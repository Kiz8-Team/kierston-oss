"use client";

/**
 * Reader for sim_init.bin — the container the packed init outputs live in.
 *
 * Everything in sim_data opens the same way: four bytes of magic, a u32 header
 * length, a JSON header, then data on an 8-byte grid. A KSIM container is that
 * envelope with a directory for a payload, and every section inside it is one
 * of those files copied in whole. So this module does not decode anything. It
 * reads the directory and hands out `ArrayBuffer`s, and `readPopulation` and
 * `readRecords` are given exactly the bytes they would have downloaded when
 * each table was its own file.
 *
 * Why it fetches ranges
 * ---------------------
 * The container is 122 MB and no page wants all of it. The firearms table is
 * 1.5 MB of that; the social graph is 54 MB and matters to one page. Fetching
 * the whole file to reach a section would be strictly worse than the six
 * separate files this replaced, so the directory is read first — a couple of
 * kilobytes off the front — and each section is then requested by byte range.
 * /api/data serves those as 206s.
 *
 * Two reads, not three: the header length sits at bytes 4..8, so the opening
 * request asks for a chunk large enough to hold the whole directory as well
 * and re-reads only if the guess was short. The directory for sixteen sections
 * is under two kilobytes, so in practice it never is.
 */

const MAGIC = "KSIM";

/** Enough to hold magic, length, and a directory, in one request. */
const PROBE = 16 * 1024;

export interface SectionSpec {
  name: string;
  /** The nested container's own tag — "KPOP", "KREC", "KTIE". */
  magic: string;
  /** The file this section was copied from, kept for provenance. */
  source: string;
  byteOffset: number;
  byteLength: number;
  /** Row counts lifted from the nested header, so a summary needs no fetch. */
  rows: Record<string, number> | null;
}

export interface ContainerMeta {
  magic: string;
  version: number;
  builtAt: string;
  seed: number;
  placementSeed: number | null;
  /**
   * sha256 over the section payloads, truncated. What a day file names to say
   * which population it was generated against — and the reason a stale day can
   * be refused rather than drawn against a city that has since been rebuilt.
   */
  digest: string;
  byteLength: number;
  sections: SectionSpec[];
}

export class Container {
  readonly url: string;
  readonly meta: ContainerMeta;
  /** Where the first section starts, which every `byteOffset` is relative to. */
  private readonly base: number;
  private readonly index: Map<string, SectionSpec>;

  constructor(url: string, meta: ContainerMeta, base: number) {
    this.url = url;
    this.meta = meta;
    this.base = base;
    this.index = new Map(meta.sections.map((section) => [section.name, section]));
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  spec(name: string): SectionSpec | null {
    return this.index.get(name) ?? null;
  }

  /**
   * One section's bytes, as its own packer wrote them.
   *
   * The returned buffer starts at the section's magic, so it is what
   * `readPopulation` or `readRecords` expects with no offset threaded through
   * either of them. That is the whole point of nesting rather than merging.
   */
  async section(name: string): Promise<ArrayBuffer> {
    const spec = this.index.get(name);
    if (!spec) {
      throw new Error(
        `${name} missing from ${this.url} (sections: ${[...this.index.keys()].join(", ")})`,
      );
    }

    const start = this.base + spec.byteOffset;
    const end = start + spec.byteLength - 1;
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!response.ok) {
      throw new Error(`${name}: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    // A server that ignored the Range answers 200 with the whole container,
    // which decodes as a KSIM where a KPOP was wanted and fails somewhere less
    // obvious. Cut it here instead, so the section is right either way.
    if (response.status !== 206 && buffer.byteLength > spec.byteLength) {
      return buffer.slice(start, start + spec.byteLength);
    }
    if (buffer.byteLength !== spec.byteLength) {
      throw new Error(
        `${name}: expected ${spec.byteLength} bytes, got ${buffer.byteLength}`,
      );
    }
    return buffer;
  }
}

const align8 = (value: number) => (value + 7) & ~7;

export async function openContainer(url: string): Promise<Container> {
  const probe = await fetch(url, { headers: { Range: `bytes=0-${PROBE - 1}` } });
  if (!probe.ok) throw new Error(`${url}: ${probe.status} ${probe.statusText}`);
  let head = new Uint8Array(await probe.arrayBuffer());

  const magic = new TextDecoder().decode(head.subarray(0, 4));
  if (magic !== MAGIC) {
    throw new Error(`${url}: magic "${magic}", expected ${MAGIC}`);
  }

  const length = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
  if (8 + length > head.length) {
    // A directory bigger than the probe. Ask again for exactly what it needs
    // rather than growing the probe and hoping — the second read is rare and
    // an unbounded guess would eventually fetch the container.
    const again = await fetch(url, { headers: { Range: `bytes=0-${8 + length - 1}` } });
    if (!again.ok) throw new Error(`${url}: ${again.status} ${again.statusText}`);
    head = new Uint8Array(await again.arrayBuffer());
  }

  const meta = JSON.parse(
    new TextDecoder().decode(head.subarray(8, 8 + length)),
  ) as ContainerMeta;

  return new Container(url, meta, align8(8 + length));
}

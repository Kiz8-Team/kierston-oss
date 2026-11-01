/** Shared KDAY codec. Unknown header fields and columns survive a rewrite. */
import { open, mkdir, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { encodeCheckpoint, type EmbeddedStateDescriptor, type StateCheckpoint } from "../engine/index.ts";
import { ARRAYS, Strings, type NumberArray, type TypeName } from "./pack.ts";
import { CITY_ASSETS_DIR, KIERSTON_DIR, SIM_DATA_DIR, SOURCES_DIR, CITY } from "../world/index.ts";

export interface BinaryColumn {
  name: string;
  type: TypeName;
  count: number;
  byteOffset: number;
  byteLength: number;
}

export interface KdayHeader {
  magic: "KDAY";
  version: number;
  date: string;
  day: number;
  /** `dd.mm.yyyy.n-hash`; absent on files written before engines were versioned. */
  engineVersion?: string;
  initDigest?: string | null;
  /** The seed day-level draws were keyed on; absent on files written before `--seed`. */
  seed?: number;
  openingState?: EmbeddedStateDescriptor;
  closingState?: EmbeddedStateDescriptor;
  counts: Record<string, number>;
  enums: Record<string, string[]>;
  strings: string[];
  columns: BinaryColumn[];
  [key: string]: unknown;
}

const align = (n: number) => Math.ceil(n / 8) * 8;

export class KdayFile {
  readonly strings: Strings;
  private readonly cache = new Map<string, NumberArray>();
  private readonly specs: Map<string, BinaryColumn>;

  private constructor(
    readonly path: string, readonly header: KdayHeader,
    private readonly handle: FileHandle, private readonly origin: number,
  ) {
    this.strings = new Strings(header.strings);
    this.specs = new Map(header.columns.map((column) => [column.name, column]));
  }

  static async open(path: string): Promise<KdayFile> {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const prefix = Buffer.alloc(8);
      if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8 || prefix.toString("ascii", 0, 4) !== "KDAY") {
        throw new Error(`${path} is not a KDAY file`);
      }
      const length = prefix.readUInt32LE(4);
      if (length < 2 || length > size - 8 || length > 128 * 1024 * 1024) throw new Error("invalid KDAY header length");
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, 8)).bytesRead !== length) throw new Error("short KDAY header");
      const header = JSON.parse(bytes.toString("utf8")) as KdayHeader;
      if (header.magic !== "KDAY" || !Number.isInteger(header.version)
          || !Array.isArray(header.columns) || !Array.isArray(header.strings)) throw new Error("invalid KDAY header");
      const origin = align(8 + length);
      const names = new Set<string>();
      const ranges: [number, number][] = [];
      for (const column of header.columns) {
        const width = ARRAYS[column.type]?.BYTES_PER_ELEMENT;
        if (!width || !Number.isSafeInteger(column.count) || column.count < 0
            || !Number.isSafeInteger(column.byteOffset) || column.byteOffset < 0
            || column.byteLength !== column.count * width || origin + column.byteOffset + column.byteLength > size
            || names.has(column.name)) throw new Error(`invalid KDAY column ${column.name}`);
        names.add(column.name);
        if (column.byteLength) ranges.push([column.byteOffset, column.byteOffset + column.byteLength]);
      }
      for (const boundary of ["openingState", "closingState"] as const) {
        const section = header[boundary];
        if (!section) continue;
        if (!Number.isSafeInteger(section.byteOffset) || section.byteOffset < 0
            || !Number.isSafeInteger(section.byteLength) || section.byteLength < 1
            || origin + section.byteOffset + section.byteLength > size) throw new Error(`invalid ${boundary} range`);
        ranges.push([section.byteOffset, section.byteOffset + section.byteLength]);
      }
      ranges.sort((a, b) => a[0] - b[0]);
      if (ranges.some((range, i) => i > 0 && ranges[i - 1]![1] > range[0])) throw new Error("overlapping KDAY sections");
      return new KdayFile(path, header, handle, origin);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  has(name: string): boolean { return this.specs.has(name); }
  names(prefix = ""): string[] { return [...this.specs.keys()].filter((name) => name.startsWith(prefix)); }
  count(name: string): number { return this.specs.get(name)?.count ?? 0; }
  string(id: number): string | null { return this.strings.values[id] ?? null; }

  async column(name: string): Promise<NumberArray> {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`KDAY missing ${name}`);
    const values = new ARRAYS[spec.type](spec.count);
    const bytes = new Uint8Array(values.buffer);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await this.handle.read(bytes, offset, bytes.length - offset, this.origin + spec.byteOffset + offset);
      if (!bytesRead) throw new Error(`short KDAY column ${name}`);
      offset += bytesRead;
    }
    this.cache.set(name, values);
    return values;
  }

  set(name: string, values: ArrayLike<number>, type?: TypeName): void {
    const actual = type ?? this.specs.get(name)?.type;
    if (!actual) throw new Error(`type required for new column ${name}`);
    const data = new ARRAYS[actual](values);
    this.cache.set(name, data);
    this.specs.set(name, { name, type: actual, count: data.length, byteLength: data.byteLength, byteOffset: 0 });
  }

  async table(prefix: string): Promise<Record<string, NumberArray>> {
    const names = this.names(`${prefix}.`);
    const values = await Promise.all(names.map((name) => this.column(name)));
    return Object.fromEntries(names.map((name, i) => [name.slice(prefix.length + 1), values[i]!]));
  }

  async write(output: string, opening: StateCheckpoint, closing: StateCheckpoint): Promise<void> {
    if (resolve(output) === resolve(this.path)) throw new Error("scenario output must differ from its input");
    if (opening.nextDate !== this.header.date) throw new Error("opening checkpoint date mismatch");
    const sections = [encodeCheckpoint(opening), encodeCheckpoint(closing)];
    let length = 0;
    const columns: BinaryColumn[] = [];
    for (const spec of this.specs.values()) {
      length = align(length);
      columns.push({ ...spec, byteOffset: length });
      length += spec.byteLength;
    }
    const descriptors = sections.map((encoded, i): EmbeddedStateDescriptor => {
      length = align(length);
      const descriptor: EmbeddedStateDescriptor = {
        magic: "KSTATE", version: opening.version, encoding: "gzip-json", boundary: i === 0 ? "opening" : "closing",
        nextDate: i === 0 ? opening.nextDate : closing.nextDate, digest: encoded.digest,
        byteOffset: length, byteLength: encoded.bytes.byteLength, rawByteLength: encoded.rawByteLength,
      };
      length += encoded.bytes.byteLength;
      return descriptor;
    });
    const header = Buffer.from(JSON.stringify({ ...this.header,
      strings: this.strings.values, columns, openingState: descriptors[0], closingState: descriptors[1] }));
    const origin = align(8 + header.length);
    await mkdir(dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${randomUUID()}`;
    const target = await open(temporary, "wx");
    try {
      const prefix = Buffer.alloc(origin);
      prefix.write("KDAY"); prefix.writeUInt32LE(header.length, 4); header.copy(prefix, 8);
      await target.writeFile(prefix);
      let written = 0;
      for (const spec of columns) {
        if (spec.byteOffset > written) await target.writeFile(new Uint8Array(spec.byteOffset - written));
        const values = await this.column(spec.name);
        await target.writeFile(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
        written = spec.byteOffset + spec.byteLength;
      }
      for (const [i, section] of sections.entries()) {
        const offset = descriptors[i]!.byteOffset;
        if (offset > written) await target.writeFile(new Uint8Array(offset - written));
        await target.writeFile(section.bytes);
        written = offset + section.bytes.byteLength;
      }
      await target.sync();
      await target.close();
      await rename(temporary, output);
    } catch (error) {
      await target.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
  }

  close(): Promise<void> { return this.handle.close(); }
}

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Fingerprints for the runtime inputs used by scenario replay.
 *
 * Every file the engine reads while planning and packing a day: the sim_data
 * build, the city's tracked tables beside its profile, the camera fleet and the
 * venue source. A day whose inputs have changed since it was exported fails
 * replay rather than replaying against stale assets.
 */
export async function replayProvenance(): Promise<{ city: string; engine: string; assets: Record<string, string> }> {
  const source = join(KIERSTON_DIR, "sim", "src");
  const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: source })).filter((name) => !name.endsWith(".test.ts")).sort();
  const engine = createHash("sha256");
  for (const name of files) engine.update(name).update(await Bun.file(join(source, name)).text());
  const routing = join(KIERSTON_DIR, "pathfinder", "src");
  for (const name of Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: routing })).filter((name) => !name.endsWith(".test.ts")).sort()) {
    engine.update(`pathfinder/${name}`).update(await Bun.file(join(routing, name)).text());
  }
  const inputs = ["population.json", "employment.json", "school_travel.json", "schools.json", "school_runs.json",
    "fleet.json", "devices.json", "towers.json", "accounts.json", "ties.bin", "affiliations.json", "orgs.json",
    "holdings.bin", "recurring_spending.bin", "vehicles.json", "mcc_by_tag.json", "pois.json", "car_graph.bin",
    "plate_rules.json", "external_traffic.json", "buildings.json", "workplaces.json", "city.json"];
  const paths: [string, string][] = inputs.map((name) => [name, join(SIM_DATA_DIR, name)]);
  paths.push(["cameras", join(KIERSTON_DIR, "cities", CITY, "cameras.json")], ["venue-source", join(SOURCES_DIR, "pois_export.json")]);
  // Read through `readCityTable`, from the city's profile directory.
  for (const table of ["payers.csv", "cab_companies.csv"]) paths.push([`city/${table}`, join(CITY_ASSETS_DIR, table)]);
  const assets: Record<string, string> = {};
  for (const [name, path] of paths) assets[name] = await Bun.file(path).exists() ? await fileDigest(path) : "absent";
  assets["sim_init.bin"] = await initContainerDigest(join(SIM_DATA_DIR, "sim_init.bin"));
  return { city: CITY, engine: engine.digest("hex"), assets };
}

/**
 * The digest `pack_init.py` writes into the sim_init.bin header, which covers
 * the binaries it contains. Read instead of hashing the container, which is
 * large; a container without one is hashed whole.
 */
async function initContainerDigest(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!await file.exists()) return "absent";
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, 4)) === "KSIM") {
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(4, true);
    const meta = JSON.parse(await file.slice(8, 8 + length).text()) as { digest?: string };
    if (meta.digest) return meta.digest;
  }
  return fileDigest(path);
}

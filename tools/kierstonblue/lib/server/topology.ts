import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { datasetPath } from "./repo";

/**
 * GraphML → a packed edge binary the browser can use immediately.
 *
 * The road network ships as 63 MB of GraphML. Parsing it in the browser costs
 * several seconds and a few hundred megabytes of heap on every page load, for
 * a result that never changes between loads. Parsing it once on the server and
 * handing the browser typed arrays turns that into a ~2 MB download and a
 * single pass with no per-edge work.
 *
 *     "KTOP"            4 bytes
 *     header length     u32, little-endian
 *     header            JSON — edge count, bounds, per-rank counts
 *     padding           to a 4-byte boundary
 *     coords            f32 × 4 per edge — aLat, aLon, bLat, bLon
 *     ranks             u8 × 1 per edge
 *
 * f32 holds a degree to about 0.4 m here, which is finer than a road is wide
 * and far finer than anything drawn at zoom 19.
 */

export const MAGIC = "KTOP";

// Rank 0 is a motorway, rank 6 a footpath. The renderer reveals ranks in order
// as you zoom in, so a wide view stays readable and cheap to draw.
const RANKS: Record<string, number> = {
  motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0,
  primary: 1, primary_link: 1,
  secondary: 2, secondary_link: 2,
  tertiary: 3, tertiary_link: 3,
  residential: 4, unclassified: 4, living_street: 4, road: 4,
  service: 5,
};

const RANK_COUNT = 7;
const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "topology.bin");

const align4 = (value: number) => (value + 3) & ~3;

interface Parsed {
  count: number;
  coords: Float32Array;
  ranks: Uint8Array;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  rankCounts: number[];
}

function parse(text: string): Parsed {
  const keys = new Map<string, string>();
  const keyRe = /<key\b([^>]*?)\/?>/g;
  for (let m: RegExpExecArray | null; (m = keyRe.exec(text)); ) {
    const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
    const name = /\battr\.name="([^"]*)"/.exec(m[1])?.[1];
    if (id && name) keys.set(id, name);
  }

  const lat = new Map<string, number>();
  const lon = new Map<string, number>();
  const nodeRe = /<node\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/node>/g;
  for (let m: RegExpExecArray | null; (m = nodeRe.exec(text)); ) {
    const dataRe = /<data\b[^>]*\bkey="([^"]*)"[^>]*>([^<]*)<\/data>/g;
    let x: number | undefined;
    let y: number | undefined;
    for (let d: RegExpExecArray | null; (d = dataRe.exec(m[2])); ) {
      const name = keys.get(d[1]);
      if (name === "x") x = Number(d[2]);
      else if (name === "y") y = Number(d[2]);
    }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      lat.set(m[1], y as number);
      lon.set(m[1], x as number);
    }
  }

  const seen = new Set<string>();
  const coords: number[] = [];
  const ranks: number[] = [];
  const rankCounts = new Array<number>(RANK_COUNT).fill(0);
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;

  const edgeRe = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/g;
  for (let m: RegExpExecArray | null; (m = edgeRe.exec(text)); ) {
    const source = /\bsource="([^"]*)"/.exec(m[1])?.[1];
    const target = /\btarget="([^"]*)"/.exec(m[1])?.[1];
    if (!source || !target) continue;
    const aLat = lat.get(source);
    const bLat = lat.get(target);
    if (aLat === undefined || bLat === undefined) continue;
    // The graph is directed; an undirected road drawn twice is wasted work.
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (seen.has(pair)) continue;
    seen.add(pair);

    let highway = "";
    const dataRe = /<data\b[^>]*\bkey="([^"]*)"[^>]*>([^<]*)<\/data>/g;
    for (let d: RegExpExecArray | null; (d = dataRe.exec(m[2])); ) {
      if (keys.get(d[1]) === "highway") { highway = d[2]; break; }
    }
    // Multi-valued tags arrive as "['residential', 'service']".
    const primary = (highway.match(/[a-z_]+/) || [""])[0];
    const rank = RANKS[primary] ?? 6;

    const aLon = lon.get(source) as number;
    const bLon = lon.get(target) as number;
    coords.push(aLat, aLon, bLat, bLon);
    ranks.push(rank);
    rankCounts[rank] += 1;
    minLat = Math.min(minLat, aLat, bLat);
    maxLat = Math.max(maxLat, aLat, bLat);
    minLon = Math.min(minLon, aLon, bLon);
    maxLon = Math.max(maxLon, aLon, bLon);
  }

  return {
    count: ranks.length,
    coords: Float32Array.from(coords),
    ranks: Uint8Array.from(ranks),
    bounds: { minLat, minLon, maxLat, maxLon },
    rankCounts,
  };
}

function pack(parsed: Parsed, stamp: string): Buffer {
  const header = Buffer.from(JSON.stringify({
    stamp,
    count: parsed.count,
    bounds: parsed.bounds,
    rankCounts: parsed.rankCounts,
    builtAt: new Date().toISOString(),
  }));
  const dataStart = align4(8 + header.length);
  const out = Buffer.alloc(dataStart + parsed.coords.byteLength + parsed.ranks.byteLength);
  out.write(MAGIC, 0, "ascii");
  out.writeUInt32LE(header.length, 4);
  header.copy(out, 8);
  Buffer.from(parsed.coords.buffer, 0, parsed.coords.byteLength).copy(out, dataStart);
  Buffer.from(parsed.ranks.buffer).copy(out, dataStart + parsed.coords.byteLength);
  return out;
}

/** Keyed on the GraphML, which is per city. */
const inFlight = new Map<string, Promise<Buffer>>();

/**
 * The packed topology, built on first use and reused after.
 *
 * The cache is keyed on the GraphML's modification time, so regenerating the
 * network invalidates it without anyone remembering to clear anything.
 */
export async function packedTopology(): Promise<Buffer> {
  const source = await datasetPath("topology");
  let packed = inFlight.get(source);
  if (!packed) {
    packed = build(source).catch((error) => { inFlight.delete(source); throw error; });
    inFlight.set(source, packed);
  }
  return packed;
}

async function build(source: string): Promise<Buffer> {
  const sourceStat = await stat(source);
  const stamp = `${source}:${sourceStat.mtimeMs}:${sourceStat.size}`;

  try {
    const cached = await readFile(CACHE_FILE);
    const headerLength = cached.readUInt32LE(4);
    const meta = JSON.parse(cached.subarray(8, 8 + headerLength).toString());
    if (meta.stamp === stamp) return cached;
  } catch {
    // No cache, or one written by an older build. Parse again.
  }

  const started = performance.now();
  const parsed = parse(await readFile(source, "utf8"));
  const packed = pack(parsed, stamp);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, packed);
  console.log(
    `[kierstonblue] packed ${parsed.count.toLocaleString()} road segments in `
    + `${Math.round(performance.now() - started)} ms`,
  );
  return packed;
}

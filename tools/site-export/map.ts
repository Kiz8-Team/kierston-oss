/**
 * Packs the base map the project website draws under its residents: roads and building footprints.
 *
 *   bun run site-map --out <dir> [--topology tools/kierstonblue/.cache/topology.bin] [--buildings kierston/sources/kierston/buildings_geom.json]
 *
 * Runs after `site-city`, because it measures everything from the origin city.json settled on.
 * Roads come from the packed topology KierstonBlue caches (open its map once if the file is missing);
 * footprints come from the OSM building extract. Both are written in the site's own units, 1e-5 degree.
 *
 *     "KMAP"           4 bytes
 *     header length    u32, little-endian
 *     header           JSON: counts, and the road count per rank
 *     padding          to a 2-byte boundary
 *     roads            i16 x 4 per segment (ax, ay, bx, by), sorted by rank
 *     sizes            u8 per building: its vertex count
 *     padding          to a 2-byte boundary
 *     vertices         i16 x 2 per vertex, each a step from the vertex before it
 *
 * Steps rather than positions, and buildings in street order, because a column of small numbers is
 * what gzip shrinks: the CDN serves this at about a third of its size on disk.
 */

import { join } from "node:path";
import { option, required } from "./args.ts";

const out = required("--out", "bun run site-map --out <dir> [--topology tools/kierstonblue/.cache/topology.bin] [--buildings kierston/sources/kierston/buildings_geom.json]");
const topologyFile = option("--topology", "tools/kierstonblue/.cache/topology.bin");
const buildingsFile = option("--buildings", "kierston/sources/kierston/buildings_geom.json");
/** Footpaths and tracks are rank 6; a city map reads better without them. */
const MAX_RANK = 5;
const MAX_VERTICES = 255;

const city = (await Bun.file(join(out, "city.json")).json()) as { origin: { lat: number; lon: number } };
const x = (lon: number) => Math.round((lon - city.origin.lon) * 1e5);
const y = (lat: number) => Math.round((lat - city.origin.lat) * 1e5);

// ---- Roads ----

const topology = await Bun.file(topologyFile).arrayBuffer();
if (new TextDecoder().decode(topology.slice(0, 4)) !== "KTOP") throw new Error(`${topologyFile} is not a packed topology`);
const headerLength = new DataView(topology).getUint32(4, true);
const meta = JSON.parse(new TextDecoder().decode(topology.slice(8, 8 + headerLength))) as { count: number };
const dataStart = (8 + headerLength + 3) & ~3;
const coords = new Float32Array(topology, dataStart, meta.count * 4);
const ranks = new Uint8Array(topology, dataStart + meta.count * 16, meta.count);

const order = [...ranks.keys()].filter((edge) => ranks[edge]! <= MAX_RANK).sort((a, b) => ranks[a]! - ranks[b]!);
const roads = new Int16Array(order.length * 4);
const rankCounts = new Array<number>(MAX_RANK + 1).fill(0);
order.forEach((edge, position) => {
  rankCounts[ranks[edge]!]! += 1;
  roads.set([x(coords[edge * 4 + 1]!), y(coords[edge * 4]!), x(coords[edge * 4 + 3]!), y(coords[edge * 4 + 2]!)], position * 4);
});

// ---- Buildings ----

interface Way { type: string; geometry?: { lat: number; lon: number }[] }
const extract = (await Bun.file(buildingsFile).json()) as { elements: Way[] };
const footprints: number[][] = [];
for (const element of extract.elements) {
  if (element.type !== "way" || !element.geometry || element.geometry.length < 4) continue;
  let ring: number[][] = element.geometry.slice(0, -1).map((point) => [x(point.lon), y(point.lat)]);
  // Rounding to a metre folds some corners onto each other.
  ring = ring.filter((point, index) => index === 0 || point[0] !== ring[index - 1]![0] || point[1] !== ring[index - 1]![1]);
  if (ring.length > MAX_VERTICES) {
    const step = ring.length / MAX_VERTICES;
    ring = Array.from({ length: MAX_VERTICES }, (_, index) => ring[Math.floor(index * step)]!);
  }
  if (ring.length >= 3) footprints.push(ring.flat());
}
// Neighbours end up next to each other in the file, which keeps the steps between buildings short.
const CELL = 200;
const key = (ring: number[]) => Math.floor(ring[1]! / CELL) * 1e4 + (Math.floor(ring[1]! / CELL) % 2 ? -1 : 1) * Math.floor(ring[0]! / CELL);
footprints.sort((a, b) => key(a) - key(b));

const sizes = new Uint8Array(footprints.length);
const vertexCount = footprints.reduce((sum, ring) => sum + ring.length / 2, 0);
const vertices = new Int16Array(vertexCount * 2);
let at = 0, lastX = 0, lastY = 0;
footprints.forEach((ring, index) => {
  sizes[index] = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i]! - lastX, dy = ring[i + 1]! - lastY;
    if (Math.abs(dx) > 32767 || Math.abs(dy) > 32767) throw new Error("a step between buildings does not fit 16 bits");
    vertices[at++] = dx;
    vertices[at++] = dy;
    lastX = ring[i]!;
    lastY = ring[i + 1]!;
  }
});

// ---- File ----

const header = new TextEncoder().encode(JSON.stringify({ roads: order.length, rankCounts, buildings: footprints.length, vertices: vertexCount }));
const even = (value: number) => (value + 1) & ~1;
const roadsAt = even(8 + header.length);
const sizesAt = roadsAt + roads.byteLength;
const verticesAt = even(sizesAt + sizes.length);
const file = new Uint8Array(verticesAt + vertices.byteLength);
file.set(new TextEncoder().encode("KMAP"), 0);
new DataView(file.buffer).setUint32(4, header.length, true);
file.set(header, 8);
file.set(new Uint8Array(roads.buffer), roadsAt);
file.set(sizes, sizesAt);
file.set(new Uint8Array(vertices.buffer), verticesAt);
await Bun.write(join(out, "map.bin"), file);
console.log(`map.bin: ${order.length} road segments, ${footprints.length} buildings, ${vertexCount} vertices: ${(file.length / 1e6).toFixed(1)} MB, ${(Bun.gzipSync(file).length / 1e6).toFixed(2)} MB gzipped`);

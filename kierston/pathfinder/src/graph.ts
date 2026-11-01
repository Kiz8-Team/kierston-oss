/**
 * The compact car graph: a forward CSR adjacency over flat typed arrays.
 *
 * Everything the search touches lives in one array per attribute, indexed by a
 * dense node/edge id, so a query is pointer-chasing free and the whole city
 * fits in a few megabytes. The on-disk form is the same arrays written back to
 * back behind a JSON header, which means loading is a read plus a few typed
 * array views rather than a parse.
 */

import { haversineMeters, METERS_PER_DEGREE_LAT, metersPerDegreeLon } from "./geo.ts";

export const GRAPH_MAGIC = "KPF1";

type ArrayKind = "f64" | "f32" | "u32" | "u8";

const CONSTRUCTOR: Record<ArrayKind, Float64ArrayConstructor | Float32ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor> = {
  f64: Float64Array, f32: Float32Array, u32: Uint32Array, u8: Uint8Array,
};

export interface GraphMeta {
  /** File the graph was built from, and when. */
  source: string;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Fastest edge speed in m/s — the denominator of the A* heuristic. */
  maxSpeedMps: number;
  /** Id of the largest strongly connected component; every node in it can
   *  reach every other, which is what makes a snap target safe to route from. */
  largestComponent: number;
  largestComponentSize: number;
  componentCount: number;
  /** Street names and highway classes, referenced by index from the edges. */
  names: string[];
  classes: string[];
}

export interface CarGraph extends GraphMeta {
  /** Node attributes, indexed by dense node id. */
  lat: Float64Array;
  lon: Float64Array;
  osmid: Float64Array;
  component: Uint32Array;
  /** Forward CSR: edges of node `v` are slots `offset[v] .. offset[v + 1]`. */
  offset: Uint32Array;
  target: Uint32Array;
  cost: Float32Array;
  length: Float32Array;
  nameId: Uint32Array;
  classId: Uint8Array;
}

interface ArraySpec {
  name: keyof CarGraph & string;
  kind: ArrayKind;
  length: number;
  byteOffset: number;
}

const LAYOUT: { name: keyof CarGraph & string; kind: ArrayKind; per: "node" | "node1" | "edge" }[] = [
  { name: "lat", kind: "f64", per: "node" },
  { name: "lon", kind: "f64", per: "node" },
  { name: "osmid", kind: "f64", per: "node" },
  { name: "component", kind: "u32", per: "node" },
  { name: "offset", kind: "u32", per: "node1" },
  { name: "target", kind: "u32", per: "edge" },
  { name: "cost", kind: "f32", per: "edge" },
  { name: "length", kind: "f32", per: "edge" },
  { name: "nameId", kind: "u32", per: "edge" },
  { name: "classId", kind: "u8", per: "edge" },
];

const align8 = (value: number) => (value + 7) & ~7;

export function encodeGraph(graph: CarGraph): Uint8Array {
  const arrays: ArraySpec[] = [];
  let byteOffset = 0;
  for (const entry of LAYOUT) {
    const view = graph[entry.name] as ArrayBufferView & { length: number };
    arrays.push({ name: entry.name, kind: entry.kind, length: view.length, byteOffset });
    byteOffset = align8(byteOffset + view.byteLength);
  }

  const meta: GraphMeta & { arrays: ArraySpec[] } = {
    source: graph.source, builtAt: graph.builtAt,
    nodeCount: graph.nodeCount, edgeCount: graph.edgeCount,
    bbox: graph.bbox, maxSpeedMps: graph.maxSpeedMps,
    largestComponent: graph.largestComponent,
    largestComponentSize: graph.largestComponentSize,
    componentCount: graph.componentCount,
    names: graph.names, classes: graph.classes,
    arrays,
  };

  const header = new TextEncoder().encode(JSON.stringify(meta));
  const dataStart = align8(8 + header.byteLength);
  const out = new Uint8Array(dataStart + byteOffset);
  out.set(new TextEncoder().encode(GRAPH_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.byteLength, true);
  out.set(header, 8);
  for (const spec of arrays) {
    const view = graph[spec.name] as ArrayBufferView;
    out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), dataStart + spec.byteOffset);
  }
  return out;
}

export function decodeGraph(buffer: ArrayBuffer): CarGraph {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== GRAPH_MAGIC) throw new Error(`not a pathfinder graph (magic ${JSON.stringify(magic)})`);

  const headerLength = new DataView(buffer).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as
    GraphMeta & { arrays: ArraySpec[] };
  const dataStart = align8(8 + headerLength);

  const graph = { ...meta } as CarGraph & { arrays?: unknown };
  for (const spec of meta.arrays) {
    const Ctor = CONSTRUCTOR[spec.kind];
    // Typed arrays over the original buffer: no copying, no per-element decode.
    (graph as unknown as Record<string, unknown>)[spec.name] =
      new Ctor(buffer, dataStart + spec.byteOffset, spec.length);
  }
  delete graph.arrays;
  return graph;
}

export async function loadGraph(path: string): Promise<CarGraph> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no graph at ${path} — run \`bun run build-graph\` first`);
  }
  return decodeGraph(await file.arrayBuffer());
}

export interface SnapResult {
  node: number;
  lat: number;
  lon: number;
  meters: number;
}

/**
 * Uniform grid over the graph's bounding box for nearest-node lookups.
 *
 * Built at load time in a single pass, and searched ring by ring outwards so
 * the work is proportional to the local node density rather than the city size.
 */
export class NodeIndex {
  private readonly cellSizeLat: number;
  private readonly cellSizeLon: number;
  private readonly rows: number;
  private readonly cols: number;
  private readonly cellStart: Uint32Array;
  private readonly cellNodes: Uint32Array;

  constructor(private readonly graph: CarGraph, targetCellMeters = 150) {
    const { minLat, minLon, maxLat, maxLon } = graph.bbox;
    this.cellSizeLat = targetCellMeters / METERS_PER_DEGREE_LAT;
    this.cellSizeLon = targetCellMeters / Math.max(1, metersPerDegreeLon((minLat + maxLat) / 2));
    this.rows = Math.max(1, Math.ceil((maxLat - minLat) / this.cellSizeLat) + 1);
    this.cols = Math.max(1, Math.ceil((maxLon - minLon) / this.cellSizeLon) + 1);

    // Counting sort into a CSR-shaped bucket list, so the index is two arrays.
    const counts = new Uint32Array(this.rows * this.cols + 1);
    const cellOf = new Uint32Array(graph.nodeCount);
    for (let node = 0; node < graph.nodeCount; node += 1) {
      const cell = this.cellFor(graph.lat[node], graph.lon[node]);
      cellOf[node] = cell;
      counts[cell + 1] += 1;
    }
    for (let i = 1; i < counts.length; i += 1) counts[i] += counts[i - 1];
    this.cellStart = counts;
    this.cellNodes = new Uint32Array(graph.nodeCount);
    const cursor = counts.slice(0, counts.length - 1);
    for (let node = 0; node < graph.nodeCount; node += 1) {
      this.cellNodes[cursor[cellOf[node]]++] = node;
    }
  }

  private row(lat: number): number {
    const value = Math.floor((lat - this.graph.bbox.minLat) / this.cellSizeLat);
    return Math.min(this.rows - 1, Math.max(0, value));
  }

  private col(lon: number): number {
    const value = Math.floor((lon - this.graph.bbox.minLon) / this.cellSizeLon);
    return Math.min(this.cols - 1, Math.max(0, value));
  }

  private cellFor(lat: number, lon: number): number {
    return this.row(lat) * this.cols + this.col(lon);
  }

  /**
   * Nearest routable node to a coordinate. `connectedOnly` keeps the result in
   * the largest strongly connected component, so a driveway stub or an isolated
   * service loop never becomes an unroutable endpoint.
   */
  nearest(lat: number, lon: number, connectedOnly = true): SnapResult | null {
    const graph = this.graph;
    const centreRow = this.row(lat);
    const centreCol = this.col(lon);
    const cellMeters = Math.min(
      this.cellSizeLat * METERS_PER_DEGREE_LAT,
      this.cellSizeLon * Math.max(1, metersPerDegreeLon(lat)),
    );

    let best = -1;
    let bestMeters = Infinity;
    const maxRing = Math.max(this.rows, this.cols);
    for (let ring = 0; ring <= maxRing; ring += 1) {
      // Everything in this ring is at least (ring - 1) cells away, so once the
      // current best beats that bound no further ring can improve on it.
      if (best >= 0 && (ring - 1) * cellMeters > bestMeters) break;
      let touched = false;
      for (let row = centreRow - ring; row <= centreRow + ring; row += 1) {
        if (row < 0 || row >= this.rows) continue;
        const edgeRow = row === centreRow - ring || row === centreRow + ring;
        for (let col = centreCol - ring; col <= centreCol + ring; col += 1) {
          if (col < 0 || col >= this.cols) continue;
          if (!edgeRow && col !== centreCol - ring && col !== centreCol + ring) continue;
          touched = true;
          const cell = row * this.cols + col;
          for (let i = this.cellStart[cell]; i < this.cellStart[cell + 1]; i += 1) {
            const node = this.cellNodes[i];
            if (connectedOnly && graph.component[node] !== graph.largestComponent) continue;
            const meters = haversineMeters(lat, lon, graph.lat[node], graph.lon[node]);
            if (meters < bestMeters) {
              bestMeters = meters;
              best = node;
            }
          }
        }
      }
      if (!touched && ring > Math.max(this.rows, this.cols)) break;
    }

    if (best < 0) return null;
    return { node: best, lat: graph.lat[best], lon: graph.lon[best], meters: bestMeters };
  }
}

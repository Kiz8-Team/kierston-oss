/**
 * Turn the OSM topology export into the compact car graph the router reads.
 *
 * The GraphML is 60+ MB of every mapped way including footpaths, which is far
 * more than a car router needs and far too slow to parse per query. This runs
 * once: it keeps the drivable subset, prices each edge in seconds, orders the
 * nodes for memory locality, labels the strongly connected components, and
 * writes the result as flat arrays.
 *
 *   bun run build-graph [--input file.graphml] [--output car_graph.bin]
 */

import {
  CAR_CLASSES, CLASS_SPEED_KPH, CLOSED_ACCESS, GRAPH_FILE, TOPOLOGY_FILE, type CarClass,
} from "./config.ts";
import { encodeGraph, type CarGraph } from "./graph.ts";
import { basename } from "node:path";

const CAR_CLASS_SET = new Set<string>(CAR_CLASSES);
const MPH_TO_KPH = 1.609344;

/** OSM list-valued tags arrive as "['residential', 'service']". */
function tokens(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/[A-Za-z_][A-Za-z_:]*/g) ?? [];
}

function unescapeXml(value: string): string {
  if (!value.includes("&")) return value;
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** First readable street name out of a raw `name` tag, list-valued or not. */
function firstName(value: string | undefined): string {
  if (!value) return "";
  const quoted = value.match(/'([^']+)'|"([^"]+)"/);
  const raw = quoted ? (quoted[1] ?? quoted[2] ?? "") : value;
  return unescapeXml(raw.trim());
}

/** Posted speed in km/h, or 0 when the way carries none we can read. */
function maxspeedKph(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/(\d+(?:\.\d+)?)\s*(mph)?/i);
  if (!match) return 0;
  const speed = Number(match[1]);
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return match[2] ? speed * MPH_TO_KPH : speed;
}

function carClassOf(highway: string | undefined): CarClass | null {
  for (const token of tokens(highway)) {
    if (CAR_CLASS_SET.has(token)) return token as CarClass;
  }
  return null;
}

function isClosed(access: string | undefined): boolean {
  return tokens(access).some((token) => CLOSED_ACCESS.has(token));
}

/**
 * Interleave quantised latitude and longitude into a Morton key. Sorting nodes
 * by it puts neighbours next to each other in memory, so an expanding search
 * walks mostly-contiguous cache lines.
 */
function mortonKey(row: number, col: number): number {
  const spread = (value: number) => {
    let x = value & 0xffff;
    x = (x | (x << 8)) & 0x00ff00ff;
    x = (x | (x << 4)) & 0x0f0f0f0f;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    return x;
  };
  return ((spread(row) << 1) | spread(col)) >>> 0;
}

interface ParsedNodes {
  lat: Float64Array;
  lon: Float64Array;
  osmid: Float64Array;
  indexOf: Map<string, number>;
}

function parseNodes(text: string, keyName: Map<string, string>): ParsedNodes {
  const lat: number[] = [];
  const lon: number[] = [];
  const osmid: number[] = [];
  const indexOf = new Map<string, number>();

  const nodeRe = /<node\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/node>/g;
  const dataRe = /<data\b[^>]*\bkey="([^"]*)"[^>]*>([^<]*)<\/data>/g;
  for (let node; (node = nodeRe.exec(text)); ) {
    let x = NaN;
    let y = NaN;
    dataRe.lastIndex = 0;
    for (let data; (data = dataRe.exec(node[2])); ) {
      const name = keyName.get(data[1]);
      if (name === "x") x = Number(data[2]);
      else if (name === "y") y = Number(data[2]);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    indexOf.set(node[1], lat.length);
    lat.push(y);
    lon.push(x);
    osmid.push(Number(node[1]));
  }

  return {
    lat: Float64Array.from(lat),
    lon: Float64Array.from(lon),
    osmid: Float64Array.from(osmid),
    indexOf,
  };
}

interface ParsedEdges {
  from: Int32Array;
  to: Int32Array;
  meters: Float64Array;
  seconds: Float64Array;
  nameId: Uint32Array;
  classId: Uint8Array;
  names: string[];
  skipped: { notCar: number; closed: number; dangling: number; degenerate: number };
}

function parseEdges(text: string, keyName: Map<string, string>, nodes: ParsedNodes): ParsedEdges {
  const from: number[] = [];
  const to: number[] = [];
  const meters: number[] = [];
  const seconds: number[] = [];
  const nameIds: number[] = [];
  const classIds: number[] = [];
  const names: string[] = [""];
  const nameIndex = new Map<string, number>([["", 0]]);
  const skipped = { notCar: 0, closed: 0, dangling: 0, degenerate: 0 };

  const edgeRe = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/g;
  const dataRe = /<data\b[^>]*\bkey="([^"]*)"[^>]*>([^<]*)<\/data>/g;
  const tags = new Map<string, string>();

  for (let edge; (edge = edgeRe.exec(text)); ) {
    const source = /\bsource="([^"]*)"/.exec(edge[1])?.[1];
    const target = /\btarget="([^"]*)"/.exec(edge[1])?.[1];
    const a = source === undefined ? undefined : nodes.indexOf.get(source);
    const b = target === undefined ? undefined : nodes.indexOf.get(target);
    if (a === undefined || b === undefined) {
      skipped.dangling += 1;
      continue;
    }
    if (a === b) {
      skipped.degenerate += 1;
      continue;
    }

    tags.clear();
    dataRe.lastIndex = 0;
    for (let data; (data = dataRe.exec(edge[2])); ) {
      const name = keyName.get(data[1]);
      if (name) tags.set(name, data[2]);
    }

    const carClass = carClassOf(tags.get("highway"));
    if (!carClass) {
      skipped.notCar += 1;
      continue;
    }
    if (isClosed(tags.get("access"))) {
      skipped.closed += 1;
      continue;
    }

    // osmnx writes a MultiDiGraph: a two-way street is already present as two
    // directed edges, so direction needs no extra handling here.
    const length = Number(tags.get("length"));
    if (!Number.isFinite(length) || length <= 0) {
      skipped.degenerate += 1;
      continue;
    }
    const kph = maxspeedKph(tags.get("maxspeed")) || CLASS_SPEED_KPH[carClass];

    const street = firstName(tags.get("name"));
    let nameId = nameIndex.get(street);
    if (nameId === undefined) {
      nameId = names.length;
      nameIndex.set(street, nameId);
      names.push(street);
    }

    from.push(a);
    to.push(b);
    meters.push(length);
    seconds.push(length / (kph / 3.6));
    nameIds.push(nameId);
    classIds.push(CAR_CLASSES.indexOf(carClass));
  }

  return {
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    meters: Float64Array.from(meters),
    seconds: Float64Array.from(seconds),
    nameId: Uint32Array.from(nameIds),
    classId: Uint8Array.from(classIds),
    names,
    skipped,
  };
}

/** Kosaraju over the CSR pair, iterative so a deep graph cannot blow the stack. */
function strongComponents(
  nodeCount: number,
  offset: Uint32Array, target: Uint32Array,
  revOffset: Uint32Array, revTarget: Uint32Array,
): { component: Uint32Array; count: number; largest: number; largestSize: number } {
  const visited = new Uint8Array(nodeCount);
  const order = new Uint32Array(nodeCount);
  const stackNode = new Int32Array(nodeCount);
  const stackSlot = new Uint32Array(nodeCount);
  let ordered = 0;

  for (let start = 0; start < nodeCount; start += 1) {
    if (visited[start]) continue;
    visited[start] = 1;
    let top = 0;
    stackNode[0] = start;
    stackSlot[0] = offset[start];
    while (top >= 0) {
      const node = stackNode[top];
      if (stackSlot[top] < offset[node + 1]) {
        const next = target[stackSlot[top]++];
        if (!visited[next]) {
          visited[next] = 1;
          top += 1;
          stackNode[top] = next;
          stackSlot[top] = offset[next];
        }
      } else {
        order[ordered++] = node;
        top -= 1;
      }
    }
  }

  const component = new Uint32Array(nodeCount).fill(0xffffffff);
  const sizes: number[] = [];
  for (let i = ordered - 1; i >= 0; i -= 1) {
    const root = order[i];
    if (component[root] !== 0xffffffff) continue;
    const id = sizes.length;
    let size = 0;
    let top = 0;
    stackNode[0] = root;
    component[root] = id;
    while (top >= 0) {
      const node = stackNode[top--];
      size += 1;
      for (let slot = revOffset[node]; slot < revOffset[node + 1]; slot += 1) {
        const next = revTarget[slot];
        if (component[next] !== 0xffffffff) continue;
        component[next] = id;
        stackNode[++top] = next;
      }
    }
    sizes.push(size);
  }

  let largest = 0;
  for (let id = 1; id < sizes.length; id += 1) if (sizes[id] > sizes[largest]) largest = id;
  return { component, count: sizes.length, largest, largestSize: sizes[largest] ?? 0 };
}

/** Group edge ids by their `from` node. `slot[k]` is the edge at CSR position k. */
function csr(nodeCount: number, from: Int32Array): { offset: Uint32Array; slot: Uint32Array } {
  const offset = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < from.length; i += 1) offset[from[i] + 1] += 1;
  for (let i = 1; i <= nodeCount; i += 1) offset[i] += offset[i - 1];
  const cursor = offset.slice(0, nodeCount);
  const slot = new Uint32Array(from.length);
  for (let i = 0; i < from.length; i += 1) slot[cursor[from[i]]++] = i;
  return { offset, slot };
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = TOPOLOGY_FILE;
  let output = GRAPH_FILE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input" && argv[i + 1]) input = argv[++i];
    else if (argv[i] === "--output" && argv[i + 1]) output = argv[++i];
  }
  return { input, output };
}

export async function buildGraph(input: string, output: string): Promise<CarGraph> {
  const startedAt = performance.now();
  const file = Bun.file(input);
  if (!(await file.exists())) throw new Error(`no topology at ${input}`);
  const text = await file.text();
  console.log(`read ${basename(input)} (${(text.length / 1e6).toFixed(1)} MB) `
    + `in ${Math.round(performance.now() - startedAt)} ms`);

  const keyName = new Map<string, string>();
  const keyRe = /<key\b([^>]*?)\/?>/g;
  for (let key; (key = keyRe.exec(text)); ) {
    const id = /\bid="([^"]*)"/.exec(key[1])?.[1];
    const name = /\battr\.name="([^"]*)"/.exec(key[1])?.[1];
    if (id && name) keyName.set(id, name);
  }

  const parsedAt = performance.now();
  const nodes = parseNodes(text, keyName);
  const edges = parseEdges(text, keyName, nodes);
  console.log(`parsed ${nodes.lat.length.toLocaleString()} nodes and `
    + `${edges.from.length.toLocaleString()} drivable edges in `
    + `${Math.round(performance.now() - parsedAt)} ms`);
  if (!edges.from.length) throw new Error("no drivable edges found");

  // Drop everything a car can never stand on, then reorder what is left so
  // spatial neighbours are index neighbours.
  const used = new Uint8Array(nodes.lat.length);
  for (let i = 0; i < edges.from.length; i += 1) {
    used[edges.from[i]] = 1;
    used[edges.to[i]] = 1;
  }
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  const kept: number[] = [];
  for (let i = 0; i < used.length; i += 1) {
    if (!used[i]) continue;
    kept.push(i);
    if (nodes.lat[i] < minLat) minLat = nodes.lat[i];
    if (nodes.lat[i] > maxLat) maxLat = nodes.lat[i];
    if (nodes.lon[i] < minLon) minLon = nodes.lon[i];
    if (nodes.lon[i] > maxLon) maxLon = nodes.lon[i];
  }

  const spanLat = Math.max(1e-9, maxLat - minLat);
  const spanLon = Math.max(1e-9, maxLon - minLon);
  const keyOf = new Uint32Array(nodes.lat.length);
  for (const old of kept) {
    const row = Math.min(0xffff, Math.floor(((nodes.lat[old] - minLat) / spanLat) * 0xffff));
    const col = Math.min(0xffff, Math.floor(((nodes.lon[old] - minLon) / spanLon) * 0xffff));
    keyOf[old] = mortonKey(row, col);
  }
  kept.sort((a, b) => keyOf[a] - keyOf[b]);

  const nodeCount = kept.length;
  const newIndex = new Int32Array(nodes.lat.length).fill(-1);
  const lat = new Float64Array(nodeCount);
  const lon = new Float64Array(nodeCount);
  const osmid = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) {
    const old = kept[i];
    newIndex[old] = i;
    lat[i] = nodes.lat[old];
    lon[i] = nodes.lon[old];
    osmid[i] = nodes.osmid[old];
  }

  const edgeCount = edges.from.length;
  const from = new Int32Array(edgeCount);
  const to = new Int32Array(edgeCount);
  for (let i = 0; i < edgeCount; i += 1) {
    from[i] = newIndex[edges.from[i]];
    to[i] = newIndex[edges.to[i]];
  }

  const forward = csr(nodeCount, from);
  const target = new Uint32Array(edgeCount);
  const cost = new Float32Array(edgeCount);
  const length = new Float32Array(edgeCount);
  const nameId = new Uint32Array(edgeCount);
  const classId = new Uint8Array(edgeCount);
  let maxSpeedMps = 1;
  for (let position = 0; position < edgeCount; position += 1) {
    const edge = forward.slot[position];
    target[position] = to[edge];
    cost[position] = edges.seconds[edge];
    length[position] = edges.meters[edge];
    nameId[position] = edges.nameId[edge];
    classId[position] = edges.classId[edge];
    const mps = edges.meters[edge] / edges.seconds[edge];
    if (mps > maxSpeedMps) maxSpeedMps = mps;
  }

  const backward = csr(nodeCount, to);
  const revTarget = new Uint32Array(edgeCount);
  for (let position = 0; position < edgeCount; position += 1) revTarget[position] = from[backward.slot[position]];
  const components = strongComponents(nodeCount, forward.offset, target, backward.offset, revTarget);

  const graph: CarGraph = {
    source: basename(input),
    builtAt: new Date().toISOString(),
    nodeCount,
    edgeCount,
    bbox: { minLat, minLon, maxLat, maxLon },
    maxSpeedMps,
    largestComponent: components.largest,
    largestComponentSize: components.largestSize,
    componentCount: components.count,
    names: edges.names,
    classes: [...CAR_CLASSES],
    lat, lon, osmid,
    component: components.component,
    offset: forward.offset,
    target, cost, length, nameId, classId,
  };

  const bytes = encodeGraph(graph);
  await Bun.write(output, bytes);

  const { notCar, closed, dangling, degenerate } = edges.skipped;
  console.log(`skipped ${notCar.toLocaleString()} non-car, ${closed.toLocaleString()} access-restricted, `
    + `${(dangling + degenerate).toLocaleString()} unusable edges`);
  console.log(`${components.count.toLocaleString()} strongly connected components, largest holds `
    + `${components.largestSize.toLocaleString()} nodes `
    + `(${((components.largestSize / nodeCount) * 100).toFixed(1)}%)`);
  console.log(`fastest edge ${(maxSpeedMps * 3.6).toFixed(0)} km/h · ${graph.names.length.toLocaleString()} street names`);
  console.log(`wrote ${output} (${(bytes.byteLength / 1e6).toFixed(1)} MB) in `
    + `${Math.round(performance.now() - startedAt)} ms`);
  return graph;
}

if (import.meta.main) {
  const { input, output } = parseArgs(Bun.argv.slice(2));
  await buildGraph(input, output);
}

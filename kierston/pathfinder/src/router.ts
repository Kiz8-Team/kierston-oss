/**
 * A* over the car graph, minimising travel time.
 *
 * The heuristic is straight-line distance divided by the fastest speed in the
 * network, which never overestimates the remaining time and so keeps the search
 * optimal. All of the per-query state is allocated once and invalidated with a
 * generation stamp instead of being cleared, so a repeated query costs only the
 * nodes it actually settles — that is what lets the same code serve a 100k-node
 * city and a country-sized extract without changing shape.
 */

import type { CarGraph } from "./graph.ts";
import { haversineMeters } from "./geo.ts";
import { MinHeap } from "./heap.ts";

export interface RoutePath {
  /** Node ids from source to target, inclusive. */
  nodes: Uint32Array;
  /** Forward-CSR edge slots connecting them; one shorter than `nodes`. */
  edges: Uint32Array;
  distanceMeters: number;
  durationSeconds: number;
  settledNodes: number;
  milliseconds: number;
}

export interface RouteOptions {
  /** Treat every road edge as bidirectional, as pedestrians ignore lane direction. */
  walking?: boolean;
}

export class Router {
  private readonly cost: Float64Array;
  private readonly parentNode: Int32Array;
  private readonly parentEdge: Int32Array;
  private readonly seen: Uint32Array;
  private readonly settled: Uint32Array;
  private readonly heap = new MinHeap(4096);
  private readonly secondsPerMeter: number;
  /** Incoming edges as CSR, used to traverse directed roads backwards on foot. */
  private readonly reverseOffset: Uint32Array;
  private readonly reverseSource: Uint32Array;
  private readonly reverseEdge: Uint32Array;
  private generation = 0;

  constructor(private readonly graph: CarGraph) {
    const n = graph.nodeCount;
    this.cost = new Float64Array(n);
    this.parentNode = new Int32Array(n);
    this.parentEdge = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.settled = new Uint32Array(n);
    this.secondsPerMeter = 1 / Math.max(1, graph.maxSpeedMps);

    const reverseOffset = new Uint32Array(n + 1);
    for (let slot = 0; slot < graph.edgeCount; slot += 1) {
      reverseOffset[graph.target[slot]! + 1] += 1;
    }
    for (let node = 1; node < reverseOffset.length; node += 1) {
      reverseOffset[node] += reverseOffset[node - 1]!;
    }

    const reverseSource = new Uint32Array(graph.edgeCount);
    const reverseEdge = new Uint32Array(graph.edgeCount);
    const cursor = reverseOffset.slice(0, n);
    for (let source = 0; source < n; source += 1) {
      for (let slot = graph.offset[source]!; slot < graph.offset[source + 1]!; slot += 1) {
        const index = cursor[graph.target[slot]!]!++;
        reverseSource[index] = source;
        reverseEdge[index] = slot;
      }
    }
    this.reverseOffset = reverseOffset;
    this.reverseSource = reverseSource;
    this.reverseEdge = reverseEdge;
  }

  route(source: number, target: number, options: RouteOptions = {}): RoutePath | null {
    const started = performance.now();
    const graph = this.graph;
    if (source < 0 || target < 0 || source >= graph.nodeCount || target >= graph.nodeCount) return null;

    const { cost, parentNode, parentEdge, seen, settled, heap } = this;
    const generation = ++this.generation;
    heap.clear();

    const targetLat = graph.lat[target];
    const targetLon = graph.lon[target];
    const heuristic = (node: number) =>
      haversineMeters(graph.lat[node], graph.lon[node], targetLat, targetLon) * this.secondsPerMeter;

    cost[source] = 0;
    parentNode[source] = -1;
    parentEdge[source] = -1;
    seen[source] = generation;
    heap.push(heuristic(source), source);

    let settledCount = 0;
    let found = false;
    while (heap.size > 0) {
      const node = heap.pop();
      if (settled[node] === generation) continue;
      settled[node] = generation;
      settledCount += 1;
      if (node === target) {
        found = true;
        break;
      }

      const base = cost[node];
      const end = graph.offset[node + 1];
      for (let slot = graph.offset[node]; slot < end; slot += 1) {
        const next = graph.target[slot];
        if (settled[next] === generation) continue;
        const candidate = base + graph.cost[slot];
        if (seen[next] === generation && cost[next] <= candidate) continue;
        seen[next] = generation;
        cost[next] = candidate;
        parentNode[next] = node;
        parentEdge[next] = slot;
        heap.push(candidate + heuristic(next), next);
      }

      if (options.walking) {
        const reverseEnd = this.reverseOffset[node + 1]!;
        for (let index = this.reverseOffset[node]!; index < reverseEnd; index += 1) {
          const next = this.reverseSource[index]!;
          if (settled[next] === generation) continue;
          const slot = this.reverseEdge[index]!;
          const candidate = base + graph.cost[slot]!;
          if (seen[next] === generation && cost[next]! <= candidate) continue;
          seen[next] = generation;
          cost[next] = candidate;
          parentNode[next] = node;
          parentEdge[next] = slot;
          heap.push(candidate + heuristic(next), next);
        }
      }
    }

    const milliseconds = performance.now() - started;
    if (!found) return null;

    let depth = 0;
    for (let node = target; node !== -1; node = parentNode[node]) depth += 1;
    const nodes = new Uint32Array(depth);
    const edges = new Uint32Array(depth - 1);
    let distanceMeters = 0;
    let cursor = depth - 1;
    for (let node = target; node !== -1; node = parentNode[node]) {
      nodes[cursor] = node;
      const slot = parentEdge[node];
      if (slot >= 0) {
        edges[cursor - 1] = slot;
        distanceMeters += graph.length[slot];
      }
      cursor -= 1;
    }

    return {
      nodes,
      edges,
      distanceMeters,
      durationSeconds: cost[target],
      settledNodes: settledCount,
      milliseconds,
    };
  }
}

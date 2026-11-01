/**
 * Time random routes across the network, so a change to the search can be
 * judged rather than guessed at.
 *
 *   bun run src/bench.ts [--queries 2000]
 */

import { GRAPH_FILE } from "./config.ts";
import { loadGraph } from "./graph.ts";
import { Router } from "./router.ts";

const argv = Bun.argv.slice(2);
const queries = Number(argv[argv.indexOf("--queries") + 1]) || 2000;

const loadedAt = performance.now();
const graph = await loadGraph(GRAPH_FILE);
const router = new Router(graph);
console.log(`loaded ${graph.nodeCount.toLocaleString()} nodes / ${graph.edgeCount.toLocaleString()} edges `
  + `in ${(performance.now() - loadedAt).toFixed(1)} ms`);

// Only nodes in the largest component, so every pair is genuinely routable.
const routable: number[] = [];
for (let node = 0; node < graph.nodeCount; node += 1) {
  if (graph.component[node] === graph.largestComponent) routable.push(node);
}

const pick = () => routable[(Math.random() * routable.length) | 0];
const times: number[] = [];
let settled = 0;
let failed = 0;
let meters = 0;

for (let i = 0; i < queries; i += 1) {
  const path = router.route(pick(), pick());
  if (!path) {
    failed += 1;
    continue;
  }
  times.push(path.milliseconds);
  settled += path.settledNodes;
  meters += path.distanceMeters;
}

times.sort((a, b) => a - b);
const at = (quantile: number) => times[Math.min(times.length - 1, Math.floor(times.length * quantile))];
const mean = times.reduce((sum, value) => sum + value, 0) / times.length;

console.log(`${times.length.toLocaleString()} routes (${failed} unroutable), `
  + `mean length ${(meters / times.length / 1000).toFixed(1)} km`);
console.log(`mean ${mean.toFixed(2)} ms · p50 ${at(0.5).toFixed(2)} ms · p95 ${at(0.95).toFixed(2)} ms · `
  + `max ${at(1).toFixed(2)} ms`);
console.log(`${Math.round(settled / times.length).toLocaleString()} nodes settled per route · `
  + `${Math.round(times.length / (times.reduce((sum, value) => sum + value, 0) / 1000)).toLocaleString()} routes/s`);

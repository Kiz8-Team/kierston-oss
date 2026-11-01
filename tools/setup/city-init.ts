/**
 * Builds the city: the init pipeline into kierston/sim_data, then the road graph.
 *
 *   bun run city-init [init_sim.py options]
 *
 * Every argument is passed to kierston/init/init_sim.py (`--households 1000`,
 * `--from <stage>`, `--seed`, `--out`, ...). The road graph is built into the
 * same folder, and skipped with `--only` or `--manifest-only`.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, VENV_PYTHON, run } from "./run.ts";

const args = process.argv.slice(2);

if (!existsSync(VENV_PYTHON)) {
  console.error("Missing kierston/.venv; run bun run setup-project first");
  process.exit(1);
}
if (!existsSync(join(ROOT, "kierston/sources"))) {
  console.error("Missing kierston/sources; run bun run setup-project first");
  process.exit(1);
}

console.log("Building city");
run([VENV_PYTHON, "kierston/init/init_sim.py", ...args]);

const noGraph = ["--only", "--manifest-only", "--help", "-h"];
if (args.some(a => noGraph.includes(a))) process.exit(0);

const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : args.find(a => a.startsWith("--out="))?.slice(6);

console.log("Building road graph");
run(["bun", "run", "build-graph"], join(ROOT, "kierston/pathfinder"),
  out ? { KIERSTON_SIM_DATA_DIR: resolve(out) } : undefined);

/**
 * The `bun run day` entry: `--city` and `--seed`, then the CLI.
 *
 *   bun run day --city <build> --export-day --date 2026-08-31
 *   bun run day --seed 7 --export-day --date 2026-08-31
 *
 * `--city PATH` runs on the city build at PATH — a folder with a
 * kierston-city.json, made by `init_sim.py --out PATH` — instead of
 * kierston/sim_data, and writes its days where that build's manifest says.
 * `--seed N` replaces the population seed every day-level draw is keyed on.
 *
 * Both have to be in the environment before anything reads it: the paths and
 * the seed are fixed when world/data.ts is first imported, and cli.ts imports
 * it at the top. So they are read here and the CLI is imported after.
 *
 * A seed is part of a chain, not of a day. Traits drawn once per person —
 * habitual venues, rotas, temperaments — come from it too, so a week continued
 * with `--from-state` should keep the seed the first day had. The cab stands
 * are drawn from it as well; `--export-taxi` with the same seed keeps the
 * viewer's taxi.json in step.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = Bun.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

const city = flag("--city");
if (city !== undefined) {
  const dir = resolve(city);
  if (!existsSync(join(dir, "kierston-city.json"))) {
    fail(`${dir} is not a city build: no kierston-city.json (init_sim.py --out writes one)`);
  }
  process.env.KIERSTON_SIM_DATA_DIR = dir;
}

const seed = flag("--seed");
if (seed !== undefined) {
  if (!/^-?\d+$/.test(seed)) fail(`--seed takes an integer, not ${seed}`);
  process.env.KIERSTON_SEED = seed;
}

await import("./cli.ts");

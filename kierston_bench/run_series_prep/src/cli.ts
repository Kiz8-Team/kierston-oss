/**
 * Build a run series from a TOML config.
 *
 *   bun run kierston_bench/run_series_prep/src/cli.ts <config.toml> [--force] [--progress-json]
 *
 * Writes kierston_bench/run_series/run_series_<id>_tasks_data.json (or the
 * config's output_dir). An existing file is not overwritten without --force,
 * because a series is meant to stay fixed once models have been run on it.
 */

import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { buildRunSeries, outputPath, seriesText } from "./series.ts";

const configPath = process.argv[2];
if (!configPath || configPath.startsWith("--")) {
  console.error("usage: cli.ts <config.toml> [--force]");
  process.exit(2);
}
const force = process.argv.includes("--force");

const config = await loadConfig(configPath);
const target = outputPath(config);
if (!force && (await Bun.file(target).exists())) {
  console.error(`${target} exists; pass --force to overwrite it`);
  process.exit(1);
}

console.error(`series ${config.id}: ${config.copies.size} families over ${config.days.length} day(s), seed ${config.seed}`);
// `--progress-json` is for callers that draw their own progress (the bench TUI):
// each update is one `@progress {...}` line on stderr among the log lines.
const progressJson = process.argv.includes("--progress-json");
const data = await buildRunSeries(config, {
  log: (line) => console.error(line),
  ...(progressJson ? { progress: (progress) => console.error(`@progress ${JSON.stringify(progress)}`) } : {}),
});

// Runs record the sha256 of the series file they started from, and scoring
// and reruns refuse once the file differs. Name the runs a --force rebuild
// strands so the operator knows before the file changes.
if (force && (await Bun.file(target).exists())) {
  const runsDir = resolve(import.meta.dir, "../../runs", config.id);
  const runs = await readdir(runsDir).catch(() => [] as string[]);
  if (runs.length > 0) {
    console.error(`series ${config.id}: rebuilding over ${runs.length} existing run(s) in ${runsDir}; they keep the old series hash and will be refused for scoring and reruns against the new file`);
    for (const run of runs.sort()) console.error(`  ${join(runsDir, run)}`);
  }
}

await mkdir(dirname(target), { recursive: true });
await Bun.write(target, seriesText(data));

const short = data.outcomes.filter((outcome) => outcome.produced < outcome.requested);
console.error(`wrote ${data.tasks.length} tasks to ${target}`);
if (short.length > 0) {
  console.error(`${short.length} family/day quota(s) short: ${short.map((o) => `${o.family}@${o.date} ${o.produced}/${o.requested}`).join(", ")}`);
}

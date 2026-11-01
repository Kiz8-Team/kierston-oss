/**
 * Freeze scoring truth into a series built before series carried it.
 *
 *   bun run kierston_bench/run_series_prep/src/attach-truth.ts <series file> --sim-data <dir> [--force]
 *
 * `<dir>` must hold the registers the series' runs were served from, which is
 * not necessarily today's kierston/sim_data. A series that already has a
 * snapshot keeps it unless --force is given.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { takeTruthSnapshot } from "../../scoring/src/truth_snapshot.ts";
import { seriesText, type RunSeriesData } from "./series.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { "sim-data": { type: "string" }, force: { type: "boolean", default: false } },
  allowPositionals: true,
});
const file = positionals[0];
if (!file || !values["sim-data"]) {
  console.error("usage: attach-truth.ts <series file> --sim-data <dir> [--force]");
  process.exit(2);
}

const series = (await Bun.file(file).json()) as RunSeriesData;
if (series.truth && !values.force) {
  console.error(`${file} already carries a truth snapshot taken ${series.truth.takenAt}; pass --force to replace it`);
  process.exit(1);
}
series.truth = await takeTruthSnapshot(resolve(values["sim-data"]));
await Bun.write(file, seriesText(series));
console.error(`${file}: truth snapshot of ${series.truth.identities.rows.length} people from ${series.truth.source}`);

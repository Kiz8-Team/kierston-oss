/**
 * Deleting a series: its task file, every run made from it, the scenario
 * kdiffs it staged, and the config the New series form wrote for it — which is
 * what holds the id. A hand-written config is the source, not the output, and
 * is left alone.
 *
 * A staged kdiff is reused by any later series that asks for the same
 * (scenario, day, seed) in the same scenario directory, so one is removed only
 * when no other series file still names it.
 */

import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import { readJson, type SeriesSummary } from "./inventory.ts";
import { PATHS, REPO_ROOT } from "./paths.ts";
import { GENERATED_HEADER } from "./series-config.ts";

export interface DeletedSeries {
  runs: number;
  deltas: number;
  /** Kdiffs left in place because another series still reads them. */
  shared: number;
  /** The TUI-generated config was removed. */
  config: boolean;
}

async function deltasOf(file: string): Promise<string[]> {
  const data = await readJson<RunSeriesData>(file);
  return (data?.series.scenarios ?? []).map((staging) => resolve(REPO_ROOT, staging.delta));
}

export async function deleteSeries(
  series: SeriesSummary, all: readonly SeriesSummary[], runsDir = PATHS.runs, configsDir = PATHS.seriesConfigs,
): Promise<DeletedSeries> {
  const runs = resolve(runsDir, series.id);
  if (!runs.startsWith(resolve(runsDir) + sep)) throw new Error(`series id ${JSON.stringify(series.id)} escapes ${runsDir}`);

  const mine = await deltasOf(series.file);
  const elsewhere = new Set<string>();
  for (const other of all) {
    if (other.file === series.file) continue;
    for (const delta of await deltasOf(other.file)) elsewhere.add(delta);
  }

  const runCount = (await readdir(runs, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).length;
  await rm(runs, { recursive: true, force: true });

  let deltas = 0, shared = 0;
  const directories = new Set<string>();
  for (const delta of new Set(mine)) {
    if (elsewhere.has(delta)) { shared += 1; continue; }
    if (await Bun.file(delta).exists()) deltas += 1;
    await rm(delta, { force: true });
    directories.add(dirname(delta));
  }
  // The default scenario directory is the series' own; leave it only if
  // something else lives there.
  for (const directory of directories) await rmdir(directory).catch(() => {});

  const configFile = join(configsDir, `${series.id}.toml`);
  const config = (await readFile(configFile, "utf8").catch(() => "")).startsWith(GENERATED_HEADER);
  if (config) await rm(configFile, { force: true });

  await rm(series.file, { force: true });
  return { runs: runCount, deltas, shared, config };
}

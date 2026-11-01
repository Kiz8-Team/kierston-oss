/**
 * A sweep runs one task on a list of models: one run per model, each
 * selecting the same task of the same series. Runner, scorer and run screens
 * see normal runs. The sweep record lists the run ids.
 *
 * The task is taken from a series or generated: a one-family, one-day,
 * one-copy series built with the series prep, so it has hidden ground truth.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import { generateSeries, type DispatchSpec } from "./dispatch.ts";
import { loadLiveTaskRows, readJson, summariseRun, type RunSummary, type TaskRow } from "./inventory.ts";
import { PATHS, REPO_ROOT, seriesFileFor } from "./paths.ts";
import { seriesToml } from "./series-config.ts";
import type { RunScore } from "../../scoring/src/score.ts";

export interface Sweep {
  id: string;
  createdAt: string;
  series: string;
  seriesFile: string;
  taskId: string;
  runs: { model: string; runId: string }[];
}

export interface SweepRow {
  model: string;
  runId: string;
  dir: string;
  /** Null until the run's directory exists: queued, or deleted since. */
  run: RunSummary | null;
  task: TaskRow | null;
  answer?: unknown;
}

export const SWEEP_ID = /^[A-Za-z0-9._-]+$/;

export function sweepFile(id: string): string {
  return join(PATHS.sweeps, `${id}.json`);
}

export function defaultSweepId(): string {
  return `sweep-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Models from flags, form text or a file: comma- or line-separated, `#`
 * comments dropped, first occurrence kept.
 */
export function parseModels(texts: readonly string[]): string[] {
  const models = texts
    .flatMap((text) => text.split("\n"))
    .map((line) => line.replace(/#.*$/, ""))
    .flatMap((line) => line.split(","))
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set(models)];
}

export function newSweep(series: string, seriesFile: string, taskId: string, models: readonly string[], id = defaultSweepId()): Sweep {
  const taken = new Set<string>();
  const runs = models.map((model) => {
    let runId = `${id}-${slug(model)}`;
    for (let n = 2; taken.has(runId); n++) runId = `${id}-${slug(model)}-${n}`;
    taken.add(runId);
    return { model, runId };
  });
  return { id, createdAt: new Date().toISOString(), series, seriesFile, taskId, runs };
}

/**
 * The model reaches pi through EM. A startup command that hard-codes a
 * model would run every entry of the sweep on that model.
 */
export function ignoresModel(startupCommand: string | undefined): boolean {
  return startupCommand !== undefined && !/\$\{?EM\b/.test(startupCommand);
}

/** One spec per model: base settings, one task, concurrency 1, model as run name. */
export function sweepSpecs(base: DispatchSpec, sweep: Sweep): DispatchSpec[] {
  return sweep.runs.map(({ model, runId }) => ({
    ...base,
    seriesFile: sweep.seriesFile,
    seriesId: sweep.series,
    model,
    runId,
    name: model,
    concurrency: 1,
    families: [],
    taskIds: [sweep.taskId],
    resume: false,
  }));
}

export async function saveSweep(sweep: Sweep): Promise<void> {
  await mkdir(PATHS.sweeps, { recursive: true });
  await Bun.write(sweepFile(sweep.id), JSON.stringify(sweep, null, 2) + "\n");
}

export async function listSweeps(): Promise<Sweep[]> {
  const entries = await readdir(PATHS.sweeps).catch(() => []);
  const sweeps: Sweep[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const sweep = await readJson<Sweep>(join(PATHS.sweeps, entry));
    if (sweep?.id && sweep.runs) sweeps.push(sweep);
  }
  return sweeps.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findSweep(reference: string): Promise<Sweep | null> {
  const direct = await readJson<Sweep>(reference.endsWith(".json") ? resolve(reference) : sweepFile(reference));
  if (direct?.runs) return direct;
  return null;
}

export async function deleteSweepRecord(sweep: Sweep): Promise<void> {
  await unlink(sweepFile(sweep.id)).catch(() => {});
}

/**
 * State of each model's run. Reads run directories only; the series file can
 * be tens of megabytes. Score comes from the run's score.json.
 */
export async function loadSweep(sweep: Sweep): Promise<SweepRow[]> {
  return Promise.all(sweep.runs.map(async ({ model, runId }): Promise<SweepRow> => {
    const dir = join(PATHS.runs, sweep.series, runId);
    const exists = await Bun.file(join(dir, "launch.json")).exists() || await Bun.file(join(dir, "selection.json")).exists();
    if (!exists) return { model, runId, dir, run: null, task: null };
    const run = await summariseRun(dir, sweep.series, runId, 1);
    const [row] = await loadLiveTaskRows(dir, [sweep.taskId], run.state === "running");
    const score = await readJson<RunScore>(join(dir, "score.json"));
    const scored = score?.tasks.find((task) => task.id === sweep.taskId);
    const task: TaskRow | null = row
      ? { ...row, ...(scored ? { score: scored.score, metrics: scored.metrics, issues: scored.issues, scoring: scored.scoring } : {}) }
      : null;
    const answer = row?.hasAnswer ? (await readJson<{ answer?: unknown }>(join(dir, taskDirName(row.id), "answer.json")))?.answer : undefined;
    return { model, runId, dir, run, task, ...(answer !== undefined ? { answer } : {}) };
  }));
}

/** Every model a previous run was launched with, most used first. */
export async function knownModels(): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const series of await readdir(PATHS.runs).catch(() => [])) {
    for (const runId of await readdir(join(PATHS.runs, series)).catch(() => [])) {
      const launch = await readJson<{ spec?: { model?: string } }>(join(PATHS.runs, series, runId, "launch.json"));
      const model = launch?.spec?.model?.trim();
      if (model) counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
}

/** `2026-08-31` or a path, as the day file the series prep reads (repository-relative). */
export function dayFile(day: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return `kierston/sim_outputs/day_${day}.bin`;
  const absolute = resolve(day);
  return absolute.startsWith(`${REPO_ROOT}/`) ? absolute.slice(REPO_ROOT.length + 1) : absolute;
}

export function generatedSeriesId(family: string, day: string, seed: number): string {
  return `task-${family}-${basename(day).replace(/^day_|\.bin$/g, "")}-s${seed}`;
}

/**
 * One task of `family` from one day. Same family, day and seed name the same
 * series, which is reused if it exists.
 */
export async function generateTask(
  family: string, day: string, seed: number, onLog?: (line: string) => void,
): Promise<{ seriesId: string; seriesFile: string; taskId: string; reused: boolean }> {
  const day_ = dayFile(day);
  if (!(await Bun.file(resolve(REPO_ROOT, day_)).exists())) throw new Error(`no day file at ${day_}`);
  const seriesId = generatedSeriesId(family, day_, seed);
  const seriesFile = seriesFileFor(seriesId);
  let reused = true;
  if (!(await Bun.file(seriesFile).exists())) {
    reused = false;
    const configFile = join(PATHS.seriesConfigs, `${seriesId}.toml`);
    await Bun.write(configFile, seriesToml({ id: seriesId, seed, days: [day_], families: new Set([family]), copies: 1, attempts: 8 }));
    const result = await generateSeries(configFile, false, undefined, onLog);
    if (!result.ok) {
      await unlink(configFile).catch(() => {});
      throw new Error(result.output.split("\n").filter(Boolean).at(-1) || `could not generate ${seriesId}`);
    }
  }
  const data = await readJson<RunSeriesData>(seriesFile);
  const task = data?.tasks.find((entry) => entry.family === family);
  if (!task) {
    const reason = data?.outcomes.find((outcome) => outcome.family === family)?.rejected.at(-1)?.reason;
    throw new Error(`${family} produced no task on ${basename(day_)}${reason ? `: ${reason}` : ""}`);
  }
  return { seriesId, seriesFile, taskId: task.id, reused };
}

/** Run `work` over `items`, at most `limit` at a time; `stopped` ends the queue early. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined && !stopped(); item = queue.shift()) await work(item);
  });
  await Promise.all(lanes);
}

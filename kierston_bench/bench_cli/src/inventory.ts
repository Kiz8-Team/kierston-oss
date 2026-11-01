/**
 * What is on disk: the series that exist, the runs made from them, and how
 * far each one got.
 *
 * A run directory is the only record of a run, and it is written as the run
 * goes: one directory per task, `meta.json` in it when that task finishes,
 * `run.json` at the top only when the whole run does. So a run that is still
 * going, one that was interrupted, and one that finished are all told apart
 * here from what the directory holds rather than from any process this CLI
 * happens to have started — which is what lets it report on runs launched from
 * another terminal, or before this session began.
 */

import { readManaged, managedState, type ManagedRun } from "./background.ts";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport, TaskMeta, TaskStatus } from "../../eval_runner/src/runner.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import { scoreSummary, type RunScore, type TaskScore } from "../../scoring/src/score.ts";
import type { ScoringSpec } from "../../task_generators/src/task.ts";
import { PATHS, seriesFileFor } from "./paths.ts";
import { readActivity, type Activity } from "./activity.ts";
import type { KdiCall } from "./kdi-call.ts";

export type RunState = "running" | "complete" | "interrupted" | "empty";

export interface SeriesSummary {
  id: string;
  file: string;
  createdAt: string;
  seed: number;
  taskCount: number;
  families: string[];
  days: { date: string; file: string }[];
  startupCommand?: string;
  /** The series' own `agent.deadline_minutes`, when it sets one. */
  deadlineMinutes?: number;
  generatorVersion?: string;
  /** Run directories made from this series. */
  runs: number;
}

export interface TaskRow {
  id: string;
  family: string;
  date: string;
  /** Live states precede the final TaskStatus written to meta.json. */
  status: TaskStatus | "pending" | "running" | "not-run";
  /** What `docker run` returned; 137 is a killed container, not a quiet agent. */
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  durationMs?: number;
  /** The time the agent was given, and when it was told to stop, if it was. */
  deadlineMs?: number;
  forcedAt?: string;
  kdiCalls?: number;
  startedAt?: string;
  hasAnswer: boolean;
  /** What the agent is doing, read from its transcript while the task runs. */
  activity?: Activity;
  score?: number | null;
  metrics?: Record<string, number>;
  scoring?: TaskScore["scoring"];
  issues?: string[];
}

export interface RunSummary {
  series: string;
  runId: string;
  /** Human-readable label saved by the launcher. */
  name?: string;
  dir: string;
  image?: string;
  startedAt?: string;
  finishedAt?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Tasks in the series, when the series file is still there to say. */
  total: number | null;
  /** Tasks with a meta.json: the run is done with them. */
  done: number;
  /** Task directories opened but not finished. */
  inFlight: number;
  counts: Partial<Record<TaskStatus | "skipped", number>>;
  state: RunState;
  manager?: Pick<ManagedRun, "host" | "backend" | "unit" | "state" | "heartbeat" | "exitCode">;
  lastActivity: number;
  score?: { meanScore: number | null; scored: number; scoredAt: string };
}

export interface RunDetail extends RunSummary {
  tasks: TaskRow[];
  /** The whole of `score.json`, where one has been written. */
  scoreReport: RunScore | null;
}

/** A run with no run.json and no file touched in this long is not running. */
const STALE_MS = 5 * 60_000;

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return (await Bun.file(path).json()) as T;
  } catch {
    return null;
  }
}

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  // Dot directories are bookkeeping, never a series, run or task: `.live`
  // holds in-flight attempt mounts and `.reruns` holds rerun attempts.
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
}

export async function listSeries(runsDir = PATHS.runs, seriesDir = PATHS.runSeries): Promise<SeriesSummary[]> {
  const entries = await readdir(seriesDir).catch(() => []);
  const runCounts = new Map<string, number>();
  for (const series of await directories(runsDir)) {
    runCounts.set(series, (await directories(join(runsDir, series))).length);
  }
  const summaries: SeriesSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(seriesDir, entry);
    const data = await readSeriesHeader(file);
    if (!data?.series) continue;
    summaries.push({
      id: data.series.id,
      file,
      createdAt: data.series.createdAt,
      seed: data.series.seed,
      taskCount: data.series.taskCount ?? data.tasks?.length ?? 0,
      families: data.series.families ?? [],
      days: data.series.days ?? [],
      startupCommand: (data.series as { agent?: { startupCommand?: string } }).agent?.startupCommand,
      deadlineMinutes: (data.series as { agent?: { deadlineMinutes?: number } }).agent?.deadlineMinutes,
      generatorVersion: (data.series as { generatorVersion?: string }).generatorVersion,
      runs: runCounts.get(data.series.id) ?? 0,
    });
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type SeriesHeader = Pick<RunSeriesData, "series"> & { tasks?: unknown[] };

const headerCache = new Map<string, { mtimeMs: number; size: number; header: SeriesHeader | null }>();

/**
 * The `series` block of a series file, without parsing the rest. A series file
 * opens with `series`, then `outcomes`, `tasks` and (since truth snapshots) a
 * `truth` payload of tens of megabytes; listing needs only the first. The file
 * is streamed until the `outcomes` (or `tasks`) key and the prefix parsed; a
 * file that is laid out differently, or a header without a task count, falls
 * back to a full parse. Results are cached by path, size and mtime.
 */
export async function readSeriesHeader(file: string): Promise<SeriesHeader | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const cached = headerCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.header;
  let header: SeriesHeader | null = null;
  let text = "";
  const decoder = new TextDecoder();
  const reader = Bun.file(file).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      const cut = /\n  "(?:outcomes|tasks|truth)":/.exec(text);
      if (cut) {
        try {
          header = JSON.parse(`${text.slice(0, cut.index).replace(/,\s*$/, "")}\n}`) as SeriesHeader;
        } catch {
          header = null;
        }
        break;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!header?.series || header.series.taskCount === undefined) header = await readJson<RunSeriesData>(file);
  headerCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, header });
  return header;
}

/** Task counts per series id, so a run in progress knows its denominator. */
export async function seriesSizes(seriesDir = PATHS.runSeries): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const series of await listSeries(PATHS.runs, seriesDir)) sizes.set(series.id, series.taskCount);
  return sizes;
}

export async function listRuns(runsDir = PATHS.runs): Promise<RunSummary[]> {
  const sizes = await seriesSizes();
  const runs: RunSummary[] = [];
  for (const series of await directories(runsDir)) {
    for (const runId of await directories(join(runsDir, series))) {
      runs.push(await summariseRun(join(runsDir, series, runId), series, runId, sizes.get(series) ?? null));
    }
  }
  return runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.lastActivity - a.lastActivity);
}

/**
 * A run that never wrote run.json still knows when it started: the runner
 * stamps the launch time into the run id. Without this an interrupted run has
 * no startedAt and sorts below every finished one whatever its date.
 */
function launchTime(runId: string): string | undefined {
  const stamp = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runId);
  if (!stamp) return undefined;
  const [, y, mo, d, h, mi, sec] = stamp;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}.000Z`;
}

export async function summariseRun(dir: string, series: string, runId: string, total: number | null): Promise<RunSummary> {
  const report = await readJson<RunReport>(join(dir, "run.json"));
  const launch = await readJson<{ spec?: { name?: string } }>(join(dir, "launch.json"));
  const selection = await readJson<{ taskIds?: string[] }>(join(dir, "selection.json"));
  const score = await readJson<RunScore>(join(dir, "score.json"));
  const taskDirs = (await directories(dir)).filter(name => name !== ".reruns");
  const counts: Partial<Record<TaskStatus | "skipped", number>> = {};
  let done = 0;
  let inFlight = 0;
  let lastActivity = 0;

  const replaced = await Bun.file(join(dir, "rerun-updated.json")).exists();
  if (report && !replaced) {
    for (const [status, count] of Object.entries(report.counts)) counts[status as TaskStatus] = count;
    done = report.tasks.length + (report.counts.skipped ?? 0);
    lastActivity = Date.parse(report.finishedAt ?? report.startedAt ?? "") || 0;
  } else {
    for (const name of taskDirs) {
      const meta = await readJson<TaskMeta>(join(dir, name, "meta.json"));
      if (meta) {
        done += 1;
        counts[meta.status] = (counts[meta.status] ?? 0) + 1;
        lastActivity = Math.max(lastActivity, Date.parse(meta.finishedAt ?? "") || 0);
      } else {
        inFlight += 1;
        const taskDir = join(dir, name);
        const touched = Math.max(
          await stat(taskDir).then((entry) => entry.mtimeMs, () => 0),
          await stat(join(taskDir, "active.json")).then((entry) => entry.mtimeMs, () => 0),
        );
        lastActivity = Math.max(lastActivity, touched);
      }
    }
  }
  if (lastActivity === 0) lastActivity = await stat(dir).then((entry) => entry.mtimeMs, () => 0);

  const manager = await readManaged(dir);
  const state: RunState = report?.interrupted ? "interrupted" : (manager ? managedState(manager) : undefined) ?? (report
    ? report.interrupted ? "interrupted" : "complete"
    : taskDirs.length === 0
      ? "empty"
      : Date.now() - lastActivity < STALE_MS
        ? "running"
        : "interrupted");

  return {
    series,
    runId,
    ...(launch?.spec?.name?.trim() ? { name: launch.spec.name.trim() } : {}),
    dir,
    image: report?.image,
    startedAt: report?.startedAt ?? launchTime(runId) ?? (lastActivity ? new Date(lastActivity).toISOString() : undefined),
    finishedAt: report?.finishedAt,
    concurrency: report?.concurrency,
    timeoutMs: report?.timeoutMs,
    total: selection?.taskIds?.length ?? report?.selectedTaskIds?.length ?? report?.tasks.length ?? total,
    done,
    inFlight,
    counts,
    state,
    lastActivity,
    ...(manager ? { manager: { host: manager.host, backend: manager.backend, unit: manager.unit, state: manager.state, heartbeat: manager.heartbeat, exitCode: manager.exitCode } } : {}),
    ...(score
      ? { score: { meanScore: score.aggregate.meanScore, scored: score.aggregate.scored, scoredAt: score.scoredAt } }
      : {}),
  };
}

/**
 * Every task of a run, in series order where the series is still on disk, so
 * a run in progress shows the tasks it has not started yet as pending.
 */
export async function loadRun(dir: string, series: string, runId: string): Promise<RunDetail> {
  const seriesData = await readJson<RunSeriesData>(seriesFileFor(series));
  const report = await readJson<RunReport>(join(dir, "run.json"));
  const selection = await readJson<{ taskIds?: string[] }>(join(dir, "selection.json"));
  const selectedIds = selection?.taskIds ?? report?.selectedTaskIds ?? report?.tasks.map((task) => task.id);
  const selected = selectedIds ? new Set(selectedIds) : null;
  const score = await readJson<RunScore>(join(dir, "score.json"));
  const scores = new Map((score?.tasks ?? []).map((task) => [task.id, task]));
  const summary = await summariseRun(dir, series, runId, seriesData?.series.taskCount ?? null);

  const rows: TaskRow[] = [];
  const seen = new Set<string>();
  // A task in flight has only its opaque case id on disk, so its directory is what ties it to a row.
  const seenDirs = new Set<string>();
  // A task with no meta.json is one the run has not finished. Whether that
  // means "not yet" or "never" is the run's state, not the task's.
  const unfinished = summary.state === "running" ? "pending" : "not-run";
  const rerun = await readJson<{ taskId: string; taskDir: string }>(join(dir, "rerun-active.json"));
  const fromMeta = async (id: string, family: string, date: string, declaredScoring?: ScoringSpec): Promise<TaskRow> => {
    const taskDir = rerun?.taskId === id ? rerun.taskDir : join(dir, taskDirName(id));
    const meta = await readJson<TaskMeta>(join(taskDir, "meta.json"));
    // In flight the bundle sits in task/ under the name the container sees it by.
    const opened = await Bun.file(join(taskDir, "input", "input.json")).exists();
    const active = await Bun.file(join(taskDir, "active.json")).exists();
    const hasAnswer = await Bun.file(join(taskDir, "answer.json")).exists();
    const scored = scores.get(id);
    const scoring = scored?.scoring ?? (scored && declaredScoring
      ? {
          method: declaredScoring.method,
          aggregate: declaredScoring.aggregate,
          summary: scoreSummary(declaredScoring.method, scored.metrics, scored.score),
        }
      : undefined);
    return {
      id,
      family: meta?.family ?? family,
      date: meta?.date ?? date,
      // A rerun applying its scenario has not opened the task yet, but it is under way.
      status: meta?.status ?? ((active || rerun?.taskId === id || summary.state === "running") && opened ? "running" : rerun?.taskId === id ? "pending" : unfinished),
      aborted: await Bun.file(join(taskDir, "abort.json")).exists(),
      ...(meta
        ? {
            durationMs: meta.durationMs,
            deadlineMs: meta.deadlineMs,
            forcedAt: meta.forcedAt,
            kdiCalls: meta.kdiCalls,
            startedAt: meta.startedAt,
            exitCode: meta.exitCode,
            timedOut: meta.timedOut,
          }
        : {}),
      hasAnswer,
      ...(scored ? { score: scored.score, metrics: scored.metrics, issues: scored.issues } : {}),
      ...(scoring ? { scoring } : {}),
    };
  };

  for (const task of seriesData?.tasks ?? []) {
    if (selected && !selected.has(task.id)) continue;
    seen.add(task.id);
    seenDirs.add(taskDirName(task.id));
    rows.push(await fromMeta(task.id, task.family, task.date, task.scoring));
  }
  // A run may hold tasks its series no longer lists, or be running without a
  // series file on disk at all; either way the directories are the record.
  for (const name of await directories(dir)) {
    if (name === ".reruns" || seenDirs.has(name)) continue;
    const meta = await readJson<TaskMeta>(join(dir, name, "meta.json"));
    // The bundle on disk carries the opaque case id the agent sees; while a
    // task is in flight its real id is only in active.json, after the run id.
    const active = meta ? null : await readJson<{ kdiTaskId?: string }>(join(dir, name, "active.json"));
    const activeId = active?.kdiTaskId?.slice(active.kdiTaskId.indexOf("/") + 1);
    const bundle = meta ?? (activeId ? { id: activeId, family: activeId.split(":")[0] ?? "", date: activeId.split(":")[1] ?? "" } : null);
    const id = bundle?.id ?? name;
    if (seen.has(id)) continue;
    seen.add(id);
    const declaredScoring = bundle && "scoring" in bundle ? bundle.scoring as ScoringSpec | undefined : undefined;
    rows.push(await fromMeta(id, bundle?.family ?? id.split(":")[0] ?? "", bundle?.date ?? "", declaredScoring));
  }

  return { ...summary, tasks: rows, scoreReport: score };
}

/** The selected task list with filesystem-derived live states for the progress screen. */
export async function loadLiveTaskRows(dir: string, taskIds: readonly string[], running: boolean): Promise<TaskRow[]> {
  return Promise.all(taskIds.map(async (id) => {
    const taskDir = join(dir, taskDirName(id));
    const meta = await readJson<TaskMeta>(join(taskDir, "meta.json"));
    const opened = await stat(taskDir).then((entry) => entry.isDirectory(), () => false);
    // Only a task still in flight needs its transcript read; a finished one has meta.json.
    const activity = meta === null && running && opened ? await readActivity(taskDir) : {};
    return {
      id,
      family: meta?.family ?? id.split(":")[0] ?? "",
      date: meta?.date ?? id.split(":")[1] ?? "",
      status: meta?.status ?? (running ? opened ? "running" : "pending" : "not-run"),
      aborted: await Bun.file(join(taskDir, "abort.json")).exists(),
      ...(meta
        ? {
            durationMs: meta.durationMs,
            deadlineMs: meta.deadlineMs,
            forcedAt: meta.forcedAt,
            kdiCalls: meta.kdiCalls,
            startedAt: meta.startedAt,
            exitCode: meta.exitCode,
            timedOut: meta.timedOut,
          }
        : {}),
      ...(activity.tool !== undefined || activity.header !== undefined ? { activity } : {}),
      hasAnswer: await Bun.file(join(taskDir, "answer.json")).exists(),
    };
  }));
}

export interface TaskDetail {
  row: TaskRow;
  dir: string;
  task: Record<string, unknown> | null;
  answer: { taskId?: string; answer?: unknown; notes?: string } | null;
  console: string[];
  kdiCalls: KdiCall[];
  logFiles: string[];
  workFiles: string[];
}

export async function loadTask(runDir: string, row: TaskRow, consoleLines = 200): Promise<TaskDetail> {
  const dir = join(runDir, taskDirName(row.id));
  const consoleText = await Bun.file(join(dir, "console.log")).text().catch(() => "");
  const kdiText = await Bun.file(join(dir, "kdi_calls.jsonl")).text().catch(() => "");
  return {
    row,
    dir,
    // Runs from before the rename keep the file as task.json.
    task: await readJson<Record<string, unknown>>(join(dir, "input.json")) ?? await readJson<Record<string, unknown>>(join(dir, "task.json")),
    answer: await readJson<{ taskId?: string; answer?: unknown; notes?: string }>(join(dir, "answer.json")),
    console: consoleText.split("\n").slice(-consoleLines),
    kdiCalls: kdiText
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          return JSON.parse(line) as KdiCall;
        } catch {
          return {};
        }
      }),
    logFiles: await readdir(join(dir, "logs")).catch(() => []),
    workFiles: await readdir(join(dir, "work")).catch(() => []),
  };
}

/** `series/runId`, `runId` or unique custom name, or a path — all name one run directory. */
export async function findRun(reference: string, runsDir = PATHS.runs): Promise<RunSummary | null> {
  const runs = await listRuns(runsDir);
  const cleaned = reference.replace(/\/+$/, "");
  const byPath = runs.find((run) => run.dir === cleaned || run.dir.endsWith(`/${cleaned}`));
  if (byPath) return byPath;
  const bySlug = runs.find((run) => `${run.series}/${run.runId}` === cleaned);
  if (bySlug) return bySlug;
  const byId = runs.filter((run) => run.runId === cleaned);
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) throw new Error(`${byId.length} runs are called ${cleaned}; name it as <series>/<run id>`);
  const byName = runs.filter((run) => run.name === cleaned);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`${byName.length} runs are named ${cleaned}; use <series>/<run id>`);
  return null;
}

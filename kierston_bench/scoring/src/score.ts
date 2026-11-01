/**
 * Scoring a run: the series' ground truth read against what each task's
 * container left behind.
 *
 * The evaluation runner deliberately never touches the truth side of a
 * series — a run directory holds answers, logs and KDI calls and nothing
 * else. This is the later step it left room for: it opens the same series
 * file the run was launched from, pairs each task with its answer, validates
 * the answer's shape, resolves the identifiers in it, and scores it.
 *
 * Nothing here writes into the run unless asked (`writeInto`), so a run can be
 * scored under different policies without one overwriting the other.
 */

import { IDENTITY_POLICY } from "../../task_generators/src/identity.ts";
import { RETIRED_FAMILIES } from "../../task_generators/src/retired.ts";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KierstonBenchTask } from "../../task_generators/src/task.ts";
import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import type { TaskMeta, TaskStatus } from "../../eval_runner/src/runner.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import type { Submission } from "../../eval_runner/src/bundle.ts";
import { DEFAULT_SCORE_OPTIONS, scorerFor, type FamilyResult, type ScoreOptions } from "./families.ts";
import { TruthIndex } from "./truth.ts";
import { validateSubmission, type ValidationIssue } from "./validate.ts";
import { aggregate, type RunAggregate } from "./aggregate.ts";

export type ScoreStatus = "scored" | "abstained" | TaskStatus | "not-run";

export interface TaskScore {
  id: string;
  family: string;
  date: string;
  /** `scored` when an answer was read and scored; otherwise why it was not. */
  status: ScoreStatus;
  /** -1..1, or null when there was nothing to score. */
  score: number | null;
  abstentionReason?: string;
  metrics: Record<string, number>;
  scoring: {
    method: string;
    aggregate: string;
    /** Human-readable account of how this task's score was obtained. */
    summary: string;
  };
  labels?: { field: string; predicted: string | null; truth: string }[];
  /** Validation problems and identifiers that would not resolve. */
  issues: string[];
  /** How each identifier in the answer was read; the audit trail for a score. */
  resolutions?: { given: string; ids: string[]; via: string; identityCredit?: number; candidateCount?: number }[];
  durationMs?: number;
  kdiCalls?: number;
}

export interface RunScore {
  identityPolicy?: string;
  series: string;
  runId: string;
  runDir: string;
  scoredAt: string;
  /** What claims were resolved against: the series' own snapshot, or a sim_data directory. */
  truth: string;
  options: ScoreOptions;
  tasks: TaskScore[];
  aggregate: RunAggregate;
}

export interface ScoreRunOptions extends Partial<ScoreOptions> {
  seriesFile: string;
  runDir: string;
  simDataDir: string;
  families?: Set<string>;
  taskIds?: Set<string>;
  /** Write `score.json` into the run directory. */
  writeInto?: boolean;
  /** Keep the per-identifier resolution trail in the result. */
  keepResolutions?: boolean;
  onTask?: (score: TaskScore, index: number, total: number) => void;
}

export async function loadSeries(file: string): Promise<RunSeriesData> {
  return JSON.parse(await readFile(file, "utf8")) as RunSeriesData;
}

/** A run's per-task metadata, keyed by task id; absent tasks were never run. */
export async function loadRunMetas(runDir: string): Promise<Map<string, TaskMeta>> {
  const metas = new Map<string, TaskMeta>();
  const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJson<TaskMeta>(join(runDir, entry.name, "meta.json"));
    if (meta?.id) metas.set(meta.id, meta);
  }
  return metas;
}

export async function scoreRun(options: ScoreRunOptions): Promise<RunScore> {
  const settings: ScoreOptions = {
    ...DEFAULT_SCORE_OPTIONS,
    ...(options.ambiguity ? { ambiguity: options.ambiguity } : {}),
    ...(options.placeCreditMetres !== undefined ? { placeCreditMetres: options.placeCreditMetres } : {}),
    ...(options.arrivalCreditMinutes !== undefined ? { arrivalCreditMinutes: options.arrivalCreditMinutes } : {}),
    ...(options.recallK !== undefined ? { recallK: options.recallK } : {}),
  };
  const series = await loadSeries(options.seriesFile);
  const metas = await loadRunMetas(options.runDir);
  // A series scores against the registers it was built with; sim_data is only for series older than that.
  const truth = new TruthIndex(series.truth ?? options.simDataDir);
  // A retired family's tasks are left out entirely, not scored as errors, so
  // runs scored before and after a retirement average over the same families.
  const selected = series.tasks.filter(
    (task) => !RETIRED_FAMILIES.has(task.family) && (!options.families || options.families.has(task.family)) && (!options.taskIds || options.taskIds.has(task.id)),
  );

  const tasks: TaskScore[] = [];
  for (const [index, task] of selected.entries()) {
    const meta = metas.get(task.id);
    const dir = join(options.runDir, taskDirName(task.id));
    const submission = await readJson<Submission>(join(dir, "answer.json"));
    const score = await scoreTask(task, submission, truth, settings, meta, options.keepResolutions ?? false);
    tasks.push(score);
    options.onTask?.(score, index, selected.length);
  }

  const result: RunScore = {
    identityPolicy: IDENTITY_POLICY,
    series: series.series.id,
    runId: runIdOf(options.runDir),
    runDir: options.runDir,
    scoredAt: new Date().toISOString(),
    truth: series.truth ? `series snapshot taken ${series.truth.takenAt}` : options.simDataDir,
    options: settings,
    tasks,
    aggregate: aggregate(tasks),
  };
  if (options.writeInto) await writeFile(join(options.runDir, "score.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

/** The warning to print when a run was scored against live sim_data rather than its series' own snapshot. */
export function truthWarning(result: Pick<RunScore, "truth">): string | null {
  return result.truth.startsWith("series snapshot")
    ? null
    : `warning: the series has no truth snapshot; claims were resolved against ${result.truth}, which may have changed since the run`;
}

/** One task scored: validation first, then the family's own scorer. */
export async function scoreTask(
  task: KierstonBenchTask,
  submission: Submission | null,
  truth: TruthIndex,
  options: ScoreOptions,
  meta?: TaskMeta,
  keepResolutions = false,
): Promise<TaskScore> {
  const base = {
    id: task.id,
    family: task.family,
    date: task.date,
    scoring: {
      method: task.scoring.method,
      aggregate: task.scoring.aggregate,
      summary: "No score was calculated.",
    },
    ...(meta ? { durationMs: meta.durationMs, kdiCalls: meta.kdiCalls } : {}),
  };
  if (submission === null) {
    // A timeout or a crash is a different failure from an agent that finished
    // and said nothing, so the run's own status stands where it has one.
    const status: ScoreStatus = meta ? (meta.status === "answered" ? "invalid-answer" : meta.status) : "not-run";
    return { ...base, status, score: null, metrics: {}, issues: [statusNote(status)] };
  }
  const validation = validateSubmission(task.answer, submission);
  if (!validation.ok) {
    return {
      ...base,
      status: "invalid-answer",
      score: null,
      metrics: {},
      issues: validation.issues.map(renderIssue),
    };
  }
  if (validation.abstentionReason !== undefined) {
    return { ...base, status: "abstained", score: null, metrics: {},
      abstentionReason: validation.abstentionReason,
      scoring: { ...base.scoring, summary: "Explicit abstention; answerability has not been verified." },
      issues: validation.issues.map(renderIssue) };
  }
  let result: FamilyResult;
  try {
    result = await scorerFor(task.family)({ task, answer: validation.value, truth, options });
  } catch (caught) {
    return { ...base, status: "error", score: null, metrics: {}, issues: [`scorer failed: ${(caught as Error).message}`] };
  }
  return {
    ...base,
    status: "scored",
    score: result.score,
    metrics: result.metrics,
    scoring: {
      method: task.scoring.method,
      aggregate: task.scoring.aggregate,
      summary: scoreSummary(task.scoring.method, result.metrics, result.score),
    },
    ...(result.labels ? { labels: result.labels } : {}),
    issues: [...validation.issues.filter((issue) => issue.severity === "warning").map(renderIssue), ...result.issues],
    ...(keepResolutions ? { resolutions: result.resolutions } : {}),
  };
}

/** Explain the main score without requiring somebody to interpret metric names. */
export function scoreSummary(method: string, metrics: Record<string, number>, score: number | null): string {
  if (metrics.identityNet !== undefined) {
    const rank = metrics.correctRank;
    return `Identity credit ${metrics.identityReward!.toFixed(3)} minus penalty ${metrics.identityPenalty!.toFixed(3)} = ${metrics.identityNet.toFixed(3)}.`
      + (rank === undefined ? "" : ` Unique correct identity at rank ${rank} of ${metrics.uniqueClaims}; reciprocal rank = ${metrics.reciprocalRank?.toFixed(3)}.`);
  }
  if (method === "rank") {
    const reciprocal = metrics.reciprocalRank ?? 0;
    const inferredRank = reciprocal > 0 ? Math.round(1 / reciprocal) : null;
    const rank = metrics.correctRank ?? inferredRank;
    const submitted = metrics.answersSubmitted ?? metrics.answeredIds;
    return rank === null
      ? `No correct answer was found${submitted === undefined ? "" : ` among ${submitted} submitted candidates`}.`
      : `The correct answer matched at rank ${rank}${submitted === undefined ? "" : ` of ${submitted} submitted candidates`}; reciprocal rank = ${reciprocal.toFixed(3)}.`;
  }
  if (method === "set-f1") {
    return `Set F1 = ${(metrics.f1 ?? score ?? 0).toFixed(3)} (precision ${(metrics.precision ?? 0).toFixed(3)}, recall ${(metrics.recall ?? 0).toFixed(3)}).`;
  }
  if (method === "distance") {
    return `Location error = ${(metrics.metres ?? 0).toFixed(1)} metres; score = ${score === null ? "not calculated" : score.toFixed(3)}.`;
  }
  if (method === "top1") return `Top answer was ${score === 1 ? "correct" : "incorrect"}.`;
  if (method === "interval-iou") return `Interval intersection-over-union = ${(metrics.iou ?? score ?? 0).toFixed(3)}.`;
  if (method === "hierarchical") return `Hierarchical credit = ${score === null ? "not calculated" : score.toFixed(3)}.`;
  if (method === "record") return `Weighted record score = ${score === null ? "not calculated" : score.toFixed(3)}.`;
  return `Score = ${score === null ? "not calculated" : score.toFixed(3)} using ${method}.`;
}

function renderIssue(issue: ValidationIssue): string {
  return issue.field ? `${issue.field}: ${issue.message}` : issue.message;
}

function statusNote(status: ScoreStatus): string {
  switch (status) {
    case "not-run":
      return "task was not run";
    case "timeout":
      return "container hit its timeout without an answer";
    case "error":
      return "container failed to run";
    case "no-answer":
      return "agent exited without writing an answer";
    default:
      return "answer file missing or unreadable";
  }
}

function runIdOf(runDir: string): string {
  return runDir.replace(/\/+$/, "").split("/").pop() ?? runDir;
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

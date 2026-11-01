/**
 * Corpus-level numbers: per family, then over the run.
 *
 * Each generator names an aggregation in its scoring spec — "mrr; also report
 * top-1 accuracy", "macro-F1 over mode labels", "median and mean distance
 * error". Those aggregations are all of one of three sorts, so this computes
 * all three for every family and lets the report show whichever the family
 * asked for: the mean (and median) of each metric the task scorers emitted,
 * a macro-F1 over pooled label observations, and the headline mean.
 *
 * A task with no answer scores nothing rather than zero, so both readings are
 * kept: `meanScore` counts an unanswered task as 0, `meanScoreAnswered` leaves
 * it out. The first is the benchmark number; the second says how good the
 * answers that did arrive were.
 */

import { macroF1, mean, median, type LabelObservation, type MacroF1 } from "./metrics.ts";
import type { ScoreStatus, TaskScore } from "./score.ts";

export interface MetricAggregate {
  mean: number;
  median: number;
  n: number;
}

export interface FamilyAggregate {
  family: string;
  tasks: number;
  /** Tasks the run actually attempted; the rest were never run. */
  attempted: number;
  scored: number;
  statuses: Record<string, number>;
  /** Unanswered tasks count as 0. */
  meanScore: number | null;
  /** Unanswered tasks are left out. */
  meanScoreAnswered: number | null;
  metrics: Record<string, MetricAggregate>;
  /** Present where the family answers labels; keyed by answer field. */
  labels?: Record<string, MacroF1>;
  /** What the generator asked to be reported, verbatim. */
  aggregate?: string;
}

export interface RunAggregate {
  tasks: number;
  attempted: number;
  scored: number;
  statuses: Record<string, number>;
  meanScore: number | null;
  meanScoreAnswered: number | null;
  families: FamilyAggregate[];
}

export function aggregate(tasks: readonly TaskScore[]): RunAggregate {
  const byFamily = new Map<string, TaskScore[]>();
  for (const task of tasks) {
    const bucket = byFamily.get(task.family);
    if (bucket) bucket.push(task);
    else byFamily.set(task.family, [task]);
  }
  const families = [...byFamily.entries()]
    .map(([family, group]) => aggregateFamily(family, group))
    .sort((a, b) => a.family.localeCompare(b.family));
  const attempted = tasks.filter(wasAttempted);
  return {
    tasks: tasks.length,
    attempted: attempted.length,
    scored: tasks.filter((task) => task.status === "scored").length,
    statuses: countStatuses(tasks),
    meanScore: mean(attempted.map((task) => task.score ?? 0)),
    meanScoreAnswered: mean(tasks.filter((task) => task.score !== null).map((task) => task.score!)),
    families,
  };
}

export function aggregateFamily(family: string, tasks: readonly TaskScore[]): FamilyAggregate {
  const metricValues = new Map<string, number[]>();
  const labelObservations = new Map<string, LabelObservation[]>();
  for (const task of tasks) {
    for (const [key, value] of Object.entries(task.metrics)) {
      if (!Number.isFinite(value)) continue;
      const bucket = metricValues.get(key);
      if (bucket) bucket.push(value);
      else metricValues.set(key, [value]);
    }
    for (const observation of task.labels ?? []) {
      const bucket = labelObservations.get(observation.field);
      if (bucket) bucket.push(observation);
      else labelObservations.set(observation.field, [observation]);
    }
  }

  const metrics: Record<string, MetricAggregate> = {};
  for (const [key, values] of [...metricValues].sort(([a], [b]) => a.localeCompare(b))) {
    metrics[key] = { mean: mean(values)!, median: median(values)!, n: values.length };
  }

  // Multi-label families pool one binary decision per label; those are folded
  // back into a single macro-F1 rather than left as dozens of fields.
  const labels: Record<string, MacroF1> = {};
  const binary: LabelObservation[] = [];
  for (const [field, observations] of labelObservations) {
    if (field.startsWith("kind:")) binary.push(...observations);
    else labels[field] = macroF1(observations);
  }
  if (binary.length > 0) labels.kinds = macroF1(binary);

  const attempted = tasks.filter(wasAttempted);
  return {
    family,
    tasks: tasks.length,
    attempted: attempted.length,
    scored: tasks.filter((task) => task.status === "scored").length,
    statuses: countStatuses(tasks),
    meanScore: mean(attempted.map((task) => task.score ?? 0)),
    meanScoreAnswered: mean(tasks.filter((task) => task.score !== null).map((task) => task.score!)),
    metrics,
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

/**
 * A task the run never reached is not a wrong answer. It stays in the task
 * count, so a partial run cannot look complete, but it is left out of the
 * mean, so a run in progress reads as what it has done so far.
 */
function wasAttempted(task: TaskScore): boolean {
  return task.status !== "not-run";
}

function countStatuses(tasks: readonly TaskScore[]): Record<string, number> {
  const counts: Partial<Record<ScoreStatus, number>> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts as Record<string, number>;
}

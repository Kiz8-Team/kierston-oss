/**
 * What moved, and how much of what moved is worth reading.
 *
 * Two profiles of the same city differ in tens of thousands of numbers, nearly
 * all of them by nothing that matters. The job here is a ranking, and the
 * ranking needs one scale that a mean income, a mode split and a violation
 * count can all be placed on. So every comparison reports a score in units of
 * "just about noticeable":
 *
 *     1.0   a change at the edge of meaning anything — a percent on a count,
 *           half a point on a share, half a percent of a standard deviation
 *    10.0   a change nobody would call noise
 *   100.0   a violation that was not there before, or a category that was
 *
 * The thresholds behind that scale are the only tuning in iceberg and they are
 * gathered at the top of this file. They are deliberately not per-metric: a
 * per-metric tolerance is a place to hide a regression by widening it, and the
 * honest way to say "this one always wobbles" is to read the diff and know it.
 *
 * A note on counts. Regenerate a city at a different size and every count in
 * the profile moves together; that is not a finding, it is the run being
 * bigger. Shares and rates are what hold still, which is why the analysis
 * records both and why a diff that is nothing but proportional count changes
 * reads, correctly, as one uninteresting block near the bottom.
 */

import type { CatMetric, InvariantMetric, Metric, NumMetric, Profile, ScalarMetric } from "./metrics.ts";
import { OTHER } from "./metrics.ts";

/** One percent of a count, or of a mean, scores 1. */
const RELATIVE = 0.01;
/** Half a point on a share scores 1. */
const SHARE = 0.005;
/** Half a percent of a standard deviation scores 1. */
const EFFECT = 0.005;
/** Half a point of total variation between two distributions scores 1. */
const TOTAL_VARIATION = 0.005;
/** A distribution's spread has to move by three percent to score 1. */
const SPREAD = 0.03;
/** A rule that starts being broken, or a category that appears from nowhere. */
const STRUCTURAL = 100;

export interface Finding {
  path: string;
  score: number;
  /** What changed, in one line. */
  headline: string;
  /** The rest of it: per-category deltas, the quantiles that moved. */
  detail: string[];
  /** For grouping the report — the first two segments of the path. */
  section: string;
  class: "invariant" | "structure" | "distribution" | "level";
}

export interface Diff {
  baseline: Profile;
  candidate: Profile;
  findings: Finding[];
  /** Rules broken in the candidate, whether or not they moved. */
  violations: { path: string; rule: string; violations: number; checked: number; examples: string[]; was: number | null }[];
  provenance: { key: string; from: unknown; to: unknown }[];
  compared: number;
}

export function diff(baseline: Profile, candidate: Profile): Diff {
  const findings: Finding[] = [];
  const paths = new Set([...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics)]);
  let compared = 0;

  for (const path of [...paths].sort()) {
    const before = baseline.metrics[path];
    const after = candidate.metrics[path];
    if (!before && after) {
      findings.push(structural(path, "new metric", after));
      continue;
    }
    if (before && !after) {
      findings.push(structural(path, "metric removed", before));
      continue;
    }
    if (!before || !after || before.t !== after.t) {
      if (before && after) findings.push(structural(path, `changed shape: ${before.t} → ${after.t}`, after));
      continue;
    }
    compared += 1;
    const finding = compare(path, before, after);
    if (finding) findings.push(finding);
  }

  const violations = [];
  for (const [path, metric] of Object.entries(candidate.metrics)) {
    if (metric.t !== "invariant" || !metric.violations) continue;
    const before = baseline.metrics[path];
    violations.push({
      path,
      rule: metric.rule,
      violations: metric.violations,
      checked: metric.checked,
      examples: metric.examples,
      was: before?.t === "invariant" ? before.violations : null,
    });
  }
  violations.sort((a, b) => b.violations - a.violations);

  const provenance = [];
  for (const key of new Set([...Object.keys(baseline.provenance), ...Object.keys(candidate.provenance)])) {
    const from = baseline.provenance[key];
    const to = candidate.provenance[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) provenance.push({ key, from, to });
  }

  findings.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return { baseline, candidate, findings, violations, provenance, compared };
}

function compare(path: string, before: Metric, after: Metric): Finding | null {
  switch (before.t) {
    case "scalar": return scalar(path, before, after as ScalarMetric);
    case "num": return num(path, before, after as NumMetric);
    case "cat": return cat(path, before, after as CatMetric);
    case "invariant": return invariant(path, before, after as InvariantMetric);
  }
}

function scalar(path: string, before: ScalarMetric, after: ScalarMetric): Finding | null {
  const delta = after.v - before.v;
  if (delta === 0) return null;
  const relative = before.v !== 0 ? Math.abs(delta / before.v) : Infinity;
  const score = after.unit === "share"
    ? Math.max(Math.abs(delta) / SHARE, relative / RELATIVE * 0.25)
    : (before.v === 0 ? STRUCTURAL / 4 : relative / RELATIVE);
  if (score < 1) return null;
  return {
    path,
    score,
    section: sectionOf(path),
    class: "level",
    headline: `${show(before.v, before.unit)} → ${show(after.v, after.unit)}${suffix(before, after, delta, relative)}`,
    detail: [],
  };
}

function suffix(before: ScalarMetric, after: ScalarMetric, delta: number, relative: number): string {
  if (after.unit === "share") return `  (${signed(delta * 100)} points)`;
  if (!Number.isFinite(relative)) return "";
  return `  (${signed(delta > 0 ? relative * 100 : -relative * 100)}%)`;
}

function num(path: string, before: NumMetric, after: NumMetric): Finding | null {
  const spread = Math.max(before.sd, after.sd, 1e-9);
  const meanShift = after.mean - before.mean;
  const effect = Math.abs(meanShift) / spread;
  const meanRelative = before.mean !== 0 ? Math.abs(meanShift / before.mean) : (meanShift ? Infinity : 0);
  const medianShift = after.q[3] - before.q[3];
  const medianRelative = before.q[3] !== 0 ? Math.abs(medianShift / before.q[3]) : (medianShift ? Infinity : 0);
  const sdRelative = before.sd !== 0 ? Math.abs((after.sd - before.sd) / before.sd) : 0;
  const beforeNulls = before.n + before.nulls ? before.nulls / (before.n + before.nulls) : 0;
  const afterNulls = after.n + after.nulls ? after.nulls / (after.n + after.nulls) : 0;
  const nullShift = Math.abs(afterNulls - beforeNulls);
  const countRelative = before.n !== 0 ? Math.abs((after.n - before.n) / before.n) : (after.n ? Infinity : 0);

  const drivers: [number, string][] = [
    [Math.min(effect / EFFECT, meanRelative / RELATIVE), `mean ${trim(before.mean)} → ${trim(after.mean)} (${signed(meanShift)}, ${trim(effect)} sd)`],
    [medianRelative / RELATIVE, `median ${trim(before.q[3])} → ${trim(after.q[3])}`],
    [sdRelative / SPREAD, `spread ${trim(before.sd)} → ${trim(after.sd)}`],
    [nullShift / SHARE, `missing ${percent(beforeNulls)} → ${percent(afterNulls)}`],
    [countRelative / RELATIVE, `${before.n.toLocaleString()} → ${after.n.toLocaleString()} values`],
  ];
  drivers.sort((a, b) => b[0] - a[0]);
  const score = drivers[0][0];
  if (score < 1) return null;

  const detail: string[] = [];
  for (const [driverScore, text] of drivers.slice(1)) if (driverScore >= 1) detail.push(text);
  const tails = [
    ["p5", before.q[1], after.q[1]], ["p25", before.q[2], after.q[2]],
    ["p75", before.q[4], after.q[4]], ["p95", before.q[5], after.q[5]],
  ] as const;
  const moved = tails.filter(([, from, to]) => from !== to);
  if (moved.length) {
    detail.push(moved.map(([name, from, to]) => `${name} ${trim(from)}→${trim(to)}`).join("  "));
  }
  if (before.min !== after.min || before.max !== after.max) {
    detail.push(`range ${trim(before.min)}..${trim(before.max)} → ${trim(after.min)}..${trim(after.max)}`);
  }
  if (before.negatives !== after.negatives) {
    detail.push(`negatives ${before.negatives.toLocaleString()} → ${after.negatives.toLocaleString()}`);
  }

  return { path, score, section: sectionOf(path), class: "distribution", headline: drivers[0][1], detail };
}

function cat(path: string, before: CatMetric, after: CatMetric): Finding | null {
  const labels = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  const shareBefore = (label: string) => (before.n ? (before.counts[label] ?? 0) / before.n : 0);
  const shareAfter = (label: string) => (after.n ? (after.counts[label] ?? 0) / after.n : 0);

  let variation = 0;
  const moves: { label: string; from: number; to: number; delta: number }[] = [];
  const appeared: string[] = [];
  const vanished: string[] = [];
  // How much of the distribution the appearances and disappearances account
  // for. A category that shows up holding two percent is a different event
  // from one holding four rows, and scoring both as "structural" would put
  // every rounding artefact at the top of the report.
  let structuralShare = 0;
  for (const label of labels) {
    if (label === OTHER) continue;
    const from = shareBefore(label);
    const to = shareAfter(label);
    variation += Math.abs(to - from) / 2;
    if (from !== to) moves.push({ label, from, to, delta: to - from });
    if (!(label in before.counts) && (after.counts[label] ?? 0) > 0) {
      appeared.push(label);
      structuralShare = Math.max(structuralShare, to);
    }
    if (!(label in after.counts) && (before.counts[label] ?? 0) > 0) {
      vanished.push(label);
      structuralShare = Math.max(structuralShare, from);
    }
  }

  const structural = appeared.length || vanished.length;
  const score = Math.max(
    variation / TOTAL_VARIATION,
    structuralShare / SHARE,
    // A category that comes or goes is worth reading even at four rows.
    structural ? 3 : 0,
  );
  if (score < 1) return null;

  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const detail = moves.slice(0, 8).map((move) =>
    `${move.label}: ${percent(move.from)} → ${percent(move.to)} (${signed(move.delta * 100)} pts)`);
  if (appeared.length) detail.unshift(`new: ${appeared.slice(0, 8).join(", ")}${appeared.length > 8 ? ` +${appeared.length - 8}` : ""}`);
  if (vanished.length) detail.unshift(`gone: ${vanished.slice(0, 8).join(", ")}${vanished.length > 8 ? ` +${vanished.length - 8}` : ""}`);

  return {
    path,
    score,
    section: sectionOf(path),
    class: structuralShare >= SHARE ? "structure" : "distribution",
    headline: `${before.distinct} → ${after.distinct} categories, ${percent(variation)} of the distribution moved`,
    detail,
  };
}

function invariant(path: string, before: InvariantMetric, after: InvariantMetric): Finding | null {
  if (before.violations === after.violations) return null;
  const worse = after.violations > before.violations;
  const score = before.violations === 0
    ? STRUCTURAL
    : Math.abs(after.violations - before.violations) / before.violations / RELATIVE;
  if (score < 1) return null;
  return {
    path,
    score,
    section: sectionOf(path),
    class: "invariant",
    headline: `${worse ? "now broken" : "less broken"}: ${before.violations.toLocaleString()} → ${after.violations.toLocaleString()} of ${after.checked.toLocaleString()} — ${after.rule}`,
    detail: after.examples.slice(0, 3),
  };
}

function structural(path: string, what: string, metric: Metric): Finding {
  const detail: string[] = [];
  if (metric.t === "cat") detail.push(`${metric.distinct} categories over ${metric.n.toLocaleString()} rows`);
  if (metric.t === "num") detail.push(`${metric.n.toLocaleString()} values, mean ${trim(metric.mean)}`);
  if (metric.t === "scalar") detail.push(show(metric.v, metric.unit));
  if (metric.t === "invariant") detail.push(`${metric.violations.toLocaleString()} violations — ${metric.rule}`);
  return { path, score: STRUCTURAL / 2, section: sectionOf(path), class: "structure", headline: what, detail };
}

const sectionOf = (path: string) => path.split(".").slice(0, 2).join(".");

export const percent = (share: number) => `${(share * 100).toFixed(share < 0.01 && share > 0 ? 2 : 1)}%`;

export function trim(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString();
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString();
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

const signed = (value: number) => `${value > 0 ? "+" : "-"}${trim(Math.abs(value))}`;

function show(value: number, unit: ScalarMetric["unit"]): string {
  switch (unit) {
    case "share": return percent(value);
    case "money": return `$${trim(value)}`;
    case "km": return `${trim(value)} km`;
    case "minutes": return `${trim(value)} min`;
    case "years": return `${trim(value)} y`;
    default: return trim(value);
  }
}

/** Reusable statistical test runner built on Iceberg profiles. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diff, type Finding } from "./diff.ts";
import type { Metric, Profile } from "./metrics.ts";

export interface MetricBand {
  /** Maximum relative movement for scalars and distribution means/medians. */
  relative?: number;
  /** Maximum absolute movement, useful for shares and minutes. */
  absolute?: number;
  /** A range the candidate value itself must remain inside. */
  range?: readonly [number, number];
  /** Maximum movement of any individual categorical share. */
  categoryAbsolute?: number;
}

export interface SuitePolicy {
  /** Metric-path patterns. `*` matches one segment and `**` the remainder. */
  bands?: Record<string, MetricBand>;
  /** New invariant violations are always hard failures by default. */
  invariants?: "no-new" | "zero";
}

export interface IcebergSuite {
  name: string;
  profile(): Profile | Promise<Profile>;
  policy?: SuitePolicy;
}

export interface SuiteResult {
  suite: string;
  profile: Profile;
  findings: Finding[];
  failures: string[];
  updated: boolean;
}

export async function runSuite(
  suite: IcebergSuite,
  expectationDir: string,
  update = false,
): Promise<SuiteResult> {
  const candidate = await suite.profile();
  const path = join(expectationDir, `${suite.name}.json`);
  if (update) {
    mkdirSync(expectationDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(candidate, null, 1)}\n`);
    return { suite: suite.name, profile: candidate, findings: [], failures: [], updated: true };
  }
  if (!existsSync(path)) {
    return {
      suite: suite.name,
      profile: candidate,
      findings: [],
      failures: [`missing expectation ${path}; run iceberg test --update ${suite.name}`],
      updated: false,
    };
  }
  const expected = JSON.parse(readFileSync(path, "utf8")) as Profile;
  const digest = expected.provenance.populationDigest;
  if (digest !== undefined && candidate.provenance.populationDigest !== digest) {
    return {
      suite: suite.name,
      profile: candidate,
      findings: [],
      failures: [
        `population digest changed: expected ${String(digest)}, got ${String(candidate.provenance.populationDigest)}; `
        + `review and run iceberg test --update ${suite.name}`,
      ],
      updated: false,
    };
  }
  const comparison = diff(expected, candidate);
  return {
    suite: suite.name,
    profile: candidate,
    findings: comparison.findings,
    failures: failures(expected, candidate, suite.policy),
    updated: false,
  };
}

export function failures(expected: Profile, candidate: Profile, policy: SuitePolicy = {}): string[] {
  const out: string[] = [];
  const invariantPolicy = policy.invariants ?? "no-new";
  for (const [path, metric] of Object.entries(candidate.metrics)) {
    if (metric.t !== "invariant") continue;
    const before = expected.metrics[path];
    const allowed = invariantPolicy === "zero"
      ? 0
      : before?.t === "invariant" ? before.violations : 0;
    if (metric.violations > allowed) {
      out.push(`${path}: ${metric.violations} violations, allowed ${allowed} — ${metric.rule}`);
    }
  }
  for (const [pattern, band] of Object.entries(policy.bands ?? {})) {
    const paths = new Set([
      ...Object.keys(expected.metrics).filter((path) => matches(pattern, path)),
      ...Object.keys(candidate.metrics).filter((path) => matches(pattern, path)),
    ]);
    if (!paths.size) out.push(`${pattern}: policy pattern matched no metrics`);
    for (const path of paths) {
      const before = expected.metrics[path];
      const after = candidate.metrics[path];
      if (!before || !after || before.t !== after.t) {
        out.push(`${path}: metric is missing or changed shape`);
        continue;
      }
      const values = comparable(before, after);
      if (before.t === "cat" && after.t === "cat" && band.categoryAbsolute !== undefined) {
        for (const category of new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])) {
          const from = (before.counts[category] ?? 0) / Math.max(1, before.n);
          const to = (after.counts[category] ?? 0) / Math.max(1, after.n);
          if (Math.abs(to - from) > band.categoryAbsolute) {
            out.push(
              `${path}.${category}: share moved ${(Math.abs(to - from) * 100).toFixed(2)} points, `
              + `allowed ${(band.categoryAbsolute * 100).toFixed(2)}`,
            );
          }
        }
      }
      if (!values) continue;
      for (const [label, from, to] of values) {
        if (band.range && (to < band.range[0] || to > band.range[1])) {
          out.push(`${path}.${label}: ${to} outside ${band.range[0]}..${band.range[1]}`);
        }
        const absolute = Math.abs(to - from);
        const relative = from === 0 ? (to === 0 ? 0 : Infinity) : absolute / Math.abs(from);
        const absoluteFails = band.absolute !== undefined && absolute > band.absolute;
        const relativeFails = band.relative !== undefined && relative > band.relative;
        const hasTolerance = band.absolute !== undefined || band.relative !== undefined;
        // When both forms are supplied they are alternative tolerances: an
        // eight-metre change around zero should not fail a percentage band.
        if (hasTolerance && (band.absolute === undefined || absoluteFails) && (band.relative === undefined || relativeFails)) {
          const allowed = [
            band.absolute === undefined ? null : `${band.absolute} absolute`,
            band.relative === undefined ? null : `${(band.relative * 100).toFixed(2)}% relative`,
          ].filter(Boolean).join(" or ");
          out.push(`${path}.${label}: moved ${absolute} (${(relative * 100).toFixed(2)}%), allowed ${allowed}`);
        }
      }
    }
  }
  return out;
}

function comparable(before: Metric, after: Metric): [string, number, number][] | null {
  if (before.t === "scalar" && after.t === "scalar") return [["value", before.v, after.v]];
  if (before.t === "num" && after.t === "num") {
    return [["mean", before.mean, after.mean], ["median", before.q[3], after.q[3]]];
  }
  if (before.t === "invariant" || after.t === "invariant") return null;
  // Categorical movement is already captured more meaningfully by Iceberg's
  // total-variation finding and can be gated through explicit share scalars.
  return null;
}

function matches(pattern: string, path: string): boolean {
  const escaped = pattern.split(".").map((part) => {
    if (part === "**") return ".*";
    if (part === "*") return "[^.]+";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("\\.");
  return new RegExp(`^${escaped}$`).test(path);
}

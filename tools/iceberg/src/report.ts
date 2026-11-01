/**
 * Printing a diff so the first screen is the answer.
 *
 * A run over sim_init.bin measures somewhere north of twenty thousand things,
 * and after a real code change a few hundred of them will have moved. Printing
 * those in path order would bury the one that matters under four hundred lines
 * of mortgage originations drifting by a percent, so the order here is always
 * severity, and the sections are only a way of laying out what survived the
 * threshold.
 *
 * Broken rules come first and are printed whether or not they moved. A file
 * that has always had eleven legs arriving before they departed is not a
 * regression, but it is not a fact anybody should have to remember either.
 */

import { percent, trim, type Diff, type Finding } from "./diff.ts";
import type { InvariantMetric, Profile } from "./metrics.ts";

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (colour ? `[${code}m${text}[0m` : text);
const bold = (text: string) => paint("1", text);
const dim = (text: string) => paint("2", text);
const red = (text: string) => paint("31", text);
const yellow = (text: string) => paint("33", text);
const green = (text: string) => paint("32", text);
const cyan = (text: string) => paint("36", text);

export interface ReportOptions {
  /** Findings below this score are not printed. */
  threshold: number;
  /** How many findings to print, or every one of them. */
  top: number | "all";
}

/** Rough severity, only ever used to pick a colour and a marker. */
function mark(score: number): string {
  if (score >= 50) return red("███");
  if (score >= 10) return yellow("██▁");
  if (score >= 3) return cyan("█▁▁");
  return dim("▁▁▁");
}

export function reportDiff(result: Diff, options: ReportOptions): string {
  const out: string[] = [];
  const { baseline, candidate } = result;
  out.push("");
  out.push(bold(`iceberg  ${candidate.source}  vs baseline  ${baseline.source}`));
  out.push(dim(`  baseline recorded ${baseline.recordedAt.slice(0, 19).replace("T", " ")} · ${result.compared.toLocaleString()} metrics compared`));

  if (result.provenance.length) {
    out.push("");
    out.push(bold("provenance"));
    for (const change of result.provenance) {
      out.push(`  ${change.key}: ${dim(String(change.from))} → ${String(change.to)}`);
    }
  }

  const shown = result.findings.filter((finding) => finding.score >= options.threshold);
  const invariants = shown.filter((finding) => finding.class === "invariant");
  const rest = shown.filter((finding) => finding.class !== "invariant");

  if (invariants.length) {
    out.push("");
    out.push(bold(red(`changed rules  (${invariants.length})`)));
    for (const finding of invariants) out.push(...lines(finding));
  }

  if (result.violations.length) {
    out.push("");
    out.push(bold(`rules broken in ${candidate.source}  (${result.violations.length})`));
    for (const violation of result.violations.slice(0, 20)) {
      const share = violation.checked ? ` of ${violation.checked.toLocaleString()} (${percent(violation.violations / violation.checked)})` : "";
      const was = violation.was === null ? dim(" · new check") : violation.was === violation.violations ? dim(" · unchanged") : ` · was ${violation.was.toLocaleString()}`;
      out.push(`  ${violation.violations === violation.was ? yellow("·") : red("!")} ${violation.path}`);
      out.push(`      ${violation.violations.toLocaleString()}${share} — ${dim(violation.rule)}${was}`);
      for (const example of violation.examples.slice(0, 2)) out.push(dim(`      ${example}`));
    }
    if (result.violations.length > 20) out.push(dim(`  …and ${result.violations.length - 20} more`));
  }

  const limit = options.top === "all" ? rest.length : options.top;
  if (rest.length) {
    out.push("");
    out.push(bold(`changed metrics  (${rest.length} above ${options.threshold}, showing ${Math.min(limit, rest.length)})`));
    let section = "";
    for (const finding of rest.slice(0, limit)) {
      if (finding.section !== section) {
        section = finding.section;
        out.push("");
        out.push(dim(`  ── ${section} ──`));
      }
      out.push(...lines(finding));
    }
    if (rest.length > limit) {
      out.push("");
      out.push(dim(`  …and ${rest.length - limit} more above the threshold (--top all)`));
    }
  }

  out.push("");
  if (!shown.length) out.push(green(`  no metric moved by more than ${options.threshold} (${result.compared.toLocaleString()} compared)`));
  else out.push(dim(`  ${shown.length} of ${result.compared.toLocaleString()} metrics moved past the threshold`));
  out.push("");
  return out.join("\n");
}

function lines(finding: Finding): string[] {
  const out = [`  ${mark(finding.score)} ${bold(finding.path)}  ${dim(`×${trim(finding.score)}`)}`];
  out.push(`      ${finding.headline}`);
  for (const line of finding.detail) out.push(dim(`      ${line}`));
  return out;
}

/** What one profile says on its own, for a first run with nothing to compare. */
export function reportProfile(profile: Profile): string {
  const out: string[] = [];
  out.push("");
  out.push(bold(`iceberg  ${profile.source}  (${profile.kind})`));
  const stamps = Object.entries(profile.provenance).map(([key, value]) => `${key} ${value}`);
  if (stamps.length) out.push(dim(`  ${stamps.join(" · ")}`));
  out.push(dim(`  ${Object.keys(profile.metrics).length.toLocaleString()} metrics recorded`));

  const counts = Object.entries(profile.metrics)
    .filter(([path, metric]) => metric.t === "scalar" && /\.(count|rows)\b|\.rows$/.test(path));
  if (counts.length) {
    out.push("");
    out.push(bold("counts"));
    for (const [path, metric] of counts.slice(0, 40)) {
      out.push(`  ${path.padEnd(46)} ${trim((metric as any).v)}`);
    }
    if (counts.length > 40) out.push(dim(`  …and ${counts.length - 40} more`));
  }

  const broken = Object.entries(profile.metrics)
    .filter(([, metric]) => metric.t === "invariant" && (metric as InvariantMetric).violations > 0)
    .sort((a, b) => (b[1] as InvariantMetric).violations - (a[1] as InvariantMetric).violations);
  out.push("");
  if (!broken.length) out.push(green(`  no rules broken (${Object.values(profile.metrics).filter((metric) => metric.t === "invariant").length} checked)`));
  else {
    out.push(bold(red(`rules broken  (${broken.length})`)));
    for (const [path, metric] of broken as [string, InvariantMetric][]) {
      out.push(`  ${red("!")} ${path}`);
      out.push(`      ${metric.violations.toLocaleString()} of ${metric.checked.toLocaleString()} (${percent(metric.checked ? metric.violations / metric.checked : 0)}) — ${dim(metric.rule)}`);
      for (const example of metric.examples.slice(0, 2)) out.push(dim(`      ${example}`));
    }
  }
  out.push("");
  return out.join("\n");
}

/** The same diff as markdown, for pasting into a pull request. */
export function markdownDiff(result: Diff, options: ReportOptions): string {
  const out: string[] = [];
  out.push(`# iceberg — ${result.candidate.source} vs ${result.baseline.source}`);
  out.push("");
  out.push(`Baseline recorded ${result.baseline.recordedAt}. ${result.compared.toLocaleString()} metrics compared.`);
  if (result.provenance.length) {
    out.push("");
    out.push("| provenance | baseline | candidate |");
    out.push("| --- | --- | --- |");
    for (const change of result.provenance) out.push(`| ${change.key} | ${change.from} | ${change.to} |`);
  }
  if (result.violations.length) {
    out.push("");
    out.push("## Rules broken");
    out.push("");
    out.push("| rule | violations | of | was |");
    out.push("| --- | --- | --- | --- |");
    for (const violation of result.violations) {
      out.push(`| \`${violation.path}\` — ${violation.rule} | ${violation.violations.toLocaleString()} | ${violation.checked.toLocaleString()} | ${violation.was ?? "—"} |`);
    }
  }
  const shown = result.findings.filter((finding) => finding.score >= options.threshold);
  const limit = options.top === "all" ? shown.length : options.top;
  out.push("");
  out.push(`## Changed metrics (${shown.length} above ${options.threshold})`);
  let section = "";
  for (const finding of shown.slice(0, limit)) {
    if (finding.section !== section) {
      section = finding.section;
      out.push("");
      out.push(`### ${section}`);
    }
    out.push("");
    out.push(`**\`${finding.path}\`** ×${trim(finding.score)} — ${finding.headline}`);
    out.push("");
    for (const line of finding.detail) out.push(`- ${line}`);
  }
  out.push("");
  return out.join("\n");
}

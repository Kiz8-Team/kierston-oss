/**
 * Rendering scores for a terminal, a spreadsheet, or a pipe.
 *
 * The table helpers here are also what the bench CLI draws with, so a
 * family table looks the same whether it was printed by `score` or scrolled
 * past in the TUI.
 */

import type { RunScore, TaskScore } from "./score.ts";
import type { FamilyAggregate } from "./aggregate.ts";

export type Align = "left" | "right";

export function pad(text: string, width: number, align: Align = "left"): string {
  const clipped = text.length > width ? (width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + "…") : text;
  const gap = " ".repeat(Math.max(0, width - clipped.length));
  return align === "right" ? gap + clipped : clipped + gap;
}

/** A plain column table: two spaces between columns, no borders. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], aligns: readonly Align[] = []): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => pad(cell ?? "", widths[column]!, aligns[column] ?? "left")).join("  ").trimEnd();
  return [line(headers), widths.map((width) => "─".repeat(width)).join("  "), ...rows.map(line)];
}

export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : `${(value * 100).toFixed(digits)}%`;
}

export function fixed(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : value.toFixed(digits);
}

/** The mean of the first metric whose name matches, unprefixed first. */
function metric(family: FamilyAggregate, suffix: string, statistic: "mean" | "median" = "mean"): number | null {
  const exact = family.metrics[suffix];
  if (exact) return exact[statistic];
  for (const [key, value] of Object.entries(family.metrics)) {
    if (key.endsWith(`.${suffix}`)) return value[statistic];
  }
  return null;
}

function macro(family: FamilyAggregate): number | null {
  const entries = Object.values(family.labels ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((sum, entry) => sum + entry.macroF1, 0) / entries.length;
}

/**
 * The metric columns a family table can carry, in the order they are shown.
 * No family reports all of them — a ranking family has no IoU, a geolocation
 * family has no macro-F1 — so the table only draws the ones somebody filled in.
 */
const METRIC_COLUMNS: { header: string; of: (family: FamilyAggregate) => string }[] = [
  { header: "ID net", of: (family) => percent(metric(family, "identityNet")) },
  { header: "ID credit", of: (family) => percent(metric(family, "identityReward")) },
  { header: "ID penalty", of: (family) => percent(metric(family, "identityPenalty")) },
  { header: "MRR", of: (family) => fixed(metric(family, "reciprocalRank"), 3) },
  { header: "top-1", of: (family) => percent(metric(family, "top1")) },
  { header: "count acc", of: (family) => percent(family.metrics["count.accuracy"]?.mean) },
  { header: "F1", of: (family) => fixed(metric(family, "f1"), 3) },
  { header: "macro-F1", of: (family) => fixed(macro(family), 3) },
  { header: "med m", of: (family) => fixed(metric(family, "metres", "median"), 0) },
  { header: "IoU", of: (family) => fixed(metric(family, "iou"), 3) },
];

/**
 * The one metric this family is really reported by, named so a single column
 * can carry a different measure on every row.
 */
export function familyHeadline(family: FamilyAggregate): { label: string; value: string } | null {
  if (family.family === "vehicle-occupancy" && family.metrics["occupants.identityNet"]) {
    return { label: "count / identity net", value: `${percent(family.metrics["count.accuracy"]?.mean)} / ${percent(family.metrics["occupants.identityNet"]?.mean)}` };
  }
  if (family.family === "vehicle-occupancy" && family.metrics["count.accuracy"]) {
    return { label: "count / identity F1", value: `${percent(family.metrics["count.accuracy"]?.mean)} / ${fixed(family.metrics["occupants.f1"]?.mean, 3)}` };
  }
  for (const column of METRIC_COLUMNS) {
    const value = column.of(family);
    if (value !== "") return { label: column.header, value };
  }
  // A family scored by something none of the named columns cover — hierarchical
  // credit, say — is still better named by its own first metric than by a dash.
  const [name, value] = Object.entries(family.metrics)[0] ?? [];
  return name && value ? { label: name.split(".").at(-1)!, value: fixed(value.mean, 3) } : null;
}

export function familyTable(families: readonly FamilyAggregate[]): string[] {
  // Only the metric columns at least one family answers for.
  const columns = METRIC_COLUMNS.filter((column) => families.some((family) => column.of(family) !== ""));
  const rows = families.map((family) => [
    family.family,
    String(family.tasks),
    String(family.attempted),
    String(family.scored),
    String(family.statuses.abstained ?? 0),
    percent(family.attempted ? (family.statuses.abstained ?? 0) / family.attempted : null),
    percent(family.meanScore),
    ...columns.map((column) => column.of(family)),
  ]);
  return table(
    ["family", "n", "run", "scored", "abstained", "abstain %", "score", ...columns.map((column) => column.header)],
    rows,
    ["left", "right", "right", "right", "right", "right", "right", ...columns.map(() => "right" as Align)],
  );
}

export function taskTable(tasks: readonly TaskScore[]): string[] {
  const rows = tasks.map((task) => [
    task.id,
    task.status,
    task.score === null ? "" : percent(task.score),
    task.scoring?.method ?? "",
    task.status === "abstained" ? task.abstentionReason ?? "Explicit abstention" : task.status === "scored" ? (task.scoring?.summary ?? "") : (task.issues[0] ?? ""),
    task.kdiCalls === undefined ? "" : String(task.kdiCalls),
    task.durationMs === undefined ? "" : `${Math.round(task.durationMs / 1000)}s`,
  ]);
  return table(
    ["task", "status", "score", "method", "result", "KDI", "time"],
    rows,
    ["left", "left", "right", "left", "left", "right", "right"],
  );
}

export function renderRunScore(result: RunScore, options: { tasks?: boolean } = {}): string {
  const { aggregate } = result;
  const statuses = Object.entries(aggregate.statuses)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const lines = [
    `${result.series}/${result.runId}  ${aggregate.tasks} task(s), ${aggregate.attempted} run: ${statuses}`,
    `score ${percent(aggregate.meanScore)} over the ${aggregate.attempted} run, ${percent(aggregate.meanScoreAnswered)} over the ${aggregate.scored} scored`,
    `identity policy: ${result.identityPolicy ?? "legacy (unversioned)"}`,
    `policy: ${result.options.ambiguity} identifiers, ${result.options.placeCreditMetres} m place credit, ${result.options.arrivalCreditMinutes} min arrival credit`,
    "",
    ...familyTable(aggregate.families),
  ];
  if (options.tasks) lines.push("", ...taskTable(result.tasks));
  return lines.join("\n");
}

/** One row per task, for a spreadsheet or a diff between two runs. */
export function toCsv(result: RunScore): string {
  const keys = [...new Set(result.tasks.flatMap((task) => Object.keys(task.metrics)))].sort();
  const header = ["task", "family", "date", "status", "score", "kdiCalls", "durationMs", "abstentionReason", ...keys];
  const rows = result.tasks.map((task) => [
    task.id,
    task.family,
    task.date,
    task.status,
    task.score === null ? "" : String(task.score),
    task.kdiCalls === undefined ? "" : String(task.kdiCalls),
    task.durationMs === undefined ? "" : String(task.durationMs),
    task.abstentionReason ?? "",
    ...keys.map((key) => (task.metrics[key] === undefined ? "" : String(task.metrics[key]))),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

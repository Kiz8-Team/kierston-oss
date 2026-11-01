/**
 * Bench-specific presentation shared by several pages: how a container's exit
 * is explained, how an answer is laid out, how KDI calls are tabulated.
 */

import { bar, duration, fit, paint, percent } from "../format.ts";
import type { TaskRow } from "../inventory.ts";
import { parseKdiCall, type KdiCall } from "../kdi-call.ts";
import type { Check } from "../preflight.ts";
import { tableLines, wrap, type Column } from "./widgets.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(spin: number): string {
  return paint(SPINNER[spin % SPINNER.length]!, "cyan");
}

/** Statuses that mean the run got no usable answer out of the task. */
const BAD_STATUSES = new Set(["no-answer", "invalid-answer", "timeout", "error", "not-run"]);

/** A task worth looking at: no usable answer, or an answer that scored nothing. */
export function isProblem(task: TaskRow): boolean {
  if (BAD_STATUSES.has(task.status)) return true;
  return task.score !== null && task.score !== undefined && task.score <= 0;
}

/**
 * What the container did, when that is the real explanation. A task with no
 * answer whose container was killed did not "exit without writing an answer" —
 * it never got to run, and saying so is the difference between blaming the
 * agent and looking at docker.
 */
export function containerNote(task: TaskRow, long = false): string | null {
  if (task.aborted) return paint("aborted by operator", "red");
  if (task.hasAnswer || task.exitCode === undefined || task.exitCode === null || task.exitCode === 0) return null;
  if (task.timedOut) return paint(`timed out (exit ${task.exitCode})`, "magenta");
  const killed = task.exitCode === 137 || task.exitCode === 143;
  const text = killed
    ? `killed by docker (exit ${task.exitCode})${long ? ", not an agent exit" : ""}`
    : `container exited ${task.exitCode}`;
  return paint(text, killed ? "red" : "yellow");
}

/** The note column of a task row: what it is doing, or why it ended as it did. */
export function taskNote(task: TaskRow): string {
  if (task.status === "running" && task.activity) {
    const tool = task.activity.tool ? paint(task.activity.tool, "cyan") : "";
    const header = task.activity.header ? paint(task.activity.header, "grey") : "";
    return [tool, header].filter(Boolean).join(" · ");
  }
  return containerNote(task) ?? task.issues?.[0] ?? task.scoring?.summary ?? "";
}

/** What is left to run, in time, from how long the finished tasks took. */
export function remaining(finished: readonly TaskRow[], left: number, concurrency: number): string {
  const times = finished.map((task) => task.durationMs).filter((ms): ms is number => typeof ms === "number");
  if (times.length === 0 || left <= 0) return "";
  const mean = times.reduce((sum, ms) => sum + ms, 0) / times.length;
  return `about ${duration((mean * left) / Math.max(1, concurrency))} left`;
}

export function scoreBar(value: number | null | undefined, cells = 12): string {
  return value === null || value === undefined ? paint("—", "grey") : `${bar(value, cells)} ${percent(value)}`;
}

export function checkLine(check: Check, columns: number, busy?: string): string {
  const mark = busy ? busy : check.ok ? paint("✓", "green") : check.advisory ? paint("!", "yellow") : paint("✗", "red");
  return fit(`  ${mark} ${fit(check.name, 22)} ${paint(check.detail, check.ok || check.advisory ? "grey" : "reset")}`, columns);
}

export function metricLabel(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

export function metricValue(name: string, value: number): string {
  if (name === "top1" || name.startsWith("recallAt") || name === "withinCredit") return value === 1 ? "yes" : "no";
  if (/rank/i.test(name) && name !== "correctRank") return `${value.toFixed(3)} (${percent(value)})`;
  if (/precision|recall|f1|accuracy|similarity|iou/i.test(name)) return `${value.toFixed(3)} (${percent(value)})`;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function taskScoring(task: Record<string, unknown> | null): { method: string; aggregate: string; summary?: string } | null {
  const value = task?.scoring;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scoring = value as Record<string, unknown>;
  if (typeof scoring.method !== "string" || typeof scoring.aggregate !== "string") return null;
  return { method: scoring.method, aggregate: scoring.aggregate };
}

interface DisplayAnswerSpec {
  kind?: string;
  fields?: Record<string, DisplayAnswerSpec>;
}

export function taskAnswerSpec(task: Record<string, unknown> | null): DisplayAnswerSpec | null {
  const answer = task?.answer;
  return answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as DisplayAnswerSpec) : null;
}

/** Render answer values according to their declared shape instead of dumping JSON syntax. */
export function answerLines(answer: unknown, spec: DisplayAnswerSpec | null, columns: number): string[] {
  if (answer === undefined) return [`  ${paint("(none written)", "grey")}`];
  if (Array.isArray(answer)) {
    if (answer.length === 0) return [`  ${paint("(empty list)", "grey")}`];
    const ranked = spec?.kind === "ranked-ids";
    return answer.flatMap((value, index) => wrappedDetail(ranked ? `${index + 1}.` : "•", displayValue(value), columns, 5));
  }
  if (answer !== null && typeof answer === "object") {
    const record = answer as Record<string, unknown>;
    if (Object.keys(record).length === 0) return [`  ${paint("(empty record)", "grey")}`];
    const ordered = [
      ...Object.keys(spec?.fields ?? {}).filter((name) => name in record),
      ...Object.keys(record).filter((name) => !(name in (spec?.fields ?? {}))),
    ];
    return ordered.flatMap((name) => wrappedDetail(humanLabel(name), displayValue(record[name]), columns, 18));
  }
  return wrappedDetail("value", displayValue(answer), columns, 12);
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "(missing)";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function humanLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

/** A label and wrapped value, with continuation lines aligned under the value. */
function wrappedDetail(label: string, value: string, columns: number, labelWidth: number): string[] {
  const prefix = `  ${label.padEnd(labelWidth)} `;
  const continuation = " ".repeat(prefix.length);
  const available = Math.max(8, columns - prefix.length);
  return wrap(value, available).map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

export function kdiCallTable(calls: readonly KdiCall[], columns: number): string[] {
  const spec: Column[] = [
    { header: "#", width: 3, align: "right" },
    { header: "call", flex: 2 },
    { header: "inputs", flex: 3 },
    { header: "result", width: 15 },
  ];
  const rows = calls.map((call, index) => {
    const parsed = parseKdiCall(call);
    const operation = parsed.target
      ? `${parsed.operation} ${parsed.target.replace(" › ", "/")}`
      : [parsed.operation, ...parsed.options].join(" ");
    const inputs = parsed.inputs.map((input) => `${input.name}=${input.value}`).join(", ");
    return [
      String(index + 1),
      operation,
      inputs || "—",
      call.code === 0
        ? paint(`ok${call.ms === undefined ? "" : ` · ${elapsed(call.ms)}`}`, "green")
        : paint(`error${call.ms === undefined ? "" : ` · ${elapsed(call.ms)}`}`, "red"),
    ];
  });
  return tableLines(spec, rows, { total: columns, height: rows.length });
}

function elapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

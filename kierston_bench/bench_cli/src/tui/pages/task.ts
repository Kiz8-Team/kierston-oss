/**
 * A task, in sections: overview, answer, prompt, KDI calls, console, files.
 * ←→ move between them, ↑↓ scroll. The overview is the "why did this score
 * what it scored" page.
 */

import { duration, paint, percent, status as statusColour } from "../../format.ts";
import { loadTask, type RunDetail, type TaskDetail, type TaskRow } from "../../inventory.ts";
import { familyLabel } from "../../task-selection.ts";
import { abortSelectedTask, rerunSelectedTask, stopRun } from "../actions.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { answerLines, containerNote, kdiCallTable, metricLabel, metricValue, scoreBar, spinner, taskAnswerSpec, taskScoring } from "../render.ts";
import type { Key } from "../screen.ts";
import { DocState } from "../state.ts";
import { fields, position, prosePanel, tabs, viewport, wrap } from "../widgets.ts";

interface Section {
  label: string;
  count?: number;
  /** Lines pinned above the scrolling body, such as a table's column row. */
  header?: () => string[];
  lines: () => string[];
}

export class TaskPage implements Page {
  private task: TaskDetail | null = null;
  private section = 0;
  private readonly docs = new Map<number, DocState>();
  private columns = 80;

  constructor(private readonly ctx: Ctx, private readonly run: RunDetail, private row: TaskRow) {}

  title(): string {
    return this.row.id;
  }

  right(): string {
    const doc = this.doc();
    return position(doc.scroll, doc.height, this.lines().length);
  }

  hints(): Hint[] {
    return [["←→", "section"], ["↑↓", "scroll"], ["X", "stop run"], ["A", "abort"], ["T", "rerun"], ["esc", "back"]];
  }

  async activate(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    // A running task keeps growing; a finished one is re-read cheaply.
    const fresh = this.run.tasks.find((task) => task.id === this.row.id);
    if (fresh) this.row = fresh;
    this.task = await loadTask(this.run.dir, this.row);
  }

  private doc(): DocState {
    let doc = this.docs.get(this.section);
    if (!doc) {
      doc = new DocState();
      this.docs.set(this.section, doc);
    }
    return doc;
  }

  private sections(): Section[] {
    const task = this.task;
    if (!task) return [];
    const columns = this.columns - 2;
    const prompt = typeof task.task?.prompt === "string" ? task.task.prompt : "";
    const sections: Section[] = [
      { label: "overview", lines: () => this.overview(task) },
      {
        label: "answer",
        lines: () => {
          const lines = answerLines(task.answer?.answer, taskAnswerSpec(task.task), columns);
          if (task.answer?.notes) lines.push("", ...prosePanel("agent notes", task.answer.notes, columns));
          return lines;
        },
      },
      { label: "prompt", lines: () => wrap(prompt || "(none)", columns).map((line) => `  ${line}`) },
    ];
    if (task.kdiCalls.length > 0) {
      const drawn = () => kdiCallTable(task.kdiCalls, columns);
      sections.push({ label: "KDI", count: task.kdiCalls.length, header: () => drawn().slice(0, 1), lines: () => drawn().slice(1) });
    }
    if (task.console.length > 0) {
      sections.push({ label: "console", count: task.console.length, lines: () => task.console.map((line) => `  ${paint(line, "grey")}`) });
    }
    if (task.workFiles.length > 0 || task.logFiles.length > 0) {
      sections.push({
        label: "files",
        count: task.workFiles.length + task.logFiles.length,
        lines: () => [
          ...(task.workFiles.length > 0 ? [paint(" work", "bold"), ...task.workFiles.map((name) => `  ${name}`)] : []),
          ...(task.logFiles.length > 0 ? ["", paint(" logs", "bold"), ...task.logFiles.map((name) => `  ${name}`)] : []),
        ],
      });
    }
    return sections;
  }

  private overview(task: TaskDetail): string[] {
    const row = task.row;
    const scoring = row.scoring ?? taskScoring(task.task);
    const lines = fields([
      ["family", familyLabel(row.family)],
      ["date", row.date],
      ["status", row.status === "running" ? `${spinner(this.ctx.spin)} ${statusColour("running")}` : statusColour(row.status)],
      ["score", row.score === null || row.score === undefined ? paint("not scored", "grey") : scoreBar(row.score)],
      ["method", scoring?.method ?? "—"],
      ["aggregation", scoring?.aggregate ?? "—"],
      ["result", scoring?.summary ?? "—"],
      ["duration", duration(row.durationMs) || "—"],
      ...(row.deadlineMs ? [["deadline", `${duration(row.deadlineMs)} · ${row.forcedAt && row.startedAt ? `stop sent at ${duration(Date.parse(row.forcedAt) - Date.parse(row.startedAt))}` : "finished in time"}`] as [string, string]] : []),
      ["container", containerNote(row, true) ?? (row.exitCode === undefined || row.exitCode === null ? "—" : `exit ${row.exitCode}`)],
      ["KDI calls", String(task.kdiCalls.length)],
      ["directory", task.dir],
    ]);
    if (row.activity?.tool || row.activity?.header) {
      lines.push("", paint(" current activity", "bold"), ...fields([["tool", row.activity.tool ?? "—"], ["step", row.activity.header ?? "—"]]));
    }
    if (row.metrics && Object.keys(row.metrics).length > 0) {
      lines.push("", paint(" scoring metrics", "bold"), ...fields(Object.entries(row.metrics).map(([name, value]) => [metricLabel(name), metricValue(name, value)]), 22));
    }
    if (row.issues?.length) {
      lines.push("", paint(" scoring notes", "bold"), ...row.issues.map((issue) => `  ${paint("•", "yellow")} ${issue}`));
    }
    return lines;
  }

  private lines(): string[] {
    const sections = this.sections();
    return sections[Math.min(this.section, Math.max(0, sections.length - 1))]?.lines() ?? [];
  }

  onKey(key: Key): boolean {
    const sections = this.sections();
    if (key.name === "left" || key.name === "right") {
      if (sections.length > 0) this.section = (this.section + (key.name === "left" ? -1 : 1) + sections.length) % sections.length;
      return true;
    }
    if (this.doc().onKey(key, this.lines().length)) return true;
    if (key.name !== "char" || !key.ch) return false;
    if (/^[1-9]$/.test(key.ch)) {
      const index = Number(key.ch) - 1;
      if (index < sections.length) this.section = index;
      return true;
    }
    if (key.ch === "A") {
      abortSelectedTask(this.ctx, this.run.dir, this.row);
      return true;
    }
    if (key.ch === "T") {
      rerunSelectedTask(this.ctx, this.run, this.row, () => this.ctx.pop());
      return true;
    }
    if (key.ch === "X") {
      stopRun(this.ctx, this.run);
      return true;
    }
    return false;
  }

  body(columns: number, height: number): string[] {
    this.columns = columns;
    const sections = this.sections();
    if (sections.length === 0) return ["", ` ${spinner(this.ctx.spin)} reading…`];
    if (this.section >= sections.length) this.section = 0;
    const section = sections[this.section]!;
    const head = [tabs(sections, this.section, columns), "", ...(section.header?.() ?? [])];
    const doc = this.doc();
    doc.height = Math.max(1, height - head.length);
    return viewport(head, this.lines(), height, doc.scroll);
  }
}

/**
 * One sweep: one row per model. Re-read once a second. ⏎ opens the selected
 * model's run.
 */

import { duration, paint, percent, status as statusColour } from "../../format.ts";
import { loadSweep, type Sweep, type SweepRow } from "../../sweep.ts";
import { stopRun } from "../actions.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { spinner } from "../render.ts";
import type { Key } from "../screen.ts";
import { ListState } from "../state.ts";
import { tableLines, type Column } from "../widgets.ts";

const COLUMNS: Column[] = [
  { header: "model", flex: 3 },
  { header: "state", width: 11 },
  { header: "status", width: 14 },
  { header: "score", width: 6, align: "right" },
  { header: "KDI", width: 4, align: "right" },
  { header: "time", width: 7, align: "right" },
  { header: "answer", flex: 4 },
];

export class SweepPage implements Page {
  private readonly list = new ListState();
  private rows: SweepRow[] = [];
  private pageSize = 10;

  constructor(private readonly ctx: Ctx, private readonly sweep: Sweep) {}

  title(): string {
    return this.sweep.id;
  }

  right(): string {
    const done = this.rows.filter((row) => row.run?.state === "complete").length;
    return `${this.sweep.taskId} · ${done}/${this.sweep.runs.length} done`;
  }

  hints(): Hint[] {
    return [["↑↓", "model"], ["⏎", "open run"], ["X", "stop run"], ["s", "rescore"], ["esc", "back"]];
  }

  async activate(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    this.rows = await loadSweep(this.sweep);
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.list.onKey(key, this.rows.length, this.pageSize)) return true;
    const row = this.rows[this.list.cursor];
    if (key.name === "enter") {
      if (row?.run) await this.ctx.openRun(row.run, [this.sweep.taskId]);
      else if (row) this.ctx.say(`${row.model} has not started`, "info");
      return true;
    }
    if (key.name !== "char" || !row?.run) return false;
    if (key.ch === "X") {
      stopRun(this.ctx, row.run);
      return true;
    }
    if (key.ch === "s") {
      await this.ctx.score(row.run, false);
      return true;
    }
    return false;
  }

  body(columns: number, height: number): string[] {
    const rows = this.rows.map((row) => {
      const task = row.task;
      const running = row.run?.state === "running";
      return [
        row.model,
        row.run ? statusColour(row.run.state) : paint("queued", "grey"),
        task ? (task.status === "running" ? `${spinner(this.ctx.spin)} running` : task.status) : "",
        row.run && this.ctx.scoring(row.run.dir) ? spinner(this.ctx.spin) : task?.score === null || task?.score === undefined ? paint("—", "grey") : percent(task.score, 0),
        task?.kdiCalls === undefined ? "" : String(task.kdiCalls),
        running && task?.startedAt ? duration(Date.now() - Date.parse(task.startedAt)) : duration(task?.durationMs),
        row.answer === undefined ? paint(task?.activity?.tool ?? "", "grey") : JSON.stringify(row.answer),
      ];
    });
    const listHeight = Math.max(1, height - 1);
    this.pageSize = listHeight;
    const offset = this.list.window(rows.length, listHeight);
    return tableLines(COLUMNS, rows, { total: columns, selected: this.list.cursor, offset, height: listHeight });
  }
}

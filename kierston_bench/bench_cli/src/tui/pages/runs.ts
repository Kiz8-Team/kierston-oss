/** Home: every run and how far it got. ⏎ opens one; D deletes one. */

import { bar, paint, percent, since, status as statusColour } from "../../format.ts";
import type { RunSummary } from "../../inventory.ts";
import { PATHS } from "../../paths.ts";
import { deleteSelectedRun, resumeRun, stopRun } from "../actions.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { spinner } from "../render.ts";
import type { Key } from "../screen.ts";
import { Filter, ListState } from "../state.ts";
import { tableLines, type Column } from "../widgets.ts";

const COLUMNS: Column[] = [
  { header: "series", flex: 2 },
  { header: "run", flex: 3 },
  { header: "state", width: 11 },
  { header: "progress", width: 18 },
  { header: "answered", width: 8, align: "right" },
  { header: "issues", width: 6, align: "right" },
  { header: "score", width: 6, align: "right" },
  { header: "last", width: 12, align: "right" },
];

export class RunsPage implements Page {
  private readonly list = new ListState();
  private readonly filter = new Filter();
  private pageSize = 10;

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "Runs";
  }

  right(): string {
    const shown = this.visible.length;
    const all = this.ctx.runs.length;
    return `${shown === all ? all : `${shown} of ${all}`} run(s) · ${this.ctx.series.length} series`;
  }

  hints(): Hint[] {
    return [
      ["↑↓", "select"],
      ["⏎", "open"],
      ["←→", "tabs"],
      ["n", "new run"],
      ["s", "score"],
      ["X", "stop"],
      ["R", "resume"],
      ["D", "delete"],
      ["/", "filter"],
      ["?", "keys"],
      ["q", "quit"],
    ];
  }

  capturing(): boolean {
    return this.filter.typing;
  }

  private get visible(): RunSummary[] {
    return this.ctx.runs.filter((run) => this.filter.matches(`${run.name ?? ""} ${run.series}/${run.runId}`));
  }

  private get selected(): RunSummary | null {
    return this.visible[this.list.cursor] ?? null;
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.filter.onKey(key)) {
      this.list.reset();
      return true;
    }
    if (this.list.onKey(key, this.visible.length, this.pageSize)) return true;
    const run = this.selected;
    if (key.name === "enter") {
      if (run) await this.ctx.openRun(run);
      return true;
    }
    if (key.name !== "char") return false;
    switch (key.ch) {
      case "n":
        await this.ctx.newRun(run?.series);
        return true;
      case "s":
        if (run) await this.ctx.score(run, false);
        return true;
      case "X":
        if (run) stopRun(this.ctx, run);
        return true;
      case "R":
        if (run) resumeRun(this.ctx, run);
        return true;
      case "D":
        deleteSelectedRun(this.ctx, run);
        return true;
      default:
        return false;
    }
  }

  body(columns: number, height: number): string[] {
    if (this.ctx.runs.length === 0) {
      return ["", ` no runs under ${PATHS.runs}`];
    }
    const visible = this.visible;
    const head: string[] = [];
    if (this.filter.active) head.push(` ${this.filter.render()}   ${paint(`${visible.length} of ${this.ctx.runs.length}`, "grey")}`);
    if (visible.length === 0) return [...head, "", ` ${paint("no matching runs", "grey")}`];
    const rows = visible.map((run) => {
      const total = run.total ?? run.done;
      const issues = (run.counts["no-answer"] ?? 0) + (run.counts["invalid-answer"] ?? 0) + (run.counts.timeout ?? 0) + (run.counts.error ?? 0);
      return [
        run.series,
        run.name ?? run.runId,
        statusColour(run.state),
        `${bar(total === 0 ? 0 : run.done / total, 10)} ${run.done}/${total}`,
        String(run.counts.answered ?? 0),
        issues === 0 ? paint("0", "grey") : paint(String(issues), "yellow"),
        this.ctx.scoring(run.dir) ? spinner(this.ctx.spin) : run.score ? percent(run.score.meanScore, 0) : paint("—", "grey"),
        since(run.lastActivity),
      ];
    });
    const listHeight = Math.max(1, height - head.length - 1);
    this.pageSize = listHeight;
    const offset = this.list.window(rows.length, listHeight);
    return [...head, ...tableLines(COLUMNS, rows, { total: columns, selected: this.list.cursor, offset, height: listHeight })];
  }
}

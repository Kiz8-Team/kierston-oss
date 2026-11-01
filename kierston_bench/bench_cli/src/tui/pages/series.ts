/** The task sets a run can be made from. ⏎ starts a run of one; D deletes one. */

import { stamp } from "../../format.ts";
import { PATHS } from "../../paths.ts";
import { deleteSelectedSeries } from "../actions.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { ListState } from "../state.ts";
import { tableLines, type Column } from "../widgets.ts";

const COLUMNS: Column[] = [
  { header: "series", flex: 2 },
  { header: "tasks", width: 6, align: "right" },
  { header: "families", width: 8, align: "right" },
  { header: "days", flex: 3 },
  { header: "runs", width: 5, align: "right" },
  { header: "created", width: 16 },
];

export class SeriesPage implements Page {
  private readonly list = new ListState();
  private pageSize = 10;

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "Series";
  }

  right(): string {
    return `${this.ctx.series.length} series`;
  }

  hints(): Hint[] {
    return [["↑↓", "select"], ["⏎", "new run of it"], ["←→", "tabs"], ["n", "new series"], ["D", "delete"], ["?", "keys"], ["q", "quit"]];
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.list.onKey(key, this.ctx.series.length, this.pageSize)) return true;
    const series = this.ctx.series[this.list.cursor];
    if (key.name === "enter") {
      if (series) await this.ctx.newRun(series.id);
      return true;
    }
    if (key.name === "char" && key.ch === "n") {
      await this.ctx.newSeries();
      return true;
    }
    if (key.name === "char" && key.ch === "D") {
      deleteSelectedSeries(this.ctx, series);
      return true;
    }
    return false;
  }

  body(columns: number, height: number): string[] {
    if (this.ctx.series.length === 0) {
      return ["", ` no series under ${PATHS.runSeries}`];
    }
    const rows = this.ctx.series.map((series) => [
      series.id,
      String(series.taskCount),
      String(series.families.length),
      series.days.map((day) => day.date).join(", "),
      String(series.runs),
      stamp(series.createdAt),
    ]);
    const listHeight = Math.max(1, height - 1);
    this.pageSize = listHeight;
    const offset = this.list.window(rows.length, listHeight);
    return tableLines(COLUMNS, rows, { total: columns, selected: this.list.cursor, offset, height: listHeight });
  }
}

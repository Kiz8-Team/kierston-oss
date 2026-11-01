/** Sweep list under a New sweep button. ⏎ presses the button or opens the sweep; D deletes the record. */

import { fit, invert, paint, stamp } from "../../format.ts";
import { PATHS } from "../../paths.ts";
import { deleteSweepRecord, listSweeps, type Sweep } from "../../sweep.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { ListState } from "../state.ts";
import { scrollTo, tableLines, type Column } from "../widgets.ts";

const COLUMNS: Column[] = [
  { header: "sweep", flex: 2 },
  { header: "series", flex: 2 },
  { header: "task", flex: 3 },
  { header: "models", width: 6, align: "right" },
  { header: "done", width: 6, align: "right" },
  { header: "created", width: 16 },
];

export class SweepsPage implements Page {
  private readonly list = new ListState();
  private sweeps: Sweep[] = [];
  private pageSize = 10;
  private offset = 0;

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "Sweeps";
  }

  right(): string {
    return `${this.sweeps.length} sweep(s)`;
  }

  hints(): Hint[] {
    return [["↑↓", "select"], ["⏎", "press / open"], ["←→", "tabs"], ["D", "delete"], ["?", "keys"], ["q", "quit"]];
  }

  async activate(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    this.sweeps = await listSweeps();
  }

  /** Row 0 is the button; the sweeps follow. */
  private get sweep(): Sweep | undefined {
    return this.list.cursor === 0 ? undefined : this.sweeps[this.list.cursor - 1];
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.list.onKey(key, this.sweeps.length + 1, this.pageSize)) return true;
    const sweep = this.sweep;
    if (key.name === "enter") {
      if (this.list.cursor === 0) await this.ctx.newSweep();
      else if (sweep) await this.ctx.openSweep(sweep);
      return true;
    }
    if (key.name !== "char") return false;
    if (key.ch === "n") {
      await this.ctx.newSweep();
      return true;
    }
    if (key.ch === "D" && sweep) {
      this.ctx.confirm(`Delete sweep record ${sweep.id}? Its ${sweep.runs.length} run(s) are kept.`, async () => {
        await deleteSweepRecord(sweep);
        await this.tick();
        this.ctx.say(`Deleted sweep record ${sweep.id}`);
      });
      return true;
    }
    return false;
  }

  /** Finished runs of the sweep, from the Runs list in memory. */
  private done(sweep: Sweep): number {
    const ids = new Set(sweep.runs.map((run) => run.runId));
    return this.ctx.runs.filter((run) => run.series === sweep.series && ids.has(run.runId) && run.state === "complete").length;
  }

  body(columns: number, height: number): string[] {
    const button = fit(` ${paint("▶ New sweep", "bold")}`, columns);
    const head = [this.list.cursor === 0 ? invert(button) : button, ""];
    if (this.sweeps.length === 0) return [...head, ` ${paint(`no sweeps under ${PATHS.sweeps}`, "grey")}`];
    const rows = this.sweeps.map((sweep) => [
      sweep.id,
      sweep.series,
      sweep.taskId,
      String(sweep.runs.length),
      `${this.done(sweep)}/${sweep.runs.length}`,
      stamp(sweep.createdAt),
    ]);
    const listHeight = Math.max(1, height - head.length - 1);
    this.pageSize = listHeight;
    // The list cursor counts the button as row 0; the table sees only the sweeps.
    const selected = this.list.cursor - 1;
    this.offset = scrollTo(Math.max(0, selected), this.offset, listHeight, rows.length);
    return [...head, ...tableLines(COLUMNS, rows, { total: columns, selected, offset: this.offset, height: listHeight })];
  }
}

/**
 * A checklist or a single choice, as a page of its own: ↑↓ move, space or ⏎
 * toggle (or pick), esc is done. Multi-select mutates the caller's set in
 * place, so leaving the page by any route keeps what was ticked.
 */

import { paint } from "../../format.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { ListState } from "../state.ts";
import { tableLines, type Column } from "../widgets.ts";

export interface PickItem {
  value: string;
  label: string;
  detail?: string;
}

type Mode =
  | { multi: true; selected: Set<string> }
  | { multi: false; current?: string; onPick: (value: string) => Promise<void> | void };

export class PickPage implements Page {
  private readonly list = new ListState();
  private pageSize = 10;

  constructor(
    private readonly ctx: Ctx,
    private readonly name: string,
    private readonly items: readonly PickItem[],
    private readonly headers: [string, string],
    private readonly mode: Mode,
  ) {
    if (!mode.multi && mode.current) {
      const index = items.findIndex((item) => item.value === mode.current);
      if (index !== -1) this.list.cursor = index;
    }
  }

  title(): string {
    return this.name;
  }

  right(): string {
    return this.mode.multi ? `${this.mode.selected.size} of ${this.items.length} selected` : `${this.items.length} choice(s)`;
  }

  hints(): Hint[] {
    return this.mode.multi
      ? [["↑↓", "move"], ["space/⏎", "toggle"], ["a", "all"], ["x", "none"], ["esc", "done"]]
      : [["↑↓", "move"], ["⏎", "choose"], ["esc", "cancel"]];
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.list.onKey(key, this.items.length, this.pageSize)) return true;
    const item = this.items[this.list.cursor];
    if (this.mode.multi) {
      if (key.name === "enter" || (key.name === "char" && key.ch === " ")) {
        if (item) {
          if (this.mode.selected.has(item.value)) this.mode.selected.delete(item.value);
          else this.mode.selected.add(item.value);
        }
        return true;
      }
      if (key.name === "char" && key.ch === "a") {
        for (const entry of this.items) this.mode.selected.add(entry.value);
        return true;
      }
      if (key.name === "char" && key.ch === "x") {
        this.mode.selected.clear();
        return true;
      }
      return false;
    }
    if (key.name === "enter" && item) {
      await this.mode.onPick(item.value);
      await this.ctx.pop();
      return true;
    }
    return false;
  }

  body(columns: number, height: number): string[] {
    const mode = this.mode;
    const spec: Column[] = [
      { header: mode.multi ? "use" : "", width: 3 },
      { header: this.headers[0], flex: 2 },
      { header: this.headers[1], flex: 3 },
    ];
    const rows = this.items.map((item) => [
      mode.multi
        ? mode.selected.has(item.value) ? paint("✓", "green") : paint("·", "grey")
        : item.value === mode.current ? paint("●", "cyan") : " ",
      item.label,
      paint(item.detail ?? "", "grey"),
    ]);
    const listHeight = Math.max(1, height - 1);
    this.pageSize = listHeight;
    const offset = this.list.window(rows.length, listHeight);
    return tableLines(spec, rows, { total: columns, selected: this.list.cursor, offset, height: listHeight });
  }
}

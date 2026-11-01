/**
 * Which tasks a run is made of: one row per family, with how many of its
 * existing tasks to include. ←→ change the count on one row; a typed number
 * sets every family at once, which is the usual way to ask for N of each.
 */

import { paint } from "../../format.ts";
import { familyLabel, selectionSummary, setAllCopies, type FamilyChoice } from "../../task-selection.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { ListState } from "../state.ts";
import { tableLines, type Column } from "../widgets.ts";

const COLUMNS: Column[] = [
  { header: "run", width: 3 },
  { header: "group", width: 5 },
  { header: "task family", flex: 1 },
  { header: "copies", width: 6, align: "right" },
  { header: "of", width: 4, align: "right" },
];

export class FamiliesPage implements Page {
  private readonly list = new ListState();
  private pageSize = 10;
  /** Digits being typed for "this many of every family", or null. */
  private forAll: string | null = null;

  constructor(private readonly ctx: Ctx, private readonly choices: FamilyChoice[]) {}

  title(): string {
    return "Tasks";
  }

  right(): string {
    return selectionSummary(this.choices);
  }

  hints(): Hint[] {
    if (this.forAll !== null) return [["0-9", "type a count"], ["⏎", "apply to every family"], ["esc", "cancel"]];
    return [["↑↓", "family"], ["←→", "copies"], ["space", "on/off"], ["0-9", "N of each"], ["a", "all"], ["x", "none"], ["esc", "done"]];
  }

  capturing(): boolean {
    return this.forAll !== null;
  }

  onKey(key: Key): boolean {
    if (this.forAll !== null) {
      if (key.name === "escape") this.forAll = null;
      else if (key.name === "enter") {
        const count = Number(this.forAll);
        this.forAll = null;
        if (Number.isFinite(count)) this.applyToAll(count);
      } else if (key.name === "backspace") this.forAll = this.forAll.slice(0, -1);
      else if (key.name === "char" && key.ch && /^[0-9]$/.test(key.ch)) this.forAll += key.ch;
      return true;
    }
    if (this.list.onKey(key, this.choices.length, this.pageSize)) return true;
    const choice = this.choices[this.list.cursor];
    if (key.name === "left" || key.name === "right") {
      if (choice) choice.copies = Math.max(0, Math.min(choice.taskIds.length, choice.copies + (key.name === "left" ? -1 : 1)));
      return true;
    }
    if (key.name === "enter" || (key.name === "char" && key.ch === " ")) {
      if (choice) choice.copies = choice.copies === 0 ? choice.taskIds.length : 0;
      return true;
    }
    if (key.name !== "char" || !key.ch) return false;
    if (/^[0-9]$/.test(key.ch)) {
      this.forAll = key.ch;
      return true;
    }
    if (key.ch === "a") {
      for (const entry of this.choices) entry.copies = entry.taskIds.length;
      return true;
    }
    if (key.ch === "x") {
      for (const entry of this.choices) entry.copies = 0;
      return true;
    }
    if (key.ch === "+" || key.ch === "=") {
      if (choice) choice.copies = Math.min(choice.taskIds.length, choice.copies + 1);
      return true;
    }
    if (key.ch === "-") {
      if (choice) choice.copies = Math.max(0, choice.copies - 1);
      return true;
    }
    return false;
  }

  private applyToAll(count: number): void {
    const { short } = setAllCopies(this.choices, count);
    const tail = short === 0 ? "" : `; ${short} famil${short === 1 ? "y has" : "ies have"} fewer tasks and use all of them`;
    this.ctx.say(`every family set to ${count} cop${count === 1 ? "y" : "ies"}${tail}`);
  }

  body(columns: number, height: number): string[] {
    const head = this.forAll === null
      ? ""
      : ` copies of every family: ${this.forAll}${paint("▌", "cyan")}`;
    const rows = this.choices.map((choice) => [
      choice.copies > 0 ? paint("✓", "green") : paint("·", "grey"),
      paint(choice.group, "grey"),
      familyLabel(choice.family),
      choice.copies > 0 ? String(choice.copies) : paint("off", "grey"),
      String(choice.taskIds.length),
    ]);
    const listHeight = Math.max(1, height - 2);
    this.pageSize = listHeight;
    const offset = this.list.window(rows.length, listHeight);
    return [head, ...tableLines(COLUMNS, rows, { total: columns, selected: this.list.cursor, offset, height: listHeight })];
  }
}

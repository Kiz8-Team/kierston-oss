/**
 * A form is a list: ↑↓ pick a row, ⏎ acts on it. A text row edits in place,
 * a toggle flips, a chooser opens a page, and a button does the thing. The
 * buttons sit at the bottom of the same list, so nothing on a form needs a
 * letter to reach.
 */

import { fit, invert, paint, width } from "../format.ts";
import type { Key } from "./screen.ts";
import { Editor, ListState } from "./state.ts";

export interface FormRow {
  label: string;
  kind: "text" | "number" | "list" | "toggle" | "choose" | "button";
  /** The value as shown, and what an edit starts from; unused for buttons. */
  value?: () => string;
  /** Grey text after the value, never part of an edit. */
  detail?: () => string;
  /** Text, number and list rows: take what was typed. */
  set?: (text: string) => void;
  toggle?: () => void;
  /** Chooser and button rows. */
  act?: () => Promise<void> | void;
  /** Called after a text edit is kept. */
  changed?: () => void;
}

export class Form {
  readonly list = new ListState();
  private editor: Editor | null = null;
  /** Index of the row being edited; rows are rebuilt on every draw, so identity would not do. */
  private editing = -1;
  private pageSize = 8;

  constructor(private readonly rows: () => FormRow[]) {}

  capturing(): boolean {
    return this.editor !== null;
  }

  get selected(): FormRow | null {
    return this.rows()[this.list.cursor] ?? null;
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.editor) {
      const outcome = this.editor.onKey(key);
      if (outcome === "done") {
        const row = this.rows()[this.editing];
        row?.set?.(this.editor.text);
        this.editor = null;
        this.editing = -1;
        row?.changed?.();
      } else if (outcome === "cancel") {
        this.editor = null;
        this.editing = -1;
      }
      return true;
    }
    const rows = this.rows();
    if (this.list.onKey(key, rows.length, this.pageSize)) return true;
    const row = rows[this.list.cursor];
    if (!row) return false;
    if (key.name === "enter" || (key.name === "char" && key.ch === " " && row.kind === "toggle")) {
      switch (row.kind) {
        case "toggle":
          row.toggle?.();
          return true;
        case "choose":
        case "button":
          await row.act?.();
          return true;
        default:
          this.editing = this.list.cursor;
          this.editor = new Editor(row.value?.() ?? "");
          return true;
      }
    }
    return false;
  }

  /**
   * The rows, one line each: label, then value. The selected row is drawn
   * inverted, the way a list's cursor is everywhere else, and scrolled into
   * view when the form is taller than the pane.
   */
  lines(columns: number, height: number, labelWidth = 14): string[] {
    const rows = this.rows();
    // The label column is as wide as its widest button, so no button is clipped.
    labelWidth = Math.max(labelWidth, ...rows.map((row) => (row.kind === "button" ? width(row.label) + 2 : width(row.label))));
    const drawn = rows.map((row, index) => {
      const selected = index === this.list.cursor;
      const editing = index === this.editing && this.editor !== null;
      let line: string;
      if (row.kind === "button") {
        line = ` ${paint(`▶ ${row.label}`, "bold")}`;
      } else {
        const value = editing ? this.editor!.render() : (row.value?.() ?? "") || paint("(unset)", "grey");
        const arrow = row.kind === "choose" ? paint(" ›", "grey") : "";
        const detail = editing ? "" : row.detail?.() ?? "";
        line = ` ${fit(paint(row.label, "bold"), labelWidth)}  ${value}${detail ? `  ${paint(detail, "grey")}` : ""}${arrow}`;
      }
      return selected ? invert(fit(line, columns)) : fit(line, columns);
    });
    this.pageSize = Math.max(1, height - 1);
    const offset = this.list.window(drawn.length, height);
    return drawn.slice(offset, offset + height);
  }
}

export function parseList(text: string): string[] {
  return text.trim() === "" ? [] : text.split(",").map((part) => part.trim()).filter(Boolean);
}

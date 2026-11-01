/**
 * The pieces every screen is drawn from: a title bar, a key bar, a table
 * whose selected row inverts, and a viewport that scrolls a long list to keep
 * the cursor in sight.
 */

import { fit, invert, paint, width } from "../format.ts";
import type { Align } from "../../../scoring/src/report.ts";

export interface Column {
  header: string;
  width?: number;
  align?: Align;
  /** Share of the leftover width this column takes when it has no fixed width. */
  flex?: number;
}

export function titleBar(title: string, right: string, columns: number): string {
  const left = ` ${title}`;
  const gap = Math.max(1, columns - width(left) - width(right) - 1);
  return paint(fit(left + " ".repeat(gap) + right + " ", columns), "bold");
}

export function keyBar(hints: readonly [string, string][], columns: number): string {
  const text = hints.map(([key, label]) => `${paint(key, "bold")} ${paint(label, "grey")}`).join("  ");
  return fit(" " + text, columns);
}

export function message(text: string, kind: "info" | "error" | "busy", columns: number): string {
  const colour = kind === "error" ? "red" : kind === "busy" ? "yellow" : "cyan";
  return fit(" " + paint(text, colour), columns);
}

/** Column widths: fixed ones as asked, the rest sharing what is left. */
function layout(columns: readonly Column[], total: number): number[] {
  const gaps = (columns.length - 1) * 2 + 2;
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const flexTotal = columns.reduce((sum, column) => sum + (column.width ? 0 : (column.flex ?? 1)), 0);
  const spare = Math.max(0, total - fixed - gaps);
  return columns.map((column) =>
    column.width ?? Math.max(4, Math.floor((spare * (column.flex ?? 1)) / Math.max(1, flexTotal))),
  );
}

export function tableLines(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: { total: number; selected?: number; offset?: number; height: number },
): string[] {
  const widths = layout(columns, options.total);
  const cell = (text: string, index: number) => {
    const value = text ?? "";
    const size = widths[index]!;
    if ((columns[index]?.align ?? "left") === "right") {
      const printable = width(value);
      return printable >= size ? fit(value, size) : " ".repeat(size - printable) + value;
    }
    return fit(value, size);
  };
  const line = (cells: readonly string[]) => " " + cells.map(cell).join("  ");

  const header = paint(line(columns.map((column) => column.header)), "grey");
  const offset = options.offset ?? 0;
  const visible = rows.slice(offset, offset + options.height);
  const body = visible.map((row, index) => {
    const text = line(row);
    return offset + index === options.selected ? invert(fit(text, options.total)) : text;
  });
  return [header, ...body];
}

/** Keep the selected row inside a window `height` tall. */
export function scrollTo(selected: number, offset: number, height: number, count: number): number {
  if (count <= height) return 0;
  let next = offset;
  if (selected < offset) next = selected;
  if (selected >= offset + height) next = selected - height + 1;
  return Math.max(0, Math.min(next, count - height));
}

/** Wrap a paragraph to the width, keeping existing line breaks. */
export function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= columns) {
      lines.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= columns) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

/** `label  value`, aligned down a detail pane. */
export function fields(entries: readonly (readonly [string, string])[], labelWidth = 16): string[] {
  return entries.map(([label, value]) => ` ${paint(fit(label, labelWidth), "grey")}${value}`);
}

/** A softly shaded, full-width block for prose that would otherwise disappear into the terminal. */
export function prosePanel(title: string, text: string, columns: number): string[] {
  const contentWidth = Math.max(8, columns - 4);
  return [
    paint(fit(` ${title}`, columns), "panel", "bold"),
    ...wrap(text || "(none)", contentWidth).map((line) => paint(fit(`  ${line}`, columns), "panel")),
  ];
}

/** A row of section names, the active one lit. Sections are switched with ←→ or 1-9. */
export function tabs(items: readonly { label: string; count?: number }[], active: number, columns: number): string {
  const text = items
    .map((item, index) => {
      const label = item.count === undefined ? item.label : `${item.label} ${item.count}`;
      // Brackets make selection visible even with NO_COLOR or TERM=dumb;
      // colour is reinforcement, never the only navigation feedback.
      return index === active ? paint(`[ ${label} ]`, "cyan", "bold") : paint(`  ${label}  `, "grey");
    })
    .join(paint("·", "grey"));
  return fit(" " + text, columns);
}

/** Keep a scroll offset inside a document, so `end` never parks past the last screen. */
export function clampScroll(scroll: number, lines: number, height: number): number {
  return Math.max(0, Math.min(scroll, Math.max(0, lines - height)));
}

/**
 * A pinned header above a scrolling body. The header never moves, which is what
 * lets a column header stay readable however far down the list you are.
 */
export function viewport(header: readonly string[], body: readonly string[], height: number, scroll: number): string[] {
  const room = Math.max(1, height - header.length);
  const start = clampScroll(scroll, body.length, room);
  return [...header, ...body.slice(start, start + room)];
}

/** `12–40 of 96`, for the corner of a title bar. */
export function position(scroll: number, shown: number, total: number): string {
  if (total <= shown) return `${total} line(s) `;
  const start = clampScroll(scroll, total, shown);
  return `${start + 1}–${Math.min(total, start + shown)} of ${total} `;
}

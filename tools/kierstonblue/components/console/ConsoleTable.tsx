"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { VirtualTable, selectableRow } from "@/components/VirtualTable";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The console's table: a virtualised grid over an index array.
 *
 * The behaviour is the browsers' — a click or Enter opens the record, arrows
 * walk the rows, one tab stop for the whole table. What it looks like is a
 * site's table: a plain head in sentence case over a hairline, a hairline
 * under every row, a grey wash under the pointer, and the selected
 * row carrying a black bar at its left edge, where the eye returns after
 * reading the record beside it.
 */

const HEAD = "sticky top-0 z-[1] h-7 border-0 bg-background "
  + "py-0 pr-2 pl-2 text-[0.76rem] font-medium text-foreground normal-case tracking-normal "
  + " data-[sorted=true]:text-foreground";

/** Cells are exactly `--row-h` tall whatever they contain: the virtualiser
 *  positions rows by arithmetic, and a tall cell would desync the spacers. */
const CELL = "h-[var(--row-h)] py-0 pr-2 pl-2 truncate";

const NUMERIC = "text-right tabular-nums";

/**
 * Zebra striping keyed off the row's position rather than :nth-child — the
 * virtualiser's spacer rows are real `<tr>`s, so nth-child would flip the
 * banding every time the window scrolled.
 */
const ROW = "cursor-pointer border-b border-border transition-none "
  + "hover:bg-[var(--accent)] "
  + "data-[selected=true]:bg-[var(--accent)] data-[selected=true]:font-medium "
  + "data-[selected=true]:shadow-[inset_2px_0_0_var(--primary)] "
  + "focus-visible:bg-[var(--accent)] focus-visible:outline-1 focus-visible:outline-ring "
  + "focus-visible:-outline-offset-1";

export type ConsoleColumn = {
  id: string;
  header: string;
  width?: string;
  align?: "left" | "right";
  sortable?: boolean;
  /** Shown on hover over the header, for a column whose name is a shorthand. */
  hint?: string;
  cell: (index: number) => React.ReactNode;
};

export type ConsoleTableProps = {
  indices: Int32Array;
  columns: ConsoleColumn[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  sort?: { id: string; dir: 1 | -1 } | null;
  onSort?: (id: string) => void;
  empty?: React.ReactNode;
  height?: string;
};

export function ConsoleTable({
  indices,
  columns,
  selected,
  onSelect,
  sort,
  onSort,
  empty,
  height,
}: ConsoleTableProps) {
  // Fixed-layout tables only overflow when they have an explicit floor. Add up
  // declared widths and give free-text columns enough room to remain useful.
  const tableMinWidth = columns.reduce((width, column) => {
    if (!column.width) return width + 176;
    const value = Number.parseFloat(column.width);
    return width + (column.width.endsWith("rem") ? value * 16 : value);
  }, 0);
  // Where the keyboard is in the table, as a position in `indices`. Null until
  // a key is pressed, so nothing is focused or scrolled on first paint.
  const [cursor, setCursor] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // A new filter or sort makes the old position meaningless — it now points at
  // a different row, or at nothing.
  useEffect(() => { setCursor(null); }, [indices]);

  const positionOf = (index: number | null) => {
    if (index === null) return -1;
    for (let position = 0; position < indices.length; position += 1) {
      if (indices[position] === index) return position;
    }
    return -1;
  };

  const move = (from: number, delta: number | "first" | "last") => {
    if (!indices.length) return;
    const next = delta === "first"
      ? 0
      : delta === "last"
        ? indices.length - 1
        : Math.min(indices.length - 1, Math.max(0, from + delta));
    setCursor(next);
    // Arrowing moves the record beside it too: the row is what the record is
    // for, and a cursor that moved without it would just be a focus ring.
    onSelect(indices[next]);
  };

  return (
    <VirtualTable
      indices={indices}
      height={height}
      focusPosition={cursor}
      shellClassName="h-full overflow-auto overscroll-contain"
      tableStyle={{ minWidth: `${Math.max(720, tableMinWidth)}px` }}
      bodyClassName=""
      header={
        <tr>
          {columns.map((column) => {
            const numeric = column.align === "right";
            const sorted = sort?.id === column.id;
            const ariaSort = sorted
              ? sort.dir === 1 ? "ascending" : "descending"
              : "none";
            const Glyph = sorted ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ChevronsUpDown;
            return (
              <TableHead
                key={column.id}
                style={column.width ? { width: column.width } : undefined}
                className={cn(HEAD, numeric && NUMERIC)}
                data-sorted={sorted}
                aria-sort={column.sortable ? ariaSort : undefined}
              >
                {column.sortable && onSort ? (
                  <button
                    type="button"
                    className={cn(
                      "group/sort inline-flex cursor-pointer items-center gap-1",
                      "border-0 bg-transparent p-0 text-inherit",
                      "[font:inherit] [letter-spacing:inherit] [text-transform:inherit]",
                      "hover:text-foreground",
                      numeric && "flex-row-reverse",
                    )}
                    onClick={() => onSort(column.id)}
                    aria-label={`Sort by ${column.header}`}
                  >
                    {column.header}
                    {/* The unsorted glyph is always there, at low contrast:
                        without it there is no sign that a header can be
                        clicked until someone clicks one. */}
                    <Glyph
                      className={cn(
                        "size-[0.66rem] shrink-0 text-foreground",
                        !sorted && "text-muted-foreground opacity-40 group-hover/sort:opacity-90",
                      )}
                      aria-hidden
                    />
                  </button>
                ) : (
                  column.header
                )}
              </TableHead>
            );
          })}
        </tr>
      }
      empty={empty}
      renderRow={(index, position) => (
        <TableRow
          key={index}
          className={ROW}
          data-stripe={position % 2 === 1}
          {...selectableRow(
            selected === index,
            () => onSelect(selected === index ? null : index),
            {
              position,
              tabStop: cursor === null
                ? selected === null ? position === 0 : selected === index
                : cursor === position,
              onMove: (delta) => {
                const from = cursor ?? positionOf(selectedRef.current);
                move(from < 0 ? position : from, delta);
              },
            },
          )}
        >
          {columns.map((column) => (
            <TableCell
              key={column.id}
              className={cn(CELL, column.align === "right" && NUMERIC)}
            >
              {column.cell(index)}
            </TableCell>
          ))}
        </TableRow>
      )}
    />
  );
}

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Table, TableBody, TableHeader } from "@/components/ui/table";

/**
 * A table over an index array, rendering only the rows on screen.
 *
 * The population is 38,000 households and 90,000 people; a browser asked to
 * lay out that many rows stops responding. Rows are a fixed height, so the
 * window is arithmetic — scrollTop divided by row height — and two spacer rows
 * hold the scrollbar at the right length.
 */
export function VirtualTable({
  indices, rowHeight = 28, overscan = 8, header, renderRow, height = "100%", empty,
  focusPosition = null, shellClassName = SHELL, bodyClassName = BODY, tableStyle,
}: {
  indices: Int32Array;
  rowHeight?: number;
  overscan?: number;
  header: React.ReactNode;
  renderRow: (index: number, position: number) => React.ReactNode;
  height?: string;
  /** The scroll box's own appearance, for a caller that frames the table
   *  itself — the console panels draw the border and the rounding. */
  shellClassName?: string;
  bodyClassName?: string;
  tableStyle?: React.CSSProperties;
  /** Shown in place of the table body when the filter matches nothing. */
  empty?: React.ReactNode;
  /**
   * A row position to scroll to and focus — how arrow-key navigation reaches
   * rows that are not in the DOM yet. Positions index into `indices`, not into
   * the dataset.
   */
  focusPosition?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });

  const measure = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const visible = Math.ceil(node.clientHeight / rowHeight);
    const start = Math.max(0, Math.floor(node.scrollTop / rowHeight) - overscan);
    const end = start + visible + overscan * 2;
    // Bail when nothing moved: this runs on every scroll event and on resize,
    // and an unconditional setState would re-render the window each time.
    setRange((current) => (current.start === start && current.end === end
      ? current
      : { start, end }));
  }, [rowHeight, overscan]);

  useEffect(() => {
    measure();
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  /**
   * Bring the target row into view before anything tries to focus it.
   *
   * The sticky header floats over the top of the scroll box, so a row scrolled
   * flush to the top would sit underneath it; its height is the offset every
   * calculation here has to allow for.
   */
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (node === null || focusPosition === null) return;
    const headerHeight = headRef.current?.offsetHeight ?? 0;
    const top = focusPosition * rowHeight;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + node.clientHeight - headerHeight;
    if (top < viewTop) node.scrollTop = top;
    else if (top + rowHeight > viewBottom) {
      node.scrollTop = top + rowHeight - node.clientHeight + headerHeight;
    }
    measure();
  }, [focusPosition, rowHeight, measure]);

  // Focus lands in a second pass: the row may only have entered the DOM as a
  // result of the scroll above.
  useEffect(() => {
    if (focusPosition === null) return;
    const row = viewportRef.current?.querySelector<HTMLElement>(
      `[data-position="${focusPosition}"]`,
    );
    if (row && row !== document.activeElement) row.focus({ preventScroll: true });
  }, [focusPosition, range]);

  const end = Math.min(indices.length, range.end);
  const start = Math.min(range.start, Math.max(0, indices.length - 1));
  const above = start * rowHeight;
  const below = Math.max(0, (indices.length - end) * rowHeight);

  const rows: React.ReactNode[] = [];
  for (let position = start; position < end; position += 1) {
    rows.push(renderRow(indices[position], position));
  }

  // `--row-h` is what the cells size themselves against, so the height the
  // virtualiser does its arithmetic with and the height the browser lays out
  // cannot drift apart when a caller passes a different `rowHeight`.
  const shellStyle = { height, "--row-h": `${rowHeight}px` } as React.CSSProperties;

  if (empty && indices.length === 0) {
    return (
      <div className={shellClassName} style={shellStyle}>
        <Table className={TABLE} style={tableStyle}>
          <TableHeader ref={headRef}>{header}</TableHeader>
        </Table>
        {empty}
      </div>
    );
  }

  return (
    <Table
      className={TABLE}
      style={tableStyle}
      containerClassName={shellClassName}
      containerRef={viewportRef}
      containerProps={{ style: shellStyle, onScroll: measure }}
      // Only the visible window is in the DOM, so the real length has to be
      // declared: without it a screen reader reports the thirty rows it can
      // see as the whole result.
      aria-rowcount={indices.length}
    >
      <TableHeader ref={headRef}>{header}</TableHeader>
      <TableBody className={bodyClassName}>
        {above ? <tr style={{ height: above }} aria-hidden /> : null}
        {rows}
        {below ? <tr style={{ height: below }} aria-hidden /> : null}
      </TableBody>
    </Table>
  );
}

/**
 * The scroll box. `overscroll-contain` keeps a flick at the end of the rows
 * from scrolling the page behind it, which at 90,000 rows happens often.
 */
const SHELL = "h-full overflow-auto overscroll-contain rounded-[var(--radius)] "
  + "border border-border bg-card shadow-[var(--shadow-card)]";

/** The rule belongs between rows rather than under each one, so the last row
 *  meets the bottom of the scroll box without a stray line. */
const BODY = "[&_tr+tr]:border-t [&_tr+tr]:border-muted";

/** Fixed layout: column widths come from the header, not from the cell text. */
const TABLE = "table-fixed border-collapse text-[0.8rem]";

/**
 * Props that turn a rendered row into a control.
 *
 * A row is how every browser here opens a record, and a click handler on a
 * <tr> is reachable by pointer only. This adds the keyboard path — Tab to the
 * row, Enter or Space to open it, arrows to walk the table — and states the
 * selection for screen readers, in one place rather than six.
 *
 * Only one row is in the tab order at a time. Twenty visible rows each taking
 * a tab stop makes Tab useless for getting past the table, which is what the
 * roving index avoids: Tab reaches the table, arrows move inside it.
 */
export function selectableRow(
  selected: boolean,
  onSelect: () => void,
  options: {
    position?: number;
    /** Arrow keys ask the caller to move; it decides what the next row is. */
    onMove?: (delta: number | "first" | "last") => void;
    /** Whether this is the row that holds the table's single tab stop. */
    tabStop?: boolean;
  } = {},
) {
  const { position, onMove, tabStop = selected } = options;
  return {
    "data-clickable": "true" as const,
    "data-selected": selected,
    "data-position": position,
    "aria-selected": selected,
    tabIndex: tabStop ? 0 : -1,
    onClick: onSelect,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
        return;
      }
      if (!onMove) return;
      const moves: Record<string, number | "first" | "last"> = {
        ArrowDown: 1,
        ArrowUp: -1,
        PageDown: 10,
        PageUp: -10,
        Home: "first",
        End: "last",
      };
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      onMove(move);
    },
  };
}

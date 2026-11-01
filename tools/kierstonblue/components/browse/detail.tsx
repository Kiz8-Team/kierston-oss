import { X } from "lucide-react";

import { title } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The drawer beside a table, and the furniture inside it.
 *
 * Every table page opens its selected row the same way: a lead naming the
 * thing — as a chip when it is somewhere you can go — then sections of facts
 * laid out as a grid of labelled cells. The drawer has no head bar; the only
 * control on it is the close mark in its corner, and every way out of it is a
 * chip in the content.
 */

/** The table beside a drawer: one drawer width on every page. */
export const DRAWER_GRID = "grid-cols-[minmax(0,1fr)_24rem] "
  + "max-[62rem]:grid-cols-1 max-[62rem]:grid-rows-[minmax(8rem,1fr)_minmax(0,45%)]";

/** The same, for a drawer holding a graph that needs the room. */
export const DRAWER_GRID_WIDE = "grid-cols-[minmax(0,1fr)_34rem] "
  + "max-[62rem]:grid-cols-1 max-[62rem]:grid-rows-[minmax(8rem,1fr)_minmax(0,45%)]";

export function Drawer({
  onClose,
  children,
}: {
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <aside
      aria-label="Selected record"
      className="relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card"
    >
      {onClose ? (
        <button
          type="button"
          className="absolute top-2.5 right-2.5 z-10 grid size-6 cursor-pointer place-items-center
            bg-transparent text-muted-foreground transition-colors hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6 text-[0.8rem]">
        {children}
      </div>
    </aside>
  );
}

/* A fact cell: the label over the value. The value's first letter is raised
   by the stylesheet, so an enum straight out of a record file — "female",
   "bachelor's" — reads as a value rather than as a code. A cell holding a
   place chip spans the whole row: an address cut to half the drawer is an
   address you cannot read. */
const CELLS = cn(
  "grid gap-x-4 gap-y-2.5",
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-0.5",
  "[&>div:has([data-chip=place])]:col-span-full [&>div:has([data-chip=building])]:col-span-full",
  "[&>div>span:first-child]:text-[0.62rem] [&>div>span:first-child]:leading-tight",
  "[&>div>span:first-child]:font-medium [&>div>span:first-child]:tracking-[0.05em]",
  "[&>div>span:first-child]:text-muted-foreground [&>div>span:first-child]:uppercase",
  "[&>div>span:last-child]:block [&>div>span:last-child]:text-[0.8rem]",
  "[&>div>span:last-child]:leading-snug [&>div>span:last-child]:tabular-nums",
  "[&>div>span:last-child]:[overflow-wrap:anywhere]",
  "[&>div>span:last-child]:first-letter:uppercase",
);

/**
 * Labelled facts, as a grid of cells.
 *
 * Children stay plain `<div><span>label</span><span>value</span></div>`; `Fact`
 * writes that shape for you. Two cells to a row by default, three for a run of
 * short values.
 */
export function Facts({
  children,
  cols = 2,
  wide = false,
  className,
}: {
  children: React.ReactNode;
  cols?: 2 | 3;
  /** The full-page variant: as many columns as fit. */
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      data-slot="facts"
      className={cn(
        CELLS,
        wide
          ? "max-w-[58rem] grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]"
          : cols === 3 ? "grid-cols-3" : "grid-cols-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One label/value pair. `wide` runs it across the whole row. */
export function Fact({
  label,
  wide = false,
  children,
}: {
  label: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "col-span-full" : undefined}>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** A section title: small caps in the text colour. */
export function DetailHeading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "mt-6 mb-2.5 flex items-center gap-2 first:mt-0",
        "text-[0.66rem] leading-tight font-semibold tracking-[0.05em] text-foreground uppercase",
        "[&_small]:font-normal [&_small]:tracking-normal [&_small]:normal-case",
        className,
      )}
    >
      {children}
    </h3>
  );
}

/**
 * What is open: its name — a chip when it is somewhere to go — and at most
 * one line under it. Clear of the close mark on the right.
 */
export function DetailLead({
  children,
  sub,
  className,
}: {
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 pr-8", className)}>
      <div className="text-[0.95rem] leading-snug font-semibold text-pretty [&_[data-chip]>span:nth-child(2)]:text-[0.85rem]">
        {children}
      </div>
      {sub ? (
        <div className="mt-1 text-[0.78rem] text-muted-foreground first-letter:uppercase">{sub}</div>
      ) : null}
    </div>
  );
}

/** Links and buttons under a section. */
export function DetailActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 flex flex-wrap gap-1.5">{children}</div>;
}

/**
 * One entry in a list of them — a household's residents, a site's staff: its
 * chip, then its own facts as a three-cell grid.
 */
export function Member({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-1.5 border-t border-border py-2.5 first:border-t-0 first:pt-0",
        "[&>b]:font-semibold",
        "[&>span]:block [&>span]:text-[0.76rem] [&>span]:text-muted-foreground",
        "[&>span]:first-letter:uppercase",
        className,
      )}
      data-slot="member"
    >
      {children}
    </div>
  );
}

/** A list of `Member`s, so the first one needs no rule over it. */
export function Members({ children }: { children: React.ReactNode }) {
  return <div className="grid">{children}</div>;
}

/**
 * Who a person is, as cells rather than a line of dots: nobody has to guess
 * that the bare number beside a name is an age.
 */
export function PersonFacts({
  age,
  sex,
  relationship,
  race,
  education,
  work,
  income,
}: {
  age?: number;
  sex?: string;
  relationship?: string;
  race?: string;
  education?: string;
  work?: string | null;
  income?: React.ReactNode;
}) {
  return (
    <Facts cols={3}>
      {age !== undefined ? <Fact label="Age">{age}</Fact> : null}
      {sex ? <Fact label="Sex">{title(sex)}</Fact> : null}
      {relationship ? <Fact label="Relation">{title(relationship)}</Fact> : null}
      {race ? <Fact label="Race">{race}</Fact> : null}
      {education ? <Fact label="Education">{title(education)}</Fact> : null}
      {work ? <Fact label="Work">{title(work)}</Fact> : null}
      {income ? <Fact label="Income">{income}</Fact> : null}
    </Facts>
  );
}

/**
 * Names with a count or code beside each, two to a row: what a site's staff
 * do, which industries a building houses.
 */
export function Tally({ items }: {
  items: { key?: React.Key; label: React.ReactNode; value: React.ReactNode }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
      {items.map((item, position) => (
        <div
          key={item.key ?? position}
          className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border/60 py-0.5"
        >
          <span className="truncate first-letter:uppercase">{item.label}</span>
          <span className="shrink-0 text-[0.76rem] text-muted-foreground tabular-nums">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

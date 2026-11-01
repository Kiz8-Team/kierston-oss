"use client";

import { cn } from "@/lib/utils";
import { Micro } from "@/components/console/Panel";

/**
 * The record beside the table: what one selected row holds that the row itself
 * could not show.
 *
 * A record is a stack of labelled facts, and what makes a stack of facts
 * readable is the label column never moving. So the rows are a grid, not a
 * flex — the values line up down the panel whatever the label happened to be,
 * and the eye can run down the values alone.
 */

export function RecordSection({
  title,
  meta,
  className,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline gap-2">
        <Micro className="font-semibold text-foreground">{title}</Micro>
        {meta ? (
          <span className="text-[0.68rem] text-muted-foreground/70 tabular-nums">{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A stack of label/value pairs.
 *
 * The label column is only as wide as the labels need — the value has to sit
 * next to its label to read as one phrase, and a rule under every row turns a
 * six-fact panel into six paragraphs. What separates the rows is the label's
 * lower contrast; that is enough, and it leaves the panel quiet.
 */
export function Fields({
  children,
  className,
  /** How much room the labels need — a page has longer ones than a side panel. */
  labels = "6rem",
  /** Run the pairs in as many columns of this width as fit, instead of one. */
  columns,
}: {
  children: React.ReactNode;
  className?: string;
  labels?: string;
  columns?: string;
}) {
  return (
    <dl
      className={cn("m-0 grid gap-x-8 gap-y-1", className)}
      style={{
        "--field-labels": labels,
        gridTemplateColumns: columns ? `repeat(auto-fill,minmax(${columns},1fr))` : undefined,
      } as React.CSSProperties}
    >
      {children}
    </dl>
  );
}

export function Field({
  label,
  children,
  note,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  /** What qualifies the value — a rate, a share — kept on the same line. */
  note?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[var(--field-labels,6rem)_minmax(0,1fr)] items-baseline gap-x-2">
      <dt className="micro pt-px text-[0.63rem] [overflow-wrap:anywhere]">{label}</dt>
      <dd
        className="m-0 text-[0.8rem] tabular-nums [overflow-wrap:anywhere]"
      >
        {children}
        {note ? (
          <span className="ml-1.5 font-normal text-muted-foreground">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** A quiet control — the console's only button shape. */
export function ConsoleButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(CONTROL, className)}
      {...props}
    />
  );
}

/** The same shape as a button, for a link that navigates rather than acts. */
export function ConsoleLinkStyle(className?: string) {
  return cn(CONTROL, className);
}

const CONTROL = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border border-border "
  + "bg-background px-2.5 text-[0.76rem] font-medium text-foreground "
  + "no-underline transition-colors hover:bg-primary hover:text-primary-foreground "
  + "hover:no-underline";

/** Nothing selected, nothing matched — the panel still has to say something. */
export function Placeholder({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center px-6 py-10 text-center">
      <div className="grid max-w-[22rem] justify-items-center gap-2">
        {Icon ? (
          <span className="grid size-8 place-items-center border border-border bg-background text-muted-foreground">
            <Icon className="size-4" />
          </span>
        ) : null}
        <p className="m-0 text-[0.85rem] font-semibold">{title}</p>
        {children ? (
          <p className="m-0 text-[0.76rem] leading-relaxed text-pretty text-muted-foreground">
            {children}
          </p>
        ) : null}
        {action}
      </div>
    </div>
  );
}

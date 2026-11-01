"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One entry in a day list — a commitment, a payment, a leg — as a single thin
 * line: the time, what it was, one short figure. Clicking it moves the day
 * cursor there. Everything else about the entry is behind the chevron, so a
 * list of thirty fits beside the map and every label has the width it needs.
 */
export function DayRow({ time, title, figure, swatch, active, muted, onSeek, children }: {
  time: string;
  title: React.ReactNode;
  /** The one number worth seeing without opening the row. */
  figure?: React.ReactNode;
  swatch?: string;
  active?: boolean;
  /** Struck through — a declined payment. */
  muted?: boolean;
  onSeek: () => void;
  /** The details, as `Facts`. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-border first:border-0">
      <div className={cn("flex items-center", active && "bg-accent")}>
        <button
          type="button"
          className="grid min-w-0 flex-1 cursor-pointer grid-cols-[2.6rem_minmax(0,1fr)_auto] items-center gap-2 bg-transparent py-1 pl-1.5 text-left text-[0.78rem] leading-tight hover:bg-accent"
          onClick={onSeek}
          title={typeof title === "string" ? title : undefined}
        >
          <span className="text-muted-foreground tabular-nums">{time}</span>
          <span className="flex min-w-0 items-center gap-1.5">
            {swatch ? (
              <i className="size-2 shrink-0 rounded-full" style={{ background: swatch }} aria-hidden />
            ) : null}
            <span className="truncate font-medium first-letter:uppercase">{title}</span>
          </span>
          {figure != null ? (
            <span className={cn("text-muted-foreground tabular-nums", muted && "line-through")}>
              {figure}
            </span>
          ) : <span />}
        </button>
        {children ? (
          <button
            type="button"
            className="grid size-6 shrink-0 cursor-pointer place-items-center bg-transparent text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Details"}
          >
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {open && children ? <div className="px-1.5 pt-1 pb-2.5">{children}</div> : null}
    </li>
  );
}

export function DayList({ children }: { children: React.ReactNode }) {
  return <ol className="m-0 grid list-none p-0">{children}</ol>;
}

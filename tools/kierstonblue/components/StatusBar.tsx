"use client";

import Link from "next/link";

import { CityPicker, DayPicker } from "@/components/ScopePicker";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * The strip across the top of the page.
 *
 * The mark at the left is a home button, not a logo. The city build and the
 * day every page shows are chosen at the right (see Scope.tsx).
 *
 * It spans the full width above the rail rather than sitting inside the
 * content column, so the page reads as one surface with a nav bay cut into
 * its left side, not as a page with a sidebar.
 */
export function StatusBar() {
  return (
    <header
      className="flex h-8 shrink-0 items-stretch border-b border-border bg-background
        text-[0.72rem] tracking-[0.04em] text-muted-foreground uppercase"
    >
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 px-3 text-foreground no-underline hover:no-underline"
        aria-label="Overview"
        title="Overview"
      >
        <Mark />
        <span className="font-semibold tracking-[0.06em]">Kierston</span>
      </Link>
      <span className="ml-auto" />
      <CityPicker />
      <DayPicker />
      <ThemeToggle />
    </header>
  );
}

function Mark() {
  /* Four cells, one filled: the smallest thing that reads as an instrument
     rather than a logo. */
  return (
    <span aria-hidden className="grid size-3.5 shrink-0 grid-cols-2 gap-px">
      <span className="bg-primary" />
      <span className="bg-foreground/25" />
      <span className="bg-foreground/25" />
      <span className="bg-foreground/45" />
    </span>
  );
}

"use client";

import Link from "next/link";
import type { Identity } from "@/lib/identity";
import { Chip } from "@/components/console/Chip";
import { Button } from "@/components/ui/button";

/**
 * A resident id, rendered as the person it stands for.
 *
 * Every table and roster in the app used to end at a number: the workplace
 * roster said "cashier — 34, female", the household said "son — 9, male", and
 * the way to find out who that actually was involved copying an id into the
 * record page by hand. Those numbers are all joins to the same dossier, so
 * this is the one component that makes them clickable, and the one place that
 * decides what a person is called when identity.bin has not been built.
 */

export function recordHref(person: number): string {
  return `/record?person=${person}`;
}

/**
 * How a name reads when it is a way through to the person.
 *
 * A class rather than a component because half these are `<Link>` and half are
 * `<button>` that open a panel in place — same appearance, different element.
 * It is underlined and inked: these sit inside sentences and rosters where
 * nothing else is clickable, and a name that only reveals itself as a link
 * under the pointer is a name nobody knows to point at.
 */
export const PERSON_LINK = "cursor-pointer p-0 font-medium text-[var(--accent-ink)] "
  + "underline decoration-[var(--accent-ink)]/40 underline-offset-2 "
  + "hover:decoration-[var(--accent-ink)]";

/**
 * A figure trailing the thing it qualifies — a resident id after a name, a
 * percentage after a count.
 *
 * Sized relative to its context so it stays subordinate whether it follows
 * body text or a heading, with compact sizing because it is always a number.
 */
export const PID = "text-[max(0.68rem,0.82em)] font-normal not-italic "
  + "text-muted-foreground";

/** First and last name, or the resident id where there is no identity file. */
export function personName(names: Identity | null, person: number): string {
  return names?.knows(person) ? names.shortName(person) : `Resident ${person}`;
}

export function PersonLink({ names, person, className }: {
  names: Identity | null;
  person: number;
  /** Extra classes; the chip shape is always applied. */
  className?: string;
}) {
  return (
    <Chip
      kind="person"
      href={recordHref(person)}
      className={className}
      title={names?.knows(person) ? names.name(person) : undefined}
    >
      {personName(names, person)}
    </Chip>
  );
}

/** The way out of a row and into the whole person, for a detail panel. */
export function FullRecordLink({ person }: { person: number }) {
  return (
    <Button asChild size="xs">
      <Link href={recordHref(person)}>Full record</Link>
    </Button>
  );
}

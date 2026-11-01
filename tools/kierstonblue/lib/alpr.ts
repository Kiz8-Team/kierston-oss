/**
 * What a plate read is called, and what it is worth.
 *
 * The six outcomes are not a severity scale and are deliberately not drawn as
 * one. Three of them are the camera getting text out of a passage — right,
 * wrong, or nothing — and three are the passage never becoming a row a
 * downstream tool would trust. The colours say which of those two groups a
 * read is in; the labels say what happened inside it.
 */

import type { CameraDayRow, CameraRead } from "@/lib/server/alpr";

export const OUTCOME_LABEL: Record<string, string> = {
  correct: "Correct",
  misread: "Misread",
  unreadable: "Unreadable",
  not_captured: "Not captured",
  no_plate: "No plate",
  spurious: "Spurious",
};

/**
 * Green for a read that says what was there, amber for one that says nothing,
 * red for one that says something untrue. A misread and a spurious read share
 * the red because they share the failure that matters: both put a plate into
 * the record that no vehicle was carrying.
 */
export const OUTCOME_TONE: Record<string, string> = {
  correct: "var(--success)",
  misread: "var(--destructive)",
  unreadable: "var(--warning)",
  not_captured: "var(--warning)",
  no_plate: "var(--muted-foreground)",
  spurious: "var(--destructive)",
};

export const OUTCOME_ORDER = [
  "correct", "misread", "unreadable", "not_captured", "no_plate", "spurious",
] as const;

export const SOURCE_LABEL: Record<string, string> = {
  resident: "Resident",
  external: "External",
};

export const LIGHTING_LABEL: Record<string, string> = {
  day: "Daylight",
  night_ir: "Night, IR",
  twilight: "Twilight",
};

/**
 * A pass's second on the clock, and which day that clock belongs to.
 *
 * An exported day is not twenty-four hours of passes. A leg that departed
 * before midnight puts a vehicle over a camera at a negative second, and a leg
 * still running at midnight puts one there past 86,400. Both are real
 * crossings of this camera inside this file, so neither is clamped away: the
 * clock is the wall clock, and the offset says which side of midnight it is.
 */
export const dayOffset = (second: number) => Math.floor(Math.round(second) / 86400);

export const clockSecond = (second: number) => {
  const value = Math.round(second) % 86400;
  return value < 0 ? value + 86400 : value;
};

/** Second of the day as a wall clock, which is the resolution reads are at. */
export function hms(second: number): string {
  const value = clockSecond(second);
  const pad = (part: number) => String(part).padStart(2, "0");
  const clock = `${pad(Math.floor(value / 3600))}:${pad(Math.floor(value / 60) % 60)}:${pad(value % 60)}`;
  const offset = dayOffset(second);
  if (offset === 0) return clock;
  return `${clock} ${offset > 0 ? "+" : "−"}${Math.abs(offset)}d`;
}

export const hourOf = (second: number) => Math.floor(clockSecond(second) / 3600);

/** The plate registry, filtered to one plate. See RecordBrowser's `q`. */
export const plateHref = (plate: string) => `/vehicles?q=${encodeURIComponent(plate)}`;

export function cameraHref(id: string, date?: string): string {
  return date ? `/cameras/${encodeURIComponent(id)}?date=${date}` : `/cameras/${encodeURIComponent(id)}`;
}

/**
 * How often this camera was right about a vehicle it could see.
 *
 * Conditional on capture, and stated that way, because the unconditional share
 * folds in vehicles that carried no plate on the side the lens faces — a lens
 * facing the front of Pennsylvania traffic is not inaccurate, it is aimed at a
 * bumper the state does not issue a plate for.
 */
export function accuracy(camera: CameraDayRow): number | null {
  const correct = camera.outcomes.correct ?? 0;
  const captured = correct + (camera.outcomes.misread ?? 0) + (camera.outcomes.unreadable ?? 0);
  return captured > 0 ? correct / captured : null;
}

/** How many of a camera's passes were on a plate somebody chose. */
export const vanityCount = (reads: CameraRead[]) =>
  reads.reduce((total, read) => total + (read.personalized ? 1 : 0), 0);

/** Passes and reads by hour, for the day's column chart. */
export function byHour(reads: CameraRead[]): { passes: number[]; read: number[] } {
  const passes = Array.from({ length: 24 }, () => 0);
  const read = Array.from({ length: 24 }, () => 0);
  for (const entry of reads) {
    const hour = hourOf(entry.second);
    passes[hour] += 1;
    if (entry.detected !== null) read[hour] += 1;
  }
  return { passes, read };
}

/**
 * Which characters the camera got wrong, as a mask over the detected text.
 *
 * Aligned from the left and only where the lengths match: a deletion or an
 * insertion shifts everything after it, and marking every character from that
 * point as wrong would say the reader failed worse than it did. Where the
 * lengths differ the whole string is simply shown as wrong.
 */
export function misreadMask(truth: string | null, detected: string | null): boolean[] | null {
  if (!truth || !detected) return null;
  if (truth.length !== detected.length) return null;
  return [...detected].map((character, at) => character !== truth[at]);
}

/** Everything a filter can be set to, with "any" meaning unfiltered. */
export interface ReadFilters {
  query: string;
  outcome: string;
  source: string;
  /**
   * any, personalized, or standard. Standard means a plate the state issued in
   * sequence, and a vehicle from outside is never counted as either — the
   * register that decides the question holds only this city's vehicles.
   */
  plate: string;
}

export const NO_FILTERS: ReadFilters = {
  query: "", outcome: "any", source: "any", plate: "any",
};

export function matches(read: CameraRead, filters: ReadFilters): boolean {
  if (filters.outcome !== "any" && read.outcome !== filters.outcome) return false;
  if (filters.source !== "any" && read.source !== filters.source) return false;
  if (filters.plate === "personalized" && !read.personalized) return false;
  if (filters.plate === "standard"
      && (read.personalized || read.source === "external" || read.plate === null)) {
    return false;
  }
  const needle = filters.query.trim().toLowerCase();
  if (!needle) return true;
  return [read.plate, read.detected, read.canonical, read.correlation, read.vehicle?.plate]
    .some((field) => field?.toLowerCase().includes(needle));
}

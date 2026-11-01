/**
 * When in the day people want to be somewhere, as a curve rather than a window.
 *
 * The first version gave each occasion a window — dinner 17:30 to 20:00, a
 * coffee 09:00 to 16:00 — and then took the first minute in it both people were
 * free. Almost everybody is free at the moment a window opens, so almost every
 * dinner in the city started at 17:30, and a restaurant's arrivals log was one
 * vertical line a day. A window says where something *can* happen; it says
 * nothing about where it *tends* to, and the second is the whole shape of a
 * venue's day.
 *
 * So each purpose has a relative weight per hour, weekday and weekend apart,
 * and a draw picks among the minutes a person is actually free in proportion to
 * it. The bounds that are left are only the outer ones — the hours at which the
 * weight is zero — and those are what a venue's opening hours already enforce;
 * nothing here pretends a sit-down meal at 10:00 is impossible, only that on a
 * Tuesday it is much rarer than one at 19:00. Who is free when does the rest:
 * a worker's weekday leaves only the evening, a retiree's leaves all of it, and
 * that difference is the daytime traffic a real café has.
 *
 * The numbers are relative and judgment, shaped to the published hourly
 * visit profiles (lunch and dinner peaks for food, a late-afternoon weekday
 * peak for shops and parks, a flat broad weekend) rather than fitted to one.
 */

import type { Rng } from "../../shared/index.ts";
import type { Purpose } from "./venues.ts";

/** Twenty-four relative weights, index = hour of the day. */
type Curve = readonly number[];

/** Build a curve from `{ hour: weight }`, every unnamed hour zero. */
function curve(points: Record<number, number>): Curve {
  return Array.from({ length: 24 }, (_, hour) => points[hour] ?? 0);
}

interface Profile {
  weekday: Curve;
  weekend: Curve;
}

export const HOURS: Partial<Record<Purpose, Profile>> = {
  cafe: {
    weekday: curve({ 6: 2, 7: 6, 8: 9, 9: 8, 10: 6, 11: 4, 12: 4, 13: 4, 14: 5, 15: 5, 16: 4, 17: 3, 18: 2, 19: 1 }),
    weekend: curve({ 7: 2, 8: 4, 9: 7, 10: 9, 11: 8, 12: 6, 13: 5, 14: 5, 15: 5, 16: 4, 17: 2, 18: 1 }),
  },
  "food-quick": {
    weekday: curve({ 7: 1, 8: 1, 9: 1, 10: 2, 11: 6, 12: 10, 13: 7, 14: 3, 15: 2, 16: 3, 17: 5, 18: 6, 19: 5, 20: 3, 21: 1 }),
    weekend: curve({ 9: 1, 10: 2, 11: 5, 12: 8, 13: 8, 14: 5, 15: 3, 16: 3, 17: 5, 18: 6, 19: 5, 20: 3, 21: 1 }),
  },
  "food-sit": {
    weekday: curve({ 8: 1, 9: 1, 10: 1, 11: 3, 12: 6, 13: 4, 14: 1, 15: 1, 16: 2, 17: 5, 18: 9, 19: 10, 20: 6, 21: 2 }),
    weekend: curve({ 8: 2, 9: 4, 10: 6, 11: 7, 12: 7, 13: 5, 14: 2, 15: 2, 16: 3, 17: 6, 18: 9, 19: 10, 20: 6, 21: 2 }),
  },
  bar: {
    weekday: curve({ 15: 1, 16: 3, 17: 6, 18: 7, 19: 7, 20: 7, 21: 6, 22: 4, 23: 2 }),
    weekend: curve({ 13: 1, 14: 2, 15: 3, 16: 4, 17: 5, 18: 6, 19: 7, 20: 8, 21: 8, 22: 6, 23: 3 }),
  },
  retail: {
    weekday: curve({ 9: 2, 10: 4, 11: 5, 12: 6, 13: 6, 14: 5, 15: 5, 16: 6, 17: 8, 18: 8, 19: 6, 20: 3 }),
    weekend: curve({ 9: 2, 10: 5, 11: 8, 12: 9, 13: 9, 14: 9, 15: 8, 16: 7, 17: 5, 18: 4, 19: 2, 20: 1 }),
  },
  park: {
    weekday: curve({ 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 3, 13: 3, 14: 3, 15: 4, 16: 6, 17: 8, 18: 8, 19: 5 }),
    weekend: curve({ 7: 2, 8: 4, 9: 6, 10: 8, 11: 9, 12: 8, 13: 8, 14: 8, 15: 8, 16: 7, 17: 6, 18: 5, 19: 3 }),
  },
};

/**
 * The weight at a minute, interpolated between hour midpoints so a curve has
 * no steps on the hour for arrivals to pile up against.
 */
export function weightAt(profile: Profile, minute: number, weekend: boolean): number {
  const hours = weekend ? profile.weekend : profile.weekday;
  const position = (((minute % 1440) + 1440) % 1440) / 60 - 0.5;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const a = hours[(lower + 24) % 24]!;
  const b = hours[(lower + 25) % 24]!;
  // An hour of zero stays zero right up to its edge: interpolating into it
  // would put a trickle of dinners at 07:40 that the curve never asked for.
  if (a === 0 || b === 0) return fraction < 0.5 ? a : b;
  return a + (b - a) * fraction;
}

/** Where the curve is nonzero, as [first, last] minute. */
export function spanOf(profile: Profile, weekend: boolean): [number, number] {
  const hours = weekend ? profile.weekend : profile.weekday;
  const first = hours.findIndex((weight) => weight > 0);
  let last = 23;
  while (last > 0 && hours[last] === 0) last -= 1;
  return [first * 60, last * 60 + 59];
}

/** Five-minute cumulative tables, built once per purpose and day type. */
const STEP = 5;
const tables = new Map<string, Float64Array>();

function table(purpose: Purpose, profile: Profile, weekend: boolean): Float64Array {
  const key = `${purpose}:${weekend ? 1 : 0}`;
  let cumulative = tables.get(key);
  if (cumulative) return cumulative;
  cumulative = new Float64Array(1440 / STEP);
  let total = 0;
  for (let bin = 0; bin < cumulative.length; bin += 1) {
    total += weightAt(profile, bin * STEP + STEP / 2, weekend);
    cumulative[bin] = total;
  }
  tables.set(key, cumulative);
  return cumulative;
}

/**
 * A minute of the day for this purpose, drawn from its curve — or null where
 * the purpose has no curve and the caller keeps its own window.
 */
export function drawMinute(purpose: Purpose, weekend: boolean, rng: Rng): number | null {
  const profile = HOURS[purpose];
  if (!profile) return null;
  const cumulative = table(purpose, profile, weekend);
  const roll = rng.next() * cumulative[cumulative.length - 1]!;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! < roll) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(1439, lo * STEP + Math.floor(rng.next() * STEP));
}

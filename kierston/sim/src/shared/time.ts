/**
 * Time in the simulation is minutes, and days are integers.
 *
 * A plan's minutes are counted from midnight of the day it belongs to and are
 * deliberately not wrapped: a night watch that starts at 1380 ends at 1860, and
 * a medic's 24-hour tour ends at 2340. Wrapping them would mean every consumer
 * of a block had to know whether `end < start` meant "tomorrow" or "bug", and
 * the arithmetic that answers "were these two people in the same place" would
 * have to special-case midnight. Only clock display wraps.
 */

export const MINUTES_PER_DAY = 1440;

/** Days since the Unix epoch, in local calendar terms. */
export function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function fromDayNumber(day: number): Date {
  return new Date(day * 86_400_000);
}

export function parseDate(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`expected YYYY-MM-DD, got "${text}"`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 0 = Monday, 6 = Sunday. The rota tables are written in these terms. */
export function weekday(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** YYYY-MM-DD in local terms. `toISOString` would shift the date by the offset. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** hh:mm, with a +1/+2 suffix when the minute has run past midnight. */
export function clock(minutes: number): string {
  const day = Math.floor(minutes / MINUTES_PER_DAY);
  const within = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const text = `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
  return day === 0 ? text : `${text}+${day}`;
}

export function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

/**
 * Congestion, as a multiplier on free-flow travel time.
 *
 * The car graph is built from `maxspeed` and class defaults, so every route it
 * returns is a 3 a.m. route. This curve is the cheapest correction that makes
 * a commute cost what a commute costs: two peaks, a midday plateau, and free
 * running overnight. It is a placeholder in the same sense as the spend shares
 * — the shape is right, the depth of the peaks is a guess, and the thing that
 * would replace it is a network loading pass that counts how many simulated
 * vehicles are on each edge in each ten-minute bin and feeds that back.
 */
const CONGESTION: readonly number[] = [
  1.00, 1.00, 1.00, 1.00, 1.00, 1.04, // 00–05
  1.12, 1.26, 1.34, 1.22, 1.10, 1.08, // 06–11
  1.12, 1.10, 1.10, 1.18, 1.30, 1.38, // 12–17
  1.24, 1.12, 1.05, 1.02, 1.00, 1.00, // 18–23
];

export function congestion(minute: number): number {
  const within = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(within / 60);
  const next = (hour + 1) % 24;
  const t = (within % 60) / 60;
  return CONGESTION[hour]! * (1 - t) + CONGESTION[next]! * t;
}

/**
 * When the next payment on a stream falls.
 *
 * The records give a rule and one real dated payday. That pair is deliberately
 * the whole calendar: a frequency alone cannot place "every other Friday" —
 * there are two answers and only the phase says which — so `banking.py` writes
 * `anchor`, the last payday on or before the reference date, and everything
 * else is projected from it here.
 *
 * Two kinds of rule, and they project differently. A weekday rule is pure
 * spacing, so it steps forward by `intervalDays` from the anchor and lands
 * exactly. A calendar rule names days of the month — the 1st, the 15th, the
 * last day — and those are not evenly spaced, so stepping by an interval would
 * drift off them within a quarter. Those are recomputed against the calendar
 * instead, which is also why `intervalDays` on a semimonthly stream is 15 and
 * not 15.2: it is a nominal spacing for anyone who wants one, not the thing
 * the dates are derived from.
 *
 * Dates are handled in UTC throughout. A payday is a calendar day and not an
 * instant, and running this through a local timezone moves half of them a day
 * either way depending on where the process happens to be.
 */

import type { IncomeStream } from "./accounts.ts";

const DAY = 86_400_000;

/** Monday is 1 here, matching the weekday names the generator writes. */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6,
};

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0));
}

/** The nth given weekday of a month — the Social Security payment rule. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + 7 * (n - 1)));
}

/** Every day of `month` this rule pays on, in order. */
function paydaysInMonth(payday: string, year: number, month: number): Date[] {
  const on = (day: number) => new Date(Date.UTC(year, month, day));
  switch (payday) {
    case "1st": return [on(1)];
    case "3rd": return [on(3)];
    case "last_day": return [monthEnd(year, month)];
    case "1st_and_15th": return [on(1), on(15)];
    case "15th_and_last": return [on(15), monthEnd(year, month)];
    case "ss_wednesday_2": return [nthWeekday(year, month, 3, 2)];
    case "ss_wednesday_3": return [nthWeekday(year, month, 3, 3)];
    case "ss_wednesday_4": return [nthWeekday(year, month, 3, 4)];
    default: return [];
  }
}

/**
 * The first payday strictly after `from`, as yyyy-mm-dd.
 *
 * Null when the stream has no anchor to project from. An irregular stream —
 * a sole trader paid when the client pays — returns its mean spacing, which is
 * an expectation rather than a date, and the caller should treat it that way.
 */
export function nextPayday(stream: IncomeStream, from: string): string | null {
  if (!stream.anchor) return null;
  const after = parse(from);

  if (stream.payday in WEEKDAYS || stream.payday === "irregular") {
    const step = stream.intervalDays || 14;
    let when = parse(stream.anchor);
    // Guarded rather than unbounded: a corrupt interval of 0 would spin here,
    // and the loop should fail visibly instead of hanging the simulation.
    for (let i = 0; i < 4_000 && when <= after; i += 1) {
      when = new Date(when.getTime() + step * DAY);
    }
    return when > after ? iso(when) : null;
  }

  for (let ahead = 0; ahead < 14; ahead += 1) {
    const probe = new Date(Date.UTC(
      after.getUTCFullYear(), after.getUTCMonth() + ahead, 1));
    for (const day of paydaysInMonth(
      stream.payday, probe.getUTCFullYear(), probe.getUTCMonth())) {
      if (day > after) return iso(day);
    }
  }
  return null;
}

/**
 * The last payday on or before `from`, as yyyy-mm-dd.
 *
 * Not the same thing as `stream.anchor`, and the difference matters. The
 * anchor is fixed at the date `banking.py` generated against and is there to
 * give the rule a phase; by the time the simulation is running some weeks
 * later, several paydays have gone by that the anchor knows nothing about.
 * Read the anchor as "when this schedule was pinned", and this as "when they
 * were actually last paid".
 */
export function lastPayday(stream: IncomeStream, from: string): string | null {
  if (!stream.anchor) return null;
  const before = parse(from);
  if (parse(stream.anchor) > before) return null;

  if (stream.payday in WEEKDAYS || stream.payday === "irregular") {
    const step = stream.intervalDays || 14;
    let when = parse(stream.anchor);
    for (let i = 0; i < 4_000; i += 1) {
      const forward = new Date(when.getTime() + step * DAY);
      if (forward > before) break;
      when = forward;
    }
    return iso(when);
  }

  for (let back = 0; back < 14; back += 1) {
    const probe = new Date(Date.UTC(
      before.getUTCFullYear(), before.getUTCMonth() - back, 1));
    const days = paydaysInMonth(
      stream.payday, probe.getUTCFullYear(), probe.getUTCMonth())
      .filter((day) => day <= before);
    if (days.length) return iso(days[days.length - 1]!);
  }
  return null;
}

/** Every payday on a stream in [from, to], both ends inclusive of the rule. */
export function paydaysBetween(
  stream: IncomeStream, from: string, to: string,
): string[] {
  const end = parse(to);
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < 400; i += 1) {
    const next = nextPayday(stream, cursor);
    if (!next || parse(next) > end) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** What a stream pays over a year, from its own schedule. */
export function annualNet(stream: IncomeStream): number {
  const periods = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }[
    stream.frequency] ?? (stream.intervalDays ? 365 / stream.intervalDays : 12);
  return Math.round(stream.netPerPeriod * periods * 100) / 100;
}

/**
 * What one person's day gained and lost, row by row.
 *
 * The delta cannot answer this. Its patches address byte ranges of whole
 * columns, so "this leg is new" is not a thing it records — the same insertion
 * shows up as a shifted offset column and a longer path column, and the
 * intervening background is copied through untouched. The row-level reading
 * only exists once both days are materialized and their tables are compared,
 * which is what this does.
 *
 * Matching is by content, not by position. A scenario that inserts a midday
 * cafe trip pushes every later leg down one index, and an index-wise
 * comparison would call the whole afternoon changed. Each row is reduced to a
 * key of the fields a reader would use to say two rows are the same event, and
 * rows are paired on that. Duplicate keys are consumed in order, so a day with
 * two identical £3.20 charges at the same minute pairs both rather than
 * reporting one added and one removed.
 */

import type { DayMovementLeg, DayScheduleEntry, DayTransaction, PersonDay } from "@/lib/server/day";

export type ChangeKind = "added" | "removed" | "same";

export interface DiffRow<T> {
  kind: ChangeKind;
  /** Present for `removed` and `same`. */
  before: T | null;
  /** Present for `added` and `same`. */
  after: T | null;
  /** Ordering key, so both sides interleave into one chronological list. */
  at: number;
}

export interface DiffTally {
  added: number;
  removed: number;
  same: number;
}

export function tally<T>(rows: DiffRow<T>[]): DiffTally {
  return {
    added: rows.filter((row) => row.kind === "added").length,
    removed: rows.filter((row) => row.kind === "removed").length,
    same: rows.filter((row) => row.kind === "same").length,
  };
}

/**
 * Pair two lists on a content key and return one chronological run.
 *
 * Rows that pair are `same` and carry both sides — a caller that wants to show
 * a moved row still has both times. Rows that do not pair are the change.
 */
function diffBy<T>(
  before: T[],
  after: T[],
  key: (row: T) => string,
  at: (row: T) => number,
): DiffRow<T>[] {
  const pending = new Map<string, T[]>();
  for (const row of before) {
    const bucket = pending.get(key(row));
    if (bucket) bucket.push(row);
    else pending.set(key(row), [row]);
  }

  const rows: DiffRow<T>[] = [];
  for (const row of after) {
    const bucket = pending.get(key(row));
    const match = bucket?.shift() ?? null;
    if (match) rows.push({ kind: "same", before: match, after: row, at: at(row) });
    else rows.push({ kind: "added", before: null, after: row, at: at(row) });
  }
  for (const bucket of pending.values()) {
    for (const row of bucket) {
      rows.push({ kind: "removed", before: row, after: null, at: at(row) });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * Keys, one per table.
 *
 * Deliberately not every field. A leg's path is a few hundred points that
 * shift with any reroute, and including it would make every leg on a changed
 * route read as removed-and-added rather than as the one leg that moved. The
 * key is what identifies the event: when it happened, how, and what for.
 */
const legKey = (leg: DayMovementLeg) =>
  `${leg.depart}|${leg.arrive}|${leg.mode}|${leg.purpose}|${leg.to.label ?? ""}`;

const scheduleKey = (entry: DayScheduleEntry) =>
  `${entry.start}|${entry.end}|${entry.kind}|${entry.label ?? ""}|${entry.where ?? ""}`;

/**
 * A charge is identified by when, how much and to whom. The balance after it
 * is left out on purpose: inserting one earlier purchase rewrites the running
 * balance of every later row, and those rows are not changes — they are the
 * same charges against a moved balance, which the detail view shows for the
 * pairs it matched.
 */
const transactionKey = (tx: DayTransaction) =>
  `${tx.minute}|${tx.amount.toFixed(2)}|${tx.reason}|${tx.merchant ?? ""}|${tx.approved}`;

export interface PersonDiff {
  schedule: DiffRow<DayScheduleEntry>[];
  legs: DiffRow<DayMovementLeg>[];
  transactions: DiffRow<DayTransaction>[];
  /** Net movement of the day's closing balance, where both sides settled one. */
  balanceShift: number | null;
  /** Kilometres travelled, before and after. */
  distance: [number, number];
}

const lastBalance = (day: PersonDay | null): number | null => {
  for (let i = (day?.transactions.length ?? 0) - 1; i >= 0; i -= 1) {
    const balance = day!.transactions[i]!.balanceAfter;
    if (balance !== null) return balance;
  }
  return null;
};

const kilometres = (day: PersonDay | null) =>
  (day?.legs ?? []).reduce((total, leg) => total + leg.kilometres, 0);

export function diffPersonDay(before: PersonDay | null, after: PersonDay | null): PersonDiff {
  const beforeBalance = lastBalance(before);
  const afterBalance = lastBalance(after);
  return {
    schedule: diffBy(before?.schedule ?? [], after?.schedule ?? [], scheduleKey, (row) => row.start),
    legs: diffBy(before?.legs ?? [], after?.legs ?? [], legKey, (row) => row.depart),
    transactions: diffBy(
      before?.transactions ?? [],
      after?.transactions ?? [],
      transactionKey,
      (row) => row.minute,
    ),
    balanceShift: beforeBalance !== null && afterBalance !== null
      ? afterBalance - beforeBalance
      : null,
    distance: [kilometres(before), kilometres(after)],
  };
}

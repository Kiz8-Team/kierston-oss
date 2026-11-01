/**
 * The things people belong to, and when those things meet.
 *
 * `init/social/affiliations.py` says a unit is a partition and not a schedule —
 * "what night it meets does not change who is in it". That was the right call
 * for building the graph and it is exactly the gap this module fills. The
 * partition is given; the calendar is what turns it into a Tuesday.
 *
 * The calendar is generated per org, once, and not per person
 * -----------------------------------------------------------
 * This is the whole design and everything else follows from it. If each member
 * of a congregation drew their own Sunday morning, four hundred people would
 * be smeared across the day and nobody would ever be in the room with anybody —
 * the co-presence that a congregation exists to produce would be destroyed by
 * the sampling. So the org draws one service time for the year and the members
 * decide only whether they came. Four hundred arrivals inside fifteen minutes
 * is not a detail; it is the single largest non-work co-presence event in the
 * city's day and it is worth building the module around.
 *
 * Attendance is derived, not guessed
 * ----------------------------------
 * `ties.py` published EXPOSURE — "the share of days on which the two are in
 * the same room" — and used it to weight every edge in the graph. That table
 * is a constraint on this layer, not a coincidence: if two members of a unit
 * meet on 16% of days in the graph and on 4% of days in the simulation, one of
 * the two is wrong, and the graph has already been written.
 *
 * For a synchronised class, two members are in the room together when the org
 * meets and both come. With k occurrences a week and independent attendance p,
 *
 *     exposure = k · p² / 7        so        p = √(7 · exposure / k)
 *
 * which means picking a cadence picks the attendance rate. The cadences below
 * are conventional — a congregation on Sunday plus a midweek group, a team
 * that trains and plays, a lodge that meets fortnightly, a local that meets
 * monthly — and the striking thing is that every one of them then solves to an
 * attendance between 0.67 and 0.75. A table of exposures written months ago
 * for a different purpose turning out to be consistent with ordinary cadences
 * at one plausible rate is the best evidence available that both are about
 * right.
 *
 * That is the clean derivation, and it is not quite what the code does. The
 * suppressions further down — shift conflicts, the midweek discount, tenure —
 * are real and all point the same way, and together they cost about a third of
 * the attendance the formula assumes. So each class carries a fitted LIFT that
 * puts the *realised* exposure back on target rather than the nominal one. See
 * LIFT for why that is a calibration and not a fudge, and what the better fix
 * would be.
 *
 * Two classes end up pinned against the ceiling once the lift is applied.
 * Worship needs an attendance of 0.97 and a union local 0.99 to reach the
 * exposure `ties.py` assigned them, which is another way of saying those two
 * targets are not reachable at the cadence assumed here: a congregation that
 * gathers twice a week cannot produce co-presence on 16% of days unless
 * essentially nobody ever misses. Either they meet more often than twice, or
 * EXPOSURE overstates them. The check prints the implied attendance in a
 * column precisely so that this is visible rather than buried.
 */

import { join } from "node:path";
import { SIM_DATA_DIR, type Person, type World } from "../../world/index.ts";
import { LAYER, mix, Rng, stream, weekday } from "../../shared/index.ts";

export type OrgClass = "worship" | "gym" | "sports" | "civic" | "fraternal" | "youth" | "union" | "work" | "school";

export interface AffiliationRow {
  person: number;
  org: string;
  class: OrgClass;
  role: string;
  since: number;
  unit: number;
  shift?: string;
}

export interface OrgRecord {
  id: string;
  class: OrgClass;
  subclass: string | null;
  name: string;
  lat: number;
  lon: number;
  pull: number;
}

/**
 * Exposure targets, copied from `init/social/ties.py`.
 *
 * Copied rather than imported because there is no import — one is Python that
 * has already run and written its answer into `ties.bin`, the other is the
 * runtime that has to reproduce it. Duplicating a constant across a language
 * boundary is a liability, so the check prints both and the day they disagree
 * is the day one of them moved.
 */
export const EXPOSURE: Record<string, number> = {
  work: 0.88, school: 0.90, worship: 0.16, gym: 0.11, sports: 0.14,
  civic: 0.07, fraternal: 0.04, youth: 0.13, union: 0.02,
};

/**
 * How often each class meets, in occurrences per week.
 *
 * Two numbers where the org and the unit meet on different rhythms. A
 * congregation gathers whole on Sunday and in small groups midweek, and those
 * are genuinely different events: one puts four hundred people in a building
 * and produces almost no conversation, the other puts nine people in a living
 * room and produces most of the ties. Splitting them is what lets the same
 * affiliation generate both.
 */
interface Cadence {
  /** Whole-org gatherings per week. */
  org: number;
  /** Unit gatherings per week. */
  unit: number;
  /** Minutes, typical. */
  length: number;
  season: boolean;
}

const CADENCE: Record<string, Cadence> = {
  worship: { org: 1, unit: 1, length: 75, season: false },
  sports: { org: 0, unit: 2, length: 90, season: true },
  civic: { org: 0.5, unit: 0.5, length: 105, season: false },
  // Fraternal does not solve monthly. A lodge meeting every four weeks
  // (k = 0.23) needs p = 1.09 to reach an exposure of 0.04, which is not a
  // probability. Either the lodges meet fortnightly — plausible; many do, and
  // the extract's thirteen are social centres as much as lodges — or 0.04 is
  // too high by about half. Fortnightly is assumed because it is the
  // assumption that can be wrong without making the arithmetic impossible, and
  // at that cadence it lands at 0.82, comfortably inside a probability.
  fraternal: { org: 0.5, unit: 0, length: 120, season: false },
  youth: { org: 0, unit: 2, length: 100, season: true },
  union: { org: 0.25, unit: 0, length: 90, season: false },
};

/**
 * The gym, which is the class that proves the rule.
 *
 * There is no calendar. `ties.py` gives the gym REALIZE = 0.15 — the lowest of
 * any class by a factor of four — which is the graph saying that sharing a gym
 * with someone almost never makes you know them, and a scheduled gym would
 * contradict that. People go at their own times, alone, and leave.
 *
 * What is worth noticing is that the gym's exposure falls out anyway. If two
 * members each attend on independent days at a rate v per week, they share a
 * day with probability (v/7)², and EXPOSURE 0.11 gives v = 2.32 visits a week —
 * which is, to two figures, the published US average. The gym needed no
 * synchronisation to reproduce its own exposure, and that is the cleanest
 * evidence in the table that leaving it unsynchronised is right.
 *
 * The step from "same day" to "same room" is carried by the unit. A gym unit
 * is a time-of-day cohort, so two members of one are the 6 a.m. crowd and
 * being there on the same day very nearly is being there together.
 */
const GYM_VISITS_PER_WEEK = Math.sqrt(EXPOSURE.gym!) * 7 * 1.08;

/**
 * What the derivation loses on contact with a real population, per class.
 *
 * `p = √(7·exposure/k)` assumes every member is free whenever their org meets
 * and that every occurrence is as well attended as every other. Neither holds.
 * A congregation contains shift workers who are on the evening watch when the
 * midweek group meets; a midweek group is a harder ask than the principal
 * service; a member who joined last spring is not the member who joined in
 * 2007. Each of those is modelled explicitly below, and together they pull the
 * realised attendance a long way under the derived one — worship landed at
 * 0.093 against a target of 0.160 before this existed.
 *
 * So this is a fitted constant and is the third in the runtime, after
 * `RUNNING` and `USABLE_KERB`. It is fitted the same way: run the exposure
 * check, read the drift, divide. What it is *not* is a fudge — the quantity it
 * corrects for is the drag of every suppression in the file, and the honest
 * alternative is not "no lift" but "revise EXPOSURE in ties.py and rebuild the
 * graph". Rebuilding the graph is the better answer and this is the cheaper
 * one, so the check prints both numbers side by side and the day someone wants
 * to do it properly the evidence is already on screen.
 *
 * Where a lift would need an attendance above 1 the class cannot reach its
 * target at the cadence it has been given, and that is a finding rather than a
 * failure — it means the cadence is wrong. See `fraternal`.
 */
const LIFT: Record<string, number> = {
  worship: 1.30,
  sports: 1.36,
  civic: 1.20,
  fraternal: 1.10,
  youth: 1.10,
  union: 1.41,
};

/** Attendance implied by a cadence and an exposure target. */
export function impliedAttendance(orgClass: string): number {
  const cadence = CADENCE[orgClass];
  const exposure = EXPOSURE[orgClass];
  if (!cadence || exposure === undefined) return 0;
  const k = cadence.org + cadence.unit;
  if (k <= 0) return 0;
  return Math.min(0.99, Math.sqrt((7 * exposure) / k) * (LIFT[orgClass] ?? 1));
}

/**
 * When a congregation gathers, by what it is.
 *
 * The day is not a draw for most of these — it is doctrine, and getting it
 * wrong is the kind of error a reader spots instantly. The subclass comes from
 * `orgs.py`, which kept the `religion` and `denomination` tags precisely so
 * that this decision could be made downstream.
 */
const SABBATH: Record<string, number> = {
  jewish: 5, muslim: 4, "seventh_day_adventist": 5,
};

const SEASONS: Record<string, [number, number]> = {
  // Month numbers, 1-based, inclusive. A pitch in February has nobody on it.
  baseball: [4, 8], softball: [4, 8], soccer: [3, 11], basketball: [11, 3],
  american_football: [8, 12], tennis: [5, 9], swimming: [6, 8], hockey: [10, 3],
  athletics: [4, 9], multi: [1, 12],
};

export interface Occurrence {
  org: string;
  /** Null where the whole org gathers rather than one unit. */
  unit: number | null;
  class: OrgClass;
  start: number;
  end: number;
  /** Whole-org gatherings are the ones that produce a crowd. */
  wholeOrg: boolean;
}

export interface Attendance {
  person: number;
  occurrence: Occurrence;
  /** Minutes: real people do not all arrive on the hour. */
  arrive: number;
  leave: number;
}

export class Affiliations {
  readonly orgs = new Map<string, OrgRecord>();
  private readonly byPerson = new Map<number, AffiliationRow[]>();
  private readonly units = new Map<string, AffiliationRow[]>();
  private readonly orgSize = new Map<string, number>();

  private constructor(orgs: OrgRecord[], rows: AffiliationRow[], readonly seed: number) {
    for (const org of orgs) this.orgs.set(org.id, org);
    for (const row of rows) {
      let list = this.byPerson.get(row.person);
      if (!list) this.byPerson.set(row.person, (list = []));
      list.push(row);
      const key = `${row.org}#${row.unit}`;
      const unit = this.units.get(key);
      if (unit) unit.push(row);
      else this.units.set(key, [row]);
      this.orgSize.set(row.org, (this.orgSize.get(row.org) ?? 0) + 1);
    }
  }

  /** Units of a class with at least `least` members — the exposure check's frame. */
  unitsOfClass(orgClass: string, least = 2): AffiliationRow[][] {
    const out: AffiliationRow[][] = [];
    for (const unit of this.units.values()) {
      if (unit.length >= least && unit[0]!.class === orgClass) out.push(unit);
    }
    return out;
  }

  static async open(seed: number): Promise<Affiliations> {
    const [orgs, affiliations] = await Promise.all([
      Bun.file(join(SIM_DATA_DIR, "orgs.json")).json() as Promise<{ org_records: OrgRecord[] }>,
      Bun.file(join(SIM_DATA_DIR, "affiliations.json")).json() as Promise<{ affiliation_records: AffiliationRow[] }>,
    ]);
    return new Affiliations(orgs.org_records, affiliations.affiliation_records, seed);
  }

  of(person: number): readonly AffiliationRow[] {
    return this.byPerson.get(person) ?? [];
  }

  members(org: string): number {
    return this.orgSize.get(org) ?? 0;
  }

  membersOfUnit(org: string, unit: number): number {
    return this.units.get(`${org}#${unit}`)?.length ?? 0;
  }

  /**
   * Does this org meet on this day, and at what time?
   *
   * Keyed on the org and the week, never on the person. Two members asking the
   * same question get the same answer because they are drawing from the same
   * stream, which is what puts them in the room together — and it holds
   * without either of them knowing the other exists, which is what keeps the
   * whole simulation pass parallel.
   */
  occurrencesOn(org: string, date: Date, day: number): Occurrence[] {
    const record = this.orgs.get(org);
    const orgClass = record?.class ?? classOf(org);
    const cadence = CADENCE[orgClass];
    if (!cadence) return [];
    if (cadence.season && !inSeason(record?.subclass ?? null, date)) return [];

    const out: Occurrence[] = [];
    const dow = weekday(date);
    const week = Math.floor(day / 7);

    if (cadence.org > 0) {
      const meets = cadence.org >= 1 ? true : everyNthWeek(org, week, Math.round(1 / cadence.org));
      const rng = new Rng(mix(this.seed, hash(org), LAYER.calendar));
      const meetDay = orgClass === "worship" ? (SABBATH[record?.subclass ?? ""] ?? 6) : rng.int(0, 4);
      if (meets && dow === meetDay) {
        // A congregation with more than one service is how a big one fits;
        // splitting it is also what stops 900 people arriving at one minute.
        const services = orgClass === "worship" && (this.orgSize.get(org) ?? 0) > 450 ? 2 : 1;
        for (let i = 0; i < services; i += 1) {
          const start = orgClass === "worship" ? 9 * 60 + 30 + i * 120 : rng.pick([18 * 60 + 30, 19 * 60, 19 * 60 + 30]);
          out.push({ org, unit: null, class: orgClass, start, end: start + cadence.length, wholeOrg: true });
        }
      }
    }

    return out;
  }

  /** The unit-level gatherings — the small group, the team's training night. */
  unitOccurrencesOn(org: string, unit: number, date: Date, day: number): Occurrence[] {
    const record = this.orgs.get(org);
    const orgClass = record?.class ?? classOf(org);
    const cadence = CADENCE[orgClass];
    if (!cadence || cadence.unit <= 0) return [];
    if (cadence.season && !inSeason(record?.subclass ?? null, date)) return [];

    const rng = new Rng(mix(this.seed, hash(org), unit, LAYER.calendar));
    const perWeek = cadence.unit;
    const dow = weekday(date);
    const week = Math.floor(day / 7);

    // Which nights this unit uses, drawn once and kept. A team that trains on
    // Tuesdays trains on Tuesdays; redrawing it weekly is a team nobody could
    // be a member of.
    const nights: number[] = [];
    const wanted = Math.max(1, Math.round(perWeek));
    const pool = [0, 1, 2, 3, 4, 5, 6];
    const weights = [0.8, 1.4, 1.2, 1.4, 0.7, 1.0, 0.5];
    for (let i = 0; i < wanted; i += 1) {
      const pick = rng.weighted(pool, weights);
      const at = pool.indexOf(pick);
      pool.splice(at, 1);
      weights.splice(at, 1);
      nights.push(pick);
    }
    if (!nights.includes(dow)) return [];
    if (perWeek < 1 && !everyNthWeek(`${org}#${unit}`, week, Math.round(1 / perWeek))) return [];

    const start = rng.pick([18 * 60, 18 * 60 + 30, 19 * 60, 19 * 60 + 30, 20 * 60]);
    return [{ org, unit, class: orgClass, start, end: start + cadence.length, wholeOrg: false }];
  }

  /**
   * Everything this person could go to today, and whether they went.
   *
   * `free` is the roster's answer, passed in rather than recomputed: an
   * officer on the evening watch does not go to the Thursday lodge meeting, and
   * a layer that let them would be quietly inventing a person who is in two
   * places. This is also where the realised attendance rate falls below the
   * derived one, and the gap is the point — a congregation whose members work
   * shifts does not achieve the attendance a congregation of office workers
   * does, and that is a fact about the city rather than an error in the model.
   */
  dayFor(person: Person, date: Date, day: number, free: (start: number, end: number) => boolean): Attendance[] {
    const out: Attendance[] = [];

    for (const row of this.of(person.id)) {
      if (row.class === "work" || row.class === "school") continue;

      if (row.class === "gym") {
        const visit = this.gymVisit(person, row, date, day, free);
        if (visit) out.push(visit);
        continue;
      }

      // A congregation big enough to run two services is still one service per
      // member — the early crowd and the late crowd are different people, and
      // which one someone is is a fact about them that does not change weekly.
      // Attending both is not devotion, it is a bug, and it doubles the
      // building's occupancy while halving the chance two members meet.
      const gatherings = this.occurrencesOn(row.org, date, day);
      const service = gatherings.length > 1
        ? [gatherings[new Rng(mix(this.seed, person.id, LAYER.habit, hash(row.org), 2)).int(0, gatherings.length - 1)]!]
        : gatherings;

      const occurrences = [...service, ...this.unitOccurrencesOn(row.org, row.unit, date, day)];

      for (const occurrence of occurrences) {
        if (!free(occurrence.start - 20, occurrence.end + 20)) continue;
        const rng = stream(this.seed, person.id, LAYER.attendance, day, hash(row.org), occurrence.start);
        if (!rng.bool(attendanceFor(person, row, occurrence))) continue;

        // Arrival spread. Tight for a service that starts when it starts,
        // loose for a meeting people drift into. Fifteen minutes of spread on
        // four hundred people is still the sharpest arrival spike in the day.
        const spread = occurrence.wholeOrg ? 7 : 12;
        const arrive = Math.round(occurrence.start + rng.gauss(-4, spread));
        const leave = Math.round(occurrence.end + Math.abs(rng.gauss(6, 9)));
        out.push({ person: person.id, occurrence, arrive, leave });
      }
    }

    return out;
  }

  /**
   * A gym visit: no calendar, no unit, no meeting. Just a rate and a habit.
   *
   * The hour is a persistent trait rather than a nightly draw, which is what
   * makes the unit a time-of-day cohort rather than a label — someone who goes
   * before work goes before work, and the 6 a.m. crowd is the same faces.
   */
  private gymVisit(person: Person, row: AffiliationRow, date: Date, day: number, free: (a: number, b: number) => boolean): Attendance | null {
    const rng = stream(this.seed, person.id, LAYER.attendance, day, hash(row.org));
    if (!rng.bool(GYM_VISITS_PER_WEEK / 7)) return null;

    const habit = new Rng(mix(this.seed, person.id, LAYER.habit, hash(row.org)));
    // Early, lunchtime, or after work. The split is the shape of a gym's day.
    const slots = [6 * 60, 12 * 60, 17 * 60 + 30, 20 * 60];
    const weights = [0.26, 0.1, 0.44, 0.2];
    const preferred = habit.weighted(slots, weights);
    const length = Math.round(Math.max(30, rng.gauss(62, 18)));

    /**
     * If the usual hour is taken, go at another one — do not skip.
     *
     * This is where the gym differs from everything else in this file, and it
     * is the difference between a rate and a calendar. A service happens when
     * it happens and someone on shift misses it; the gym is open fourteen
     * hours and somebody who meant to go at six and could not goes at eight.
     * Dropping the visit instead cost about a third of them and pulled the
     * simulated exposure well under the target for no reason but the
     * scheduler's convenience.
     */
    for (const slot of [preferred, ...slots.filter((s) => s !== preferred)]) {
      const start = Math.round(slot + rng.gauss(0, 28));
      if (!free(start, start + length)) continue;
      const occurrence: Occurrence = { org: row.org, unit: row.unit, class: "gym", start, end: start + length, wholeOrg: false };
      return { person: person.id, occurrence, arrive: start, leave: start + length };
    }
    return null;
  }
}

/**
 * Whether this member turns up, given the chance.
 *
 * The base rate is what the exposure target implies. Three things move it, and
 * all three are already in the data rather than invented here:
 *
 *   tenure    `since` is on every row. Someone who joined nineteen years ago
 *             is not the same member as someone who joined last spring, and
 *             the attrition that makes a lapsed member is most of why an org
 *             of four hundred has a hundred and fifty in the room.
 *   role      `affiliations.py` marks leaders. A leader is there when it is
 *             on, near enough always — that is what the role means.
 *   age       Attendance at everything is U-shaped in age for the young and
 *             rising in age for worship, and flattening that would lose the
 *             one demographic signal these logs would obviously carry.
 */
function attendanceFor(person: Person, row: AffiliationRow, occurrence: Occurrence): number {
  let p = impliedAttendance(row.class);

  const tenure = Math.max(0, 2026 - row.since);
  p *= 0.86 + 0.14 * Math.min(1, tenure / 8);

  if (row.role !== "member") p = Math.min(0.97, p * 1.28);

  if (row.class === "worship") {
    // Older congregants attend more, and the difference between 25 and 70 is
    // large enough that averaging it away would be visible in the arrivals.
    p *= person.age >= 65 ? 1.16 : person.age >= 45 ? 1.04 : person.age >= 30 ? 0.94 : 0.82;
  }

  // A midweek small group is a harder ask than the principal service, and the
  // people who go to it are a subset rather than a sample.
  if (!occurrence.wholeOrg && row.class === "worship") p *= 0.72;

  return Math.max(0.02, Math.min(0.99, p));
}

/** Deterministic "does this org meet in week w", for cadences under weekly. */
function everyNthWeek(key: string, week: number, n: number): boolean {
  if (n <= 1) return true;
  return ((week % n) + n) % n === ((hash(key) % n) + n) % n;
}

function inSeason(subclass: string | null, date: Date): boolean {
  const range = SEASONS[subclass ?? "multi"] ?? SEASONS.multi!;
  const month = date.getMonth() + 1;
  const [from, to] = range;
  // A winter sport wraps the year end, which is why this is not `>= && <=`.
  return from <= to ? month >= from && month <= to : month >= from || month <= to;
}

function classOf(org: string): OrgClass {
  return org.startsWith("u:") ? "union" : "civic";
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export { CADENCE, GYM_VISITS_PER_WEEK, hash as hashOrg };

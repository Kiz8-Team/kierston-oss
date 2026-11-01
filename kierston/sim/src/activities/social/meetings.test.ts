/**
 * The properties a shared activity has to have to be worth anything.
 *
 * All of them are about agreement between two days that were planned
 * separately, because that is the only hard part. A meeting one person went to
 * and the other did not is worse than no meeting at all: it is a co-presence
 * record that contradicts itself, and every task in the benchmark that reasons
 * about who was with whom would be scored against it.
 *
 * Run against the real city rather than a fixture for the same reason the
 * attention and radio tests are. The claims are claims about a population —
 * that nobody is in two places, that every party to a gathering believes in
 * it, that the driver of a car is not also in the back of it — and a hand-built
 * pair can only show that the code does what it was written to do.
 */

import { describe, expect, test } from "bun:test";
import { meetingsFor, type Meeting } from "./meetings.ts";
import { loadDayContext } from "../../engine/index.ts";
import { dayNumber, parseDate } from "../../shared/index.ts";
import { drives, modeOf } from "../../transport/index.ts";
import { simDataPresent } from "../../world/index.ts";

/** Skipped, not failed, on a checkout without a built city. */
const CITY = simDataPresent();
const context = CITY ? await loadDayContext() : (null as unknown as Awaited<ReturnType<typeof loadDayContext>>);

/** A Saturday, because that is where the meetings are. */
const DATE = parseDate("2026-08-22");
const DAY = dayNumber(DATE);

const input = {
  world: context?.world,
  graph: context?.ties,
  venues: context?.venues,
  affiliations: context?.affiliations,
  date: DATE,
  day: DAY,
};

/**
 * Every hundredth person. Small enough to run in a test and large enough that
 * the counterpart lookups reach right across the city — which is the point,
 * since a sample's counterparts are almost never in the sample.
 */
const sample = !CITY ? [] : [...context.world.persons.values()].filter((person) => person.id % 101 === 0);
const held = sample.map((person) => ({ person, meetings: meetingsFor(input, person) }));
const all = held.flatMap((row) => row.meetings);

/**
 * One derivation per person, shared by every test below.
 *
 * Deriving a counterpart's day is the expensive call here — it walks their
 * whole contact list — and several of these tests want the same counterpart.
 * Memoising it is not a shortcut around the property being tested: the claim
 * is that any two callers get the same answer, and the determinism test
 * upholds that separately against uncached calls.
 */
const derived = new Map<number, Meeting[]>();
function meetingsOf(person: number): Meeting[] {
  const cached = derived.get(person);
  if (cached) return cached;
  const other = context.world.persons.get(person)!;
  const fresh = meetingsFor(input, other);
  derived.set(person, fresh);
  return fresh;
}

describe.skipIf(!CITY)("meetings", () => {
  test("the sample produces some, or there is nothing to check", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  test("every party to a gathering also holds it", () => {
    for (const meeting of all) {
      for (const party of meeting.parties) {
        expect(context.world.persons.get(party)).toBeDefined();
        expect(meetingsOf(party).map((one) => one.id)).toContain(meeting.id);
      }
    }
  });

  test("both sides derive the identical gathering, not merely one with the same id", () => {
    for (const meeting of all) {
      for (const party of meeting.parties) {
        const mirror = meetingsOf(party).find((one) => one.id === meeting.id)!;
        expect(mirror.start).toBe(meeting.start);
        expect(mirror.end).toBe(meeting.end);
        expect(mirror.venue.id).toBe(meeting.venue.id);
        expect(mirror.purpose).toBe(meeting.purpose);
        expect(mirror.payer).toBe(meeting.payer);
        expect(mirror.parties).toEqual(meeting.parties);
        expect(mirror.ride).toEqual(meeting.ride);
      }
    }
  });

  test("nobody is in two places", () => {
    for (const { meetings } of held) {
      const ordered = [...meetings].sort((a, b) => a.start - b.start);
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i]!.start).toBeGreaterThanOrEqual(ordered[i - 1]!.end);
      }
    }
  });

  test("a gathering has at least two people, in id order, and lasts a while", () => {
    for (const meeting of all) {
      expect(meeting.parties.length).toBeGreaterThanOrEqual(2);
      expect([...meeting.parties].sort((a, b) => a - b)).toEqual([...meeting.parties]);
      expect(new Set(meeting.parties).size).toBe(meeting.parties.length);
      expect(meeting.end).toBeGreaterThan(meeting.start);
    }
  });

  test("whoever is at the wheel could actually be at the wheel", () => {
    for (const meeting of all) {
      if (!meeting.ride) continue;
      const driver = context.world.persons.get(meeting.ride.driver)!;
      expect(meeting.parties).toContain(driver.id);
      expect(drives(context.world, driver)).toBe(true);
      // A lift is a `passenger` leg on the rider, which `travel.ts` prices over
      // the road graph. A driver the mobility layer would have walked produces
      // a passenger in a car nobody drove — see `atTheWheel`.
      expect(["car", "carpool"]).toContain(modeOf(driver));
      expect(meeting.ride.riders).not.toContain(driver.id);
      for (const rider of meeting.ride.riders) expect(meeting.parties).toContain(rider);
    }
  });

  test("whoever paid was there", () => {
    for (const meeting of all) {
      if (meeting.payer === null) continue;
      expect(meeting.parties).toContain(meeting.payer);
    }
  });

  test("a household outing is one household; a hosted gathering is several", () => {
    for (const meeting of all) {
      const households = new Set(
        meeting.parties.map((id) => context.world.persons.get(id)?.household),
      );
      if (meeting.kind === "household") {
        expect(households.size).toBe(1);
        continue;
      }
      // More than one address, and never the convener's twice: a couple can be
      // invited together, so guests may share a household with each other.
      expect(households.size).toBeGreaterThan(1);
      const host = context.world.persons.get(meeting.host!)!;
      const guests = meeting.parties.filter((id) => id !== host.id);
      for (const guest of guests) {
        expect(context.world.persons.get(guest)!.household).not.toBe(host.household);
      }
    }
  });

  test("a hosted gathering names a convener who is at it", () => {
    for (const meeting of all) {
      if (meeting.kind === "household") {
        expect(meeting.host).toBeNull();
        continue;
      }
      expect(meeting.host).not.toBeNull();
      expect(meeting.parties).toContain(meeting.host!);
    }
  });

  test("some gathering has more than two people who do not live together", () => {
    // The whole point of keying on a convener rather than on a pair. A run
    // where this fails has silently fallen back to pairs.
    const groups = all.filter(
      (meeting) => meeting.kind !== "household" && meeting.parties.length > 2,
    );
    expect(groups.length).toBeGreaterThan(0);
  });

  test("the same call twice gives the same day", () => {
    for (const { person, meetings } of held) {
      expect(meetingsFor(input, person)).toEqual(meetings);
    }
  });

  test("a different date gives a different set, so nothing is date-blind", () => {
    const other = parseDate("2026-08-19");
    const otherInput = { ...input, date: other, day: dayNumber(other) };
    const ids = new Set(all.map((meeting) => meeting.id));
    const midweek = sample.flatMap((person) => meetingsFor(otherInput, person));
    expect(midweek.some((meeting) => !ids.has(meeting.id))).toBe(true);
  });
});

describe.skipIf(!CITY)("the shape of the week", () => {
  const countOn = (iso: string): number => {
    const date = parseDate(iso);
    const on = { ...input, date, day: dayNumber(date) };
    return sample.reduce((total, person) => total + meetingsFor(on, person).length, 0);
  };

  test("a Saturday holds more arrangements than a Tuesday", () => {
    // Not a tuning assertion — the ratio is left loose. What it guards is
    // DAY_SHAPE being indexed the way `weekday` numbers the week, which is
    // Monday-first and was wrong the first time it was written.
    expect(countOn("2026-08-22")).toBeGreaterThan(countOn("2026-08-18"));
  });
});

/** Meetings are exported to a viewer, so the fields it reads must be present. */
describe.skipIf(!CITY)("what the export reads", () => {
  test("every gathering names a venue with an id and a position", () => {
    for (const meeting of all satisfies Meeting[]) {
      expect(meeting.venue.id).toBeTruthy();
      expect(Number.isFinite(meeting.venue.lat)).toBe(true);
      expect(Number.isFinite(meeting.venue.lon)).toBe(true);
    }
  });
});

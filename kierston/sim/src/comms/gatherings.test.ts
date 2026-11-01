/**
 * What the communications layer is allowed to believe about who was together.
 *
 * A unit test against hand-built timelines rather than against the city, and
 * deliberately so: every claim here is about the bookkeeping — that attendance
 * is read from the timeline the planner produced and not from the meeting the
 * layer drew, that a party who never arrived is counted as absent, that a
 * driver's kerbside stop is not mistaken for a table. None of those is a claim
 * about a population, and a city would only make them slower to check.
 *
 * The claims that *are* about a population — how much traffic this suppresses,
 * how much it adds — are measured against a full export instead, because a
 * sample's counterparts are almost never in the sample.
 */

import { describe, expect, test } from "bun:test";
import { Gatherings } from "./gatherings.ts";
import type { Meeting } from "../activities/social/index.ts";
import type { Day } from "../scheduler/index.ts";

function meeting(id: string, parties: number[], start: number, end: number, host: number | null): Meeting {
  return {
    id, purpose: "food-sit", start, end, parties, kind: host === null ? "household" : "hosted", host,
    ride: null, payer: null,
    venue: { id: "v1", lat: 40.6, lon: -75.5, name: "", tag: "amenity=restaurant", purposes: [], pull: 1, mcc: null, opens: 0, closes: 1440,
      estimated: false, chain: null } as unknown as Meeting["venue"],
  };
}

/**
 * The smallest thing `observe` will read: it looks at one field of the day and
 * nothing else, so a whole planned day would be scaffolding around one array.
 */
function dayWith(events: { kind: string; payload: unknown }[]): Day {
  return { scheduled: { timeline: events } } as unknown as Day;
}

const stay = (m: Meeting) => ({ kind: "stay", payload: { kind: "meet", meeting: m, label: "", where: m.venue.id } });
const kerb = (m: Meeting) => ({ kind: "stay", payload: { kind: "meet", meeting: m, label: "collecting", where: null } });

describe("gatherings", () => {
  test("a party is whoever's timeline actually holds the stay", () => {
    const m = meeting("meet/1/100", [1, 2, 3], 1140, 1235, 1);
    const g = new Gatherings();
    g.observe(dayWith([stay(m)]), 1);
    g.observe(dayWith([stay(m)]), 2);
    // Person 3 was drawn into it and the planner could not deliver them.
    g.observe(dayWith([]), 3);
    g.seal();

    const [held] = g.all();
    expect(held!.attendees).toEqual([1, 2]);
    expect(held!.absent).toEqual([3]);
  });

  test("a driver's kerbside stop is not a table", () => {
    // Same payload kind, no venue. Counting it would make a driver co-present
    // with their passenger at the passenger's own front door, which is true
    // for two minutes and false for the purpose this table is read for.
    const m = meeting("meet/4/100", [4, 5], 1140, 1235, 4);
    const g = new Gatherings();
    g.observe(dayWith([kerb(m)]), 4);
    g.observe(dayWith([stay(m)]), 5);
    g.seal();
    expect(g.all()).toEqual([]);
  });

  test("co-presence is symmetric, bounded by the hour, and specific to the pair", () => {
    const m = meeting("meet/1/100", [1, 2], 1140, 1235, 1);
    const g = new Gatherings();
    g.observe(dayWith([stay(m)]), 1);
    g.observe(dayWith([stay(m)]), 2);
    g.seal();

    expect(g.together(1, 2, 1200)).toBe(true);
    expect(g.together(2, 1, 1200)).toBe(true);
    expect(g.together(1, 2, 1139)).toBe(false);
    // Half-open: the minute the gathering ends, they have left.
    expect(g.together(1, 2, 1235)).toBe(false);
    expect(g.together(1, 9, 1200)).toBe(false);
  });

  test("everybody at a table of four is with everybody else, and not with themselves", () => {
    const m = meeting("meet/1/100", [1, 2, 3, 4], 600, 700, 1);
    const g = new Gatherings();
    for (const person of [1, 2, 3, 4]) g.observe(dayWith([stay(m)]), person);
    g.seal();

    for (const a of [1, 2, 3, 4]) {
      expect(g.together(a, a, 650)).toBe(false);
      for (const b of [1, 2, 3, 4]) {
        if (a !== b) expect(g.together(a, b, 650)).toBe(true);
      }
    }
  });

  test("a gathering only one person reached is not co-presence at all", () => {
    const m = meeting("meet/1/100", [1, 2], 600, 700, 1);
    const g = new Gatherings();
    g.observe(dayWith([stay(m)]), 1);
    g.seal();
    expect(g.all()).toEqual([]);
    expect(g.together(1, 2, 650)).toBe(false);
  });

  test("a person at two gatherings is co-present at each, with the right people", () => {
    const lunch = meeting("meet/1/100", [1, 2], 720, 780, 1);
    const dinner = meeting("meet/3/100", [1, 3], 1140, 1235, 3);
    const g = new Gatherings();
    g.observe(dayWith([stay(lunch), stay(dinner)]), 1);
    g.observe(dayWith([stay(lunch)]), 2);
    g.observe(dayWith([stay(dinner)]), 3);
    g.seal();

    expect(g.together(1, 2, 750)).toBe(true);
    expect(g.together(1, 3, 750)).toBe(false);
    expect(g.together(1, 3, 1200)).toBe(true);
    expect(g.together(1, 2, 1200)).toBe(false);
  });

  test("reset clears both the roll and the windows", () => {
    const m = meeting("meet/1/100", [1, 2], 600, 700, 1);
    const g = new Gatherings();
    g.observe(dayWith([stay(m)]), 1);
    g.observe(dayWith([stay(m)]), 2);
    g.seal();
    g.reset();
    expect(g.size).toBe(0);
    expect(g.all()).toEqual([]);
    expect(g.together(1, 2, 650)).toBe(false);
  });
});

/**
 * The properties the attention curve is supposed to have.
 *
 * Run against real planned days rather than a fixture, for the same reason the
 * radio and banking tests are: the claims worth checking are claims about the
 * whole city — that a night worker's reachable hours are nocturnal, that the
 * occupational spread survives into the daytime, that nobody is reachable
 * while asleep — and a hand-built day can only show that the code does what it
 * was written to do.
 *
 * The determinism test earns its place the same way it does in `attach.test`.
 * Every draw here is keyed on identity, and the point of that discipline is
 * that a layer added next month cannot silently rewrite the curves this month
 * already produced.
 */

import { describe, expect, test } from "bun:test";
import { attentionAt, attentionCurve, ATTENTION_SCALE, MINUTES, nextGlance } from "./index.ts";
import { loadDayContext } from "../engine/index.ts";
import { planDay } from "../scheduler/index.ts";
import { dayNumber, parseDate } from "../shared/index.ts";
import { simDataPresent } from "../world/index.ts";

/** Skipped, not failed, on a checkout without a built city. */
const CITY = simDataPresent();
const context = CITY ? await loadDayContext() : (null as unknown as Awaited<ReturnType<typeof loadDayContext>>);
const DATE = parseDate("2026-07-28");
const DAY = dayNumber(DATE);
const SEED = CITY ? context.world.seed : 0;

const occupationOf = (person: number) => context.world.assignments.get(person)?.occupation ?? null;

/** A sample big enough for the aggregates and small enough to plan in a test. */
const sample = !CITY ? [] : [...context.world.persons.values()].filter((person) => person.id % 97 === 0);

function curveFor(person: (typeof sample)[number]) {
  return attentionCurve(planDay(context, person, DATE, DAY), person, occupationOf(person.id), SEED, DAY);
}

const curves = sample.map((person) => ({ person, attention: curveFor(person) }));

describe.skipIf(!CITY)("attention curve", () => {
  test("every planned day yields a curve of exactly one day", () => {
    for (const { attention } of curves) {
      if (!attention.known) continue;
      expect(attention.minute.length).toBe(MINUTES);
    }
  });

  test("nobody is certain to look at their phone, and nobody is beyond reach all day", () => {
    for (const { attention } of curves) {
      if (!attention.known) continue;
      let peak = 0;
      for (const value of attention.minute) peak = Math.max(peak, value);
      expect(peak).toBeLessThan(ATTENTION_SCALE);
      expect(peak).toBeGreaterThan(0);
    }
  });

  test("sleep is the least attentive state of anybody's day", () => {
    // Read off the plan rather than the clock: the claim is that the curve
    // tracks the planner's own bouts, which for a night worker are at noon.
    let checked = 0;
    for (const { person, attention } of curves) {
      if (!attention.known) continue;
      const planned = planDay(context, person, DATE, DAY);
      const asleep: number[] = [];
      for (const event of planned.scheduled.timeline) {
        if (event.kind === "stay" && event.source === "sleep") {
          // Clamped at both ends: a bout carried over from the previous date
          // starts before midnight, and one running into the next ends after
          // it. Both are ordinary and both index outside the array.
          const from = Math.max(0, Math.floor(event.start));
          const to = Math.min(MINUTES, Math.ceil(event.end));
          for (let minute = from; minute < to; minute += 1) asleep.push(minute);
        }
      }
      if (asleep.length === 0) continue;
      checked += 1;
      // Means rather than extremes. A hands-busy worker's quietest waking
      // minute quantises to the same byte as a sleeping one — the curve has
      // 255 levels and both states are near the floor — so an assertion on
      // the maximum is testing rounding, not the model. What the model
      // actually claims is that the night is an order of magnitude quieter
      // than the day, and that is a claim about averages.
      const asleepSet = new Set(asleep);
      let night = 0;
      let waking = 0;
      let wakingMinutes = 0;
      for (let minute = 0; minute < MINUTES; minute += 1) {
        if (asleepSet.has(minute)) night += attention.minute[minute]!;
        else {
          waking += attention.minute[minute]!;
          wakingMinutes += 1;
        }
      }
      if (wakingMinutes === 0) continue;
      expect(night / asleep.length).toBeLessThan(waking / wakingMinutes);
    }
    expect(checked).toBeGreaterThan(sample.length / 4);
  });

  test("a desk worker is reachable at work and a machinist is not", () => {
    // The single claim the occupation table exists to make. Compared as a
    // ratio of daytime means rather than absolutely, because temperament
    // varies within both groups and only the gap between them is asserted.
    const daytime = (attention: ReturnType<typeof curveFor>) => {
      let total = 0;
      for (let minute = 9 * 60; minute < 16 * 60; minute += 1) total += attention.minute[minute]!;
      return total / (7 * 60);
    };
    const inRange = (person: number, low: number, high: number) => {
      const code = Number.parseInt(occupationOf(person) ?? "", 10);
      return Number.isFinite(code) && code >= low && code < high;
    };
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

    const desk = curves.filter(({ person, attention }) => attention.known && inRange(person.id, 500, 1300));
    const production = curves.filter(({ person, attention }) => attention.known && inRange(person.id, 7700, 9000));
    expect(desk.length).toBeGreaterThan(3);
    expect(production.length).toBeGreaterThan(3);
    expect(mean(desk.map(({ attention }) => daytime(attention))))
      .toBeGreaterThan(mean(production.map(({ attention }) => daytime(attention))) * 1.5);
  });

  test("the same day produces the same curve twice", () => {
    for (const { person, attention } of curves.slice(0, 40)) {
      expect([...curveFor(person).minute]).toEqual([...attention.minute]);
    }
  });
});

describe.skipIf(!CITY)("reply latency", () => {
  test("a glance never precedes the message that prompted it", () => {
    for (const { person, attention } of curves) {
      if (!attention.known) continue;
      for (const second of [0, 8 * 3600, 13 * 3600 + 17, 21 * 3600]) {
        const at = nextGlance(attention, second, SEED, person.id, DAY, second);
        if (at >= 0) expect(at).toBeGreaterThanOrEqual(second);
      }
    }
  });

  test("a message sent while asleep waits hours; one sent at home waits minutes", () => {
    // Not asserted per person — an individual can be atypical either way — but
    // across the sample the two must separate, because that separation is the
    // entire reason the layer reads the day plan at all.
    const waits = (second: number) => {
      const found: number[] = [];
      for (const { person, attention } of curves) {
        if (!attention.known) continue;
        const at = nextGlance(attention, second, SEED, person.id, DAY, second);
        if (at >= 0) found.push(at - second);
      }
      return found.reduce((a, b) => a + b, 0) / Math.max(found.length, 1);
    };
    expect(waits(3 * 3600)).toBeGreaterThan(waits(19 * 3600) * 5);
  });

  test("attention outside the day reads as unreachable", () => {
    const { attention } = curves.find(({ attention }) => attention.known)!;
    expect(attentionAt(attention, -1)).toBe(0);
    expect(attentionAt(attention, MINUTES)).toBe(0);
  });
});

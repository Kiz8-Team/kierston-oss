/**
 * The invariants the radio layer is supposed to guarantee.
 *
 * These run against the real towers.json and devices.json rather than a
 * fixture, for the same reason the banking tests run against the real
 * holdings: the properties worth checking are properties of the whole network
 * — that the span table tiles the day exactly, that a handset never appears on
 * spectrum its radio cannot receive, that a stationary phone does not thrash —
 * and a hand-built fixture can only demonstrate that the code does what it was
 * written to do.
 *
 * The determinism test is the one that would catch the most damaging class of
 * regression. Every draw in here is keyed on identity rather than drawn from a
 * walked generator, and the whole point of that discipline is that adding a
 * layer next month cannot silently rewrite the days this month already
 * produced. A test that only checked the records were plausible would not
 * notice the day they quietly became different plausible records.
 */

import { describe, expect, test } from "bun:test";
import {
  Cells, INDOOR, LTE_ONLY, MINUTES, OUTDOOR, RSRP_FLOOR, Subscribers,
  EVENT_CAUSES, EVENT_KINDS, UNATTACHED, attachDay, emptyDayNetwork, radioTier, type Track,
} from "./index.ts";
import { simDataPresent } from "../world/index.ts";

/** Skipped, not failed, on a checkout without a built city. */
const CITY = simDataPresent("population.json", "towers.json", "buildings.json", "devices.json", "accounts.json");
const cells = CITY ? await Cells.open() : (null as unknown as Cells);
const subscribers = CITY ? await Subscribers.open() : (null as unknown as Subscribers);
const SEED = 20260728;
const DAY = 20663;

/** A handset that never moves, at the city centre. */
function stationary(): Track {
  const at = cells.project(cells.centre[0], cells.centre[1]);
  return {
    x: new Float64Array(MINUTES).fill(at.x),
    y: new Float64Array(MINUTES).fill(at.y),
    exposure: new Uint8Array(MINUTES).fill(INDOOR),
    asleep: new Uint8Array(MINUTES),
    known: true,
  };
}

/** A handset carried straight across the city over the working day. */
function crossing(): Track {
  const track = stationary();
  const from = cells.project(cells.centre[0] - 0.04, cells.centre[1] - 0.05);
  const to = cells.project(cells.centre[0] + 0.04, cells.centre[1] + 0.05);
  for (let minute = 0; minute < MINUTES; minute += 1) {
    const t = minute / (MINUTES - 1);
    track.x[minute] = from.x + (to.x - from.x) * t;
    track.y[minute] = from.y + (to.y - from.y) * t;
    track.exposure[minute] = OUTDOOR;
  }
  return track;
}

function run(subscriber: number, track: Track) {
  const out = emptyDayNetwork();
  attachDay(cells, subscribers.all[subscriber]!, track, null, SEED, DAY, out);
  return out;
}

describe.skipIf(!CITY)("the span table", () => {
  test("explicit communication sessions drive the existing connected-state machine", () => {
    const baseline = run(0, stationary());
    const active = emptyDayNetwork();
    attachDay(cells, subscribers.all[0]!, stationary(), null, SEED, DAY, active, null, new Uint8Array(MINUTES).fill(1));
    const connected = (day: typeof active) => day.spans.reduce((sum, span) => sum + span.connected, 0);
    expect(connected(active)).toBeGreaterThan(connected(baseline));
    expect(active.spans[0]!.start).toBe(0);
    expect(active.spans.at(-1)!.end).toBe(MINUTES);
  });
  test("tiles the whole day with no gap and no overlap", () => {
    for (const index of [0, 1, 500, 5000, 40000]) {
      const { spans } = run(index, stationary());
      expect(spans[0]!.start).toBe(0);
      expect(spans[spans.length - 1]!.end).toBe(MINUTES);
      for (let i = 1; i < spans.length; i += 1) {
        expect(spans[i]!.start).toBe(spans[i - 1]!.end);
      }
    }
  });

  test("never repeats a cell across a boundary", () => {
    // Two adjacent spans on the same cell would mean a span was closed for no
    // reason, which is how a double-counted handover would show up.
    const { spans } = run(7, crossing());
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.cell).not.toBe(spans[i - 1]!.cell);
    }
  });

  test("reports a level no weaker than a handset could demodulate", () => {
    const { spans } = run(11, crossing());
    for (const span of spans) {
      if (span.cell === UNATTACHED) continue;
      expect(span.rsrp).toBeGreaterThan(RSRP_FLOOR - 1);
      expect(span.rsrp).toBeLessThan(-40);
    }
  });
});

describe.skipIf(!CITY)("what a handset is allowed on", () => {
  test("an LTE-only radio never appears on an NR cell", () => {
    const lteOnly = subscribers.all.filter((row) => row.tier === LTE_ONLY);
    expect(lteOnly.length).toBeGreaterThan(0);
    for (const subscriber of lteOnly.slice(0, 40)) {
      const { spans } = run(subscriber.index, crossing());
      for (const span of spans) {
        if (span.cell === UNATTACHED) continue;
        expect(cells.records[span.cell]!.radio).toBe("LTE");
      }
    }
  });

  test("a handset is on its own network or its declared roaming partner", () => {
    for (const subscriber of subscribers.all.slice(0, 200)) {
      const { spans } = run(subscriber.index, crossing());
      for (const span of spans) {
        if (span.cell === UNATTACHED) continue;
        const operator = cells.operatorOf(span.cell);
        if (operator === subscriber.operator) continue;
        expect(operator).toBe(subscriber.roaming);
      }
    }
  });

  test("radio capability follows the model year, not the price", () => {
    expect(radioTier(2017, "flagship")).toBe(LTE_ONLY);
    expect(radioTier(2019, "budget")).toBe(LTE_ONLY);
    expect(radioTier(2020, "flagship")).toBeGreaterThan(LTE_ONLY);
    // C-band came to the top of the range two years before the bottom of it.
    expect(radioTier(2021, "budget")).toBeLessThan(radioTier(2021, "flagship"));
  });
});

describe.skipIf(!CITY)("hysteresis", () => {
  test("a phone that does not move holds its cell for hours", () => {
    // The failure this catches is the one a naive strongest-cell rule
    // produces: hundreds of changes a night from a handset on a bedside table.
    let changes = 0;
    const people = 60;
    for (let index = 0; index < people; index += 1) {
      changes += run(index, stationary()).spans.filter((span) => span.cell !== UNATTACHED).length;
    }
    expect(changes / people).toBeLessThan(20);
  });

  test("a phone crossing the city changes cell far more often than one that stays put", () => {
    let moving = 0;
    let still = 0;
    for (let index = 0; index < 60; index += 1) {
      moving += run(index, crossing()).spans.length;
      still += run(index, stationary()).spans.length;
    }
    expect(moving).toBeGreaterThan(still * 2);
  });
});

describe.skipIf(!CITY)("determinism", () => {
  test("a warm day continues the serving cell without a fictional midnight attach", () => {
    let picked = null;
    for (let index = 0; index < 100 && !picked; index += 1) {
      const first = emptyDayNetwork();
      const closing = attachDay(cells, subscribers.all[index]!, stationary(), null, SEED, DAY, first);
      if (closing.attached) picked = { index, closing };
    }
    expect(picked).not.toBeNull();
    const second = emptyDayNetwork();
    attachDay(
      cells, subscribers.all[picked!.index]!, stationary(), null, SEED, DAY + 1, second, picked!.closing,
    );
    expect(second.spans[0]!.cell).toBe(picked!.closing.serving);
    expect(second.events.some((event) =>
      event.minute === 0 && event.kind === EVENT_KINDS.indexOf("attach")
      && event.cause === EVENT_CAUSES.indexOf("day-start"),
    )).toBeFalse();
  });

  test("the same subscriber and date produce the same day twice", () => {
    const first = run(3, crossing());
    const second = run(3, crossing());
    expect(second.spans).toEqual(first.spans);
    expect(second.events).toEqual(first.events);
  });

  test("a different date is a different day", () => {
    const out = emptyDayNetwork();
    attachDay(cells, subscribers.all[3]!, crossing(), null, SEED, DAY + 1, out);
    const same = run(3, crossing());
    // The route is identical, so the cells are; what the date moves is the
    // handset's own availability and its bearer activity.
    expect(out.events).not.toEqual(same.events);
  });
});

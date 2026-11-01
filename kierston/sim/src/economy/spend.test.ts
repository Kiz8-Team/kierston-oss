/**
 * What the spending layer promises about a day it has priced.
 *
 * Built against stub days rather than planned ones. That is the opposite of
 * the choice `bank.test.ts` makes, and for the opposite reason: the bank's
 * invariants are properties of the whole city's records, while these are
 * properties of the pricing rules — that a basket is paid for at the till and
 * not at the door, that ten times the income does not buy ten times the
 * groceries — and each of those is clearest when the day around it is two
 * lines long. Planning a real day to test them would mean loading the road
 * graph to find out what time somebody left a shop.
 */

import { describe, expect, test } from "bun:test";
import { Bank } from "./banking/index.ts";
import type { Household, Person, World } from "../world/index.ts";
import { simDataPresent } from "../world/index.ts";

/** The bank tests read the built city's holdings; skipped, not failed, without one. */
const CITY = simDataPresent("holdings.bin");
import { chargesFor, settleDay, REFERENCE_INCOME, TICKETS } from "./spend.ts";
import type { Day } from "../scheduler/index.ts";
import type { Leg } from "../transport/index.ts";
import type { Purpose, Venue, Venues } from "../activities/discretionary/index.ts";
import type { Meeting } from "../activities/social/index.ts";

const SEED = 20260728;

function venue(id: string, tag: string, mcc: number | null, purposes: Purpose[]): Venue {
  return {
    id, lat: 40.6, lon: -75.47, name: `Test ${tag}`, tag, purposes,
    pull: 1, estimated: true, chain: null, opens: 0, closes: 1440, mcc,
  };
}

function context(venues: Venue[], income = REFERENCE_INCOME, size = 1) {
  const byId = new Map(venues.map((v) => [v.id, v]));
  const household: Household = { id: 1, size, income, dwelling: null };
  return {
    world: {
      seed: SEED,
      households: new Map([[1, household]]),
    } as unknown as World,
    venues: { get: (id: string) => byId.get(id) } as unknown as Venues,
  };
}

function person(id = 1, age = 40): Person {
  return {
    id, household: 1, age, sex: 1, employment: 1, occupation: null, hours: 40,
    depart: null, arrive: null, travel: null, transport: "1",
    enrolled: null, grade: null,
  };
}

/** A day holding one stay at one venue, and nothing else. */
function stopDay(id: string, purpose: Purpose, start: number, end: number, legs: Leg[] = []): Day {
  return {
    person: 1,
    scheduled: {
      person: 1,
      timeline: [{
        kind: "stay",
        activityId: `stop/1/0/${purpose}/${id}/0`,
        source: "stop",
        place: { lat: 40.6, lon: -75.47, id, kind: "venue", label: "Test" },
        start, end,
        policy: "optional",
        payload: { kind: "stop", purpose, label: purpose, where: id },
      }],
      rejected: [],
      lateMinutes: 0,
      metrics: { trips: 0, drivenKm: 0, walkedKm: 0, rejected: 0 },
    },
    blocks: [], tours: [], legs, attendance: [],
    plan: { person: 1, stops: [], trips: 0, extraKm: 0 },
    drivenKm: 0, walkedKm: 0, cabKm: { loaded: 0, empty: 0 }, trips: 0, late: 0,
  } as unknown as Day;
}

/** The median of many days of the same shape, which is what a ticket quotes. */
function medianAmount(purpose: Purpose, mcc: number, income: number, size = 1): number {
  const shop = venue("v:way/1", "shop=supermarket", mcc, [purpose]);
  const amounts: number[] = [];
  for (let day = 0; day < 400; day += 1) {
    const charges = chargesFor(
      context([shop], income, size), person(), stopDay("v:way/1", purpose, 600, 660), day);
    for (const charge of charges) amounts.push(charge.amount);
  }
  amounts.sort((a, b) => a - b);
  return amounts[Math.floor(amounts.length / 2)]!;
}

describe("when the money moves", () => {
  test("a basket is paid for on the way out, not on the way in", () => {
    const shop = venue("v:way/1", "shop=supermarket", 5411, ["grocery"]);
    for (let day = 0; day < 200; day += 1) {
      const [charge] = chargesFor(context([shop]), person(), stopDay("v:way/1", "grocery", 600, 660), day);
      if (!charge) continue;
      expect(charge._timestamp).toBeGreaterThan(650);
      expect(charge._timestamp).toBeLessThanOrEqual(660);
    }
  });

  test("a coffee is paid for at the counter on arrival", () => {
    const cafe = venue("v:node/2", "amenity=cafe", 5814, ["cafe"]);
    for (let day = 0; day < 200; day += 1) {
      const [charge] = chargesFor(context([cafe]), person(), stopDay("v:node/2", "cafe", 480, 505), day);
      if (!charge) continue;
      expect(charge._timestamp).toBeGreaterThanOrEqual(480);
      expect(charge._timestamp).toBeLessThanOrEqual(485);
    }
  });

  test("a payment never falls outside the stay it belongs to, however short", () => {
    const shop = venue("v:way/3", "shop=convenience", 5499, ["convenience"]);
    // Four minutes, which is shorter than the offset any settlement rule draws.
    for (let day = 0; day < 300; day += 1) {
      for (const charge of chargesFor(
        context([shop]), person(), stopDay("v:way/3", "convenience", 700, 704), day)) {
        expect(charge._timestamp).toBeGreaterThanOrEqual(700);
        expect(charge._timestamp).toBeLessThanOrEqual(704);
      }
    }
  });

  test("an evening at a bar is bought in rounds, spread across it", () => {
    const bar = venue("v:way/4", "amenity=bar", 5813, ["bar"]);
    const charges = chargesFor(
      context([bar]), person(), stopDay("v:way/4", "bar", 20 * 60, 20 * 60 + 150), 11);
    expect(charges.length).toBeGreaterThan(1);
    expect(charges.length).toBeLessThanOrEqual(4);
    for (const charge of charges) {
      expect(charge._timestamp).toBeGreaterThanOrEqual(20 * 60);
      expect(charge._timestamp).toBeLessThanOrEqual(20 * 60 + 150);
    }
    // Distinct minutes: a round bought at the same minute as the last one is
    // one purchase split in two, which is not what this models.
    expect(new Set(charges.map((c) => c._timestamp)).size).toBe(charges.length);
  });
});

describe("what it costs", () => {
  test("spending rises with income but by less than income does", () => {
    const poor = medianAmount("grocery", 5411, 20_000);
    const middle = medianAmount("grocery", 5411, REFERENCE_INCOME);
    const rich = medianAmount("grocery", 5411, 200_000);
    expect(middle).toBeGreaterThan(poor);
    expect(rich).toBeGreaterThan(middle);
    // Engel's law is the whole point: ten times the income of the $20k
    // household does not buy anything like ten times the food.
    expect(rich / poor).toBeLessThan(4);
  });

  test("a bigger household buys a bigger basket and not a bigger haircut", () => {
    const one = medianAmount("grocery", 5411, REFERENCE_INCOME, 1);
    const five = medianAmount("grocery", 5411, REFERENCE_INCOME, 5);
    // 1.32, from the fitted perHead of 0.08. This bound used to be 1.8 and the
    // CE Diary does not support it: the weighted median basket runs $38.92 at
    // one person to $63.01 at five, a raw ratio of 1.64, and holding income
    // fixed — which is what this test does — takes it to 1.32, because larger
    // households earn more and the raw ratio is partly that.
    //
    // The rest of the gap is real and lives elsewhere. A five-person household
    // makes 2.31 shopping trips a week against 1.62 for one person, so it buys
    // much more food in total while buying only a little more per trip. That
    // is `tours.ts` to answer for, not a basket size.
    expect(five).toBeGreaterThan(one * 1.25);
    expect(five).toBeLessThan(one * 1.45);

    const salon = venue("v:way/9", "shop=hairdresser", 7230, ["personal"]);
    const cut = (size: number) => {
      const amounts: number[] = [];
      for (let day = 0; day < 300; day += 1) {
        for (const charge of chargesFor(
          context([salon], REFERENCE_INCOME, size), person(), stopDay("v:way/9", "personal", 600, 645), day)) {
          amounts.push(charge.amount);
        }
      }
      amounts.sort((a, b) => a - b);
      return amounts[Math.floor(amounts.length / 2)]!;
    };
    expect(cut(5) / cut(1)).toBeCloseTo(1, 1);
  });

  test("the median basket is near the ticket it was quoted at", () => {
    const ticket = TICKETS.grocery!;
    const median = medianAmount("grocery", 5411, REFERENCE_INCOME, 1);
    // Within a fifth. Tips are nought here and the venue pull is 1, so the
    // only thing between the two is the lognormal's own sampling error.
    expect(median).toBeGreaterThan(ticket.base * 0.8);
    expect(median).toBeLessThan(ticket.base * 1.2);
  });

  test("somewhere that takes no money is never charged for", () => {
    const park = venue("v:way/5", "leisure=park", null, ["park"]);
    for (let day = 0; day < 50; day += 1) {
      expect(chargesFor(context([park]), person(), stopDay("v:way/5", "park", 600, 700), day)).toEqual([]);
    }
  });

  test("the same day priced twice is the same day", () => {
    const shop = venue("v:way/6", "shop=supermarket", 5411, ["grocery"]);
    const day = stopDay("v:way/6", "grocery", 1020, 1080);
    const first = chargesFor(context([shop]), person(), day, 42);
    const second = chargesFor(context([shop]), person(), day, 42);
    expect(second).toEqual(first);
  });
});

describe("travel", () => {
  function taxiLeg(km: number, minutes: number, wait = 0): Leg {
    return {
      journeyId: "fare/1/0",
      purpose: "stop", mode: "taxi",
      from: { lat: 40.6, lon: -75.47 }, to: { lat: 40.62, lon: -75.5 },
      fromLabel: "home", toLabel: "shop",
      depart: 600, arrive: 600 + minutes, kilometres: km, estimated: false, wait,
    } as Leg;
  }

  test("the meter is paid when the cab stops, and rises with the ride", () => {
    const short = chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [taxiLeg(2, 8)]), 3);
    const long = chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [taxiLeg(14, 30)]), 3);
    expect(short[0]!.reason).toBe("fare");
    expect(short[0]!._timestamp).toBe(608);
    expect(long[0]!.amount).toBeGreaterThan(short[0]!.amount);
  });

  test("a short hop still pays the minimum fare", () => {
    for (let day = 0; day < 100; day += 1) {
      const [fare] = chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [taxiLeg(0.4, 3)]), day);
      expect(fare!.amount).toBeGreaterThanOrEqual(8);
    }
  });

  test("waiting in traffic is on the meter", () => {
    const moving = chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [taxiLeg(6, 20, 0)]), 7);
    const stuck = chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [taxiLeg(6, 20, 11)]), 7);
    expect(stuck[0]!.amount).toBeGreaterThan(moving[0]!.amount);
  });

  test("the driver's own cab leg pays no fare", () => {
    const driving = { ...taxiLeg(6, 20), mode: "cab" } as Leg;
    expect(chargesFor(context([]), person(), stopDay("none", "grocery", 0, 0, [driving]), 7)).toEqual([]);
  });
});

describe("the date boundary", () => {
  test("a stay across midnight is charged on exactly one of the two dates", () => {
    const bar = venue("v:node/9", "amenity=bar", 5813, ["bar"]);
    for (let day = 10; day < 60; day += 1) {
      // Tonight 22:30-01:30, then the same stay as tomorrow's continuation.
      const tonight = chargesFor(context([bar]), person(), stopDay("v:node/9", "bar", 1350, 1530), day);
      const carried = chargesFor(context([bar]), person(), stopDay("v:node/9", "bar", -90, 90), day + 1);
      for (const charge of [...tonight, ...carried]) {
        expect(charge._timestamp).toBeGreaterThanOrEqual(0);
        expect(charge._timestamp).toBeLessThan(1440);
      }
      // Three hours is four rounds, split between the dates and none twice.
      expect([0, 4]).toContain(tonight.length + carried.length);
    }
  });
});

describe.skipIf(!CITY)("settling against the bank", () => {
  const bank = CITY ? Bank.load() : (null as unknown as Bank);
  const shop = venue("v:way/7", "shop=supermarket", 5411, ["grocery"]);

  test("what the ledger says left is what left the accounts", () => {
    const who = 8123;
    const held = () => bank.position(who).accounts
      .reduce((total, account) => total + account.balance, 0);
    const drawn = () => bank.position(who).cards
      .reduce((total, card) => total + card.balance, 0);

    const before = held() - drawn();
    const posted = settleDay(
      bank, context([shop], 62_000, 3), person(who), stopDay("v:way/7", "grocery", 1020, 1080), 5);
    const spent = posted
      .filter((tx) => tx.approved && tx.kind === "payment")
      .reduce((total, tx) => total + tx.amount, 0);

    expect(posted.length).toBeGreaterThan(0);
    // A withdrawal moves money between two of this person's own places, so it
    // must not show up in the difference at all.
    expect(Math.round((before - (held() - drawn())) * 100) / 100)
      .toBeCloseTo(Math.round(spent * 100) / 100, 2);
  });

  test("a pocket that runs low is refilled from an account, not from nowhere", () => {
    let withdrawals = 0;
    // One bank, four hundred people. They do not share an account between
    // them, so nobody's day here is disturbed by anybody else's — and
    // reloading holdings.bin per person costs seconds each.
    const fresh = bank;
    for (let who = 9000; who < 9400; who += 1) {
      const position = fresh.position(who);
      const cash = position.accounts.find((account) => account.type === "cash");
      if (!cash) continue;
      const bankedBefore = position.accounts
        .filter((account) => account.type !== "cash")
        .reduce((total, account) => total + account.balance, 0);

      for (const tx of settleDay(
        fresh, context([shop], 55_000, 2), person(who), stopDay("v:way/7", "grocery", 1020, 1080), 5)) {
        if (tx.kind !== "withdrawal" || !tx.approved) continue;
        withdrawals += 1;
        const after = fresh.position(who).accounts
          .filter((account) => account.type !== "cash")
          .reduce((total, account) => total + account.balance, 0);
        // Rounded because the sum of a dozen settled balances is a float sum,
        // and this test is about where the notes came from, not about cents.
        expect(Math.round((bankedBefore - after) * 100) / 100).toBeGreaterThanOrEqual(tx.amount);
        expect(tx.amount % 20).toBe(0);
      }
    }
    // Not every one of four hundred people is short of cash on a given day,
    // but a good many are: the check is that the mechanism fires at all.
    expect(withdrawals).toBeGreaterThan(0);
  });
});

/** A day holding one gathering at one venue, and nothing else. */
function meetDay(
  id: string, purpose: Purpose, start: number, end: number,
  parties: number[], payer: number | null, self = 1,
): Day {
  const meeting = {
    id: `meet/${parties[0]}/0`,
    purpose,
    venue: { id, lat: 40.6, lon: -75.47 },
    start, end, parties, kind: "hosted", host: parties[0],
    ride: null, payer,
  } as unknown as Meeting;
  return {
    person: self,
    scheduled: {
      person: self,
      timeline: [{
        kind: "stay",
        activityId: `meet/${self}/0/${id}`,
        source: "meet",
        place: { lat: 40.6, lon: -75.47, id, kind: "venue", label: "Test" },
        start, end,
        policy: "optional",
        payload: { kind: "meet", meeting, label: purpose, where: id },
      }],
      rejected: [],
      lateMinutes: 0,
      metrics: { trips: 0, drivenKm: 0, walkedKm: 0, rejected: 0 },
    },
    blocks: [], tours: [], legs: [], attendance: [],
    plan: { person: self, stops: [], trips: 0, extraKm: 0 },
    drivenKm: 0, walkedKm: 0, cabKm: { loaded: 0, empty: 0 }, trips: 0, late: 0,
  } as unknown as Day;
}

/** Every charge a gathering of this shape raises, over many days. */
function tableCharges(
  parties: number[], payer: number | null, self = 1, days = 400,
): number[][] {
  const table = venue("v:way/9", "amenity=restaurant", 5812, ["food-sit"]);
  const out: number[][] = [];
  for (let day = 0; day < days; day += 1) {
    out.push(chargesFor(
      context([table]), person(self),
      meetDay("v:way/9", "food-sit", 1110, 1200, parties, payer, self), day,
    ).map((charge) => charge.amount));
  }
  return out;
}

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe("when somebody eats alone", () => {
  test("a solo diner pays for their own meal, every time", () => {
    const table = venue("v:way/8", "amenity=restaurant", 5812, ["food-sit"]);
    let billed = 0;
    const days = 600;
    for (let day = 0; day < days; day += 1) {
      const charges = chargesFor(
        context([table]), person(), stopDay("v:way/8", "food-sit", 1128, 1249), day);
      // Never more than one: a stop is one cover, and the party draw that used
      // to multiply it up — and hand it to a diner the simulation never seated
      // — is gone. See COVERS in spend.ts.
      expect(charges.length).toBeLessThanOrEqual(1);
      billed += charges.length;
    }
    // Only `paid`, at 0.97, is allowed to leave a meal off the ledger.
    expect(billed / days).toBeGreaterThan(0.94);
  });
});

describe("when a gathering picks up the bill", () => {
  test("the person the meeting names as treating is charged, every time", () => {
    const days = tableCharges([1, 2, 3], 1);
    const paid = days.filter((charges) => charges.length === 1).length;
    // `paid` on the ticket is 0.97, and that is the only thing allowed to stop
    // a named payer being billed. Before the fix a drawn party could return
    // nothing for them and leave the day with no restaurant charge at all.
    expect(paid / days.length).toBeGreaterThan(0.94);
    expect(days.every((charges) => charges.length <= 1)).toBe(true);
  });

  test("nobody else at the table is charged for it", () => {
    for (const charges of tableCharges([1, 2, 3], 2, 1)) expect(charges).toHaveLength(0);
  });

  test("a cover at a treated table costs what a cover costs", () => {
    // The level, which the draw this replaced did *not* get wrong on average —
    // its expected covers billed per diner is exactly one, so it moved the
    // spread of restaurant charges and not their total. What it got wrong was
    // every individual table: the covers were billed twice over, once for the
    // real party and once for an imaginary one, and a fifth of the time that
    // landed on nobody at all. This pins the level so a later change to the
    // multiplication cannot quietly double it.
    const covers = 4;
    const treated = mean(tableCharges([1, 2, 3, 4], 1, 1, 1600).flat()) / covers;
    const own = mean(tableCharges([1, 2, 3, 4], null, 1, 1600).flat());

    expect(treated / own).toBeGreaterThan(0.9);
    expect(treated / own).toBeLessThan(1.12);
  });

  test("the bill is the real covers, not a party drawn behind the meeting's back", () => {
    const two = median(tableCharges([1, 2], 1).flat());
    const six = median(tableCharges([1, 2, 3, 4, 5, 6], 1).flat());
    // Priced per cover and multiplied, so six covers cost three times two. The
    // draw this replaced multiplied that again by one to four.
    expect(six / two).toBeGreaterThan(2.7);
    expect(six / two).toBeLessThan(3.3);
  });

  test("with nobody treating, each diner pays their own cover", () => {
    const days = tableCharges([1, 2, 3, 4], null);
    const own = median(days.flat());
    const treated = median(tableCharges([1, 2, 3, 4], 1).flat());
    expect(treated / own).toBeGreaterThan(3.5);
    expect(treated / own).toBeLessThan(4.5);
  });
});

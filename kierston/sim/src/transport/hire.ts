/**
 * Who has no car, and what they do about it.
 *
 * Every taxi trip in this city used to descend from one answer: JWTRNS 7, "how
 * you usually got to work". That is 198 people, it produced about 295 fares a
 * day, and a fleet of 146 drivers turned three or four of them a shift against
 * the fifteen to twenty-five a real cab turns. The fleet was never the problem —
 * it is the PUMS-weighted count and its day pattern already matches WKHP. The
 * demand was, and the reason is structural: a commute question cannot see a
 * fare that is not a commute.
 *
 * Three groups it cannot see, and two of them are here:
 *
 *   the carless       Fifteen percent of households in this town keep no
 *                     vehicle. Most of them never answered JWTRNS at all,
 *                     because the question is only put to people who worked
 *                     last week — so a retired couple with no car came out of
 *                     `modeOf` as drivers, and every trip they made was a drive
 *                     in a car the vehicle registry says they do not own.
 *
 *   those who stopped Driving thins out sharply after seventy-five. Somebody
 *                     who has given up their licence still goes to the surgery
 *                     and still shops, and where there is nobody in the house
 *                     to drive them those trips are cabs. They are a large
 *                     share of the daytime trade in a real fleet and they
 *                     generated nothing here.
 *
 *   visitors          Not in the population, and out of reach of this module
 *                     or any other. A hotel rank is demand this simulation
 *                     structurally cannot produce.
 *
 * What this file does *not* do is decide a trip. It decides a standing fact
 * about a person — whether a car is available to them at all — and hands the
 * travel layer a mode and a propensity. Which particular trips become fares is
 * `travel.ts`'s draw, keyed on the pair of places, so that the outbound and the
 * return agree and so that both passes of the dispatcher see the same demand.
 *
 * Not evenings only, deliberately. The temptation is to model the fare as the
 * trip home from the pub, because that is the one everybody pictures. But the
 * defining fact about a household with no car is that it has no car on a
 * Tuesday morning either, and a propensity that switched on at six would put
 * the whole of this new demand into the hours the fleet is already busiest
 * while leaving the daytime cab as idle as it is now.
 */

import type { Person, World } from "../world/index.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import type { LegMode } from "./travel.ts";

/**
 * The two propensities and the age curve, all three fitted rather than measured.
 *
 * There is no local survey of how a carless household in the city gets to the
 * supermarket, and the national ones answer a different question — NHTS records
 * the trips people made, not the trips they would have made by cab if the walk
 * had been longer. So these are fitted, and to two published numbers at once:
 * fares per driver per shift, which the trade puts at fifteen to twenty-five,
 * and the share of a fleet's kilometres run empty, which is forty to fifty
 * percent.
 *
 * The second is the one that makes the fit worth trusting, because nothing here
 * aims at it. Empty running is a property of the *fleet* — how far a car has to
 * go to reach its next fare — and at the old demand it sat at 62%, which is
 * what a fleet looks like when it spends the shift driving out and back for
 * three or four jobs. It falls to 41% at the demand fitted below, without a
 * dispatcher constant being touched. Two independent published figures reached
 * by one parameter is the strongest evidence available that the level is right.
 *
 * The sweep that set them is in NOTICES.md. Above about 0.16 the fleet is the
 * binding constraint rather than the demand: total fares stop rising, the
 * median wait climbs to the passenger's patience, and everything extra comes
 * out as people giving up and walking. The city cannot absorb more cab trips
 * than 127 drivers can carry, whatever propensity is asserted here.
 */
export interface HirePolicy {
  /** Share of a carless adult's non-walkable trips made by cab. */
  carless: number;
  /** The same for somebody who has stopped driving and has nobody to drive them. */
  elder: number;
  /**
   * The share of each age band who no longer drive.
   *
   * Read as "from this age, this many have stopped", highest age first — the
   * first band a person reaches is the one that applies. Roughly the FHWA
   * licensure series against population: near-universal licensing to seventy,
   * then a fall that is slow through the late seventies and steep after
   * eighty-five.
   */
  cessation: readonly { from: number; share: number }[];
  /** Below this age somebody is escorted rather than hiring anything. */
  adult: number;
}

export const HIRE: HirePolicy = {
  carless: 0.12,
  elder: 0.45,
  cessation: [
    { from: 85, share: 0.72 },
    { from: 80, share: 0.45 },
    { from: 75, share: 0.25 },
    { from: 70, share: 0.09 },
  ],
  adult: 18,
};

/** The policy with the carless channel off, for the sweep. */
export const NO_CARLESS: HirePolicy = { ...HIRE, carless: 0 };
/** The policy with the age channel off, for the sweep. */
export const NO_ELDER: HirePolicy = { ...HIRE, elder: 0 };
/** The state of the world before this module: only JWTRNS 7 rides. */
export const NONE: HirePolicy = { ...HIRE, carless: 0, elder: 0 };

/**
 * The JWTRNS answers that are no answer, and are the only ones this file acts on.
 *
 * 0 is not-applicable — they did not work last week and were never asked, which
 * is two thirds of the town and the whole of the population this module is
 * about. 11 is worked at home and 12 is "other", and neither says anything
 * about how the respondent gets to the supermarket on a Sunday.
 *
 * Every other code is an observation about a real week and outranks anything
 * inferred here. That includes code 1: somebody who drove to work has a car,
 * and the vehicle registry not having given their household one is a
 * disagreement between two models rather than a fact about them — the survey
 * wins, because it is the observation and the registry is a resample.
 */
const UNSTATED = new Set(["0", "11", "12"]);

/** JWTRNS 7. Somebody who already told the survey they take a cab to work. */
const STATED_TAXI = "7";

/**
 * How this person travels when they are not commuting, and how often it is a cab.
 *
 * `usual` is undefined for everybody the travel layer should keep deciding for
 * itself, which is most of the town. It is `taxi` only for someone with no car
 * available at all — and that mode is right for them even at a hire share well
 * under one, because `walkShare` already gives the taxi mode its own curve:
 * carless people walk considerably further than drivers before the trip becomes
 * something they have to pay for, and the trips that are still too far are
 * split between the cab and everything else by `share`.
 */
export interface Hirer {
  usual: LegMode | undefined;
  /** Probability a non-walked trip of theirs is a fare. 1 for a stated cab commuter. */
  share: number;
}

const NOT_A_HIRER: Hirer = { usual: undefined, share: 0 };

export function hirerFor(world: World, person: Person, policy: HirePolicy = HIRE): Hirer {
  if (person.transport === STATED_TAXI) return { usual: "taxi", share: 1 };
  if (person.age < policy.adult) return NOT_A_HIRER;
  if (person.transport !== null && person.transport !== undefined
      && !UNSTATED.has(person.transport)) return NOT_A_HIRER;

  if (world.carless.has(person.household)) {
    return policy.carless > 0 ? { usual: "taxi", share: policy.carless } : NOT_A_HIRER;
  }
  if (policy.elder > 0 && stopped(world, person, policy) && alone(world, person, policy)) {
    return { usual: "taxi", share: policy.elder };
  }
  return NOT_A_HIRER;
}

/**
 * Has this person given up driving? A trait, drawn once and kept.
 *
 * The same argument `rng.ts` makes for punctuality. Giving up a licence is a
 * thing that happens to a person, not a thing that happens to a Tuesday, and
 * redrawing it daily would produce somebody who drives to church and takes a
 * cab to the shops on the same afternoon.
 */
function stopped(world: World, person: Person, policy: HirePolicy): boolean {
  const band = policy.cessation.find((row) => person.age >= row.from);
  if (!band) return false;
  return new Rng(mix(world.seed, person.id, LAYER.licence)).next() < band.share;
}

/**
 * Nobody in the house to drive them.
 *
 * The difference between a fare and a lift, and the reason the age channel is
 * far smaller than the raw count of over-seventy-fives suggests. An eighty-year
 * old living with a driving daughter is driven; one living alone, or with a
 * spouse who has also stopped, orders a car. Only the second is demand.
 */
function alone(world: World, person: Person, policy: HirePolicy): boolean {
  for (const other of household(world, person.household)) {
    if (other.id === person.id || other.age < policy.adult) continue;
    if (!stopped(world, other, policy)) return false;
  }
  return true;
}

/**
 * Can this person get behind a wheel today?
 *
 * The three conditions that already decide it, gathered under one name because
 * a second layer now needs to ask. `hirerFor` asks it about the person the
 * journey belongs to; `meetings.ts` asks it about everybody at a table, to work
 * out whose car four people arrived in.
 *
 * Pure, and pure in the way that matters here: it reads a static registry, a
 * static age and one trait draw, and no part of anybody's day. Two people can
 * therefore both ask it about each other and get the same answer without
 * either having planned a day yet.
 */
export function drives(world: World, person: Person, policy: HirePolicy = HIRE): boolean {
  if (person.age < DRIVING_AGE) return false;
  if (world.carless.has(person.household)) return false;
  return !stopped(world, person, policy);
}

/**
 * The age a licence becomes possible in Pennsylvania. A junior licence at 16
 * and 6 months carries restrictions this layer does not model; the effect of
 * treating seventeen as the threshold is a rounding error on a few hundred
 * people.
 */
const DRIVING_AGE = 17;

/** Everybody at one address, for a layer that reasons about the household. */
export function householdOf(world: World, id: number): readonly Person[] {
  return household(world, id);
}

/**
 * Who else lives here, indexed once per world rather than scanned per person.
 *
 * Held against the world object because that is what it is a fact about, and
 * because the checks build several contexts over one population.
 */
const HOUSEHOLDS = new WeakMap<World, Map<number, Person[]>>();

function household(world: World, id: number): readonly Person[] {
  let index = HOUSEHOLDS.get(world);
  if (!index) {
    index = new Map();
    for (const person of world.persons.values()) {
      const mine = index.get(person.household);
      if (mine) mine.push(person);
      else index.set(person.household, [person]);
    }
    HOUSEHOLDS.set(world, index);
  }
  return index.get(id) ?? [];
}

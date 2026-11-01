/**
 * Per-person deterministic randomness.
 *
 * Every draw in the simulation comes from a stream keyed by identity — person,
 * day, and which layer is asking — rather than from one generator walked in
 * order. That costs a hash per stream and buys two things worth far more:
 * adding a layer next month cannot reshuffle the days a layer written today
 * already produced, and any single person's Tuesday can be regenerated on its
 * own without running the town to get there.
 *
 * Keys are numbers, not strings. A string key would be clearer to read at the
 * call site and would also mean allocating and hashing a string several million
 * times a simulated day, so layers are numbered in LAYER and the mixing is
 * integer arithmetic throughout.
 */

/** Which layer is drawing. Append only — changing a number rewrites history. */
export const LAYER = {
  workDays: 1,
  punctuality: 2,
  departure: 3,
  overtime: 4,
  parking: 5,
  taxiDays: 6,
  routeChoice: 7,
  breaks: 8,
  /** Which shop is *their* shop. One draw per person per purpose, forever. */
  habit: 9,
  /** Whether a tour picks up a stop, and which purpose it is for. */
  stopChoice: 10,
  /** Errands with no commute to hang off — the trips that start at home. */
  errand: 11,
  /** Where and when a person eats, on the days they eat out. */
  meal: 12,
  /** An org's meeting calendar. Keyed on the org, not on any member. */
  calendar: 13,
  /** Whether a member turns up to an occurrence they could have gone to. */
  attendance: 14,
  /** How long someone stays once they are there. */
  dwell: 15,
  /** Which stand a cab driver waits at between fares. One draw per driver, forever. */
  taxiStand: 16,
  /** Tie-breaks in the dispatcher, so two equal cabs do not always resolve the same way. */
  taxiDispatch: 17,
  /** Whether one particular trip is made by cab rather than by whatever else was open. */
  hire: 18,
  /** Whether somebody old enough to have stopped driving has. One draw per person, forever. */
  licence: 19,
  /** How much sleep a person needs, when they prefer it, and how long they take to leave. One draw per person, forever. */
  sleep: 20,
  /** Whether a parent waiting between two school runs spends the gap somewhere, and where. */
  escortWait: 21,
  /** What a visit costs and at which minute inside it the money moves. */
  spend: 22,
  /** How much cash somebody likes to have on them, and when they go and get it. */
  cash: 23,
  /** Which bills fall due today, what they come to, and who in the household pays. */
  bills: 24,
  /** Whether the phone is on, charged, and carried at all. One draw per person per day. */
  handset: 25,
  /** Shadow fading: how one subscriber hears one cell from one place. */
  fading: 26,
  /** Whether the radio is in a connected state this minute, or merely camped. */
  bearer: 27,
  /**
   * How attached to their phone somebody is, and when their breaks fall.
   *
   * Two things off one layer number because they are the same object: the
   * temperament draw takes no day and is a trait, the break jitter takes the
   * day and is not, and `stream` keys them apart on the extra argument.
   */
  attention: 28,
  /** How long one particular person takes to notice one particular message. */
  reply: 29,
  /** Whether a pair speak today at all, and about what. */
  contact: 30,
  /** Which app a pair use, drawn once for the pair and rarely departed from. */
  channel: 31,
  /** The branching inside one conversation: who answers, and how often. */
  exchange: 32,
  /** Whether a call is answered, how long it rings, and how long it lasts. */
  call: 33,
  /**
   * Whether somebody convenes a gathering today, whom they ask, where it is
   * and whose car they came in.
   *
   * Keyed on the convener, or on the household — never on a pair — because
   * every party has to draw the same evening without consulting the others,
   * and a pair key is one a third person cannot compute. See
   * `activities/social/meetings.ts`.
   */
  meet: 34,
  /**
   * The traffic a gathering generates: arranging it, the run-up, the photos
   * afterwards, the calls to somebody who did not turn up.
   *
   * Separate from `exchange` because it is keyed on the gathering rather than
   * on a pair, and because a gathering's thread carries traffic that no tie's
   * weekly rate accounts for. See `comms/gatherings.ts`.
   */
  gathering: 35,
  /** What a fixed plate reader captures, and how its OCR interprets the plate. */
  alpr: 36,
  /** Vehicles whose home and owner sit outside the modelled population. */
  externalTraffic: 37,
  /**
   * Whether an officer's watch is spent in a car, and where the car goes.
   *
   * Keyed on the officer and the day, never on the unit: a station works out
   * which of its officers are in cars by asking each of them this same
   * question, so the answer has to be computable from one person's row.
   */
  patrol: 38,
  /** Calls for service: keyed on the day, then the incident index. */
  calls: 39,
} as const;

export type Layer = (typeof LAYER)[keyof typeof LAYER];

/** One round of a 32-bit avalanche. Cheap, and good enough to decorrelate. */
function avalanche(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function mix(...keys: number[]): number {
  let h = 0x9e3779b9;
  for (const key of keys) h = avalanche(h ^ (key | 0));
  return h >>> 0;
}

/**
 * A stream. `mulberry32` because it is four operations, passes the tests that
 * matter at this scale, and has no state worth carrying between calls.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  between(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.between(lo, hi + 1));
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  /** Box–Muller, one value per call. The second is not worth the state. */
  gauss(mean = 0, sigma = 1): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Pick by weight. Weights need not sum to anything in particular. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i += 1) {
      roll -= weights[i]!;
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

export function stream(seed: number, person: number, layer: Layer, ...rest: number[]): Rng {
  return new Rng(mix(seed, person, layer, ...rest));
}

/**
 * A trait: one draw per person that never varies by day.
 *
 * Punctuality is the example the commute needs. Someone who leaves five
 * minutes late leaves five minutes late every morning, and redrawing it daily
 * would turn a personality into noise that averages out.
 */
export function trait(seed: number, person: number, layer: Layer): number {
  return new Rng(mix(seed, person, layer)).next();
}

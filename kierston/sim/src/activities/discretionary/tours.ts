/**
 * The discretionary day, hung off the commute where there is one.
 *
 * A commute is the spine, and this is what attaches to it. Almost everything
 * people do outside work and home is cheaper to do on the way than as its own
 * journey, and modelling it as its own journey is the classic way to build a
 * synthetic city with twice the traffic it should have and every shop's
 * catchment centred on the wrong place. The supermarket a person uses is not
 * the one nearest their house; it is the one nearest the line between their
 * house and their work, and those are different shops for most of Kierston.
 *
 * Where the café question lands
 * -----------------------------
 * Bars, cafés and restaurants are not affiliations, and `init/social/orgs.py`
 * settled that before this module existed — only tags describing somewhere
 * with a membership become an org, because "a restaurant has regulars but not
 * a roster, and the difference is whether the same forty people are there
 * every week". So they are venues, and a visit is generated one of three ways:
 *
 *   alone, en route     a stop on a leg. Breakfast on the way in, the pint on
 *                       the way home. This module, `intercept`.
 *   alone, from a base  a trip out and back from home or from work. The
 *                       lunch break is the big one. This module, `excursion`.
 *   with someone        not generated here at all. The meetings layer decides who and
 *                       when, and picks the venue as part of that, because
 *                       the venue has to suit two homes rather than one.
 *
 * The third case is why a stop can be `claimable`. Dinner out and the evening
 * bar are drawn here as solo events, and when the meetings layer arrives it
 * takes precedence over any claimable stop it overlaps rather than adding a
 * second dinner. Generating them here first is not wasted: it means the solo
 * half of the city's restaurant trade exists before the social half does, and
 * that half is real — a third of restaurant covers are people on their own or
 * picking up.
 *
 * What holds the regulars together is not a roster but a habit. `venues.ts`
 * draws a person's shop once per purpose and keeps it, so the same face is at
 * the same counter most Tuesdays without anybody having to store a membership.
 * That is the whole substitute for an affiliation, and it is enough.
 */

import { homeOf, placeOf, type Person, type Point, type World } from "../../world/index.ts";
import type { Block, Tour } from "../work/index.ts";
import { LAYER, stream, type Rng, weekday } from "../../shared/index.ts";
import { haversineKm, modeOf, type Roads } from "../../transport/index.ts";
import { isOpen, type Purpose, type Venue, type Venues } from "./venues.ts";
import { drawMinute } from "./hours.ts";

export interface Stop {
  purpose: Purpose;
  venue: Venue;
  arrive: number;
  leave: number;
  /** Which journey it attached to, and therefore what it cost. */
  on: "to-work" | "to-home" | "from-work" | "from-home";
  /**
   * Extra kilometres over the journey that would have happened anyway.
   *
   * What the stop was judged worth when it was drawn, not what it ended up
   * costing. The cost is in the legs `travel.ts` builds, which route the real
   * chain — home to the shop to the office — rather than a detour off a line.
   */
  detourKm: number;
  detourMinutes: number;
  /**
   * Minutes the planner may start this later than `arrive` if it cannot get
   * the person there on time. See `Demand.slack` for why it exists; carried on
   * the stop rather than looked up again because the meal break's allowance is
   * what the shift has left rather than what the purpose would permit.
   */
  slack: number;
  /** True where the meetings layer may replace this with a joint version. */
  claimable: boolean;
}

export interface DayPlan {
  person: number;
  stops: Stop[];
  /**
   * Trips this layer expects its stops to generate. Indicative only — the real
   * count is legs, and only `travel.ts` knows how many there are once the whole
   * day is chained together and the walk back to the car is in it.
   */
  trips: number;
  extraKm: number;
}

/**
 * How often a purpose is wanted, in trips per week.
 *
 * Per person unless marked, and the marked ones matter: a household buys
 * groceries once and one member goes, so drawing it per person would give a
 * family of four four weekly shops. The shopper is whoever the household
 * settled on, drawn once — households have a person who does the food.
 */
interface Demand {
  perWeek: number;
  household: boolean;
  /** Share of these that attach to a journey already happening. */
  intercept: number;
  /**
   * Minutes inside, as the *median* of the visit rather than its mean.
   *
   * Measured, from NHTS `DWELTIME` on the trip file grouped by `WHYTO`. The
   * medians are 60 for buying goods, 30 for buying a meal, 40 for a service,
   * 25 for an errand, 120 for health care and 130 for recreation, and the
   * numbers below are those split across the purposes that make each group up.
   * Where a split is not something WHYTO can settle it is marked; the group's
   * median is the constraint, and how it divides inside the group is judgment.
   */
  dwell: number;
  /**
   * The lognormal spread of that visit, in log-minutes.
   *
   * Not decoration, and the reason a single median could never have been
   * enough. Fitting σ off each group's deciles gives a consistent 0.6–1.3 —
   * the same figure from the 10th percentile and the 90th, which is what says
   * the distribution really is lognormal — against the flat 0.45 this used to
   * draw with. Too narrow a spread loses both tails at once: the city ends up
   * with no five-minute stops, when 12% of real non-home stays are under six
   * minutes, and no two-hour ones either.
   */
  spread: number;
  /** Kilometres of detour it is worth. */
  budget: number;
  /**
   * The outer bounds of where in the day it can be, as minutes from midnight.
   * Where `hours.ts` has a curve for the purpose, the curve decides where in
   * these bounds the draw lands; the rest keep a triangle across them.
   */
  window: [number, number];
  /**
   * Minutes the visit may start later than it was drawn, for the planner to
   * spend getting the person there.
   *
   * The times a stop carries are a draw and not an appointment, and this is
   * what says so. `intercept` prices the hop to the venue as bare road time,
   * while the planner prices the same movement door to door — the walk out to
   * the car, the search for a space, the walk in from it — so the minute this
   * layer names is routinely a minute the planner cannot reach. Offered a
   * window exactly as wide as its own duration, it had one candidate minute to
   * test and nothing to do but refuse: 94% of every stop drawn onto a commute
   * leg was thrown away, against 2% of the ones drawn from home, where the
   * person has all morning behind them to absorb the difference.
   *
   * Spending it does not scatter the stop across the afternoon. `insertWindow`
   * takes the earliest minute it can actually reach, so this is headroom and
   * not drift — the visit still happens as soon as the day allows one, and a
   * slide that would make the person late for whatever follows is rejected by
   * the planner's own onward check rather than by anything here.
   *
   * Zero for an appointment, which is at the hour it was given and not at the
   * hour that turns out to be convenient. The middle tier is the trade that is
   * half booked and half walk-in; which purposes sit there is judgment.
   */
  slack: number;
  claimable: boolean;
}

/** What a stop that is nobody's appointment may slide by. See `Demand.slack`. */
const SLIDE = 30;
/** The same for a trade you often, but not always, ring ahead for. */
const BOOKED = 15;

const DEMAND: Record<string, Demand> = {
  // The weekly shop and the top-up are the same building and different trips,
  // and NHTS agrees they are different lengths: WHYTO 11 has a median of 60
  // minutes and only 3% of its stays under six, which is a shop rather than a
  // milk run. So the shop takes the group's median and the milk run keeps the
  // few minutes it always had — the split WHYTO cannot make, made here.
  grocery: { perWeek: 1.6, household: true, intercept: 0.62, dwell: 60, spread: 0.7, budget: 2.2, window: [9 * 60, 21 * 60], slack: SLIDE, claimable: false },
  convenience: { perWeek: 1.3, household: false, intercept: 0.78, dwell: 8, spread: 0.8, budget: 0.7, window: [6 * 60, 23 * 60], slack: SLIDE, claimable: false },
  // Coffee is the most interceptable thing anyone buys — almost nobody makes a
  // journey for it, they buy it on one they were making.
  //
  // Buying a meal is a median of 30 minutes and it barely moves across the day
  // — 30 in the morning, 35 at lunch, 25 in the evening — because the evening
  // figure is mostly carry-out rather than the long dinner one might expect.
  // That is why the café, the counter and the table are not read off the clock:
  // WHYTO cannot separate them, so the group median is the constraint and the
  // three below are chosen to meet it in the proportions they are drawn at.
  cafe: { perWeek: 1.9, household: false, intercept: 0.88, dwell: 25, spread: 0.95, budget: 0.9, window: [6 * 60, 20 * 60], slack: SLIDE, claimable: true },
  "food-quick": { perWeek: 1.5, household: false, intercept: 0.7, dwell: 20, spread: 0.95, budget: 1.1, window: [7 * 60, 22 * 60], slack: SLIDE, claimable: true },
  "food-sit": { perWeek: 0.85, household: false, intercept: 0.3, dwell: 70, spread: 0.7, budget: 2.5, window: [8 * 60, 22 * 60], slack: SLIDE, claimable: true },
  bar: { perWeek: 0.55, household: false, intercept: 0.34, dwell: 95, spread: 0.8, budget: 2.4, window: [13 * 60, 24 * 60], slack: SLIDE, claimable: true },
  // Fuel is not drawn from a rate at all — see `wantsFuel`.
  //
  // 0.93 was too high to be a description of anything: it left a twentieth of
  // fills as journeys in their own right, and since a fill was only drawn for
  // people who had a commute to hang it on, nobody without one ever drove to a
  // station at all. Most refuelling really is done on the way somewhere, so
  // this stays the highest intercept in the table — but a fifth of it is a
  // person noticing the gauge and going out for that and nothing else.
  fuel: { perWeek: 0, household: false, intercept: 0.8, dwell: 6, spread: 0.6, budget: 0.6, window: [5 * 60, 23 * 60], slack: SLIDE, claimable: false },
  pharmacy: { perWeek: 0.3, household: false, intercept: 0.6, dwell: 12, spread: 1.1, budget: 1.0, window: [9 * 60, 20 * 60], slack: SLIDE, claimable: false },
  // An appointment. Nobody intercepts a dentist, and nobody chooses one for
  // being near the route — they go to theirs, at the time they were given.
  //
  // Two hours is what WHYTO 18 actually says, and it is the single largest
  // correction in this table. A medical visit is mostly waiting for it.
  health: { perWeek: 0.07, household: false, intercept: 0.08, dwell: 120, spread: 0.9, budget: 0.2, window: [8 * 60 + 30, 16 * 60 + 30], slack: 0, claimable: false },
  personal: { perWeek: 0.17, household: false, intercept: 0.22, dwell: 45, spread: 1.1, budget: 0.8, window: [9 * 60, 18 * 60], slack: BOOKED, claimable: false },
  errand: { perWeek: 0.38, household: false, intercept: 0.55, dwell: 25, spread: 1.28, budget: 1.0, window: [9 * 60, 17 * 60], slack: SLIDE, claimable: false },
  retail: { perWeek: 0.95, household: false, intercept: 0.35, dwell: 60, spread: 0.7, budget: 2.6, window: [9 * 60, 21 * 60], slack: SLIDE, claimable: true },
  vehicle: { perWeek: 0.04, household: false, intercept: 0.15, dwell: 60, spread: 1.1, budget: 1.2, window: [8 * 60, 17 * 60], slack: BOOKED, claimable: false },
  // WHYTO 15 is 130 minutes, but it is all of recreation — a cinema and a
  // ball game are in it, and a walk round the block is not two hours. Set
  // below the group and flagged rather than taken straight, which is the one
  // number here deliberately not the measured one.
  park: { perWeek: 0.45, household: false, intercept: 0.1, dwell: 85, spread: 0.75, budget: 0.6, window: [7 * 60, 20 * 60], slack: SLIDE, claimable: true },
};

/**
 * Who a purpose is for.
 *
 * Age gates are not decoration. A city where 15-year-olds go to bars and
 * 80-year-olds go clubbing is wrong in a way that shows up the first time
 * anybody looks at a venue's log, and the fix is one table.
 */
function appetite(purpose: string, person: Person, income: number): number {
  const age = person.age;
  switch (purpose) {
    case "bar":
      if (age < 21) return 0;
      return age < 30 ? 1.7 : age < 45 ? 1.15 : age < 60 ? 0.75 : 0.35;
    case "cafe":
      if (age < 14) return 0.15;
      return age < 25 ? 1.15 : age < 55 ? 1.2 : 0.8;
    case "food-quick":
      return age < 25 ? 1.45 : age < 45 ? 1.1 : age < 65 ? 0.8 : 0.5;
    case "food-sit":
      // The strongest income gradient of anything here, and the best-attested.
      return (age < 18 ? 0.5 : 1) * (income > 120000 ? 1.6 : income > 70000 ? 1.15 : income > 40000 ? 0.85 : 0.55);
    case "health":
      return age >= 65 ? 2.4 : age >= 45 ? 1.3 : age < 5 ? 2.0 : 0.8;
    case "park":
      return age < 12 ? 1.8 : age < 40 ? 1.1 : age < 65 ? 0.9 : 0.7;
    case "retail":
      return income > 90000 ? 1.35 : income > 45000 ? 1.0 : 0.7;
    case "grocery":
    case "convenience":
    case "errand":
    case "pharmacy":
    case "personal":
    case "vehicle":
      return age < 16 ? 0.1 : 1;
    default:
      return 1;
  }
}

/** Under-16s do not drive themselves anywhere, and mostly are not out alone. */
const INDEPENDENT_AGE = 16;

export interface TourContext {
  world: World;
  roads: Roads;
  venues: Venues;
}

/**
 * The day's discretionary stops for one person.
 *
 * `blocks` and `tour` are the roster's and the commute's answers, passed in
 * rather than recomputed — this layer's whole job is to fit around them, and a
 * version that re-derived them could fit around a different day than the one
 * the person is actually having.
 */
export function activitiesFor(
  context: TourContext,
  person: Person,
  date: Date,
  day: number,
  blocks: Block[],
  tour: Tour | null,
  /**
   * Spans already spoken for by a layer that outranks this one. Affiliations
   * run first and pass theirs in: a Tuesday small group is a commitment in a
   * way that buying shampoo is not, and the shampoo is what moves.
   *
   * Sleep arrives this way too, along with whatever of yesterday's shift is
   * still running after midnight. Both used to be a pair of constants here —
   * nobody in the city did anything before 06:00 or after 23:30 — which is why
   * a night-watch officer coming off at 07:00 could be sent to a café at 08:00
   * and, on the wrong side of it, could be sent to one at 06:14 while still on
   * patrol. Sleep is per person now and knows what the person did last night;
   * the span given here is the compressible one, so an evening that runs late
   * eats into the night rather than being refused by it.
   */
  committed: readonly (readonly [number, number])[] = [],
): DayPlan {
  const { world, venues } = context;
  const home = homeOf(world, person);
  const plan: DayPlan = { person: person.id, stops: [], trips: 0, extraKm: 0 };

  // Off the map is off the map. Someone working outside the extract does their
  // errands outside it too, and putting them in a Kierston shop at lunchtime
  // is the same error as counting them in a co-presence pool.
  if (!home || tour?.offMap) return plan;
  if (person.age < INDEPENDENT_AGE) return plan;

  const household = world.households.get(person.household);
  const income = household?.income ?? 45000;
  const rng = stream(world.seed, person.id, LAYER.stopChoice, day);

  const work = blocks.find((block) => block.kind === "work") ?? null;
  /**
   * Three tests, not one, because "is this person busy" depends on what is
   * asking. An intercept happens *inside* a commute leg and a lunch break
   * happens *inside* a shift — testing either against a span it is a part of
   * rejects every one of them, which is how the first version of this produced
   * a city where nobody ever stopped for anything.
   *
   *   commitments  hard blocks, affiliations, sleep, stops already placed
   *   legs         the journeys, which an excursion collides with and an
   *                intercept extends
   *   inside work  what a meal break is allowed to overlap: its own shift
   */
  const commitments: [number, number][] = [
    ...blocks.filter((block) => block.fixed).map((block) => [block.start, block.end] as [number, number]),
    ...committed.map(([a, b]) => [a, b] as [number, number]),
  ];
  const legs: [number, number][] = (tour?.legs ?? []).map((leg) => [leg.depart, leg.arrive]);
  const taken: [number, number][] = [];

  const clear = (spans: readonly (readonly [number, number])[], from: number, to: number) =>
    spans.every(([a, b]) => to <= a || from >= b);
  const freeOnRoute = (from: number, to: number) => clear(commitments, from, to) && clear(taken, from, to);
  const freeEntirely = (from: number, to: number) => freeOnRoute(from, to) && clear(legs, from, to);

  const outbound = tour?.legs.find((leg) => leg.purpose === "work") ?? null;
  const back = tour?.legs.find((leg) => leg.purpose === "home") ?? null;

  for (const [purpose, demand] of Object.entries(DEMAND) as [Purpose, Demand][]) {
    const wanted = purpose === "fuel"
      ? wantsFuel(world, person, tour, day)
      : rng.bool(dailyRate(purpose, demand, person, household?.size ?? 1, income, world.seed, date));
    if (!wanted) continue;

    const at = timeFor(purpose, demand, weekday(date) >= 5, rng);
    const intercepted = rng.bool(demand.intercept);

    /**
     * Which leg, if either.
     *
     * The drawn time chooses the leg; it does not have to *match* it. That
     * distinction is the whole mechanism and getting it backwards is what the
     * first version did — it drew a grocery run for three in the afternoon,
     * found no leg within an hour of three, and sent the person out on a
     * special trip. But somebody who wants groceries on a working day does not
     * go at three, they go at half past six on the way home, and the drawn
     * hour was only ever expressing *which end of the day* they lean toward.
     * So the window picks the leg and then the leg picks the minute.
     *
     * Testing the drawn time against the leg times instead cut the intercept
     * rate to 6% against the 30–90% these purposes are actually intercepted at,
     * and every one of the trips it lost came back as a car journey that should
     * never have happened.
     */
    const wantsEvening = at > 13 * 60;
    const first = wantsEvening ? back : outbound;
    const second = wantsEvening ? outbound : back;

    // A stop is only worth intercepting on a leg that is going somewhere the
    // stop can happen: nobody buys a pint on the way *to* the early shift.
    const usable = (leg: typeof outbound, when: number) =>
      leg !== null && when >= demand.window[0] - 90 && when <= demand.window[1] + 90;

    let stop: Stop | null = null;
    for (const leg of [first, second]) {
      if (!intercepted || !leg) continue;
      if (!usable(leg, leg.depart)) continue;
      stop = intercept(context, person, purpose, demand, leg.from, leg.to, leg.depart,
        leg.purpose === "work" ? "to-work" : "to-home", rng);
      if (stop) break;
    }

    if (stop && !freeOnRoute(stop.arrive - 5, stop.leave + 5)) stop = null;

    if (!stop) {
      const site = placeOf(world, work?.site ?? null);
      const base = work && !work.fixed ? home : atThatHour(at, work, home, site);
      if (!base) continue;
      stop = excursion(context, person, purpose, demand, base, at, base === site ? "from-work" : "from-home", rng);
      if (stop && !freeEntirely(stop.arrive - 5, stop.leave + 5)) continue;
    }
    if (!stop) continue;

    plan.stops.push(stop);
    taken.push([stop.arrive - 5, stop.leave + 5]);
    plan.extraKm += stop.detourKm;
    plan.trips += stop.on === "to-work" || stop.on === "to-home" ? 1 : 2;
  }

  // The work lunch, which is neither of the two mechanisms above. It is tested
  // against everything except the shift it is a break from — `taken` and the
  // affiliations, not the work block.
  const lunch = midday(context, person, work, day, (a, b) => clear(committed, a, b) && clear(taken, a, b), rng);
  if (lunch) {
    plan.stops.push(lunch);
    plan.extraKm += lunch.detourKm;
    plan.trips += 2;
  }

  plan.stops.sort((a, b) => a.arrive - b.arrive);
  return plan;
}

/**
 * Daily probability from a weekly rate.
 *
 * Weekends are not weekdays for any of this, and flattening them would put the
 * same number of people in the shops on Sunday morning as on Tuesday morning.
 * The household purposes are divided by the household size and then given back
 * to one member, which is what makes a family have one weekly shop.
 */
function dailyRate(purpose: string, demand: Demand, person: Person, size: number, income: number, seed: number, date: Date): number {
  let perWeek = demand.perWeek * appetite(purpose, person, income);
  if (demand.household) {
    // Whoever does the food does it. A stable draw, not a nightly one: the
    // person who shops this week is the person who shopped last week.
    const shopper = stream(seed, person.household, LAYER.habit, 0).int(0, Math.max(0, size - 1));
    const rank = stream(seed, person.id, LAYER.habit, 1).int(0, Math.max(0, size - 1));
    if (rank !== shopper) perWeek *= 0.18;
  }

  const dow = weekday(date);
  const weekend = dow >= 5;
  const shift = purpose === "retail" || purpose === "park" || purpose === "grocery"
    ? (weekend ? 1.55 : 0.82)
    : purpose === "bar"
      ? (dow === 4 || dow === 5 ? 2.1 : 0.6)
      : purpose === "errand" || purpose === "health" || purpose === "personal"
        ? (weekend ? 0.25 : 1.3)
        : 1;

  return Math.min(0.95, (perWeek * shift) / 7);
}

/**
 * Fuel, from distance rather than from a rate.
 *
 * A tank is state, and this layer has none by design — a person's Tuesday has
 * to be reproducible without running Monday first. So instead of tracking a
 * level, the day's driven distance is divided by the range of a tank, which
 * gives the right refuelling *rate* over any window long enough to matter
 * without ever storing a litre. The cost is that refuelling is memoryless
 * where a real one is periodic, and someone can fill up twice in a week.
 *
 * `vehicles.bin` has the actual car and would give a real range per person;
 * wiring that in is the obvious next thing and needs the fuel model to exist.
 */
const TANK_RANGE_KM = 520;

/**
 * The rest of the day's driving, which this layer cannot see when it asks.
 *
 * The commute is the only journey that exists at the moment `wantsFuel` runs —
 * every other trip is generated by the loop this sits inside, so asking how far
 * someone drove today is asking a question whose answer is still being written.
 * A constant is the only honest way out, and it is the city's own measured
 * figure rather than a flattering one: a full-city day drives 635,566 car
 * kilometres against roughly 278,000 of commuting, so about four kilometres per
 * adult per day happen off the commute.
 *
 * Deliberately not raised to whatever would land fuel on CEX. The city drives
 * about a fifth of what a real household's fuel bill implies, and that is a
 * fault in trip generation and the transit fallback. Hiding it inside this
 * constant would make the fuel numbers look right for the wrong reason.
 */
const OFF_COMMUTE_KM = 4;

/**
 * Who can refuel, and how likely they are to today.
 *
 * The commute used to be a precondition and not merely an input, so a day with
 * no journey to work could not produce a fill-up however far the person drove.
 * That deleted two thirds of adult-days outright — retirees, days off, anyone
 * working from home — and with them the whole idea of driving to the station as
 * an errand, which is what a person without a commute to hang it on would do.
 * Now the commute only contributes its kilometres, and the test is whether the
 * person drives at all.
 */
function wantsFuel(world: World, person: Person, tour: Tour | null, day: number): boolean {
  // No car in the household is a harder no than any draw: `world.carless` is
  // the vehicle registry's silence, not a probability.
  if (world.carless.has(person.household)) return false;
  // `modeOf` answers "car" for a stated driver and for any adult nobody
  // surveyed, and "carpool" for under-16s, so this is the age test as well.
  if (modeOf(person) !== "car") return false;
  const commute = tour
    ? tour.legs.reduce((total, leg) => total + (leg.parking ? leg.kilometres : 0), 0)
    : 0;
  const km = commute + OFF_COMMUTE_KM;
  return stream(world.seed, person.id, LAYER.errand, day, 7).bool(Math.min(0.4, km / TANK_RANGE_KM));
}

function timeFor(purpose: Purpose, demand: Demand, weekend: boolean, rng: Rng): number {
  const drawn = drawMinute(purpose, weekend, rng);
  if (drawn !== null) return drawn;
  const [from, to] = demand.window;
  // Triangular toward the middle of the window rather than uniform across it.
  // Uniform gives a flat day, and nothing in a city is flat.
  return Math.round((from + to) / 2 + ((rng.next() + rng.next() - 1) * (to - from)) / 2);
}

/** A stop on a journey already being made. */
function intercept(
  context: TourContext,
  person: Person,
  purpose: Purpose,
  demand: Demand,
  from: Point,
  to: Point,
  depart: number,
  on: "to-work" | "to-home",
  rng: Rng,
): Stop | null {
  const venue = context.venues.chooseOnRoute(from, to, purpose, demand.budget, rng, depart + 12);
  if (!venue) return null;

  const direct = context.roads.trip(from, to, depart);
  const first = context.roads.trip(from, venue, depart);
  const second = context.roads.trip(venue, to, depart + first.minutes + demand.dwell);
  const detourMinutes = first.minutes + second.minutes - direct.minutes;
  const detourKm = Math.max(0, first.kilometres + second.kilometres - direct.kilometres);

  const arrive = Math.round(depart + first.minutes);
  return {
    purpose,
    venue,
    arrive,
    leave: Math.round(arrive + dwellFor(demand, rng)),
    on,
    detourKm: Math.round(detourKm * 100) / 100,
    detourMinutes: Math.round(detourMinutes),
    slack: demand.slack,
    claimable: demand.claimable,
  };
}

/** A journey made for its own sake, out and back from wherever the person is. */
function excursion(
  context: TourContext,
  person: Person,
  purpose: Purpose,
  demand: Demand,
  base: Point,
  at: number,
  on: "from-home" | "from-work",
  rng: Rng,
): Stop | null {
  const venue = context.venues.habitual(context.world.seed, person.id, base, purpose, rng, at);
  if (!venue) return null;

  const out = context.roads.trip(base, venue, at);
  const arrive = Math.round(at);
  const stay = dwellFor(demand, rng);
  return {
    purpose,
    venue,
    arrive,
    leave: Math.round(arrive + stay),
    on,
    // Both ways, because none of this journey would have happened otherwise.
    detourKm: Math.round(out.kilometres * 200) / 100,
    detourMinutes: Math.round(out.minutes * 2),
    slack: demand.slack,
    claimable: demand.claimable,
  };
}

/**
 * Lunch, which is its own mechanism and not a stop on anything.
 *
 * It leaves from work, not from home, and it comes back — which makes it the
 * one trip in the day whose origin is the workplace, and the reason the
 * midday peak exists at all in the venue logs. Whether it happens is mostly
 * whether the person brought food, and that is the majority answer.
 *
 * The group version of this is not a deliberate meeting. Nobody negotiates lunch
 * with a colleague a week out; it emerges from three people in the same unit
 * taking the same break window and walking to the same place, and it will fall
 * out of the co-presence pools during execution without being planned. That is the
 * distinction the meetings layer has to respect: deliberate meetings are
 * scheduled, work lunches are not.
 */
const BRINGS_LUNCH = 0.62;

/** Median minutes for the meal break, by what was bought. See `midday`. */
const LUNCH: Partial<Record<Purpose, number>> = {
  "food-sit": 55,
  "food-quick": 32,
  convenience: 12,
  cafe: 20,
};

/**
 * How much a meal break varies, and the longest one anybody takes.
 *
 * Both fitted to the lunch subset of NHTS rather than to meals in general,
 * because a break is a tighter thing than a meal: WHYTO 13 arrived at between
 * 11:00 and 14:00 has a median of 35 minutes, p90 of 90 and p95 of 134, which
 * solves to σ ≈ 0.78 from either tail. The `buy meals` group as a whole gives
 * 0.95, and using that here was wrong — an evening out has a spread a lunch
 * hour does not, and the difference came out as 10.4% of breaks running past
 * two hours against a real 5.6%.
 *
 * `MAX` is NHTS's 99th percentile and a backstop rather than a shaper. The
 * binding limit in almost every case is the shift, below.
 */
const LUNCH_SPREAD = 0.78;
const LUNCH_MAX = 250;
/** Below this there is no point going out at all. */
const LUNCH_MIN = 8;

function midday(context: TourContext, person: Person, work: Block | null, day: number, free: (a: number, b: number) => boolean, rng: Rng): Stop | null {
  if (!work || !work.fixed) return null;
  if (work.mode !== "sited") return null;
  const site = placeOf(context.world, work.site);
  if (!site) return null;

  // A shift has to be long enough to have a middle, and the break has to fall
  // inside it — a 06:00–14:00 watch takes its meal at 10:30, not at noon.
  const length = work.end - work.start;
  if (length < 5 * 60) return null;
  const at = work.start + Math.min(length / 2, 4 * 60 + rng.gauss(0, 25));
  if (at < work.start + 90 || at > work.end - 60) return null;

  if (stream(context.world.seed, person.id, LAYER.meal, day).bool(BRINGS_LUNCH)) return null;

  const purpose: Purpose = rng.weighted(["food-quick", "food-sit", "convenience", "cafe"], [0.52, 0.16, 0.24, 0.08]);
  // Lunch is walked if it can be. The choice set is what is near the office,
  // which is why the budget is small and the venue is chosen from the site
  // rather than from home — a person's habitual café is near their house and
  // has nothing to do with where they eat at one o'clock.
  const venue = context.venues.choose(site, purpose, rng, at);
  if (!venue) return null;

  const km = haversineKm(site, venue);
  const walked = km < 0.7;
  const travel = walked ? (km * 1000) / 78 : context.roads.trip(site, venue, at).minutes + 3;

  // The meal break has its own lengths and does not read DEMAND's, because a
  // break is bounded in two ways an evening out is not, and both bounds are
  // applied here rather than assumed.
  //
  // The shift is the first: the person has to be back at their desk, so what
  // is left of the shift after the walk there and the walk back is the most
  // the meal can possibly be. The second is NHTS's own lunch tail, which is a
  // backstop for the shift that is fourteen hours long.
  //
  // Drawing this unbounded was a real bug and not a cosmetic one. It produced
  // five-hour lunches sitting on top of stops the person had already been
  // given, because the free test below asked about a flat forty-five minutes —
  // safe when the three lengths this used to pick from topped out at 42, and
  // wrong the moment the length became a draw.
  const room = Math.min(LUNCH_MAX, work.end - Math.round(at + 2 * travel));
  if (room < LUNCH_MIN) return null;
  const stay = Math.min(room, dwellFor(
    { ...DEMAND[purpose]!, dwell: LUNCH[purpose] ?? 30, spread: LUNCH_SPREAD },
    rng,
  ));

  // Now the length is known, so the question can be the real one: is the
  // person free for the whole time they are away from the office — there, the
  // meal, and back — rather than for a constant that has nothing to do with it.
  const arrive = Math.round(at + travel);
  const leave = Math.round(at + travel + stay);
  if (!free(at - 5, Math.round(leave + travel + 5))) return null;

  return {
    purpose,
    venue,
    arrive,
    leave,
    on: "from-work",
    detourKm: walked ? 0 : Math.round(km * 200) / 100,
    detourMinutes: Math.round(travel * 2),
    // What the shift has left after this meal, and never the purpose's own
    // allowance: a break is bounded by having to be back at the desk, and the
    // room was already solved for above. A lunch that slid the full thirty
    // minutes a café is otherwise allowed would be a person walking back in
    // half an hour late.
    slack: Math.max(0, Math.min(DEMAND[purpose]!.slack, room - stay)),
    claimable: false,
  };
}

function dwellFor(demand: Demand, rng: Rng): number {
  // Lognormal, and now measurably so rather than "lognormal-ish": fitting σ
  // from NHTS `DWELTIME` at the 10th percentile and at the 90th gives the same
  // answer within a few hundredths for every purpose group, which is the test
  // the shape had never been put to.
  //
  // Drawn about zero rather than about -0.1, so `dwell` is the median of what
  // comes out instead of sitting 10% above it. The old offset made every
  // number in DEMAND mean something slightly other than it said.
  return Math.max(3, Math.round(demand.dwell * Math.exp(rng.gauss(0, demand.spread))));
}

/** Where someone is at a given minute, for a trip that starts from there. */
function atThatHour(at: number, work: Block | null, home: Point, site: Point | null): Point | null {
  if (work && site && work.fixed && at >= work.start && at <= work.end) return site;
  return home;
}

export { DEMAND, TANK_RANGE_KM };

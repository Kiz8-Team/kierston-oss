/**
 * Every movement between two places, as a routed leg.
 *
 * The layers above this one each place a person somewhere: the roster puts
 * them at a site, affiliations put them in a hall on Tuesday evening, tours put
 * them in a shop. None of them can say how the person got there, because none
 * of them knows what the others decided — the commute layer cannot know that
 * the 18:40 arrival at the lodge is coming from the office rather than from the
 * front door, and it is coming from the office, which is a different trip on a
 * different road at a different hour.
 *
 * So travel is not generated per activity. It is generated once, at the end,
 * from the whole day: the day is a sequence of stays, and every gap between two
 * consecutive stays at different places is a journey that gets routed. The
 * scheduler decides that sequence; this module prices one journey of it at a
 * time. That division is the only construction that makes the day closed — a
 * person who is at the supermarket at 18:10 and at the lodge at 18:40 has a
 * thirty-minute journey between them whether or not any layer thought to
 * generate one, and before this module existed they simply teleported. Only the
 * work commute had legs.
 *
 * What pricing a journey involves beyond the distance
 * ---------------------------------------------------
 *   the car is somewhere    A vehicle does not follow its owner around. The car
 *                           is at the last place it was driven to, so walking
 *                           away from it is only allowed where the person comes
 *                           straight back — and where they somehow do not, the
 *                           walk back to it is a leg of its own, with the
 *                           purpose `vehicle`. Without a car location a
 *                           simulated person drives away from places their car
 *                           is not, which is free distance out of nowhere.
 *
 *   two directions          `estimateTransition` answers "when must they leave
 *                           to arrive by then", which is the only question a
 *                           fixed arrival can be solved with; `priceTransition`
 *                           answers "leaving now, what does the journey cost",
 *                           which is the only question the roads can answer.
 *                           The scheduler uses both, in that order.
 *
 *   modes are per trip      A driver walks some short hops and drives others,
 *                           drawn rather than thresholded, which is what puts
 *                           the lunchtime trade on foot and leaves the evening
 *                           supermarket in the car.
 *
 * Congestion is priced from a provisional departure and then again from the
 * resolved one, two passes, which is the same trick `departureFor` uses and for
 * the same reason: the duration depends on the minute, and the minute depends
 * on the duration.
 */

import type { Person, Point } from "../world/index.ts";
import type { Kerb, Parking } from "./parking.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import { ACCESS_MINUTES, haversineKm, type Roads } from "./routing.ts";

/**
 * `taxi` is riding in one and `cab` is driving one, and they are two modes for
 * the same reason `bus` and `passenger` are.
 *
 * A passenger whose usual mode is a taxicab has no car, so a short trip of
 * theirs is a candidate to be walked instead. A driver's short trip is not a
 * candidate for anything — it is the job, and the cab goes where the job is.
 * One mode covering both meant every deadhead under a kilometre came out as the
 * driver getting out and walking.
 */
export type LegMode =
  | "car" | "carpool" | "transit" | "walk" | "bike" | "taxi" | "cab" | "bus" | "passenger"
  // At the wheel of a marked patrol car, which is a mode for the same reason
  // `cab` is one: the vehicle is not the officer's, their own car is standing
  // at the station, and none of a shift's movement is a candidate to be walked
  // instead. It is not in DRIVING, because the kilometres are the city's fleet
  // and not this person's driving.
  | "patrol"
  | "ambulance"
  | "other";

/**
 * What is at the far end, which is what the leg was made for.
 *
 * `school` is a student's own trip, `escort` is the adult making it for them,
 * and `run` is a leg of a school bus route. The three are separated rather than
 * folded into `work` because they answer different questions of the same day:
 * one drop-off is one child's arrival, one parent's detour, and one of a
 * driver's forty stops, and a count of school trips that could not tell them
 * apart would treat all three as the same trip.
 *
 * `fare` and `deadhead` are the cab driver's half of a taxi trip and split for
 * the same reason, except here the split is the entire point of measuring it.
 * A cab with a passenger in it and a cab driving across town to collect one are
 * the same vehicle on the same road, and the share of its kilometres spent
 * empty is the number that says whether a fleet is the right size. Folding them
 * together would make that unrecoverable.
 */
export type LegPurpose =
  | "work" | "home" | "stop" | "affiliation" | "vehicle"
  | "school" | "escort" | "run"
  | "fare" | "deadhead"
  // A patrol car moving between the points of its beat. Not `work`: the shift
  // is the driving, so counting it as a commute would put ninety kilometres of
  // a watch into the city's journey-to-work distribution.
  | "patrol"
  // A unit sent to a call for service, police or EMS.
  | "response"
  // Going to meet somebody. Separate from `stop` although the far end is often
  // the same building, because the two answer different questions: a café visit
  // that exists because a friend is in it is not trip generation, it is a tie
  // being exercised, and a count that folded them together could not say which
  // of the city's evenings were social.
  | "meet";

export interface Leg {
  /** Stable identity across demand and dispatched passes. */
  journeyId?: string;
  /** The physical registered vehicle used by this movement, where one exists. */
  vehicleId?: string;
  purpose: LegPurpose;
  mode: LegMode;
  from: Point;
  to: Point;
  fromLabel: string;
  toLabel: string;
  depart: number;
  arrive: number;
  kilometres: number;
  estimated: boolean;
  /** Present on driving legs. The walk from the space is inside `arrive`. */
  parking?: Parking;
  /**
   * Minutes of this leg spent waiting rather than moving, which is a taxi.
   *
   * Inside `depart`..`arrive` already — the field is here so a check can
   * recover it, because the wait is the whole difference between a cab and a
   * car and it is invisible in a duration that has absorbed it.
   */
  wait?: number;
}

/** The label every dwelling carries, so a leg can be recognised as starting there. */
export const HOME_LABEL = "home";

export interface Place extends Point {
  /** Place id where there is one — a site, a venue, an org. Null for a dwelling. */
  id: string | null;
  kind: "home" | "work" | "venue" | "org" | "school" | "stop" | "depot" | "kerb" | "stand";
  label: string;
}

/**
 * A stay somewhere, from one layer's point of view.
 *
 * The shape the school and taxi layers describe somebody else's journey in.
 * `fixed` says the stay cannot move, so the travel around it is solved to meet
 * it; `ref` is the producing layer's own object, which the scheduler reads to
 * derive the journey id both halves of a shared trip carry.
 */
export interface Sojourn<T = unknown> {
  place: Place;
  arrive: number;
  leave: number;
  fixed: boolean;
  purpose: LegPurpose;
  ref: T;
  /**
   * How the leg *arriving here* is travelled, where the person's usual mode is
   * not the answer.
   *
   * A school bus is the case this exists for, from both ends. The child riding
   * it is not walking and is not in the family car; the driver at the wheel is
   * not in their own car either, which is parked at the depot. Neither is
   * expressible as a property of the person, because both are properties of
   * this particular leg — the same driver drives home in their own car an hour
   * later.
   */
  mode?: LegMode;
  /**
   * How long the leg arriving here takes, where something outside this module
   * already knows.
   *
   * Only the bus run uses it. A run is priced once, as one multi-waypoint path
   * over the whole route, and every rider's boarding minute is read off that
   * one answer — so re-routing the hop from a child's stop to their school
   * would produce a second, shorter, wrong number for a journey the bus makes
   * with thirty other children and eleven more stops on it.
   */
  minutes?: number;
  /**
   * The same, for the leg *leaving* here.
   *
   * Needed because a journey has two ends and only one of them is a stay this
   * module was given. A child collected from school is driven home, and home is
   * a stay the scheduler adds rather than one the school layer handed over —
   * there is nothing to hang the mode on except the school they are leaving.
   * Without it their ride home was priced as whatever their *morning* trip was,
   * so a child who walked in and was collected by car had the drive home
   * recorded as a walk.
   *
   * `mode` on the arriving stay wins where both are set: the bus stop knows it
   * is a bus better than the school knows what happens after the bell.
   */
  leaveMode?: LegMode;
  /** Registered vehicle used by the arriving/leaving vehicle movement. */
  vehicleId?: string;
}

export interface TravelContext {
  roads: Roads;
  kerb: Kerb;
  seed: number;
  /** The day's cab assignments, where the dispatch pass has run. */
  dispatch?: Dispatch | null;
  /**
   * How often this person's non-walked trips are actually a cab.
   *
   * Per person and not per city, which is why it is on the context: the context
   * is built for one person's day. 1 is somebody who told the survey they
   * commute by taxi and for whom the cab is simply how they travel; anything
   * less is `hire.ts` inferring that no car is available to them, where the rest
   * of their trips fall back to a bus. Absent means the same as 1, so a caller
   * that knows nothing about this — the school layer, the checks — cannot
   * silently suppress a stated cab commuter's fares.
   */
  hireShare?: number;
}

/**
 * A walked hop taken because no cab came: where it ended and what it cost.
 *
 * Somebody who cannot get a car does not stand at the kerb until one appears.
 * They set off on foot in the direction they were going and try again from
 * further along, which is both what people do and the only fallback that leaves
 * the trip's geometry honest — a fare that fails at 20:14 outside a bar and
 * succeeds at 20:24 nine hundred metres down the road is two different pickups
 * for the fleet and one continuous journey for the person.
 */
export interface Hop {
  to: Point;
  minutes: number;
  kilometres: number;
}

/**
 * What the dispatcher did with one request.
 *
 * `walk` means they gave up and finished on foot; `via` is then the whole
 * walked path, ending at the destination. `transit` means even that was too far
 * — the last resort, and a number worth watching rather than a case worth
 * hiding, because a fleet that produces many of them is too small.
 */
export type FareOutcome =
  | { kind: "ride"; driver: number; wait: number; minutes: number; kilometres: number; via: Hop[] }
  | { kind: "walk"; via: Hop[] }
  | { kind: "transit" };

/**
 * The day's cab assignments, as something a person's day can read.
 *
 * Structural on purpose: `taxi.ts` imports this module for its types, so this
 * module cannot import `taxi.ts` back. The interface is the seam.
 */
export interface Dispatch {
  fareFor(person: number, day: number, from: Point, to: Point, departAt: number, journeyId?: string): FareOutcome | null;
}

/**
 * JWTRNS to a mode the router can price.
 *
 * The codes are the ACS ones and not a guess: 1 is car/truck/van, 2 through 6
 * are the transit modes, 7 taxicab, 8 motorcycle, 9 bicycle, 10 walked, 11
 * worked from home, 12 other.
 *
 * There is no carpool code. JWTRNS does not distinguish driving alone from
 * riding with someone — that is JWRIP, vehicle occupancy, which the synthesis
 * stage does not currently carry.
 */
const MODE: Record<string, LegMode> = {
  "1": "car",
  "2": "transit",
  "3": "transit",
  "4": "transit",
  "5": "transit",
  "6": "transit",
  "7": "taxi",
  "8": "other",
  "9": "bike",
  "10": "walk",
  "11": "other",
  "12": "other",
};

export const DRIVING: ReadonlySet<LegMode> = new Set<LegMode>(["car", "carpool", "taxi", "cab"]);

/**
 * The two modes where the vehicle is not the traveller's own.
 *
 * It arrives, it leaves, and it is not standing outside afterwards waiting to
 * be walked back to — so neither of them can strand a car and neither of them
 * parks one.
 */
const HIRED: ReadonlySet<LegMode> = new Set<LegMode>(["taxi", "cab"]);

/**
 * The mode a person travels by, which is the survey's answer where they gave
 * one and the household's car where they did not.
 *
 * `travels` is the discretionary version of the same question and it is not the
 * same answer. JWTRNS is *how you get to work*, and a bus commuter with a car
 * on the drive does not take the bus to the supermarket at nine on a Sunday.
 * Rather than invent a second mode table this treats the commute mode as the
 * mode for everything and accepts the bias, which pushes non-work transit trips
 * up and non-work car trips down. It is the largest known error in this module.
 */
export function modeOf(person: Person): LegMode {
  if (person.transport === null || person.transport === undefined) {
    // Nobody surveyed them, because they do not commute: children, retirees,
    // anyone out of the labour force. Under-16s are passengers when the trip is
    // too far to walk, which is what `carpool` means here.
    return person.age < INDEPENDENT_AGE ? "carpool" : "car";
  }
  return MODE[person.transport] ?? "car";
}

const INDEPENDENT_AGE = 16;

/**
 * Whether a short trip is walked, as a probability rather than a threshold.
 *
 * A threshold was the first version and it was wrong in a way the aggregate
 * showed immediately: every trip under the distance became a walk and the
 * city's walk mode share came out at 30% of all trips, against a national
 * figure around a tenth. The error is not the distance, it is the determinism.
 * Half a kilometre to the shop is walked by some people on some days and driven
 * by the same people on others, and what decides it — the weather, the load,
 * the hurry, whether the car is already out — is nothing this model has. So it
 * is a draw, and the shares below are the NHTS answer for trips of that length
 * in a small city: most short trips in America are still driven.
 *
 * Someone with no car in the household is a different question and walks a
 * great deal further before the trip becomes a bus ride.
 */
const CARLESS_WALK_KM = 2.4;

function walkShare(usual: LegMode, km: number): number {
  if (usual === "walk") return 1;
  // Being driven is not a mode somebody switches out of. A child whose parent
  // takes them to school does not walk on the days the trip is short — the
  // decision was the adult's and it was made for the whole journey.
  if (usual === "passenger" || usual === "bus" || usual === "cab" || usual === "patrol" || usual === "ambulance") return 0;
  if (usual === "bike") return km <= 0.4 ? 0.5 : 0;
  // Somebody who takes a cab to work is in neither of the two groups below and
  // needs a curve of their own.
  //
  // They are not a driver: there is no car on the drive, so the eight hundred
  // metres to the shop is a walk and not a trip, and leaving them in the driver
  // branch invented a summoned, metered fare for every one of them. But they
  // are not the carless case either, which assumes the alternative to walking
  // is a timetable — for this person the alternative to walking is the thing
  // they already told the survey they do daily and evidently pay for. Using the
  // carless shares put them on foot for two kilometres each way and emptied the
  // city of taxi trips almost entirely.
  if (usual === "taxi") return km <= 0.4 ? 0.85 : km <= 0.8 ? 0.6 : km <= 1.6 ? 0.28 : 0;
  if (!DRIVING.has(usual)) {
    // No car in the answer they gave, so the alternative to walking is a fare
    // or a timetable, and the distance people accept on foot goes up sharply.
    return km <= 0.8 ? 0.92 : km <= CARLESS_WALK_KM ? 0.62 : 0;
  }
  if (km <= 0.25) return 0.72;
  if (km <= 0.5) return 0.38;
  if (km <= 0.8) return 0.2;
  if (km <= 1.2) return 0.07;
  return 0;
}

/**
 * The draw, keyed on the pair of places and not on the direction.
 *
 * Two properties, both load-bearing. It has to be stable across passes, because
 * both the backward solve and the forward pricing ask the same question and a
 * day solved against a mode it does not travel by is not a day. And it has to
 * be symmetric, because nobody walks to the shop and drives back: keying on the
 * unordered pair is what makes the return trip agree with the outbound one.
 */
function walkDraw(seed: number, person: Person, day: number, from: Place, to: Place): number {
  const a = placeKey(from);
  const b = placeKey(to);
  return new Rng(mix(seed, person.id, LAYER.routeChoice, day, Math.min(a, b), Math.max(a, b))).next();
}

/**
 * Whether this particular trip is the one they pay for.
 *
 * Somebody with no car of their own does not take a cab everywhere. They walk
 * what is walkable — `walkShare` gives the taxi mode its own, much longer curve
 * for exactly this reason — and of what is left, some is a bus, some is a lift
 * from a neighbour this simulation cannot see, and some is a fare. This is the
 * split, and it is drawn rather than thresholded for the same reason the walk
 * is: what decides it is the shopping, the weather and the hour, none of which
 * this model has.
 *
 * Keyed on the unordered pair of places, like `walkDraw`, and for both of the
 * same reasons. Stable, so the backward solve and the forward pricing agree —
 * and, more sharply here, so that the demand pass and the dispatched pass ask
 * for a car on the same trips, which is the invariant the whole two-pass
 * construction in `taxi.ts` rests on. Symmetric, because nobody takes a cab to
 * the surgery and a bus home from it.
 *
 * A separate layer from the walk draw, so that raising one does not quietly
 * correlate with the other.
 */
function hires(context: TravelContext, person: Person, day: number, from: Place, to: Place): boolean {
  const share = context.hireShare ?? 1;
  if (share >= 1) return true;
  if (share <= 0) return false;
  const a = placeKey(from);
  const b = placeKey(to);
  return new Rng(mix(context.seed, person.id, LAYER.hire, day, Math.min(a, b), Math.max(a, b))).next() < share;
}

function placeKey(place: Place): number {
  if (place.id !== null) {
    let h = 0;
    for (let i = 0; i < place.id.length; i += 1) h = (Math.imul(h, 31) + place.id.charCodeAt(i)) | 0;
    return h;
  }
  return Math.round(place.lat * 1e5) ^ Math.round(place.lon * 1e5);
}

/** Cycling speed, km/h, on the routed distance. */
const BIKE_KPH = 15;

/**
 * Transit, off the survey and onto a factor.
 *
 * The commute layer believes JWMNP because the respondent gave it. There is no
 * such number for a trip to the shops, and there is no line geometry to route
 * on, so a bus trip is priced as the drive plus the two things that make it a
 * bus trip: the wait, and the fact that it stops. Both are constants and both
 * are guesses, flagged `estimated` so nothing downstream mistakes them for a
 * routed answer.
 */
const TRANSIT_FACTOR = 1.9;
const TRANSIT_WAIT = 8;

/**
 * How long the passenger expects to wait for a cab, in minutes.
 *
 * This is not the wait they get — that is the dispatcher's answer and it varies
 * with where the nearest free car happens to be. It is what they *allow*, and
 * the distinction is what keeps the two-pass construction honest.
 *
 * The demand pass and the real pass both plan the day against this constant, so
 * a person requests their cab at the same minute in both and the assignment
 * made in between is still addressed to a fare that exists. Then the real pass
 * charges the wait that actually happened, and the difference between the two
 * is not an inconsistency to be reconciled — it is the passenger being late,
 * which is exactly what happens to somebody whose cab took eleven minutes when
 * they had allowed seven, and which the scheduler already records as lateness.
 *
 * Feed the realised wait back into the planning instead and the loop does not
 * close: a longer wait moves the request earlier, which moves the assignment,
 * which moves the wait.
 */
export const NOMINAL_WAIT = 5;

export interface Segment {
  purpose: LegPurpose;
  mode: LegMode;
  from: Place;
  to: Place;
  minutes: number;
  kilometres: number;
  estimated: boolean;
  parking?: Parking;
  wait?: number;
  vehicleId?: string;
}

/**
 * Door-to-door minutes, for the backward pass.
 *
 * It has to agree with what the forward pass will charge, or the person is sent
 * off in time for a journey they are not about to make. So it prices the same
 * parking, from the same deterministic supply, and the residual gap between the
 * two is only the congestion the departure minute moved.
 */
export function estimateTransition(
  context: TravelContext,
  person: Person,
  day: number,
  usual: LegMode,
  from: Place,
  to: Place,
  arriveBy: number,
): number {
  const straight = haversineKm(from, to);
  if (walks(usual, straight, walkDraw(context.seed, person, day, from, to))) return context.roads.walk(from, to).minutes;

  // The trip a carless person is not paying for. Priced as a bus, which is what
  // the forward pass will charge for it too — see `price`.
  if (usual === "taxi" && !hires(context, person, day, from, to)) {
    return context.roads.trip(from, to, arriveBy).minutes * TRANSIT_FACTOR + TRANSIT_WAIT;
  }

  const survey = surveyMinutes(person, usual, from, to);
  if (survey !== null) return survey;

  if (usual === "cab") return context.roads.departureFor(from, to, arriveBy).minutes + ACCESS_MINUTES;
  if (usual === "bike") return (context.roads.trip(from, to, arriveBy).kilometres / BIKE_KPH) * 60;
  if (usual === "passenger") return context.roads.departureFor(from, to, arriveBy).minutes + ACCESS_MINUTES;
  if (!DRIVING.has(usual)) return context.roads.trip(from, to, arriveBy).minutes * TRANSIT_FACTOR + TRANSIT_WAIT;

  const trip = context.roads.departureFor(from, to, arriveBy);
  // Deliberately the nominal wait and not the dispatcher's. See NOMINAL_WAIT:
  // this is the pass that decides when the person asks for a car, and it has to
  // give the same answer before and after the cars have been allocated.
  if (usual === "taxi") return trip.minutes + NOMINAL_WAIT;
  const parking = context.kerb.park(to, arriveBy, context.seed, person.id, to.kind === "home");
  return trip.minutes + ACCESS_MINUTES + parking.searchMinutes + parking.walkMinutes;
}

/**
 * The respondent's own commute time, where this leg is the commute.
 *
 * Transit and cycling are the two modes with no routed answer, and JWMNP is the
 * best one there is for the trip it was asked about. Using the generic factor
 * for a bus commute as well made every transit commuter late to work by the
 * difference between the two, which is not a modelling result — it is the same
 * trip priced twice by two different methods inside one day.
 */
function surveyMinutes(person: Person, usual: LegMode, from: Place, to: Place): number | null {
  if (DRIVING.has(usual) || usual === "walk") return null;
  if (usual === "passenger" || usual === "bus" || usual === "patrol" || usual === "ambulance") return null;
  if (!person.travel) return null;
  const commute = (from.kind === "home" && to.kind === "work") || (from.kind === "work" && to.kind === "home");
  return commute ? person.travel : null;
}

/** Is this trip walked, whatever the person's usual mode is? */
function walks(usual: LegMode, straightKm: number, draw: number): boolean {
  return draw < walkShare(usual, straightKm);
}

/**
 * Two places are the same place when they share an id, or — for dwellings and
 * kerbside points, which have none — when they are the same kind within thirty
 * metres of each other. The tolerance is here because a parking space and the
 * building it serves are two coordinates for one arrival.
 */
function samePlace(a: Place, b: Place): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.kind === b.kind && haversineKm(a, b) < 0.03;
}

/**
 * One journey, as the one or two legs it really takes.
 *
 * Two, when the car is not where the person is and the trip is not simply the
 * walk back to it. The planner's `returnsHere` rule means that is rare, and it
 * is kept because the rule is a heuristic about the *next* stay and later layers
 * will insert stays this module never saw.
 */
export function priceTransition(
  context: TravelContext,
  person: Person,
  day: number,
  usual: LegMode,
  carAt: Place | null,
  from: Place,
  to: Place,
  departAt: number,
  purpose: LegPurpose,
  returnsHere: boolean,
  fixedMinutes?: number,
  journeyId?: string,
): { segments: Segment[]; carAt: Place | null } {
  const { roads, kerb, seed } = context;
  const straight = haversineKm(from, to);
  const stranding = carAt !== null && samePlace(carAt, from) && !returnsHere;

  // A leg whose duration is already settled elsewhere: the school bus, whose
  // whole route was priced as one path. It takes the distance the road gives
  // and the time the run gives, and it leaves the car exactly where it was —
  // the driver's own car is at the depot and the child never had one.
  if (fixedMinutes !== undefined && usual !== "car") {
    const trip = roads.trip(from, to, departAt);
    return {
      segments: [{
        purpose,
        mode: usual,
        from,
        to,
        minutes: fixedMinutes,
        kilometres: trip.kilometres,
        estimated: trip.estimated,
      }],
      carAt,
    };
  }

  if (!stranding && walks(usual, straight, walkDraw(seed, person, day, from, to))) {
    const trip = roads.walk(from, to);
    return {
      segments: [{ purpose, mode: "walk", from, to, minutes: trip.minutes, kilometres: trip.kilometres, estimated: trip.estimated }],
      carAt,
    };
  }

  if (!DRIVING.has(usual)) {
    const trip = roads.trip(from, to, departAt);
    const survey = surveyMinutes(person, usual, from, to);
    const minutes = survey ?? (usual === "bike"
      ? (trip.kilometres / BIKE_KPH) * 60
      : usual === "passenger"
        ? trip.minutes + ACCESS_MINUTES
        : trip.minutes * TRANSIT_FACTOR + TRANSIT_WAIT);
    return {
      segments: [{ purpose, mode: usual, from, to, minutes, kilometres: trip.kilometres, estimated: true }],
      carAt,
    };
  }

  const segments: Segment[] = [];
  let origin = from;
  let at = departAt;

  // A taxi comes to the door and leaves nothing behind, so it never strands a
  // vehicle and never parks one. Nor does the cab a driver is at the wheel of:
  // their own car is at home, where it has been since the shift started.
  if (!HIRED.has(usual) && carAt && !samePlace(carAt, from)) {
    const back = roads.walk(from, carAt);
    // Where the car is parked at the destination, walking to it *is* the trip:
    // the person walked out and is walking home, and there is no drive.
    if (samePlace(carAt, to)) {
      return {
        segments: [{ purpose, mode: "walk", from, to, minutes: back.minutes, kilometres: back.kilometres, estimated: back.estimated }],
        carAt,
      };
    }
    segments.push({ purpose: "vehicle", mode: "walk", from, to: carAt, minutes: back.minutes, kilometres: back.kilometres, estimated: back.estimated });
    origin = carAt;
    at += back.minutes;
  }

  if (usual === "taxi") {
    // Too far to walk and not worth a fare: the bus, or the neighbour with the
    // van, priced the way every other unrouted transit trip is priced. It is a
    // real trip and it has to appear in the day — the alternative, dropping it,
    // would be a model in which people without cars simply do less.
    if (!hires(context, person, day, from, to)) {
      const trip = roads.trip(origin, to, at);
      return {
        segments: [...segments, {
          purpose,
          mode: "transit",
          from: origin,
          to,
          minutes: trip.minutes * TRANSIT_FACTOR + TRANSIT_WAIT,
          kilometres: trip.kilometres,
          estimated: true,
        }],
        carAt,
      };
    }
    return {
      segments: [...segments, ...fareSegments(context, purpose, person, day, origin, to, at, journeyId)],
      carAt,
    };
  }

  const provisional = roads.trip(origin, to, at + ACCESS_MINUTES);

  // A driver's own leg with no duration handed down — in practice only the
  // drive home at the end of the shift, since every leg the dispatcher planned
  // arrives here with its minutes already settled. No parking search: the cab
  // goes on the drive, and the search model is about competing for a kerb space
  // in town, which is not what happens outside a driver's own house.
  if (usual === "cab") {
    return {
      segments: [...segments, {
        purpose,
        mode: "cab",
        from: origin,
        to,
        minutes: provisional.minutes + ACCESS_MINUTES,
        kilometres: provisional.kilometres,
        estimated: provisional.estimated,
      }],
      carAt,
    };
  }

  const parking = kerb.park(to, at + ACCESS_MINUTES + provisional.minutes, seed, person.id, to.kind === "home");
  const parked: Place = {
      ...parking.at,
      id: null,
      kind: parking.kind === "driveway" ? "home" : "kerb",
      label: parking.kind === "driveway" ? to.label : `parked near ${to.label}`,
  };
  const trip = roads.trip(origin, parked, at + ACCESS_MINUTES);
  segments.push({
    purpose,
    mode: usual,
    from: origin,
    to: parked,
    minutes: fixedMinutes === undefined
      ? ACCESS_MINUTES + trip.minutes + parking.searchMinutes
      : Math.max(1, fixedMinutes - parking.walkMinutes),
    kilometres: trip.kilometres,
    estimated: trip.estimated,
    parking,
  });

  if (!samePlace(parked, to)) {
    const walked = roads.walk(parked, to);
    segments.push({
      purpose,
      mode: "walk",
      from: parked,
      to,
      minutes: Math.max(parking.walkMinutes, walked.minutes),
      kilometres: walked.kilometres,
      estimated: walked.estimated,
    });
  }

  return { segments, carAt: parked };
}

/**
 * One taxi journey, as the dispatcher resolved it.
 *
 * The passenger's side of `taxi.ts`. Everything interesting has already been
 * decided — which car, how long it took to arrive, whether one came at all —
 * and what is left here is turning that answer into legs, which is this
 * module's job and not the dispatcher's.
 *
 * The ride is priced from the dispatcher's own routing rather than re-routed.
 * Same argument as the school bus: the cab makes one journey, and a passenger
 * and a driver who each routed it separately would disagree about when it
 * arrived by however much the congestion multiplier moved between their two
 * departure minutes.
 */
function fareSegments(
  context: TravelContext,
  purpose: LegPurpose,
  person: Person,
  day: number,
  from: Place,
  to: Place,
  departAt: number,
  journeyId?: string,
): Segment[] {
  const { roads } = context;
  const outcome = context.dispatch?.fareFor(person.id, day, from, to, departAt, journeyId) ?? null;

  // No dispatch pass has run, or this leg was not among the demand it harvested.
  // A cab arrives in about the time a cab takes and nobody is driving it, which
  // is what the demand pass itself runs on and what the whole simulation ran on
  // before there were drivers in it.
  if (!outcome) {
    const trip = roads.trip(from, to, departAt + NOMINAL_WAIT);
    return [{
      purpose,
      mode: "taxi",
      from,
      to,
      minutes: trip.minutes + NOMINAL_WAIT,
      kilometres: trip.kilometres,
      estimated: trip.estimated,
      wait: NOMINAL_WAIT,
    }];
  }

  // Nothing came and it was too far to walk. Priced as transit because that is
  // what is left, and flagged estimated because there is no line to route on.
  if (outcome.kind === "transit") {
    const trip = roads.trip(from, to, departAt);
    return [{
      purpose,
      mode: "transit",
      from,
      to,
      minutes: trip.minutes * TRANSIT_FACTOR + TRANSIT_WAIT,
      kilometres: trip.kilometres,
      estimated: true,
    }];
  }

  // The walk out of a failed request, hop by hop. Each one carries the journey's
  // own purpose rather than a purpose of its own: a person walking down the road
  // hoping for a cab is going to work, and a trip table that called those legs
  // something else would lose the journey they belong to.
  const segments: Segment[] = [];
  let origin = from;
  for (let i = 0; i < outcome.via.length; i += 1) {
    const hop = outcome.via[i]!;
    const arrived = outcome.kind === "walk" && i === outcome.via.length - 1;
    const place: Place = arrived
      ? to
      : { lat: hop.to.lat, lon: hop.to.lon, id: null, kind: "kerb", label: `on foot toward ${to.label}` };
    segments.push({
      purpose,
      mode: "walk",
      from: origin,
      to: place,
      minutes: hop.minutes,
      kilometres: hop.kilometres,
      estimated: false,
    });
    origin = place;
  }

  if (outcome.kind === "walk") return segments;

  segments.push({
    purpose,
    mode: "taxi",
    from: origin,
    to,
    minutes: outcome.wait + outcome.minutes,
    kilometres: outcome.kilometres,
    estimated: false,
    wait: outcome.wait,
  });
  return segments;
}

/**
 * Total driving distance in a day, for the fuel model to consume later.
 *
 * A kilometre belongs to whoever is at the wheel, which for a taxi is not the
 * person the trip was made for. Counting a fare on both sides — once as the
 * passenger's car trip and once as the driver's — would put every taxi
 * kilometre in the city into the total twice, and would charge the fuel to
 * somebody who does not own the car. So `taxi`, the passenger's mode, is
 * excluded and `cab`, the driver's, is not.
 */
export function drivenKilometres(legs: readonly Leg[]): number {
  return legs.reduce(
    (total, leg) => total + (DRIVING.has(leg.mode) && leg.mode !== "taxi" ? leg.kilometres : 0),
    0,
  );
}

/**
 * Cab kilometres, split by whether there was anyone in the back.
 *
 * The split is the fleet's efficiency and there is a published figure to check
 * it against: roughly two fifths to a half of the miles a taxi fleet turns are
 * empty ones. A simulation that produced 5% would have a dispatcher matching
 * cabs that are already standing where the fare is, and one that produced 80%
 * would have too few cars chasing too much of the map.
 */
export function taxiKilometres(legs: readonly Leg[]): { loaded: number; empty: number } {
  let loaded = 0;
  let empty = 0;
  for (const leg of legs) {
    if (leg.mode !== "cab") continue;
    if (leg.purpose === "fare") loaded += leg.kilometres;
    else empty += leg.kilometres;
  }
  return { loaded, empty };
}

/**
 * Every kilometre turned by a patrol car, which is the city's fuel bill and not
 * anybody's driving.
 *
 * Split from `drivenKilometres` for the same reason cab miles are: an officer
 * covering ninety kilometres on a watch has not commuted ninety kilometres, and
 * folding the two together would put the city's driving-per-adult check out by
 * the whole of the fleet's mileage.
 */
export function patrolKilometres(legs: readonly Leg[]): number {
  return legs.reduce((total, leg) => total + (leg.mode === "patrol" ? leg.kilometres : 0), 0);
}

/** Total distance walked, which is a different meter and a different consumer. */
export function walkedKilometres(legs: readonly Leg[]): number {
  const parked = legs.reduce((total, leg) => total + (leg.parking?.metres ?? 0), 0) / 1000;
  return parked + legs.reduce((total, leg) => total + (leg.mode === "walk" ? leg.kilometres : 0), 0);
}

/**
 * The home-to-work journey inside the day, which is what PUMS asked about.
 *
 * Not simply "the leg whose purpose is work": with a stop on the way in, the
 * journey is two legs and a coffee, and JWMNP is neither the first leg nor the
 * whole span. It is the travel time, so the dwell is excluded and the detour is
 * not — a person who stops at the café did drive further, and said so.
 */
export function commuteSpan(legs: readonly Leg[]): { minutes: number; kilometres: number; depart: number; mode: LegMode; estimated: boolean } | null {
  const end = legs.findIndex((leg) => leg.purpose === "work");
  if (end < 0) return null;

  let start = end;
  while (start > 0 && legs[start]!.fromLabel !== HOME_LABEL) start -= 1;
  if (legs[start]!.fromLabel !== HOME_LABEL) return null;

  const journey = legs.slice(start, end + 1);
  return {
    minutes: journey.reduce((total, leg) => total + (leg.arrive - leg.depart), 0),
    kilometres: journey.reduce((total, leg) => total + leg.kilometres, 0),
    depart: journey[0]!.depart,
    mode: journey.find((leg) => leg.purpose !== "vehicle")?.mode ?? journey[0]!.mode,
    estimated: journey.some((leg) => leg.estimated),
  };
}

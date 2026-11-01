/**
 * Turning a work block into a journey.
 *
 * A commute is not a trip, it is the spine of a tour. Everything discretionary
 * that happens on a working day hangs off it — the intercepted shop on the way
 * home, the school drop-off on the way out, the tank filled at the station
 * that was on the route anyway — so what this produces is a leg list with the
 * gaps other layers will insert into, not a pair of point-to-point trips.
 *
 * The arrival is the anchor, not the departure. PUMS asked when the respondent
 * left and when they got there, and the two answers do not have to be
 * consistent with any real travel time; what a person actually controls is
 * being at work when they are due, so the plan routes backwards from `arrive`
 * to the minute they must leave, and their punctuality trait moves that.
 *
 * What this is *not*, since `travel.ts` arrived
 * ---------------------------------------------
 * This is the provisional commute and not the day's travel. It answers two
 * questions nothing else can — when is this person at work, and what corridor
 * does their journey run down, which is what `tours.ts` needs before it can
 * decide which shop is on the way. The legs the day actually contains are built
 * once, at the end, by `travel.ts`, from every stay the day ended up with. A
 * commute with a stop on it is two legs there, and this module never sees the
 * stop.
 */

import { homeOf, placeOf, type Assignment, type Person, type Point, type World } from "../../world/index.ts";
import type { Kerb, Parking } from "../../transport/index.ts";
import { punctuality, type Block } from "./roster.ts";
import { LAYER, stream } from "../../shared/index.ts";
import { ACCESS_MINUTES, DRIVING, HOME_LABEL, haversineKm, modeOf, type Leg, type LegMode, type Roads, type Trip } from "../../transport/index.ts";

export type { Leg, LegMode };
export { modeOf };

export interface Tour {
  person: number;
  legs: Leg[];
  /** Set where the person's day happens somewhere the simulation cannot see. */
  offMap: boolean;
  note?: string;
}

/**
 * The mode table lives in `travel.ts` now, because every trip needs it and only
 * some trips are commutes.
 *
 * Walking is routed, on the car graph, under the assumption that every road in
 * town has a footway of some kind — see `routing.ts` for what that costs. A
 * pedestrian takes the driver's path at a pedestrian's pace, so a walk has real
 * geometry and a real duration rather than the survey's number and no route.
 *
 * Transit on a commute is still the survey's, and only on a commute. A bus does
 * not take the car network's travel time, it takes its line's, and there is no
 * line geometry here to route on, so where the respondent gave a number it is
 * better than anything this could compute. Bikes are the survey's too, for a
 * different reason: cycling is neither the car's speed nor the pedestrian's.
 * Neither answer exists for a trip to the shops, which is why `travel.ts` has
 * to price those itself.
 */
export interface CommuteContext {
  world: World;
  roads: Roads;
  kerb: Kerb;
}

/**
 * The journey a work block implies, or a tour that says why there isn't one.
 *
 * Four outcomes, and the mode field is what distinguishes them:
 *
 *   home       no journey at all. The block happens where the person sleeps.
 *   external   a journey off the edge of the extract. The trip cannot be
 *              routed because the destination is not in the graph, so its
 *              duration is the survey's and its geometry is nothing. The
 *              person is marked off-map, which is what keeps them out of every
 *              venue pool and every co-presence draw until they come back.
 *   itinerant  a journey to the base, and then a day the base does not
 *              describe. The outbound leg is real; what happens after it is
 *              the dispatch layer's, not this one's.
 *   sited      the ordinary case, both ways.
 */
export function commuteFor(context: CommuteContext, person: Person, block: Block, day: number): Tour {
  const { world, roads, kerb } = context;
  const assignment = world.assignments.get(person.id)!;
  const home = homeOf(world, person);

  if (block.mode === "home" || !home) {
    return { person: person.id, legs: [], offMap: false, note: block.mode === "home" ? "works from home" : "no dwelling" };
  }

  if (block.mode === "external") {
    const travel = person.travel ?? 45;
    return {
      person: person.id,
      legs: [
        offMapLeg("work", home, block.start - travel, block.start, modeOf(person)),
        offMapLeg("home", home, block.end, block.end + travel, modeOf(person)),
      ],
      offMap: true,
      note: "works outside the extract",
    };
  }

  const site = placeOf(world, block.site);
  if (!site) {
    return { person: person.id, legs: [], offMap: false, note: `site ${block.site} has no coordinates` };
  }

  // A cab has no depot. `init_work` sets a driver's site to their own dwelling
  // so that `site` keeps meaning "where the shift starts" for every role, and
  // routing that produces a three-minute drive to the end of the driveway.
  // The shift starts where the person already is; the day happens elsewhere,
  // and that is the dispatch layer's to generate.
  if (haversineKm(home, site) < 0.05) {
    return { person: person.id, legs: [], offMap: false, note: "shift starts at the dwelling" };
  }

  const mode = modeOf(person);
  const drift = punctuality(world.seed, person);
  const rng = stream(world.seed, person.id, LAYER.departure, day);

  const outbound = leg(context, person, "work", home, site, block.start, mode, drift + rng.gauss(0, 3.5), true);
  // Leaving is looser than arriving. Nobody schedules the moment they get in
  // the car to go home, so the spread on the return is wider and one-sided in
  // the direction the roster already pushed it with overtime.
  const back = leg(context, person, "home", site, home, block.end + Math.max(0, rng.gauss(4, 7)), mode, 0, false);

  return { person: person.id, legs: [outbound, back], offMap: false };
}

function offMapLeg(purpose: Leg["purpose"], from: Point, depart: number, arrive: number, mode: LegMode): Leg {
  return {
    purpose,
    mode,
    from,
    to: from,
    fromLabel: purpose === "work" ? HOME_LABEL : "off the map",
    toLabel: purpose === "work" ? "off the map" : HOME_LABEL,
    depart,
    arrive,
    kilometres: 0,
    estimated: true,
  };
}

/**
 * One leg, priced.
 *
 * `anchoredOnArrival` is the difference between the two directions. Going to
 * work, the arrival is fixed and the departure is solved for; coming home, the
 * departure is fixed and the arrival is whatever the road gives. Parking is
 * charged on driving legs at both ends, and the search and the walk are inside
 * the arrival time rather than beside it — a driver who spent four minutes
 * finding a space and two walking is six minutes later into the building, and
 * a plan that recorded those separately would have them arriving on time and
 * being somewhere else.
 */
function leg(
  context: CommuteContext,
  person: Person,
  purpose: Leg["purpose"],
  from: Point,
  to: Point,
  anchor: number,
  mode: LegMode,
  drift: number,
  anchoredOnArrival: boolean,
): Leg {
  const { roads, kerb, world } = context;
  const driving = DRIVING.has(mode);
  // The provisional commute knows only two places, so the labels are the two
  // ends of it. `travel.ts` names them properly once the day is assembled.
  const fromLabel = purpose === "work" ? HOME_LABEL : "work";
  const toLabel = purpose === "work" ? "work" : HOME_LABEL;

  if (mode === "walk") {
    // Routed, and no access time: there is no vehicle to reach and nothing to
    // park at the far end. The door-to-door trip is the walk.
    const trip = roads.walk(from, to);
    const depart = anchoredOnArrival ? anchor - trip.minutes + drift : anchor + drift;
    return {
      purpose,
      mode,
      from,
      to,
      fromLabel,
      toLabel,
      depart: Math.round(depart),
      arrive: Math.round(depart + trip.minutes),
      kilometres: Math.round(trip.kilometres * 100) / 100,
      estimated: trip.estimated,
    };
  }

  if (!driving) {
    // Believe the survey. The car graph has no opinion worth having about a
    // bus line, and inventing one would be worse than the answer the
    // respondent gave.
    const minutes = person.travel ?? 25;
    const depart = anchoredOnArrival ? anchor - minutes + drift : anchor + drift;
    return {
      purpose,
      mode,
      from,
      to,
      fromLabel,
      toLabel,
      depart: Math.round(depart),
      arrive: Math.round(depart + minutes),
      kilometres: 0,
      estimated: true,
    };
  }

  const goingHome = purpose === "home";
  let trip: Trip;
  let parking: Parking;
  let depart: number;
  let arrive: number;

  // Getting to the car is part of the commute the survey measured, so it is
  // part of the one simulated here. It is charged at the origin only: the
  // walk at the far end is the parking model's, and charging both would be
  // counting the same steps twice.
  if (anchoredOnArrival) {
    // Solve backwards, then charge parking, then solve backwards again — the
    // parking time changes the minute the drive has to end, which changes the
    // congestion the drive meets.
    const first = roads.departureFor(from, to, anchor);
    parking = kerb.park(to, anchor - first.minutes, world.seed, person.id, goingHome);
    const doorTime = parking.searchMinutes + parking.walkMinutes;
    trip = roads.departureFor(from, to, anchor - doorTime);
    depart = anchor - doorTime - trip.minutes - ACCESS_MINUTES + drift;
    arrive = anchor + drift;
  } else {
    depart = anchor + drift;
    trip = roads.trip(from, to, depart + ACCESS_MINUTES);
    parking = kerb.park(to, depart + ACCESS_MINUTES + trip.minutes, world.seed, person.id, goingHome);
    arrive = depart + ACCESS_MINUTES + trip.minutes + parking.searchMinutes + parking.walkMinutes;
  }

  return {
    purpose,
    mode,
    from,
    to,
    fromLabel,
    toLabel,
    depart: Math.round(depart),
    arrive: Math.round(arrive),
    kilometres: Math.round(trip.kilometres * 100) / 100,
    estimated: trip.estimated,
    parking,
  };
}

/** Total driving distance in a tour, for the fuel model to consume later. */
export function tourKilometres(tour: Tour): number {
  return tour.legs.reduce((total, leg) => total + (DRIVING.has(leg.mode) ? leg.kilometres : 0), 0);
}

/** Total distance walked, which is a different meter and a different consumer. */
export function tourWalkKilometres(tour: Tour): number {
  const parked = tour.legs.reduce((total, leg) => total + (leg.parking?.metres ?? 0), 0) / 1000;
  return parked + tour.legs.reduce((total, leg) => total + (leg.mode === "walk" ? leg.kilometres : 0), 0);
}

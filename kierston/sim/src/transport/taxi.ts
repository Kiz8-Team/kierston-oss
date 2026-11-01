/**
 * The cab that comes when somebody orders one.
 *
 * A taxi trip is the one journey in this city that cannot be generated from
 * one person's day, because it is two people's days and neither of them can
 * work out the other's alone. The passenger knows where they are going and when
 * they need to be there. The driver knows where they have just set somebody
 * down. Which of the hundred cabs on the road is the one that comes is a fact
 * about the whole fleet at that minute, and it belongs to neither day.
 *
 * Before this module a taxi leg was a car that materialised at the door in the
 * time it takes to walk to a driveway, and the hundred and forty-six people the
 * employment stage records as taxi drivers sat at home through their entire
 * shift, because `init_work` posts them at their own dwelling and there was
 * nothing to send them anywhere else.
 *
 * Why the matching is a pass of its own
 * -------------------------------------
 * It is neither an init-stage decision nor a runtime one, and both alternatives
 * fail for reasons worth writing down.
 *
 * `school_travel.py` could pre-decide every bus manifest in Python because
 * school demand is static: a child, a school, a bell, all of them known before
 * any day is simulated. Taxi demand is not. A fare exists because `tours.ts`
 * drew a supermarket stop and the chain decided the gap to it was too long to
 * walk — it does not exist until a day has been built, so nothing upstream of
 * `day.ts` can enumerate it.
 *
 * Nor can the matching happen inside `chain`. That function runs its stay list
 * up to four times, each with a backward solve and a forward pricing pass, so a
 * dispatcher called from inside it would allocate cars during attempts that get
 * thrown away. Worse, it would need a mutable city-wide table of who is free,
 * which makes one person's day depend on the order the population happened to
 * be planned in — and losing that is losing the property the whole simulation
 * is built on, that any single person's Tuesday can be regenerated on its own.
 *
 * So the fleet is allocated once, in the middle: days are built to find out
 * what the demand is, the cars are matched to it, and the days are built again
 * against the answer. What comes out is an immutable table that a passenger and
 * a driver both read, which is the same construction `school.ts` uses for a bus
 * run and `affiliations.ts` for an org's calendar, and it is used here for the
 * same reason — it puts two people in one car without either of them having to
 * simulate the other.
 *
 * The invariant that makes two passes enough
 * ------------------------------------------
 * The demand the first pass finds must not depend on what the second pass
 * decides, or the passes do not converge: a longer wait makes the passenger
 * leave earlier, which moves the request, which moves the assignment, which
 * moves the wait.
 *
 * It closes because a fare is identified by its *endpoints*, and the minute it
 * is requested is fixed by a constant — `travel.ts`'s NOMINAL_WAIT, what the
 * passenger allows for a cab rather than what they get. Both passes plan the
 * day against that constant, so both ask for a car at the same minute, and the
 * assignment made in between is still addressed to a fare that exists. The
 * realised wait then differs, and that difference is not an error to reconcile:
 * it is the passenger arriving late, which the chain already records.
 */

import { homeOf, placeOf, type Person, type Point, type World } from "../world/index.ts";
import { hirerFor } from "./hire.ts";
import { rosterFor } from "../activities/work/index.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import { haversineKm, type Roads } from "./routing.ts";
import type { Dispatch, FareOutcome, Hop, Leg, LegMode, Place, Sojourn } from "./travel.ts";

/** JWTRNS 7. The only answer that puts somebody in the back of a cab. */
const TAXI_TRANSPORT = "7";

/** The role `init_work.py` posts a driver into. */
export const DRIVER_ROLE = "taxi_driver";

/**
 * How long a passenger will hold on before giving up on the car.
 *
 * Not a dispatch policy — no operator turns work away — but the passenger's
 * patience, which is what actually ends a request. Beyond this they stop
 * waiting and start walking, and the fare is lost to the fleet whether or not a
 * car was eventually going to reach them.
 */
const MAX_WAIT = 18;

/**
 * How many cabs are routed before one is chosen.
 *
 * The nearest car by straight line is not the nearest by road — a river, a rail
 * cutting and a one-way system all make a cab that looks closer take longer —
 * so the choice has to be made on routed time. Routing the whole fleet for
 * every fare is what that would cost if the shortlist did not exist; five is
 * enough that the crow-flies ordering being wrong about the first two does not
 * change the answer.
 */
const CANDIDATES = 5;

/**
 * How long a cab sits where it dropped off before drifting back to its stand.
 *
 * The difference between a fleet that waits where the work was and one that
 * waits where the work is. Too short and every car spends its shift driving
 * back and forth to a handful of points, which is empty distance nobody drives.
 * Too long and the fleet slowly smears itself over the map in proportion to
 * where it has already been, and stops being anywhere useful.
 *
 * It was expected to dominate the empty-mileage share and does not: sweeping it
 * from twelve to thirty minutes moved that share by a single point. At the
 * demand of the time — three or four fares a shift — that was because most of a
 * cab's empty distance was the drive out at the start and back at the end, and
 * no waiting policy could touch it. `hire.ts` has since raised the fares to
 * about seventeen and the empty share has fallen from 62% to 41% on its own,
 * which does not make this constant worth re-sweeping so much as it explains
 * why the first sweep found nothing: the number it was aimed at was not the
 * number it controls.
 */
const IDLE_RETURN = 20;

/** Door open, fare in, meter on. And the same at the other end. */
const PICKUP_DWELL = 0.8;
const DROP_DWELL = 0.5;

/** A driver will not start a fare they cannot finish before the shift ends. */
const OVERRUN_GRACE = 25;

/**
 * The fallbacks, for a request no car answered.
 *
 * Somebody who cannot get a cab does not stand still. If the destination is
 * close they walk it; if it is not, they set off toward it anyway and try again
 * from further along, which is both what people do and what keeps the failure
 * from being a hole in the day. Two retries, because a third would be a person
 * who has walked most of the way and would have been better off walking.
 *
 * The two distances are different on purpose. WALKABLE is the judgement made
 * with a full day still ahead — close enough that it is not worth another
 * attempt. GIVE_UP is the judgement made after twenty minutes of failing to get
 * a car, when the alternative is no longer a cab but a bus, and the distance a
 * person will accept on foot goes up accordingly.
 */
const WALKABLE_KM = 1.6;
const GIVE_UP_KM = 3.2;
const RELAY_KM = 0.75;
const RELAY_ATTEMPTS = 2;

/** How many stands the city's taxi demand is summarised into. */
const STANDS = 8;
const STAND_PASSES = 12;

/**
 * Where a cab waits between fares.
 *
 * Not a POI, and deliberately not. There is no `amenity=taxi` worth the name in
 * the extract, and inventing a rank outside the station and the two hotels
 * would be putting a guess about the trade into the geometry. What a driver
 * actually does is wait where the work is, so the stands are derived from where
 * the work is: the homes and workplaces of everyone in the city who can order a
 * cab at all, clustered into a handful of centres. That is `hire.ts`'s answer
 * and not JWTRNS's — when it was the latter the ranks were placed from 198
 * people to serve the trips of 8,743, and moving them onto the whole demand
 * took a minute off the median wait and put the last idle driver to work.
 *
 * Derived from the *static* geography rather than from a simulated day's fares,
 * which matters more than it looks. A driver's stand is a habit — the corner
 * they have waited on for nine years — so it has to be the same on Tuesday as
 * on Saturday, and clustering each day's own demand would have given them a
 * different one every morning.
 */
export interface Stand extends Point {
  id: string;
  /** Demand points nearest to it, which is what makes one stand busier than another. */
  mass: number;
}

/**
 * The points the stands are clustered from: where the people who order cabs are.
 *
 * Everyone `hire.ts` says can order one, not only the hundred and ninety-eight
 * who commute by cab. When it was the latter the ranks were drawn from 0.2% of
 * the demand they were supposed to serve, which was defensible only while that
 * 0.2% *was* the demand.
 *
 * Still the static geography — homes and workplaces, never a simulated day's
 * fares — for the reason below: a driver's stand is a habit and has to be the
 * same on Tuesday as on Saturday.
 */
function demandPoints(world: World): Point[] {
  const points: Point[] = [];
  for (const person of world.persons.values()) {
    if (hirerFor(world, person).usual !== "taxi") continue;
    const home = homeOf(world, person);
    if (home) points.push(home);
    const site = placeOf(world, world.assignments.get(person.id)?.site ?? null);
    if (site) points.push(site);
  }
  return points;
}

/**
 * Lloyd's algorithm, seeded by farthest-point rather than at random.
 *
 * Random seeding on a city this shape puts two centres in the same downtown
 * cluster about a third of the time, and a stand that duplicates another one is
 * a stand the outskirts do not get. Farthest-point is deterministic given the
 * first pick and spreads the initial centres over the extent of the demand,
 * which is the property wanted here — these are waiting places, and they are
 * useful in proportion to how much of the map they cover between them.
 */
export function stands(world: World, k = STANDS): Stand[] {
  const points = demandPoints(world);
  if (points.length === 0) return [];

  const rng = new Rng(mix(world.seed, LAYER.taxiStand));
  const centres: Point[] = [points[rng.int(0, points.length - 1)]!];
  while (centres.length < Math.min(k, points.length)) {
    let best = points[0]!;
    let bestDistance = -1;
    for (const point of points) {
      let nearest = Infinity;
      for (const centre of centres) nearest = Math.min(nearest, haversineKm(point, centre));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = point;
      }
    }
    centres.push(best);
  }

  const owner = new Int32Array(points.length);
  for (let pass = 0; pass < STAND_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < points.length; i += 1) {
      let pick = 0;
      let nearest = Infinity;
      for (let c = 0; c < centres.length; c += 1) {
        const distance = haversineKm(points[i]!, centres[c]!);
        if (distance < nearest) {
          nearest = distance;
          pick = c;
        }
      }
      if (owner[i] !== pick) moved = true;
      owner[i] = pick;
    }

    const lat = new Float64Array(centres.length);
    const lon = new Float64Array(centres.length);
    const count = new Int32Array(centres.length);
    for (let i = 0; i < points.length; i += 1) {
      const c = owner[i]!;
      lat[c] += points[i]!.lat;
      lon[c] += points[i]!.lon;
      count[c] += 1;
    }
    for (let c = 0; c < centres.length; c += 1) {
      if (count[c]! === 0) continue;
      centres[c] = { lat: lat[c]! / count[c]!, lon: lon[c]! / count[c]! };
    }
    if (!moved) break;
  }

  const mass = new Int32Array(centres.length);
  for (let i = 0; i < points.length; i += 1) mass[owner[i]!] += 1;

  return centres.map((centre, i) => ({ ...centre, id: `stand/${i}`, mass: mass[i]! }));
}

/**
 * The stand one driver waits at, drawn once and kept forever.
 *
 * A trait, in `rng.ts`'s sense, and for the reason that file gives: redrawing
 * it daily would turn a habit into noise. Weighted by how busy the stand is
 * against how far it is from the driver's own front door, because both are real
 * — the busy stand is worth more fares and the near one is worth a shorter
 * drive at either end of a shift, and drivers trade the two off differently.
 */
function standFor(seed: number, driver: number, home: Point, all: readonly Stand[]): Stand {
  const weights = all.map((stand) => stand.mass / (haversineKm(home, stand) + 0.6) ** 2);
  return new Rng(mix(seed, driver, LAYER.taxiStand)).weighted(all, weights);
}

/** The stand a point falls to, which is what makes one stand's catchment. */
export function nearestStand(point: Point, all: readonly Stand[]): number {
  let pick = -1;
  let nearest = Infinity;
  for (let i = 0; i < all.length; i += 1) {
    const distance = haversineKm(point, all[i]!);
    if (distance < nearest) {
      nearest = distance;
      pick = i;
    }
  }
  return pick;
}

/**
 * The static half of this module, written down for something else to read.
 *
 * Everything in this file is one of two things: derived once from the city's
 * geography, or decided fresh for a date. The stands and the rank a driver
 * keeps are the first kind — the same on Tuesday as on Saturday — and that
 * makes them the part of the taxi layer a viewer can show without simulating
 * anybody's day.
 *
 * It is a function here rather than a query over there because the clustering
 * is seeded: `stands` draws its first centre through `rng.ts` from
 * `world.seed`, and `standFor` draws a driver's habit the same way. A second
 * implementation of that in a browser would be a second answer, and a second
 * answer is a map of ranks no driver in the simulation waits at. So the
 * simulation writes what it actually uses.
 */
export interface TaxiGeography {
  stands: Stand[];
  /**
   * A driver, their front door, and the rank they keep.
   *
   * `shift` is the establishment `init_work.py` posted them into and not a day
   * they worked: the watch they are on and the hours it runs. Which dates it
   * lands on is the rota's business and `rosterFor`'s, and neither belongs in
   * a file that claims to be the same every morning.
   */
  drivers: {
    person: number;
    home: Point;
    operator: number | null;
    vehicle: string | null;
    depot: Point | null;
    stand: number;
    km: number;
    watch: string | null;
    start: number | null;
    end: number | null;
  }[];
  /**
   * The people who commute by cab — everyone whose answer to JWTRNS was 7.
   *
   * A subset of the demand and no longer the whole of it: the stands are
   * clustered from every hirer `hire.ts` finds, which is forty times as many
   * people. These are kept as their own list because they are the ones with a
   * workplace to have a catchment about. A carless pensioner has a home and a
   * pattern of errands, which is demand but is not a second point on the map.
   */
  riders: {
    person: number;
    home: Point | null;
    homeStand: number;
    site: string | null;
    work: Point | null;
    workStand: number;
  }[];
}

export function geography(world: World, all: readonly Stand[]): TaxiGeography {
  const drivers: TaxiGeography["drivers"] = [];
  for (const assignment of world.assignments.values()) {
    if (assignment.role !== DRIVER_ROLE) continue;
    const person = world.persons.get(assignment.person);
    if (!person) continue;
    const home = homeOf(world, person);
    if (!home) continue;
    const affiliation = world.fleet.drivers.get(person.id);
    if (!affiliation) continue;
    const depot = affiliation.operator === null
      ? null : world.fleet.operators.get(affiliation.operator)?.depot ?? null;
    const base = depot ?? home;
    const stand = standFor(world.seed, person.id, base, all);
    drivers.push({
      person: person.id,
      home: { lat: home.lat, lon: home.lon },
      operator: affiliation.operator,
      vehicle: affiliation.vehicle,
      depot: depot ? { lat: depot.lat, lon: depot.lon } : null,
      stand: all.indexOf(stand),
      km: haversineKm(base, stand),
      watch: assignment.shift?.watch ?? assignment.platoon ?? null,
      start: assignment.shift?.start ?? null,
      end: assignment.shift?.end ?? null,
    });
  }
  drivers.sort((a, b) => a.person - b.person);

  const riders: TaxiGeography["riders"] = [];
  for (const person of world.persons.values()) {
    if (person.transport !== TAXI_TRANSPORT) continue;
    const home = homeOf(world, person);
    const site = world.assignments.get(person.id)?.site ?? null;
    const work = placeOf(world, site);
    riders.push({
      person: person.id,
      home: home ? { lat: home.lat, lon: home.lon } : null,
      homeStand: home ? nearestStand(home, all) : -1,
      site,
      work: work ? { lat: work.lat, lon: work.lon } : null,
      workStand: work ? nearestStand(work, all) : -1,
    });
  }
  riders.sort((a, b) => a.person - b.person);

  return { stands: [...all], drivers, riders };
}

/** A request, as the demand pass found it: two points and the minute it is made. */
export interface Request {
  id?: string;
  person: number;
  from: Point;
  to: Point;
  /** Minute the passenger asks for a car. Fixed by NOMINAL_WAIT, not by the answer. */
  at: number;
}

/**
 * Every taxi leg in a day that was built without a dispatcher.
 *
 * The demand pass's only output. Legs whose mode is `taxi` are the passenger's
 * side of a fare and nothing else in the simulation produces one — a driver's
 * legs are `cab`, and this runs before any driver has a day at all.
 */
export function requestsIn(person: number, legs: readonly Leg[]): Request[] {
  const out: Request[] = [];
  for (const leg of legs) {
    if (leg.mode !== "taxi") continue;
    // A leg that starts and ends at the same point is not a journey anybody
    // orders a car for. It is what `commute.ts` emits for somebody who works
    // outside the extract: the trip is real, but its far end is off the map, so
    // both ends are recorded at the dwelling and the geometry is nothing. Sent
    // to the fleet it becomes a fare of no distance, dispatched to a car that
    // drives nowhere — and, because a person's two off-map legs are then
    // identical, two fares indistinguishable from each other.
    if (haversineKm(leg.from, leg.to) < 0.02) continue;
    out.push({ id: leg.journeyId, person, from: leg.from, to: leg.to, at: leg.depart });
  }
  return out;
}

/** Where a cab went to wait, and when, between one fare and the next. */
interface Reposition {
  from: Point;
  setOff: number;
  arrive: number;
  leave: number;
  minutes: number;
  kilometres: number;
}

/** One fare, from the fleet's side. */
export interface Job {
  journeyId?: string;
  person: number;
  from: Point;
  to: Point;
  requestedAt: number;
  /** Minute the cab sets off for the pickup, and where from. */
  setOff: number;
  origin: Point;
  approach: number;
  approachKm: number;
  /** Minute the cab reaches the passenger. */
  pickup: number;
  ride: number;
  rideKm: number;
  /** Minute the passenger is set down. */
  drop: number;
  /** A drift back to the stand taken before this fare, where the gap allowed one. */
  before: Reposition | null;
}

export interface Cab {
  person: number;
  vin: string;
  operator: number | null;
  base: Point;
  stand: Stand;
  shiftStart: number;
  shiftEnd: number;
  /** Where the last fare left the car, and the minute it was free again. */
  at: Point;
  freeFrom: number;
  jobs: Job[];
  /** The last drift to the stand, kept so the end of the shift can be built. */
  resting: Reposition | null;
}

/**
 * Which drivers are on the road today, and when.
 *
 * `rosterFor` is the whole test, and it is one pure call per driver against
 * their own static assignment — the same cheapness `school.ts` relies on when a
 * child checks whether the parent nominated to drive them is free.
 *
 * At `step` above 1 only one driver in every `step` is put on the road. The
 * count is taken over the drivers themselves and not over the assignments they
 * sit in, so the fleet shrinks by the fraction asked for rather than by
 * whatever share of the city's jobs happen to be driving jobs.
 */
export function onDuty(
  world: World, date: Date, day: number, all: readonly Stand[], step = 1,
  held: readonly Cab[] = [],
): { cabs: Cab[]; unavailable: number } {
  const pending: { person: Person; block: { start: number; end: number }; base: Point;
    operator: number | null; vin: string | null }[] = [];
  let seen = -1;
  for (const assignment of world.assignments.values()) {
    if (assignment.role !== DRIVER_ROLE) continue;
    seen += 1;
    if (seen % step !== 0) continue;
    const person = world.persons.get(assignment.person);
    if (!person) continue;
    const home = homeOf(world, person);
    if (!home) continue;
    const affiliation = world.fleet.drivers.get(person.id);
    if (!affiliation) continue;
    const operator = affiliation.operator;
    const base = operator === null
      ? home
      : world.fleet.operators.get(operator)?.depot ?? null;
    if (!base) continue;

    for (const block of rosterFor(world, person, date, day)) {
      if (block.kind !== "work") continue;
      pending.push({ person, block, base, operator, vin: affiliation.vehicle });
    }
  }

  const cabs: Cab[] = [];
  let unavailable = 0;
  const pools = new Map<number, string[]>();
  for (const row of world.fleet.vehicles) {
    if (row.service_class !== "taxi" || row.operator === null) continue;
    const mine = pools.get(row.operator) ?? [];
    mine.push(row.vin);
    pools.set(row.operator, mine);
  }
  for (const [operator, vins] of pools) {
    vins.sort();
    new Rng(mix(world.seed, day, operator, LAYER.taxiStand)).shuffle(vins);
    // The cars come off the road with the drivers. Leaving an operator's whole
    // yard to a tenth of its drivers would hand every one of them a free car
    // and put `unavailable` at nought, which is the one number here that says
    // whether the registry can cover the roster it was built for.
    if (step > 1) pools.set(operator, vins.slice(0, Math.max(1, Math.round(vins.length / step))));
  }
  // A cab carried over midnight keeps its VIN until the carried shift has
  // really ended, so no driver collects it from the yard before then.
  const freeAt = new Map<string, number>();
  for (const cab of held) freeAt.set(cab.vin, Math.max(freeAt.get(cab.vin) ?? -Infinity, carriedUntil(cab)));
  pending.sort((a, b) => a.block.start - b.block.start || a.person.id - b.person.id);
  for (const shift of pending) {
    let vin = shift.vin;
    if (shift.operator !== null) {
      vin = (pools.get(shift.operator) ?? []).find((candidate) =>
        (freeAt.get(candidate) ?? -Infinity) <= shift.block.start) ?? null;
    } else if (vin && (freeAt.get(vin) ?? -Infinity) > shift.block.start) {
      vin = null;
    }
    if (!vin) { unavailable += 1; continue; }
    // Reserve the return-to-depot grace too; a second driver cannot collect a
    // car that the first is still bringing back after a late fare.
    freeAt.set(vin, shift.block.end + OVERRUN_GRACE);
    cabs.push({
      person: shift.person.id, vin, operator: shift.operator, base: shift.base,
      stand: standFor(world.seed, shift.person.id, shift.base, all),
      shiftStart: shift.block.start, shiftEnd: shift.block.end,
      at: shift.base, freeFrom: shift.block.start, jobs: [], resting: null,
    });
  }
  return { cabs, unavailable };
}

/**
 * The minute a cab carried over midnight is back in its yard, in today's frame.
 *
 * The later of the shift end plus the return grace, the last set-down, and the
 * recorded return to base. Until then the VIN and the driver both belong to
 * yesterday's shift, whose remaining minutes are in the driver's frozen
 * continuation.
 */
export function carriedUntil(cab: Cab): number {
  return Math.max(
    cab.shiftEnd + OVERRUN_GRACE,
    cab.freeFrom,
    cab.resting ? Math.max(cab.resting.arrive, cab.resting.leave) : -Infinity,
  );
}

/**
 * Where a given cab is at a given minute, and what it took to get there.
 *
 * The idle rule made concrete. A car that set somebody down two minutes ago is
 * still at the kerb where it set them down; a car that has been empty for
 * twenty is back at its stand, and the drive there is real distance that has to
 * be charged to it rather than teleported.
 */
function standing(roads: Roads, cab: Cab, when: number): { at: Point; drift: Reposition | null } {
  if (when - cab.freeFrom <= IDLE_RETURN) return { at: cab.at, drift: null };
  if (haversineKm(cab.at, cab.stand) < 0.05) return { at: cab.stand, drift: null };

  const trip = roads.trip(cab.at, cab.stand, cab.freeFrom);
  const arrive = cab.freeFrom + trip.minutes;
  // Far enough away that they are still driving there when the call comes, in
  // which case they take it from where they are — nobody carries on to the rank
  // to turn straight round.
  if (arrive > when) return { at: cab.at, drift: null };

  return {
    at: cab.stand,
    drift: {
      from: cab.at,
      setOff: cab.freeFrom,
      arrive,
      leave: arrive,
      minutes: trip.minutes,
      kilometres: trip.kilometres,
    },
  };
}

interface Offer {
  cab: Cab;
  at: Point;
  drift: Reposition | null;
  setOff: number;
  pickup: number;
  approach: number;
  approachKm: number;
}

/**
 * The nearest free car that can be there soon enough, or nothing.
 *
 * Greedy and myopic — it takes the fare in front of it with the car that can
 * reach it first, and never holds a car back for a better fare thirty seconds
 * later. That is what a dispatcher with a radio does, and the fleet it produces
 * is the one being modelled.
 */
function offer(roads: Roads, cabs: readonly Cab[], from: Point, to: Point, at: number): Offer | null {
  const available: { cab: Cab; at: Point; drift: Reposition | null; km: number }[] = [];
  for (const cab of cabs) {
    if (at < cab.shiftStart || at > cab.shiftEnd) continue;
    if (cab.freeFrom > at + MAX_WAIT) continue;
    const where = standing(roads, cab, at);
    available.push({ cab, at: where.at, drift: where.drift, km: haversineKm(where.at, from) });
  }
  if (available.length === 0) return null;

  available.sort((a, b) => a.km - b.km);
  const offers: Offer[] = [];
  for (const candidate of available.slice(0, CANDIDATES)) {
    const ready = candidate.drift ? candidate.drift.arrive : candidate.cab.freeFrom;
    const approach = roads.trip(candidate.at, from, at);
    // The car sets off when the call comes, not in time to be there for it.
    //
    // Solving backwards from the requested minute — the way every other journey
    // in this simulation is solved — quietly turns the whole fleet into advance
    // bookings: an idle cab leaves early, arrives exactly on time, and the
    // median wait in the city comes out at zero. That is not a taxi. The
    // passenger's wait *is* the approach, and it is the number this module
    // exists to produce.
    const setOff = Math.max(ready, at);
    offers.push({
      cab: candidate.cab,
      at: candidate.at,
      drift: candidate.drift,
      setOff,
      pickup: setOff + approach.minutes,
      approach: approach.minutes,
      approachKm: approach.kilometres,
    });
  }

  // Soonest at the kerb, and where two cars would arrive together the one that
  // burns less getting there.
  offers.sort((a, b) => (a.pickup === b.pickup ? a.approachKm - b.approachKm : a.pickup - b.pickup));

  for (const best of offers) {
    if (best.pickup - at > MAX_WAIT) break;
    const ride = roads.trip(from, to, best.pickup);
    const back = roads.trip(to, best.cab.base, best.pickup + PICKUP_DWELL + ride.minutes);
    if (best.pickup + PICKUP_DWELL + ride.minutes + back.minutes
        > best.cab.shiftEnd + OVERRUN_GRACE) continue;
    return best;
  }
  return null;
}

/**
 * The whole allocation for one day, and the table a person's day reads it from.
 */
/**
 * A fleet's whole state, containing nothing that cannot cross a worker
 * boundary: no class instances, no functions, no references to the world.
 */
export interface FleetState {
  cabs: Cab[];
  day: number;
  unavailable: number;
  tally: { ride: number; relay: number; walk: number; transit: number };
  byFare: Map<string, FareOutcome[]>;
  byJourney: Map<string, FareOutcome>;
  minutes: Map<string, number[]>;
}

export class Fleet implements Dispatch {
  private readonly byFare = new Map<string, FareOutcome[]>();
  private readonly byJourney = new Map<string, FareOutcome>();
  private readonly minutes = new Map<string, number[]>();

  readonly cabs: Cab[];
  readonly day: number;
  readonly unavailable: number;
  /** How each request came out, for the checks. */
  readonly tally = { ride: 0, relay: 0, walk: 0, transit: 0 };

  private constructor(cabs: Cab[], day: number, unavailable: number) {
    this.cabs = cabs;
    this.day = day;
    this.unavailable = unavailable;
  }

  /** Dispatch one priority request against caller-supplied snapshots at its time.
   * The caller owns cancellations; matching, routing, dwell and fallbacks are
   * exactly the same as the ordinary fleet's. Snapshots are never mutated.
   */
  static priority(roads: Roads, cabs: readonly Cab[], request: Request, day: number): { fleet: Fleet; outcome: FareOutcome } {
    const fleet = new Fleet(structuredClone([...cabs]), day, 0);
    const outcome = fleet.serve(roads, request);
    fleet.record(request, outcome);
    return { fleet, outcome };
  }

  /**
   * The allocation as plain data, for a process that did not make it.
   *
   * A parallel export plans its people in workers, and a passenger's day is
   * unreadable without the table that says which cab answered them. Matching
   * cannot be repeated per worker — it is the one step in a day that has to
   * see the whole city's demand at once, and three workers each matching a
   * third of it would put three different cars at three different kerbs. So
   * the fleet is built once and copied out, which it can be because every
   * field in it is already plain: points, minutes and ids, no behaviour.
   */
  state(): FleetState {
    return {
      cabs: this.cabs,
      day: this.day,
      unavailable: this.unavailable,
      tally: this.tally,
      byFare: this.byFare,
      byJourney: this.byJourney,
      minutes: this.minutes,
    };
  }

  /** The same table, on the other side of the wire. */
  static adopt(state: FleetState): Fleet {
    const fleet = new Fleet(state.cabs, state.day, state.unavailable);
    Object.assign(fleet.tally, state.tally);
    for (const [key, outcomes] of state.byFare) fleet.byFare.set(key, outcomes);
    for (const [key, outcome] of state.byJourney) fleet.byJourney.set(key, outcome);
    for (const [key, at] of state.minutes) fleet.minutes.set(key, at);
    return fleet;
  }

  /**
   * Match a day's requests against a day's drivers.
   *
   * Requests are served in the order they are made, which is the only ordering
   * that is not an assumption: a dispatcher cannot answer a call it has not had
   * yet, so a fare booked at 08:02 gets the pick of the fleet that a fare
   * booked at 08:03 no longer has.
   *
   * `step` thins the fleet for a run that is only serving a slice of the city's
   * demand — one driver kept in every `step`, the same fraction the passengers
   * were drawn at. It is 1 for every full run.
   */
  static build(
    world: World,
    roads: Roads,
    date: Date,
    day: number,
    requests: readonly Request[],
    all: readonly Stand[],
    step = 1,
    opening: readonly Cab[] = [],
  ): Fleet {
    // A cab carried over midnight is not dispatchable today. Its driver's
    // minutes up to the end of that shift are yesterday's frozen
    // continuation, which already holds every fare that crossed or followed
    // midnight; a new fare there would be a cab leg the driver's timeline
    // cannot contain, and replaying its jobs would emit last night's fares a
    // second time. It is used only to hold its VIN and its driver until the
    // carried shift has ended, so `cabs` has at most one cab per driver from
    // the day's roster and every lookup by person returns today's shift.
    const duty = onDuty(world, date, day, all, step, opening);
    const fresh = duty.cabs.filter((cab) => !opening.some((prior) =>
      (prior.vin === cab.vin || prior.person === cab.person) && carriedUntil(prior) > cab.shiftStart,
    ));
    const fleet = new Fleet(fresh, day, duty.unavailable + duty.cabs.length - fresh.length);
    const queue = [...requests].sort((a, b) => (a.at === b.at ? a.person - b.person : a.at - b.at));

    for (const request of queue) {
      fleet.record(request, fleet.serve(roads, request));
    }

    // Every registered cab returns to its base: an owner-driver's dwelling or
    // the LLC depot where the next shift collects it.
    for (const cab of fleet.cabs) {
      if (cab.jobs.length === 0) continue; // the base anchor covers an idle shift
      const trip = roads.trip(cab.at, cab.base, cab.freeFrom);
      const arrive = cab.freeFrom + trip.minutes;
      cab.resting = {
        from: cab.at,
        setOff: cab.freeFrom,
        arrive,
        leave: Math.max(arrive, cab.shiftEnd),
        minutes: Math.max(0.5, arrive - cab.freeFrom),
        kilometres: trip.kilometres,
      };
    }

    return fleet;
  }

  /** One request, through the fallbacks, committing whichever car answered. */
  private serve(roads: Roads, request: Request): FareOutcome {
    const via: Hop[] = [];
    let from = request.from;
    let at = request.at;

    for (let attempt = 0; ; attempt += 1) {
      const best = offer(roads, this.cabs, from, request.to, at);
      if (best) {
        const ride = roads.trip(from, request.to, best.pickup);
        const drop = best.pickup + PICKUP_DWELL + ride.minutes;
        const cab = best.cab;

        cab.jobs.push({
          ...(request.id === undefined ? {} : { journeyId: request.id }),
          person: request.person,
          from,
          to: request.to,
          requestedAt: at,
          setOff: best.setOff,
          origin: best.at,
          approach: best.approach,
          approachKm: best.approachKm,
          pickup: best.pickup,
          ride: ride.minutes,
          rideKm: ride.kilometres,
          drop,
          before: best.drift,
        });
        cab.at = request.to;
        cab.freeFrom = drop + DROP_DWELL;

        if (via.length > 0) this.tally.relay += 1;
        else this.tally.ride += 1;
        return {
          kind: "ride",
          driver: cab.person,
          wait: best.pickup - at,
          minutes: PICKUP_DWELL + ride.minutes,
          kilometres: ride.kilometres,
          via,
        };
      }

      const straight = haversineKm(from, request.to);
      if (straight <= WALKABLE_KM || attempt >= RELAY_ATTEMPTS) {
        if (straight <= GIVE_UP_KM) {
          const walk = roads.walk(from, request.to);
          via.push({ to: request.to, minutes: walk.minutes, kilometres: walk.kilometres });
          this.tally.walk += 1;
          return { kind: "walk", via };
        }
        this.tally.transit += 1;
        return { kind: "transit" };
      }

      // Walk on toward the destination and ask again from further along. The
      // relay is a junction on the route the walker is actually taking, so the
      // hop costs what a hop of that length costs — see `Roads.walkPrefix`.
      const relay = roads.walkPrefix(from, request.to, RELAY_KM * 1000);
      if (!relay) {
        // The route is shorter than the distance we meant to walk, so there is
        // no further along to get to: they are close enough to finish on foot.
        const walk = roads.walk(from, request.to);
        via.push({ to: request.to, minutes: walk.minutes, kilometres: walk.kilometres });
        this.tally.walk += 1;
        return { kind: "walk", via };
      }
      via.push({ to: relay.at, minutes: relay.minutes, kilometres: relay.kilometres });
      at += relay.minutes;
      from = relay.at;
    }
  }

  private record(request: Request, outcome: FareOutcome): void {
    if (request.id !== undefined) this.byJourney.set(request.id, outcome);
    const key = fareKey(request.person, request.from, request.to);
    const outcomes = this.byFare.get(key);
    if (outcomes) {
      outcomes.push(outcome);
      this.minutes.get(key)!.push(request.at);
    } else {
      this.byFare.set(key, [outcome]);
      this.minutes.set(key, [request.at]);
    }
  }

  /**
   * What happened to this person's cab, looked up by where they were going.
   *
   * Keyed on the endpoints and not on the minute, which is the invariant this
   * module is built on — see the header. The minute is used only to tell apart
   * the rare day containing the same journey twice, and even then it only has
   * to pick the nearer of two, so it does not have to agree to the minute with
   * what the demand pass saw.
   */
  fareFor(person: number, day: number, from: Point, to: Point, departAt: number, journeyId?: string): FareOutcome | null {
    if (day !== this.day) return null;
    if (journeyId !== undefined) {
      const exact = this.byJourney.get(journeyId);
      if (exact) return exact;
    }
    const key = fareKey(person, from, to);
    const outcomes = this.byFare.get(key);
    if (!outcomes) return null;
    if (outcomes.length === 1) return outcomes[0]!;

    const at = this.minutes.get(key)!;
    let pick = 0;
    for (let i = 1; i < at.length; i += 1) {
      if (Math.abs(at[i]! - departAt) < Math.abs(at[pick]! - departAt)) pick = i;
    }
    return outcomes[pick]!;
  }

  /** Every fare a given driver took today, in order. */
  jobsFor(person: number): Job[] {
    return this.cabs.find((cab) => cab.person === person)?.jobs ?? [];
  }

  /**
   * The minute a request was made, for the drift check.
   *
   * Resolved the same way `fareFor` resolves a repeated journey — nearest to
   * the minute asked about — because a check that picked the first of two
   * would report the gap between them as drift the model does not have.
   */
  requestedAt(person: number, from: Point, to: Point, departAt: number): number | null {
    const at = this.minutes.get(fareKey(person, from, to));
    if (!at || at.length === 0) return null;
    let pick = at[0]!;
    for (const minute of at) {
      if (Math.abs(minute - departAt) < Math.abs(pick - departAt)) pick = minute;
    }
    return pick;
  }
}

/**
 * A fare's identity: who, from where, to where.
 *
 * Quantised to about a metre, which is finer than any coordinate in this
 * simulation is meaningful to and coarse enough that a float that came back
 * through two different code paths still matches itself.
 */
function fareKey(person: number, from: Point, to: Point): string {
  return `${person}|${q(from)}|${q(to)}`;
}

function q(point: Point): string {
  return `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
}

const CAB: LegMode = "cab";

function kerb(point: Point, id: string, label: string): Place {
  return { lat: point.lat, lon: point.lon, id, kind: "kerb", label };
}

/**
 * A driver's shift, as the stays that make it.
 *
 * Every stay carries its own `minutes`, and that is not an optimisation. It is
 * what stops the chain re-deciding a leg the dispatcher has already settled: a
 * duration handed down here short-circuits both the backward solve and the
 * forward pricing, so a two-hundred-metre deadhead cannot come back out of
 * `walkShare` as the driver getting out and walking, and the minute this car
 * reaches the kerb is the same minute the passenger's own day was built around.
 *
 * The pattern is `school.ts`'s `driverStays` and the argument is the same one.
 */
export function cabbieStays(fleet: Fleet, person: Person): Sojourn<Job | Reposition>[] {
  const cab = fleet.cabs.find((c) => c.person === person.id);
  if (!cab) return [];

  const stays: Sojourn<Job | Reposition>[] = [];
  let index = 0;
  const baseRef: Reposition = {
    from: cab.base, setOff: cab.shiftStart, arrive: cab.shiftStart,
    leave: cab.shiftStart, minutes: 0.5, kilometres: 0,
  };

  /**
   * One stay, with its times reconciled to whole minutes.
   *
   * The rounding has to be done here and has to be done to both ends together.
   * A stay whose arrival is rounded and whose duration is not composes to a
   * different minute than it claims, and the chain reads that fractional
   * disagreement as the driver being late — which is how a shift with nothing
   * wrong in it came out as "0.603 min late".
   */
  const put = (
    place: Place,
    from: number,
    to: number,
    minutes: number,
    purpose: "fare" | "deadhead",
    ref: Job | Reposition,
    continuesInCab = true,
  ) => {
    const arrive = Math.round(from);
    stays.push({
      place,
      arrive,
      // KDAY uses whole minutes. A real sub-minute pickup, set-down or depot
      // handoff must remain an anchor after rounding; otherwise the scheduler
      // rejects it and loses the cab's authoritative location.
      leave: Math.max(arrive + 1, Math.round(to)),
      fixed: true,
      purpose,
      ref,
      mode: CAB,
      minutes: Math.max(0.5, Math.round(minutes)),
      vehicleId: cab.vin,
      ...(continuesInCab ? { leaveMode: CAB } : {}),
    });
  };

  const first = cab.jobs[0];
  const firstOut = first
    ? (first.before ? first.before.setOff : first.setOff)
    : cab.shiftEnd;
  // No arriving cab mode: an LLC driver reaches the depot in their own
  // commute. The leg leaving this anchor is the registered taxi.
  stays.push({
    place: { ...cab.base, id: cab.operator === null ? null : `depot/${cab.operator}`,
      kind: cab.operator === null ? "home" : "depot",
      label: cab.operator === null ? "home" : "taxi depot" },
    // A car whose first dispatch is exactly on the shift boundary still has to
    // be collected from the depot. A zero-duration anchor is rejected by the
    // scheduler and made the registered cab materialise at the driver's home.
    arrive: cab.shiftStart - 1, leave: Math.max(cab.shiftStart, firstOut),
    fixed: true, purpose: "deadhead", ref: baseRef,
    // An idle shift never takes the cab out of the depot. Marking every base
    // anchor as a cab departure made the driver's personal trip home move the
    // VIN even when there was no dispatch at all.
    ...(first ? { leaveMode: CAB } : {}),
    vehicleId: cab.vin,
  });

  for (let i = 0; i < cab.jobs.length; i += 1) {
    const job = cab.jobs[i]!;

    // Waiting for work is not work with a passenger in it, so the drive to the
    // stand is empty distance and is counted as such. It ends when the driver
    // sets off for the next fare rather than when they arrive: a car that
    // reached its stand at 06:41 and is not wanted until 08:16 spent those
    // ninety-five minutes parked on the rank, which is the whole reason the
    // stand exists. Ending the stay on arrival sent them to the pickup
    // immediately and had them sitting at a stranger's kerb instead.
    if (job.before) {
      put(
        kerb(cab.stand, cab.stand.id, "cab stand"),
        job.before.arrive,
        job.setOff,
        job.before.minutes,
        "deadhead",
        job.before,
      );
    }

    put(
      kerb(job.from, `fare/${cab.person}/${index}/pickup`, "pickup"),
      job.pickup,
      job.pickup + PICKUP_DWELL,
      job.approach,
      "deadhead",
      job,
    );

    // The same rule at the other end: a driver who is not wanted anywhere for a
    // while stays where they set down until they set off, whether that is for
    // the next fare or back to the rank.
    const next = cab.jobs[i + 1];
    const until = next
      ? (next.before ? next.before.setOff : next.setOff)
      : (cab.resting ? cab.resting.setOff : job.drop + DROP_DWELL);

    put(
      kerb(job.to, `fare/${cab.person}/${index}/drop`, "set down"),
      job.drop,
      Math.max(job.drop + DROP_DWELL, until),
      job.ride,
      "fare",
      job,
    );

    index += 1;
  }

  if (cab.resting) {
    put(
      { ...cab.base, id: cab.operator === null ? null : `depot/${cab.operator}`,
        kind: cab.operator === null ? "home" : "depot",
        label: cab.operator === null ? "home" : "taxi depot" },
      cab.resting.arrive,
      cab.resting.leave,
      cab.resting.minutes,
      "deadhead",
      cab.resting,
      // The registered taxi has returned to its depot. The driver may travel
      // home afterward, but that personal journey must not move this VIN.
      false,
    );
  }

  return stays;
}

/**
 * The fares a shift is worth, for the checks.
 *
 * Kept here rather than derived from the legs because a driver whose day the
 * chain could not close still took the fares — and a check that read the legs
 * would report the fleet as idle rather than report the day as broken.
 */
export function fleetTally(fleet: Fleet): {
  drivers: number;
  working: number;
  fares: number;
  waits: number[];
} {
  const waits: number[] = [];
  let fares = 0;
  let working = 0;
  for (const cab of fleet.cabs) {
    if (cab.jobs.length > 0) working += 1;
    fares += cab.jobs.length;
    for (const job of cab.jobs) waits.push(job.pickup - job.requestedAt);
  }
  return { drivers: fleet.cabs.length, working, fares, waits };
}

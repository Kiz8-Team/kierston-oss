/**
 * Getting to school, and the bus that does most of it.
 *
 * `school_travel.py` decided the structure — who rides which run, in what
 * order, and which adult would drive them if they are driven. Nothing here
 * re-decides any of that. What this module does is price it: turn a manifest
 * into minutes over the road graph, and turn those minutes into the stays a
 * student's day, a parent's day and a driver's day are each made of.
 *
 * The run is priced once, not once per rider
 * ------------------------------------------
 * A school bus route is one journey with forty stops on it, and the minute it
 * reaches any one of them is a fact about the whole route. Pricing a child's
 * hop from their stop to their school on its own would answer a question
 * nobody asked — the bus does not drive there, it drives to eleven more stops
 * first — and would give thirty children on one bus thirty different arrival
 * times at a building they all walk into together.
 *
 * So `timing` solves the whole path as one multi-waypoint route, backwards from
 * the bell, and caches it on the run. Every rider reads their boarding minute
 * off that one answer, and so does the driver. This is the second place in the
 * simulation where two people's days are made consistent by both deriving them
 * from the same shared object rather than by one of them reading the other —
 * `affiliations.ts` does it with an org's calendar, and the reason is the same:
 * it keeps the whole simulation pass parallel.
 *
 * A lift is a nomination, and today may not honour it
 * ---------------------------------------------------
 * The escort named on a student's row is who drives them on the days that adult
 * is free, which is not every day. The test is `rosterFor` on the escort — one
 * pure call, needing nothing about the escort's day except their own static
 * assignment and the date — and both the child and the parent make it and get
 * the same answer. Where it fails, the child takes the fallback the init stage
 * already wrote beside the nomination.
 *
 * That is why a run's manifest is sized on everyone who *could* board rather
 * than on everyone who does. The seat has to exist on the days the lift falls
 * through, and a bus sized to its typical load would leave children at the kerb
 * every time a parent picked up an early shift.
 */

import { homeOf, placeOf, type Person, type Point, type SchoolMode, type SchoolRider, type SchoolRun, type World } from "../../world/index.ts";
import { rosterFor, schoolDay } from "../work/index.ts";
import { HOME_LABEL, type LegMode, type Place, type Roads, type Sojourn } from "../../transport/index.ts";

/**
 * How long a bus is stopped at a stop.
 *
 * Door open, children on, door shut. Short because the stops are small — a
 * dozen children at a corner, not a queue at a terminal — and because the run's
 * length is far more sensitive to this than to anything else in it: forty stops
 * at a minute each is forty minutes, which is most of the route.
 */
const DWELL_MINUTES = 0.9;

/** The same, at a school, where thirty children get off at once. */
const SCHOOL_DWELL = 3;

/**
 * A bus is slower than the car the graph is priced for.
 *
 * Not because it accelerates worse — over a residential grid that barely
 * matters — but because it is long, takes junctions wide, and is legally
 * obliged to stop at every railway crossing. The derate is applied to the
 * routed driving time, so a run down an arterial is affected less than one
 * through a housing estate, which is the right shape.
 */
const BUS_DERATE = 1.18;

/** How close to the bell an escort has to be free to be able to make the trip. */
const DROP_WINDOW = 30;
const DROP_AFTER = 15;

/**
 * A child is at the stop before the bus is, not as it pulls away.
 *
 * Comfortably longer than `travel.ts`'s MIN_DWELL, and that is not incidental.
 * A stay shorter than the minimum dwell reads to the chain as one the person
 * could not have made, so it is dropped — which quietly deleted every bus stop
 * in the city on the first run of this and turned every rider into a car trip.
 */
const STOP_WAIT = 6;

/** Minutes a child spends at the home stop getting off the afternoon bus. */
const STEP_OFF = 1;

export interface RunTiming {
  /** Minute the bus is at each stop, in the order it serves them. */
  stops: number[];
  /** Minute it reaches each school, in the order it serves them. */
  schools: number[];
  /** Minute it leaves the depot, and the minute it is back. */
  depart: number;
  ret: number;
  /**
   * First waypoint to last: how long the run occupies its bus.
   *
   * This is the number the fleet assignment needs and the one the init stage
   * could only guess at. Deliberately *not* depot to depot — a driver chaining
   * one tier's run into the next does not go back to the yard in between, and
   * the dead-head from the last school to the next first stop is covered by the
   * turnaround allowance rather than folded in here.
   */
  span: number;
  kilometres: number;
  /** The stops and schools in the order the bus actually drives them. */
  path: Place[];
}

/**
 * The whole run, solved.
 *
 * Morning and afternoon are mirror images and are built as one: the morning
 * collects from the far end of the catchment inward and delivers to the
 * schools, and the afternoon leaves the schools and drops back out the way it
 * came. That is why the afternoon walks the stop list in reverse — the list is
 * stored in collection order, and a drop-off run that followed it would start
 * by driving to the far edge of the city with a full bus.
 */
function order(world: World, run: SchoolRun): Place[] {
  const stops: Place[] = run.stops.map((stop, index) => ({
    lat: stop.lat,
    lon: stop.lon,
    id: `${run.id}#${index}`,
    kind: "stop",
    label: `stop ${index + 1}`,
  }));

  const schools: Place[] = run.schools.flatMap((id) => {
    const at = placeOf(world, id);
    return at ? [{ lat: at.lat, lon: at.lon, id, kind: "school", label: id }] : [];
  });

  return run.direction === "am"
    ? [...stops, ...schools]
    : [...schools, ...stops.reverse()];
}

const cache = new Map<string, RunTiming | null>();

export function timing(world: World, roads: Roads, run: SchoolRun): RunTiming | null {
  const cached = cache.get(run.id);
  if (cached !== undefined) return cached;

  const depot = world.school.depots.get(run.operator);
  const path = order(world, run);
  if (!depot || path.length === 0) {
    cache.set(run.id, null);
    return null;
  }

  const dwell = (place: Place) => (place.kind === "school" ? SCHOOL_DWELL : DWELL_MINUTES);

  // Every hop, priced in sequence — twice.
  //
  // Congestion depends on the minute a leg starts, and the minute depends on
  // where the run sits against its bell, which is not known until the whole
  // thing has been priced. So the first pass charges every leg at the bell and
  // the second re-charges each at the minute the first pass put it. It is the
  // same two-pass trick `departureFor` uses for a commute and it matters more
  // here: a morning run spans two hours of the peak building, so pricing its
  // 06:10 legs at 08:45 congestion made the whole route too slow at the start
  // and too fast at the end. The chain then re-priced each leg at its real
  // departure, disagreed with this, and reported the driver as late for the
  // difference.
  let legs: { minutes: number; kilometres: number }[] = [];
  let at: number[] = [];
  let elapsed = 0;
  let anchor = run.bell;
  let home = roads.trip(path[path.length - 1]!, depot, run.bell);

  for (let pass = 0; pass < 2; pass += 1) {
    legs = [];
    let from: Point = depot;
    let clockAt = anchor;
    for (const place of path) {
      const trip = roads.trip(from, place, clockAt);
      const minutes = trip.minutes * BUS_DERATE;
      legs.push({ minutes, kilometres: trip.kilometres });
      clockAt += minutes + dwell(place);
      from = place;
    }
    home = roads.trip(from, depot, clockAt);

    // Cumulative arrival at each waypoint, measured from the depot departure.
    at = [];
    elapsed = 0;
    for (let i = 0; i < path.length; i += 1) {
      elapsed += legs[i]!.minutes;
      at.push(elapsed);
      elapsed += dwell(path[i]!);
    }

    // Place the run against its bell. The morning has to have reached its last
    // school by the bell; the afternoon cannot leave its first school before it.
    anchor = run.direction === "am"
      ? run.bell - at[at.length - 1]!
      : run.bell - at[0]!;
  }

  const minutes = at.map((minute) => Math.round(anchor + minute));
  const stopCount = run.stops.length;
  const stops = run.direction === "am"
    ? minutes.slice(0, stopCount)
    : minutes.slice(run.schools.length).reverse();
  const schools = run.direction === "am"
    ? minutes.slice(stopCount)
    : minutes.slice(0, run.schools.length);

  const result: RunTiming = {
    stops,
    schools,
    depart: Math.round(anchor),
    span: Math.round(at[at.length - 1]! - at[0]!),
    ret: Math.round(anchor + elapsed + home.minutes * BUS_DERATE),
    kilometres:
      legs.reduce((total, leg) => total + leg.kilometres, 0) + home.kilometres,
    path,
  };
  cache.set(run.id, result);
  return result;
}

/**
 * Which mode a student actually uses today.
 *
 * Everything except `lift` is already settled — a bus runs whether or not
 * anyone is free, and a walk needs nobody. A lift is the one answer that has to
 * be checked against a second person's day, and the check is deliberately the
 * cheapest one that is still correct: does the nominated adult's own roster put
 * them at a fixed commitment across the window the trip needs.
 */
export function modeToday(
  world: World,
  rider: SchoolRider,
  direction: "am" | "pm",
  date: Date,
  day: number,
): { mode: SchoolMode; escort: number | null } {
  const nominated = direction === "am" ? rider.am : rider.pm;
  if (nominated !== "lift") return { mode: nominated, escort: null };

  const escortId = direction === "am" ? rider.escort_am : rider.escort_pm;
  const fallback = (direction === "am" ? rider.fallback_am : rider.fallback_pm) ?? "walk";
  const escort = escortId === null ? null : world.persons.get(escortId);
  if (!escort) return { mode: fallback, escort: null };

  const bell = world.school.startTimes[rider.band]!;
  const out = bell + world.school.dayLength[rider.band]!;
  const [from, to] = direction === "am"
    ? [bell - DROP_WINDOW, bell + DROP_AFTER]
    : [out - DROP_AFTER, out + DROP_WINDOW];

  const busy = rosterFor(world, escort, date, day)
    .some((block) => block.fixed && block.start < to && block.end > from)
    // The tail of a shift that started yesterday: a parent coming off a night
    // watch at 08:00 is not at the gate at 07:55.
    || overnight(world, escort, date, day).some(([start, end]) => start < to && end > from)
    || siblingClash(world, rider, escort.id, direction, date, day);

  return busy ? { mode: fallback, escort: null } : { mode: "lift", escort: escortId };
}

/**
 * How far apart two school runs by one adult to two different schools must
 * be, in minutes. The escort stays are four minutes long and the drive between
 * two schools is not free; closer than this, the second run is rejected in the
 * adult's day while the child's day still has the lift.
 */
const SCHOOL_HOP = 20;

/** The minute an escort stay at this child's school ends. */
function escortMinute(world: World, rider: SchoolRider, direction: "am" | "pm"): number {
  const bell = world.school.startTimes[rider.band]!;
  return direction === "am" ? bell - 5 : bell + world.school.dayLength[rider.band]! + 5;
}

/**
 * Whether this adult is already taking a lower-id child to a different school
 * too close in time to make both runs.
 *
 * The lower id keeps the lift and this child falls back, which every party
 * computes the same way: the recursion only looks at lower ids, so it ends.
 * Two children at one school are one run and never clash.
 */
function siblingClash(
  world: World,
  rider: SchoolRider,
  escort: number,
  direction: "am" | "pm",
  date: Date,
  day: number,
): boolean {
  const children = world.school.escorting.get(escort);
  if (!children) return false;
  const mine = escortMinute(world, rider, direction);
  for (const child of children) {
    if (child >= rider.person) continue;
    const other = world.school.riders.get(child);
    if (!other || other.school === rider.school) continue;
    if (Math.abs(escortMinute(world, other, direction) - mine) >= SCHOOL_HOP) continue;
    const theirs = modeToday(world, other, direction, date, day);
    if (theirs.mode === "lift" && theirs.escort === escort) return true;
  }
  return false;
}

/** Yesterday's fixed blocks that run past midnight, in today's minutes. */
function overnight(world: World, person: Person, date: Date, day: number): [number, number][] {
  const yesterday = new Date(date);
  yesterday.setDate(date.getDate() - 1);
  const spans: [number, number][] = [];
  for (const block of rosterFor(world, person, yesterday, day - 1)) {
    if (!block.fixed || block.end <= 1440) continue;
    spans.push([block.start - 1440, block.end - 1440]);
  }
  return spans;
}

/** What a student's own day contains, beyond being at school. */
export interface SchoolTrip {
  direction: "am" | "pm";
  mode: SchoolMode;
  run: SchoolRun | null;
}

/**
 * How a student gets about today, as a mode the router understands.
 *
 * This is for everything *except* the school trip, which now carries its own
 * mode at both ends. What is left is the rest of a student's day — the walk to
 * the shop, the lift to a friend's — and their morning is the best evidence
 * there is for it: a child driven to school is a passenger the rest of the day,
 * and one who walks there walks to the shop too. `modeOf` cannot answer this at
 * all — it has no survey response for anybody who does not commute and falls
 * back to the household's car — so for a student this replaces it.
 */
export function usualFor(rider: SchoolRider): LegMode {
  switch (rider.am) {
    case "self": return "car";
    case "walk": return "walk";
    case "transit": return "transit";
    // A bus rider is not a bus rider for anything else: the yellow bus goes to
    // school and nowhere else, so the rest of their day is on foot or with a
    // parent, and which of those it is depends on how old they are.
    case "bus":
    case "lift":
    default: return "passenger";
  }
}

/** How the leg into a stay is travelled and how long it takes, where known. */
export interface Arrival {
  mode?: LegMode;
  minutes?: number;
}

/**
 * A student's school mode, as something the router can price.
 *
 * `lift` becomes `passenger` and not `car`: the child is not driving, and the
 * kilometres belong to the adult who is. `self` is the one case where a student
 * is the driver, which is why it is the only one that maps to `car`.
 */
function legModeFor(mode: SchoolMode): LegMode {
  switch (mode) {
    case "bus": return "bus";
    case "lift": return "passenger";
    case "walk": return "walk";
    case "transit": return "transit";
    case "self": return "car";
  }
}

/**
 * The stays a student's travel to and from school implies.
 *
 * The school itself is not here — that is a roster block, and `day.ts` makes a
 * stay of it the same way it does a shift. What this adds is the bus stop,
 * which is a real place a child stands for three minutes and the only reason
 * their walk to it is a leg rather than a rounding error.
 *
 * A lift adds nothing at all on the child's side. The child is a passenger; the
 * journey is the parent's, appears in the parent's leg list, and counting it
 * again here would double every school run in the city.
 */
export function riderStays(
  world: World,
  roads: Roads,
  rider: SchoolRider,
  date: Date,
  day: number,
): { stays: Sojourn<SchoolTrip>[]; trips: SchoolTrip[]; arrival: Arrival; departure: Arrival } {
  const stays: Sojourn<SchoolTrip>[] = [];
  const trips: SchoolTrip[] = [];
  // How the school itself is reached and left. The school stay belongs to the
  // roster and is built in `day.ts`, so the things this module knows about it
  // that nothing else can — that the leg in was a bus, that the leg out was the
  // back seat of a parent's car — are handed back rather than written directly.
  //
  // Both ends, separately, because the two directions are decided separately.
  // Deriving the afternoon from the morning was the first version and it priced
  // every asymmetric day wrong: walk in, collected by car, recorded as a walk.
  const arrival: Arrival = {};
  const departure: Arrival = {};
  if (!schoolDay(date)) return { stays, trips, arrival, departure };

  for (const direction of ["am", "pm"] as const) {
    const { mode } = modeToday(world, rider, direction, date, day);
    const runId = world.school.ridesOn.get(rider.person)?.[direction] ?? null;
    const run = mode === "bus" && runId ? world.school.runs.get(runId) ?? null : null;
    trips.push({ direction, mode, run });
    (direction === "am" ? arrival : departure).mode = legModeFor(mode);

    if (!run) continue;
    const clock = timing(world, roads, run);
    if (!clock) continue;

    const index = run.stops.findIndex((stop) => stop.riders.includes(rider.person));
    if (index < 0) continue;
    const stop = run.stops[index]!;
    const minute = clock.stops[index]!;

    const place: Place = {
      lat: stop.lat,
      lon: stop.lon,
      id: `${run.id}#${index}`,
      kind: "stop",
      label: direction === "am" ? "bus stop" : "bus stop (home)",
    };

    if (direction === "am") {
      // Waiting at the stop, then the ride. The ride is a leg into the school,
      // and the school stay is the roster block's, so only the wait is a stay.
      arrival.minutes = Math.max(1, clock.schools[clock.schools.length - 1]! - minute);
      stays.push({
        place,
        arrive: minute - STOP_WAIT,
        leave: minute,
        fixed: true,
        purpose: "school",
        ref: { direction, mode, run },
        // A child walks to their stop. Without this the leg is priced at the
        // household's mode — `modeOf` calls an under-16 a passenger — and the
        // city acquires nine thousand two-hundred-metre car trips a morning.
        mode: "walk" as LegMode,
      });
    } else {
      // The child steps off at the run's minute for this stop. The stay has
      // to be positive: the planner rejects a zero-length fixed stay, and the
      // rejected stop used to leave the child a direct school-to-door "bus"
      // leg at the planner's own time with no VIN.
      stays.push({
        place,
        arrive: minute,
        leave: minute + STEP_OFF,
        fixed: true,
        purpose: "school",
        ref: { direction, mode, run },
        // The ride home, priced from the run rather than from this hop.
        mode: "bus" as LegMode,
        minutes: Math.max(1, minute - clock.schools[0]!),
        // And off the bus onto the pavement. Without this the last two hundred
        // metres inherit the day's usual mode, which for a bus rider is
        // `passenger` — so every child in the city got a lift from their own
        // stop to their own front door.
        leaveMode: "walk" as LegMode,
      });
    }
  }

  return { stays, trips, arrival, departure };
}

/**
 * The detour an adult makes to take a child to school, or collect them.
 *
 * One stay per trip, at the school, four minutes long — long enough to be a
 * stop rather than a drive-past and short enough to be a drop-off rather than a
 * visit. It is fixed, because the bell is: a parent who arrives after it has
 * not dropped their child off late, they have made a different journey.
 *
 * Reads other people, and this is the one place in this subsystem that does. It is
 * bounded: the children of one adult, each answered from their own static row
 * by the same predicate the child evaluates, with no planning of anybody's day.
 */
export function escortStays(
  world: World,
  person: Person,
  date: Date,
  day: number,
): Sojourn<{ child: number; direction: "am" | "pm" }>[] {
  if (!schoolDay(date)) return [];
  const children = world.school.escorting.get(person.id);
  if (!children) return [];

  const stays: Sojourn<{ child: number; direction: "am" | "pm" }>[] = [];
  for (const child of children) {
    const rider = world.school.riders.get(child);
    if (!rider) continue;
    const at = placeOf(world, rider.school);
    if (!at) continue;

    for (const direction of ["am", "pm"] as const) {
      const today = modeToday(world, rider, direction, date, day);
      if (today.mode !== "lift" || today.escort !== person.id) continue;

      const bell = world.school.startTimes[rider.band]!;
      const minute = direction === "am"
        ? bell - 5
        : bell + world.school.dayLength[rider.band]! + 5;

      stays.push({
        place: { lat: at.lat, lon: at.lon, id: rider.school, kind: "school", label: "school run" },
        arrive: minute - 4,
        leave: minute,
        fixed: true,
        purpose: "escort",
        ref: { child, direction },
      });
    }
  }

  return stays;
}

/**
 * A bus driver's runs, as the stays that make them.
 *
 * Every stop is a stay and every school is a stay, which is what turns the run
 * into a routed multi-waypoint path rather than a pair of points with a made-up
 * duration between them. The legs between them are `bus` mode with the run's
 * own minutes, so the driver's day and every rider's day are priced off one
 * answer.
 *
 * The depot brackets each run. It matters more than it looks: it is where the
 * driver's own car is left, and without it the chain would have them driving
 * their car to the first stop of the route.
 */
export function driverStays(
  world: World,
  roads: Roads,
  person: Person,
  date: Date,
  day: number,
): Sojourn<{ run: SchoolRun; leg: number }>[] {
  if (!schoolDay(date)) return [];
  const runs = world.school.driving.get(person.id);
  if (!runs || runs.length === 0) return [];

  const stays: Sojourn<{ run: SchoolRun; leg: number }>[] = [];

  // The depot brackets each *block* of runs, not each run.
  //
  // A driver covering three tiers does not go back to the yard between them —
  // they drop the high schoolers and drive straight to the first stop of the
  // middle school route. Bracketing every run put two dead-head trips to the
  // depot in the middle of every morning, which is both wrong and expensive:
  // the yard is at the centroid of the schools served, so the detour is real
  // distance, and it was enough to make the runs overlap and the driver late.
  const first = new Set<string>();
  const last = new Set<string>();
  for (const direction of ["am", "pm"] as const) {
    const block = runs.filter((run) => run.direction === direction);
    if (block.length === 0) continue;
    first.add(block[0]!.id);
    last.add(block[block.length - 1]!.id);
  }

  for (const run of runs) {
    const clock = timing(world, roads, run);
    const depot = world.school.depots.get(run.operator);
    if (!clock || !depot) continue;

    const minutes = run.direction === "am"
      ? [...clock.stops, ...clock.schools]
      : [...clock.schools, ...[...clock.stops].reverse()];

    const depotPlace: Place = {
      lat: depot.lat,
      lon: depot.lon,
      id: `depot/${run.operator}`,
      kind: "depot",
      label: "bus depot",
    };

    if (first.has(run.id)) {
      stays.push({
        place: depotPlace,
        arrive: clock.depart - 12,
        leave: clock.depart,
        fixed: true,
        purpose: "run",
        ref: { run, leg: -1 },
      });
    }

    for (let i = 0; i < clock.path.length; i += 1) {
      const place = clock.path[i]!;
      const minute = minutes[i]!;
      const dwell = place.kind === "school" ? SCHOOL_DWELL : DWELL_MINUTES;
      stays.push({
        place,
        arrive: minute,
        leave: minute + dwell,
        fixed: true,
        purpose: "run",
        ref: { run, leg: i },
        mode: "bus" as LegMode,
        ...(run.vin ? { vehicleId: run.vin } : {}),
        // The leg into the first waypoint is the dead-head from wherever the
        // bus was — the yard on the first run of a block, the last school of
        // the previous run otherwise — and the chain routes it either way.
        minutes: i === 0
          ? (first.has(run.id) ? Math.max(1, minute - clock.depart) : undefined)
          : Math.max(0.5, minute - minutes[i - 1]!),
      });
    }

    if (last.has(run.id)) {
      stays.push({
        place: depotPlace,
        arrive: clock.ret,
        leave: clock.ret + 8,
        fixed: true,
        purpose: "run",
        ref: { run, leg: clock.path.length },
        mode: "bus" as LegMode,
        ...(run.vin ? { vehicleId: run.vin } : {}),
        minutes: Math.max(1, clock.ret - minutes[minutes.length - 1]!),
      });
    }
  }

  return stays;
}

/** Every kilometre driven by a bus today, which is not a personal vehicle. */
export function busKilometres(world: World, roads: Roads, person: Person): number {
  const runs = world.school.driving.get(person.id);
  if (!runs) return 0;
  return runs.reduce((total, run) => total + (timing(world, roads, run)?.kilometres ?? 0), 0);
}

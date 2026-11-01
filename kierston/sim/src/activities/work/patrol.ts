/**
 * What a police officer does with the eight hours between roll call and end of
 * watch, for the ones who spend them in a car.
 *
 * Before this module the city's two hundred and ten officers arrived at a
 * station, sat in it for their whole tour, and drove home — which is what the
 * roster says, because a roster is a posting and a posting is a building. The
 * building is where the shift starts and ends and it is not where the shift
 * happens. A patrol officer is the one worker in this city whose job *is*
 * driving around it, and leaving them parked deleted the single most
 * distinctive movement pattern a simulated city has: a small number of vehicles
 * covering a great deal of ground, all day and all night, over the same
 * territory, never going anywhere in particular.
 *
 * Not every officer, and the share is the point
 * ---------------------------------------------
 * `init_work.py` posts everyone at a station to `duty: patrol`, which says
 * where they are assigned and not what they are doing at two in the afternoon.
 * The same establishment covers the desk, the booking room, court, warrants,
 * the school details and the sergeants who spend the tour in an office. So a
 * share of each watch is on the road and the rest are in the building, and the
 * share is not flat across the clock — the day watch carries nearly all the
 * administrative posts and the night watch almost none. See `PATROL_SHARE` in
 * `fleet.py`, which is where the number lives, because the same number sizes
 * the fleet: the cars registered there are exactly the cars this puts out.
 *
 * A unit is capped by the yard, not by the roster. A station that has fourteen
 * officers drawn for cars and eleven cars puts out eleven units, and the other
 * three work the building. That is the right way round — a department cannot
 * field a car it does not own — and it is what keeps the vehicle timeline sound
 * without any coordination between officers' days.
 *
 * Why this can be computed one officer at a time
 * ----------------------------------------------
 * Whether *this* officer is in a car depends on how many of their colleagues
 * drew one first, which sounds like the thing the whole design forbids: a day
 * that depends on other people's days is a day that depends on the order the
 * city was planned in.
 *
 * It is not that. What the station is asked for is a fact about static rows —
 * who is posted here, on which watch, and whether their rota has them in today
 * — and `rosterFor` answers the last of those from one person's assignment and
 * the date, with nothing planned and nothing shared. So every officer at a
 * station derives the same roster, in the same order, and reads their own place
 * in it. It is the device `school.ts` uses for a bus run and `affiliations.ts`
 * for an org's calendar, and it is the reason a patrol shift can be generated
 * in a worker process that has never seen another officer's day.
 *
 * The beat is geography, not a lookup
 * -----------------------------------
 * The extract contains no police districts — OSM does not carry them and the
 * city does not publish them in it — so the beats are derived: the dwellings
 * are clustered into ten territories of roughly equal population, each
 * station takes the ones nearest to it, and its units cycle through them. That
 * is an invention and is meant to be read as one. What it gets right is the
 * shape of the thing: coverage is proportional to where people live, a unit
 * stays inside its own territory for a whole watch, and downtown is patrolled
 * by cars from the downtown station.
 *
 * What a watch is made of
 * -----------------------
 * Roll call, then a sequence of stops with driving between them, then back to
 * the station to write it up. The stops are the tour's whole substance: a
 * patrol shift is not a continuous drive, it is twenty short stationary
 * intervals — a traffic stop, a call, a property check, twenty minutes sat on a
 * corner where the complaints come from — joined by the movement between them.
 * Modelling the watch as one long drive would produce the right mileage and the
 * wrong everything else, because what a plate reader, a phone mast and a
 * witness all see is where a car *stopped*.
 *
 * Calls for service live in `dispatch/`, which splices them into this tour.
 */

import { placeOf, type FleetVehicle, type Person, type Point, type World } from "../../world/index.ts";
import { haversineKm, type Place, type Roads, type Sojourn } from "../../transport/index.ts";
import { LAYER, mix, Rng } from "../../shared/index.ts";
import { rosterFor, type Block } from "./roster.ts";

/** The role and duty this whole module is about. */
const OFFICER = "police_officer";
const PATROL_DUTY = "patrol";

/**
 * What share of a watch's patrol-duty officers is drawn for a car.
 *
 * The same table as `fleet.PATROL_SHARE`, and it has to stay the same table:
 * the fleet is sized on the peak of these shares, so raising one here without
 * re-running the vehicle stage puts more officers in cars than the city owns
 * and the surplus simply works the station. Copied rather than imported for the
 * ordinary reason — the Python stage runs long before this does, and the number
 * has to be readable at both ends.
 */
const PATROL_SHARE: Record<string, number> = { day: 0.36, evening: 0.45, night: 0.55 };

/** Minutes after the start of the watch that the car actually leaves the yard. */
const ROLL_OUT = 12;

/**
 * Minutes before end of watch that the unit is back at the station.
 *
 * The reports, the property, the handover to the next watch. It is also what
 * keeps the fleet's timeline clean: the car is back before the officer relieving
 * them rolls out, and it is anchored on the *scheduled* end of the watch rather
 * than on the roster's block, which carries overtime. An officer held over is
 * held over at the station, which is where the paperwork is.
 */
const WRAP = 30;

/** Below this there is not enough watch left to be worth taking a car out. */
const MIN_TOUR = 90;

/**
 * How long a unit is stopped at one point of the beat.
 *
 * Four minutes is a plate check or a drive-past that turned into nothing;
 * sixteen is a traffic stop written up, or a quarter of an hour sat where the
 * complaints come from. The pair is set against the hop distance below rather
 * than on its own: together they decide what share of the watch the car spends
 * moving, and that is the number with something to check it against — see
 * `HOP_KM`.
 */
const STOP_MIN = 4;
const STOP_MAX = 16;

/**
 * The meal break, which is a genuine feature of a watch and not a detail.
 *
 * Half an hour, once, somewhere in the middle third. It is the longest the car
 * stands still all tour and therefore the most observable thing in the shift —
 * a stationary plate for thirty minutes outside the same place most nights is
 * exactly the kind of pattern this simulation exists to contain.
 */
const MEAL_MINUTES = 30;

/**
 * How many territories the city is divided into.
 *
 * Ten over a city of forty-six square kilometres puts a beat at about two
 * kilometres across, which is both what a real municipal beat measures and
 * small enough that a unit crosses its own territory several times a watch.
 */
const BEATS = 10;

/** Lloyd passes. The clusters settle in far fewer; this is the ceiling. */
const BEAT_PASSES = 12;

/** Points on the beat a unit can be at. Enough that a watch does not repeat. */
const WAYPOINTS_PER_BEAT = 48;

/**
 * How much of a beat's waypoints sit on roads worth patrolling.
 *
 * A unit works the arterials, the commercial strip and the through routes; it
 * does not spend a watch parked in cul-de-sacs. But it does not spend it all on
 * Hamilton Street either, so a third of the points are ordinary residential
 * nodes and the beat has some depth to it.
 */
const RANKED_SHARE = 2 / 3;

/** Road classes a patrol car is actually seen on. */
const RANKED: ReadonlySet<string> = new Set([
  "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link", "unclassified", "residential",
]);

/** Classes a unit does not stop on: no kerb, no reason, and no way back. */
const UNPATROLLED: ReadonlySet<string> = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "service", "busway",
]);

/**
 * How far the next point of the beat tends to be, in kilometres, and how
 * tightly that holds.
 *
 * A unit does not teleport across its territory between stops and it does not
 * shuffle down one street either. Somewhere under two kilometres is what
 * covering a beat looks like; the spread is wide enough that the occasional run
 * to the far corner still happens.
 *
 * This and the dwell above are what the watch's mileage comes out of, and the
 * mileage is the one thing here with a published counterpart: a municipal
 * patrol unit turns somewhere between sixty and a hundred and thirty kilometres
 * on an eight-hour shift, depending mostly on how much of the beat is grid and
 * how much is arterial. The pair below land the simulated watch inside that,
 * with about half the tour spent moving.
 *
 * It is a floor rather than an estimate, and the reason is worth stating: a
 * real unit *cruises*, and this one drives the shortest route between two
 * points and then stops. The circling that fills the gaps in a real shift is
 * mileage this model cannot produce without inventing stops nobody made.
 */
const HOP_KM = 1.8;
const HOP_SPREAD = 1.0;

/** Candidates considered per hop. Enough to choose from, cheap enough to route. */
const HOP_CANDIDATES = 8;

/**
 * A ceiling on the stops in one watch, so a pathological beat cannot spin.
 *
 * Well above what a watch reaches — the tour ends when there is no longer time
 * to make another stop and still be back — so it is a guard and not a shape.
 */
const MAX_STOPS = 60;

export interface PatrolPost {
  kind: "station" | "post" | "meal" | "scene";
  beat: number;
  index: number;
  vin: string | null;
  incident?: number;
  incidentKind?: number;
}

export interface Beat {
  id: number;
  centre: Point;
  waypoints: Place[];
}

/** One officer's place in their station's line-up for the day. */
export interface Unit {
  person: number;
  vin: string;
  station: string;
  beat: number;
}

// ---------------------------------------------------------------------------
// Geography

const beatCache = new WeakMap<World, Beat[]>();

/**
 * The city's patrol territories, derived once from where people live.
 *
 * Farthest-point seeding and then Lloyd's algorithm, which is the same
 * construction `stands` uses for cab ranks and for the same reason: random
 * seeding on a city this shape drops two centres in the same downtown cluster
 * about a third of the time, and a beat that duplicates another one is a beat
 * the outskirts do not get.
 *
 * Clustered on dwellings rather than on the road network. A beat is a share of
 * the population to be covered, not a share of the tarmac — the industrial
 * north-east has a great deal of road and very few people in it, and a beat
 * drawn on roads would send a car round it every night for nobody.
 */
export function beats(world: World, roads: Roads): Beat[] {
  const known = beatCache.get(world);
  if (known) return known;

  const homes: Point[] = [];
  for (const household of world.households.values()) {
    const point = household.dwelling ? world.places.get(household.dwelling) : undefined;
    if (point) homes.push(point);
  }
  if (homes.length === 0) {
    beatCache.set(world, []);
    return [];
  }

  const rng = new Rng(mix(world.seed, LAYER.patrol));
  const centres: Point[] = [homes[rng.int(0, homes.length - 1)]!];
  while (centres.length < Math.min(BEATS, homes.length)) {
    let best = homes[0]!;
    let bestDistance = -1;
    for (const point of homes) {
      let nearest = Infinity;
      for (const centre of centres) nearest = Math.min(nearest, haversineKm(point, centre));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = point;
      }
    }
    centres.push(best);
  }

  const owner = new Int32Array(homes.length);
  for (let pass = 0; pass < BEAT_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < homes.length; i += 1) {
      let pick = 0;
      let nearest = Infinity;
      for (let c = 0; c < centres.length; c += 1) {
        const distance = haversineKm(homes[i]!, centres[c]!);
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
    for (let i = 0; i < homes.length; i += 1) {
      const c = owner[i]!;
      lat[c] += homes[i]!.lat;
      lon[c] += homes[i]!.lon;
      count[c] += 1;
    }
    for (let c = 0; c < centres.length; c += 1) {
      if (count[c]! === 0) continue;
      centres[c] = { lat: lat[c]! / count[c]!, lon: lon[c]! / count[c]! };
    }
    if (!moved) break;
  }

  const built = centres.map((centre, id) => ({ id, centre, waypoints: [] as Place[] }));
  assignWaypoints(built, roads, world.seed);
  beatCache.set(world, built);
  return built;
}

/**
 * Give every beat somewhere to be, off the road graph itself.
 *
 * The waypoints are junctions, not interpolated coordinates, for the reason
 * `walkPrefix` gives at length: a point between two nodes lands wherever it
 * lands — the middle of a rail yard, the far side of the river — and the drive
 * to it then snaps to whatever node is nearest, which can be most of a
 * kilometre away and reachable only the long way round.
 *
 * Only the largest strongly connected component. A node off it cannot be routed
 * to or from, and a beat with one on it would have a unit vanish for a watch.
 */
function assignWaypoints(built: Beat[], roads: Roads, seed: number): void {
  const { lat, lon, offset, classId, classes, component, largestComponent, nodeCount } = roads.graph;
  const ranked: number[][] = built.map(() => []);
  const ordinary: number[][] = built.map(() => []);

  for (let node = 0; node < nodeCount; node += 1) {
    if (component[node] !== largestComponent) continue;
    let best: string | null = null;
    let patrollable = false;
    for (let slot = offset[node]!; slot < offset[node + 1]!; slot += 1) {
      const name = classes[classId[slot]!] ?? "";
      if (UNPATROLLED.has(name)) continue;
      patrollable = true;
      if (RANKED.has(name) && (best === null || rank(name) < rank(best))) best = name;
    }
    if (!patrollable) continue;

    const here = { lat: lat[node]!, lon: lon[node]! };
    let pick = 0;
    let nearest = Infinity;
    for (const beat of built) {
      const distance = haversineKm(here, beat.centre);
      if (distance < nearest) {
        nearest = distance;
        pick = beat.id;
      }
    }
    (best !== null && rank(best) <= rank("tertiary") ? ranked : ordinary)[pick]!.push(node);
  }

  for (const beat of built) {
    const rng = new Rng(mix(seed, LAYER.patrol, beat.id));
    const wanted = Math.round(WAYPOINTS_PER_BEAT * RANKED_SHARE);
    const chosen = [
      ...sample(ranked[beat.id]!, wanted, rng),
      ...sample(ordinary[beat.id]!, WAYPOINTS_PER_BEAT - wanted, rng),
    ];
    beat.waypoints = chosen.map((node, index) => ({
      lat: lat[node]!,
      lon: lon[node]!,
      id: `beat/${beat.id}/${index}`,
      kind: "kerb" as const,
      label: `beat ${beat.id + 1} · ${index}`,
    }));
  }
}

/** Lower is a bigger road. Used only to prefer one class over another. */
function rank(name: string): number {
  const order = ["primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential"];
  const at = order.indexOf(name);
  return at < 0 ? order.length : at;
}

/** `count` items, without replacement, deterministically. */
function sample(pool: readonly number[], count: number, rng: Rng): number[] {
  if (pool.length <= count) return [...pool];
  const taken = new Set<number>();
  const out: number[] = [];
  // Bounded: the pool is always far larger than the count in practice, and the
  // guard is what stops a small beat from spinning on collisions.
  for (let attempt = 0; out.length < count && attempt < count * 12; attempt += 1) {
    const index = rng.int(0, pool.length - 1);
    if (taken.has(index)) continue;
    taken.add(index);
    out.push(pool[index]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who is in a car

interface Posting {
  person: number;
  watch: string;
}

const postingCache = new WeakMap<World, Map<string, Posting[]>>();

/** Every patrol-duty officer, by the station and watch they are posted to. */
function postings(world: World): Map<string, Posting[]> {
  const known = postingCache.get(world);
  if (known) return known;
  const out = new Map<string, Posting[]>();
  for (const assignment of world.assignments.values()) {
    if (assignment.role !== OFFICER || assignment.duty !== PATROL_DUTY) continue;
    const watch = assignment.shift?.watch;
    if (!assignment.site || !watch) continue;
    const key = `${assignment.site}/${watch}`;
    const mine = out.get(key) ?? [];
    mine.push({ person: assignment.person, watch });
    out.set(key, mine);
  }
  // Person order, so every officer at a station derives the same line-up.
  for (const mine of out.values()) mine.sort((a, b) => a.person - b.person);
  postingCache.set(world, out);
  return out;
}

const beatOrderCache = new WeakMap<World, Map<string, number[]>>();

/**
 * The beats a station's units work, nearest first.
 *
 * Each beat belongs to the station nearest to it, so every territory has an
 * owner and no beat is covered twice while another goes uncovered. A station
 * that owns nothing — the substation is four hundred metres from headquarters
 * and loses every beat to it — falls back to working the ones nearest to it
 * anyway, which is what a detachment in the same downtown actually does.
 */
function beatsFor(world: World, roads: Roads, station: string): number[] {
  const cache = beatOrderCache.get(world) ?? new Map<string, number[]>();
  beatOrderCache.set(world, cache);
  const known = cache.get(station);
  if (known) return known;

  const all = beats(world, roads);
  const here = placeOf(world, station);
  if (!here || all.length === 0) {
    cache.set(station, []);
    return [];
  }

  const stations = [...postings(world).keys()]
    .map((key) => key.slice(0, key.lastIndexOf("/")))
    .filter((site, index, list) => list.indexOf(site) === index)
    .sort();

  const owned = all.filter((beat) => {
    let nearest: string | null = null;
    let best = Infinity;
    for (const site of stations) {
      const point = placeOf(world, site);
      if (!point) continue;
      const distance = haversineKm(beat.centre, point);
      if (distance < best) {
        best = distance;
        nearest = site;
      }
    }
    return nearest === station;
  });

  const order = (owned.length > 0 ? owned : all)
    .slice()
    .sort((a, b) => haversineKm(a.centre, here) - haversineKm(b.centre, here))
    .map((beat) => beat.id);
  cache.set(station, order);
  return order;
}

const unitCache = new Map<string, Map<number, Unit>>();

/**
 * The units one station puts out on one watch on one day.
 *
 * Every officer posted here evaluates this and finds themselves in it or not,
 * which is what makes the answer consistent without anybody coordinating. The
 * draw is per officer per day — an officer is not permanently a car officer,
 * because the desk and the wagon rotate — and the cars are handed out in person
 * order until the yard is empty.
 */
function unitsAt(
  world: World,
  roads: Roads,
  station: string,
  watch: string,
  date: Date,
  day: number,
): Map<number, Unit> {
  const key = `${station}/${watch}/${day}`;
  const known = unitCache.get(key);
  if (known) return known;

  const units = new Map<number, Unit>();
  const cars: readonly FleetVehicle[] = world.fleet.patrolCars.get(station) ?? [];
  const roster = postings(world).get(`${station}/${watch}`) ?? [];
  const order = beatsFor(world, roads, station);
  if (cars.length === 0 || roster.length === 0 || order.length === 0) {
    unitCache.set(key, units);
    return units;
  }

  const share = PATROL_SHARE[watch] ?? 0.4;
  let index = 0;
  for (const posting of roster) {
    if (index >= cars.length) break;
    const person = world.persons.get(posting.person);
    if (!person) continue;
    // On duty at all today, which is the rota's answer and nobody else's.
    if (!rosterFor(world, person, date, day).some((block) => block.kind === "work")) continue;
    if (new Rng(mix(world.seed, posting.person, LAYER.patrol, day)).next() >= share) continue;
    units.set(posting.person, {
      person: posting.person,
      vin: cars[index]!.vin,
      station,
      beat: order[index % order.length]!,
    });
    index += 1;
  }

  unitCache.set(key, units);
  return units;
}

/** This officer's unit today, or null where they are working the building. */
export function unitFor(
  world: World,
  roads: Roads,
  person: Person,
  block: Block,
  date: Date,
  day: number,
): Unit | null {
  const assignment = world.assignments.get(person.id);
  if (!assignment || assignment.role !== OFFICER || assignment.duty !== PATROL_DUTY) return null;
  const watch = assignment.shift?.watch;
  if (!assignment.site || !watch || block.kind !== "work") return null;
  return unitsAt(world, roads, assignment.site, watch, date, day).get(person.id) ?? null;
}

// ---------------------------------------------------------------------------
// The watch

export interface PatrolContext {
  world: World;
  roads: Roads;
}

/**
 * One officer's watch, as the stays it is made of.
 *
 * The station brackets it at both ends, exactly as the depot brackets a bus
 * driver's runs, and for the same two reasons: it is where the car is, and it
 * is where the officer's own car is standing while they are out in it. The
 * first stay carries no mode, so the journey into it is priced as the ordinary
 * commute the officer actually makes; every stay after it is `patrol` with the
 * minutes this module measured, so nothing downstream re-prices a route it did
 * not plan.
 *
 * Empty for everyone who is not in a car today, which is most of the force and
 * all of the rest of the city.
 */
export function patrolStays(
  context: PatrolContext,
  person: Person,
  block: Block,
  date: Date,
  day: number,
): Sojourn<PatrolPost>[] {
  const { world, roads } = context;
  const unit = unitFor(world, roads, person, block, date, day);
  if (!unit) return [];

  const shift = world.assignments.get(person.id)?.shift;
  const station = placeOf(world, world.assignments.get(person.id)?.site ?? null);
  const beat = beats(world, roads)[unit.beat];
  if (!shift || !station || !beat || beat.waypoints.length === 0) return [];

  const rollOut = shift.start + ROLL_OUT;
  const back = shift.end - WRAP;
  if (back - rollOut < MIN_TOUR) return [];

  const stationPlace: Place = {
    ...station,
    id: world.assignments.get(person.id)!.site,
    kind: "work",
    label: "station",
  };

  const stays: Sojourn<PatrolPost>[] = [{
    place: stationPlace,
    arrive: block.start,
    leave: rollOut,
    fixed: true,
    purpose: "work",
    ref: { kind: "station", beat: unit.beat, index: -1, vin: null },
  }];

  const rng = new Rng(mix(world.seed, person.id, LAYER.patrol, day, 1));
  const midpoint = (rollOut + back) / 2;
  let at = rollOut;
  let from: Point = station;
  let last: string | null = null;
  let mealTaken = false;
  // The drive back to the station, as it was priced when the last stop was
  // accepted. Reusing that number rather than re-routing at the end is what
  // keeps the unit from being a minute late into its own yard: the two prices
  // are the same road at two different minutes of congestion, and the stop was
  // only taken because the first one fitted.
  let homeward = 0;

  for (let stop = 0; stop < MAX_STOPS; stop += 1) {
    const next = nextPoint(beat, from, last, rng);
    if (!next) break;
    const out = Math.max(1, Math.round(roads.trip(from, next, at).minutes));
    const arrive = at + out;
    // A meal is taken at the first stop past the middle of the watch, which is
    // when a break falls: not at a fixed minute, because the watch does not
    // stop for the clock, and not at random, because nobody eats at 23:10 and
    // again at 23:40.
    const meal = !mealTaken && arrive >= midpoint;
    const dwell = meal ? MEAL_MINUTES : rng.int(STOP_MIN, STOP_MAX);
    // Only take the stop if the unit can still be back before end of watch.
    const home = Math.max(1, Math.round(roads.trip(next, station, arrive + dwell).minutes));
    if (arrive + dwell + home > back) break;

    stays.push({
      place: next,
      arrive,
      leave: arrive + dwell,
      fixed: true,
      purpose: "patrol",
      ref: { kind: meal ? "meal" : "post", beat: unit.beat, index: stop, vin: unit.vin },
      mode: "patrol",
      minutes: out,
      vehicleId: unit.vin,
    });
    if (meal) mealTaken = true;
    at = arrive + dwell;
    from = next;
    last = next.id;
    homeward = home;
  }

  // A watch with nowhere to go is not a watch. It happens only where the beat
  // is unroutable, and the officer works the station like anybody else.
  if (stays.length === 1) return [];

  // Back to the station, and the rest of the tour is spent in it. `block.end`
  // rather than the watch's own end, so an officer held over is held over here
  // — which is the one place overtime belongs, since the car has to be in the
  // yard before the next watch takes it.
  stays.push({
    place: stationPlace,
    arrive: back,
    leave: Math.max(back + 1, block.end),
    fixed: true,
    purpose: "work",
    ref: { kind: "station", beat: unit.beat, index: MAX_STOPS, vin: unit.vin },
    mode: "patrol",
    minutes: Math.max(1, homeward),
    vehicleId: unit.vin,
  });

  return stays;
}

/**
 * Where the unit goes next.
 *
 * Drawn from a handful of the beat's points weighted on how far away they are,
 * rather than the nearest or a uniform pick. The nearest would walk the car
 * down one street for eight hours; a uniform pick would have it cross its whole
 * territory between every pair of stops, which is both wrong and expensive to
 * route.
 */
function nextPoint(beat: Beat, from: Point, last: string | null, rng: Rng): Place | null {
  const points = beat.waypoints;
  if (points.length === 0) return null;

  const candidates: Place[] = [];
  const weights: number[] = [];
  for (let i = 0; i < Math.min(HOP_CANDIDATES, points.length); i += 1) {
    const candidate = points[rng.int(0, points.length - 1)]!;
    if (candidate.id === last) continue;
    const distance = haversineKm(from, candidate);
    candidates.push(candidate);
    weights.push(Math.exp(-((distance - HOP_KM) ** 2) / (2 * HOP_SPREAD ** 2)) + 1e-6);
  }
  if (candidates.length === 0) return null;
  return rng.weighted(candidates, weights);
}

"use client";

import { clock, siteLabel, type Employment, type Assignment, type Site } from "./employment";
import { haversine } from "./enrollment";
import type { Fleets } from "./fleet";

/**
 * The cab trade: where a car waits, who waits in it, and who calls one.
 *
 * sim_data/taxi.json is the standing half of kierston/sim/src/transport/taxi.ts, and it
 * is the only file this app reads that the simulation writes rather than an
 * init stage. That is not a filing accident. Everything else in the taxi layer
 * — the fares, the waits, the empty mileage — exists only once a date has been
 * picked and a fleet dispatched against a day's demand, and none of it can be
 * shown here until KierstonBlue can ask the simulation to run one. What is in
 * this file is what does not move: eight stands and the driver habits attached
 * to them.
 *
 * Why the geometry is imported rather than computed
 * -------------------------------------------------
 * A stand is the centre of a cluster of taxi-commuter homes and workplaces,
 * found by Lloyd's algorithm seeded through the population seed; which stand a
 * given driver keeps is a weighted draw made once from that same seed. Both
 * are reproducible only by the code that made them. Re-deriving either here
 * would give an answer that looks right and is a different city — ranks nobody
 * in the simulation waits at, on a map that says they do. So the simulation
 * writes down what it uses and this reads it.
 *
 * Two things the numbers here do not say
 * --------------------------------------
 * A stand's `mass` counts demand *points*, not people: a rider contributes
 * their home and their workplace separately, and the two usually fall to
 * different stands. It is a measure of where the work is, which is what a
 * driver picking a rank is actually weighing.
 *
 * And a rider is somebody whose census answer to how they get to work was a
 * cab — not somebody who got one. Whether a car reaches them on any given
 * morning is a fare, and a fare is a day's business: eighteen minutes of
 * waiting and they walk instead. That distinction is the whole reason the two
 * halves of this layer are in different places.
 */

/**
 * A colour per stand, so a catchment reads as an area rather than a list.
 *
 * Eight is what `STANDS` in sim/src/transport/taxi.ts asks for and eight is what this
 * has; a ninth stand would wrap and two ranks would share a colour, which is
 * worth knowing before that constant is raised. Chosen to stay apart at the
 * small dot sizes the map draws demand points at rather than to be pretty.
 */
export const STAND_COLORS = [
  "#e2a02f", "#2a86c8", "#3d9a5c", "#c2417a",
  "#7a4fc0", "#00a0a8", "#eb6834", "#5d6b78",
] as const;

export const standColor = (index: number) =>
  STAND_COLORS[((index % STAND_COLORS.length) + STAND_COLORS.length) % STAND_COLORS.length];

export interface Stand {
  index: number;
  id: string;
  lat: number;
  lon: number;
  /** Homes and workplaces nearest to it — what makes one rank busier. */
  mass: number;
  /** Indexes into `drivers`. */
  drivers: number[];
  /** Indexes into `riders` whose home falls to this stand. */
  homes: number[];
  /** Indexes into `riders` whose workplace falls to this stand. */
  works: number[];
}

/** A watch, as `init_work.py` posted the driver into it. */
export type Watch = "day" | "evening" | "night";

export const WATCHES: Watch[] = ["day", "evening", "night"];

export const WATCH_LABEL: Record<Watch, string> = {
  day: "Day",
  evening: "Evening",
  night: "Night",
};

export const WATCH_COLOR: Record<Watch, string> = {
  day: "#e2a02f",
  evening: "#c2417a",
  night: "#2a86c8",
};

export interface Driver {
  index: number;
  person: number;
  lat: number;
  lon: number;
  /** Index into `stands`. */
  stand: number;
  /** Straight-line kilometres from their door to the rank they keep. */
  km: number;
  watch: Watch | null;
  /** Minutes past midnight. `end` may exceed 1440 on a night watch. */
  start: number | null;
  end: number | null;
  assignment: Assignment | null;
  operator: number | null;
  operatorName: string | null;
  vehicle: string | null;
  /**
   * The site their job is posted to, which for an itinerant role is a base
   * rather than a place they sit. Not where they wait — that is the stand.
   */
  depot: Site | null;
}

export interface Rider {
  index: number;
  person: number;
  lat: number;
  lon: number;
  /** Index into `stands` for the home end, -1 where there is no dwelling. */
  homeStand: number;
  site: string | null;
  workLat: number;
  workLon: number;
  workStand: number;
  /** Straight-line kilometres, home to work. */
  km: number;
  assignment: Assignment | null;
  workplace: Site | null;
}

export class TaxiFleet {
  readonly source: string;
  readonly seed: number;
  readonly stands: Stand[];
  readonly drivers: Driver[];
  readonly riders: Rider[];
  /** Resident id → index into `drivers`, for the record page's benefit. */
  readonly byDriver: Map<number, number>;
  readonly byRider: Map<number, number>;
  readonly watches: Record<Watch, number>;
  /** Drivers with no shift on their assignment, so no watch to place them on. */
  readonly unwatched: number;

  constructor(init: {
    source: string;
    seed: number;
    stands: Stand[];
    drivers: Driver[];
    riders: Rider[];
  }) {
    this.source = init.source;
    this.seed = init.seed;
    this.stands = init.stands;
    this.drivers = init.drivers;
    this.riders = init.riders;

    this.byDriver = new Map(this.drivers.map((driver) => [driver.person, driver.index]));
    this.byRider = new Map(this.riders.map((rider) => [rider.person, rider.index]));

    this.watches = { day: 0, evening: 0, night: 0 };
    this.unwatched = 0;
    for (const driver of this.drivers) {
      if (driver.watch) this.watches[driver.watch] += 1;
      else this.unwatched += 1;
    }
  }

  standOf(index: number): Stand | null {
    return index >= 0 && index < this.stands.length ? this.stands[index] : null;
  }

  /** Where a rider works, as a name rather than an OSM id. */
  workplace(rider: Rider): string {
    return rider.site ? siteLabel(rider.workplace) : "Outside the region";
  }

  /**
   * Cars on the road at a given minute, by the establishment.
   *
   * The shape of the day the fleet is *staffed* for, which is not the shape of
   * the day it works: a rota decides which dates a driver's watch actually
   * lands on, and this counts every driver as if theirs landed on all of them.
   * So it is an envelope — nobody is out who is not counted here — and the
   * curve of real cars sits somewhere underneath it.
   */
  onWatch(minute: number): number {
    let count = 0;
    for (const driver of this.drivers) {
      if (driver.start === null || driver.end === null) continue;
      // A night watch runs past midnight, so its window is stored unwrapped
      // and has to be asked about twice — once as itself, once a day earlier.
      if (minute >= driver.start && minute < driver.end) count += 1;
      else if (minute + 1440 >= driver.start && minute + 1440 < driver.end) count += 1;
    }
    return count;
  }

  /** The busiest minute of the staffed day, and how many cars it has. */
  get peak(): { minute: number; cars: number } {
    let best = { minute: 0, cars: 0 };
    for (let minute = 0; minute < 1440; minute += 5) {
      const cars = this.onWatch(minute);
      if (cars > best.cars) best = { minute, cars };
    }
    return best;
  }

  get standbyMass(): number {
    return this.stands.reduce((sum, stand) => sum + stand.mass, 0);
  }
}

// ---- Decoding ---------------------------------------------------------------

interface RawPoint { lat: number; lon: number }

export interface TaxiFile {
  source: string;
  seed: number;
  stands: { id: string; lat: number; lon: number; mass: number }[];
  drivers: {
    person: number;
    home: RawPoint;
    operator: number | null;
    vehicle: string | null;
    depot: RawPoint | null;
    stand: number;
    km: number;
    watch: string | null;
    start: number | null;
    end: number | null;
  }[];
  riders: {
    person: number;
    home: RawPoint | null;
    homeStand: number;
    site: string | null;
    work: RawPoint | null;
    workStand: number;
  }[];
}

function watchOf(value: string | null): Watch | null {
  return value === "day" || value === "evening" || value === "night" ? value : null;
}

export function joinTaxi(file: TaxiFile, employment: Employment, fleet: Fleets): TaxiFleet {
  /** The job behind a resident id, and the site it is posted to. */
  const job = (person: number): { assignment: Assignment | null; site: Site | null } => {
    const assignment = employment.forPerson(person);
    return { assignment, site: employment.siteOf(assignment) };
  };

  const stands: Stand[] = file.stands.map((stand, index) => ({
    index,
    id: stand.id,
    lat: stand.lat,
    lon: stand.lon,
    mass: stand.mass,
    drivers: [],
    homes: [],
    works: [],
  }));

  const drivers: Driver[] = file.drivers.map((driver, index) => {
    const posting = job(driver.person);
    const operator = driver.operator === null ? null : fleet.operatorById.get(driver.operator) ?? null;
    const depot: Site | null = operator ? {
      index: -1, id: operator.depot.site, name: operator.name, address: "",
      lat: operator.depot.lat, lon: operator.depot.lon,
      category: "workplace", klass: "taxi depot", group: "office",
      capacity: 0, floor: 0, industries: ["6190"],
      evidence: operator.depot.evidence, estimated: true, role: "depot", staff: [],
    } : null;
    return {
      index,
      person: driver.person,
      lat: driver.home.lat,
      lon: driver.home.lon,
      stand: driver.stand,
      km: driver.km,
      watch: watchOf(driver.watch),
      start: driver.start,
      end: driver.end,
      assignment: posting.assignment,
      operator: driver.operator,
      operatorName: operator?.name ?? null,
      vehicle: driver.vehicle,
      depot,
    };
  });
  for (const driver of drivers) stands[driver.stand]?.drivers.push(driver.index);

  const riders: Rider[] = file.riders.map((rider, index) => {
    const home = rider.home;
    const work = rider.work;
    const posting = job(rider.person);
    return {
      index,
      person: rider.person,
      lat: home?.lat ?? NaN,
      lon: home?.lon ?? NaN,
      homeStand: rider.homeStand,
      site: rider.site,
      workLat: work?.lat ?? NaN,
      workLon: work?.lon ?? NaN,
      workStand: rider.workStand,
      // Not the length of the ride — that is a road distance the dispatcher
      // works out on the day — but the trip it is a straight line under, and
      // the thing that says whether a fare is a hop or half the city.
      km: home && work
        ? haversine(home.lat, home.lon, work.lat, work.lon) / 1000
        : NaN,
      assignment: posting.assignment,
      workplace: posting.site,
    };
  });
  for (const rider of riders) {
    stands[rider.homeStand]?.homes.push(rider.index);
    stands[rider.workStand]?.works.push(rider.index);
  }

  return new TaxiFleet({ source: file.source, seed: file.seed, stands, drivers, riders });
}

/** A shift as a span — "5:15 am – 1:15 pm", with the night watch wrapped. */
export function shiftSpan(start: number | null, end: number | null): string {
  if (start === null || end === null) return "—";
  return `${clock(start)} – ${clock(end)}`;
}

"use client";

import { BAND_LABEL, type Band, type School, type Enrollment } from "./enrollment";
import type { Fleets } from "./fleet";

/**
 * How every student gets to school, and the bus runs that carry the ones who ride.
 *
 * sim_data/school_travel.json is two tables that only make sense together. One
 * row per student says which way they travel in the morning and which way back,
 * and one row per bus run says which corners it stops at, which schools it
 * delivers to, which bus does it and who drives. The join between them is the
 * rider ids inside each stop — a student's row says "bus", and the run that
 * carries them is only discoverable by looking through every stop of every run
 * for their id. That inversion is the whole of the load cost and happens once,
 * here, rather than in a detail panel that would otherwise scan 285 manifests.
 *
 * Two things in the file are worth knowing before reading any number off it.
 *
 * A mode is not always what happens. `lift` means a parent was nominated to
 * drive, and the parent's own shift decides on the day whether they can; the
 * `fallback_*` column is what the student does when they cannot. The simulation
 * resolves that per day, so this viewer shows both and calls neither the truth.
 *
 * A run's `minutes` is measured, not assumed — but only after somebody has run
 * `bun run day --measure-runs` in kierston/sim and rebuilt this stage. Until
 * then `timed` is false and the duration is a straight-line estimate, which is
 * why the two are kept side by side rather than collapsed into one column.
 */

export type SchoolMode = "bus" | "lift" | "walk" | "transit" | "self";
export type Direction = "am" | "pm";

export const MODES: SchoolMode[] = ["bus", "lift", "walk", "transit", "self"];

export const MODE_LABEL: Record<SchoolMode, string> = {
  bus: "School bus",
  lift: "Parent lift",
  walk: "Walk",
  transit: "Public transit",
  self: "Self-drive",
};

/** Short enough for a table cell, where the column header carries the rest. */
export const MODE_SHORT: Record<SchoolMode, string> = {
  bus: "Bus",
  lift: "Lift",
  walk: "Walk",
  transit: "Transit",
  self: "Drives",
};

export const MODE_COLOR: Record<SchoolMode, string> = {
  bus: "#e2a02f",
  lift: "#c2417a",
  walk: "#3d9a5c",
  transit: "#2a86c8",
  self: "#7a4fc0",
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  am: "Morning",
  pm: "Afternoon",
};

export type OperatorKind = "district" | "contractor";

export interface Operator {
  id: number;
  name: string;
  kind: OperatorKind;
  lat: number;
  lon: number;
  /** Why the yard is where it is — there is no depot in the OSM extract. */
  sited: string;
}

export interface RunStop {
  lat: number;
  lon: number;
  /** Resident ids boarding here, or alighting on an afternoon run. */
  riders: number[];
}

export interface Run {
  index: number;
  id: string;
  /**
   * The run's identity, taken from its manifest rather than its position in
   * the file. Two builds that produce the same stops, riders and schools give
   * the same fingerprint; anything else gives a different one, which is what
   * stops a stale measurement being applied to a route it was never taken from.
   */
  fingerprint: string;
  operator: number;
  band: Band;
  direction: Direction;
  /** The minute the last school is reached (am) or the first releases (pm). */
  bell: number;
  /** When the bus leaves the yard. */
  depotOut: number;
  schools: string[];
  stops: RunStop[];
  riders: number;
  /** Minutes in service, measured if `timed`, else estimated. */
  minutes: number;
  estimatedMinutes: number;
  /** Yard to yard, including the empty legs at each end. */
  occupied: number;
  timed: boolean;
  vin: string | null;
  driver: number | null;
  seats: number | null;
}

export interface Rider {
  index: number;
  person: number;
  band: Band;
  /** OSM id of the school, or null for a student with no local place. */
  school: string | null;
  sector: string;
  /** Straight-line kilometres from home to school. */
  km: number;
  am: SchoolMode;
  pm: SchoolMode;
  escortAm: number | null;
  escortPm: number | null;
  /** What happens when the nominated adult cannot drive. Null unless `lift`. */
  fallbackAm: SchoolMode | null;
  fallbackPm: SchoolMode | null;
  /** Index into `runs`, or -1. */
  runAm: number;
  runPm: number;
}

/** One bus, and everything it does in a day. */
export interface Bus {
  vin: string;
  operator: number;
  seats: number;
  runs: number[];
  /** Distinct drivers across the day — two, where the split shift is covered. */
  drivers: number[];
  riders: number;
  /** Minutes the bus is out of the yard, summed over its runs. */
  occupied: number;
  /** Fullest run as a share of the seats — what the fleet was sized against. */
  peakLoad: number;
}

/** One driver, and the runs they take out. */
export interface Driver {
  person: number;
  operator: number;
  runs: number[];
  buses: string[];
  riders: number;
  occupied: number;
  /** First out of the yard and last back, which brackets the split shift. */
  firstOut: number;
  lastIn: number;
}

function bandRank(band: Band): number {
  return ["prek", "elem", "middle", "high", "college"].indexOf(band);
}

export class SchoolTravel {
  readonly source: string;
  readonly seed: number;
  readonly students: number;
  readonly startTimes: Partial<Record<Band, number>>;
  readonly dayLength: Partial<Record<Band, number>>;
  readonly operators: Operator[];
  readonly operatorById: Map<number, Operator>;
  readonly runs: Run[];
  readonly runById: Map<string, number>;
  readonly riders: Rider[];
  /** Resident id → index into `riders`, -1 for anyone not a student. */
  readonly byPerson: Int32Array;
  readonly buses: Bus[];
  readonly drivers: Driver[];
  /** Adult → the students they are nominated to drive, either direction. */
  readonly escorting: Map<number, number[]>;
  /** Schools by OSM id, borrowed from the enrollment catalogue. */
  readonly schools: Map<string, School>;
  readonly modes: { am: Record<SchoolMode, number>; pm: Record<SchoolMode, number> };
  /** Runs with a bus but nobody rostered to drive it. */
  readonly unstaffed: number;

  constructor(init: {
    source: string;
    seed: number;
    students: number;
    startTimes: Partial<Record<Band, number>>;
    dayLength: Partial<Record<Band, number>>;
    operators: Operator[];
    runs: Run[];
    riders: Rider[];
    byPerson: Int32Array;
    schools: Map<string, School>;
  }) {
    this.source = init.source;
    this.seed = init.seed;
    this.students = init.students;
    this.startTimes = init.startTimes;
    this.dayLength = init.dayLength;
    this.operators = init.operators;
    this.runs = init.runs;
    this.riders = init.riders;
    this.byPerson = init.byPerson;
    this.schools = init.schools;

    this.operatorById = new Map(this.operators.map((operator) => [operator.id, operator]));
    this.runById = new Map(this.runs.map((run) => [run.id, run.index]));

    this.escorting = new Map();
    const empty = (): Record<SchoolMode, number> =>
      ({ bus: 0, lift: 0, walk: 0, transit: 0, self: 0 });
    this.modes = { am: empty(), pm: empty() };
    for (const rider of this.riders) {
      this.modes.am[rider.am] += 1;
      this.modes.pm[rider.pm] += 1;
      for (const escort of [rider.escortAm, rider.escortPm]) {
        if (escort === null) continue;
        const mine = this.escorting.get(escort) ?? [];
        // One entry per adult, not one per direction: an adult nominated for
        // both ends of one child's day is still one adult with one child.
        if (!mine.includes(rider.index)) mine.push(rider.index);
        this.escorting.set(escort, mine);
      }
    }

    const buses = new Map<string, Bus>();
    const drivers = new Map<number, Driver>();
    this.unstaffed = 0;

    for (const run of this.runs) {
      if (run.driver === null) this.unstaffed += 1;

      if (run.vin) {
        const bus = buses.get(run.vin) ?? {
          vin: run.vin,
          operator: run.operator,
          seats: run.seats ?? 0,
          runs: [],
          drivers: [],
          riders: 0,
          occupied: 0,
          peakLoad: 0,
        };
        bus.runs.push(run.index);
        bus.riders += run.riders;
        bus.occupied += run.occupied;
        if (bus.seats) bus.peakLoad = Math.max(bus.peakLoad, run.riders / bus.seats);
        if (run.driver !== null && !bus.drivers.includes(run.driver)) {
          bus.drivers.push(run.driver);
        }
        buses.set(run.vin, bus);
      }

      if (run.driver !== null) {
        const driver = drivers.get(run.driver) ?? {
          person: run.driver,
          operator: run.operator,
          runs: [],
          buses: [],
          riders: 0,
          occupied: 0,
          firstOut: Infinity,
          lastIn: -Infinity,
        };
        driver.runs.push(run.index);
        driver.riders += run.riders;
        driver.occupied += run.occupied;
        driver.firstOut = Math.min(driver.firstOut, run.depotOut);
        driver.lastIn = Math.max(driver.lastIn, run.depotOut + run.occupied);
        if (run.vin && !driver.buses.includes(run.vin)) driver.buses.push(run.vin);
        drivers.set(run.driver, driver);
      }
    }

    // Both lists read in the order the day happens, so a bus or a driver with
    // several runs shows the morning block above the afternoon one.
    const byClock = (x: number, y: number) => this.runs[x].depotOut - this.runs[y].depotOut;
    this.buses = [...buses.values()].sort((a, b) => a.vin.localeCompare(b.vin));
    for (const bus of this.buses) bus.runs.sort(byClock);
    this.drivers = [...drivers.values()].sort((a, b) => a.person - b.person);
    for (const driver of this.drivers) driver.runs.sort(byClock);
  }

  /** How a resident travels to school, or null if they are not a student. */
  forPerson(id: number): Rider | null {
    if (id < 0 || id >= this.byPerson.length) return null;
    const index = this.byPerson[id];
    return index < 0 ? null : this.riders[index];
  }

  runOf(index: number): Run | null {
    return index >= 0 ? this.runs[index] : null;
  }

  schoolOf(id: string | null): School | null {
    return id ? this.schools.get(id) ?? null : null;
  }

  operatorOf(run: Run): Operator | null {
    return this.operatorById.get(run.operator) ?? null;
  }

  /** Buses that took at least one run today, out of a fleet that is larger. */
  get busesInService(): number { return this.buses.length; }

  get seatedRiders(): number {
    return this.runs.reduce((sum, run) => sum + run.riders, 0);
  }

  /** Whether any run is still on the straight-line estimate. */
  get untimed(): number {
    return this.runs.reduce((sum, run) => sum + (run.timed ? 0 : 1), 0);
  }
}

/**
 * The waypoints a run visits, in order, between leaving the yard and returning.
 *
 * This mirrors `order()` in kierston/sim/src/activities/school/school.ts exactly, and has to: it
 * is what the measured duration was measured over, so a map drawn in a
 * different order would be showing a route nobody drove. A morning run collects
 * its corners and then delivers to its schools; an afternoon run starts at the
 * schools and runs the same corners backwards.
 */
export function runWaypoints(
  travel: SchoolTravel,
  run: Run,
): { lat: number; lon: number; kind: "stop" | "school"; label: string; riders: number }[] {
  const stops = run.stops.map((stop, index) => ({
    lat: stop.lat,
    lon: stop.lon,
    kind: "stop" as const,
    label: `Stop ${index + 1}`,
    riders: stop.riders.length,
  }));

  const schools = run.schools.flatMap((id) => {
    const school = travel.schoolOf(id);
    if (!school) return [];
    return [{
      lat: school.lat,
      lon: school.lon,
      kind: "school" as const,
      label: school.name || id,
      riders: 0,
    }];
  });

  return run.direction === "am" ? [...stops, ...schools] : [...schools, ...stops.reverse()];
}

export function runLabel(run: Run): string {
  return `${BAND_LABEL[run.band]} · ${run.direction === "am" ? "Morning" : "Afternoon"}`;
}

// ---- Decoding ---------------------------------------------------------------

interface RawRun {
  id: string;
  fingerprint: string;
  operator: number;
  band: Band;
  direction: Direction;
  bell: number;
  depot_out?: number;
  schools: string[];
  stops: RunStop[];
  riders: number;
  minutes: number;
  estimated_minutes: number;
  occupied?: number;
  timed: boolean;
  vin: string | null;
  driver: number | null;
  seats: number | null;
}

interface RawRider {
  person: number;
  band: Band;
  school?: string | null;
  sector: string;
  km: number;
  am: SchoolMode;
  pm: SchoolMode;
  escort_am: number | null;
  escort_pm: number | null;
  fallback_am: SchoolMode | null;
  fallback_pm: SchoolMode | null;
}

export interface SchoolTravelFile {
  source: string;
  seed: number;
  students: number;
  start_times: Partial<Record<Band, number>>;
  day_length: Partial<Record<Band, number>>;
  runs: RawRun[];
  riders: RawRider[];
}

export function joinSchoolTravel(
  file: SchoolTravelFile,
  enrollment: Enrollment,
  fleet: Fleets,
): SchoolTravel {
  const runs: Run[] = file.runs.map((raw, index) => ({
    index,
    id: raw.id,
    fingerprint: raw.fingerprint,
    operator: raw.operator,
    band: raw.band,
    direction: raw.direction,
    bell: raw.bell,
    // Older builds of the stage wrote neither of these. Falling back to the
    // service window keeps the tables readable rather than printing NaN.
    depotOut: raw.depot_out ?? raw.bell - raw.minutes,
    schools: raw.schools,
    stops: raw.stops,
    riders: raw.riders,
    minutes: raw.minutes,
    estimatedMinutes: raw.estimated_minutes,
    occupied: raw.occupied ?? raw.minutes,
    timed: raw.timed,
    vin: raw.vin,
    driver: raw.driver,
    seats: raw.seats,
  }));

  const riders: Rider[] = file.riders.map((raw, index) => ({
    index,
    person: raw.person,
    band: raw.band,
    school: raw.school ?? null,
    sector: raw.sector,
    km: raw.km,
    am: raw.am,
    pm: raw.pm,
    escortAm: raw.escort_am,
    escortPm: raw.escort_pm,
    fallbackAm: raw.fallback_am,
    fallbackPm: raw.fallback_pm,
    runAm: -1,
    runPm: -1,
  }));

  const byPerson = new Int32Array(enrollment.byPerson.length).fill(-1);
  for (const rider of riders) {
    if (rider.person >= 0 && rider.person < byPerson.length) byPerson[rider.person] = rider.index;
  }

  // The one join that is not a lookup: a run lists its riders, a rider does not
  // list their run, and both directions have to be walked to invert it.
  for (const run of runs) {
    for (const stop of run.stops) {
      for (const person of stop.riders) {
        const index = person >= 0 && person < byPerson.length ? byPerson[person] : -1;
        if (index < 0) continue;
        if (run.direction === "am") riders[index].runAm = run.index;
        else riders[index].runPm = run.index;
      }
    }
  }

  const schools = new Map<string, School>();
  for (const school of enrollment.schools) {
    schools.set(school.id, school);
    // A campus answers to any of its buildings, and a run's manifest names
    // whichever way the school stage settled on.
    for (const building of school.buildings ?? []) schools.set(building, school);
  }

  return new SchoolTravel({
    source: file.source,
    seed: file.seed,
    students: file.students,
    startTimes: file.start_times,
    dayLength: file.day_length,
    operators: fleet.operators.filter((operator) => operator.kind !== "taxi").map((operator) => ({
      id: operator.id, name: operator.name,
      kind: operator.kind as OperatorKind,
      lat: operator.depot.lat, lon: operator.depot.lon,
      sited: operator.depot.evidence,
    })),
    runs,
    riders,
    byPerson,
    schools,
  });
}

/** Band order, for any list that should read as a ladder rather than by size. */
export function byBand<T>(items: T[], band: (item: T) => Band): T[] {
  return [...items].sort((a, b) => bandRank(band(a)) - bandRank(band(b)));
}

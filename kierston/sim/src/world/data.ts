/**
 * Everything the roster and commute layers read, loaded once.
 *
 * The files are the ones `init/` writes, unchanged. Reading population.json
 * costs a second or two and about a gigabyte in Bun's heap at full scale; that
 * is the price of not having a second copy of the population to keep in step,
 * and when it stops being acceptable the answer is population.bin, which
 * already exists for the viewer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const KIERSTON_DIR = join(import.meta.dir, "..", "..", "..");
/**
 * The built city. KIERSTON_SIM_DATA_DIR points elsewhere — another build, or an
 * empty directory to check that city tests skip. `bun run day --city PATH`
 * sets it (see `day.ts`).
 */
export const SIM_DATA_DIR = resolve(process.env.KIERSTON_SIM_DATA_DIR ?? join(KIERSTON_DIR, "sim_data"));

/**
 * The build's `kierston-city.json`, written by init/init_sim.py — see
 * init/city_manifest.py. Absent on builds that predate it, which then behave
 * as they always did.
 */
export interface CityManifest {
  format: "kierston-city";
  version: 1;
  city: string;
  name: string | null;
  seed: number | null;
  populationSeed: number | null;
  households: number | null;
  /** Where this build's KDAY files go, relative to the build. */
  days: string;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
}

export const CITY_MANIFEST_FILE = "kierston-city.json";

export function readCityManifest(dir: string): CityManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, CITY_MANIFEST_FILE), "utf8"));
    return manifest?.format === "kierston-city" && manifest.version === 1 ? manifest : null;
  } catch {
    return null;
  }
}

export const CITY_MANIFEST = readCityManifest(SIM_DATA_DIR);

/** Which city is loaded, matching KIERSTON_CITY on the Python side; a build's manifest names its own. */
export const CITY = process.env.KIERSTON_CITY ?? CITY_MANIFEST?.city ?? "kierston";
/** What the user downloaded for this city. Only the venue catalogue reads it. */
export const SOURCES_DIR = join(KIERSTON_DIR, "sources", CITY);
/**
 * Final simulation products, kept apart from rebuildable initialization data:
 * where the build's manifest says, else kierston/sim_outputs as before.
 */
export const SIM_OUTPUTS_DIR = CITY_MANIFEST
  ? resolve(SIM_DATA_DIR, CITY_MANIFEST.days)
  : join(KIERSTON_DIR, "sim_outputs");

/**
 * The seed every day-level draw is keyed on. The population's own seed unless
 * `bun run day --seed N` overrides it (KIERSTON_SEED). External traffic keeps
 * the seed external_traffic.json was built with either way.
 */
export const SEED_OVERRIDE = process.env.KIERSTON_SEED === undefined
  ? null
  : Number(process.env.KIERSTON_SEED);

/** The files a day context cannot load without. */
const CITY_FILES = ["population.json", "pois.json", "ties.bin", "car_graph.bin"];

/**
 * Whether a built city is on disk: the core files, plus any named here.
 *
 * Tests that read the real city skip on a checkout without one.
 */
export function simDataPresent(...files: string[]): boolean {
  return [...CITY_FILES, ...files].every((file) => existsSync(join(SIM_DATA_DIR, file)));
}

export interface Person {
  id: number;
  household: number;
  age: number;
  /** In custody on the reference date (init's dockets stage); not in the city's day. */
  incarcerated?: boolean;
  sex: number;
  race_ethnicity?: string;
  income?: number | null;
  employment: number | null;
  occupation: string | null;
  hours: number | null;
  /** Minutes from midnight. Rewritten by init/work/shifts.py for primary roles. */
  depart: number | null;
  arrive: number | null;
  travel: number | null;
  /** JWTRNS. "1" is drove alone, "2" carpool, "11" worked from home. */
  transport: string | null;
  enrolled: number | null;
  grade: number | null;
  /**
   * Sleep, as `init/population/traits.py` drew it. Named the way the JSON
   * names it, like every other field here.
   *
   * Optional only until the population is rebuilt — see `traitsFor` in
   * `sleep.ts` for what happens to a person who predates the trait stage.
   */
  chronotype?: number;
  sleep_need?: number;
  readiness?: number;
}

export interface Household {
  id: number;
  size: number;
  income: number;
  dwelling: string | null;
}

/**
 * How a student travels, per direction, as `school_travel.py` decided it.
 *
 * `escort` is a nomination and not a fact about today: the adult named here
 * drives on the days their own roster leaves them free, and on the days it does
 * not the student falls back. Both facts are written because the runtime must
 * be able to answer the question from this row alone — see `school.ts` for why
 * that matters more than it looks.
 */
export type SchoolMode = "bus" | "lift" | "walk" | "transit" | "self";

export interface SchoolRider {
  person: number;
  band: "prek" | "elem" | "middle" | "high" | "college";
  school: string;
  sector: string;
  km: number;
  am: SchoolMode;
  pm: SchoolMode;
  escort_am: number | null;
  escort_pm: number | null;
  fallback_am: SchoolMode | null;
  fallback_pm: SchoolMode | null;
}

export interface RunStop {
  lat: number;
  lon: number;
  riders: number[];
}

export interface SchoolRun {
  id: string;
  /**
   * The run's identity, taken from its manifest rather than its position.
   *
   * Round-tripped untouched: `school_travel.py` computes it, the measurement
   * pass writes it back beside the duration it measured, and the next init pass
   * matches on it. Ids carry a positional index and silently mean a different
   * run when the splitting changes, which made stale measurements apply to
   * routes they were never taken from instead of being ignored.
   */
  fingerprint: string;
  operator: number;
  band: SchoolRider["band"];
  direction: "am" | "pm";
  /** The minute the last school is reached (am) or the first releases (pm). */
  bell: number;
  schools: string[];
  stops: RunStop[];
  riders: number;
  /** Minutes the run occupies its bus, measured if `timed`, else estimated. */
  minutes: number;
  estimated_minutes: number;
  timed: boolean;
  vin: string | null;
  driver: number | null;
  seats: number | null;
}

export interface SchoolTravel {
  startTimes: Record<string, number>;
  dayLength: Record<string, number>;
  riders: Map<number, SchoolRider>;
  runs: Map<string, SchoolRun>;
  /** The runs a student rides, by direction. */
  ridesOn: Map<number, { am: string | null; pm: string | null }>;
  /** The runs a driver takes out, in the order they take them. */
  driving: Map<number, SchoolRun[]>;
  /** The students an adult is nominated to drive, either direction. */
  escorting: Map<number, number[]>;
  depots: Map<number, Point>;
}

export interface FleetOperator {
  id: number;
  name: string;
  kind: "district" | "contractor" | "taxi" | "police" | "ems";
  legal_form: string;
  depot: Point & { site: string; evidence: string };
}

export interface FleetVehicle {
  vin: string;
  service_class: "taxi" | "school_bus" | "police" | "ems";
  operator: number | null;
  owner_driver: number | null;
  /**
   * The premises this vehicle is kept at, where that is finer than its
   * operator's depot.
   *
   * Only the police fleet has one. A cab pool and a bus yard each have a single
   * address, so the operator's depot is the answer for every vehicle in them; a
   * force has three sets of premises sharing one operator, and a unit turning
   * out of the substation collects a car standing in the substation yard rather
   * than one across town. See `fleet.py` for how the allocation is made.
   */
  base?: string | null;
}

export interface FleetDriver {
  person: number;
  operator: number | null;
  vehicle: string | null;
}

export interface FleetData {
  operators: Map<number, FleetOperator>;
  vehicles: FleetVehicle[];
  drivers: Map<number, FleetDriver>;
  /**
   * The marked patrol cars kept at each police site, in VIN order.
   *
   * Indexed by base because that is the question the patrol layer asks: how
   * many units this station can put out is how many cars are standing in its
   * yard, and which officer gets which of them has to be answerable from the
   * station's own list without consulting anybody else's day.
   */
  patrolCars: Map<string, FleetVehicle[]>;
  /** The ambulances kept at each fire house, by facility key, in VIN order. */
  ambulances: Map<string, FleetVehicle[]>;
}

/** One physical row from the vehicle registry. The VIN, not its owner, is the identity. */
export interface RegisteredVehicle {
  vin: string;
  owner: number;
  owner_type: "person" | "organization";
  household: number | null;
  service_class: "taxi" | "school_bus" | "police" | "ems" | null;
  seats: number | null;
}

export type WorkMode = "sited" | "itinerant" | "home" | "external";

export interface Shift {
  watch: string;
  /** Minutes from midnight; `end` may exceed 1440 and for a medic exceeds 2280. */
  start: number;
  end: number;
  report: number;
  rota:
    | { kind: "person"; on: number; off: number; rest: number[] | null }
    | { kind: "platoon"; on: number; off: number; offset: number }
    | { kind: "days"; days: number };
}

export interface Assignment {
  person: number;
  class: "primary" | "filler";
  role?: string;
  duty?: string;
  crew?: string | null;
  platoon?: string;
  occupation: string;
  site: string | null;
  mode: WorkMode;
  hours?: number;
  depart?: number | null;
  arrive?: number | null;
  travel?: number;
  transport?: string;
  shift?: Shift;
}

export interface Point {
  lat: number;
  lon: number;
}

export interface World {
  persons: Map<number, Person>;
  households: Map<number, Household>;
  assignments: Map<number, Assignment>;
  /** OSM id (`way/123`, `node/456`) to a point. Homes, worksites, facilities. */
  places: Map<string, Point>;
  school: SchoolTravel;
  fleet: FleetData;
  /** Every registered vehicle, plus the household access pool used at runtime. */
  vehicles: Map<string, RegisteredVehicle>;
  householdVehicles: Map<number, string[]>;
  /**
   * Households with no car of their own, from the vehicle registry.
   *
   * The one household fact the travel layer cannot do without. JWTRNS answers
   * how somebody got to work and says nothing about the fifteen percent of
   * households here that keep no vehicle at all — most of whom never answered
   * it, because they do not commute. Without this every one of them is a
   * driver, which is where the taxi layer's missing demand went.
   */
  carless: Set<number>;
  seed: number;
}

async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

/**
 * Resolve every id anything in the simulation might point at.
 *
 * Four sources, in increasing order of authority: the building extract covers
 * dwellings and most premises; the workplace catalogue adds the sites that were
 * matched to POIs rather than buildings; the facility list is the emergency
 * services' own premises; and orgs cover the places people belong to. Later
 * sources overwrite earlier ones because they were built with more knowledge of
 * what the place actually is.
 */
async function loadPlaces(): Promise<Map<string, Point>> {
  const places = new Map<string, Point>();

  const buildings = await readJson<{ points: unknown[][] }>(join(SIM_DATA_DIR, "buildings.json"));
  for (const point of buildings.points) {
    const id = point[9] as string;
    if (id) places.set(id, { lat: point[0] as number, lon: point[1] as number });
  }

  const workplaces = await readJson<{ site_records: { id: string; lat: number; lon: number }[] }>(
    join(SIM_DATA_DIR, "workplaces.json"),
  );
  for (const site of workplaces.site_records) places.set(site.id, { lat: site.lat, lon: site.lon });

  const employment = await readJson<{ facilities: { key: string; lat: number; lon: number }[] }>(
    join(SIM_DATA_DIR, "employment.json"),
  );
  for (const facility of employment.facilities) {
    places.set(facility.key, { lat: facility.lat, lon: facility.lon });
  }

  const orgs = await readJson<{ org_records: { id: string; lat: number; lon: number }[] }>(
    join(SIM_DATA_DIR, "orgs.json"),
  );
  for (const org of orgs.org_records) places.set(org.id, { lat: org.lat, lon: org.lon });

  // Schools last, and after orgs on purpose: a school is in the org catalogue
  // as somewhere people belong, and here as somewhere they are sent. Where the
  // two disagree the school file is the one that placed the students.
  const schools = await readJson<{ school_records: { id: string; lat: number; lon: number }[] }>(
    join(SIM_DATA_DIR, "schools.json"),
  );
  for (const school of schools.school_records) places.set(school.id, { lat: school.lat, lon: school.lon });

  return places;
}

/**
 * The school travel layer, indexed the three ways it gets asked about.
 *
 * By student, because a child's day starts from their own row. By run, because
 * a rider's boarding minute is a fact about the whole route and not about them.
 * And by driver, because the driver's day *is* the runs — they are their shift,
 * not a journey to one.
 */
async function loadFleet(): Promise<FleetData> {
  const file = await readJson<{
    operators: FleetOperator[];
    vehicles: FleetVehicle[];
    drivers: FleetDriver[];
  }>(join(SIM_DATA_DIR, "fleet.json"));
  const patrolCars = new Map<string, FleetVehicle[]>();
  const ambulances = new Map<string, FleetVehicle[]>();
  for (const vehicle of file.vehicles) {
    if (!vehicle.base) continue;
    const based = vehicle.service_class === "police" ? patrolCars
      : vehicle.service_class === "ems" ? ambulances : null;
    if (!based) continue;
    const mine = based.get(vehicle.base) ?? [];
    mine.push(vehicle);
    based.set(vehicle.base, mine);
  }
  for (const mine of patrolCars.values()) mine.sort((a, b) => a.vin.localeCompare(b.vin));
  for (const mine of ambulances.values()) mine.sort((a, b) => a.vin.localeCompare(b.vin));

  return {
    operators: new Map(file.operators.map((row) => [row.id, row])),
    vehicles: file.vehicles,
    drivers: new Map(file.drivers.map((row) => [row.person, row])),
    patrolCars,
    ambulances,
  };
}

async function loadSchoolTravel(fleet: FleetData): Promise<SchoolTravel> {
  const file = await readJson<{
    start_times: Record<string, number>;
    day_length: Record<string, number>;
    runs: SchoolRun[];
    riders: SchoolRider[];
  }>(join(SIM_DATA_DIR, "school_travel.json"));

  const riders = new Map<number, SchoolRider>();
  const escorting = new Map<number, number[]>();
  for (const rider of file.riders) {
    riders.set(rider.person, rider);
    // One entry per adult, not one per adult per direction: the parent's day is
    // built by asking each nominated child what today's answer is, and an adult
    // nominated for both ends of one child's day is still one adult.
    for (const escort of [rider.escort_am, rider.escort_pm]) {
      if (escort === null) continue;
      const mine = escorting.get(escort) ?? [];
      if (!mine.includes(rider.person)) mine.push(rider.person);
      escorting.set(escort, mine);
    }
  }

  const runs = new Map<string, SchoolRun>();
  const ridesOn = new Map<number, { am: string | null; pm: string | null }>();
  const driving = new Map<number, SchoolRun[]>();

  for (const run of file.runs) {
    runs.set(run.id, run);
    for (const stop of run.stops) {
      for (const person of stop.riders) {
        const seat = ridesOn.get(person) ?? { am: null, pm: null };
        seat[run.direction] = run.id;
        ridesOn.set(person, seat);
      }
    }
    if (run.driver !== null) {
      const mine = driving.get(run.driver) ?? [];
      mine.push(run);
      driving.set(run.driver, mine);
    }
  }

  // The morning before the afternoon, and within a direction the earliest bell
  // first — which for the morning is the high school and for the afternoon is
  // whichever band gets out first. That is the order the driver drives them in.
  for (const mine of driving.values()) {
    mine.sort((a, b) => (a.direction === b.direction ? a.bell - b.bell : a.direction === "am" ? -1 : 1));
  }

  // The yards, and only the yards. The operator list also holds the two cab
  // pools and the police department, neither of which runs a school bus, and
  // an allow-list is what keeps a fleet added later from silently becoming a
  // depot a run could be dispatched from.
  const depots = new Map<number, Point>();
  for (const operator of fleet.operators.values()) {
    if (operator.kind === "district" || operator.kind === "contractor") {
      depots.set(operator.id, operator.depot);
    }
  }

  return {
    startTimes: file.start_times,
    dayLength: file.day_length,
    riders,
    runs,
    ridesOn,
    driving,
    escorting,
    depots,
  };
}

/**
 * The households that own no vehicle, from `personal_records/vehicles.py`.
 *
 * A household is carless by absence: the registry is a list of vehicles and
 * their keepers, so the only way to be without one is not to appear in it. Only
 * personally-owned rows count — an LLC's cab sitting in a depot is registered to
 * an operator and parked against the driver's household by nothing at all.
 */
async function loadVehicles(households: Iterable<number>): Promise<{
  vehicles: Map<string, RegisteredVehicle>;
  householdVehicles: Map<number, string[]>;
  carless: Set<number>;
}> {
  const file = await readJson<{ vehicles: Record<string, RegisteredVehicle> }>(
    join(SIM_DATA_DIR, "vehicles.json"),
  );
  const vehicles = new Map<string, RegisteredVehicle>();
  const householdVehicles = new Map<number, string[]>();
  for (const [vin, row] of Object.entries(file.vehicles)) {
    const vehicle = { ...row, vin };
    vehicles.set(vin, vehicle);
    if (vehicle.owner_type !== "person" || vehicle.household === null) continue;
    const mine = householdVehicles.get(vehicle.household) ?? [];
    mine.push(vin);
    householdVehicles.set(vehicle.household, mine);
  }
  for (const mine of householdVehicles.values()) mine.sort();
  const carless = new Set<number>();
  for (const id of households) if (!householdVehicles.has(id)) carless.add(id);
  return { vehicles, householdVehicles, carless };
}

/**
 * The grade a person attends, from the PUMS SCHG code population.json carries.
 *
 * SCHG is a code, not a grade: "01" preschool, "02" kindergarten, "03"-"14"
 * grades 1-12, "15" undergraduate, "16" graduate school. Init keys its school
 * bands on the code string, so the conversion happens here. Preschool is -1,
 * kindergarten 0, undergraduate 13 and graduate 17, which keeps the cut-offs
 * in comms/attention.ts (5, 8, 12) on the right side for every code.
 */
export function gradeFromSchg(code: unknown): number | null {
  if (code === null || code === undefined || code === "") return null;
  const value = Number(code);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (value === 1) return -1;
  if (value <= 14) return value - 2;
  return value === 15 ? 13 : 17;
}

export async function loadWorld(): Promise<World> {
  const fleet = await loadFleet();
  const [population, employment, places, school] = await Promise.all([
    readJson<{
      person_records: Person[];
      household_records: Household[];
      seed: number;
    }>(join(SIM_DATA_DIR, "population.json")),
    readJson<{ assignments: Assignment[] }>(join(SIM_DATA_DIR, "employment.json")),
    loadPlaces(),
    loadSchoolTravel(fleet),
  ]);

  const persons = new Map<number, Person>();
  for (const person of population.person_records) {
    person.grade = gradeFromSchg(person.grade);
    persons.set(person.id, person);
  }

  const households = new Map<number, Household>();
  for (const household of population.household_records) households.set(household.id, household);

  const assignments = new Map<number, Assignment>();
  for (const assignment of employment.assignments) assignments.set(assignment.person, assignment);

  const { vehicles, householdVehicles, carless } = await loadVehicles(households.keys());

  return {
    persons, households, assignments, places, school, fleet,
    vehicles, householdVehicles, carless, seed: SEED_OVERRIDE ?? population.seed,
  };
}

/** Where a person sleeps. Null for the group-quarters residents, who have no household. */
export function homeOf(world: World, person: Person): Point | null {
  const household = world.households.get(person.household);
  if (!household?.dwelling) return null;
  return world.places.get(household.dwelling) ?? null;
}

export function placeOf(world: World, id: string | null): Point | null {
  return id ? world.places.get(id) ?? null : null;
}

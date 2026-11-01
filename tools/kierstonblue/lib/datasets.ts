"use client";

import {
  Employment, joinEmployment, type EmploymentFile, type WorkplaceFile,
} from "./employment";
import {
  Enrollment, joinEnrollment, type EnrollmentFile, type SchoolFile,
} from "./enrollment";
import { SpatialGrid, buildPointGrid } from "./grid";
import { Identity } from "./identity";
import { Fleets, type FleetFile } from "./fleet";
import { Kinship, type KinshipFile } from "./kinship";
import { Labels, type LabelPayload } from "./labels";
import { Population, loadPopulation } from "./population";
import { RecordSet, loadRecords } from "./records";
import {
  SchoolTravel, joinSchoolTravel, type SchoolTravelFile,
} from "./school-travel";
import { TaxiFleet, joinTaxi, type TaxiFile } from "./taxi";
import { CameraFleet, type CameraFile } from "./cameras";
import { Network, type TowerFile } from "./towers";
import { TieGraph, loadTies } from "./ties";

/**
 * Client-side dataset loading, with one cache per dataset.
 *
 * The caches are module-level on purpose: moving between the map, the
 * households table and the analysis view is a client-side navigation, and a
 * 6 MB population that had to be re-fetched and re-indexed on each of them
 * would make the app feel like three separate tools again.
 */

export const ENDPOINTS = {
  topology: "/api/topology",
  city: "/api/data/sim/city.json",
  pois: "/api/data/sim/pois.json",
  buildings: "/api/data/sim/buildings.json",
  population: "/api/data/sim/population.bin",
  employment: "/api/data/sim/employment.json",
  workplaces: "/api/data/sim/workplaces.json",
  enrollment: "/api/data/sim/enrollment.json",
  schools: "/api/data/sim/schools.json",
  schoolTravel: "/api/data/sim/school_travel.json",
  fleet: "/api/data/sim/fleet.json",
  taxi: "/api/data/sim/taxi.json",
  towers: "/api/data/sim/towers.json",
  cameras: "/api/data/city/cameras.json",
  kinship: "/api/data/sim/kinship.json",
  ties: "/api/data/sim/ties.bin",
  identity: "/api/data/sim/identity.bin",
  criminal: "/api/data/sim/criminal.bin",
  civil: "/api/data/sim/civil.bin",
  firearms: "/api/data/sim/firearms.bin",
  vehicles: "/api/data/sim/vehicles.bin",
  holdings: "/api/data/sim/holdings.bin",
  labels: "/api/labels",
  rents: "/api/rents",
} as const;

/** The record files, which all load the same way. */
export const RECORD_DATASETS = [
  "criminal", "civil", "firearms", "vehicles", "holdings",
] as const;

export type RecordDataset = (typeof RECORD_DATASETS)[number];

/**
 * Where a map opens: the centre the city build's profile published in
 * city.json, so a second city does not open on the first one's streets.
 */
export function getCenter(): Promise<[number, number]> {
  return once("center", async () => {
    const { center } = await json<{ center: [number, number] }>(ENDPOINTS.city);
    return center;
  });
}

// ---- Topology ---------------------------------------------------------------

export interface Topology {
  count: number;
  /** aLat, aLon, bLat, bLon per segment. */
  coords: Float32Array;
  ranks: Uint8Array;
  rankCounts: number[];
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  grid: SpatialGrid;
}

function decodeTopology(buffer: ArrayBuffer): Topology {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "KTOP") {
    throw new Error("not a packed topology");
  }
  const headerLength = new DataView(buffer).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const dataStart = (8 + headerLength + 3) & ~3;
  const coords = new Float32Array(buffer, dataStart, meta.count * 4);
  const ranks = new Uint8Array(buffer, dataStart + meta.count * 16, meta.count);

  const grid = new SpatialGrid(true);
  for (let i = 0; i < meta.count; i += 1) {
    const o = i * 4;
    grid.addBox(
      i,
      Math.min(coords[o], coords[o + 2]), Math.min(coords[o + 1], coords[o + 3]),
      Math.max(coords[o], coords[o + 2]), Math.max(coords[o + 1], coords[o + 3]),
    );
  }

  return {
    count: meta.count,
    coords,
    ranks,
    rankCounts: meta.rankCounts,
    bounds: meta.bounds,
    grid,
  };
}

// ---- Points of interest -----------------------------------------------------

export interface PoiGroup {
  label: string;
  color: string;
  count: number;
  default: boolean;
  types: { i: number; id: string; label: string; count: number }[];
}

/** [lat, lon, group, type, name, address, addressSource]. */
export type Poi = [number, number, number, number, string, string, number];

export interface PoiData {
  groups: PoiGroup[];
  points: Poi[];
  grid: SpatialGrid;
  typeLabel: Map<number, string>;
}

// ---- Buildings --------------------------------------------------------------

export interface BuildingCategory {
  label: string;
  color: string;
  count: number;
}

/**
 * [lat, lon, category, kind, levels, flats, name, address, tags, osmId,
 *  living, units, unitsSource].
 *
 * `units` is the dwelling-unit count from extract_dwellings.py and is 0 for
 * anything nobody sleeps in — it, not the `living` flag at index 10, is the
 * filter worth having, since `living` also counts sheds and garages.
 */
export type Building = [
  number, number, number, string, number, number, string, string,
  Record<string, string> | null, string, number, number, string,
];

export interface BuildingData {
  categories: BuildingCategory[];
  points: Building[];
  dwellings: number;
  grid: SpatialGrid;
  byOsmId: Map<string, number>;
}

// ---- Loading ----------------------------------------------------------------

const cache = new Map<string, Promise<unknown>>();

function once<T>(name: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(name) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = load().catch((error) => {
    // A failed load must not poison the cache, or a restarted service can
    // never be picked up without a full reload.
    cache.delete(name);
    throw error;
  });
  cache.set(name, promise);
  return promise;
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return response.json() as Promise<T>;
}

export function getTopology(): Promise<Topology> {
  return once("topology", async () => {
    const response = await fetch(ENDPOINTS.topology);
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error ?? `HTTP ${response.status}`);
    }
    return decodeTopology(await response.arrayBuffer());
  });
}

export function getRents(): Promise<(number | null)[]> {
  return once("rents", () => json<(number | null)[]>(ENDPOINTS.rents));
}

export function getPois(): Promise<PoiData> {
  return once("pois", async () => {
    const data = await json<{ groups: PoiGroup[]; points: Poi[] }>(ENDPOINTS.pois);
    const typeLabel = new Map<number, string>();
    for (const group of data.groups) {
      for (const type of group.types) typeLabel.set(type.i, type.id);
    }
    return {
      ...data,
      typeLabel,
      grid: buildPointGrid(data.points.length, (i) => [data.points[i][0], data.points[i][1]]),
    };
  });
}

export function getBuildings(): Promise<BuildingData> {
  return once("buildings", async () => {
    const data = await json<{
      categories: BuildingCategory[]; points: Building[]; dwellings?: number;
    }>(ENDPOINTS.buildings);
    const byOsmId = new Map<string, number>();
    data.points.forEach((building, i) => byOsmId.set(building[9], i));
    return {
      categories: data.categories,
      points: data.points,
      dwellings: data.dwellings
        ?? data.points.reduce((sum, building) => sum + (building[11] ? 1 : 0), 0),
      byOsmId,
      grid: buildPointGrid(data.points.length, (i) => [data.points[i][0], data.points[i][1]]),
    };
  });
}

export function getPopulation(): Promise<Population> {
  return once("population", async () => {
    const population = await loadPopulation(ENDPOINTS.population);
    // Build the join indexes once, here, rather than on the first popup.
    population.buildingByOsmId;
    population.householdsByBuilding;
    return population;
  });
}

/**
 * Who works where, joined to the population.
 *
 * The employment table refers to people by resident id and to workplaces by
 * OSM id, so it is only meaningful next to the population — which is why this
 * waits for it rather than making every caller remember to.
 */
export function getEmployment(): Promise<Employment> {
  return once("employment", async () => {
    const [employment, workplaces, population] = await Promise.all([
      json<EmploymentFile>(ENDPOINTS.employment),
      json<WorkplaceFile>(ENDPOINTS.workplaces),
      getPopulation(),
    ]);
    return joinEmployment(employment, workplaces, population);
  });
}

/**
 * Who studies where, joined to the population.
 *
 * Same contract as getEmployment: the enrollment table refers to people by
 * resident id and to schools by OSM id, so it only means anything next to the
 * population. It is a quarter the size of the employment table — 29,622 rows
 * against 54,664 — and still waits for the population rather than racing it.
 */
export function getEnrollment(): Promise<Enrollment> {
  return once("enrollment", async () => {
    const [enrollment, schools, population] = await Promise.all([
      json<EnrollmentFile>(ENDPOINTS.enrollment),
      json<SchoolFile>(ENDPOINTS.schools),
      getPopulation(),
    ]);
    return joinEnrollment(enrollment, schools, population);
  });
}

/**
 * How every student travels, and the bus runs that carry the ones who ride.
 *
 * Waits on the enrollment rather than the population, and only for the school
 * catalogue inside it: a run's manifest names the schools it delivers to by
 * OSM id, and a route with no coordinates cannot be drawn or measured against
 * anything. The enrollment is cached like everything else, so a reader coming
 * from the students table has already paid for it.
 */
export function getSchoolTravel(): Promise<SchoolTravel> {
  return once("schoolTravel", async () => {
    const [file, enrollment, fleet] = await Promise.all([
      json<SchoolTravelFile>(ENDPOINTS.schoolTravel),
      getEnrollment(),
      getFleet(),
    ]);
    return joinSchoolTravel(file, enrollment, fleet);
  });
}

export function getFleet(): Promise<Fleets> {
  return once("fleet", async () => new Fleets(await json<FleetFile>(ENDPOINTS.fleet)));
}

/**
 * The cab stands, the drivers who keep them and the people who ride.
 *
 * Waits on the employment for the same reason getSchoolTravel waits on the
 * enrollment: the file is geometry and resident ids, and the job behind each
 * of those ids — the watch a driver is on, the workplace a rider is going to
 * — lives in employment.json. Both are cached, so a reader arriving from the
 * jobs table has already paid for the larger half.
 */
export function getTaxi(): Promise<TaxiFleet> {
  return once("taxi", async () => {
    const [file, employment, fleet] = await Promise.all([
      json<TaxiFile>(ENDPOINTS.taxi),
      getEmployment(),
      getFleet(),
    ]);
    return joinTaxi(file, employment, fleet);
  });
}

/**
 * The cell network — the structures, and the cells transmitting from them.
 *
 * Nothing to join: the file is self-contained geography and identifiers, and
 * the only index worth building — cell to structure — is built in the Network
 * constructor. 1.3 MB, which is why it is fetched whole rather than paged.
 */
export function getTowers(): Promise<Network> {
  return once("towers", async () => new Network(await json<TowerFile>(ENDPOINTS.towers)));
}

/** The plate readers — mounts, and the approach each camera watches. */
export function getCameras(): Promise<CameraFleet> {
  return once("cameras", async () => new CameraFleet(await json<CameraFile>(ENDPOINTS.cameras)));
}

/**
 * Who everyone is — names, birth dates, taxpayer ids, immigration, marital.
 *
 * Cached like the rest, and worth it: every records page needs a name against
 * a resident id, so this is fetched by whichever of them a reader opens first
 * and handed over synchronously to the others.
 */
export function getIdentity(): Promise<Identity> {
  return once("identity", async () => new Identity(await loadRecords(ENDPOINTS.identity)));
}

/**
 * One of the packed record files.
 *
 * They decode through the same reader — the header describes the columns — so
 * there is one loader rather than five, and the cache key is the dataset name.
 */
export function getRecords(dataset: RecordDataset): Promise<RecordSet> {
  return once(dataset, () => loadRecords(ENDPOINTS[dataset]));
}

/**
 * The family graph — parents, children, siblings, partners.
 *
 * Unlike employment and enrollment this needs nothing joined to it: every id
 * in the file is a resident id in the population's own numbering, or a stub
 * above the external base that stands for a parent who is not here. Inverting
 * the parent map is the whole of the load cost and happens once.
 */
export function getKinship(): Promise<Kinship> {
  return once("kinship", async () => new Kinship(await json<KinshipFile>(ENDPOINTS.kinship)));
}

/**
 * The social graph — who knows whom, and how well.
 *
 * The largest file in the app at 55 MB, and the one with real work to do after
 * it lands: the edges are stored once, canonically, so the index that answers
 * "who does this person know" has to be built here rather than read. It needs
 * the population first, for the resident count that index is sized on, which
 * makes this the same bargain getEmployment makes and for the same reason.
 */
export function getTies(): Promise<TieGraph> {
  return once("ties", async () => {
    const population = await getPopulation();
    return loadTies(
      ENDPOINTS.ties,
      population.counts.persons + population.counts.quarters,
    );
  });
}

/** PUMS occupation, industry, transport and grade names. */
export function getLabels(): Promise<Labels> {
  return once("labels", async () => new Labels(await json<LabelPayload>(ENDPOINTS.labels)));
}

/** Whether a dataset is already resolved, for rendering without a spinner. */
export function isLoaded(name: keyof typeof ENDPOINTS): boolean {
  return cache.has(name);
}

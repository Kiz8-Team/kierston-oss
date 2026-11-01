/** Shared paths and the driving model the whole pathfinder agrees on. */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PATHFINDER_DIR = join(import.meta.dir, "..");
export const KIERSTON_DIR = join(PATHFINDER_DIR, "..");
export const REPO_ROOT = join(KIERSTON_DIR, "..");

/** Which city is loaded, matching KIERSTON_CITY on the Python side. */
export const CITY = process.env.KIERSTON_CITY ?? "kierston";
/** What the user downloaded for this city. Never written to. */
export const SOURCES_DIR = join(KIERSTON_DIR, "sources", CITY);
/**
 * Built artefacts the simulation runs on, as opposed to the drafts they came
 * from. KIERSTON_SIM_DATA_DIR points at another city build, with the meaning
 * init/paths.py and sim/src/world/data.ts give it.
 */
export const SIM_DATA_DIR = process.env.KIERSTON_SIM_DATA_DIR
  ? resolve(process.env.KIERSTON_SIM_DATA_DIR)
  : join(KIERSTON_DIR, "sim_data");

export const TOPOLOGY_FILE = join(SOURCES_DIR, "topology.graphml");
export const GRAPH_FILE = join(SIM_DATA_DIR, "car_graph.bin");
export const POI_FILE = join(SIM_DATA_DIR, "pois.json");
export const BUILDING_FILE = join(SIM_DATA_DIR, "buildings.json");
export const GEOCODE_FILE = join(SIM_DATA_DIR, "pathfinder_geocode.json");

/**
 * The city's centre, from the profile the pipeline published.
 *
 * Read from `sim_data/city.json` rather than written here, because a
 * coordinate in the source is a second place a city is defined and the two
 * drift. There is no fallback: a centre borrowed from another city would bias
 * every geocode towards the wrong place, so a missing or malformed city.json
 * stops the caller and says how to publish it. Read on first use rather than
 * at import, so loading this module never needs a built city.
 */
let cachedCentre: readonly [number, number] | null = null;
export function center(path = join(SIM_DATA_DIR, "city.json")): readonly [number, number] {
  if (cachedCentre && path === join(SIM_DATA_DIR, "city.json")) return cachedCentre;
  let lat: unknown;
  let lon: unknown;
  try {
    [lat, lon] = JSON.parse(readFileSync(path, "utf8")).center ?? [];
  } catch (error) {
    throw new Error(`pathfinder: could not read the city centre from ${path} (${(error as Error).message}); `
      + "publish it with `kierston/.venv/bin/python kierston/init/init_sim.py --only locale`");
  }
  if (typeof lat !== "number" || typeof lon !== "number") {
    throw new Error(`pathfinder: ${path} has no numeric center [lat, lon]; `
      + "publish it with `kierston/.venv/bin/python kierston/init/init_sim.py --only locale`");
  }
  const found = [lat, lon] as const;
  if (path === join(SIM_DATA_DIR, "city.json")) cachedCentre = found;
  return found;
}
export const DEFAULT_PORT = 8787;

/** The highway classes a car may legally drive on, in the order they are ranked. */
export const CAR_CLASSES = [
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street",
  "road", "service", "busway",
] as const;

export type CarClass = (typeof CAR_CLASSES)[number];

/**
 * Free-flow speeds in km/h, used when the way carries no `maxspeed`. Driveways
 * and parking aisles fall under `service`: slow on purpose, so a route only
 * cuts through a lot when it is genuinely the way in.
 */
export const CLASS_SPEED_KPH: Record<CarClass, number> = {
  motorway: 105, motorway_link: 70,
  trunk: 90, trunk_link: 60,
  primary: 80, primary_link: 50,
  secondary: 65, secondary_link: 45,
  tertiary: 55, tertiary_link: 40,
  unclassified: 45, residential: 35, living_street: 15,
  road: 40, service: 15, busway: 30,
};

/** `access` values that close a way to ordinary traffic. */
export const CLOSED_ACCESS = new Set(["private", "no", "customers", "delivery", "agricultural", "forestry"]);

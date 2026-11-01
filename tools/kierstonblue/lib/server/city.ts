import { readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { cookies } from "next/headers";

/**
 * Which city build the app is looking at.
 *
 * A city build is a folder of init outputs with a `kierston-city.json` in it —
 * what `init_sim.py --out PATH` writes, see kierston/init/city_manifest.py.
 * kierston/sim_data is the default build and is accepted without a manifest,
 * because builds made before the manifest existed have none.
 *
 * The choice is a cookie, so every route and every server page reads the same
 * one without it being threaded through URLs. A cookie naming a folder that is
 * not a build falls back to the default rather than serving from it: the app
 * reads whatever directory the cookie names, so it has to be one that says
 * what it is.
 */

export const REPO_ROOT = resolve(process.cwd(), "..", "..");
export const KIERSTON_DIR = join(REPO_ROOT, "kierston");
export const DEFAULT_CITY_DIR = join(KIERSTON_DIR, "sim_data");

export const CITY_COOKIE = "kb-city";
/** Builds added by path, beyond the ones found under kierston/. */
export const CITIES_COOKIE = "kb-cities";
export const DAY_COOKIE = "kb-day";

export const MANIFEST_FILE = "kierston-city.json";

export interface CityManifest {
  format: "kierston-city";
  version: 1;
  city: string;
  name: string | null;
  seed: number | null;
  populationSeed: number | null;
  households: number | null;
  days: string;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
}

export interface City {
  dir: string;
  /** The profile slug: which sources/ and cities/ folders belong to it. */
  slug: string;
  name: string;
  /** Where its day files are. */
  outputs: string;
  manifest: CityManifest | null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** The build at `dir`, or null when the folder is not one. */
export async function readCity(dir: string): Promise<City | null> {
  if (!isAbsolute(dir)) return null;
  dir = resolve(dir);
  const raw = await readJson(join(dir, MANIFEST_FILE)) as CityManifest | null;
  const manifest = raw?.format === "kierston-city" && raw.version === 1 ? raw : null;
  if (!manifest && dir !== DEFAULT_CITY_DIR) return null;
  const profile = await readJson(join(dir, "city.json")) as { name?: string; slug?: string } | null;
  const slug = manifest?.city ?? profile?.slug ?? process.env.KIERSTON_CITY ?? "kierston";
  return {
    dir,
    slug,
    name: manifest?.name ?? profile?.name ?? slug,
    outputs: manifest ? resolve(dir, manifest.days) : join(KIERSTON_DIR, "sim_outputs"),
    manifest,
  };
}

/** The build this request is for. */
export async function currentCity(): Promise<City> {
  const store = await cookies();
  const chosen = store.get(CITY_COOKIE)?.value;
  if (chosen) {
    const city = await readCity(chosen);
    if (city) return city;
  }
  return (await readCity(DEFAULT_CITY_DIR))!;
}

/** The day picked in the header, unchecked: callers validate it against their list. */
export async function currentDay(): Promise<string | null> {
  const day = (await cookies()).get(DAY_COOKIE)?.value ?? null;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function addedCities(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const SKIP = new Set(["node_modules", "sources", "reference", "cities", "jurisdictions", "_attic", ".git"]);

/** Folders under kierston/ holding a manifest, three levels down at most. */
async function discover(dir: string, depth: number, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE)) found.push(dir);
  if (depth === 0) return;
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => discover(join(dir, entry.name), depth - 1, found)));
}

/** Every build the header can offer: the default, any under kierston/, and those added by path. */
export async function listCities(): Promise<City[]> {
  const store = await cookies();
  const found: string[] = [];
  await discover(KIERSTON_DIR, 3, found);
  const dirs = [...new Set([
    DEFAULT_CITY_DIR, ...found, ...addedCities(store.get(CITIES_COOKIE)?.value),
  ].map((dir) => resolve(dir)))];
  const cities = await Promise.all(dirs.map(readCity));
  return cities.filter((city): city is City => city !== null);
}

/** The default build is the city's name; any other is its folder. */
export function cityLabel(city: City): string {
  return city.dir === DEFAULT_CITY_DIR ? city.name : basename(city.dir);
}


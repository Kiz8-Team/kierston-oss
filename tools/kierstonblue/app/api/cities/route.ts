import { cookies } from "next/headers";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  CITIES_COOKIE, CITY_COOKIE, DAY_COOKIE, addedCities, cityLabel, currentCity, listCities, readCity,
  type City,
} from "@/lib/server/city";

export interface CityOption {
  dir: string;
  label: string;
  slug: string;
  seed: number | null;
  populationSeed: number | null;
  builtAt: string | null;
  commit: string | null;
}

function option(city: City): CityOption {
  return {
    dir: city.dir,
    label: cityLabel(city),
    slug: city.slug,
    seed: city.manifest?.seed ?? null,
    populationSeed: city.manifest?.populationSeed ?? null,
    builtAt: city.manifest?.builtAt ?? null,
    commit: city.manifest?.commit ?? null,
  };
}

const YEAR = 60 * 60 * 24 * 365;

export async function GET() {
  const [current, cities] = await Promise.all([currentCity(), listCities()]);
  return Response.json({ current: current.dir, cities: cities.map(option) });
}

/** Select a build by path, adding it to the list when it was not already there. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { dir?: unknown } | null;
  const raw = typeof body?.dir === "string" ? body.dir.trim() : "";
  const dir = raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : resolve(raw);
  const city = raw ? await readCity(dir) : null;
  if (!city) return Response.json({ error: "not a city build" }, { status: 400 });

  const store = await cookies();
  const known = (await listCities()).some((item) => item.dir === city.dir);
  if (!known) {
    const added = [...addedCities(store.get(CITIES_COOKIE)?.value), city.dir];
    store.set(CITIES_COOKIE, JSON.stringify(added), { path: "/", maxAge: YEAR, sameSite: "lax" });
  }
  store.set(CITY_COOKIE, city.dir, { path: "/", maxAge: YEAR, sameSite: "lax" });
  // A day belongs to a build; the new one picks its own newest.
  store.delete(DAY_COOKIE);
  return Response.json({ current: city.dir, city: option(city) });
}

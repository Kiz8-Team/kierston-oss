import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root, two levels above this file; resolved without loading
 * .env. Derived from import.meta.url, not Bun's import.meta.dir, because the
 * bench runner starts Fastgate under Node.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The built city's sim_data, where init's `locale` stage publishes city.json.
 * KIERSTON_SIM_DATA_DIR points elsewhere, as it does for the simulation.
 */
export function simDataDir(): string {
  return process.env.KIERSTON_SIM_DATA_DIR ?? join(REPO_ROOT, "kierston", "sim_data");
}

/**
 * The IANA zone event timestamps are written in: `CITY_TIME_ZONE` when set,
 * else the `time_zone` the city profile published to `sim_data/city.json`.
 * There is no built-in default, because a zone guessed for a city it was not
 * written for would shift every imported timestamp by hours.
 */
export function cityTimeZone(dir = simDataDir()): string {
  const override = process.env.CITY_TIME_ZONE?.trim();
  if (override) return override;
  const path = join(dir, "city.json");
  const hint = "set CITY_TIME_ZONE, or publish it with `kierston/.venv/bin/python kierston/init/init_sim.py --only locale`";
  let zone: unknown;
  try {
    zone = (JSON.parse(readFileSync(path, "utf8")) as { time_zone?: unknown }).time_zone;
  } catch (error) {
    throw new Error(`no city time zone: ${path} could not be read (${(error as Error).message}); ${hint}`);
  }
  if (typeof zone !== "string" || !zone) throw new Error(`no city time zone: ${path} has no time_zone; ${hint}`);
  return zone;
}

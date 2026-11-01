/**
 * What is particular to the loaded city, read from where init put it.
 *
 * Two sources, by who owns them. The city's own tracked lists — the stand-in
 * payer directory, the cab companies a fare is paid to — are source in
 * `cities/<city>/*.csv`, read here directly the way `cameras.json` is. The
 * city's clock is in `sim_data/city.json`, which init's `locale` stage
 * publishes from the profile; `CITY_TIME_ZONE` still overrides it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CITY, KIERSTON_DIR, SIM_DATA_DIR } from "./data.ts";

/** The city's tracked assets: cameras.json and the long lists beside it. */
export const CITY_ASSETS_DIR = join(KIERSTON_DIR, "cities", CITY);

/** One CSV record, split into fields; `"` quotes a field and `""` escapes one. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const tables = new Map<string, readonly Record<string, string>[]>();

/**
 * A city list, as header-keyed rows in file order. Order is data: callers
 * index into these lists with a seeded draw, so a reordered file changes who
 * gets which name.
 */
export function readCityTable(file: string, dir = CITY_ASSETS_DIR): readonly Record<string, string>[] {
  const path = join(dir, file);
  const cached = tables.get(path);
  if (cached) return cached;
  if (!existsSync(path)) throw new Error(`missing ${path}: the city's ${file} is tracked source beside its profile`);
  const [header, ...body] = parseCsv(readFileSync(path, "utf8"));
  if (!header) throw new Error(`${path} is empty; it needs a header row`);
  const rows = body.map((fields, line) => {
    if (fields.length !== header.length) {
      throw new Error(`${path}:${line + 2}: ${fields.length} fields, header has ${header.length}`);
    }
    return Object.fromEntries(header.map((name, column) => [name, fields[column]!]));
  });
  tables.set(path, rows);
  return rows;
}

/** The profile as init's `locale` stage published it. */
export interface CityJson {
  name: string;
  slug: string;
  center: [number, number];
  radius_m: number;
  jurisdiction: string;
  time_zone?: string;
}

/**
 * The IANA zone the city keeps: `CITY_TIME_ZONE` when set, else the profile's
 * `time_zone` from `sim_data/city.json`. There is no built-in default — a zone
 * guessed for a city it was not written for would shift every timestamp.
 */
export function cityTimeZone(dir = SIM_DATA_DIR): string {
  const override = process.env.CITY_TIME_ZONE?.trim();
  if (override) return override;
  const path = join(dir, "city.json");
  let zone: unknown;
  try {
    zone = (JSON.parse(readFileSync(path, "utf8")) as CityJson).time_zone;
  } catch (error) {
    throw new Error(`no city time zone: CITY_TIME_ZONE is unset and ${path} could not be read `
      + `(${(error as Error).message}); run \`kierston/.venv/bin/python kierston/init/init_sim.py --only locale\``);
  }
  if (typeof zone !== "string" || !zone) {
    throw new Error(`no city time zone: CITY_TIME_ZONE is unset and ${path} has no time_zone; `
      + "run `kierston/.venv/bin/python kierston/init/init_sim.py --only locale`");
  }
  return zone;
}

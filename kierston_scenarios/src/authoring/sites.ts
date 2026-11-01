/**
 * Sites: the buildings people work and study in, as places a scenario can
 * bind.
 *
 * Venues are where the discretionary layer sends people for coffee and
 * groceries; sites are where the employment and school layers send them for
 * the day. A hospital, a warehouse, a government office or a school is a
 * site, and a scenario that stages an incident there needs to pick one by
 * what it is rather than by an OSM id copied from a map. The catalogue is
 * read once from `workplaces.json` and `schools.json`, the same files the
 * engine placed those people with.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transport, world } from "../../../kierston/sim/src/index.ts";
import type { Place } from "./dsl.ts";

export interface Site {
  id: string;
  /** Building class from the workplace catalogue (`hospital`, `warehouse`, `school`, ...). */
  class: string;
  name: string | null;
  address: string | null;
  lat: number;
  lon: number;
  /** People the catalogue expects on site on a working day; null where unknown. */
  capacity: number | null;
}

export interface SiteFilter {
  id?: string;
  /** One class or any of several; matched exactly against the catalogue class. */
  class?: string | readonly string[];
  /** Require a catalogued capacity of at least this many people. */
  minCapacity?: number;
  near?: Place;
  withinKm?: number;
}

interface WorkplaceRecord { id: string; lat: number; lon: number; class?: string; name?: string | null; address?: string | null; capacity?: number | null }
interface SchoolRecord { id: string; lat: number; lon: number; name?: string | null; capacity?: number | null }

export class SiteCatalog {
  private static instance: SiteCatalog | undefined;
  readonly sites: readonly Site[];
  private constructor(sites: Site[]) { this.sites = sites; }

  /** The catalogue for the sim data directory the engine itself reads. */
  static shared(directory = world.SIM_DATA_DIR): SiteCatalog {
    if (!SiteCatalog.instance) SiteCatalog.instance = SiteCatalog.load(directory);
    return SiteCatalog.instance;
  }
  static load(directory: string): SiteCatalog {
    const read = <T>(file: string): T => JSON.parse(readFileSync(join(directory, file), "utf8")) as T;
    const workplaces = read<{ site_records: WorkplaceRecord[] }>("workplaces.json").site_records;
    const schools = read<{ school_records: SchoolRecord[] }>("schools.json").school_records;
    const byId = new Map<string, Site>();
    for (const row of workplaces) {
      byId.set(row.id, { id: row.id, class: row.class ?? "yes", name: row.name || null, address: row.address || null,
        lat: row.lat, lon: row.lon, capacity: typeof row.capacity === "number" ? row.capacity : null });
    }
    // The school file placed the students, so it names the class where the
    // two catalogues disagree.
    for (const row of schools) {
      const known = byId.get(row.id);
      byId.set(row.id, { id: row.id, class: "school", name: row.name || known?.name || null, address: known?.address ?? null,
        lat: row.lat, lon: row.lon, capacity: typeof row.capacity === "number" ? row.capacity : known?.capacity ?? null });
    }
    return new SiteCatalog([...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  matching(role: string, filter: SiteFilter): Site[] {
    if (filter.withinKm !== undefined && (!filter.near || !(filter.withinKm > 0))) throw new Error(`${role}: withinKm requires near and a positive radius`);
    const classes = filter.class === undefined ? null : new Set(typeof filter.class === "string" ? [filter.class] : filter.class);
    if (classes && !classes.size) throw new Error(`${role}: class must not be empty`);
    if (filter.minCapacity !== undefined && !(filter.minCapacity >= 0)) throw new Error(`${role}: minCapacity must be non-negative`);
    return this.sites.filter((site) => {
      if (filter.id !== undefined && site.id !== filter.id) return false;
      if (classes && !classes.has(site.class)) return false;
      if (filter.minCapacity !== undefined && (site.capacity === null || site.capacity < filter.minCapacity)) return false;
      if (filter.near && filter.withinKm !== undefined && transport.haversineKm(filter.near, site) > filter.withinKm) return false;
      return true;
    });
  }
  get(id: string): Site | undefined { return this.sites.find((site) => site.id === id); }
}

/** A site as a scenario place: a venue-kind point that trips can route to and presence can hold at. */
export function sitePlace(site: Site): Place {
  return { lat: site.lat, lon: site.lon, id: site.id, kind: "venue", label: site.name || site.address || site.id };
}

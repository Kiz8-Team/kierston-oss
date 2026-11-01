"use client";

import { buildPointGrid, type SpatialGrid } from "./grid";
import { WORKPLACE_GROUPS, workplaceGroup, type WorkplaceGroupId } from "./map-style";
import type { Population } from "./population";

/**
 * Where everyone works, joined to where they live.
 *
 * sim_data/employment.json is one row per working person — 54,664 of them —
 * saying which site they were assigned to, how they get there and when. It
 * carries site ids, not coordinates, so on its own it cannot be shown: the
 * catalogue of places lives in workplaces.json, the emergency stations live in
 * employment.json's own `facilities`, and a home-based worker's "site" is the
 * OSM id of their dwelling, which only the population knows about. This module
 * resolves all three into one array of sites, indexes the assignments by
 * person and by site, and hands the result to the views.
 *
 * The join is done once per session, in the same spirit as lib/datasets.ts:
 * moving between the jobs table, the workplace table and the map must not cost
 * another 10 MB parse.
 */

export type WorkMode = "sited" | "itinerant" | "home" | "external";
export type WorkClass = "primary" | "filler";

export const MODE_LABEL: Record<WorkMode, string> = {
  sited: "on site",
  itinerant: "itinerant",
  home: "home",
  external: "outside the region",
};

/** How assign_work.py found a seat: exact industry, its sector, or anything. */
export const MATCH_LABEL: Record<string, string> = {
  exact: "exact industry",
  sector: "same sector",
  any: "any industry",
  home: "home",
  external: "outside the region",
  none: "none",
};

export type SiteCategory = "workplace" | "facility" | "home";

export interface Site {
  index: number;
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  category: SiteCategory;
  /** OSM building class, or the facility kind for a station. */
  klass: string;
  group: WorkplaceGroupId;
  /** Seats workplaces.py allowed here. 0 where the concept does not apply. */
  capacity: number;
  /** Usable floor area in m², summed over levels. */
  floor: number;
  industries: string[];
  /** tag, poi or inferred — how confident the industry label is. */
  evidence: string;
  /** A station whose position or size was estimated rather than surveyed. */
  estimated: boolean;
  /** Station, substation, bureau — only emergency facilities carry one. */
  role: string;
  staff: number[];
}

export interface Assignment {
  index: number;
  /** Resident id in the population's own numbering. */
  person: number;
  klass: WorkClass;
  mode: WorkMode;
  occupation: string;
  industry: string | null;
  /** Index into `sites`, or -1 for a job outside the region. */
  site: number;
  hours: number | null;
  /** Minutes past midnight, from the ACS departure and arrival bins. */
  depart: number | null;
  arrive: number | null;
  /** JWTRNS code. */
  transport: string | null;
  /** Door-to-door minutes, as assigned. */
  travel: number | null;
  match: string | null;
  role: string | null;
  platoon: string | null;
  duty: string | null;
  crew: string | null;
}

export interface Role {
  key: string;
  label: string;
  occupation: string;
  target: number | null;
  count: number;
}

export interface Portal {
  id: string;
  lat: number;
  lon: number;
  workers: number;
  provisional: boolean;
}

export interface GroupCount {
  id: WorkplaceGroupId;
  label: string;
  color: string;
  sites: number;
  staff: number;
}

export class Employment {
  readonly assignments: Assignment[];
  readonly sites: Site[];
  readonly roles: Role[];
  readonly portals: Portal[];
  readonly groups: GroupCount[];
  readonly seed: number;
  readonly source: string;
  /** Resident id → assignment index, -1 for anyone without a job. */
  readonly byPerson: Int32Array;
  readonly grid: SpatialGrid;
  readonly siteById: Map<string, number>;
  /** Assignments per mode, over the whole workforce. */
  readonly modes: Record<WorkMode, number>;

  constructor(init: {
    assignments: Assignment[];
    sites: Site[];
    roles: Role[];
    portals: Portal[];
    seed: number;
    source: string;
    byPerson: Int32Array;
    siteById: Map<string, number>;
  }) {
    this.assignments = init.assignments;
    this.sites = init.sites;
    this.roles = init.roles;
    this.portals = init.portals;
    this.seed = init.seed;
    this.source = init.source;
    this.byPerson = init.byPerson;
    this.siteById = init.siteById;
    this.grid = buildPointGrid(this.sites.length, (i) => [this.sites[i].lat, this.sites[i].lon]);

    this.modes = { sited: 0, itinerant: 0, home: 0, external: 0 };
    for (const assignment of this.assignments) this.modes[assignment.mode] += 1;

    const bySite = new Map<WorkplaceGroupId, { sites: number; staff: number }>();
    for (const site of this.sites) {
      const slot = bySite.get(site.group) ?? { sites: 0, staff: 0 };
      slot.sites += 1;
      slot.staff += site.staff.length;
      bySite.set(site.group, slot);
    }
    this.groups = WORKPLACE_GROUPS
      .map((group) => ({
        id: group.id,
        label: group.label,
        color: group.color,
        sites: bySite.get(group.id)?.sites ?? 0,
        staff: bySite.get(group.id)?.staff ?? 0,
      }))
      .filter((group) => group.sites > 0);
  }

  /** The job a resident holds, or null if they hold none. */
  forPerson(id: number): Assignment | null {
    if (id < 0 || id >= this.byPerson.length) return null;
    const index = this.byPerson[id];
    return index < 0 ? null : this.assignments[index];
  }

  siteOf(assignment: Assignment | null): Site | null {
    if (!assignment || assignment.site < 0) return null;
    return this.sites[assignment.site];
  }

  /** Everyone working at a building, addressed by its OSM id. */
  staffOfOsmId(osmId: string): Assignment[] {
    const index = this.siteById.get(osmId);
    if (index === undefined) return [];
    return this.sites[index].staff.map((i) => this.assignments[i]);
  }

  get workers(): number { return this.assignments.length; }
  get sited(): number { return this.modes.sited; }
}

// ---- Decoding ---------------------------------------------------------------

interface RawAssignment {
  person: number;
  class: WorkClass;
  mode: WorkMode;
  occupation: string;
  industry?: string | null;
  site?: string | null;
  hours?: number | null;
  depart?: number | null;
  arrive?: number | null;
  transport?: string | null;
  travel?: number | null;
  match?: string | null;
  role?: string | null;
  platoon?: string | null;
  duty?: string | null;
  crew?: string | null;
}

interface RawFacility {
  key: string;
  kind: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  floor: number;
  estimated: boolean;
  role?: string;
}

interface RawSite {
  id: string;
  lat: number;
  lon: number;
  class: string;
  name: string;
  address: string;
  floor: number;
  industries: string[];
  evidence: string;
  capacity: number;
  estimated?: boolean;
}

export interface EmploymentFile {
  source: string;
  seed: number;
  work_assignment_seed?: number;
  roles: Record<string, { occupation: string; target: number | null; class: string }>;
  facilities: RawFacility[];
  assignments: RawAssignment[];
}

export interface WorkplaceFile {
  site_records: RawSite[];
  portals: Portal[];
}

const titleCase = (key: string) =>
  key.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());

export function joinEmployment(
  employment: EmploymentFile,
  workplaces: WorkplaceFile,
  population: Population,
): Employment {
  const sites: Site[] = [];
  const siteById = new Map<string, number>();

  const add = (site: Omit<Site, "index" | "staff">): number => {
    const index = sites.length;
    sites.push({ ...site, index, staff: [] });
    siteById.set(site.id, index);
    return index;
  };

  for (const record of workplaces.site_records) {
    add({
      id: record.id,
      name: record.name,
      address: record.address,
      lat: record.lat,
      lon: record.lon,
      category: "workplace",
      klass: record.class,
      group: workplaceGroup(record.class),
      capacity: record.capacity,
      floor: record.floor,
      industries: record.industries,
      evidence: record.evidence,
      estimated: Boolean(record.estimated),
      role: "",
    });
  }

  // Stations come from employment.json rather than the workplace catalogue,
  // because their staffing is a declared establishment and not floor area.
  for (const facility of employment.facilities) {
    if (siteById.has(facility.key)) continue;
    add({
      id: facility.key,
      name: facility.name,
      address: facility.address,
      lat: facility.lat,
      lon: facility.lon,
      category: "facility",
      klass: facility.kind,
      group: workplaceGroup(facility.kind),
      capacity: 0,
      floor: facility.floor,
      industries: [],
      evidence: "establishment",
      estimated: Boolean(facility.estimated),
      role: facility.role ?? "",
    });
  }

  const assignments: Assignment[] = [];
  const byPerson = new Int32Array(population.counts.persons + population.counts.quarters)
    .fill(-1);

  for (const raw of employment.assignments) {
    let site = -1;
    if (raw.site) {
      const known = siteById.get(raw.site);
      if (known !== undefined) {
        site = known;
      } else {
        // Not in either catalogue, so it is a dwelling: someone who works at
        // home, or a driver whose cab lives on their own street.
        const index = population.buildingByOsmId.get(raw.site);
        if (index !== undefined) {
          const building = population.building(index);
          site = add({
            id: building.id,
            name: "",
            address: building.address,
            lat: building.lat,
            lon: building.lon,
            category: "home",
            klass: building.kind,
            group: "home",
            capacity: 0,
            floor: 0,
            industries: [],
            evidence: "dwelling",
            estimated: false,
            role: "",
          });
        }
      }
    }

    const assignment: Assignment = {
      index: assignments.length,
      person: raw.person,
      klass: raw.class,
      mode: raw.mode,
      occupation: raw.occupation,
      industry: raw.industry ?? null,
      site,
      hours: raw.hours ?? null,
      depart: raw.depart ?? null,
      arrive: raw.arrive ?? null,
      transport: raw.transport ?? null,
      travel: raw.travel ?? null,
      match: raw.match ?? null,
      role: raw.role ?? null,
      platoon: raw.platoon ?? null,
      duty: raw.duty ?? null,
      crew: raw.crew ?? null,
    };
    assignments.push(assignment);
    if (site >= 0) sites[site].staff.push(assignment.index);
    if (raw.person >= 0 && raw.person < byPerson.length) byPerson[raw.person] = assignment.index;
  }

  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    if (assignment.role) counts.set(assignment.role, (counts.get(assignment.role) ?? 0) + 1);
  }
  const roles: Role[] = Object.entries(employment.roles ?? {}).map(([key, role]) => ({
    key,
    label: titleCase(key),
    occupation: role.occupation,
    target: role.target,
    count: counts.get(key) ?? 0,
  }));

  return new Employment({
    assignments,
    sites,
    roles,
    portals: workplaces.portals ?? [],
    seed: employment.work_assignment_seed ?? employment.seed,
    source: employment.source,
    byPerson,
    siteById,
  });
}

/** "7:15 a.m." from minutes past midnight. */
export function clock(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "—";
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const half = hour < 12 ? "am" : "pm";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${String(minute).padStart(2, "0")} ${half}`;
}

export function siteLabel(site: Site | null): string {
  if (!site) return "Outside the region";
  if (site.name) return site.name;
  if (site.category === "home") return "Home";
  if (site.address) return site.address;
  return titleCase(site.klass || "building");
}

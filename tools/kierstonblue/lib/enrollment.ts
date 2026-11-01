"use client";

import { buildPointGrid, type SpatialGrid } from "./grid";
import type { Population } from "./population";

/**
 * Where everyone studies, joined to where they live.
 *
 * The counterpart to lib/employment.ts, and the same shape of problem:
 * sim_data/enrollment.json is one row per enrolled person saying which school
 * they were sent to, and it carries school ids rather than coordinates. The
 * catalogue those ids point at lives in schools.json. This resolves the two
 * into one array of schools, indexes the assignments by person and by school,
 * and hands the result to the views.
 *
 * Where it differs from employment is worth stating, because the difference is
 * the interesting part of the dataset. A workplace is chosen; a public school
 * is assigned by catchment. assign_school.py therefore places students at
 * their nearest school with room rather than by gravity, and the emergent
 * catchments are the thing a reader wants to interrogate — which is why the
 * school detail leads with trip distance and how many students got a school
 * that was not their nearest.
 */

export type StudyMode = "enrolled" | "external";
export type Band = "prek" | "elem" | "middle" | "high" | "college";
export type Sector = "public" | "charter" | "private" | "unknown";

/** Grade order, which is also the order every band list is shown in. */
export const BANDS: Band[] = ["prek", "elem", "middle", "high", "college"];

export const BAND_LABEL: Record<Band, string> = {
  prek: "Preschool",
  elem: "Elementary",
  middle: "Middle school",
  high: "High school",
  college: "College",
};

export const SECTOR_LABEL: Record<Sector, string> = {
  public: "Public",
  charter: "Charter",
  private: "Private",
  unknown: "Not known",
};

export const MODE_LABEL: Record<StudyMode, string> = {
  enrolled: "in Kierston",
  external: "outside the region",
};

export interface School {
  index: number;
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** school or college — a campus is one institution, not one building. */
  kind: "school" | "college";
  /** The grades taught here. More than one where the name did not say. */
  bands: Band[];
  /** False where `bands` is the any-K-12 fallback rather than read off a name. */
  banded: boolean;
  sector: Sector;
  /** Students schools.py sized the building for. */
  capacity: number;
  floor: number;
  /** The OSM ways merged into this record. One, except for a campus. */
  buildings: string[];
  students: number[];
}

export interface Enrollment_ {
  index: number;
  /** Resident id in the population's own numbering. */
  person: number;
  band: Band;
  /** SCHG, or null where the sample did not give one. */
  grade: string | null;
  /** What the student reported, which is not always what the school is. */
  sector: Sector;
  mode: StudyMode;
  /** Index into `schools`, or -1 for a place outside the region. */
  school: number;
  /** Door-to-door minutes, as assigned. */
  travel: number | null;
  /** Minutes past midnight. */
  depart: number | null;
  arrive: number | null;
}

export interface BandCount {
  id: Band;
  label: string;
  color: string;
  schools: number;
  students: number;
  external: number;
}

export class Enrollment {
  readonly assignments: Enrollment_[];
  readonly schools: School[];
  readonly seed: number;
  readonly source: string;
  /** Students the PUMS weights imply per band, for the fit against capacity. */
  readonly demand: Partial<Record<Band, number>>;
  /** Resident id → assignment index, -1 for anyone not enrolled. */
  readonly byPerson: Int32Array;
  /**
   * Where each student sleeps, parallel to `assignments`.
   *
   * Resolved once at join time rather than on demand, because the map's
   * catchment layer draws a line from every visible student's home on every
   * frame. Going through Population.building() there would allocate a record
   * and do three string-table lookups per student per frame — 25,000 of them
   * at the draw budget, which is the difference between a smooth pan and a
   * stuttering one. f64 because a lat needs eight significant digits and f32
   * carries seven.
   */
  readonly homeLat: Float64Array;
  readonly homeLon: Float64Array;
  readonly grid: SpatialGrid;
  readonly schoolById: Map<string, number>;
  readonly modes: Record<StudyMode, number>;
  readonly bands: BandCount[];

  constructor(init: {
    assignments: Enrollment_[];
    schools: School[];
    seed: number;
    source: string;
    demand: Partial<Record<Band, number>>;
    byPerson: Int32Array;
    homeLat: Float64Array;
    homeLon: Float64Array;
    schoolById: Map<string, number>;
  }) {
    this.homeLat = init.homeLat;
    this.homeLon = init.homeLon;
    this.assignments = init.assignments;
    this.schools = init.schools;
    this.seed = init.seed;
    this.source = init.source;
    this.demand = init.demand;
    this.byPerson = init.byPerson;
    this.schoolById = init.schoolById;
    this.grid = buildPointGrid(this.schools.length,
      (i) => [this.schools[i].lat, this.schools[i].lon]);

    this.modes = { enrolled: 0, external: 0 };
    for (const assignment of this.assignments) this.modes[assignment.mode] += 1;

    const students = new Map<Band, number>();
    const external = new Map<Band, number>();
    for (const assignment of this.assignments) {
      const into = assignment.mode === "external" ? external : students;
      into.set(assignment.band, (into.get(assignment.band) ?? 0) + 1);
    }
    // A school teaching three bands counts once in each, because the question
    // the legend answers is "how many buildings could take a nine-year-old",
    // not "how many buildings are there".
    const schools = new Map<Band, number>();
    for (const school of this.schools) {
      for (const band of school.bands) schools.set(band, (schools.get(band) ?? 0) + 1);
    }

    this.bands = BANDS
      .map((band) => ({
        id: band,
        label: BAND_LABEL[band],
        color: BAND_COLOR[band],
        schools: schools.get(band) ?? 0,
        students: students.get(band) ?? 0,
        external: external.get(band) ?? 0,
      }))
      .filter((band) => band.students > 0 || band.external > 0);
  }

  /** Where a resident studies, or null if they are not enrolled. */
  forPerson(id: number): Enrollment_ | null {
    if (id < 0 || id >= this.byPerson.length) return null;
    const index = this.byPerson[id];
    return index < 0 ? null : this.assignments[index];
  }

  schoolOf(assignment: Enrollment_ | null): School | null {
    if (!assignment || assignment.school < 0) return null;
    return this.schools[assignment.school];
  }

  /**
   * Everyone studying at a building, addressed by its OSM id.
   *
   * A campus answers to any of its buildings, which is why `schoolById` is
   * populated from `buildings` and not only from the record's own id: clicking
   * Cressman Library on the map has to find Muhlenberg.
   */
  studentsOfOsmId(osmId: string): Enrollment_[] {
    const index = this.schoolById.get(osmId);
    if (index === undefined) return [];
    return this.schools[index].students.map((i) => this.assignments[i]);
  }

  get students(): number { return this.assignments.length; }
  get placed(): number { return this.modes.enrolled; }
  get seats(): number {
    return this.schools.reduce((sum, school) => sum + school.capacity, 0);
  }
}

/** Legend colours, warm through the compulsory years and cool for college. */
export const BAND_COLOR: Record<Band, string> = {
  prek: "#e9a13b",
  elem: "#e2622f",
  middle: "#c2417a",
  high: "#7a4fc0",
  college: "#2a86c8",
};

// ---- Decoding ---------------------------------------------------------------

interface RawAssignment {
  person: number;
  band: Band;
  grade?: string | null;
  sector: Sector;
  mode: StudyMode;
  school?: string | null;
  travel?: number | null;
  depart?: number | null;
  arrive?: number | null;
}

interface RawSchool {
  id: string;
  lat: number;
  lon: number;
  name: string;
  kind: "school" | "college";
  bands: Band[];
  banded: boolean;
  sector: Sector;
  capacity: number;
  floor: number;
  buildings: string[];
}

export interface EnrollmentFile {
  source: string;
  seed: number;
  assignments: RawAssignment[];
}

export interface SchoolFile {
  school_records: RawSchool[];
  demand?: Partial<Record<Band, number>>;
}

export function joinEnrollment(
  enrollment: EnrollmentFile,
  catalogue: SchoolFile,
  population: Population,
): Enrollment {
  const schools: School[] = [];
  const schoolById = new Map<string, number>();

  for (const record of catalogue.school_records) {
    const index = schools.length;
    schools.push({ ...record, index, students: [] });
    schoolById.set(record.id, index);
    for (const building of record.buildings ?? []) schoolById.set(building, index);
  }

  const assignments: Enrollment_[] = [];
  const byPerson = new Int32Array(population.counts.persons + population.counts.quarters)
    .fill(-1);
  const homeLat = new Float64Array(enrollment.assignments.length);
  const homeLon = new Float64Array(enrollment.assignments.length);
  const a = population.a;

  for (const raw of enrollment.assignments) {
    const school = raw.school ? schoolById.get(raw.school) ?? -1 : -1;
    const assignment: Enrollment_ = {
      index: assignments.length,
      person: raw.person,
      band: raw.band,
      grade: raw.grade ?? null,
      sector: raw.sector,
      mode: raw.mode,
      school,
      travel: raw.travel ?? null,
      depart: raw.depart ?? null,
      arrive: raw.arrive ?? null,
    };
    assignments.push(assignment);
    if (school >= 0) schools[school].students.push(assignment.index);
    if (raw.person >= 0 && raw.person < byPerson.length) byPerson[raw.person] = assignment.index;

    // residentBuilding binary-searches the household offsets, so it is paid
    // once here rather than once per student per frame.
    const building = population.residentBuilding(raw.person);
    homeLat[assignment.index] = a.building_lat[building];
    homeLon[assignment.index] = a.building_lon[building];
  }

  return new Enrollment({
    assignments,
    schools,
    seed: enrollment.seed,
    source: enrollment.source,
    demand: catalogue.demand ?? {},
    byPerson,
    homeLat,
    homeLon,
    schoolById,
  });
}

export function schoolLabel(school: School | null): string {
  if (!school) return "Outside the region";
  if (school.name) return school.name;
  // 11 of the 77 sites are unnamed ways. Saying which band it teaches is more
  // use than repeating the id, which is on the row next to it anyway.
  const bands = school.bands.map((band) => BAND_LABEL[band].toLowerCase()).join(" / ");
  return `Unnamed ${bands} school`;
}

/** Straight-line metres, which is what the school chooser itself scored on. */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

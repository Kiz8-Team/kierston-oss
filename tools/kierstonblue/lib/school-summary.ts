import {
  BANDS, BAND_LABEL, SECTOR_LABEL, type Band, type Enrollment, type Sector,
} from "./enrollment";
import type { Population } from "./population";
import type { Band as Bar } from "./summary";

/** Whole-enrollment distributions, in one pass over the assignments. */

export interface SchoolSummary {
  students: number;
  placed: number;
  external: number;
  /** People under 18, the pool most of the students come out of. */
  minors: number;
  schoolsUsed: number;
  seats: number;
  medianTrip: number;
  bands: Bar[];
  sectors: Bar[];
  trips: Bar[];
  starts: Bar[];
  /** Seats against the students PUMS implies, per band. */
  fit: { label: string; seats: number; wanted: number }[];
  note: string;
}

const TRIP_BANDS = [
  [0, 8, "under 8 min"],
  [8, 12, "8–11 min"],
  [12, 16, "12–15 min"],
  [16, 22, "16–21 min"],
  [22, 30, "22–29 min"],
  [30, Infinity, "30+ min"],
] as const;

/**
 * School start times, which are staggered by band rather than spread like
 * commutes. American districts run one bus fleet over three routes, so the
 * departures pile up in three narrow spikes and a band-width histogram is the
 * honest way to show it.
 */
const START_BANDS = [
  [0, 7 * 60, "before 7 am"],
  [7 * 60, 7.5 * 60, "7–7:30 am"],
  [7.5 * 60, 8 * 60, "7:30–8 am"],
  [8 * 60, 8.5 * 60, "8–8:30 am"],
  [8.5 * 60, 9 * 60, "8:30–9 am"],
  [9 * 60, 24 * 60, "after 9 am"],
] as const;

const SECTORS: Sector[] = ["public", "charter", "private", "unknown"];

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summariseSchools(
  enrollment: Enrollment,
  population: Population,
): SchoolSummary {
  const trips = TRIP_BANDS.map(([, , label]) => ({ label, value: 0 }));
  const starts = START_BANDS.map(([, , label]) => ({ label, value: 0 }));
  const times: number[] = [];
  const sectors = new Map<Sector, number>();

  for (const assignment of enrollment.assignments) {
    // The sector counted is the school's, not the student's answer: a private
    // school student with no local place attends nothing here, and counting
    // them as private would overstate what the city's private stock holds.
    const school = enrollment.schoolOf(assignment);
    if (school) sectors.set(school.sector, (sectors.get(school.sector) ?? 0) + 1);

    if (assignment.travel !== null && assignment.travel > 0) {
      times.push(assignment.travel);
      const band = TRIP_BANDS.findIndex(
        ([low, high]) => assignment.travel! >= low && assignment.travel! < high);
      trips[band === -1 ? trips.length - 1 : band].value += 1;
    }
    if (assignment.depart !== null) {
      const band = START_BANDS.findIndex(
        ([low, high]) => assignment.depart! >= low && assignment.depart! < high);
      if (band !== -1) starts[band].value += 1;
    }
  }

  let minors = 0;
  const a = population.a;
  for (let p = 0; p < a.person_age.length; p += 1) if (a.person_age[p] < 18) minors += 1;
  for (let q = 0; q < a.quarters_age.length; q += 1) if (a.quarters_age[q] < 18) minors += 1;

  let schoolsUsed = 0;
  for (const school of enrollment.schools) if (school.students.length) schoolsUsed += 1;

  const seatsPerBand = new Map<Band, number>();
  for (const school of enrollment.schools) {
    // A school eligible for three bands has one set of seats, not three. It is
    // attributed to the band it was named for, and an unbanded one to the
    // middle of the range it could serve, so the totals still add up.
    const band = school.banded ? school.bands[0] : school.bands[school.bands.length >> 1];
    seatsPerBand.set(band, (seatsPerBand.get(band) ?? 0) + school.capacity);
  }

  return {
    students: enrollment.students,
    placed: enrollment.placed,
    external: enrollment.modes.external,
    minors,
    schoolsUsed,
    seats: enrollment.seats,
    medianTrip: median(times),
    bands: BANDS
      .map((band) => ({
        label: BAND_LABEL[band],
        value: enrollment.bands.find((entry) => entry.id === band)?.students ?? 0,
      }))
      .filter((bar) => bar.value > 0),
    sectors: SECTORS
      .map((sector) => ({ label: SECTOR_LABEL[sector], value: sectors.get(sector) ?? 0 }))
      .filter((bar) => bar.value > 0),
    trips,
    starts,
    fit: BANDS
      .map((band) => ({
        label: BAND_LABEL[band],
        seats: seatsPerBand.get(band) ?? 0,
        wanted: enrollment.demand[band] ?? 0,
      }))
      .filter((row) => row.seats > 0 || row.wanted > 0),
    note: `${enrollment.source} · school seed ${enrollment.seed}`,
  };
}

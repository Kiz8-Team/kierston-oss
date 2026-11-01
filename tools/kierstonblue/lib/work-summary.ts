import type { Employment, WorkMode } from "./employment";
import { MODE_LABEL } from "./employment";
import type { Labels } from "./labels";
import type { Population } from "./population";
import type { Band } from "./summary";

/** Whole-workforce distributions, in one pass over the assignments. */

export interface WorkSummary {
  workers: number;
  /** People the population marks as employed, 16 and over. */
  employed: number;
  sitesUsed: number;
  seats: number;
  medianCommute: number;
  medianHours: number;
  modes: Band[];
  commutes: Band[];
  departures: Band[];
  sectors: Band[];
  occupationGroups: Band[];
  note: string;
}

const COMMUTE_BANDS = [
  [0, 10, "under 10 min"],
  [10, 20, "10–19 min"],
  [20, 30, "20–29 min"],
  [30, 45, "30–44 min"],
  [45, 60, "45–59 min"],
  [60, Infinity, "60+ min"],
] as const;

const DEPARTURE_BANDS = [
  [0, 5 * 60, "before 5 am"],
  [5 * 60, 6 * 60, "5–6 am"],
  [6 * 60, 7 * 60, "6–7 am"],
  [7 * 60, 8 * 60, "7–8 am"],
  [8 * 60, 9 * 60, "8–9 am"],
  [9 * 60, 12 * 60, "9 am–noon"],
  [12 * 60, 17 * 60, "afternoon"],
  [17 * 60, 24 * 60, "evening or night"],
] as const;

const MODE_ORDER: WorkMode[] = ["sited", "itinerant", "home", "external"];

/** Employed, in the ACS sense: at work, absent from it, or in the forces. */
const EMPLOYED = new Set([1, 2, 4, 5]);

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summariseWork(
  employment: Employment,
  labels: Labels,
  population: Population,
): WorkSummary {
  const commutes = COMMUTE_BANDS.map(([, , label]) => ({ label, value: 0 }));
  const departures = DEPARTURE_BANDS.map(([, , label]) => ({ label, value: 0 }));
  const sectors = new Map<string, number>();
  const groups = new Map<string, number>();
  const travel: number[] = [];
  const hours: number[] = [];

  for (const assignment of employment.assignments) {
    if (assignment.travel !== null && assignment.travel > 0) {
      travel.push(assignment.travel);
      const band = COMMUTE_BANDS.findIndex(
        ([low, high]) => assignment.travel! >= low && assignment.travel! < high);
      commutes[band === -1 ? commutes.length - 1 : band].value += 1;
    }
    if (assignment.hours !== null) hours.push(assignment.hours);
    if (assignment.depart !== null) {
      const band = DEPARTURE_BANDS.findIndex(
        ([low, high]) => assignment.depart! >= low && assignment.depart! < high);
      if (band !== -1) departures[band].value += 1;
    }
    const sector = labels.industrySector(assignment.industry);
    if (sector) sectors.set(sector, (sectors.get(sector) ?? 0) + 1);
    const group = labels.occupationGroupLabel(assignment.occupation);
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  let employed = 0;
  const a = population.a;
  for (let p = 0; p < a.person_age.length; p += 1) {
    if (a.person_age[p] >= 16 && EMPLOYED.has(a.person_employment[p])) employed += 1;
  }
  for (let q = 0; q < a.quarters_age.length; q += 1) {
    if (a.quarters_age[q] >= 16 && EMPLOYED.has(a.quarters_employment[q])) employed += 1;
  }

  let seats = 0;
  let sitesUsed = 0;
  for (const site of employment.sites) {
    seats += site.capacity;
    if (site.staff.length) sitesUsed += 1;
  }

  const ranked = (counts: Map<string, number>, limit: number): Band[] =>
    [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, limit)
      .map(([label, value]) => ({ label, value }));

  return {
    workers: employment.workers,
    employed,
    sitesUsed,
    seats,
    medianCommute: median(travel),
    medianHours: median(hours),
    modes: MODE_ORDER.map((mode) => ({
      label: MODE_LABEL[mode],
      value: employment.modes[mode],
    })),
    commutes,
    departures,
    sectors: ranked(sectors, 8).map((band) => ({
      label: labels.sectorLabel(band.label),
      value: band.value,
    })),
    occupationGroups: ranked(groups, 8),
    note: `${employment.source} · work seed ${employment.seed}`,
  };
}

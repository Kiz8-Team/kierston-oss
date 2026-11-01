import type { Population } from "./population";
import { num, usd, usdCompact } from "./format";

/**
 * Area statistics: the synthetic population, aggregated into square cells.
 *
 * Every household is placed in a specific building, so any area question —
 * density, age, income — is a matter of choosing a cell size and summing. The
 * cells are square in metres rather than degrees, so a cell means the same
 * thing at the top of the map as at the bottom and a density is honest.
 *
 * Aggregation touches every person once (about 90,000 of them) and takes a few
 * milliseconds, so a result is cached per cell size and per metric set rather
 * than recomputed while a legend is being dragged.
 */

const METRES_PER_DEGREE_LAT = 111_320;

export interface AreaCell {
  key: number;
  row: number;
  col: number;
  south: number;
  west: number;
  north: number;
  east: number;
  households: number;
  people: number;
  quarters: number;
  ageSum: number;
  under18: number;
  over64: number;
  employed: number;
  workingAge: number;
  incomes: number[];
  medianIncome: number;
  rents: number[];
  medianRent: number;
  areaKm2: number;
}

export interface AreaGrid {
  /** Cell side, in metres. */
  size: number;
  cells: AreaCell[];
  byKey: Map<number, AreaCell>;
  totals: { households: number; people: number; cells: number };
}

export type MetricId =
  | "density" | "households" | "age" | "income" | "rent" | "size" | "children" | "employment";

export interface Metric {
  id: MetricId;
  label: string;
  unit: string;
  /** NaN for a cell with too little in it to say anything. */
  value: (cell: AreaCell) => number;
  format: (value: number) => string;
  /** Short form for a legend tick. */
  tick: (value: number) => string;
}

/** Cells below this are noise: one household's income is not an area's income. */
const MIN_HOUSEHOLDS = 3;

export const METRICS: Metric[] = [
  {
    id: "density",
    label: "People per km²",
    unit: "people/km²",
    value: (c) => c.people / c.areaKm2,
    format: (v) => `${num(v)} people/km²`,
    tick: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : num(v)),
  },
  {
    id: "households",
    label: "Households per km²",
    unit: "households/km²",
    value: (c) => c.households / c.areaKm2,
    format: (v) => `${num(v)} households/km²`,
    tick: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : num(v)),
  },
  {
    id: "age",
    label: "Average age",
    unit: "years",
    value: (c) => (c.people >= MIN_HOUSEHOLDS ? c.ageSum / c.people : NaN),
    format: (v) => `${v.toFixed(1)} years`,
    tick: (v) => v.toFixed(0),
  },
  {
    id: "income",
    label: "Median household income",
    unit: "USD/year",
    value: (c) => (c.households >= MIN_HOUSEHOLDS ? c.medianIncome : NaN),
    format: (v) => `${usd(v)} median`,
    tick: usdCompact,
  },
  {
    id: "rent",
    label: "Median monthly rent",
    unit: "USD/month",
    value: (c) => (c.rents.length >= MIN_HOUSEHOLDS ? c.medianRent : NaN),
    format: (v) => `${usd(v)} monthly median`,
    tick: usdCompact,
  },
  {
    id: "size",
    label: "Average household size",
    unit: "people",
    value: (c) => (c.households >= MIN_HOUSEHOLDS ? (c.people - c.quarters) / c.households : NaN),
    format: (v) => `${v.toFixed(2)} people per household`,
    tick: (v) => v.toFixed(1),
  },
  {
    id: "children",
    label: "Share under 18",
    unit: "%",
    value: (c) => (c.people >= 10 ? c.under18 / c.people : NaN),
    format: (v) => `${(v * 100).toFixed(1)}% under 18`,
    tick: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: "employment",
    label: "Employment rate, 16–64",
    unit: "%",
    value: (c) => (c.workingAge >= 10 ? c.employed / c.workingAge : NaN),
    format: (v) => `${(v * 100).toFixed(1)}% employed`,
    tick: (v) => `${Math.round(v * 100)}%`,
  },
];

export const METRIC_BY_ID = new Map(METRICS.map((metric) => [metric.id, metric]));

export const CELL_SIZES = [150, 250, 400, 650, 1000];

const cache = new Map<number, AreaGrid>();

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Bucket the population into `size`-metre cells.
 *
 * Longitude degrees shrink towards the poles, so the cell width in degrees is
 * derived from the latitude of the study area rather than assumed square.
 */
export function areaGrid(
  population: Population, size: number, householdRents: (number | null)[] | null = null,
): AreaGrid {
  const cacheKey = size * 2 + (householdRents ? 1 : 0);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const a = population.a;
  const latSpan = size / METRES_PER_DEGREE_LAT;
  // One reference latitude for the whole grid keeps cells aligned; over a 5 km
  // study area the cosine varies by less than a thousandth.
  const reference = a.building_lat.length ? a.building_lat[0] : 40.6;
  const lonSpan = latSpan / Math.cos((reference * Math.PI) / 180);
  const areaKm2 = (size / 1000) ** 2;

  const byKey = new Map<number, AreaCell>();
  const cellFor = (lat: number, lon: number): AreaCell => {
    const row = Math.floor(lat / latSpan);
    const col = Math.floor(lon / lonSpan);
    const key = row * 1_000_003 + col;
    let cell = byKey.get(key);
    if (!cell) {
      cell = {
        key, row, col,
        south: row * latSpan, north: (row + 1) * latSpan,
        west: col * lonSpan, east: (col + 1) * lonSpan,
        households: 0, people: 0, quarters: 0, ageSum: 0,
        under18: 0, over64: 0, employed: 0, workingAge: 0,
        incomes: [], medianIncome: NaN, rents: [], medianRent: NaN, areaKm2,
      };
      byKey.set(key, cell);
    }
    return cell;
  };

  const tally = (cell: AreaCell, age: number, employment: number) => {
    cell.people += 1;
    cell.ageSum += age;
    if (age < 18) cell.under18 += 1;
    else if (age > 64) cell.over64 += 1;
    if (age >= 16 && age <= 64) {
      cell.workingAge += 1;
      // 1 and 2 are "at work" and "employed but absent"; 4 and 5 are the
      // armed-forces equivalents. All four are people with a job.
      if (employment === 1 || employment === 2 || employment === 4 || employment === 5) {
        cell.employed += 1;
      }
    }
  };

  const householdBuilding = a.household_building;
  const offsets = a.household_person;
  for (let h = 0; h < householdBuilding.length; h += 1) {
    const building = householdBuilding[h];
    const cell = cellFor(a.building_lat[building], a.building_lon[building]);
    cell.households += 1;
    cell.incomes.push(a.household_income[h]);
    const rent = householdRents?.[h];
    if (rent != null && rent > 0) cell.rents.push(rent);
    for (let p = offsets[h]; p < offsets[h + 1]; p += 1) {
      tally(cell, a.person_age[p], a.person_employment[p]);
    }
  }

  // Group quarters hold real residents — a campus dormitory is not an empty
  // block — so they count towards people, age and employment, but not towards
  // household income or household size.
  const quartersBuilding = a.quarters_building;
  for (let q = 0; q < quartersBuilding.length; q += 1) {
    const building = quartersBuilding[q];
    const cell = cellFor(a.building_lat[building], a.building_lon[building]);
    cell.quarters += 1;
    tally(cell, a.quarters_age[q], a.quarters_employment[q]);
  }

  const cells = [...byKey.values()];
  for (const cell of cells) {
    cell.medianIncome = median(cell.incomes);
    cell.medianRent = median(cell.rents);
  }

  const grid: AreaGrid = {
    size,
    cells,
    byKey,
    totals: {
      cells: cells.length,
      households: householdBuilding.length,
      people: cells.reduce((sum, cell) => sum + cell.people, 0),
    },
  };
  cache.set(cacheKey, grid);
  return grid;
}

export interface Scale {
  min: number;
  max: number;
  /** 0–1, clipped. NaN in, NaN out. */
  normalise: (value: number) => number;
}

/**
 * The colour domain for a metric, clipped to the 2nd–98th percentile.
 *
 * A single tower block would otherwise own the whole ramp and flatten every
 * other cell to the lightest step.
 */
export function metricScale(grid: AreaGrid, metric: Metric): Scale {
  const values: number[] = [];
  for (const cell of grid.cells) {
    const value = metric.value(cell);
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  const min = values.length ? values[Math.floor(values.length * 0.02)] : 0;
  const max = values.length ? values[Math.ceil(values.length * 0.98) - 1] : 1;
  const span = max - min || 1;
  return {
    min,
    max,
    normalise: (value) =>
      Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / span)) : NaN,
  };
}

/**
 * Sequential blue, light → dark: one hue for magnitude, per the house palette.
 * The lightest step is allowed to recede towards the map surface.
 */
export const SEQUENTIAL = [
  "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b",
];

export function rampColor(t: number): string {
  if (!Number.isFinite(t)) return "transparent";
  const index = Math.min(SEQUENTIAL.length - 1, Math.floor(t * SEQUENTIAL.length));
  return SEQUENTIAL[index];
}

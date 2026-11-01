import type { Population } from "./population";
import { EMPLOYMENT, RACE_LABEL } from "./population";

/** Whole-population distributions, computed in one pass over the columns. */

export interface Band {
  label: string;
  value: number;
}

export interface Summary {
  people: number;
  households: number;
  quarters: number;
  buildings: number;
  dwellingBuildings: number;
  averageHouseholdSize: number;
  medianHouseholdIncome: number;
  medianAge: number;
  pyramid: { band: string; male: number; female: number }[];
  sizes: Band[];
  incomes: Band[];
  races: Band[];
  employment: Band[];
  tenureNote: string;
}

const AGE_BANDS = [
  [0, 9], [10, 19], [20, 29], [30, 39], [40, 49],
  [50, 59], [60, 69], [70, 79], [80, 200],
] as const;

const INCOME_BANDS = [
  [-Infinity, 0, "loss or none"],
  [0, 25_000, "under $25k"],
  [25_000, 50_000, "$25–50k"],
  [50_000, 75_000, "$50–75k"],
  [75_000, 100_000, "$75–100k"],
  [100_000, 150_000, "$100–150k"],
  [150_000, 200_000, "$150–200k"],
  [200_000, Infinity, "$200k+"],
] as const;

function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarise(population: Population): Summary {
  const a = population.a;
  const counts = population.counts;

  const pyramid = AGE_BANDS.map(([low, high]) => ({
    band: high > 100 ? `${low}+` : `${low}–${high}`,
    male: 0,
    female: 0,
  }));
  const bandOf = (age: number) =>
    Math.min(pyramid.length - 1, Math.floor(age / 10));

  const races = new Map<string, number>();
  const employment = new Map<string, number>();
  const ages: number[] = [];

  const tally = (prefix: "person" | "quarters", index: number) => {
    const age = a[`${prefix}_age`][index];
    ages.push(age);
    const slot = pyramid[bandOf(age)];
    if (a[`${prefix}_sex`][index] === 1) slot.male += 1;
    else slot.female += 1;

    const race = population.strings.race[a[`${prefix}_race`][index]];
    races.set(race, (races.get(race) ?? 0) + 1);

    if (age >= 16) {
      const label = EMPLOYMENT[a[`${prefix}_employment`][index]] ?? "unknown";
      employment.set(label, (employment.get(label) ?? 0) + 1);
    }
  };

  for (let p = 0; p < a.person_age.length; p += 1) tally("person", p);
  for (let q = 0; q < a.quarters_age.length; q += 1) tally("quarters", q);

  // Sizes past six are a long thin tail, so they share a row.
  const sizes = new Map<number, number>();
  for (const size of a.household_size) {
    const bucket = Math.min(size, 7);
    sizes.set(bucket, (sizes.get(bucket) ?? 0) + 1);
  }

  const incomes = INCOME_BANDS.map(([, , label]) => ({ label, value: 0 }));
  for (const income of a.household_income) {
    const index = INCOME_BANDS.findIndex(([low, high]) => income >= low && income < high);
    incomes[index === -1 ? incomes.length - 1 : index].value += 1;
  }

  const people = counts.persons + counts.quarters;
  return {
    people,
    households: counts.households,
    quarters: counts.quarters,
    buildings: counts.buildings,
    dwellingBuildings: counts.dwellingBuildings,
    averageHouseholdSize: counts.persons / counts.households,
    medianHouseholdIncome: median(a.household_income),
    medianAge: median(ages),
    pyramid,
    sizes: [...sizes.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([size, value]) => ({
        label: size >= 7 ? "7 or more" : `${size} ${size === 1 ? "person" : "people"}`,
        value,
      })),
    incomes,
    races: [...races.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([race, value]) => ({ label: RACE_LABEL[race] ?? race, value })),
    employment: [...employment.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([label, value]) => ({ label, value })),
    tenureNote: `${population.meta.source} · seed ${population.meta.seed}`,
  };
}

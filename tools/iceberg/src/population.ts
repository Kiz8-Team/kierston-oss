/**
 * population.bin, with the joins the rest of iceberg asks it for.
 *
 * The packed population numbers people twice over: household members are
 * 0..persons and group-quarters residents continue from there, which is the
 * numbering every other file — employment, vehicles, ties, the day plans —
 * refers to a person by. So this class exposes both the columns as they are
 * packed and a `resident` view over the pair, because a question like "what
 * share of 30-year-olds own a car" is asked against resident ids and would
 * otherwise silently drop the five thousand people living in dorms and homes.
 *
 * The two indexes it precomputes — person to household, building to household
 * count — are the ones every cross-tab needs. Both are one pass and a few
 * hundred kilobytes; doing either lazily per lookup would turn a cross-tab
 * into a scan of the whole city.
 */

import { columns, strings, type Envelope, type TypedArray } from "./format.ts";

export const SEX: Record<number, string> = { 1: "male", 2: "female" };

export const RELATIONSHIP: Record<number, string> = {
  20: "householder", 21: "spouse", 22: "unmarried partner",
  23: "spouse", 24: "unmarried partner", 25: "child", 26: "adopted child",
  27: "stepchild", 28: "sibling", 29: "parent", 30: "grandchild",
  31: "parent-in-law", 32: "child-in-law", 33: "other relative",
  34: "roommate", 35: "foster child", 36: "other non-relative",
  37: "in group quarters", 38: "in group quarters",
};

export const EMPLOYMENT: Record<number, string> = {
  1: "employed", 2: "employed, absent", 3: "unemployed",
  4: "armed forces", 5: "armed forces, absent", 6: "not in labour force",
};

export function education(code: number): string {
  if (code <= 1) return "no schooling";
  if (code < 16) return "some schooling";
  return {
    16: "high school", 17: "GED", 18: "some college", 19: "some college",
    20: "associate's", 21: "bachelor's", 22: "master's",
    23: "professional degree", 24: "doctorate",
  }[code] ?? "unknown";
}

/** The 23 SOC major groups, which is the useful grain for an occupation mix. */
export const SOC_MAJOR: Record<string, string> = {
  "11": "management", "13": "business & financial", "15": "computing & maths",
  "17": "architecture & engineering", "19": "life & social science",
  "21": "community & social service", "23": "legal", "25": "education",
  "27": "arts & media", "29": "healthcare practitioners", "31": "healthcare support",
  "33": "protective service", "35": "food preparation & serving", "37": "cleaning & grounds",
  "39": "personal care", "41": "sales", "43": "office & admin", "45": "farming & forestry",
  "47": "construction & extraction", "49": "installation & repair", "51": "production",
  "53": "transport & material moving", "55": "military",
};

export class Population {
  readonly meta: any;
  readonly counts: { buildings: number; dwellingBuildings: number; households: number; persons: number; quarters: number };
  readonly a: Record<string, TypedArray>;
  readonly s: Record<string, string[]>;
  /** persons + quarters — the id space everything else in sim_data uses. */
  readonly residents: number;
  /** Household of each household member; quarters residents have none. */
  readonly householdOf: Int32Array;
  readonly householdsInBuilding: Uint16Array;
  readonly residentsInBuilding: Uint32Array;

  constructor(env: Envelope) {
    this.meta = env.meta;
    this.counts = env.meta.counts;
    this.a = columns(env);
    this.s = {};
    for (const name of env.meta.stringTables) this.s[name] = strings(this.a, name);
    this.residents = this.counts.persons + this.counts.quarters;

    const offsets = this.a.household_person as Uint32Array;
    this.householdOf = new Int32Array(this.counts.persons).fill(-1);
    for (let h = 0; h < this.counts.households; h += 1) {
      for (let p = offsets[h]; p < offsets[h + 1]; p += 1) this.householdOf[p] = h;
    }

    this.householdsInBuilding = new Uint16Array(this.counts.buildings);
    this.residentsInBuilding = new Uint32Array(this.counts.buildings);
    const building = this.a.household_building as Uint32Array;
    for (let h = 0; h < this.counts.households; h += 1) {
      this.householdsInBuilding[building[h]] += 1;
      this.residentsInBuilding[building[h]] += offsets[h + 1] - offsets[h];
    }
    const quarters = this.a.quarters_building as Uint32Array;
    for (let q = 0; q < this.counts.quarters; q += 1) this.residentsInBuilding[quarters[q]] += 1;
  }

  isQuarters(id: number): boolean { return id >= this.counts.persons; }

  /** One column's value for a resident id, whichever table they live in. */
  of(field: string, id: number): number {
    return this.isQuarters(id)
      ? this.a[`quarters_${field}`][id - this.counts.persons]
      : this.a[`person_${field}`][id];
  }

  age(id: number): number { return this.of("age", id); }
  sex(id: number): string { return SEX[this.of("sex", id)] ?? "—"; }
  race(id: number): string { return this.s.race[this.of("race", id)]; }
  income(id: number): number { return this.of("income", id); }
  employment(id: number): string { return EMPLOYMENT[this.of("employment", id)] ?? "—"; }
  education(id: number): string { return education(this.of("education", id)); }

  socMajor(id: number): string | null {
    const code = this.s.soc[this.of("soc", id)];
    if (!code) return null;
    return SOC_MAJOR[code.slice(0, 2)] ?? `soc ${code.slice(0, 2)}`;
  }

  building(id: number): number {
    return this.isQuarters(id)
      ? (this.a.quarters_building as Uint32Array)[id - this.counts.persons]
      : (this.a.household_building as Uint32Array)[this.householdOf[id]];
  }

  household(id: number): number {
    return this.isQuarters(id) ? -1 : this.householdOf[id];
  }

  /** The members of one household, as resident ids. */
  members(household: number): [number, number] {
    const offsets = this.a.household_person as Uint32Array;
    return [offsets[household], offsets[household + 1]];
  }

  /** "West Cumberland Street" out of "520 West Cumberland Street, Allentown…". */
  street(building: number): string {
    const address = this.s.address[(this.a.building_address as Uint32Array)[building]];
    const first = address.split(",")[0] ?? "";
    return first.replace(/^\d+[A-Za-z]?\s+/, "").trim() || "—";
  }

  postcode(building: number): string {
    const address = this.s.address[(this.a.building_address as Uint32Array)[building]];
    return address.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? "—";
  }

  buildingKind(building: number): string {
    return this.s.kind[(this.a.building_kind as Uint8Array)[building]];
  }
}

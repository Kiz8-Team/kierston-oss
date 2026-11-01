/**
 * Reader for sim_data/population.bin — the packed synthetic population.
 *
 * A typed port of tools/lib/population.js, extended with the indexes the
 * browsers and the area analysis need. The file layout is written by
 * kierston/init/population/pack_population.py: magic, a JSON header describing every
 * column, then the columns as raw typed arrays.
 *
 * Nothing here copies or decodes per record. The typed arrays are views onto
 * the downloaded buffer, and a record only becomes an object when something
 * asks to display one — which is what lets a table scroll through 90,000
 * people without ever materialising them.
 */

const MAGIC = "KPOP";

const CONSTRUCTOR = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i32: Int32Array, f32: Float32Array, f64: Float64Array,
} as const;

type Kind = keyof typeof CONSTRUCTOR;
type Column = InstanceType<(typeof CONSTRUCTOR)[Kind]>;

const align8 = (value: number) => (value + 7) & ~7;

/** PUMS code books, kept here so every view labels people the same way. */
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

/** SCHL, collapsed to the milestones worth showing. Grades fold into one band. */
export function education(code: number): string {
  if (code <= 1) return "no schooling";
  if (code < 16) return "some schooling";
  return {
    16: "high school", 17: "GED", 18: "some college", 19: "some college",
    20: "associate's", 21: "bachelor's", 22: "master's",
    23: "professional degree", 24: "doctorate",
  }[code] ?? "unknown";
}

export const RACE_LABEL: Record<string, string> = {
  hispanic: "Hispanic (any race)", nh_white: "White", nh_black: "Black",
  nh_asian: "Asian", nh_two_or_more: "Two or more", nh_other: "Other",
};

export interface PopulationMeta {
  source: string;
  builtAt: string;
  seed: number;
  placementSeed: number | null;
  counts: {
    buildings: number;
    dwellingBuildings: number;
    households: number;
    persons: number;
    quarters: number;
  };
  stringTables: string[];
  arrays: { name: string; kind: Kind; length: number; byteOffset: number }[];
}

export interface BuildingRecord {
  index: number;
  id: string;
  address: string;
  kind: string;
  lat: number;
  lon: number;
  units: number;
}

export interface PersonRecord {
  index: number;
  age: number;
  sex: string;
  race: string;
  relationship: string;
  education: string;
  employment: string;
  income: number;
  occupation: string | null;
  industry: string | null;
  soc: string | null;
}

export interface HouseholdRecord {
  index: number;
  source: string;
  size: number;
  income: number;
  unit: number;
  area: number;
  building: BuildingRecord;
  members: PersonRecord[];
}

function readStrings(arrays: Record<string, Column>, name: string): string[] {
  const offsets = arrays[`${name}_offset`] as Uint32Array | undefined;
  const bytes = arrays[`${name}_bytes`] as Uint8Array | undefined;
  if (!offsets || !bytes) return [""];
  const decoder = new TextDecoder();
  // Index 0 is the empty string, so a column can use 0 for "not applicable".
  const out = [""];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

export function decodePopulation(buffer: ArrayBuffer): Population {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a population binary: python kierston/init/population/pack_population.py");
  }

  const headerLength = new DataView(buffer).getUint32(4, true);
  const meta: PopulationMeta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const dataStart = align8(8 + headerLength);

  const arrays: Record<string, Column> = {};
  for (const spec of meta.arrays) {
    arrays[spec.name] = new CONSTRUCTOR[spec.kind](
      buffer, dataStart + spec.byteOffset, spec.length);
  }

  const strings: Record<string, string[]> = {};
  for (const name of meta.stringTables) strings[name] = readStrings(arrays, name);

  return new Population(meta, arrays, strings, buffer.byteLength, headerLength);
}

export async function loadPopulation(url: string): Promise<Population> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return decodePopulation(await response.arrayBuffer());
}

export class Population {
  readonly meta: PopulationMeta;
  readonly counts: PopulationMeta["counts"];
  readonly a: Record<string, Column>;
  readonly strings: Record<string, string[]>;
  /** Size of the whole .bin as it came off the wire, for the file summary. */
  readonly bytes: number;
  /** Size of the JSON header between the magic and the first column. */
  readonly headerBytes: number;
  private _byBuilding: Map<number, number[]> | null = null;
  private _byOsmId: Map<string, number> | null = null;

  constructor(
    meta: PopulationMeta,
    arrays: Record<string, Column>,
    strings: Record<string, string[]>,
    bytes = 0,
    headerBytes = 0,
  ) {
    this.meta = meta;
    this.counts = meta.counts;
    this.a = arrays;
    this.strings = strings;
    this.bytes = bytes;
    this.headerBytes = headerBytes;
  }

  /** Households living in each building, built on first use. */
  get householdsByBuilding(): Map<number, number[]> {
    if (!this._byBuilding) {
      const map = new Map<number, number[]>();
      const building = this.a.household_building;
      for (let h = 0; h < building.length; h += 1) {
        const list = map.get(building[h]);
        if (list) list.push(h);
        else map.set(building[h], [h]);
      }
      this._byBuilding = map;
    }
    return this._byBuilding;
  }

  /** OSM id → building index, for joining against the map's building layer. */
  get buildingByOsmId(): Map<string, number> {
    if (!this._byOsmId) {
      const map = new Map<string, number>();
      const ids = this.a.building_id;
      for (let b = 0; b < ids.length; b += 1) map.set(this.strings.id[ids[b]], b);
      this._byOsmId = map;
    }
    return this._byOsmId;
  }

  building(index: number): BuildingRecord {
    return {
      index,
      id: this.strings.id[this.a.building_id[index]],
      address: this.strings.address[this.a.building_address[index]],
      kind: this.strings.kind[this.a.building_kind[index]],
      lat: this.a.building_lat[index],
      lon: this.a.building_lon[index],
      units: this.a.building_units[index],
    };
  }

  household(index: number): HouseholdRecord {
    const start = this.a.household_person[index];
    const end = this.a.household_person[index + 1];
    const members: PersonRecord[] = [];
    for (let p = start; p < end; p += 1) members.push(this.person(p));
    return {
      index,
      source: this.strings.source[this.a.household_source[index]],
      size: this.a.household_size[index],
      income: this.a.household_income[index],
      unit: this.a.household_unit[index],
      area: this.a.household_area[index],
      building: this.building(this.a.household_building[index]),
      members,
    };
  }

  /** Read one person from any of the person-shaped column sets. */
  read(prefix: "person" | "quarters", index: number): PersonRecord {
    const a = this.a;
    return {
      index,
      age: a[`${prefix}_age`][index],
      sex: SEX[a[`${prefix}_sex`][index]] ?? "—",
      race: this.strings.race[a[`${prefix}_race`][index]],
      relationship: RELATIONSHIP[a[`${prefix}_relationship`][index]] ?? "—",
      education: education(a[`${prefix}_education`][index]),
      employment: EMPLOYMENT[a[`${prefix}_employment`][index]] ?? "—",
      income: a[`${prefix}_income`][index],
      occupation: this.strings.occupation[a[`${prefix}_occupation`][index]] || null,
      industry: this.strings.industry[a[`${prefix}_industry`][index]] || null,
      soc: this.strings.soc[a[`${prefix}_soc`][index]] || null,
    };
  }

  person(index: number): PersonRecord { return this.read("person", index); }
  quartersResident(index: number): PersonRecord { return this.read("quarters", index); }

  /**
   * Whether a resident id belongs to a group-quarters resident.
   *
   * population.json numbers everyone in one sequence — household members
   * first, then quarters — and employment.json refers to people by that
   * number. The packed columns keep the two apart, so anything joining on a
   * resident id has to split it back out.
   */
  isQuarters(id: number): boolean {
    return id >= this.counts.persons;
  }

  /** One person, addressed by the id the rest of the simulation uses. */
  resident(id: number): PersonRecord {
    return this.isQuarters(id)
      ? this.quartersResident(id - this.counts.persons)
      : this.person(id);
  }

  /** The building a resident sleeps in, quarters included. */
  residentBuilding(id: number): number {
    return this.isQuarters(id)
      ? this.a.quarters_building[id - this.counts.persons]
      : this.a.household_building[this.householdOfPerson(id)];
  }

  /** A resident's household, or -1 for someone living in group quarters. */
  residentHousehold(id: number): number {
    return this.isQuarters(id) ? -1 : this.householdOfPerson(id);
  }

  /**
   * The household a person belongs to.
   *
   * People are stored in household order behind an offset array, so this is a
   * binary search rather than a per-person household column.
   */
  householdOfPerson(person: number): number {
    const offsets = this.a.household_person;
    let low = 0;
    let high = offsets.length - 2;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (person < offsets[mid]) high = mid - 1;
      else if (person >= offsets[mid + 1]) low = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** Where a household lives, without materialising the household. */
  householdLatLon(index: number): [number, number] {
    const building = this.a.household_building[index];
    return [this.a.building_lat[building], this.a.building_lon[building]];
  }
}

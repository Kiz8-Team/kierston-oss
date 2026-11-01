/**
 * Reader for sim_data/population.bin — the packed synthetic population.
 *
 * Shared by the inspector and the map so both agree on what the columns mean.
 * The file layout is written by kierston/init/pack_population.py and matches
 * the pathfinder's graph binary: magic, a JSON header describing every column,
 * then the columns themselves as raw typed arrays.
 *
 * Nothing here copies or decodes per record. The typed arrays are views onto
 * the downloaded buffer, and a record only becomes an object when something
 * asks to display one.
 */

const MAGIC = "KPOP";

const CONSTRUCTOR = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i32: Int32Array, f32: Float32Array, f64: Float64Array,
};

const align8 = (value) => (value + 7) & ~7;

/** PUMS code books, kept here so both tools label people the same way. */
export const SEX = { 1: "male", 2: "female" };

export const RELATIONSHIP = {
  20: "householder", 21: "spouse", 22: "unmarried partner",
  23: "spouse", 24: "unmarried partner", 25: "child", 26: "adopted child",
  27: "stepchild", 28: "sibling", 29: "parent", 30: "grandchild",
  31: "parent-in-law", 32: "child-in-law", 33: "other relative",
  34: "roommate", 35: "foster child", 36: "other non-relative",
  37: "in group quarters", 38: "in group quarters",
};

export const EMPLOYMENT = {
  1: "employed", 2: "employed, absent", 3: "unemployed",
  4: "armed forces", 5: "armed forces, absent", 6: "not in labour force",
};

/** SCHL, collapsed to the milestones worth showing. Grades fold into one band. */
export function education(code) {
  if (code <= 1) return "no schooling";
  if (code < 16) return "some schooling";
  return {
    16: "high school", 17: "GED", 18: "some college", 19: "some college",
    20: "associate's", 21: "bachelor's", 22: "master's",
    23: "professional degree", 24: "doctorate",
  }[code] ?? "unknown";
}

export const RACE_LABEL = {
  hispanic: "Hispanic (any race)", nh_white: "White", nh_black: "Black",
  nh_asian: "Asian", nh_two_or_more: "Two or more", nh_other: "Other",
};

function readStrings(arrays, name) {
  const offsets = arrays[`${name}_offset`];
  const bytes = arrays[`${name}_bytes`];
  if (!offsets || !bytes) return [""];
  const decoder = new TextDecoder();
  // Index 0 is the empty string, so a column can use 0 for "not applicable".
  const out = [""];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

export function decodePopulation(buffer) {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a population binary; run init/pack_population.py");
  }

  const headerLength = new DataView(buffer).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const dataStart = align8(8 + headerLength);

  const arrays = {};
  for (const spec of meta.arrays) {
    arrays[spec.name] = new CONSTRUCTOR[spec.kind](
      buffer, dataStart + spec.byteOffset, spec.length);
  }

  const strings = {};
  for (const name of meta.stringTables) strings[name] = readStrings(arrays, name);

  return new Population(meta, arrays, strings);
}

export async function loadPopulation(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return decodePopulation(await response.arrayBuffer());
}

export class Population {
  constructor(meta, arrays, strings) {
    this.meta = meta;
    this.counts = meta.counts;
    this.a = arrays;
    this.strings = strings;
    this._byBuilding = null;
    this._byOsmId = null;
  }

  /** Households living in each building, built on first use. */
  get householdsByBuilding() {
    if (!this._byBuilding) {
      const map = new Map();
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
  get buildingByOsmId() {
    if (!this._byOsmId) {
      const map = new Map();
      const ids = this.a.building_id;
      for (let b = 0; b < ids.length; b += 1) map.set(this.strings.id[ids[b]], b);
      this._byOsmId = map;
    }
    return this._byOsmId;
  }

  building(index) {
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

  household(index) {
    const start = this.a.household_person[index];
    const end = this.a.household_person[index + 1];
    const members = [];
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
  read(prefix, index) {
    const a = this.a;
    return {
      index,
      age: a[`${prefix}_age`][index],
      sex: SEX[a[`${prefix}_sex`][index]],
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

  person(index) { return this.read("person", index); }
  quartersResident(index) { return this.read("quarters", index); }
}

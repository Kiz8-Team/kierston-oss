/**
 * The static truth registers, read straight from `kierston/sim_data`.
 *
 * These are the files the simulation itself was built from, so they are the
 * ground truth for everything that does not change within a day: who lives
 * with whom, who is kin to whom, who works where, who owns what. KDI shows
 * an agent a processed slice of the same facts; the generators read the
 * originals so the recorded answer is the simulator's own.
 *
 * Every load is lazy and cached — a generator run touches only the files its
 * families need, and `population.json` alone is fifty megabytes.
 */

import { join } from "node:path";
import { PlaceBook, foldPlaceText } from "./places.ts";

// ---------------------------------------------------------------------------
// Record shapes, narrowed to the fields the generators read.
// ---------------------------------------------------------------------------

export interface HouseholdRecord {
  id: number;
  size: number;
  income: number;
  dwelling: string;
  unit: number;
}

export interface PersonRecord {
  id: number;
  household: number;
  age: number;
  sex: number;
  occupation: string | null;
  soc: string | null;
  employment: number | null;
}

export interface Population {
  household_records: HouseholdRecord[];
  person_records: PersonRecord[];
}

export interface ParentLink {
  id: number;
  role: "mother" | "father";
  kind: string;
}

export interface Kinship {
  external_base: number;
  /** [a, b, "partner" | "spouse"] pairs. */
  partners: [number, number, string][];
  /** Child person id -> that child's parents. */
  parents: Record<string, ParentLink[]>;
}

export interface Dwelling {
  id: string;
  lat: number;
  lon: number;
  kind: string;
  address: string;
  units: number;
}

export interface Dwellings {
  dwellings: Dwelling[];
}

export interface EnrollmentAssignment {
  person: number;
  band: string;
  grade: string;
  sector: string;
  school: string;
  mode: string;
  depart: number;
  arrive: number;
}

export interface Enrollment {
  assignments: EnrollmentAssignment[];
}

export interface EmploymentShift {
  watch: string;
  start: number;
  end: number;
  rota?: { kind: string; on: number; off: number; rest: number[] };
}

export interface EmploymentAssignment {
  person: number;
  role: string | null;
  class: string;
  occupation: string | null;
  site: string | null;
  mode: string;
  duty?: string | null;
  shift?: EmploymentShift | null;
}

export interface Employment {
  assignments: EmploymentAssignment[];
}

export interface AffiliationRecord {
  person: number;
  org: string;
  class: string;
  role: string;
  since: number;
}

export interface Affiliations {
  affiliation_records: AffiliationRecord[];
}

export interface OrgRecord {
  id: string;
  class: string;
  subclass?: string;
  name: string;
  lat: number;
  lon: number;
}

export interface SiteRecord {
  id: string;
  name?: string | null;
  address?: string | null;
}

export interface Workplaces {
  site_records: SiteRecord[];
}

export interface Orgs {
  org_records: OrgRecord[];
}

export interface SchoolRecord {
  id: string;
  lat: number;
  lon: number;
  name: string;
  bands: string[];
  sector?: string;
}

export interface Schools {
  school_records: SchoolRecord[];
}

export interface SchoolRider {
  person: number;
  band: string;
  school: string;
  /** Travel mode to and from school: "walk", "drive", "bus", ... */
  am: string | null;
  pm: string | null;
  /** The nominated escort's person id, where one exists. */
  escort_am: number | null;
  escort_pm: number | null;
}

export interface SchoolTravel {
  riders: SchoolRider[];
}

export interface VehicleRecord {
  vin: string;
  owner: number;
  owner_type: string;
  household: number | null;
  make: string;
  model: string;
  body: string;
  model_year: number;
  colour: string;
  plate: string;
  plate_type: string;
}

export interface Vehicles {
  vehicles: Record<string, VehicleRecord>;
}

export interface Subscription {
  user: number;
  primary: boolean;
  msisdn: string;
  imsi: string;
  carrier: string;
  account_holder: number;
  handset: string;
}

export interface Devices {
  /** Person id (as a string key) -> that person's subscriptions. */
  subscriptions: Record<string, Subscription[]>;
}

export interface AccountRecord {
  channel: string;
  handle: string;
  display_name: string;
  line: string | null;
  created: number;
}

export interface Accounts {
  /** Person id (as a string key) -> that person's messaging accounts. */
  account_records: Record<string, AccountRecord[]>;
}

// ---------------------------------------------------------------------------
// The tie graph, read raw. Rates are the runtime's derivation; the benchmark
// wants the underlying columns — kind, focus, affinity, valence — as written.
// ---------------------------------------------------------------------------

export interface TieEdges {
  kinds: readonly string[];
  foci: readonly string[];
  externalBase: number;
  count: number;
  a: Int32Array;
  b: Int32Array;
  kind: Uint8Array;
  focus: Uint16Array;
  /** 0..255. */
  affinity: Uint8Array;
  /** 0..255. */
  exposure: Uint8Array;
  /** Negative for an estrangement. */
  valence: Int8Array;
}

interface KtieHeader {
  edges: number;
  kinds: string[];
  foci: string[];
  external_base: number;
  columns: { name: string; dtype: string }[];
}

function tieView(dtype: string, bytes: ArrayBuffer): ArrayBufferView {
  const kind = dtype[1];
  const width = Number(dtype.slice(-1));
  if (kind === "i" && width === 4) return new Int32Array(bytes);
  if (kind === "u" && width === 4) return new Uint32Array(bytes);
  if (kind === "u" && width === 2) return new Uint16Array(bytes);
  if (kind === "i" && width === 1) return new Int8Array(bytes);
  if (kind === "u" && width === 1) return new Uint8Array(bytes);
  throw new Error(`ties.bin has a column of unsupported dtype ${dtype}`);
}

async function readTies(path: string): Promise<TieEdges> {
  const blob = new Uint8Array(await Bun.file(path).arrayBuffer());
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (String.fromCharCode(...blob.subarray(0, 4)) !== "KTIE") {
    throw new Error(`${path} is not a KTIE file`);
  }
  const length = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + length))) as KtieHeader;
  let offset = 8 + length;
  offset += (-offset % 8 + 8) % 8;

  const columns = new Map<string, ArrayBufferView>();
  for (const column of header.columns) {
    const width = Number(column.dtype.slice(-1));
    const bytes = blob.buffer.slice(blob.byteOffset + offset, blob.byteOffset + offset + width * header.edges);
    columns.set(column.name, tieView(column.dtype, bytes));
    offset += width * header.edges;
  }

  return {
    kinds: header.kinds,
    foci: header.foci,
    externalBase: header.external_base,
    count: header.edges,
    a: columns.get("a") as Int32Array,
    b: columns.get("b") as Int32Array,
    kind: columns.get("kind") as Uint8Array,
    focus: columns.get("focus") as Uint16Array,
    affinity: columns.get("affinity") as Uint8Array,
    exposure: columns.get("exposure") as Uint8Array,
    valence: columns.get("valence") as Int8Array,
  };
}

// ---------------------------------------------------------------------------

/** How far a charge may sit from the point of interest that raised it. */
const VENUE_MATCH_METRES = 75;

export class World {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(readonly simDataDir: string) {}

  private load<T>(file: string, reader?: (path: string) => Promise<T>): Promise<T> {
    const cached = this.cache.get(file);
    if (cached) return cached as Promise<T>;
    const path = join(this.simDataDir, file);
    const loading = reader ? reader(path) : (Bun.file(path).json() as Promise<T>);
    this.cache.set(file, loading);
    return loading;
  }

  /**
   * The IANA zone the city keeps: `CITY_TIME_ZONE` when set, else the
   * `time_zone` init's `locale` stage published to `city.json`. No default,
   * as in Fastgate: a guessed zone shifts every cutoff by hours.
   */
  async timeZone(): Promise<string> {
    const override = process.env.CITY_TIME_ZONE?.trim();
    if (override) return override;
    const zone = (await this.load<{ time_zone?: unknown }>("city.json")).time_zone;
    if (typeof zone !== "string" || !zone) {
      throw new Error(`no time_zone in ${join(this.simDataDir, "city.json")}; set CITY_TIME_ZONE, or publish it with \`kierston/.venv/bin/python kierston/init/init_sim.py --only locale\``);
    }
    return zone;
  }

  async placeName(reference: string | null): Promise<string> {
    if (!reference) throw new Error("venue has no observable reference");
    const key = reference.replace(/^v:/, "");
    const records = [
      ...(await this.orgs()).org_records,
      ...(await this.schools()).school_records,
      ...(await this.load<{ site_records: { id: string; name?: string; address?: string }[] }>("workplaces.json")).site_records,
    ];
    const found = records.find((record) => record.id.replace(/^v:/, "") === key);
    const name = found?.name || (found && "address" in found ? found.address : undefined);
    if (typeof name === "string" && name.trim()) return name;
    if (!/^(?:v:)?(?:way|node|relation)\//.test(reference)) return reference;
    throw new Error(`venue ${reference} has no name or address to use as an observable clue`);
  }

  async personSsn(person: number): Promise<string> {
    const data = await this.load<{ identities: Record<string, { taxpayer_id?: string }> }>("identity.json");
    const ssn = data.identities[String(person)]?.taxpayer_id;
    if (!ssn || !/^\d{3}-\d{2}-\d{4}$/.test(ssn)) throw new Error(`person ${person} has no usable SSN`);
    return ssn;
  }

  /** What a 911 operator has on a caller: full name, date of birth, and the number of the line they rang from. */
  async callerIdentity(person: number): Promise<{ name: string; dob: string; phone: string }> {
    type Identity = { first_name?: string; middle_name?: string | null; surname?: string; birth_date?: string };
    const identity = (await this.load<{ identities: Record<string, Identity> }>("identity.json")).identities[String(person)];
    const name = [identity?.first_name, identity?.middle_name, identity?.surname].filter((part) => part?.trim()).join(" ");
    if (!identity?.first_name || !identity.surname) throw new Error(`person ${person} has no usable name`);
    if (!identity.birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(identity.birth_date)) throw new Error(`person ${person} has no usable date of birth`);
    const lines = (await this.devices()).subscriptions[String(person)] ?? [];
    const line = lines.find((subscription) => subscription.primary) ?? lines[0];
    if (!line) throw new Error(`person ${person} has no phone line to call from`);
    return { name, dob: identity.birth_date, phone: line.msisdn };
  }

  /** Every named or addressed place the registers hold, indexed the way the scorer reads an answer. */
  places(): Promise<PlaceBook> {
    const cached = this.cache.get("#places");
    if (cached) return cached as Promise<PlaceBook>;
    const building = (async () => {
      const book = new PlaceBook();
      for (const place of (await this.dwellings()).dwellings) book.add(place);
      for (const place of (await this.orgs()).org_records) book.add(place);
      for (const place of (await this.schools()).school_records) book.add(place);
      for (const place of (await this.workplaces()).site_records) book.add(place);
      return book;
    })();
    this.cache.set("#places", building);
    return building;
  }

  /**
   * The places a model can actually name. Its only gazetteer is the point of
   * interest search, so a place counts when some point's name, address, or
   * the two together resolve to it and to nothing else. A campus building
   * that carries no name of its own fails this even when the campus has one:
   * the name resolves to a different element, and the answer is marked wrong.
   */
  observablePlaces(): Promise<Set<string>> {
    const cached = this.cache.get("#observable");
    if (cached) return cached as Promise<Set<string>>;
    const building = (async () => {
      const book = await this.places();
      const points = (await this.load<{ points: [number, number, number, number, string, string, number][] }>("pois.json")).points;
      const seen = new Set<string>();
      for (const point of points) {
        const name = (point[4] ?? "").trim(), address = (point[5] ?? "").trim();
        for (const form of [name, address, name && address ? `${name}, ${address}` : ""]) {
          if (!form || /^(?:[a-z]:)?(?:way|node|relation)\/\d+$/i.test(form)) continue;
          const match = book.resolve(form);
          if (match.ids.length === 1) seen.add(match.ids[0]!);
        }
      }
      return seen;
    })();
    this.cache.set("#observable", building);
    return building;
  }

  /** Whether `observablePlaces` holds this reference, whatever prefix it carries. */
  async observable(reference: string): Promise<boolean> {
    return (await this.observablePlaces()).has((await this.places()).same(reference));
  }

  /**
   * What a shop or restaurant can be called in an answer: the point of
   * interest of that name at those coordinates, with every string that
   * denotes it and no other. Null when no such point exists, or when it
   * shares both its name and its address and so cannot be written down.
   */
  async venueText(name: string | null, lat: number, lon: number): Promise<{ name: string; address: string; accepted: string[] } | null> {
    if (!name) return null;
    const points = (await this.load<{ points: [number, number, number, number, string, string, number][] }>("pois.json")).points;
    const names = new Map<string, number>(), addresses = new Map<string, number>(), pairs = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string) => { if (key) map.set(key, (map.get(key) ?? 0) + 1); };
    for (const point of points) {
      bump(names, foldPlaceText(point[4] ?? ""));
      bump(addresses, foldPlaceText(point[5] ?? ""));
      bump(pairs, foldPlaceText(`${point[4] ?? ""}, ${point[5] ?? ""}`));
    }
    const folded = foldPlaceText(name);
    let best: (typeof points)[number] | null = null, bestMetres = VENUE_MATCH_METRES;
    for (const point of points) {
      if (foldPlaceText(point[4] ?? "") !== folded) continue;
      const metres = Math.hypot((point[0] - lat) * 111_320, (point[1] - lon) * 111_320 * Math.cos((lat * Math.PI) / 180));
      if (metres <= bestMetres) { best = point; bestMetres = metres; }
    }
    if (!best) return null;
    const address = (best[5] ?? "").trim();
    const accepted: string[] = [];
    if (names.get(folded) === 1) accepted.push(best[4]);
    if (address && addresses.get(foldPlaceText(address)) === 1) accepted.push(address);
    if (address && pairs.get(foldPlaceText(`${best[4]}, ${address}`)) === 1) accepted.push(`${best[4]}, ${address}`);
    return accepted.length === 0 ? null : { name: best[4], address, accepted };
  }

  population(): Promise<Population> {
    return this.load("population.json");
  }

  kinship(): Promise<Kinship> {
    return this.load("kinship.json");
  }

  dwellings(): Promise<Dwellings> {
    return this.load("dwellings.json");
  }

  enrollment(): Promise<Enrollment> {
    return this.load("enrollment.json");
  }

  employment(): Promise<Employment> {
    return this.load("employment.json");
  }

  affiliations(): Promise<Affiliations> {
    return this.load("affiliations.json");
  }

  orgs(): Promise<Orgs> {
    return this.load("orgs.json");
  }

  workplaces(): Promise<Workplaces> {
    return this.load("workplaces.json");
  }

  schools(): Promise<Schools> {
    return this.load("schools.json");
  }

  schoolTravel(): Promise<SchoolTravel> {
    return this.load("school_travel.json");
  }

  vehicles(): Promise<Vehicles> {
    return this.load("vehicles.json");
  }

  devices(): Promise<Devices> {
    return this.load("devices.json");
  }

  accounts(): Promise<Accounts> {
    return this.load("accounts.json");
  }

  ties(): Promise<TieEdges> {
    return this.load("ties.bin", readTies);
  }
}

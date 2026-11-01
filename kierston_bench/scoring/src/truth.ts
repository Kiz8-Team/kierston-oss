/**
 * Identifier resolution: what the agent wrote, turned into what the ground
 * truth is written in.
 *
 * A generator records its answer from the simulator's own tables, so the truth
 * side of a task says `{"person": 32823}` — an index into the population. An
 * agent never sees that number. It works through KDI, where the same person is
 * an SSN, a name and date of birth, a mobile number, an IMSI, a messenger
 * handle. Scoring an answer therefore starts by mapping every identifier the
 * agent could legitimately have used back onto the simulator's id.
 *
 * The maps are built lazily from the series' own truth snapshot, or from a
 * `kierston/sim_data` directory for a series built before snapshots, one file at a time, so
 * scoring a run of ranked-id families never opens the fifty-megabyte
 * population file that only the vehicle families need.
 *
 * Ambiguity is kept rather than hidden. "Maria Santos" may be four people; the
 * resolver returns all four and the caller decides, by policy, whether a name
 * that narrows to more than one person may score.
 */

import { identityName, parseIdentity } from "../../task_generators/src/identity.ts";
import { PlaceBook, canonicalPlace, type PlaceRecord } from "../../task_generators/src/places.ts";
import { join } from "node:path";
import { normalize } from "../../kdi/src/normalize.ts";
import { snapshotFile, type TruthSnapshot } from "./truth_snapshot.ts";

export type EntityKind = "person" | "household" | "place" | "vehicle" | "plate";

export interface Resolution {
  /** The value as the agent wrote it. */
  given: string;
  /** Every truth id the value could denote, canonical form, sorted. */
  ids: string[];
  /** Which index answered: `id`, `ssn`, `phone`, `imsi`, `handle`, `name`, `address`, `name+address`, `plate`, `vin`, `place`, or `unresolved`. */
  via: string;
  identityCredit?: number;
  candidateCount?: number;
}

/** How a resolution that names more than one entity is treated. */
export type AmbiguityPolicy = "strict" | "lenient";

interface IdentityRecord {
  first_name?: string | null;
  middle_name?: string | null;
  surname?: string | null;
  birth_date?: string | null;
  taxpayer_id?: string | null;
  /** `ssn`, `itin` or null. Only an SSN is the full identity; an ITIN holder or a person with neither has no stronger identity than name and date of birth. */
  taxpayer_id_kind?: string | null;
  mobile?: string | null;
  landline?: string | null;
}

interface SubscriptionRecord {
  msisdn?: string | null;
  imsi?: string | null;
}

interface AccountRecord {
  channel?: string | null;
  handle?: string | null;
}

export { canonicalPlace };

export function canonicalPlate(value: string): string {
  return normalize(value, "plate");
}

function canonicalName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function add(index: Map<string, Set<string>>, key: string, id: string): void {
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.add(id);
  else index.set(key, new Set([id]));
}

function lookup(index: Map<string, Set<string>>, key: string): string[] | null {
  const bucket = index.get(key);
  return bucket ? [...bucket].sort() : null;
}

export class TruthIndex {
  private readonly files = new Map<string, Promise<unknown>>();
  private persons?: Promise<PersonIndex>;
  private places?: Promise<PlaceIndex>;
  private vehicles?: Promise<VehicleIndex>;
  private households?: Promise<HouseholdIndex>;

  /** A sim_data directory, or the snapshot a series was built with (see truth_snapshot.ts). */
  constructor(readonly source: string | TruthSnapshot) {}

  /** A sim_data file, or null when it is not on disk; every miss degrades to id-only resolution. */
  private file<T>(name: string): Promise<T | null> {
    const cached = this.files.get(name);
    if (cached) return cached as Promise<T | null>;
    const source = this.source;
    const loading =
      typeof source === "string"
        ? Bun.file(join(source, name))
            .json()
            .then((value) => value as T)
            .catch(() => null)
        : Promise.resolve(snapshotFile(source, name) as T | null);
    this.files.set(name, loading);
    return loading;
  }

  private personIndex(): Promise<PersonIndex> {
    this.persons ??= buildPersonIndex(this);
    return this.persons;
  }

  private placeIndex(): Promise<PlaceIndex> {
    this.places ??= buildPlaceIndex(this);
    return this.places;
  }

  private vehicleIndex(): Promise<VehicleIndex> {
    this.vehicles ??= buildVehicleIndex(this);
    return this.vehicles;
  }

  private householdIndex(): Promise<HouseholdIndex> {
    this.households ??= buildHouseholdIndex(this);
    return this.households;
  }

  /** Exposed for the loaders below; each one reads only the files it needs. */
  read<T>(name: string): Promise<T | null> {
    return this.file<T>(name);
  }

  async resolve(kind: EntityKind, value: unknown): Promise<Resolution> {
    const given = typeof value === "string" ? value.trim() : String(value);
    if (given === "") return { given, ids: [], via: "unresolved" };
    switch (kind) {
      case "person":
        return (await this.personIndex()).resolve(given);
      case "household":
        return (await this.householdIndex()).resolve(given);
      case "place":
        return (await this.placeIndex()).resolve(given);
      case "vehicle":
        return (await this.vehicleIndex()).resolve(given);
      case "plate":
        return { given, ids: [canonicalPlate(given)], via: "plate" };
    }
  }

  async assertIdentityTargets(ids: ReadonlySet<string>): Promise<void> {
    const data = await this.read<{ identities?: Record<string, IdentityRecord> }>("identity.json");
    if (!data?.identities) throw new Error("identity.json is unavailable; cannot score identity claims");
    if ([...ids].some((id) => !Object.hasOwn(data.identities!, id))) {
      throw new Error("a target is missing from identity.json; cannot score identity claims");
    }
  }

  /** `credit` is the claim's tier and what a wrong claim costs; `earned` is what it pays when right. */
  async resolveIdentity(value: unknown): Promise<Resolution & { credit: number; earned: number; key: string }> {
    return (await this.personIndex()).identity(value);
  }

  /** Everyone in the household of the given person, for the hierarchical vehicle score. */
  async householdOf(person: string): Promise<{ household: string | null; members: string[] }> {
    return (await this.householdIndex()).of(person);
  }

  async membersOfHousehold(household: string): Promise<string[]> {
    return (await this.householdIndex()).members(household);
  }

  /** The registered keeper and household of one vehicle, by VIN or plate. */
  async vehicleOwner(value: string): Promise<{ vin: string | null; owner: string | null; household: string | null }> {
    return (await this.vehicleIndex()).owner(value);
  }
}

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

class PersonIndex {
  constructor(
    private readonly count: number,
    private readonly ssn: Map<string, Set<string>>,
    private readonly phone: Map<string, Set<string>>,
    private readonly imsi: Map<string, Set<string>>,
    private readonly handle: Map<string, Set<string>>,
    private readonly name: Map<string, Set<string>>,
    private readonly fullName: Map<string, Set<string>>,
    private readonly dob: Map<string, Set<string>>,
    /** People with no Social Security number, for whom name and date of birth is the most specific claim there is. */
    private readonly withoutSsn: Set<string>,
  ) {}

  identity(value: unknown): Resolution & { credit: number; earned: number; key: string } {
    const { claim, credit, valid, key } = parseIdentity(value);
    const given = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    const via = claim.ssn ? "ssn" : claim.dob ? "name-dob" : "name";
    const matches: string[][] = [];
    if (claim.ssn) matches.push(lookup(this.ssn, normalize(claim.ssn, "ssn")) ?? []);
    if (claim.name) matches.push(lookup(this.fullName, claim.name) ?? []);
    if (claim.dob) matches.push(lookup(this.dob, claim.dob) ?? []);
    const ids = valid && matches.length ? matches[0]!.filter((id) => matches.every((set) => set.includes(id))) : [];
    // Name and date of birth is the strongest identity a person without an SSN has, so it pays as an SSN would.
    const earned = via === "name-dob" && ids.length === 1 && this.withoutSsn.has(ids[0]!) ? 1 : credit;
    return { given, ids, via: valid ? via : "invalid-identity", credit, earned, key };
  }

  resolve(given: string): Resolution {
    const digits = given.replace(/[^0-9]/g, "");
    if (digits.length === 9) {
      const bySsn = lookup(this.ssn, normalize(given, "ssn"));
      if (bySsn) return { given, ids: bySsn, via: "ssn" };
    }
    if (/^p?-?\d+$/i.test(given.replace(/\s+/g, ""))) {
      const id = given.replace(/[^0-9]/g, "");
      if (this.count === 0 || Number(id) < this.count) return { given, ids: [id], via: "id" };
    }
    if (digits.length === 10 || digits.length === 11) {
      const byPhone = lookup(this.phone, normalize(given, "phone"));
      if (byPhone) return { given, ids: byPhone, via: "phone" };
    }
    if (digits.length >= 14) {
      const byImsi = lookup(this.imsi, digits);
      if (byImsi) return { given, ids: byImsi, via: "imsi" };
    }
    const byHandle = lookup(this.handle, given.trim().toLowerCase().replace(/^@/, ""));
    if (byHandle) return { given, ids: byHandle, via: "handle" };
    const byName = lookup(this.name, canonicalName(given));
    if (byName) return { given, ids: byName, via: "name" };
    // A bare number that fell outside the population is still an id attempt.
    if (/^\d+$/.test(given)) return { given, ids: [given], via: "id" };
    return { given, ids: [], via: "unresolved" };
  }
}

async function buildPersonIndex(truth: TruthIndex): Promise<PersonIndex> {
  const ssn = new Map<string, Set<string>>();
  const phone = new Map<string, Set<string>>();
  const imsi = new Map<string, Set<string>>();
  const handle = new Map<string, Set<string>>();
  const name = new Map<string, Set<string>>();

  const fullName = new Map<string, Set<string>>();
  const dob = new Map<string, Set<string>>();
  const withoutSsn = new Set<string>();
  const identity = await truth.read<{ identities?: Record<string, IdentityRecord> }>("identity.json");
  const identities = identity?.identities ?? {};
  for (const [person, record] of Object.entries(identities)) {
    if (record.taxpayer_id) add(ssn, normalize(record.taxpayer_id, "ssn"), person);
    // A record without the kind predates it and is taken as an SSN when it carries a number at all.
    if (!record.taxpayer_id || (record.taxpayer_id_kind ?? "ssn") !== "ssn") withoutSsn.add(person);
    if (record.mobile) add(phone, normalize(record.mobile, "phone"), person);
    if (record.landline) add(phone, normalize(record.landline, "phone"), person);
    const first = record.first_name ?? "";
    const last = record.surname ?? "";
    const middle = record.middle_name ?? "";
    if (record.birth_date) add(dob, record.birth_date, person);
    if (first && last) {
      add(fullName, identityName(`${first} ${last}`), person);
      if (middle) add(fullName, identityName(`${first} ${middle} ${last}`), person);
    }
    if (first || last) {
      add(name, canonicalName(`${first} ${last}`), person);
      add(name, canonicalName(`${last} ${first}`), person);
      if (middle) add(name, canonicalName(`${first} ${middle} ${last}`), person);
      if (record.birth_date) add(name, canonicalName(`${first} ${last} ${record.birth_date}`), person);
    }
  }

  const devices = await truth.read<{ subscriptions?: Record<string, SubscriptionRecord[]> }>("devices.json");
  for (const [person, subscriptions] of Object.entries(devices?.subscriptions ?? {})) {
    for (const subscription of subscriptions ?? []) {
      if (subscription.msisdn) add(phone, normalize(subscription.msisdn, "phone"), person);
      if (subscription.imsi) add(imsi, subscription.imsi.replace(/[^0-9]/g, ""), person);
    }
  }

  const accounts = await truth.read<{ account_records?: Record<string, AccountRecord[]> }>("accounts.json");
  for (const [person, records] of Object.entries(accounts?.account_records ?? {})) {
    for (const record of records ?? []) {
      if (!record.handle) continue;
      const bare = record.handle.trim().toLowerCase().replace(/^@/, "");
      add(handle, bare, person);
      if (record.channel) add(handle, `${record.channel.toLowerCase()}:${bare}`, person);
    }
  }

  return new PersonIndex(Object.keys(identities).length, ssn, phone, imsi, handle, name, fullName, dob, withoutSsn);
}

// ---------------------------------------------------------------------------
// Household — also the person -> household map the vehicle families need.
// ---------------------------------------------------------------------------

class HouseholdIndex {
  constructor(
    private readonly personToHousehold: Map<string, string>,
    private readonly householdToPersons: Map<string, string[]>,
  ) {}

  resolve(given: string): Resolution {
    const id = given.replace(/[^0-9]/g, "");
    if (id === "") return { given, ids: [], via: "unresolved" };
    return { given, ids: [id], via: "id" };
  }

  of(person: string): { household: string | null; members: string[] } {
    const household = this.personToHousehold.get(person) ?? null;
    return { household, members: household === null ? [] : (this.householdToPersons.get(household) ?? []) };
  }

  members(household: string): string[] {
    return this.householdToPersons.get(household) ?? [];
  }
}

async function buildHouseholdIndex(truth: TruthIndex): Promise<HouseholdIndex> {
  const personToHousehold = new Map<string, string>();
  const householdToPersons = new Map<string, string[]>();
  const population = await truth.read<{ person_records?: { id: number; household: number }[] }>("population.json");
  for (const record of population?.person_records ?? []) {
    if (record.household === null || record.household === undefined) continue;
    const person = String(record.id);
    const household = String(record.household);
    personToHousehold.set(person, household);
    const members = householdToPersons.get(household);
    if (members) members.push(person);
    else householdToPersons.set(household, [person]);
  }
  return new HouseholdIndex(personToHousehold, householdToPersons);
}

// ---------------------------------------------------------------------------
// Place — dwellings, workplaces, organizations and schools share one index,
// because a task's "site" or "venue" may be any of them and an agent has no
// reason to know which table the truth was taken from.
// ---------------------------------------------------------------------------

class PlaceIndex {
  constructor(private readonly book: PlaceBook) {}

  resolve(given: string): Resolution {
    return { given, ...this.book.resolve(given) };
  }
}

async function buildPlaceIndex(truth: TruthIndex): Promise<PlaceIndex> {
  const book = new PlaceBook();
  const dwellings = await truth.read<{ dwellings?: PlaceRecord[] }>("dwellings.json");
  for (const place of dwellings?.dwellings ?? []) book.add(place);
  const orgs = await truth.read<{ org_records?: PlaceRecord[] }>("orgs.json");
  for (const place of orgs?.org_records ?? []) book.add(place);
  const schools = await truth.read<{ school_records?: PlaceRecord[] }>("schools.json");
  for (const place of schools?.school_records ?? []) book.add(place);
  const workplaces = await truth.read<{ site_records?: PlaceRecord[] }>("workplaces.json");
  for (const place of workplaces?.site_records ?? []) book.add(place);
  return new PlaceIndex(book);
}

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------

interface VehicleRecord {
  vin: string;
  plate?: string | null;
  owner?: number | null;
  household?: number | null;
}

class VehicleIndex {
  constructor(
    private readonly byVin: Map<string, VehicleRecord>,
    private readonly byPlate: Map<string, Set<string>>,
  ) {}

  resolve(given: string): Resolution {
    const vin = given.trim().toUpperCase();
    if (this.byVin.has(vin)) return { given, ids: [vin], via: "vin" };
    const byPlate = lookup(this.byPlate, canonicalPlate(given));
    if (byPlate) return { given, ids: byPlate, via: "plate" };
    return { given, ids: [vin], via: "unresolved" };
  }

  owner(value: string): { vin: string | null; owner: string | null; household: string | null } {
    const resolved = this.resolve(value);
    const vin = resolved.ids[0] ?? null;
    const record = vin === null ? undefined : this.byVin.get(vin);
    return {
      vin,
      owner: record?.owner === null || record?.owner === undefined ? null : String(record.owner),
      household: record?.household === null || record?.household === undefined ? null : String(record.household),
    };
  }
}

async function buildVehicleIndex(truth: TruthIndex): Promise<VehicleIndex> {
  const byVin = new Map<string, VehicleRecord>();
  const byPlate = new Map<string, Set<string>>();
  const vehicles = await truth.read<{ vehicles?: Record<string, VehicleRecord> }>("vehicles.json");
  for (const record of Object.values(vehicles?.vehicles ?? {})) {
    if (!record?.vin) continue;
    const vin = record.vin.toUpperCase();
    byVin.set(vin, record);
    if (record.plate) add(byPlate, canonicalPlate(record.plate), vin);
  }
  return new VehicleIndex(byVin, byPlate);
}

/**
 * Whether a resolution counts as naming the truth.
 *
 * Under `strict`, an identifier that narrows to several people — a common
 * name, say — is not an answer; under `lenient` it counts when the truth is
 * among them, which is the right reading when a run is being triaged rather
 * than reported.
 */
export function resolvesTo(resolution: Resolution, truth: ReadonlySet<string>, policy: AmbiguityPolicy): boolean {
  if (resolution.ids.length === 0) return false;
  if (resolution.ids.length > 1 && policy === "strict") return false;
  return resolution.ids.some((id) => truth.has(id));
}

/** The single id a resolution settles on, or null when it names none or many. */
export function settledId(resolution: Resolution, policy: AmbiguityPolicy): string | null {
  if (resolution.ids.length === 1) return resolution.ids[0]!;
  if (resolution.ids.length > 1 && policy === "lenient") return resolution.ids[0]!;
  return null;
}

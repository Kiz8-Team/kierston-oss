/**
 * The registers a series is scored against, frozen into the series itself.
 *
 * A task's truth names simulator ids (`{"person": 14487}`), and an answer names
 * what KDI showed the agent: an SSN, a name and date of birth, a line, a plate,
 * a building. Joining the two needs the whole population's identifiers, because
 * a wrong claim must still resolve to someone else, to nobody, or to several
 * people. Read live from `kierston/sim_data`, that join follows whatever the
 * directory holds on the day of scoring, and a re-initialized population
 * re-keys every SSN and phone number a finished run was served.
 *
 * So the series carries a snapshot of exactly the fields `TruthIndex` reads,
 * taken when the series is built. Tables are columnar to keep the file small;
 * `snapshotFile` gives them back in the shapes of the sim_data files.
 */

import { basename, isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

type Cell = string | number | boolean | null;

interface Table {
  columns: string[];
  rows: Cell[][];
}

export interface TruthSnapshot {
  /**
   * The sim_data directory the snapshot was read from, relative to the
   * repository root (`kierston/sim_data`), or only its name when it lies
   * outside the repository; never an absolute host path. And when.
   */
  source: string;
  takenAt: string;
  identities: Table;
  subscriptions: Table;
  accounts: Table;
  households: Table;
  dwellings: Table;
  orgs: Table;
  schools: Table;
  workplaces: Table;
  vehicles: Table;
}

const IDENTITY = ["person", "first_name", "middle_name", "surname", "birth_date", "taxpayer_id", "taxpayer_id_kind", "mobile", "landline"];
const SUBSCRIPTION = ["person", "msisdn", "imsi"];
const ACCOUNT = ["person", "channel", "handle"];
const HOUSEHOLD = ["id", "household"];
const PLACE = ["id", "name", "address", "lat", "lon"];
const VEHICLE = ["key", "vin", "plate", "owner", "household"];

/**
 * A register value as a snapshot cell. Every column read here is a scalar in
 * sim_data; a nested value would come back from the snapshot as a string where
 * TruthIndex expects the object, so it is refused rather than flattened.
 */
function cell(value: unknown, column: string): Cell {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`truth snapshot: column ${column} holds a ${Array.isArray(value) ? "list" : typeof value}; truth_snapshot.ts snapshots scalars only`);
}

function table(columns: string[], records: Iterable<Record<string, unknown>>): Table {
  const rows: Cell[][] = [];
  for (const record of records) rows.push(columns.map((column) => cell(record[column], column)));
  return { columns, rows };
}

/** `kierston/sim_data` for the repository's own directory; a bare name for one elsewhere. */
export function snapshotSource(simDataDir: string): string {
  const path = relative(REPO_ROOT, resolve(simDataDir));
  return path === "" ? "." : path.startsWith("..") || isAbsolute(path) ? basename(resolve(simDataDir)) : path;
}

function* keyed<T>(byKey: Record<string, T[] | T> | undefined, key: string): Generator<Record<string, unknown>> {
  for (const [id, value] of Object.entries(byKey ?? {})) {
    for (const record of Array.isArray(value) ? value : [value]) yield { ...(record as Record<string, unknown>), [key]: id };
  }
}

/** Read the registers `TruthIndex` resolves against from a sim_data directory. */
export async function takeTruthSnapshot(simDataDir: string): Promise<TruthSnapshot> {
  const read = async <T>(name: string): Promise<T> => {
    const file = Bun.file(join(simDataDir, name));
    if (!(await file.exists())) throw new Error(`${join(simDataDir, name)} is missing; a series cannot be scored without it`);
    return (await file.json()) as T;
  };
  const identity = await read<{ identities?: Record<string, Record<string, unknown>> }>("identity.json");
  const devices = await read<{ subscriptions?: Record<string, Record<string, unknown>[]> }>("devices.json");
  const accounts = await read<{ account_records?: Record<string, Record<string, unknown>[]> }>("accounts.json");
  const population = await read<{ person_records?: Record<string, unknown>[] }>("population.json");
  const dwellings = await read<{ dwellings?: Record<string, unknown>[] }>("dwellings.json");
  const orgs = await read<{ org_records?: Record<string, unknown>[] }>("orgs.json");
  const schools = await read<{ school_records?: Record<string, unknown>[] }>("schools.json");
  const workplaces = await read<{ site_records?: Record<string, unknown>[] }>("workplaces.json");
  const vehicles = await read<{ vehicles?: Record<string, Record<string, unknown>> }>("vehicles.json");
  return {
    source: snapshotSource(simDataDir),
    takenAt: new Date().toISOString(),
    identities: table(IDENTITY, keyed(identity.identities, "person")),
    subscriptions: table(SUBSCRIPTION, keyed(devices.subscriptions, "person")),
    accounts: table(ACCOUNT, keyed(accounts.account_records, "person")),
    households: table(HOUSEHOLD, population.person_records ?? []),
    dwellings: table(PLACE, dwellings.dwellings ?? []),
    orgs: table(PLACE, orgs.org_records ?? []),
    schools: table(PLACE, schools.school_records ?? []),
    workplaces: table(PLACE, workplaces.site_records ?? []),
    vehicles: table(VEHICLE, keyed(vehicles.vehicles, "key")),
  };
}

function records({ columns, rows }: Table): Record<string, Cell>[] {
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])));
}

function grouped(rows: Record<string, Cell>[], key: string): Record<string, Record<string, Cell>[]> {
  const out: Record<string, Record<string, Cell>[]> = {};
  for (const { [key]: id, ...rest } of rows) (out[String(id)] ??= []).push(rest);
  return out;
}

const single = (rows: Record<string, Cell>[], key: string) =>
  Object.fromEntries(rows.map(({ [key]: id, ...rest }) => [String(id), rest]));

/** One sim_data file `TruthIndex` reads, rebuilt from the snapshot; null for a file it does not hold. */
export function snapshotFile(snapshot: TruthSnapshot, name: string): unknown {
  switch (name) {
    case "identity.json": return { identities: single(records(snapshot.identities), "person") };
    case "devices.json": return { subscriptions: grouped(records(snapshot.subscriptions), "person") };
    case "accounts.json": return { account_records: grouped(records(snapshot.accounts), "person") };
    case "population.json": return { person_records: records(snapshot.households) };
    case "dwellings.json": return { dwellings: records(snapshot.dwellings) };
    case "orgs.json": return { org_records: records(snapshot.orgs) };
    case "schools.json": return { school_records: records(snapshot.schools) };
    case "workplaces.json": return { site_records: records(snapshot.workplaces) };
    case "vehicles.json": return { vehicles: single(records(snapshot.vehicles), "key") };
    default: return null;
  }
}

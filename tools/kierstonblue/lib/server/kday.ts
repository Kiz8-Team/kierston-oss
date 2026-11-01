/**
 * The KDAY envelope, read once for every page that reads a packed day.
 *
 * `day.ts` reads a person's movement, money and radio out of these columns and
 * `comms.ts` reads their conversations and attention curve out of the same
 * file. Both need the same three things — the JSON header, a column by name,
 * and one typed value out of a buffer — so those live here rather than being
 * copied. A second implementation of the envelope is a second place for the
 * next version bump to be forgotten.
 *
 * Four magic bytes, a little-endian u32 header length, then 8-aligned typed
 * columns. Every version so far has been additive, so an old file still reads
 * and what it lacks it simply lacks: the counts in the header say which tables
 * are present, and the `banked`, `networked` and `messaged` flags say whether
 * an absent table means "not exported" or "nothing happened".
 */

import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { roots } from "./repo";

export const MAGIC = "KDAY";
/** No such string, in a u32 string-table reference. */
export const NONE = 0xffffffff;
/** The same absence in an enum byte. */
export const NONE_U8 = 0xff;
/** And in a signed coordinate column, where every real value is a microdegree. */
export const NONE_I32 = 0x7fffffff;
/** No serving cell, in a span, an event or a carrier record. */
export const NONE_CELL = -1;

export const align8 = (value: number) => (value + 7) & ~7;

export type TypeName = "u8" | "u32" | "i32" | "f32";

export interface ColumnSpec {
  name: string;
  type: TypeName;
  count: number;
  byteOffset: number;
  byteLength: number;
}

/**
 * The modelled capture and error rates a day's reads were drawn from.
 *
 * Carried in the header rather than looked up here: these are priors, not
 * measurements, and a viewer that quoted its own copy of them would keep
 * quoting it after the sim changed its mind.
 */
export interface AlprModel {
  version: number;
  source: string;
  lighting: Record<string, {
    capture: number; correct: number; misread: number; unreadable: number;
  }>;
  noPlateSpurious: Record<string, number>;
  headway: { belowSeconds: number; capture: number; error: number }[];
  dwell: { belowSeconds: number; capture: number; error: number }[];
  mutation: Record<string, number>;
}

/**
 * A checkpoint descriptor: where the packed KSTATE for one boundary of the day
 * sits in the file. Both boundaries have the same shape and differ only in
 * which edge of the day they describe.
 */
export interface StateSection {
  magic: "KSTATE";
  version: number;
  encoding: "gzip-json";
  boundary: "opening" | "closing";
  nextDate: string;
  digest: string;
  byteOffset: number;
  byteLength: number;
  rawByteLength: number;
}

/**
 * One instruction a scenario asked for, and what the engine actually made of
 * it.
 *
 * The declared half and the realized half are kept apart on purpose. A
 * scenario says "buy coffee at 12:10"; what lands in the day is a transaction
 * at a minute the replay chose, against a balance that may have declined it.
 * `result` is the second of those, and its `legs` and `transactions` are row
 * ids into the materialized day's own tables — the join that lets the viewer
 * show the produced rows rather than restating the request.
 */
export interface ScenarioAction {
  id: string;
  kind: string;
  result: {
    person: number;
    start: number;
    arrival: number;
    departure: number;
    destination?: string | null;
    recipient?: number | null;
    mode?: string | null;
    approved?: boolean;
    decline?: string | null;
    channel?: string | null;
    outcome?: string | null;
    legs?: number[];
    transactions?: number[];
    /** Index into the person's own transaction run, where the action spent. */
    transactionInPerson?: number;
  } | null;
}

/** Why a person is in the affected set: the role they played in each action. */
export interface ScenarioAffected {
  person: number;
  reasons: string[];
}

export interface ScenarioTruth {
  format: "KIERSTON_SCENARIO";
  version: number;
  name: string;
  scenarioVersion: number;
  seed: number;
  /** The scenario script itself, so a renamed file is still identifiable. */
  sourceHash: string;
  /** The base day this was replayed from, as a whole-file digest. */
  inputHash: string;
  provenance?: {
    city?: string;
    engine?: string;
    assets?: Record<string, string>;
  };
  isolation?: string;
  maxAffected?: number;
  /** Role name from the script to the resident it resolved to. */
  actors: Record<string, number>;
  /** Role name to a venue id, in the `v:way/…` form the graph uses. */
  places: Record<string, string>;
  affected: ScenarioAffected[];
  actions: ScenarioAction[];
}

export interface DayMeta {
  magic: string;
  version: number;
  date: string;
  day: number;
  initDigest: string | null;
  /**
   * Complete state before this date. Absent before version 11, and its absence
   * is what a v10 file fails scenario replay on: without an opening boundary
   * there is nothing to replay the day forward from. Read the field rather
   * than the version — see the KDIF reader in `kdif.ts`.
   */
  openingState?: StateSection | null;
  /** Complete state after this date, stored after the analytical columns. */
  closingState?: StateSection | null;
  /**
   * What the export was replayed against, where it was one. Version 11 records
   * the engine and asset digests so a day cannot be silently compared with one
   * generated from a different city.
   */
  replayProvenance?: {
    city?: string;
    engine?: string;
    assets?: Record<string, string>;
  } | null;
  /**
   * Present only in a materialized scenario day, never in a base export. This
   * is the ground truth a scenario wrote about itself: what it bound, what it
   * did, and who it touched. Evaluator instrumentation — the provider tables
   * are read exactly as they are in any other day and know nothing of it.
   */
  scenario?: ScenarioTruth | null;
  /** What `attention.level` is a fraction of. Absent before version 5. */
  attentionScale?: number;
  /**
   * The plate reader's priors, copied into the file so a read cannot outlive
   * the assumptions that generated it. Absent before version 8.
   */
  alprModel?: AlprModel;
  counts: {
    persons: number;
    schedules: number;
    legs: number;
    pathPoints: number;
    /** Both absent in a version 1 file, which predates the money. */
    transactions?: number;
    /** 1 where the export ran with a bank, so an empty ledger means empty. */
    banked?: number;
    /** All absent before version 3, which added the cellular network. */
    subscribers?: number;
    cells?: number;
    spans?: number;
    events?: number;
    /** The radio's counterpart to `banked`: 1 where a network was loaded. */
    networked?: number;
    /** All absent before version 4, which added the conversations. */
    accounts?: number;
    conversations?: number;
    messages?: number;
    calls?: number;
    smsRecords?: number;
    callRecords?: number;
    /** The same flag again, for the comms layer: 1 where one was loaded. */
    messaged?: number;
    /** Absent before version 5, which added the attention curves. */
    attentionRuns?: number;
    /**
     * Absent before version 6, which added the day's deliberate gatherings.
     * Unlike the tables above there is no flag beside them: a gathering is
     * planned by the scheduler rather than by an optional layer, so a v6 file
     * with no meetings is a city where nobody arranged anything.
     */
    meetings?: number;
    parties?: number;
    /**
     * All absent before version 8, which added the fixed plate readers. The
     * flag beside them is `surveilled`, and it answers the question the bank's
     * and the radio's flags answer: a day with no sited fleet is not a city
     * where no camera saw anything.
     */
    surveilled?: number;
    cameras?: number;
    /** Physical passes over a watched edge — the ground truth, not the log. */
    alprPasses?: number;
    /** Rows the sensor produced, null detections included. One per pass. */
    alprObservations?: number;
    /** Of those observations, how many carried any text at all. */
    alprReads?: number;
    alprCorrect?: number;
    alprMisread?: number;
    alprUnreadable?: number;
    alprNotCaptured?: number;
    alprNoPlate?: number;
    alprSpurious?: number;
    /** All absent before version 9, which added the traffic from outside. */
    trafficGateways?: number;
    externalVehicles?: number;
    recurringExternalVehicles?: number;
    oneOffExternalVehicles?: number;
    externalTrips?: number;
    trafficRoutes?: number;
    trafficPathPoints?: number;
    throughTrips?: number;
    stoppingTours?: number;
    /**
     * Both absent before version 12, which gave every registered vehicle its
     * own continuous day. There is no flag beside them: the register is part
     * of the world rather than an optional layer, so a v12 file with no
     * vehicle rows is a city where nothing is registered.
     */
    vehicles?: number;
    vehicleSpans?: number;
  };
  enums: {
    scheduleKind: string[];
    mode: string[];
    purpose: string[];
    txKind?: string[];
    reason?: string[];
    instrument?: string[];
    decline?: string[];
    /** All absent before version 3, alongside the cellular tables. */
    operator?: string[];
    radioLayer?: string[];
    radioTier?: string[];
    exposure?: string[];
    eventKind?: string[];
    eventCause?: string[];
    /** All absent before version 4, alongside the conversations. */
    channel?: string[];
    conversationKind?: string[];
    messageKind?: string[];
    callOutcome?: string[];
    /**
     * Not a fixed list: whatever `accounts.py` produced, in the order the
     * loader first saw them. `conversation.focus` is unreadable without it.
     */
    conversationFocus?: string[];
    /** Absent before version 6, alongside the gatherings. */
    meetingKind?: string[];
    partyRole?: string[];
    /** All absent before version 8, alongside the plate readers. */
    plateSide?: string[];
    lighting?: string[];
    alprOutcome?: string[];
    /**
     * Whether `alprTruth.movement` indexes a resident leg or an external trip.
     * Without it a movement id is two different keys sharing a column.
     */
    alprMovementSource?: string[];
    /** Both absent before version 9, alongside the traffic from outside. */
    externalVehicleKind?: string[];
    externalTripKind?: string[];
    /** All absent before version 12, alongside the vehicle timelines. */
    vehicleOwnerType?: string[];
    vehicleServiceClass?: string[];
    vehicleSpanKind?: string[];
  };
  strings: string[];
  columns: ColumnSpec[];
}

/** The versions this reader understands. Additive, so every one still reads. */
const VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

export async function readMeta(path: string): Promise<{ meta: DayMeta; dataStart: number }> {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, prefix.length, 0);
    if (prefix.toString("utf8", 0, 4) !== MAGIC) throw new Error(`${path} is not a KDAY file`);
    const length = prefix.readUInt32LE(4);
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 8);
    const meta = JSON.parse(header.toString("utf8")) as DayMeta;
    if (meta.magic !== MAGIC || !VERSIONS.includes(meta.version)) {
      throw new Error(`unsupported KDAY version ${meta.version ?? "unknown"}`);
    }
    if (meta.version >= 10 && (meta.closingState?.magic !== "KSTATE"
        || meta.closingState.boundary !== "closing")) {
      throw new Error(`KDAY v${meta.version} is missing its closing KSTATE`);
    }
    if (meta.version >= 11 && (meta.openingState?.magic !== "KSTATE"
        || meta.openingState.boundary !== "opening")) {
      throw new Error(`KDAY v${meta.version} is missing its opening KSTATE`);
    }
    return { meta, dataStart: align8(8 + length) };
  } finally {
    await handle.close();
  }
}

export async function dayPath(date: string): Promise<string | null> {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? join((await roots()).outputs, `day_${date}.bin`)
    : null;
}

/** The file's modification time, which is what every cache in here is keyed on. */
export async function dayMtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

export const widthOf = (type: TypeName): number => (type === "u8" ? 1 : 4);

export function value(buffer: Buffer, type: TypeName, index: number): number {
  const offset = index * widthOf(type);
  if (type === "u8") return buffer.readUInt8(offset);
  if (type === "u32") return buffer.readUInt32LE(offset);
  if (type === "i32") return buffer.readInt32LE(offset);
  return buffer.readFloatLE(offset);
}

/**
 * The columns of one open file, addressed by name.
 *
 * A thin wrapper rather than a class hierarchy: what every caller wants is a
 * slice of one column and a string out of the header, and both of those are
 * one line each once the header and the file handle are in the same place.
 */
export interface Reader {
  meta: DayMeta;
  has(name: string): boolean;
  spec(name: string): ColumnSpec;
  /** `count` rows of a column from `start`, as raw bytes. */
  slice(name: string, start: number, count: number): Promise<Buffer>;
  /** A whole column, for the passes that walk one end to end. */
  whole(name: string): Promise<Buffer>;
  /** One value, for the binary searches over the person table. */
  scalar(name: string, row: number): Promise<number>;
  /** A header string by id, or null for `NONE`. */
  string(id: number): string | null;
  close(): Promise<void>;
}

export async function openDay(path: string): Promise<Reader> {
  const { meta, dataStart } = await readMeta(path);
  const columns = new Map(meta.columns.map((column) => [column.name, column]));
  const handle = await open(path, "r");

  const spec = (name: string): ColumnSpec => {
    const found = columns.get(name);
    if (!found) throw new Error(`KDAY is missing ${name}`);
    return found;
  };
  const slice = async (name: string, start: number, count: number): Promise<Buffer> => {
    const column = spec(name);
    const width = widthOf(column.type);
    if (start < 0 || count < 0 || start + count > column.count) {
      throw new Error(`${name} slice ${start}:${start + count} is outside ${column.count} rows`);
    }
    const buffer = Buffer.alloc(count * width);
    if (count > 0) {
      await handle.read(buffer, 0, buffer.length, dataStart + column.byteOffset + start * width);
    }
    return buffer;
  };

  return {
    meta,
    has: (name) => columns.has(name),
    spec,
    slice,
    whole: (name) => slice(name, 0, spec(name).count),
    scalar: async (name, row) => value(await slice(name, row, 1), spec(name).type, 0),
    string: (id) => (id === NONE ? null : (meta.strings[id] ?? null)),
    close: () => handle.close(),
  };
}

/**
 * A whole column as a typed array, which is what the index passes want.
 *
 * `slice` hands back bytes because a per-person read is a handful of rows and a
 * `readUInt32LE` per row is cheaper than a copy. A pass over five million rows
 * is the opposite case.
 */
export async function typed(reader: Reader, name: string): Promise<Uint32Array | Int32Array | Uint8Array> {
  const column = reader.spec(name);
  const buffer = await reader.whole(name);
  if (column.type === "u8") return new Uint8Array(buffer.buffer, buffer.byteOffset, column.count);
  if (column.type === "i32") return new Int32Array(buffer.buffer, buffer.byteOffset, column.count);
  return new Uint32Array(buffer.buffer, buffer.byteOffset, column.count);
}

/**
 * One handset and the SIM in it, which are two facts and not one.
 *
 * `carrier` is the brand on the bill and `operator` is whose spectrum the phone
 * actually transmits on. For a third of this city those differ: an MVNO sells
 * the subscription and a host network carries it, so the records name the host.
 * Showing only the carrier would make every Mint customer look like they were
 * on a network that owns no towers.
 */
export interface DaySubscriber {
  /** Row in the file's subscriber table — what a span, event or CDR points at. */
  index: number;
  person: number;
  imsi: string | null;
  imei: string | null;
  msisdn: string | null;
  carrier: string | null;
  /** The host network, from the `operator` enum. */
  operator: string;
  /** What the radio in this handset can reach: lte, sub6 or cband. */
  tier: string;
  mvno: boolean;
  prepaid: boolean;
}

/** A cell a day touched, copied out of the file's own cell table. */
export interface DayCell {
  index: number;
  cgi: string | null;
  structure: string | null;
  operator: string;
  /** Radio and role together — "LTE anchor", "NR capacity". */
  layer: string;
  band: string | null;
  trackingArea: number;
  pci: number;
  lat: number;
  lon: number;
}

const SUBSCRIBER_COLUMNS = [
  "subscriber.person", "subscriber.imsi", "subscriber.imei", "subscriber.msisdn",
  "subscriber.carrier", "subscriber.operator", "subscriber.tier",
  "subscriber.mvno", "subscriber.prepaid",
] as const;

const CELL_COLUMNS = [
  "cell.cgi", "cell.structure", "cell.operator", "cell.layer", "cell.band",
  "cell.trackingArea", "cell.pci", "cell.latE6", "cell.lonE6",
] as const;

const enumAt = (list: string[] | undefined, code: number, fallback: string): string =>
  list?.[code] ?? fallback;

/**
 * The named handsets behind a set of subscriber indices.
 *
 * Resolved here rather than left as foreign keys, because a browser that had to
 * fetch devices.json to name a number would be reading a file the day file
 * already carries. A few rows at a time, so each is a seek rather than a pass.
 */
export async function readSubscribers(
  reader: Reader, wanted: Iterable<number>,
): Promise<DaySubscriber[]> {
  if (!reader.has("subscriber.person")) return [];
  const indices = [...new Set(wanted)].filter((index) => index >= 0).sort((a, b) => a - b);
  return Promise.all(indices.map(async (index) => {
    const fields = await Promise.all(SUBSCRIBER_COLUMNS.map(async (name) =>
      value(await reader.slice(name, index, 1), reader.spec(name).type, 0)));
    const [person, imsi, imei, msisdn, carrier, operator, tier, mvno, prepaid] = fields;
    return {
      index,
      person: person!,
      imsi: reader.string(imsi!),
      imei: reader.string(imei!),
      msisdn: reader.string(msisdn!),
      carrier: reader.string(carrier!),
      operator: enumAt(reader.meta.enums.operator, operator!, "unknown"),
      tier: enumAt(reader.meta.enums.radioTier, tier!, "lte"),
      mvno: mvno === 1,
      prepaid: prepaid === 1,
    } satisfies DaySubscriber;
  }));
}

/**
 * The named cells behind a set of cell indices.
 *
 * The cell table is a couple of thousand rows, so the columns are read whole
 * and only the wanted rows are materialised — cheaper than seeking nine times
 * per distinct cell, and a day touches a few dozen of them.
 */
export async function readCells(reader: Reader, wanted: Iterable<number>): Promise<DayCell[]> {
  if (!reader.has("cell.cgi")) return [];
  const indices = [...new Set(wanted)].filter((index) => index >= 0).sort((a, b) => a - b);
  if (!indices.length) return [];
  const data = await Promise.all(CELL_COLUMNS.map((name) => reader.whole(name)));
  const buffers = new Map(CELL_COLUMNS.map((name, i) => [name as string, data[i]!]));
  const at = (name: string, row: number) => value(buffers.get(name)!, reader.spec(name).type, row);
  return indices.map((index) => ({
    index,
    cgi: reader.string(at("cell.cgi", index)),
    structure: reader.string(at("cell.structure", index)),
    operator: enumAt(reader.meta.enums.operator, at("cell.operator", index), "unknown"),
    layer: enumAt(reader.meta.enums.radioLayer, at("cell.layer", index), "unknown"),
    band: reader.string(at("cell.band", index)),
    trackingArea: at("cell.trackingArea", index),
    pci: at("cell.pci", index),
    lat: at("cell.latE6", index) / 1e6,
    lon: at("cell.lonE6", index) / 1e6,
  } satisfies DayCell));
}

/**
 * The row in the person table for a resident id, or -1.
 *
 * IDs are currently dense, so the common path is one read. The binary search
 * stays because the format promises sorted ids, not id === row.
 */
export async function personRow(reader: Reader, person: number): Promise<number> {
  const total = reader.meta.counts.persons;
  if (person < total && await reader.scalar("person.id", person) === person) return person;
  let low = 0;
  let high = total - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const id = await reader.scalar("person.id", middle);
    if (id === person) return middle;
    if (id < person) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/**
 * Which resident owned each leg, as the columns that answer it.
 *
 * Legs are stored citywide in one table and a person owns a contiguous run of
 * it, so anything reading that table sideways — a camera pass, a vehicle's
 * movement — holds a row number and needs the resident behind it.
 * Materialising a leg-to-person array would be twenty megabytes for a question
 * asked a few thousand times, so the offsets are held and each row binary-
 * searches them. Cached per file: the arrays are a couple of megabytes and
 * every page on the same date wants them.
 */
export interface LegOwners {
  offset: Uint32Array;
  count: Uint32Array;
  person: Uint32Array;
}

const ownerCache = new Map<string, { mtimeMs: number; owners: LegOwners }>();

export async function legOwners(
  reader: Reader, path: string, mtimeMs: number,
): Promise<LegOwners> {
  const cached = ownerCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.owners;
  const [offset, count, person] = await Promise.all([
    typed(reader, "person.legOffset"),
    typed(reader, "person.legCount"),
    typed(reader, "person.id"),
  ]);
  const owners: LegOwners = {
    offset: offset as Uint32Array,
    count: count as Uint32Array,
    person: person as Uint32Array,
  };
  ownerCache.set(path, { mtimeMs, owners });
  return owners;
}

/**
 * The resident whose leg this is, or null.
 *
 * Offsets are cumulative and therefore non-decreasing, with people who went
 * nowhere sharing the offset of whoever comes next. The last row whose offset
 * is at or below the leg is the only candidate, and it still has to be checked
 * against that row's count — a leg past the end of the last person's run
 * belongs to nobody rather than to them.
 */
export function personOfLeg(owners: LegOwners, leg: number): number | null {
  let low = 0;
  let high = owners.offset.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (owners.offset[middle]! <= leg) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (found < 0) return null;
  if (leg >= owners.offset[found]! + owners.count[found]!) return null;
  return owners.person[found]!;
}

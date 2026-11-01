/**
 * The ClickHouse rows a scenario changes, carried inside its KDIF so an apply
 * needs neither the base KDAY nor a replay: the writer works them out once,
 * the importer streams them in.
 *
 * Changed rows are found without materializing either day. Every provider row
 * is a pure function of a handful of raw column values (its own table's
 * columns, the message or call it points at, its handover range) plus lookups
 * that a scenario may only append to. Hashing those raw words per row and
 * comparing the two multisets gives the base rows that vanished and the
 * scenario rows that appeared; only those are extracted.
 */

import { createHash } from "node:crypto";
import {
  alprReads, bankTransactions, callRecords, cameraIds, cellReferences, networkEvents,
  smsRecords, subscriberImeis, subscriberImsis, type DaySource,
} from "./extract.ts";
import type { NumericColumn } from "./kday.ts";

export type Row = Record<string, unknown>;

export const RECORD_TABLES = [
  "alpr_reads", "network_events", "sms_records", "call_records", "call_handovers", "bank_transactions",
] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

export interface TableRecords {
  /** The column an apply deletes by and a revert restores by. */
  key: string;
  /** Base rows the scenario removed, complete, so a revert can put them back. */
  deleted: Row[];
  inserted: Row[];
}

export interface ScenarioRecords {
  format: "FASTGATE_ROWS";
  version: 1;
  /** Stands in for the delta's file digest as the scenario's identity: the
   * rows are inside the file, so its digest cannot be known before writing. */
  scenarioId: string;
  timeZone: string;
  tables: Record<RecordTable, TableRecords>;
}

export const RECORD_KEYS: Record<RecordTable, string> = {
  alpr_reads: "read_id",
  network_events: "event_id",
  sms_records: "sms_record_id",
  call_records: "call_record_id",
  call_handovers: "call_record_id",
  bank_transactions: "transaction_id",
};

/** A deterministic identity for a delta's byte-level content, computed before
 * the records section exists so annotating a delta never changes it. */
export function scenarioIdentity(delta: {
  baseHash: string; date: string; metadata?: unknown; columns: unknown; opening?: unknown; closing?: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      baseHash: delta.baseHash, date: delta.date, metadata: delta.metadata ?? null,
      columns: delta.columns, opening: delta.opening ?? null, closing: delta.closing ?? null,
    }))
    .digest("hex");
}

interface HashSpec {
  /** Column whose presence and length define the table. */
  anchor: string;
  /** Columns hashed by the row's own index. Offsets into other tables are left
   * out: they shift on any insert while the row they describe does not. */
  direct: string[];
  /** Columns hashed at the index another column of this row points at. */
  indirect: { via: string; columns: string[] }[];
  /** Columns hashed over a range this row owns. */
  ranges: { start: string; count: string; columns: string[] }[];
  /** Index-to-value tables the row resolves through; must only grow. */
  lookups: string[];
}

const SUBSCRIBERS = ["subscriber.imsi", "subscriber.imei"];
const CELLS = ["cell.cgi", "cell.trackingArea"];

const SPECS: Record<Exclude<RecordTable, "call_handovers">, HashSpec> = {
  alpr_reads: {
    anchor: "alprObservation.detectedText",
    direct: ["alprObservation.camera", "alprObservation.second", "alprObservation.detectedText",
      "alprObservation.canonicalText", "alprObservation.confidence", "alprObservation.lighting"],
    indirect: [], ranges: [], lookups: ["camera.id"],
  },
  network_events: {
    anchor: "event.subscriber",
    direct: ["event.subscriber", "event.minute", "event.kind", "event.cell", "event.previous", "event.cause",
      "event.ta", "event.secondary"],
    indirect: [], ranges: [], lookups: [...SUBSCRIBERS, ...CELLS],
  },
  sms_records: {
    anchor: "sms.message",
    direct: ["sms.from", "sms.to", "sms.cell", "sms.toCell", "sms.part", "sms.parts", "sms.delivered"],
    indirect: [{ via: "sms.message", columns: ["message.at", "message.channel"] }],
    ranges: [], lookups: [...SUBSCRIBERS, "cell.cgi"],
  },
  call_records: {
    anchor: "cdr.call",
    direct: ["cdr.from", "cdr.to", "cdr.originCell", "cdr.endCell", "cdr.toOriginCell", "cdr.toEndCell",
      "cdr.handoverCount"],
    indirect: [{ via: "cdr.call", columns: ["call.at", "call.outcome", "call.ring", "call.duration"] }],
    ranges: [{ start: "cdr.handoverAt", count: "cdr.handoverCount", columns: ["handover.second", "handover.cell"] }],
    lookups: [...SUBSCRIBERS, "cell.cgi"],
  },
  bank_transactions: {
    anchor: "tx.minute",
    direct: ["tx.minute", "tx.amount", "tx.kind", "tx.approved", "tx.decline", "tx.instrument", "tx.mcc",
      "tx.merchant", "tx.account", "tx.card", "tx.network", "tx.balanceAfter", "tx.latE6", "tx.lonE6"],
    indirect: [], ranges: [], lookups: [],
  },
};

/** The column's raw bits as 32-bit words, so floats hash by pattern. */
function words(column: NumericColumn): Uint32Array {
  if (column instanceof Uint8Array) return Uint32Array.from(column);
  if (column instanceof Uint32Array) return column;
  if (column.byteOffset % 4) {
    const copy = new Uint8Array(column.byteLength);
    copy.set(new Uint8Array(column.buffer, column.byteOffset, column.byteLength));
    return new Uint32Array(copy.buffer);
  }
  return new Uint32Array(column.buffer, column.byteOffset, column.length);
}

/** True when `next` starts with every byte of `previous`: indices that existed
 * in the base still name the same thing. */
function extendsColumn(previous: NumericColumn, next: NumericColumn): boolean {
  if (next.byteLength < previous.byteLength) return false;
  const x = new Uint8Array(previous.buffer, previous.byteOffset, previous.byteLength);
  const y = new Uint8Array(next.buffer, next.byteOffset, previous.byteLength);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/** Two 32-bit lanes per row, viewed as one 64-bit hash for sorting. */
async function rowHashes(source: DaySource, spec: HashSpec): Promise<BigUint64Array> {
  if (!source.has(spec.anchor)) return new BigUint64Array(0);
  const count = source.meta.columns.find((column) => column.name === spec.anchor)!.count;
  const load = async (name: string) => words(await source.column(name));
  // A direct column the file predates is left out of the hash on both sides;
  // base and scenario are the same version, so the omission is symmetric.
  const direct = await Promise.all(spec.direct.filter((name) => source.has(name)).map(load));
  const indirect = await Promise.all(spec.indirect.map(async (entry) => ({
    via: await load(entry.via), columns: await Promise.all(entry.columns.map(load)),
  })));
  const ranges = await Promise.all(spec.ranges.map(async (entry) => ({
    start: await load(entry.start), count: await load(entry.count),
    columns: await Promise.all(entry.columns.map(load)),
  })));
  for (const column of direct) if (column.length !== count) throw new Error(`${spec.anchor} table has ragged columns`);
  const lanes = new Uint32Array(count * 2);
  for (let row = 0; row < count; row += 1) {
    let a = 0x9e3779b9, b = 0x85ebca6b;
    const mix = (word: number) => {
      a = Math.imul(a ^ word, 0x01000193); a ^= a >>> 15;
      b = Math.imul(b + word, 0x27d4eb2f); b ^= b >>> 13;
    };
    for (const column of direct) mix(column[row]!);
    for (const entry of indirect) {
      const at = entry.via[row]!;
      for (const column of entry.columns) mix(at < column.length ? column[at]! : 0xffffffff);
    }
    for (const entry of ranges) {
      const start = entry.start[row]!, length = entry.count[row]!;
      mix(length);
      for (let index = start; index < start + length; index += 1) {
        for (const column of entry.columns) mix(index < column.length ? column[index]! : 0xffffffff);
      }
    }
    lanes[row * 2] = a >>> 0;
    lanes[row * 2 + 1] = b >>> 0;
  }
  return new BigUint64Array(lanes.buffer);
}

/** Row indices present in one multiset and not the other, ascending. Rows with
 * equal hashes pair off regardless of position, so a moved row is unchanged. */
export function differingRows(
  base: BigUint64Array, scenario: BigUint64Array,
): { deleted: Uint32Array; inserted: Uint32Array } {
  const sortedBase = base.slice().sort(), sortedScenario = scenario.slice().sort();
  const deletedNeed = new Map<bigint, number>(), insertedNeed = new Map<bigint, number>();
  let i = 0, j = 0;
  const note = (map: Map<bigint, number>, hash: bigint) => map.set(hash, (map.get(hash) ?? 0) + 1);
  while (i < sortedBase.length || j < sortedScenario.length) {
    if (j >= sortedScenario.length || (i < sortedBase.length && sortedBase[i]! < sortedScenario[j]!)) {
      note(deletedNeed, sortedBase[i]!); i += 1;
    } else if (i >= sortedBase.length || sortedScenario[j]! < sortedBase[i]!) {
      note(insertedNeed, sortedScenario[j]!); j += 1;
    } else { i += 1; j += 1; }
  }
  const collect = (hashes: BigUint64Array, need: Map<bigint, number>): Uint32Array => {
    const out: number[] = [];
    if (need.size) {
      for (let row = 0; row < hashes.length; row += 1) {
        const remaining = need.get(hashes[row]!);
        if (remaining) { out.push(row); need.set(hashes[row]!, remaining - 1); }
      }
    }
    return Uint32Array.from(out);
  };
  return { deleted: collect(base, deletedNeed), inserted: collect(scenario, insertedNeed) };
}

interface Context {
  source: DaySource;
  digest: string;
  cameras: string[];
  sites: Awaited<ReturnType<typeof cellReferences>>;
  cgis: string[];
  imsis: string[];
  imeis: string[];
}

async function context(source: DaySource, digest: string): Promise<Context> {
  const [cameras, sites, imsis, imeis] = await Promise.all([
    cameraIds(source), cellReferences(source), subscriberImsis(source), subscriberImeis(source),
  ]);
  return { source, digest, cameras, sites, cgis: sites.map((site) => site.cgi), imsis, imeis };
}

const plain = (row: object): Row => ({ ...row });

async function extract(
  context: Context, timeZone: string, name: Exclude<RecordTable, "call_handovers">, rows: Uint32Array,
): Promise<{ rows: Row[]; handovers: Row[] }> {
  const { source, digest, cameras, sites, cgis, imsis, imeis } = context;
  if (!rows.length) return { rows: [], handovers: [] };
  if (name === "alpr_reads") {
    return { rows: (await alprReads(source, digest, timeZone, cameras, rows)).map(plain), handovers: [] };
  }
  if (name === "network_events") {
    return { rows: (await networkEvents(source, digest, timeZone, imsis, imeis, sites, rows)).map(plain), handovers: [] };
  }
  if (name === "sms_records") {
    return { rows: (await smsRecords(source, digest, timeZone, imsis, imeis, cgis, rows)).map(plain), handovers: [] };
  }
  if (name === "call_records") {
    const phone = await callRecords(source, digest, timeZone, imsis, imeis, cgis, rows);
    return { rows: phone.calls.map(plain), handovers: phone.handovers.map(plain) };
  }
  return {
    rows: (await bankTransactions(source, digest, timeZone, rows)).map((row) => {
      const { _person_id, ...bankRow } = row;
      return {
        ...bankRow,
        amount: row.amount.toFixed(2),
        balance_after: row.balance_after === null ? null : row.balance_after.toFixed(2),
      };
    }),
    handovers: [],
  };
}

async function checkLookups(base: DaySource, scenario: DaySource): Promise<void> {
  if (JSON.stringify(base.meta.enums) !== JSON.stringify(scenario.meta.enums)) {
    throw new Error("scenario changed the KDAY enum tables; its ClickHouse rows cannot be derived");
  }
  const names = new Set(Object.values(SPECS).flatMap((spec) => spec.lookups));
  for (const name of names) {
    if (!base.has(name)) continue;
    const [before, after] = await Promise.all([base.column(name), scenario.column(name)]);
    if (!extendsColumn(before, after)) {
      throw new Error(`scenario rewrote ${name}; a lookup table may only be appended to`);
    }
  }
}

export interface RecordsProgress {
  (label: string): void;
}

/** Works out the rows an apply must delete and insert for each provider
 * table. Reads only the columns those tables depend on, never the whole day.
 */
export async function scenarioRecords(
  base: DaySource, scenario: DaySource, baseDigest: string, scenarioId: string, timeZone: string,
  progress?: RecordsProgress,
): Promise<ScenarioRecords> {
  if (base.meta.date !== scenario.meta.date) throw new Error("scenario and base days differ in date");
  await checkLookups(base, scenario);
  const [baseContext, scenarioContext] = await Promise.all([
    context(base, baseDigest), context(scenario, scenarioId),
  ]);
  const tables = Object.fromEntries(RECORD_TABLES.map((name) => [name, {
    key: RECORD_KEYS[name], deleted: [] as Row[], inserted: [] as Row[],
  }])) as Record<RecordTable, TableRecords>;
  for (const name of Object.keys(SPECS) as (keyof typeof SPECS)[]) {
    progress?.(`Comparing ${name}`);
    const spec = SPECS[name];
    const [before, after] = await Promise.all([rowHashes(base, spec), rowHashes(scenario, spec)]);
    const changed = differingRows(before, after);
    const [removed, added] = await Promise.all([
      extract(baseContext, timeZone, name, changed.deleted),
      extract(scenarioContext, timeZone, name, changed.inserted),
    ]);
    tables[name].deleted = removed.rows;
    tables[name].inserted = added.rows;
    if (name === "call_records") {
      tables.call_handovers.deleted = removed.handovers;
      tables.call_handovers.inserted = added.handovers;
    }
  }
  return { format: "FASTGATE_ROWS", version: 1, scenarioId, timeZone, tables };
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape-checks a records section read from disk. Row contents are whatever
 * the writer's extractors produced; only the structure is enforced here. */
export function validateRecords(records: unknown): ScenarioRecords {
  const value = records as ScenarioRecords;
  if (!isRow(value) || value.format !== "FASTGATE_ROWS" || value.version !== 1
    || typeof value.scenarioId !== "string" || !/^[a-f0-9]{64}$/.test(value.scenarioId)
    || typeof value.timeZone !== "string" || !isRow(value.tables)) {
    throw new Error("invalid KDIF records section");
  }
  for (const name of RECORD_TABLES) {
    const entry = value.tables[name];
    if (!isRow(entry) || entry.key !== RECORD_KEYS[name]
      || !Array.isArray(entry.deleted) || !Array.isArray(entry.inserted)) {
      throw new Error(`invalid KDIF records for ${name}`);
    }
    for (const row of [...entry.deleted, ...entry.inserted]) {
      if (!isRow(row) || typeof row[entry.key] !== "string") throw new Error(`invalid KDIF record in ${name}`);
    }
  }
  return value;
}

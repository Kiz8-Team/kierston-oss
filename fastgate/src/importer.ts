import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { deleteWhere, initializeSchema, INSERT_BATCH, insertBatches, table, type Database } from "./database.ts";
import {
  alprReads, bankTransactions, callRecords, cameraIds, cellReferences, networkEvents,
  smsRecords, subscriberImsis, subscriberImeis,
} from "kierston-provider-rows";
import { KdayReader } from "kierston-provider-rows";
import { cityTimeZone } from "./city.ts";
import { resolveTableImport, type TableImportOptions } from "./import-options.ts";
import type { ProgressHandler } from "./progress.ts";
import { clearJournal } from "./scenario-journal.ts";
import { DYNAMIC_DAY_COLUMNS } from "./schema.ts";
import type { StaticDatabase } from "./static-database.ts";

export interface ImportSummary {
  date: string;
  alreadyImported: boolean;
  alprReads: number;
  networkEvents: number;
  smsRecords: number;
  callRecords: number;
  callHandovers: number;
  bankTransactions: number;
}

export const DYNAMIC_TABLES = [
  "alpr_reads",
  "network_events",
  "sms_records",
  "call_records",
  "call_handovers",
  "bank_transactions",
] as const;

interface ImportMarker {
  source_digest: string;
  status: "importing" | "complete";
}

const importLocks = new Map<string, Promise<void>>();
let lastVersion = 0n;

export function nextVersion(): string {
  const clock = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  lastVersion = clock > lastVersion ? clock : lastVersion + 1n;
  return lastVersion.toString();
}

export async function withImportLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = importLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => held);
  importLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importLocks.get(key) === queued) importLocks.delete(key);
  }
}

export async function importMarker(database: Database, date: string): Promise<ImportMarker | null> {
  const result = await database.client.query({
    query: `SELECT source_digest, status
      FROM ${table(database, "ingested_days")} FINAL
      WHERE observation_date = {date:Date32}
      LIMIT 1`,
    query_params: { date },
    format: "JSONEachRow",
  });
  const rows = await result.json<ImportMarker>();
  return rows[0] ?? null;
}

async function writeMarker(
  database: Database,
  date: string,
  digest: string,
  status: ImportMarker["status"],
): Promise<void> {
  await database.client.insert({
    table: table(database, "ingested_days"),
    values: [{
      observation_date: date,
      source_digest: digest,
      status,
      imported_at: new Date(),
      _version: nextVersion(),
    }],
    format: "JSONEachRow",
  });
}

export async function sha256(path: string, progress?: ProgressHandler): Promise<string> {
  const hash = createHash("sha256");
  const total = (await stat(path)).size;
  let completed = 0;
  progress?.({ stage: "read", label: "Reading source file", completed, total });
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    completed += chunk.length;
    progress?.({ stage: "read", label: "Reading source file", completed, total });
  }
  return hash.digest("hex");
}

/** The scenario marker for a date, read here rather than from
 * scenario-importer.ts, which imports this module. */
async function activeScenario(
  database: Database, date: string,
): Promise<{ scenario_digest: string; status: string } | null> {
  const result = await database.client.query({
    query: `SELECT scenario_digest, status
      FROM ${table(database, "active_scenarios")} FINAL
      WHERE observation_date = {date:Date32}
      LIMIT 1`,
    query_params: { date },
    format: "JSONEachRow",
  });
  return (await result.json<{ scenario_digest: string; status: string }>())[0] ?? null;
}

const CLOCK_COLUMNS: Record<string, string> = Object.fromEntries(DYNAMIC_DAY_COLUMNS);

/** Removes one day's rows from a dynamic table, leaving every other day. Rows
 * stamped with an observation_date go by that stamp; rows imported before the
 * stamp existed go by the local calendar day of their clock column. */
async function deleteDay(
  database: Database, tableName: string, date: string, timeZone: string,
): Promise<void> {
  const clock = CLOCK_COLUMNS[tableName];
  if (!clock) throw new Error(`${tableName} has no day column`);
  await deleteWhere(
    database, tableName,
    `observation_date = {date:Date32}
      OR (observation_date IS NULL AND toDate(${clock}, {zone:String}) = {date:Date32})`,
    { date, zone: timeZone },
  );
}

function stamped<T extends object>(rows: readonly T[], date: string): (T & { observation_date: string })[] {
  return rows.map((row) => ({ ...row, observation_date: date }));
}

function emptySummary(date: string, alreadyImported = false): ImportSummary {
  return {
    date, alreadyImported, alprReads: 0, networkEvents: 0,
    smsRecords: 0, callRecords: 0,
    callHandovers: 0, bankTransactions: 0,
  };
}

export async function importKday(
  database: Database,
  path: string,
  timeZone = cityTimeZone(),
  progress?: ProgressHandler,
  staticDatabase?: StaticDatabase,
  options?: TableImportOptions,
): Promise<ImportSummary> {
  const explicitOptions = options?.tables !== undefined || options?.mode !== undefined;
  const selection = resolveTableImport(DYNAMIC_TABLES, options, explicitOptions ? "overwrite" : "append");
  // Validate the configured zone before reading the source.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  progress?.({ stage: "schema", label: "Initializing ClickHouse schema" });
  await initializeSchema(database);
  const [reader, digest] = await Promise.all([KdayReader.open(path), sha256(path, progress)]);
  try {
    return await withImportLock(database.database, async () => {
      const date = reader.meta.date;
      const fullOverwrite = selection.explicit && selection.mode === "overwrite"
        && DYNAMIC_TABLES.every((name) => selection.tables.has(name));
      // A selective import writes base rows under a day whose scenario rows the
      // journal tracks; append would duplicate base rows the scenario removed
      // and overwrite would drop the scenario's rows while its marker says it is
      // applied. Both are refused unless the caller forces them.
      const scenario = selection.explicit ? await activeScenario(database, date) : null;
      if (scenario && !options?.forceWithScenario) {
        throw new Error(
          `scenario ${scenario.scenario_digest} is active for ${date}; `
          + "run revert:scenario first or pass --force-with-scenario",
        );
      }
      const existing = selection.explicit ? null : await importMarker(database, date);
      if (existing) {
        if (existing.source_digest !== digest) {
          throw new Error(`a different source file has already been imported for ${reader.meta.date}`);
        }
        if (existing.status === "complete") {
          progress?.({ stage: "skipped", label: `${reader.meta.date} is already imported` });
          return emptySummary(reader.meta.date, true);
        }
      }

      // A full overwrite replaces the whole day from this file, so the day
      // marker moves to this file's digest. Partial and append imports leave
      // the marker as it was.
      const marksDay = !selection.explicit || fullOverwrite;
      if (marksDay) await writeMarker(database, date, digest, "importing");
      const version = nextVersion();

      const summary = emptySummary(reader.meta.date);

      const extracting = (table: string): void => progress?.({ stage: "extract", label: `Reading ${table}` });
      const inserting = (table: string) => (completed: number, total: number): void =>
        progress?.({ stage: "insert", label: `Writing ${table}`, completed, total });

      if (selection.tables.has("alpr_reads")) {
        extracting("ALPR references");
        const cameraIdLookup = await cameraIds(reader);
        extracting("ALPR reads");
        const readRows = await alprReads(reader, digest, timeZone, cameraIdLookup);
        if (selection.mode === "overwrite") await deleteDay(database, "alpr_reads", date, timeZone);
        await insertBatches(database, "alpr_reads", stamped(readRows, date), version, INSERT_BATCH, inserting("ALPR reads"));
        summary.alprReads = readRows.length;
      }

      const telecomSelected = ["network_events", "sms_records", "call_records", "call_handovers"]
        .some((name) => selection.tables.has(name));
      if (telecomSelected) extracting("telecom references");
      const siteRows = telecomSelected ? await cellReferences(reader) : [];
      const imsis = telecomSelected ? await subscriberImsis(reader) : [];
      const imeis = telecomSelected ? await subscriberImeis(reader) : [];
      const cgis = siteRows.map((row) => row.cgi);
      if (selection.tables.has("network_events")) {
        extracting("network events");
        const eventRows = await networkEvents(reader, digest, timeZone, imsis, imeis, siteRows);
        if (selection.mode === "overwrite") await deleteDay(database, "network_events", date, timeZone);
        await insertBatches(database, "network_events", stamped(eventRows, date), version, INSERT_BATCH, inserting("network events"));
        summary.networkEvents = eventRows.length;
      }

      if (selection.tables.has("sms_records")) {
        extracting("SMS records");
        const smsRows = await smsRecords(reader, digest, timeZone, imsis, imeis, cgis);
        if (selection.mode === "overwrite") await deleteDay(database, "sms_records", date, timeZone);
        await insertBatches(database, "sms_records", stamped(smsRows, date), version, INSERT_BATCH, inserting("SMS records"));
        summary.smsRecords = smsRows.length;
      }

      const callsSelected = selection.tables.has("call_records");
      const handoversSelected = selection.tables.has("call_handovers");
      if (callsSelected || handoversSelected) {
        extracting("call records");
        const phone = await callRecords(reader, digest, timeZone, imsis, imeis, cgis);
        if (callsSelected) {
          const callRows = phone.calls;
          if (selection.mode === "overwrite") await deleteDay(database, "call_records", date, timeZone);
          await insertBatches(database, "call_records", stamped(callRows, date), version, INSERT_BATCH, inserting("call records"));
          summary.callRecords = phone.calls.length;
        }
        if (handoversSelected) {
          const handoverRows = phone.handovers;
          if (selection.mode === "overwrite") await deleteDay(database, "call_handovers", date, timeZone);
          await insertBatches(
            database, "call_handovers", stamped(handoverRows, date), version, INSERT_BATCH, inserting("call handovers"),
          );
          summary.callHandovers = phone.handovers.length;
        }
      }

      if (selection.tables.has("bank_transactions")) {
        extracting("bank transactions");
        const transactionRows = await bankTransactions(reader, digest, timeZone);
        const decimalTransactions = transactionRows.map((row) => {
          const { _person_id, ...bankRow } = row;
          return {
            ...bankRow,
            amount: row.amount.toFixed(2),
            balance_after: row.balance_after === null ? null : row.balance_after.toFixed(2),
          };
        });
        if (selection.mode === "overwrite") await deleteDay(database, "bank_transactions", date, timeZone);
        await insertBatches(
          database, "bank_transactions", stamped(decimalTransactions, date), version, INSERT_BATCH, inserting("bank transactions"),
        );
        summary.bankTransactions = transactionRows.length;
      }

      if (fullOverwrite && scenario) {
        // Every scenario row is gone, so the day is its base again.
        await clearJournal(database, date);
        await deleteWhere(database, "active_scenarios", "observation_date = {date:Date32}", { date });
      }
      if (marksDay) await writeMarker(database, date, digest, "complete");
      progress?.({ stage: "complete", label: `Imported ${reader.meta.date} (${selection.mode})` });
      return summary;
    });
  } finally {
    await reader.close();
  }
}

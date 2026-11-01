import { deleteIds, INSERT_BATCH, insertBatches, initializeSchema, table, type Database } from "./database.ts";
import {
  clearJournal, journalDeleted, journalInserted, markJournalled, type JournalKey,
} from "./scenario-journal.ts";
import { cityTimeZone } from "./city.ts";
import { importMarker, nextVersion, withImportLock } from "./importer.ts";
import { readDelta } from "./kdif.ts";
import type { ProgressHandler } from "./progress.ts";
import { RECORD_KEYS, RECORD_TABLES, validateRecords, type RecordTable, type Row } from "kierston-provider-rows";

export interface ScenarioTableChanges {
  deleted: number;
  inserted: number;
}

export interface ScenarioImportSummary {
  date: string;
  baseDigest: string;
  scenarioDigest: string;
  alreadyImported: boolean;
  tables: Record<RecordTable, ScenarioTableChanges>;
}

export interface ScenarioMarker {
  base_digest: string;
  scenario_digest: string;
  status: "importing" | "complete";
}

/** The column a revert deletes by. Handovers hang off their call, so a call id
 * removes every handover that arrived with it. */
export const JOURNAL_KEYS: Record<RecordTable, string> = RECORD_KEYS;

export const JOURNAL_TABLES = RECORD_TABLES;

export async function scenarioMarker(database: Database, date: string): Promise<ScenarioMarker | null> {
  const result = await database.client.query({
    query: `SELECT base_digest, scenario_digest, status
      FROM ${table(database, "active_scenarios")} FINAL
      WHERE observation_date = {date:Date32}
      LIMIT 1`,
    query_params: { date },
    format: "JSONEachRow",
  });
  return (await result.json<ScenarioMarker>())[0] ?? null;
}

/** Every date with a scenario marker, including an apply that never finished. */
export async function activeScenarios(database: Database): Promise<(ScenarioMarker & { observation_date: string })[]> {
  const result = await database.client.query({
    query: `SELECT toString(observation_date) AS observation_date, base_digest, scenario_digest, status
      FROM ${table(database, "active_scenarios")} FINAL
      ORDER BY observation_date`,
    format: "JSONEachRow",
  });
  return await result.json<ScenarioMarker & { observation_date: string }>();
}

async function writeScenarioMarker(
  database: Database, date: string, baseDigest: string, scenarioDigest: string,
  status: ScenarioMarker["status"],
): Promise<void> {
  await database.client.insert({
    table: table(database, "active_scenarios"),
    values: [{ observation_date: date, base_digest: baseDigest, scenario_digest: scenarioDigest,
      status, applied_at: new Date(), _version: nextVersion() }],
    format: "JSONEachRow",
  });
}

function emptyChanges(): Record<RecordTable, ScenarioTableChanges> {
  return Object.fromEntries(RECORD_TABLES.map((name) => [name, { deleted: 0, inserted: 0 }])) as
    Record<RecordTable, ScenarioTableChanges>;
}

const keyOf = (rows: readonly Row[], key: string): string[] => rows.map((row) => String(row[key]));

/** Applies the rows a KDIF carries to the day its base was imported as. Reads
 * no KDAY: the delta names every row to delete and insert, and its
 * `scenarioId` stands in for a file digest as the scenario's identity.
 */
export async function importScenario(
  database: Database,
  deltaPath: string,
  timeZone = cityTimeZone(),
  progress?: ProgressHandler,
): Promise<ScenarioImportSummary> {
  progress?.({ stage: "read", label: "Reading scenario delta" });
  const delta = await readDelta(deltaPath);
  if (!delta.records) {
    throw new Error(`${deltaPath} carries no ClickHouse rows; annotate it from its base KDAY first`);
  }
  const records = validateRecords(delta.records);
  if (records.timeZone !== timeZone) {
    throw new Error(`the delta's rows were written for ${records.timeZone}, not ${timeZone}`);
  }
  const { date, baseHash: baseDigest } = delta;
  const scenarioDigest = records.scenarioId;
  progress?.({ stage: "schema", label: "Initializing ClickHouse schema" });
  await initializeSchema(database);
  return await withImportLock(database.database, async () => {
    const imported = await importMarker(database, date);
    if (!imported || imported.status !== "complete" || imported.source_digest !== baseDigest) {
      throw new Error("the exact base KDAY must be completely imported before applying its KDIF");
    }
    const active = await scenarioMarker(database, date);
    if (active?.status === "complete" && active.base_digest === baseDigest
      && active.scenario_digest === scenarioDigest) {
      progress?.({ stage: "skipped", label: "This scenario is already active" });
      return { date, baseDigest, scenarioDigest, alreadyImported: true, tables: emptyChanges() };
    }
    if (active && (active.base_digest !== baseDigest || active.scenario_digest !== scenarioDigest)) {
      throw new Error(`a different scenario is already active for ${date}; restore the base day before switching scenarios`);
    }
    await writeScenarioMarker(database, date, baseDigest, scenarioDigest, "importing");
    // The journal is what a later revert replays, so it is rebuilt from
    // scratch here and sentinelled before the first row moves.
    const journal: JournalKey = { date, baseDigest, scenarioDigest };
    await clearJournal(database, date);
    const changes = emptyChanges();
    const version = nextVersion();
    await markJournalled(database, journal, version);
    for (const name of RECORD_TABLES) {
      const entry = records.tables[name];
      const key = RECORD_KEYS[name];
      changes[name] = { deleted: entry.deleted.length, inserted: entry.inserted.length };
      const total = entry.deleted.length + entry.inserted.length;
      progress?.({ stage: "insert", label: `Journaling ${name}`, completed: 0, total });
      await journalDeleted(database, journal, name, key, entry.deleted, version);
      await journalInserted(database, journal, name, key, entry.inserted, version);
      progress?.({ stage: "insert", label: `Deleting ${name}`, completed: 0, total: entry.deleted.length });
      await deleteIds(database, name, key, keyOf(entry.deleted, key));
      // Stamped with the day so a later `--mode overwrite` of this date finds them.
      const inserted = entry.inserted.map((row) => ({ ...row, observation_date: date }));
      await insertBatches(database, name, inserted, version, INSERT_BATCH, (completed, total) => {
        progress?.({ stage: "insert", label: `Inserting ${name}`, completed, total });
      });
      progress?.({ stage: "insert", label: `Updating ${name}`, completed: total, total });
    }
    await writeScenarioMarker(database, date, baseDigest, scenarioDigest, "complete");
    progress?.({ stage: "complete", label: `Applied scenario for ${date}` });
    return { date, baseDigest, scenarioDigest, alreadyImported: false, tables: changes };
  });
}

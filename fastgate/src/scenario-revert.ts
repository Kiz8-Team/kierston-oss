import { deleteIds, deleteWhere, initializeSchema, INSERT_BATCH, insertBatches, type Database } from "./database.ts";
import { nextVersion, withImportLock } from "./importer.ts";
import type { ProgressHandler } from "./progress.ts";
import { JOURNAL_KEYS, JOURNAL_TABLES, scenarioMarker } from "./scenario-importer.ts";
import { clearJournal, readJournal } from "./scenario-journal.ts";

export interface ScenarioRevertTableChanges {
  deleted: number;
  restored: number;
}

export interface ScenarioRevertSummary {
  date: string;
  baseDigest: string;
  scenarioDigest: string;
  tables: Record<string, ScenarioRevertTableChanges>;
}

/** Puts a day back to the KDAY it was imported from by replaying the journal
 * the apply wrote. It reads no KDAY and no KDIF: the rows a scenario removed
 * were kept verbatim, and the rows it added are removed by id.
 */
export async function revertScenario(
  database: Database,
  date: string,
  progress?: ProgressHandler,
): Promise<ScenarioRevertSummary> {
  progress?.({ stage: "schema", label: "Initializing ClickHouse schema" });
  await initializeSchema(database);
  return await withImportLock(database.database, async () => {
    const active = await scenarioMarker(database, date);
    if (!active) throw new Error(`no scenario is active for ${date}`);
    const key = { date, baseDigest: active.base_digest, scenarioDigest: active.scenario_digest };
    progress?.({ stage: "extract", label: "Reading the scenario journal" });
    const journal = await readJournal(database, key);
    if (!journal.sentinel) {
      throw new Error(
        `the scenario active for ${date} was applied without a revert journal; `
        + "re-import its base KDAY to restore the day",
      );
    }
    const version = nextVersion();
    const tables: Record<string, ScenarioRevertTableChanges> = {};
    for (const name of JOURNAL_TABLES) {
      const entry = journal.tables.get(name);
      tables[name] = {
        deleted: entry?.insertedIds.length ?? 0,
        restored: entry?.deletedRows.length ?? 0,
      };
      if (!entry) continue;
      progress?.({
        stage: "insert",
        label: `Deleting scenario rows from ${name}`,
        completed: 0,
        total: entry.insertedIds.length,
      });
      await deleteIds(database, name, JOURNAL_KEYS[name], entry.insertedIds);
      const restored = entry.deletedRows.map((row) => ({ ...row, observation_date: date }));
      await insertBatches(database, name, restored, version, INSERT_BATCH, (completed, total) => {
        progress?.({ stage: "insert", label: `Restoring ${name}`, completed, total });
      });
      progress?.({
        stage: "insert",
        label: `Reverting ${name}`,
        completed: entry.insertedIds.length + entry.deletedRows.length,
        total: entry.insertedIds.length + entry.deletedRows.length,
      });
    }
    await clearJournal(database, date);
    await deleteWhere(database, "active_scenarios", "observation_date = {date:Date32}", { date });
    progress?.({ stage: "complete", label: `Reverted ${date} to its base day` });
    return { date, baseDigest: key.baseDigest, scenarioDigest: key.scenarioDigest, tables };
  });
}

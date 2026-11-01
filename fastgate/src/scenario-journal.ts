import { deleteWhere, insertBatches, table, type Database } from "./database.ts";

export type Row = Record<string, unknown>;

/** What a journal entry records about one row of one scenario apply.
 * `deleted` carries the base row's full contents so a revert can put it back;
 * `inserted` carries only the id a revert removes. `applied` is the sentinel
 * that proves the apply journaled itself at all. */
export type JournalChange = "deleted" | "inserted" | "applied";

export interface JournalKey {
  date: string;
  baseDigest: string;
  scenarioDigest: string;
}

export interface JournalEntry {
  table_name: string;
  change: JournalChange;
  row_id: string;
  row_json: string;
}

function journalRow(key: JournalKey, entry: JournalEntry): Row {
  return {
    observation_date: key.date,
    base_digest: key.baseDigest,
    scenario_digest: key.scenarioDigest,
    ...entry,
  };
}

/** Drops any journal for a date, including a half-written one left by an apply
 * that failed partway. */
export async function clearJournal(database: Database, date: string): Promise<void> {
  await deleteWhere(database, "scenario_journal", "observation_date = {date:Date32}", { date });
}

export async function markJournalled(
  database: Database, key: JournalKey, version: string,
): Promise<void> {
  await insertBatches(database, "scenario_journal", [
    journalRow(key, { table_name: "", change: "applied", row_id: "", row_json: "" }),
  ], version);
}

/** The journal is a ReplacingMergeTree sorted on row_id, so two deleted rows
 * that share a key (every handover of one call shares call_record_id) would
 * collapse to one. Each deleted row's id therefore carries its ordinal within
 * the apply; a revert reads row_json, never row_id, for deleted rows. */
export function deletedRowId(row: Row, keyField: string, ordinal: number): string {
  return `${String(row[keyField])}#${ordinal}`;
}

export async function journalDeleted(
  database: Database, key: JournalKey, tableName: string, keyField: string,
  rows: readonly Row[], version: string,
): Promise<void> {
  await insertBatches(database, "scenario_journal", rows.map((row, ordinal) => journalRow(key, {
    table_name: tableName,
    change: "deleted",
    row_id: deletedRowId(row, keyField, ordinal),
    row_json: JSON.stringify(row),
  })), version);
}

export async function journalInserted(
  database: Database, key: JournalKey, tableName: string, keyField: string,
  rows: readonly Row[], version: string,
): Promise<void> {
  const ids = [...new Set(rows.map((row) => String(row[keyField])))];
  await insertBatches(database, "scenario_journal", ids.map((id) => journalRow(key, {
    table_name: tableName,
    change: "inserted",
    row_id: id,
    row_json: "",
  })), version);
}

export interface JournalledTable {
  insertedIds: string[];
  deletedRows: Row[];
}

export interface Journal {
  sentinel: boolean;
  tables: Map<string, JournalledTable>;
}

export async function readJournal(database: Database, key: JournalKey): Promise<Journal> {
  const result = await database.client.query({
    query: `SELECT table_name, change, row_id, row_json
      FROM ${table(database, "scenario_journal")} FINAL
      WHERE observation_date = {date:Date32}
        AND base_digest = {base:String}
        AND scenario_digest = {scenario:String}`,
    query_params: { date: key.date, base: key.baseDigest, scenario: key.scenarioDigest },
    format: "JSONEachRow",
  });
  const journal: Journal = { sentinel: false, tables: new Map() };
  for (const entry of await result.json<JournalEntry>()) {
    if (entry.change === "applied") {
      journal.sentinel = true;
      continue;
    }
    const bucket = journal.tables.get(entry.table_name)
      ?? { insertedIds: [], deletedRows: [] };
    if (entry.change === "inserted") bucket.insertedIds.push(entry.row_id);
    else bucket.deletedRows.push(JSON.parse(entry.row_json) as Row);
    journal.tables.set(entry.table_name, bucket);
  }
  return journal;
}

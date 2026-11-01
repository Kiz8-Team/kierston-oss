import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, table } from "../src/database.ts";
import { importKday } from "../src/importer.ts";
import { importScenario } from "../src/scenario-importer.ts";
import { revertScenario } from "../src/scenario-revert.ts";
import { writeAmountScenarioFixture, writeObservableFixture } from "./fixture.ts";

const clickHouseUrl = process.env.FASTGATE_TEST_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_URL;

test.skipIf(!clickHouseUrl)("imports all observable table families into ClickHouse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-database-test-"));
  const path = join(directory, "fixture.bin");
  const configuredDatabase = process.env.FASTGATE_TEST_CLICKHOUSE_DATABASE;
  const databaseName = configuredDatabase ?? `fastgate_test_${process.pid}_${Date.now()}`;
  const database = connect({
    url: clickHouseUrl!,
    database: databaseName,
    username: process.env.FASTGATE_TEST_CLICKHOUSE_USER ?? process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.FASTGATE_TEST_CLICKHOUSE_PASSWORD ?? process.env.CLICKHOUSE_PASSWORD ?? "",
  });
  try {
    await writeObservableFixture(path);
    const first = await importKday(database, path, "America/New_York");
    expect(first).toMatchObject({
      alreadyImported: false,
      alprReads: 1,
      networkEvents: 1,
      smsRecords: 1,
      callRecords: 1,
      callHandovers: 1,
      bankTransactions: 1,
    });
    const countsResult = await database.client.query({
      query: `SELECT table_name, rows FROM (
        SELECT 'alpr_reads' AS table_name, count() AS rows FROM ${table(database, "alpr_reads")} FINAL
        UNION ALL SELECT 'network_events', count() FROM ${table(database, "network_events")} FINAL
        UNION ALL SELECT 'sms_records', count() FROM ${table(database, "sms_records")} FINAL
        UNION ALL SELECT 'call_records', count() FROM ${table(database, "call_records")} FINAL
        UNION ALL SELECT 'call_handovers', count() FROM ${table(database, "call_handovers")} FINAL
        UNION ALL SELECT 'bank_transactions', count() FROM ${table(database, "bank_transactions")} FINAL
        UNION ALL SELECT 'ingested_days', count() FROM ${table(database, "ingested_days")} FINAL
      )`,
      format: "JSONEachRow",
    });
    const counts = await countsResult.json<{ table_name: string; rows: string }>();
    expect(Object.fromEntries(counts.map((row) => [row.table_name, Number(row.rows)]))).toEqual({
      alpr_reads: 1,
      network_events: 1,
      sms_records: 1,
      call_records: 1,
      call_handovers: 1,
      bank_transactions: 1,
      ingested_days: 1,
    });

    const deltaPath = join(directory, "fixture.kdiff");
    await writeAmountScenarioFixture(path, deltaPath);
    const scenario = await importScenario(database, deltaPath, "America/New_York");
    expect(scenario).toMatchObject({
      alreadyImported: false,
      tables: {
        alpr_reads: { deleted: 0, inserted: 0 },
        network_events: { deleted: 0, inserted: 0 },
        sms_records: { deleted: 0, inserted: 0 },
        call_records: { deleted: 0, inserted: 0 },
        call_handovers: { deleted: 0, inserted: 0 },
        bank_transactions: { deleted: 1, inserted: 1 },
      },
    });
    expect((await importScenario(database, deltaPath, "America/New_York")).alreadyImported).toBe(true);
    const scenarioState = await database.client.query({
      query: `SELECT amount FROM ${table(database, "bank_transactions")} FINAL`,
      format: "JSONEachRow",
    });
    expect((await scenarioState.json<{ amount: string }>()).map((row) => Number(row.amount))).toEqual([19.75]);

    const reverted = await revertScenario(database, scenario.date);
    expect(reverted).toMatchObject({
      date: scenario.date,
      tables: {
        alpr_reads: { deleted: 0, restored: 0 },
        network_events: { deleted: 0, restored: 0 },
        sms_records: { deleted: 0, restored: 0 },
        call_records: { deleted: 0, restored: 0 },
        call_handovers: { deleted: 0, restored: 0 },
        bank_transactions: { deleted: 1, restored: 1 },
      },
    });
    const restoredState = await database.client.query({
      query: `SELECT amount FROM ${table(database, "bank_transactions")} FINAL`,
      format: "JSONEachRow",
    });
    expect((await restoredState.json<{ amount: string }>()).map((row) => Number(row.amount))).toEqual([12.5]);
    const clearedMarkers = await database.client.query({
      query: `SELECT count() AS rows FROM ${table(database, "active_scenarios")} FINAL`,
      format: "JSONEachRow",
    });
    expect(Number((await clearedMarkers.json<{ rows: string }>())[0]?.rows)).toBe(0);
    await expect(revertScenario(database, scenario.date)).rejects.toThrow("no scenario is active");
    // A reverted day accepts a scenario again, which is the whole point of swapping one for another.
    expect((await importScenario(database, deltaPath, "America/New_York")).alreadyImported).toBe(false);
    await revertScenario(database, scenario.date);

    const changedPath = join(directory, "fixture-changed.bin");
    const changed = await readFile(path);
    const merchant = changed.indexOf("Market");
    expect(merchant).toBeGreaterThan(-1);
    changed[merchant] = "N".charCodeAt(0);
    await writeFile(changedPath, changed);
    const appended = await importKday(database, changedPath, "America/New_York", undefined, undefined, {
      tables: ["alpr_reads"], mode: "append",
    });
    expect(appended).toMatchObject({ alprReads: 1, networkEvents: 0 });
    const appendedCount = await database.client.query({
      query: `SELECT count() AS rows FROM ${table(database, "alpr_reads")} FINAL`,
      format: "JSONEachRow",
    });
    expect(Number((await appendedCount.json<{ rows: string }>())[0]?.rows)).toBe(2);

    const overwritten = await importKday(database, path, "America/New_York", undefined, undefined, {
      tables: ["alpr_reads"], mode: "overwrite",
    });
    expect(overwritten).toMatchObject({ alprReads: 1, networkEvents: 0 });
    const selectiveCounts = await database.client.query({
      query: `SELECT table_name, rows FROM (
        SELECT 'alpr_reads' AS table_name, count() AS rows FROM ${table(database, "alpr_reads")} FINAL
        UNION ALL SELECT 'network_events', count() FROM ${table(database, "network_events")} FINAL
      )`,
      format: "JSONEachRow",
    });
    expect(Object.fromEntries(
      (await selectiveCounts.json<{ table_name: string; rows: string }>())
        .map((row) => [row.table_name, Number(row.rows)]),
    )).toEqual({ alpr_reads: 1, network_events: 1 });

    expect((await importKday(database, path, "America/New_York")).alreadyImported).toBe(true);
  } finally {
    if (!configuredDatabase) {
      await database.client.command({ query: `DROP DATABASE IF EXISTS \`${databaseName}\`` }).catch(() => {});
    }
    await database.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

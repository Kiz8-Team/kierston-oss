import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStatic, staticTable } from "../src/static-database.ts";
import { importStaticRecords } from "../src/static-importer.ts";
import { writeStaticFixture } from "./static-fixture.ts";

const postgresUrl = process.env.FASTGATE_TEST_POSTGRES_URL;

test.skipIf(!postgresUrl)("atomically replaces static records in PostgreSQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-static-database-test-"));
  const path = join(directory, "sim_init.bin");
  const schema = `fastgate_test_${process.pid}_${Date.now()}`;
  const database = connectStatic({ url: postgresUrl!, schema });
  try {
    await writeStaticFixture(path);
    const first = await importStaticRecords(database, path);
    expect(first).toMatchObject({ records: 4 });
    expect(first.tables).toEqual({
      identity_registry_people: 2,
      carrier_devices: 1,
      carrier_accounts: 1,
    });

    const result = await database.pool.query<{
      subscriber_first_name: string;
      subscriber_last_name: string;
      account_holder_first_name: string;
      account_holder_ssn: string | null;
      carrier: string;
      plan_type: string;
    }>({
      text: `SELECT subscriber_first_name, subscriber_last_name,
          account_holder_first_name, account_holder_ssn, carrier, plan_type
        FROM ${staticTable(database, "carrier_accounts")}`,
    });
    expect(result.rows).toEqual([{
      subscriber_first_name: "Ada",
      subscriber_last_name: "Lovelace",
      account_holder_first_name: "Grace",
      account_holder_ssn: null,
      carrier: "Carrier One",
      plan_type: "postpaid",
    }]);
    const columns = await database.pool.query<{ column_name: string }>({
      text: `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'carrier_accounts'`,
      values: [schema],
    });
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("person");
    expect(names).not.toContain("user");
    expect(names).not.toContain("account_holder");
    expect(names).not.toContain("record");
    expect(names).not.toContain("identity_record_index");

    const deviceColumns = await database.pool.query<{ column_name: string }>({
      text: `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'carrier_devices'`,
      values: [schema],
    });
    expect(deviceColumns.rows.map((row) => row.column_name).sort()).toEqual([
      "_record_index", "imei", "model",
    ]);

    const people = await database.pool.query<{
      first_name: string;
      taxpayer_id_kind: string;
      taxpayer_id: string;
      ssn: string | null;
    }>({
      text: `SELECT first_name, taxpayer_id_kind, taxpayer_id, ssn
        FROM ${staticTable(database, "identity_registry_people")}
        ORDER BY _record_index`,
    });
    expect(people.rows).toEqual([
      { first_name: "Ada", taxpayer_id_kind: "ssn", taxpayer_id: "111-22-3333", ssn: "111-22-3333" },
      { first_name: "Grace", taxpayer_id_kind: "itin", taxpayer_id: "444-55-6666", ssn: null },
    ]);
    const prohibited = await database.pool.query<{ column_name: string }>({
      text: `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'identity_registry_people'
          AND column_name = 'worker_class'`,
      values: [schema],
    });
    expect(prohibited.rows).toEqual([]);

    const primaryKey = await database.pool.query<{ column_name: string }>({
      text: `SELECT attribute.attname AS column_name
        FROM pg_index index
        JOIN pg_class relation ON relation.oid = index.indrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN unnest(index.indkey) WITH ORDINALITY key(attnum, position) ON true
        JOIN pg_attribute attribute
          ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
        WHERE namespace.nspname = $1
          AND relation.relname = 'identity_registry_people'
          AND index.indisprimary
        ORDER BY key.position`,
      values: [schema],
    });
    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(["_record_index"]);

    await database.pool.query(`CREATE TABLE ${staticTable(database, "dot_vehicle_registrations")} (
      plate Text, registered_owner_first_name Text, registered_owner_middle_name Text,
      registered_owner_last_name Text, registered_owner_date_of_birth Text
    )`);
    await database.pool.query({
      text: `INSERT INTO ${staticTable(database, "carrier_devices")} (_record_index, imei, model)
        VALUES ($1, $2, $3)`,
      values: [99, "999999999999999", "Preserved Phone"],
    });
    const overwritten = await importStaticRecords(database, path, undefined, {
      tables: ["carrier_accounts"], mode: "overwrite",
    });
    expect(overwritten.tables).toEqual({ carrier_accounts: 1 });
    expect((await database.pool.query(
      `SELECT count(*)::int AS count FROM ${staticTable(database, "carrier_devices")}`,
    )).rows[0]?.count).toBe(2);

    const appended = await importStaticRecords(database, path, undefined, {
      tables: ["carrier_accounts"], mode: "append",
    });
    expect(appended.tables).toEqual({ carrier_accounts: 1 });
    expect((await database.pool.query(
      `SELECT _record_index::int AS index FROM ${staticTable(database, "carrier_accounts")} ORDER BY _record_index`,
    )).rows).toEqual([{ index: 0 }, { index: 1 }]);

    expect((await importStaticRecords(database, path)).records).toBe(4);
  } finally {
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await database.end();
    await rm(directory, { recursive: true, force: true });
  }
});

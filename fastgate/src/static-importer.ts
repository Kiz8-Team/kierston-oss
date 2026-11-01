import type { PoolClient } from "pg";
import {
  omittedProviderRecord, PROVIDER_TABLES, providerTable,
  type IdentityRole, type ProviderTable,
} from "./static-catalog.ts";
import { initializeStaticSchema, staticTable, type StaticDatabase } from "./static-database.ts";
import { postgresIdentifier } from "./static-schema.ts";
import {
  StaticContainerReader, StaticRecordSet,
  type DecodedStaticRecord, type FieldKind, type TableSpec,
} from "./static-records.ts";
import { resolveTableImport, type TableImportOptions } from "./import-options.ts";
import type { ProgressHandler } from "./progress.ts";

export interface StaticImportSummary {
  containerDigest: string;
  tables: Record<string, number>;
  records: number;
}

interface IdentitySnapshot {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  ssn: string | null;
}

interface ProviderColumn {
  name: string;
  type: string;
}

type ProviderRow = Record<string, unknown> & { _record_index: number };

function importSummary(
  reader: StaticContainerReader,
  tables: Record<string, number> = {},
): StaticImportSummary {
  return {
    containerDigest: reader.meta.digest,
    tables,
    records: Object.values(tables).reduce((total, count) => total + count, 0),
  };
}

function sourceType(kind: FieldKind): string {
  if (kind === "bool") return "Boolean";
  if (kind === "rate") return "Real";
  if (kind === "money") return "Numeric(18, 2)";
  if (kind === "list") return "Text[]";
  if (kind === "enum" || kind === "str" || kind === "date") return "Text";
  return "Integer";
}

function identityColumns(role: IdentityRole): ProviderColumn[] {
  const columns: ProviderColumn[] = [
    { name: `${role.prefix}first_name`, type: "Text" },
    { name: `${role.prefix}middle_name`, type: "Text" },
    { name: `${role.prefix}last_name`, type: "Text" },
  ];
  if (role.detail !== "name") columns.push({ name: `${role.prefix}date_of_birth`, type: "Text" });
  if (role.detail === "ssn") columns.push({ name: `${role.prefix}ssn`, type: "Text" });
  return columns;
}

function providerColumns(owner: ProviderTable, source: TableSpec): ProviderColumn[] {
  const columns: ProviderColumn[] = [{ name: "_record_index", type: "Bigint" }];
  const omitted = new Set(owner.omittedColumns ?? []);
  if (owner.parentColumn) columns.push({ name: owner.parentColumn, type: "Bigint" });
  for (const role of owner.identities) columns.push(...identityColumns(role));
  if (owner.derivedSsn) columns.push({ name: "ssn", type: "Text" });
  for (const field of source.fields) {
    // KREC ids are simulator joins. Provider datasets get copied identities,
    // never a universal resident key that joins every provider back together.
    if (field.kind !== "id" && !omitted.has(field.name)) {
      columns.push({
        name: field.name,
        type: sourceType(field.kind),
      });
    }
  }
  const names = new Set<string>();
  for (const column of columns) {
    postgresIdentifier(column.name);
    if (names.has(column.name)) throw new Error(`${owner.table} has duplicate column ${column.name}`);
    names.add(column.name);
  }
  return columns;
}

async function initializeProviderTable(
  client: PoolClient,
  database: StaticDatabase,
  owner: ProviderTable,
  source: TableSpec,
  ifNotExists = false,
): Promise<ProviderColumn[]> {
  const columns = providerColumns(owner, source);
  const table = staticTable(database, owner.table);
  const declarations = columns
    .map((column) => `${postgresIdentifier(column.name)} ${column.type}`)
    .join(",\n        ");
  await client.query(`CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
    ${declarations},
    PRIMARY KEY (_record_index)
  )`);

  let index = 0;
  for (const role of owner.identities) {
    const identity = [
      `${role.prefix}last_name`, `${role.prefix}first_name`,
      ...(role.detail === "name" ? [] : [`${role.prefix}date_of_birth`]),
    ];
    index += 1;
    await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier(`${owner.table}_lookup_${index}_idx`)}
      ON ${table} (${identity.map(postgresIdentifier).join(", ")})`);
    if (role.detail === "ssn") {
      index += 1;
      const ssn = `${role.prefix}ssn`;
      await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier(`${owner.table}_lookup_${index}_idx`)}
        ON ${table} (${postgresIdentifier(ssn)}) WHERE ${postgresIdentifier(ssn)} IS NOT NULL`);
    }
  }
  const available = new Set(columns.map((column) => column.name));
  for (const fields of owner.indexes ?? []) {
    if (!fields.every((field) => available.has(field))) continue;
    index += 1;
    await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier(`${owner.table}_lookup_${index}_idx`)}
      ON ${table} (${fields.map(postgresIdentifier).join(", ")})`);
  }
  return columns;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildIdentities(records: StaticRecordSet): Map<number, IdentitySnapshot> {
  const identities = new Map<number, IdentitySnapshot>();
  for (const row of records.records()) {
    if (row.recordType !== "identity") continue;
    const kind = text(row.record.taxpayer_id_kind)?.toLowerCase();
    identities.set(row.recordIndex, {
      firstName: text(row.record.first_name),
      middleName: text(row.record.middle_name),
      lastName: text(row.record.surname),
      dateOfBirth: text(row.record.birth_date),
      ssn: kind === "ssn" ? text(row.record.taxpayer_id) : null,
    });
  }
  return identities;
}

function identityId(role: IdentityRole, row: DecodedStaticRecord): number | null {
  if (role.source === "row") return row.recordIndex;
  if (role.source === "vehicle_owner") {
    return row.record.owner_type === "person" && typeof row.record.owner === "number"
      ? row.record.owner : null;
  }
  const value = row.record[role.source];
  return typeof value === "number" ? value : null;
}

function copyIdentity(
  output: ProviderRow,
  role: IdentityRole,
  row: DecodedStaticRecord,
  identities: ReadonlyMap<number, IdentitySnapshot>,
): void {
  const id = identityId(role, row);
  const identity = id === null ? null : identities.get(id);
  if (id !== null && !identity) throw new Error(`${row.dataset}.${row.recordType} references unknown person ${id}`);
  output[`${role.prefix}first_name`] = identity?.firstName ?? null;
  output[`${role.prefix}middle_name`] = identity?.middleName ?? null;
  output[`${role.prefix}last_name`] = identity?.lastName ?? null;
  if (role.detail !== "name") output[`${role.prefix}date_of_birth`] = identity?.dateOfBirth ?? null;
  if (role.detail === "ssn") output[`${role.prefix}ssn`] = identity?.ssn ?? null;
}

function providerRow(
  owner: ProviderTable,
  source: TableSpec,
  row: DecodedStaticRecord,
  identities: ReadonlyMap<number, IdentitySnapshot>,
  selectedTables: ReadonlySet<string>,
  offsets: ReadonlyMap<string, number>,
): ProviderRow {
  const output: ProviderRow = { _record_index: row.recordIndex + (offsets.get(owner.table) ?? 0) };
  const omitted = new Set(owner.omittedColumns ?? []);
  if (owner.parentColumn) {
    let parentOffset = 0;
    if (row.parent) {
      const parent = providerTable(row.dataset, row.parent.recordType);
      if (selectedTables.has(parent.table)) parentOffset = offsets.get(parent.table) ?? 0;
    }
    output[owner.parentColumn] = row.parent ? row.parent.recordIndex + parentOffset : null;
  }
  for (const role of owner.identities) copyIdentity(output, role, row, identities);
  if (owner.derivedSsn) {
    output.ssn = row.record.taxpayer_id_kind === "ssn" ? row.record.taxpayer_id ?? null : null;
  }
  for (const field of source.fields) {
    if (field.kind !== "id" && !omitted.has(field.name)) {
      output[field.name] = row.record[field.name] ?? null;
    }
  }
  return output;
}

async function insertProviderBatch(
  client: PoolClient,
  database: StaticDatabase,
  owner: ProviderTable,
  columns: readonly ProviderColumn[],
  rows: readonly ProviderRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const table = staticTable(database, owner.table);
  const names = columns.map((column) => postgresIdentifier(column.name));
  const definitions = columns
    .map((column) => `${postgresIdentifier(column.name)} ${column.type}`)
    .join(", ");
  await client.query({
    text: `INSERT INTO ${table} (${names.join(", ")})
      SELECT ${names.map((name) => `item.${name}`).join(", ")}
      FROM jsonb_to_recordset($1::jsonb) AS item(${definitions})`,
    values: [JSON.stringify(rows)],
  });
}

export async function importStaticRecords(
  database: StaticDatabase,
  path: string,
  progress?: ProgressHandler,
  options?: TableImportOptions,
): Promise<StaticImportSummary> {
  const selection = resolveTableImport(
    PROVIDER_TABLES.map((owner) => owner.table),
    options,
    "overwrite",
  );
  progress?.({ stage: "schema", label: "Initializing PostgreSQL provider schema" });
  await initializeStaticSchema(database);
  const reader = await StaticContainerReader.open(path);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${database.schema}.static-import`]);

    const sections = reader.recordSections();
    if (sections.length === 0) throw new Error("KSIM contains no KREC provider-record sections");
    const identitySection = sections.find((section) => section.name === "identity");
    if (!identitySection) throw new Error("KSIM is missing identity records needed for provider copies");
    let identityRecords: StaticRecordSet | null = StaticRecordSet.decode(await reader.section(identitySection));
    const identities = buildIdentities(identityRecords);
    const headers = await Promise.all(sections.map((section) => reader.recordMeta(section)));
    const availableTables = new Set(headers.flatMap((header) => header.tables
      .filter((source) => !omittedProviderRecord(header.dataset, source.name))
      .map((source) => providerTable(header.dataset, source.name).table)));
    if (options?.tables !== undefined) {
      const unavailable = [...selection.tables].filter((name) => !availableTables.has(name));
      if (unavailable.length > 0) {
        throw new Error(
          `selected table${unavailable.length === 1 ? "" : "s"} not found in source: ${unavailable.join(", ")}`,
        );
      }
    }
    const total = headers.reduce((count, header) => count + header.tables.reduce((sum, source) => {
      if (omittedProviderRecord(header.dataset, source.name)) return sum;
      return sum + (selection.tables.has(providerTable(header.dataset, source.name).table) ? source.rows : 0);
    }, 0), 0);
    const tables: Record<string, number> = {};
    const offsets = new Map<string, number>();

    // Preserve the original full-snapshot behavior. Explicit overwrites below
    // truncate only their selected tables so table metadata and grants remain.
    for (const owner of PROVIDER_TABLES) {
      if (!selection.explicit && selection.mode === "overwrite" && selection.tables.has(owner.table)) {
        await client.query(`DROP TABLE IF EXISTS ${staticTable(database, owner.table)}`);
      }
    }
    // A traditional full import also cleans up the old provenance-bearing model.
    if (!selection.explicit && selection.mode === "overwrite") {
      await client.query(`DROP TABLE IF EXISTS ${staticTable(database, "bank_customer_payment_profiles")}`);
      await client.query(`DROP TABLE IF EXISTS ${staticTable(database, "active_static_import")}`);
      await client.query(`DROP TABLE IF EXISTS ${staticTable(database, "static_imports")}`);
    }

    let completed = 0;
    for (const section of sections) {
      progress?.({ stage: "extract", label: `Reading ${section.name} provider records` });
      const records = section === identitySection && identityRecords
        ? identityRecords : StaticRecordSet.decode(await reader.section(section));
      identityRecords = null;
      if (records.meta.dataset !== section.name) {
        throw new Error(`${section.name} section contains ${records.meta.dataset} records`);
      }
      const sourceTables = new Map(records.meta.tables.map((table) => [table.name, table]));
      const prepared = new Map<string, { owner: ProviderTable; columns: ProviderColumn[] }>();
      for (const source of records.meta.tables) {
        if (omittedProviderRecord(records.meta.dataset, source.name)) continue;
        const owner = providerTable(records.meta.dataset, source.name);
        if (!selection.tables.has(owner.table)) continue;
        const columns = await initializeProviderTable(
          client, database, owner, source, selection.mode === "append" || selection.explicit,
        );
        if (selection.mode === "overwrite" && selection.explicit) {
          await client.query(`TRUNCATE TABLE ${staticTable(database, owner.table)}`);
        }
        prepared.set(source.name, { owner, columns });
        tables[owner.table] = 0;
        if (selection.mode === "append") {
          const result = await client.query<{ offset: string }>(
            `SELECT COALESCE(MAX(_record_index), -1) + 1 AS offset FROM ${staticTable(database, owner.table)}`,
          );
          const offset = Number(result.rows[0]?.offset ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new Error(`${owner.table} has an unsupported _record_index offset`);
          }
          offsets.set(owner.table, offset);
        }
      }

      let activeType = "";
      let batch: ProviderRow[] = [];
      let processed = 0;
      const flush = async (): Promise<void> => {
        if (batch.length > 0) {
          const target = prepared.get(activeType)!;
          await insertProviderBatch(client, database, target.owner, target.columns, batch);
        }
        completed += processed;
        progress?.({ stage: "insert", label: "Writing provider tables", completed, total });
        batch = [];
        processed = 0;
      };
      for (const row of records.records()) {
        if (activeType && row.recordType !== activeType) await flush();
        activeType = row.recordType;
        if (omittedProviderRecord(records.meta.dataset, activeType)) continue;
        const target = prepared.get(activeType);
        if (!target) continue;
        processed += 1;
        const source = sourceTables.get(activeType);
        if (!source) throw new Error(`unprepared provider table ${records.meta.dataset}.${activeType}`);
        batch.push(providerRow(target.owner, source, row, identities, selection.tables, offsets));
        tables[target.owner.table] = (tables[target.owner.table] ?? 0) + 1;
        if (batch.length === 1_000) await flush();
      }
      await flush();
    }

    await client.query("COMMIT");
    progress?.({ stage: "complete", label: "Imported provider-owned static records" });
    return importSummary(reader, tables);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await reader.close();
  }
}

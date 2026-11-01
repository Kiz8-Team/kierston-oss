import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { expect, test } from "bun:test";
import { ALPR_CAMERA_COLUMNS } from "../../../fastgate/src/camera-importer.ts";
import {
  CELL_SITE_COLUMNS,
  CELL_STRUCTURE_COLUMNS,
} from "../../../fastgate/src/cell-importer.ts";
import { PROVIDER_TABLES } from "../../../fastgate/src/static-catalog.ts";
import { StaticContainerReader } from "../../../fastgate/src/static-records.ts";
import { schemaSql } from "../../../fastgate/src/schema.ts";
import { DATABASES, publicCatalog } from "../src/catalog.ts";
import type { QueryDef } from "../src/catalog-types.ts";

const STATIC_CONTAINER = resolvePath(import.meta.dir, "../../../kierston/sim_data/sim_init.bin");
const CLICKHOUSE_CONTROL_TABLES = new Set(["ingested_days", "active_scenarios", "scenario_journal"]);

function clickHouseSchemas(): Map<string, Set<string>> {
  const schemas = new Map<string, Set<string>>();
  for (const statement of schemaSql("kdi_contract")) {
    const table = statement.match(/CREATE TABLE IF NOT EXISTS `kdi_contract`\.(\w+)/)?.[1];
    const body = statement.match(/CREATE TABLE IF NOT EXISTS `kdi_contract`\.\w+ \(([\s\S]*?)\) ENGINE/)?.[1];
    if (!table || !body) continue;
    schemas.set(table, new Set(
      body.split(",\n").map((line) => line.trim().match(/^(\w+)\s/)?.[1]).filter((name): name is string => !!name),
    ));
  }
  return schemas;
}

function explicitPostgresSchemas(): Map<string, Set<string>> {
  return new Map<string, Set<string>>([
    ["alpr_cameras", new Set<string>(ALPR_CAMERA_COLUMNS.map(([name]) => name))],
    ["carrier_cell_sites", new Set<string>(CELL_SITE_COLUMNS.map(([name]) => name))],
    ["carrier_structures", new Set<string>(CELL_STRUCTURE_COLUMNS.map(([name]) => name))],
  ]);
}

function orderColumns(order: string | undefined): string[] {
  return order?.split(",").map((term) => term.trim().split(/\s+/)[0]!.replaceAll('"', "")) ?? [];
}

function referencedColumns(query: QueryDef): Set<string> {
  return new Set([
    ...query.select.map((column) => column.name),
    ...query.match.flatMap((match) => match.columns),
    ...orderColumns(query.order),
  ]);
}

function expectQueriesToMatch(schemas: ReadonlyMap<string, ReadonlySet<string>>, store: QueryDef["store"]): void {
  for (const database of DATABASES) {
    for (const query of database.queries) {
      if (query.store !== store || !schemas.has(query.table)) continue;
      const columns = schemas.get(query.table)!;
      const missing = [...referencedColumns(query)].filter((column) => !columns.has(column));
      expect(missing, `${database.id}.${query.id} references missing ${query.table} columns`).toEqual([]);
    }
  }
}

test("catalog matches the explicit ClickHouse and PostgreSQL schemas", () => {
  const clickhouse = clickHouseSchemas();
  const postgres = explicitPostgresSchemas();
  const clickhouseCatalogTables = new Set(
    DATABASES.flatMap((database) => database.queries)
      .filter((query) => query.store === "clickhouse")
      .map((query) => query.table),
  );
  const postgresCatalogTables = new Set(
    DATABASES.flatMap((database) => database.queries)
      .filter((query) => query.store === "postgres")
      .map((query) => query.table),
  );

  expect(clickhouseCatalogTables).toEqual(
    new Set([...clickhouse.keys()].filter((table) => !CLICKHOUSE_CONTROL_TABLES.has(table))),
  );
  for (const table of postgres.keys()) expect(postgresCatalogTables.has(table), `${table} has no catalog query`).toBe(true);
  expectQueriesToMatch(clickhouse, "clickhouse");
  expectQueriesToMatch(postgres, "postgres");
});

test("catalog does not expose simulation-only metadata", () => {
  const exposed = new Set(
    DATABASES.flatMap((database) => database.queries)
      .flatMap((query) => query.select.map((column) => `${query.table}.${column.name}`)),
  );
  expect(exposed).not.toContain("identity_registry_people.line_paternal");
  expect(exposed).not.toContain("identity_registry_people.line_maternal");
  expect(exposed).not.toContain("identity_registry_people.naming_group");
  expect(exposed).not.toContain("corrections_statuses.offending_class");
  expect(exposed).not.toContain("carrier_structures.source");
  expect(exposed).not.toContain("alpr_cameras.daily_passes");
  expect(exposed).not.toContain("alpr_cameras.distinct_drivers");
  expect(exposed).not.toContain("alpr_cameras.source_day");
  for (const column of [
    "occupation_code", "soc_code", "industry_code", "worker_class", "weekly_hours", "job_role",
    "education_attainment", "currently_enrolled", "school_id", "school_name", "school_grade", "school_sector",
    "marital_married_last_year", "marital_divorced_last_year", "marital_widowed_last_year",
  ]) expect(exposed).not.toContain(`identity_registry_people.${column}`);
});

test("public catalog advertises typed filters without result caps or summaries", () => {
  for (const database of DATABASES) {
    for (const query of database.queries) {
      const publicQuery = publicCatalog()
        .find((entry) => entry.id === database.id)!.queries.find((entry) => entry.id === query.id)!;
      expect(publicQuery.filters.length).toBeGreaterThan(0);
      expect(publicQuery).not.toHaveProperty("limit");
      expect(publicQuery).not.toHaveProperty("groupable");
      expect(publicQuery).not.toHaveProperty("metrics");
    }
  }
});

test.skipIf(!existsSync(STATIC_CONTAINER))(
  "catalog matches the provider schema in the current static container",
  async () => {
    const reader = await StaticContainerReader.open(STATIC_CONTAINER);
    try {
      const sources = new Map<string, Awaited<ReturnType<typeof reader.recordMeta>>["tables"][number]>();
      for (const section of reader.recordSections()) {
        const meta = await reader.recordMeta(section);
        for (const source of meta.tables) sources.set(`${meta.dataset}\0${source.name}`, source);
      }

      const schemas = new Map<string, Set<string>>();
      for (const owner of PROVIDER_TABLES) {
        const source = sources.get(`${owner.dataset}\0${owner.recordType}`);
        expect(source, `static container is missing ${owner.dataset}.${owner.recordType}`).toBeDefined();
        const columns = new Set(["_record_index"]);
        if (owner.parentColumn) columns.add(owner.parentColumn);
        for (const role of owner.identities) {
          columns.add(`${role.prefix}first_name`);
          columns.add(`${role.prefix}middle_name`);
          columns.add(`${role.prefix}last_name`);
          if (role.detail !== "name") columns.add(`${role.prefix}date_of_birth`);
          if (role.detail === "ssn") columns.add(`${role.prefix}ssn`);
        }
        if (owner.derivedSsn) columns.add("ssn");
        for (const field of source!.fields) {
          if (field.kind !== "id") columns.add(field.name);
        }
        schemas.set(owner.table, columns);
      }

      const catalogTables = new Set(
        DATABASES.flatMap((database) => database.queries)
          .filter((query) => query.store === "postgres")
          .map((query) => query.table),
      );
      for (const table of schemas.keys()) expect(catalogTables.has(table), `${table} has no catalog query`).toBe(true);
      expectQueriesToMatch(schemas, "postgres");
    } finally {
      await reader.close();
    }
  },
);

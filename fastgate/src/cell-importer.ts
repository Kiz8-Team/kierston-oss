import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { resolveTableImport, type ImportMode, type TableImportOptions } from "./import-options.ts";
import type { ProgressHandler } from "./progress.ts";
import { initializeStaticSchema, staticTable, type StaticDatabase } from "./static-database.ts";
import { postgresIdentifier } from "./static-schema.ts";

export const CELL_SITE_TABLE = "carrier_cell_sites";
export const CELL_STRUCTURE_TABLE = "carrier_structures";
export const CELL_TABLES = [CELL_STRUCTURE_TABLE, CELL_SITE_TABLE] as const;

export interface CellImportSummary {
  mode: ImportMode;
  tables: Record<string, number>;
}

interface TowerFile {
  city?: unknown;
  seed?: unknown;
  structure_records?: unknown;
  cell_records?: unknown;
}

interface StructureRow extends Record<string, unknown> {
  structure_id: string;
  latitude: number;
  longitude: number;
}

interface CellSiteRow extends Record<string, unknown> {
  cgi: string;
  cell_key: string;
  structure_id: string;
  latitude: number;
  longitude: number;
}

export const CELL_STRUCTURE_COLUMNS = [
  ["structure_id", "Text"],
  ["city", "Text"],
  ["source", "Text"],
  ["asr", "Text"],
  ["latitude", "Double Precision"],
  ["longitude", "Double Precision"],
  ["structure", "Text"],
  ["structure_type", "Text"],
  ["height_m", "Real"],
  ["building_levels", "Integer"],
  ["owner", "Text"],
  ["in_city", "Boolean"],
] as const;

export const CELL_SITE_COLUMNS = [
  ["cgi", "Text"],
  ["cell_key", "Text"],
  ["structure_id", "Text"],
  ["city", "Text"],
  ["operator", "Text"],
  ["operator_key", "Text"],
  ["mcc", "Text"],
  ["mnc", "Text"],
  ["radio", "Text"],
  ["band", "Text"],
  ["role", "Text"],
  ["frequency_mhz", "Real"],
  ["station_id", "Bigint"],
  ["cell_id", "Bigint"],
  ["identity", "Bigint"],
  ["tracking_area", "Bigint"],
  ["sector", "Integer"],
  ["azimuth", "Real"],
  ["beamwidth", "Real"],
  ["downtilt", "Real"],
  ["height_m", "Real"],
  ["eirp_dbm", "Real"],
  ["range_m", "Real"],
  ["morphology", "Text"],
  ["latitude", "Double Precision"],
  ["longitude", "Double Precision"],
  ["pci", "Integer"],
] as const;

const STRUCTURE_REQUIRED = ["structure_id", "city", "latitude", "longitude"];
const CELL_REQUIRED = ["cgi", "cell_key", "structure_id", "city", "latitude", "longitude"];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function towerRows(value: unknown): { structures: StructureRow[]; cells: CellSiteRow[] } {
  const source = record(value, "tower inventory") as TowerFile;
  const city = requiredString(source.city, "city");
  if (!Array.isArray(source.structure_records)) throw new Error("structure_records must be an array");
  if (!Array.isArray(source.cell_records)) throw new Error("cell_records must be an array");

  const structures: StructureRow[] = [];
  const ids = new Set<string>();
  for (const value of source.structure_records) {
    const structure = record(value, "structure record");
    const id = requiredString(structure.id, "structure id");
    if (ids.has(id)) throw new Error(`duplicate structure ${id}`);
    ids.add(id);
    structures.push({
      structure_id: id,
      city,
      source: optionalString(structure.source),
      asr: optionalString(structure.asr),
      latitude: requiredNumber(structure.lat, `${id} latitude`),
      longitude: requiredNumber(structure.lon, `${id} longitude`),
      structure: optionalString(structure.structure),
      structure_type: optionalString(structure.structure_type),
      height_m: optionalNumber(structure.height_m),
      building_levels: optionalNumber(structure.building_levels),
      owner: optionalString(structure.owner),
      in_city: optionalBoolean(structure.in_city),
    });
  }

  const cells: CellSiteRow[] = [];
  const seen = new Set<string>();
  for (const value of source.cell_records) {
    const cell = record(value, "cell record");
    const key = requiredString(cell.id, "cell id");
    const cgi = requiredString(cell.cgi, `${key} cgi`);
    if (seen.has(cgi)) throw new Error(`duplicate CGI ${cgi}`);
    seen.add(cgi);
    const structureId = requiredString(cell.structure, `${key} structure`);
    if (!ids.has(structureId)) throw new Error(`${key} references unknown structure ${structureId}`);
    cells.push({
      cgi,
      cell_key: key,
      structure_id: structureId,
      city,
      operator: optionalString(cell.operator),
      operator_key: optionalString(cell.operator_key),
      mcc: optionalString(cell.mcc),
      mnc: optionalString(cell.mnc),
      radio: optionalString(cell.radio),
      band: optionalString(cell.band),
      role: optionalString(cell.role),
      frequency_mhz: optionalNumber(cell.frequency_mhz),
      station_id: optionalNumber(cell.station_id),
      cell_id: optionalNumber(cell.cell_id),
      identity: optionalNumber(cell.identity),
      tracking_area: optionalNumber(cell.tracking_area),
      sector: optionalNumber(cell.sector),
      azimuth: optionalNumber(cell.azimuth),
      beamwidth: optionalNumber(cell.beamwidth),
      downtilt: optionalNumber(cell.downtilt),
      height_m: optionalNumber(cell.height_m),
      eirp_dbm: optionalNumber(cell.eirp_dbm),
      range_m: optionalNumber(cell.range_m),
      morphology: optionalString(cell.morphology),
      latitude: requiredNumber(cell.lat, `${key} latitude`),
      longitude: requiredNumber(cell.lon, `${key} longitude`),
      pci: optionalNumber(cell.pci),
    });
  }

  return { structures, cells };
}

function declarations(
  columns: readonly (readonly [string, string])[], required: readonly string[],
): string {
  return columns.map(([name, type]) =>
    `${postgresIdentifier(name)} ${type}${required.includes(name) ? " NOT NULL" : ""}`,
  ).join(",\n      ");
}

async function initializeCellTables(client: PoolClient, database: StaticDatabase): Promise<void> {
  const structures = staticTable(database, CELL_STRUCTURE_TABLE);
  const cells = staticTable(database, CELL_SITE_TABLE);
  await client.query(`CREATE TABLE IF NOT EXISTS ${structures} (
      ${declarations(CELL_STRUCTURE_COLUMNS, STRUCTURE_REQUIRED)},
      PRIMARY KEY (structure_id)
    )`);
  // The sectors on one mast share its location, so the reference is what keeps
  // a cell from outliving the structure it is bolted to.
  await client.query(`CREATE TABLE IF NOT EXISTS ${cells} (
      ${declarations(CELL_SITE_COLUMNS, CELL_REQUIRED)},
      PRIMARY KEY (cgi),
      FOREIGN KEY (structure_id) REFERENCES ${structures} (structure_id) ON DELETE CASCADE
    )`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("carrier_cell_sites_location_idx")}
    ON ${cells} (latitude, longitude)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("carrier_cell_sites_structure_idx")}
    ON ${cells} (structure_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("carrier_cell_sites_operator_idx")}
    ON ${cells} (operator_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("carrier_cell_sites_area_idx")}
    ON ${cells} (tracking_area)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("carrier_structures_location_idx")}
    ON ${structures} (latitude, longitude)`);
}

async function insertRows(
  client: PoolClient,
  database: StaticDatabase,
  name: string,
  columns: readonly (readonly [string, string])[],
  key: string,
  rows: readonly Record<string, unknown>[],
  mode: ImportMode,
): Promise<number> {
  if (rows.length === 0) return 0;
  const names = columns.map(([name]) => postgresIdentifier(name));
  const types = columns.map(([name, type]) => `${postgresIdentifier(name)} ${type}`).join(", ");
  const result = await client.query({
    text: `INSERT INTO ${staticTable(database, name)} (${names.join(", ")})
      SELECT ${names.map((name) => `item.${name}`).join(", ")}
      FROM jsonb_to_recordset($1::jsonb) AS item(${types})
      ${mode === "append" ? `ON CONFLICT (${postgresIdentifier(key)}) DO NOTHING` : ""}`,
    values: [JSON.stringify(rows)],
  });
  return result.rowCount ?? 0;
}

export async function importCellSites(
  database: StaticDatabase,
  path: string,
  progress?: ProgressHandler,
  options?: TableImportOptions,
): Promise<CellImportSummary> {
  const selection = resolveTableImport(CELL_TABLES, options, "overwrite");
  await initializeStaticSchema(database);
  progress?.({ stage: "read", label: "Reading tower inventory" });
  const source: unknown = JSON.parse(await readFile(path, "utf8"));
  const { structures, cells } = towerRows(source);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${database.schema}.cell-sites-import`]);
    progress?.({ stage: "schema", label: "Initializing PostgreSQL cell site tables" });
    await initializeCellTables(client, database);
    // Cells reference structures, so they go out first and come back last.
    if (selection.mode === "overwrite") {
      if (selection.tables.has(CELL_SITE_TABLE)) {
        await client.query(`TRUNCATE TABLE ${staticTable(database, CELL_SITE_TABLE)}`);
      }
      if (selection.tables.has(CELL_STRUCTURE_TABLE)) {
        await client.query(`TRUNCATE TABLE ${staticTable(database, CELL_STRUCTURE_TABLE)} CASCADE`);
      }
    }
    const tables: Record<string, number> = {};
    if (selection.tables.has(CELL_STRUCTURE_TABLE)) {
      progress?.({ stage: "insert", label: "Writing structures", completed: 0, total: structures.length });
      tables[CELL_STRUCTURE_TABLE] = await insertRows(
        client, database, CELL_STRUCTURE_TABLE, CELL_STRUCTURE_COLUMNS, "structure_id", structures, selection.mode,
      );
      progress?.({
        stage: "insert", label: "Writing structures", completed: structures.length, total: structures.length,
      });
    }
    if (selection.tables.has(CELL_SITE_TABLE)) {
      progress?.({ stage: "insert", label: "Writing cell sites", completed: 0, total: cells.length });
      tables[CELL_SITE_TABLE] = await insertRows(
        client, database, CELL_SITE_TABLE, CELL_SITE_COLUMNS, "cgi", cells, selection.mode,
      );
      progress?.({ stage: "insert", label: "Writing cell sites", completed: cells.length, total: cells.length });
    }
    await client.query("COMMIT");
    progress?.({ stage: "complete", label: `Imported cell sites (${selection.mode})` });
    return { mode: selection.mode, tables };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

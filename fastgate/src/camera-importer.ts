import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { resolveTableImport, type ImportMode, type TableImportOptions } from "./import-options.ts";
import type { ProgressHandler } from "./progress.ts";
import { initializeStaticSchema, staticTable, type StaticDatabase } from "./static-database.ts";
import { postgresIdentifier } from "./static-schema.ts";

export const ALPR_CAMERA_TABLE = "alpr_cameras";

export interface CameraImportSummary {
  table: typeof ALPR_CAMERA_TABLE;
  mode: ImportMode;
  cameras: number;
  written: number;
}

interface CameraFile {
  city?: unknown;
  sited_from?: { day?: unknown };
  optics?: Record<string, Record<string, unknown>>;
  mount_records?: unknown;
  camera_records?: unknown;
}

interface CameraRow extends Record<string, unknown> {
  camera_id: string;
  city: string;
  mount_id: string;
  latitude: number;
  longitude: number;
}

export const ALPR_CAMERA_COLUMNS = [
  ["camera_id", "Text"],
  ["city", "Text"],
  ["mount_id", "Text"],
  ["latitude", "Double Precision"],
  ["longitude", "Double Precision"],
  ["address", "Text"],
  ["street", "Text"],
  ["site", "Text"],
  ["site_type", "Text"],
  ["role", "Text"],
  ["owner", "Text"],
  ["owner_kind", "Text"],
  ["mount_kind", "Text"],
  ["mount_height_m", "Real"],
  ["reads", "Text"],
  ["azimuth", "Real"],
  ["road_class", "Text"],
  ["edge", "Bigint"],
  ["from_node", "Bigint"],
  ["to_node", "Bigint"],
  ["target_latitude", "Double Precision"],
  ["target_longitude", "Double Precision"],
  ["optics_id", "Text"],
  ["optics_label", "Text"],
  ["capture_width_m", "Real"],
  ["capture_distance_m", "Real"],
  ["capture_fov_deg", "Real"],
  ["network", "Text"],
  ["daily_passes", "Integer"],
  ["distinct_drivers", "Integer"],
  ["free_flow_mps", "Real"],
  ["zone_seconds", "Real"],
  ["site_distance_m", "Real"],
  ["source_day", "Text"],
] as const;

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

export function cameraRows(value: unknown): CameraRow[] {
  const source = record(value, "camera inventory") as CameraFile;
  const city = requiredString(source.city, "city");
  if (!Array.isArray(source.mount_records)) throw new Error("mount_records must be an array");
  if (!Array.isArray(source.camera_records)) throw new Error("camera_records must be an array");

  const mounts = new Map<string, Record<string, unknown>>();
  for (const value of source.mount_records) {
    const mount = record(value, "mount record");
    const id = requiredString(mount.id, "mount id");
    if (mounts.has(id)) throw new Error(`duplicate mount ${id}`);
    mounts.set(id, mount);
  }

  const ids = new Set<string>();
  return source.camera_records.map((value) => {
    const camera = record(value, "camera record");
    const cameraId = requiredString(camera.id, "camera id");
    if (ids.has(cameraId)) throw new Error(`duplicate camera ${cameraId}`);
    ids.add(cameraId);
    const mountId = requiredString(camera.mount, `${cameraId} mount`);
    const mount = mounts.get(mountId);
    if (!mount) throw new Error(`${cameraId} references unknown mount ${mountId}`);
    const opticsId = optionalString(camera.optics);
    const optics = opticsId ? source.optics?.[opticsId] : undefined;
    const street = optionalString(camera.street);
    const site = optionalString(camera.site);
    const address = optionalString(camera.address) ?? street;

    return {
      camera_id: cameraId,
      city,
      mount_id: mountId,
      latitude: requiredNumber(mount.lat, `${mountId} latitude`),
      longitude: requiredNumber(mount.lon, `${mountId} longitude`),
      address,
      street,
      site,
      site_type: optionalString(camera.site_type),
      role: optionalString(camera.role),
      owner: optionalString(mount.owner),
      owner_kind: optionalString(camera.owner_kind) ?? optionalString(mount.owner_kind),
      mount_kind: optionalString(mount.kind),
      mount_height_m: optionalNumber(mount.height_m),
      reads: optionalString(camera.reads),
      azimuth: optionalNumber(camera.azimuth),
      road_class: optionalString(camera.class),
      edge: optionalNumber(camera.edge),
      from_node: optionalNumber(camera.from_node),
      to_node: optionalNumber(camera.to_node),
      target_latitude: optionalNumber(camera.to_lat),
      target_longitude: optionalNumber(camera.to_lon),
      optics_id: opticsId,
      optics_label: optionalString(optics?.label),
      capture_width_m: optionalNumber(optics?.capture_width_m),
      capture_distance_m: optionalNumber(optics?.capture_distance_m),
      capture_fov_deg: optionalNumber(optics?.capture_fov_deg),
      network: optionalString(camera.network),
      daily_passes: optionalNumber(camera.daily_passes),
      distinct_drivers: optionalNumber(camera.distinct_drivers),
      free_flow_mps: optionalNumber(camera.free_flow_mps),
      zone_seconds: optionalNumber(camera.zone_seconds),
      site_distance_m: optionalNumber(camera.site_distance_m),
      source_day: optionalString(source.sited_from?.day),
    };
  });
}

async function initializeCameraTable(client: PoolClient, database: StaticDatabase): Promise<void> {
  const table = staticTable(database, ALPR_CAMERA_TABLE);
  const declarations = ALPR_CAMERA_COLUMNS.map(([name, type]) => {
    const nullable = ["camera_id", "city", "mount_id", "latitude", "longitude"].includes(name) ? " NOT NULL" : "";
    return `${postgresIdentifier(name)} ${type}${nullable}`;
  }).join(",\n      ");
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      ${declarations},
      PRIMARY KEY (camera_id)
    )`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("alpr_cameras_location_idx")}
    ON ${table} (latitude, longitude)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("alpr_cameras_address_idx")}
    ON ${table} (address)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${postgresIdentifier("alpr_cameras_role_idx")}
    ON ${table} (role)`);
}

async function insertCameras(
  client: PoolClient,
  database: StaticDatabase,
  rows: readonly CameraRow[],
  mode: ImportMode,
): Promise<number> {
  if (rows.length === 0) return 0;
  const names = ALPR_CAMERA_COLUMNS.map(([name]) => postgresIdentifier(name));
  const definitions = ALPR_CAMERA_COLUMNS.map(([name, type]) => `${postgresIdentifier(name)} ${type}`).join(", ");
  const result = await client.query({
    text: `INSERT INTO ${staticTable(database, ALPR_CAMERA_TABLE)} (${names.join(", ")})
      SELECT ${names.map((name) => `item.${name}`).join(", ")}
      FROM jsonb_to_recordset($1::jsonb) AS item(${definitions})
      ${mode === "append" ? "ON CONFLICT (camera_id) DO NOTHING" : ""}`,
    values: [JSON.stringify(rows)],
  });
  return result.rowCount ?? 0;
}

export async function importAlprCameras(
  database: StaticDatabase,
  path: string,
  progress?: ProgressHandler,
  options?: TableImportOptions,
): Promise<CameraImportSummary> {
  const selection = resolveTableImport([ALPR_CAMERA_TABLE], options, "overwrite");
  await initializeStaticSchema(database);
  progress?.({ stage: "read", label: "Reading ALPR camera inventory" });
  const source: unknown = JSON.parse(await readFile(path, "utf8"));
  const rows = cameraRows(source);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${database.schema}.alpr-cameras-import`]);
    progress?.({ stage: "schema", label: "Initializing PostgreSQL ALPR camera table" });
    await initializeCameraTable(client, database);
    if (selection.mode === "overwrite") {
      await client.query(`TRUNCATE TABLE ${staticTable(database, ALPR_CAMERA_TABLE)}`);
    }
    progress?.({ stage: "insert", label: "Writing ALPR cameras", completed: 0, total: rows.length });
    const written = await insertCameras(client, database, rows, selection.mode);
    progress?.({ stage: "insert", label: "Writing ALPR cameras", completed: rows.length, total: rows.length });
    await client.query("COMMIT");
    progress?.({ stage: "complete", label: `Imported ALPR cameras (${selection.mode})` });
    return { table: ALPR_CAMERA_TABLE, mode: selection.mode, cameras: rows.length, written };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

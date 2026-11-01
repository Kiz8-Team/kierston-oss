import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPR_CAMERA_TABLE, cameraRows, importAlprCameras } from "../src/camera-importer.ts";
import { connectStatic, staticTable } from "../src/static-database.ts";
import { importStaticRecords } from "../src/static-importer.ts";
import { writeStaticFixture } from "./static-fixture.ts";

function fixture(ids = ["ALPR-001", "ALPR-002"], firstAddress = "Main Street"): Record<string, unknown> {
  return {
    city: "kierston",
    sited_from: { day: "2026-07-28" },
    optics: {
      falcon: {
        label: "Solar ALPR camera",
        capture_width_m: 4.57,
        capture_distance_m: 19.81,
        capture_fov_deg: 13.2,
      },
    },
    mount_records: ids.map((id, index) => ({
      id: `MNT-${index + 1}`,
      lat: 40.6 + index / 100,
      lon: -75.4 - index / 100,
      kind: "pole",
      height_m: 4.2,
      owner: "Kierston Police Department",
      owner_kind: "police",
    })),
    camera_records: ids.map((id, index) => ({
      id,
      mount: `MNT-${index + 1}`,
      role: "arterial",
      reads: "rear",
      optics: "falcon",
      street: index === 0 ? "Main Street" : "Second Street",
      address: index === 0 ? firstAddress : null,
      class: "primary",
      edge: index + 10,
      from_node: index + 20,
      to_node: index + 30,
      to_lat: 40.61,
      to_lon: -75.41,
      azimuth: 90,
      daily_passes: 100,
      distinct_drivers: 80,
      free_flow_mps: 15,
      zone_seconds: 1.3,
      network: "Sentinel Road Systems",
    })),
  };
}

test("joins cameras to mounts and falls back to the road for an address", () => {
  const rows = cameraRows(fixture());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    camera_id: "ALPR-001",
    mount_id: "MNT-1",
    latitude: 40.6,
    longitude: -75.4,
    address: "Main Street",
    optics_label: "Solar ALPR camera",
  });
  expect(rows[1]?.address).toBe("Second Street");
});

const postgresUrl = process.env.FASTGATE_TEST_POSTGRES_URL;

test.skipIf(!postgresUrl)("creates and updates only the ALPR camera table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-camera-test-"));
  const path = join(directory, "cameras.json");
  const staticPath = join(directory, "sim_init.bin");
  const schema = `fastgate_camera_test_${process.pid}_${Date.now()}`;
  const database = connectStatic({ url: postgresUrl!, schema });
  try {
    await writeFile(path, JSON.stringify(fixture()));
    const first = await importAlprCameras(database, path);
    expect(first).toEqual({ table: ALPR_CAMERA_TABLE, mode: "overwrite", cameras: 2, written: 2 });

    await writeStaticFixture(staticPath);
    await importStaticRecords(database, staticPath);
    expect(Number((await database.pool.query(
      `SELECT count(*) AS count FROM ${staticTable(database, ALPR_CAMERA_TABLE)}`,
    )).rows[0]?.count)).toBe(2);

    await database.pool.query(`CREATE TABLE ${staticTable(database, "unrelated_records")} (value Text)`);
    await database.pool.query(`INSERT INTO ${staticTable(database, "unrelated_records")} VALUES ('keep me')`);

    await writeFile(path, JSON.stringify(fixture(["ALPR-001", "ALPR-003"], "Changed address")));
    const appended = await importAlprCameras(database, path, undefined, { mode: "append" });
    expect(appended).toEqual({ table: ALPR_CAMERA_TABLE, mode: "append", cameras: 2, written: 1 });
    expect((await database.pool.query(
      `SELECT camera_id, address FROM ${staticTable(database, ALPR_CAMERA_TABLE)} ORDER BY camera_id`,
    )).rows).toEqual([
      { camera_id: "ALPR-001", address: "Main Street" },
      { camera_id: "ALPR-002", address: "Second Street" },
      { camera_id: "ALPR-003", address: "Second Street" },
    ]);

    const overwritten = await importAlprCameras(database, path, undefined, { mode: "overwrite" });
    expect(overwritten.written).toBe(2);
    expect((await database.pool.query(
      `SELECT camera_id, address FROM ${staticTable(database, ALPR_CAMERA_TABLE)} ORDER BY camera_id`,
    )).rows).toEqual([
      { camera_id: "ALPR-001", address: "Changed address" },
      { camera_id: "ALPR-003", address: "Second Street" },
    ]);
    expect((await database.pool.query(
      `SELECT value FROM ${staticTable(database, "unrelated_records")}`,
    )).rows).toEqual([{ value: "keep me" }]);
  } finally {
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await database.end();
    await rm(directory, { recursive: true, force: true });
  }
});

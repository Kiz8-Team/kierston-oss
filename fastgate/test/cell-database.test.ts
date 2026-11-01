import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELL_SITE_TABLE, CELL_STRUCTURE_TABLE, importCellSites } from "../src/cell-importer.ts";
import { connectStatic, staticTable } from "../src/static-database.ts";

const postgresUrl = process.env.FASTGATE_TEST_POSTGRES_URL;

const inventory = {
  city: "kierston",
  structure_records: [{
    id: "roof/way/493136180", source: "modelled", asr: null, lat: 40.603119, lon: -75.469654,
    structure: "rooftop", structure_type: "ROOF", height_m: 42.4, building_levels: 12,
    owner: null, in_city: true,
  }],
  cell_records: [{
    id: "att/970000/0", structure: "roof/way/493136180", operator: "AT&T", operator_key: "att",
    mcc: "310", mnc: "410", radio: "LTE", band: "B12", role: "anchor", frequency_mhz: 731,
    station_id: 970000, cell_id: 0, cgi: "310410-42002-248320000", identity: 248320000,
    tracking_area: 42002, sector: 0, azimuth: 138.2, beamwidth: 65, downtilt: 7.9,
    height_m: 9.1, eirp_dbm: 59, range_m: 487, morphology: "dense urban",
    lat: 40.609486, lon: -75.474832, pci: 301,
  }],
};

test.skipIf(!postgresUrl)("cell sites load with the masts they hang off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-cell-database-test-"));
  const path = join(directory, "towers.json");
  const schema = `fastgate_test_cells_${process.pid}_${Date.now()}`;
  const database = connectStatic({ url: postgresUrl!, schema });
  try {
    await writeFile(path, JSON.stringify(inventory));
    const first = await importCellSites(database, path);
    expect(first.tables).toEqual({
      [CELL_STRUCTURE_TABLE]: 1,
      [CELL_SITE_TABLE]: 1,
    });

    // The whole point: a CGI off a carrier record reaches a place, a bearing
    // and the mast it shares with its neighbours.
    const located = await database.pool.query<{
      azimuth: number; latitude: number; structure_type: string; mast_height: number;
    }>({
      text: `SELECT cell.azimuth, cell.latitude, mast.structure_type, mast.height_m AS mast_height
        FROM ${staticTable(database, CELL_SITE_TABLE)} cell
        JOIN ${staticTable(database, CELL_STRUCTURE_TABLE)} mast
          ON mast.structure_id = cell.structure_id
        WHERE cell.cgi = $1`,
      values: ["310410-42002-248320000"],
    });
    expect(located.rows).toEqual([{
      azimuth: 138.2, latitude: 40.609486, structure_type: "ROOF", mast_height: 42.4,
    }]);

    // Reloading replaces the inventory rather than accumulating it.
    const again = await importCellSites(database, path);
    expect(again.tables).toEqual({
      [CELL_STRUCTURE_TABLE]: 1,
      [CELL_SITE_TABLE]: 1,
    });
    expect((await database.pool.query(
      `SELECT count(*)::int AS count FROM ${staticTable(database, CELL_SITE_TABLE)}`,
    )).rows[0]?.count).toBe(1);

    // A sector cannot survive the structure it is bolted to.
    await expect(database.pool.query({
      text: `INSERT INTO ${staticTable(database, CELL_SITE_TABLE)}
        (cgi, cell_key, structure_id, city, latitude, longitude)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      values: ["310410-1-1", "att/1/1", "roof/way/absent", "kierston", 40.6, -75.4],
    })).rejects.toThrow();
  } finally {
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await database.end();
    await rm(directory, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { towerRows } from "../src/cell-importer.ts";

const inventory = {
  city: "kierston",
  structure_records: [
    {
      id: "roof/way/493136180", source: "modelled", asr: null,
      lat: 40.603119, lon: -75.469654, structure: "rooftop", structure_type: "ROOF",
      height_m: 42.4, building_levels: 12, owner: null, in_city: true,
    },
    {
      id: "mast/asr/1303112", source: "asr", asr: "1303112",
      lat: 40.61, lon: -75.47, structure: "tower", structure_type: "MTOWER",
      height_m: 61.0, owner: "Allentown SMSA Limited Partnership", in_city: true,
    },
  ],
  cell_records: [
    {
      id: "att/970000/0", structure: "roof/way/493136180", operator: "AT&T", operator_key: "att",
      mcc: "310", mnc: "410", radio: "LTE", band: "B12", role: "anchor", frequency_mhz: 731,
      station_id: 970000, cell_id: 0, cgi: "310410-42002-248320000", identity: 248320000,
      tracking_area: 42002, sector: 0, azimuth: 138.2, beamwidth: 65.0, downtilt: 7.9,
      height_m: 9.1, eirp_dbm: 59.0, range_m: 487, morphology: "dense urban",
      lat: 40.609486, lon: -75.474832, pci: 301,
    },
    {
      id: "att/970000/1", structure: "roof/way/493136180", operator: "AT&T", operator_key: "att",
      mcc: "310", mnc: "410", radio: "NR", band: "n41", role: "capacity", frequency_mhz: 2593,
      station_id: 970000, cell_id: 1, cgi: "310410-42002-248320001", identity: 248320001,
      tracking_area: 42002, sector: 1, azimuth: 258.2, beamwidth: 65.0, downtilt: 4.0,
      height_m: 9.1, eirp_dbm: 62.0, range_m: 210, morphology: "dense urban",
      lat: 40.609486, lon: -75.474832, pci: 302,
    },
  ],
};

const clone = (): typeof inventory => JSON.parse(JSON.stringify(inventory)) as typeof inventory;

test("tower inventory yields located sectors and the masts they sit on", () => {
  const { structures, cells } = towerRows(clone());
  expect(structures).toHaveLength(2);
  expect(cells).toHaveLength(2);
  expect(cells[0]).toMatchObject({
    cgi: "310410-42002-248320000",
    cell_key: "att/970000/0",
    structure_id: "roof/way/493136180",
    city: "kierston",
    operator_key: "att",
    radio: "LTE",
    role: "anchor",
    // The fields that make a CGI more than a point: which way it faces and
    // how wide, so a read places a handset in a wedge rather than on a dot.
    azimuth: 138.2,
    beamwidth: 65.0,
    range_m: 487,
    latitude: 40.609486,
    longitude: -75.474832,
  });
  // Two sectors, one mast, pointing opposite ways.
  expect(cells.map((row) => row.structure_id)).toEqual([
    "roof/way/493136180", "roof/way/493136180",
  ]);
  expect(cells.map((row) => row.azimuth)).toEqual([138.2, 258.2]);
});

test("absent structure detail is null rather than missing", () => {
  const { structures } = towerRows(clone());
  expect(structures[0]).toMatchObject({ asr: null, owner: null, building_levels: 12 });
  // building_levels is absent on a mast, not merely null there.
  expect(structures[1]).toMatchObject({ asr: "1303112", building_levels: null, structure_type: "MTOWER" });
});

test("a cell on an unknown structure is rejected", () => {
  const broken = clone();
  broken.cell_records[0]!.structure = "roof/way/000";
  expect(() => towerRows(broken)).toThrow(/unknown structure/);
});

test("a repeated CGI is rejected", () => {
  const broken = clone();
  broken.cell_records[1]!.cgi = broken.cell_records[0]!.cgi;
  expect(() => towerRows(broken)).toThrow(/duplicate CGI/);
});

test("a cell with no coordinates is rejected", () => {
  const broken = clone();
  delete (broken.cell_records[0] as Partial<{ lat: number }>).lat;
  expect(() => towerRows(broken)).toThrow(/latitude/);
});

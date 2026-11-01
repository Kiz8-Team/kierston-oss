import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchPlaces, validatePlaceSearch } from "../place_search.ts";

const directory = await mkdtemp(join(tmpdir(), "km-places-"));
const catalog = join(directory, "pois.json");
await writeFile(catalog, JSON.stringify({
  groups: [{ id: "food", label: "Food & drink", types: [{ i: 7, id: "amenity=cafe", label: "Cafe" }] }],
  points: [
    [40, -75, 0, 7, "At origin", "1 Main Street", 0],
    [40.001, -75, 0, 7, "About 111 metres north", "2 Main Street", 1],
    [40.01, -75, 0, 7, "Outside", "", 0],
  ],
}));

afterAll(() => rm(directory, { recursive: true, force: true }));

test("returns all POIs in the radius, nearest first, with decoded metadata", async () => {
  const result = await searchPlaces(40, -75, 150, catalog);
  expect(result.count).toBe(2);
  expect(result.places.map((place) => place.id)).toEqual(["poi/0", "poi/1"]);
  expect(result.places[0]).toEqual({
    id: "poi/0",
    name: "At origin",
    type: "amenity=cafe",
    typeLabel: "Cafe",
    group: "food",
    groupLabel: "Food & drink",
    address: "1 Main Street",
    latitude: 40,
    longitude: -75,
    distanceMetres: 0,
  });
  expect(result.places[1]!.distanceMetres).toBe(111);
});

test("validates coordinates and radius", () => {
  expect(validatePlaceSearch(91, 0, 10)).toContain("latitude");
  expect(validatePlaceSearch(0, -181, 10)).toContain("longitude");
  expect(validatePlaceSearch(0, 0, -1)).toContain("radiusMetres");
  expect(validatePlaceSearch(0, 0, 0)).toBeNull();
});

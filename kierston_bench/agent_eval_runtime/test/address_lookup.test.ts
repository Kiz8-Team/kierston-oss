import { expect, test } from "bun:test";
import { lookupInCatalog, validateAddressQuery } from "../address_lookup.ts";
import type { CarGraph } from "../../../kierston/pathfinder/src/graph.ts";

const points = [
  [40, -75, 0, "house", 0, 0, "", "12 West Main Street, City", { "addr:street": "West Main Street", "addr:housenumber": "12" }, "way/1"],
  [40.001, -75, 0, "house", 0, 0, "", "112 West Main Street, City", { "addr:street": "West Main Street", "addr:housenumber": "112" }, "way/2"],
  [40, -75, 0, "house", 0, 0, "", "PA", { "addr:state": "PA" }, "way/3"],
];
const graph = {
  nodeCount: 2, lat: new Float64Array([39.99, 40.01]), lon: new Float64Array([-75, -75]),
  offset: new Uint32Array([0, 1, 2]), target: new Uint32Array([1, 0]),
  nameId: new Uint32Array([1, 1]), names: ["", "West Main Street"],
} as CarGraph;

test("matches normalized addresses without matching a different house number", () => {
  const result = lookupInCatalog({ address: "12 w. main st" }, points, graph);
  expect(result.addresses.map(a => a.id)).toEqual(["way/1"]);
  expect(result.streets).toHaveLength(0);
  expect(lookupInCatalog({ address: "W Main St" }, points, graph).streetCount).toBe(1);
  expect(lookupInCatalog({ address: "Unknown Road" }, points, graph).addressCount).toBe(0);
});

test("reverse search projects onto edges, deduplicates directions, and filters centroids", () => {
  const result = lookupInCatalog({ latitude: 40, longitude: -75, radiusMetres: 120 }, points, graph);
  expect(result.addresses.map(a => a.id)).toEqual(["way/1", "way/2"]);
  expect(result.addresses[1]!.distanceMetres).toBeCloseTo(111.195, 2);
  expect(result.streets).toHaveLength(1);
  expect(result.streets[0]!.distanceMetres).toBe(0);
  expect(lookupInCatalog({ latitude: 40, longitude: -75, radiusMetres: 0 }, points, graph).addressCount).toBe(1);
});

test("rejects invalid or mixed query modes", () => {
  for (const query of [{}, { address: " " }, { address: "!!!" }, { address: "x", latitude: 40 }, { latitude: 91, longitude: 0, radiusMetres: 100 }, { latitude: 0, longitude: 0, radiusMetres: -1 }, { latitude: NaN, longitude: 0, radiusMetres: 1 }]) expect(validateAddressQuery(query)).not.toBeNull();
  expect(validateAddressQuery({ address: "Main St" })).toBeNull();
});

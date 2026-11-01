import { describe, expect, test } from "bun:test";
import type { CarGraph } from "./graph.ts";
import { Router } from "./router.ts";

function directedGraph(): CarGraph {
  return {
    source: "test",
    builtAt: "test",
    nodeCount: 3,
    edgeCount: 2,
    bbox: { minLat: 0, minLon: 0, maxLat: 0, maxLon: 0.002 },
    maxSpeedMps: 10,
    largestComponent: 0,
    largestComponentSize: 3,
    componentCount: 1,
    names: ["", "One Way"],
    classes: ["residential"],
    lat: new Float64Array([0, 0, 0]),
    lon: new Float64Array([0, 0.001, 0.002]),
    osmid: new Float64Array([1, 2, 3]),
    component: new Uint32Array([0, 0, 0]),
    offset: new Uint32Array([0, 1, 2, 2]),
    target: new Uint32Array([1, 2]),
    cost: new Float32Array([10, 10]),
    length: new Float32Array([100, 100]),
    nameId: new Uint32Array([1, 1]),
    classId: new Uint8Array([0, 0]),
  };
}

describe("Router walking mode", () => {
  test("keeps lane direction for normal routes", () => {
    expect(new Router(directedGraph()).route(2, 0)).toBeNull();
  });

  test("can traverse directed lane edges backwards", () => {
    const path = new Router(directedGraph()).route(2, 0, { walking: true });

    expect(Array.from(path?.nodes ?? [])).toEqual([2, 1, 0]);
    expect(Array.from(path?.edges ?? [])).toEqual([1, 0]);
    expect(path?.distanceMeters).toBe(200);
  });
});

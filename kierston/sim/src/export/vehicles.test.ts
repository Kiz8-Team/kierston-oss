import { describe, expect, test } from "bun:test";
import type { DayContext } from "../engine/index.ts";
import { buildVehicleDay, vehicleBoundaryStates } from "./vehicles.ts";

function context(vins: string[]): DayContext {
  const depot = { lat: 40.6, lon: -75.47 };
  return {
    world: {
      persons: new Map(), households: new Map(), assignments: new Map(), places: new Map(),
      school: {}, householdVehicles: new Map(), carless: new Set(), seed: 1,
      vehicles: new Map(vins.map((vin) => [vin, {
        vin, owner: 10, owner_type: "organization", household: null,
        service_class: "taxi", seats: null,
      }])),
      fleet: {
        operators: new Map([[10, { id: 10, name: "test", depot }]]),
        vehicles: vins.map((vin) => ({ vin, service_class: "taxi", operator: 10, owner_driver: null })),
        drivers: new Map(),
      },
    },
  } as unknown as DayContext;
}

function legs(vehicle: number[], depart: number[], arrive: number[], fromLat: number[], toLat: number[]) {
  return {
    vehicle, depart, arrive,
    fromLat: fromLat.map((value) => Math.round(value * 1e6)),
    fromLon: fromLat.map(() => Math.round(-75.47 * 1e6)),
    toLat: toLat.map((value) => Math.round(value * 1e6)),
    toLon: toLat.map(() => Math.round(-75.47 * 1e6)),
  };
}

describe("vehicle timeline validation", () => {
  test("warns about every invalid VIN and still returns the day", () => {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => { said.push(message); };
    try {
      const day = buildVehicleDay(
        context(["VIN1", "VIN2"]), ["VIN1", "VIN2"],
        legs([0, 1], [60, 120], [70, 130], [40.63, 40.64], [40.65, 40.66]),
      );
      expect(day.vin).toEqual(["VIN1", "VIN2"]);
      expect(day.spanEnd.at(-1)).toBe(86_400);
    } finally {
      console.warn = warn;
    }
    expect(said.join("\n")).toMatch(/2 errors[\s\S]*VIN1 teleports[\s\S]*VIN2 teleports/);
  });

  test("ignores a continuation wholly after midnight", () => {
    const day = buildVehicleDay(
      context(["VIN1"]), ["VIN1"],
      legs([0], [1500], [1510], [40.6], [40.61]),
    );
    expect(day.spanStart).toEqual([0]);
    expect(day.spanEnd).toEqual([86_400]);
    expect(day.spanKind).toEqual([0]);
  });

  test("clips a crossing journey and carries its midnight coordinate", () => {
    const day = buildVehicleDay(
      context(["VIN1"]), ["VIN1"],
      legs([0], [1430], [1450], [40.6], [40.62]),
    );
    expect(day.spanEnd.at(-1)).toBe(86_400);
    expect(vehicleBoundaryStates(day, "closing")[0]!.location?.lat).toBeCloseTo(40.61, 6);
  });
});

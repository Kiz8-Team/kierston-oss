import { describe, expect, test } from "bun:test";
import type { Person } from "../world/index.ts";
import { cabbieStays, Fleet, type FleetState } from "./taxi.ts";

describe("taxi driver stays", () => {
  test("an idle shift does not drive the taxi home", () => {
    const point = { lat: 40.62, lon: -75.45 };
    const state: FleetState = {
      cabs: [{
        person: 7, vin: "TAXI1", operator: 11, base: point,
        stand: { ...point, id: "stand/0", mass: 1 },
        shiftStart: 480, shiftEnd: 960, at: point, freeFrom: 480,
        jobs: [], resting: null,
      }],
      day: 1, unavailable: 0,
      tally: { ride: 0, relay: 0, walk: 0, transit: 0 },
      byFare: new Map(), byJourney: new Map(), minutes: new Map(),
    };
    const person = { id: 7 } as Person;

    const stays = cabbieStays(Fleet.adopt(state), person);

    expect(stays).toHaveLength(1);
    expect(stays[0]!.vehicleId).toBe("TAXI1");
    expect(stays[0]!.leaveMode).toBeUndefined();
  });
});

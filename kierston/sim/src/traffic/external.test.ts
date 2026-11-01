import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Rng } from "../shared/index.ts";
import { emptyExternalTrafficDay, formatPlate, type PlateRule } from "./external.ts";

const rulesFile = join(import.meta.dir, "..", "..", "..", "init", "traffic", "us_plate_rules.json");

describe("US plate rules", () => {
  test("covers every state and DC exactly once", async () => {
    const file = await Bun.file(rulesFile).json() as { rules: PlateRule[] };
    expect(file.rules).toHaveLength(51);
    expect(new Set(file.rules.map((row) => row.code)).size).toBe(51);
    expect(file.rules.find((row) => row.code === "PA")?.front).toBeFalse();
    expect(file.rules.find((row) => row.code === "NJ")?.front).toBeTrue();
    expect(file.rules.filter((row) => row.front)).toHaveLength(30); // 29 states plus DC
  });

  test("every representative pattern produces an ALPR-safe serial", async () => {
    const file = await Bun.file(rulesFile).json() as { rules: PlateRule[] };
    for (const [index, rule] of file.rules.entries()) {
      for (const pattern of rule.patterns) {
        const text = formatPlate(pattern, new Rng(index + 1));
        expect(text).toMatch(/^[A-Z0-9-]{5,8}$/);
        expect(text).not.toContain("I");
        expect(text).not.toContain("O");
        expect(text).not.toContain("Q");
      }
    }
  });
});

test("an absent traffic asset has a structurally empty day", () => {
  const day = emptyExternalTrafficDay();
  expect(day.vehicles).toEqual([]);
  expect(day.tripVehicle).toEqual([]);
  expect(day.routePathOffset).toEqual([]);
  expect(day.throughTrips).toBe(0);
});

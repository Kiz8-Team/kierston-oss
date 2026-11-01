import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfig, REPO_ROOT, SCENARIOS_DIR, scenarioSeed } from "../src/config.ts";

const base = { series: { id: "unit", seed: 7, days: ["kierston/sim_outputs/day_2026-09-04.bin"] } };

describe("scenario plans in a series config", () => {
  test("a plan names a catalogued scenario and its families, with seeds derived from the series seed", () => {
    const config = parseConfig({ ...base, tasks: { include: "all" }, scenarios: [{ id: "mass-shooting", count: 2 }] });
    expect(config.scenarios).toHaveLength(1);
    const plan = config.scenarios[0]!;
    expect(plan.script).toBe(join(SCENARIOS_DIR, "rti/mass-shooting.ts"));
    expect(plan.families).toEqual(["mass-shooting"]);
    // Two wanted, so two times the eight default attempts as candidates, in order.
    expect(plan.wanted).toBe(2);
    expect(plan.seeds).toHaveLength(16);
    expect(plan.seeds.slice(0, 2)).toEqual([scenarioSeed(7, "mass-shooting", 0), scenarioSeed(7, "mass-shooting", 1)]);
    expect(plan.days).toEqual([join(REPO_ROOT, "kierston/sim_outputs/day_2026-09-04.bin")]);
    expect(plan.maxAffected).toBe(1500);
    expect(config.scenarioDir).toBe(join(REPO_ROOT, "kierston/sim_outputs/scenarios/unit"));
  });

  test("RTI and DT families default to one copy per staging while TT families keep the series default", () => {
    const config = parseConfig({ ...base, tasks: { include: "all", copies: 3, per_family: { "protest-members": 2 } },
      scenarios: [{ id: "protest", seeds: [3, 4], days: ["other/day.bin"], max_affected: 900 }, { id: "swatting", count: 3 }] });
    expect(config.copies.get("device-to-person")).toBe(3);
    expect(config.copies.get("mass-shooting")).toBe(1);
    expect(config.copies.get("protest-members")).toBe(2);
    expect(config.copies.get("swatting")).toBe(1);
    expect(config.scenarios[1]).toMatchObject({ id: "swatting", script: join(SCENARIOS_DIR, "dt/swatting.ts"), families: ["swatting"], maxAffected: 64 });
    expect(config.scenarios[1]!.wanted).toBe(3);
    const plan = config.scenarios[0]!;
    expect(plan.seeds).toEqual([3, 4]);
    expect(plan.wanted).toBeUndefined();
    expect(plan.days).toEqual([join(REPO_ROOT, "other/day.bin")]);
    expect(plan.maxAffected).toBe(900);
  });

  test("a plan only generates the families the series includes", () => {
    const config = parseConfig({ ...base, tasks: { include: ["mass-gathering", "colocation"] },
      scenarios: [{ id: "mass-gathering" }, { id: "explosion" }] });
    expect(config.scenarios.map((plan) => plan.families)).toEqual([["mass-gathering"], []]);
  });

  test("without a count, tasks.copies sets how many stagings each day wants", () => {
    const config = parseConfig({ ...base, tasks: { include: "all", copies: 4 }, scenarios: [{ id: "swatting" }, { id: "protest", count: 2 }] });
    expect(config.scenarios.map((plan) => plan.wanted)).toEqual([4, 2]);
    expect(config.scenarios[0]!.seeds).toHaveLength(32);
    expect(config.copies.get("swatting")).toBe(1);
  });

  test("mistakes fail before any day is opened", () => {
    expect(() => parseConfig({ ...base, tasks: {}, scenarios: [{ id: "bank-heist" }] })).toThrow("benchmark scenario");
    expect(() => parseConfig({ ...base, tasks: {}, scenarios: [{ id: "protest", seeds: [1, 1] }] })).toThrow("distinct");
    expect(() => parseConfig({ ...base, tasks: {}, scenarios: [{ id: "protest", seeds: [1], count: 2 }] })).toThrow("not both");
    expect(() => parseConfig({ ...base, tasks: { include: ["explosion"] } })).toThrow("no [[scenarios]] entry");
    expect(() => parseConfig({ ...base, tasks: { include: ["stabbing"] } })).toThrow("no [[scenarios]] entry");
    expect(parseConfig({ ...base, tasks: {} }).scenarios).toEqual([]);
  });
});

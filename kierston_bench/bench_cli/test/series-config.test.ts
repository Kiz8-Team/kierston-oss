import { expect, test } from "bun:test";
import { parseConfig } from "../../run_series_prep/src/config.ts";
import { SERIES_FAMILIES, isStagedFamily, scenariosFor, seriesToml } from "../src/series-config.ts";

const base = { id: "t", seed: 42, days: ["kierston/sim_outputs/day_2026-09-04.bin"], copies: 3, attempts: 8 };

test("the builder offers RTI and DT families alongside the technical ones", () => {
  expect(SERIES_FAMILIES).toContain("mass-shooting");
  expect(SERIES_FAMILIES).toContain("swatting");
  expect(SERIES_FAMILIES.some((family) => !isStagedFamily(family))).toBe(true);
});

test("every family chosen stages every scenario, and the config parses", () => {
  const toml = seriesToml({ ...base, families: new Set(SERIES_FAMILIES) });
  const config = parseConfig(Bun.TOML.parse(toml) as Record<string, unknown>);
  expect(config.scenarios.map((plan) => plan.id)).toEqual(scenariosFor(new Set(SERIES_FAMILIES)));
  // Copies sets the deltas per scenario per day; each delta still yields one task per staged family.
  expect(config.scenarios.every((plan) => plan.wanted === 3 && plan.families.length > 0)).toBe(true);
  expect(config.copies.get("swatting")).toBe(1);
});

test("a subset stages only the scenarios its staged families read", () => {
  const technical = SERIES_FAMILIES.find((family) => !isStagedFamily(family))!;
  const toml = seriesToml({ ...base, families: new Set([technical, "swatting"]) });
  const config = parseConfig(Bun.TOML.parse(toml) as Record<string, unknown>);
  expect(config.scenarios.map((plan) => plan.id)).toEqual(["swatting"]);
  expect([...config.copies.keys()].sort()).toEqual([technical, "swatting"].sort());
});

test("technical families alone write no scenarios", () => {
  const technical = SERIES_FAMILIES.filter((family) => !isStagedFamily(family));
  const toml = seriesToml({ ...base, families: new Set(technical) });
  expect(toml).not.toContain("[[scenarios]]");
  expect(parseConfig(Bun.TOML.parse(toml) as Record<string, unknown>).scenarios).toEqual([]);
});

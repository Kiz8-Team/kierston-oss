import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cityTimeZone } from "../src/city.ts";

const saved = process.env.CITY_TIME_ZONE;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.CITY_TIME_ZONE;
  else process.env.CITY_TIME_ZONE = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function simData(city?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "fastgate-city-"));
  dirs.push(dir);
  if (city) writeFileSync(join(dir, "city.json"), JSON.stringify(city));
  return dir;
}

describe("city time zone", () => {
  test("comes from the published city.json", () => {
    delete process.env.CITY_TIME_ZONE;
    expect(cityTimeZone(simData({ time_zone: "Europe/Lisbon" }))).toBe("Europe/Lisbon");
  });

  test("CITY_TIME_ZONE overrides it", () => {
    process.env.CITY_TIME_ZONE = "Asia/Tokyo";
    expect(cityTimeZone(simData({ time_zone: "Europe/Lisbon" }))).toBe("Asia/Tokyo");
  });

  test("has no built-in default", () => {
    delete process.env.CITY_TIME_ZONE;
    expect(() => cityTimeZone(simData())).toThrow("--only locale");
    expect(() => cityTimeZone(simData({ name: "Somewhere" }))).toThrow("has no time_zone");
  });
});

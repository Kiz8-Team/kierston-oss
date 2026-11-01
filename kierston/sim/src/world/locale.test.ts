import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cityTimeZone, parseCsv, readCityTable } from "./index.ts";
import { benefitPayer, payerFor } from "../economy/banking/index.ts";

const saved = process.env.CITY_TIME_ZONE;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.CITY_TIME_ZONE;
  else process.env.CITY_TIME_ZONE = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "locale-"));
  dirs.push(dir);
  return dir;
}

describe("city lists", () => {
  test("csv fields may be quoted", () => {
    expect(parseCsv('name,w\n"Wells Fargo Bank, N.A.",1\n"say ""hi""",2\n'))
      .toEqual([["name", "w"], ["Wells Fargo Bank, N.A.", "1"], ['say "hi"', "2"]]);
  });

  test("the reference city's cab companies and payers are the ones the code used to carry", () => {
    expect(readCityTable("cab_companies.csv").map((row) => row.name)).toEqual([
      "Kierston Yellow Cab", "Lehigh Valley Taxi Co.", "Hamilton Street Cabs", "Queen City Livery LLC",
    ]);
    const payers = readCityTable("payers.csv");
    expect(payers.filter((row) => !row.sector!.startsWith("benefit:") && row.sector !== "fallback")).toHaveLength(47);
    expect(payerFor(null, "way/1")).toBe("Kierston Business Services LLC");
    expect(payerFor("MIL", "anything")).toBe("Defense Finance and Accounting Service");
    expect(benefitPayer("unemployment")).toBe("PA Department of Labor & Industry");
    expect(benefitPayer("wages")).toBeNull();
  });

  test("a missing list names the file", () => {
    expect(() => readCityTable("absent.csv", scratch())).toThrow("absent.csv");
  });
});

describe("city time zone", () => {
  test("comes from city.json unless CITY_TIME_ZONE overrides it, and has no default", () => {
    delete process.env.CITY_TIME_ZONE;
    const dir = scratch();
    expect(() => cityTimeZone(dir)).toThrow("--only locale");
    writeFileSync(join(dir, "city.json"), JSON.stringify({ name: "X" }));
    expect(() => cityTimeZone(dir)).toThrow("has no time_zone");
    writeFileSync(join(dir, "city.json"), JSON.stringify({ time_zone: "Europe/Lisbon" }));
    expect(cityTimeZone(dir)).toBe("Europe/Lisbon");
    process.env.CITY_TIME_ZONE = "Asia/Tokyo";
    expect(cityTimeZone(dir)).toBe("Asia/Tokyo");
  });
});

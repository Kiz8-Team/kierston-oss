import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYER, mix, Rng } from "../shared/index.ts";
import { KIERSTON_DIR } from "../world/index.ts";
import {
  ALPR_MODEL, correlationId, externalPlateTruth, lightingAt, loadPlateRules, misreadPlate, observePlate,
  parsePlateRules, plateOnSide, plateTruth, withinExportedDay, type Lighting, type PlateRules,
} from "./index.ts";

/**
 * The constants alpr.ts carried before the plate rules moved to the
 * jurisdiction bundle: the issuer that marks a home plate, the home state's
 * rear-only rule and the neighbouring-state mix with its serials.
 */
const PREVIOUS_RULES: PlateRules = {
  version: 1,
  jurisdiction: "us-pa",
  state: "PA",
  issuer: "Pennsylvania Department of Transportation",
  front: false,
  visitors: [
    { jurisdiction: "PA", share: 0.88, pattern: "LLL-DDDD" },
    { jurisdiction: "NJ", share: 0.07, pattern: "LDD-LL" },
    { jurisdiction: "NY", share: 0.03, pattern: "LLL-DDDD" },
    { jurisdiction: "DE", share: 0.01, pattern: "DDDDDD" },
    { jurisdiction: "MD", share: 0.01, pattern: "DLLDDDD" },
  ],
};
const RULES = PREVIOUS_RULES;

/** externalPlateTruth as it was written against those constants, kept as the reference. */
function previousExternalPlate(seed: number, person: number) {
  const rng = new Rng(mix(seed, person, LAYER.alpr, 0x455854));
  const draw = rng.next();
  let cumulative = 0;
  let jurisdiction = "PA";
  for (const row of PREVIOUS_RULES.visitors) {
    cumulative += row.share;
    if (draw < cumulative) { jurisdiction = row.jurisdiction; break; }
  }
  const pick = (alphabet: string, count: number) => {
    let out = "";
    for (let index = 0; index < count; index += 1) out += alphabet[rng.int(0, alphabet.length - 1)]!;
    return out;
  };
  const letters = pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 3);
  const digits = pick("0123456789", 6);
  const text = jurisdiction === "NJ" ? `${letters[0]}${digits.slice(0, 2)}-${letters.slice(1)}`
    : jurisdiction === "DE" ? digits
      : jurisdiction === "MD" ? `${digits[0]}${letters.slice(0, 2)}${digits.slice(1, 5)}`
        : `${letters}-${digits.slice(0, 4)}`;
  return { text, jurisdiction, front: jurisdiction !== "PA", rear: true, body: null };
}

const PYTHON = join(KIERSTON_DIR, ".venv", "bin", "python");

describe("plate rules", () => {
  test.skipIf(!existsSync(PYTHON))("init publishes the rules alpr.ts used to hard-code", async () => {
    const out = mkdtempSync(join(tmpdir(), "plate-rules-"));
    try {
      const run = Bun.spawnSync([PYTHON, join(KIERSTON_DIR, "init", "publish_locale.py")], {
        env: { ...process.env, KIERSTON_SIM_DATA_DIR: out, KIERSTON_CITY: "kierston" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const published = await loadPlateRules(join(out, "plate_rules.json"));
      expect(published).toEqual(PREVIOUS_RULES);
      for (let person = 0; person < 20_000; person += 1) {
        expect(externalPlateTruth(71, person, published)).toEqual(previousExternalPlate(71, person));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a missing or stale rule file is an error that says how to rebuild it", async () => {
    await expect(loadPlateRules(join(tmpdir(), "no-such-dir", "plate_rules.json")))
      .rejects.toThrow("--only locale");
    expect(() => parsePlateRules({ ...PREVIOUS_RULES, version: 0 }, "stale.json")).toThrow("version 0");
    expect(() => parsePlateRules({ ...PREVIOUS_RULES, visitors: [{ jurisdiction: "XX", share: 1, pattern: "LLLL" }] },
      "wide.json")).toThrow("more than 3 L");
  });
});

const DATE = new Date(2026, 6, 28);
const LAT = 40.602989;
const LON = -75.472188;

describe("plate presentation", () => {
  test("Pennsylvania presents only the rear plate", () => {
    const plate = plateTruth({
      plate: "ABC-1234", issuer: "Pennsylvania Department of Transportation",
      owner: 1, owner_type: "person", household: 1,
    }, RULES);
    expect(plateOnSide(plate, "rear")).toBe("ABC-1234");
    expect(plateOnSide(plate, "front")).toBeNull();
  });

  test("a non-local plate defaults to both sides and an explicit rule wins", () => {
    const visitor = plateTruth({
      plate: "VISITOR", jurisdiction: "NJ",
      owner: null, owner_type: "organization", household: null,
    }, RULES);
    expect(plateOnSide(visitor, "front")).toBe("VISITOR");
    expect(plateOnSide(visitor, "rear")).toBe("VISITOR");

    const rearOnly = plateTruth({
      plate: "REAR-1", jurisdiction: "XX", plate_sides: ["rear"],
      owner: null, owner_type: "organization", household: null,
    }, RULES);
    expect(plateOnSide(rearOnly, "front")).toBeNull();
  });

  test("an unregistered driving vehicle gets a stable regional plate", () => {
    expect(externalPlateTruth(71, 4002, RULES)).toEqual(externalPlateTruth(71, 4002, RULES));
    let local = 0;
    let outOfState = 0;
    for (let person = 0; person < 10_000; person += 1) {
      const plate = externalPlateTruth(71, person, RULES);
      expect(plate.rear).toBeTrue();
      expect(plate.front).toBe(plate.jurisdiction !== "PA");
      if (plate.jurisdiction === "PA") local += 1;
      else outOfState += 1;
    }
    expect(local / (local + outOfState)).toBeCloseTo(0.88, 2);
  });
});

describe("day ownership", () => {
  test("a file keeps only the passes on its own date", () => {
    // A leg carried from yesterday starts at a negative second; yesterday's
    // file already wrote those passes. A plan running past midnight is
    // re-planned by tomorrow, which writes those.
    expect(withinExportedDay(-1)).toBe(false);
    expect(withinExportedDay(0)).toBe(true);
    expect(withinExportedDay(86_399)).toBe(true);
    expect(withinExportedDay(86_400)).toBe(false);
    expect(withinExportedDay(90_000)).toBe(false);
  });
});

describe("light and identity", () => {
  test("classifies noon as day and midnight as IR night", () => {
    expect(lightingAt(DATE, 12 * 3600, LAT, LON)).toBe("day");
    expect(lightingAt(DATE, 0, LAT, LON)).toBe("night_ir");
  });

  test("night IR has the strongest baseline", () => {
    expect(ALPR_MODEL.lighting.night_ir.capture).toBeGreaterThan(ALPR_MODEL.lighting.day.capture);
    expect(ALPR_MODEL.lighting.night_ir.correct).toBeGreaterThan(ALPR_MODEL.lighting.day.correct);
    expect(ALPR_MODEL.lighting.night_ir.misread).toBeLessThan(ALPR_MODEL.lighting.day.misread);
  });

  test("correlation identity is about the passage, not its plate", () => {
    expect(correlationId("20260728", "ALPR-023", 184029, 0))
      .toBe("20260728:ALPR-023:leg-184029:crossing-0");
  });
});

describe("OCR", () => {
  test("every requested mutation changes a seven-character registration", () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      expect(misreadPlate("ABC-1234", new Rng(seed))).not.toBe("ABC-1234");
      expect(misreadPlate("AAA-1111", new Rng(seed))).not.toBe("AAA-1111");
    }
  });

  test("the aggregate rates follow their configured lighting priors", () => {
    const rates = (lighting: Lighting) => {
      const tally = { correct: 0, misread: 0, unreadable: 0, not_captured: 0 };
      const rng = new Rng(20260728 + lighting.length);
      const total = 100_000;
      for (let i = 0; i < total; i += 1) {
        const outcome = observePlate("ABC-1234", lighting, Infinity, 1.2, rng).outcome;
        if (outcome in tally) tally[outcome as keyof typeof tally] += 1;
      }
      return Object.fromEntries(Object.entries(tally).map(([key, value]) => [key, value / total]));
    };

    const day = rates("day");
    const night = rates("night_ir");
    const twilight = rates("twilight");
    expect(day.correct).toBeCloseTo(0.99 * 0.97, 2);
    expect(night.correct).toBeGreaterThan(day.correct);
    expect(twilight.correct).toBeLessThan(day.correct);
    expect(night.misread).toBeLessThan(day.misread);
  });

  test("close traffic lowers capture and raises OCR errors", () => {
    const sample = (headway: number) => {
      const rng = new Rng(71);
      let correct = 0;
      let bad = 0;
      for (let i = 0; i < 50_000; i += 1) {
        const outcome = observePlate("ABC-1234", "day", headway, 1.2, rng).outcome;
        if (outcome === "correct") correct += 1;
        if (outcome === "misread" || outcome === "unreadable" || outcome === "not_captured") bad += 1;
      }
      return { correct, bad };
    };
    const open = sample(3);
    const close = sample(0.4);
    expect(close.correct).toBeLessThan(open.correct);
    expect(close.bad).toBeGreaterThan(open.bad);
  });

  test("a plate-absent view only rarely creates a spurious read", () => {
    const count = (lighting: Lighting) => {
      const rng = new Rng(1937 + lighting.length);
      let spurious = 0;
      for (let index = 0; index < 100_000; index += 1) {
        const outcome = observePlate(null, lighting, Infinity, 1.2, rng).outcome;
        expect(["no_plate", "spurious"]).toContain(outcome);
        if (outcome === "spurious") spurious += 1;
      }
      return spurious / 100_000;
    };
    const day = count("day");
    const night = count("night_ir");
    expect(day).toBeCloseTo(ALPR_MODEL.noPlateSpurious.day, 3);
    expect(night).toBeLessThan(day);
  });
});

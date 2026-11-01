import { describe, expect, test } from "bun:test";
import { Builder, type Profile } from "./metrics.ts";
import { failures } from "./suites.ts";

function profile(value: number, violations = 0) {
  const b = new Builder();
  b.scalar("scheduler.trips.rate", value, "rate");
  b.invariant("scheduler.timeline.overlap", "events do not overlap", violations, 10);
  return b.profile("scheduler", "test");
}

describe("Iceberg suite guardrails", () => {
  test("fails a new invariant violation", () => {
    expect(failures(profile(3), profile(3, 1))).toEqual([
      "scheduler.timeline.overlap: 1 violations, allowed 0 — events do not overlap",
    ]);
  });

  test("gates a calibrated relative movement", () => {
    expect(failures(profile(3), profile(3.2), {
      bands: { "scheduler.trips.rate": { relative: 0.03 } },
    })[0]).toContain("allowed 3.00%");
  });

  test("leaves review-only movements out of hard failures", () => {
    expect(failures(profile(3), profile(3.2))).toEqual([]);
  });

  test("gates individual categorical share movement", () => {
    const categorical = (car: number): Profile => ({
      iceberg: 1,
      kind: "test",
      source: "test",
      recordedAt: "2026-01-01T00:00:00.000Z",
      provenance: {},
      metrics: { mode: { t: "cat", n: 100, distinct: 2, counts: { car, walk: 100 - car } } },
    });
    expect(failures(categorical(60), categorical(57), {
      bands: { mode: { categoryAbsolute: 0.01 } },
    })).toHaveLength(2);
  });
});

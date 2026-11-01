import { expect, test } from "bun:test";
import { familyHeadline, familyTable } from "../src/report.ts";
import type { FamilyAggregate } from "../src/aggregate.ts";

function family(name: string, metrics: Record<string, number>): FamilyAggregate {
  return {
    family: name,
    tasks: 4,
    attempted: 4,
    scored: 4,
    statuses: { scored: 4 },
    meanScore: 0.5,
    meanScoreAnswered: 0.5,
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { mean: value, median: value, n: 4 }])),
  };
}

test("a family table only draws the metric columns somebody answered for", () => {
  const [header] = familyTable([family("who_paid", { reciprocalRank: 0.62 }), family("who_paid_too", { top1: 1 })]);
  expect(header).toContain("MRR");
  expect(header).toContain("top-1");
  // No family here reports a distance or an overlap, so those columns are absent.
  expect(header).not.toContain("IoU");
  expect(header).not.toContain("med m");
  expect(header).not.toContain("macro-F1");
});

test("each family has one metric it is really reported by", () => {
  expect(familyHeadline(family("ranked", { reciprocalRank: 0.62 }))).toEqual({ label: "MRR", value: "0.620" });
  expect(familyHeadline(family("placed", { metres: 380 }))).toEqual({ label: "med m", value: "380" });
  expect(familyHeadline(family("bare", {}))).toBeNull();
});

test("vehicle occupancy reports count and identity quality separately", () => {
  const occupancy = family("vehicle-occupancy", { "count.accuracy": 1, "occupants.f1": 0.25 });
  expect(familyHeadline(occupancy)).toEqual({ label: "count / identity F1", value: "100.0% / 0.250" });
  const output = familyTable([occupancy]).join("\n");
  expect(output).toContain("count acc");
  expect(output).toContain("F1");
  expect(output).toContain("100.0%");
  expect(output).toContain("0.250");
});

test("negative identity scores display with their penalty, separately from MRR", () => {
  const ranked = family("device-to-person", { identityNet: -0.5, identityReward: 0.5, identityPenalty: 1, reciprocalRank: 0.5 });
  ranked.meanScore = -0.5;
  expect(familyHeadline(ranked)).toEqual({ label: "ID net", value: "-50.0%" });
  const output = familyTable([ranked]).join("\n");
  expect(output).toContain("-50.0%");
  expect(output).toContain("ID penalty");
  expect(output).toContain("MRR");
  expect(output).toContain("100.0%");
});

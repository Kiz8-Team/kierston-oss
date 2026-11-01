import { describe, expect, test } from "bun:test";
import { editSimilarity, haversineMetres, intervalIou, macroF1, median, recallAtK, reciprocalRank, setScore } from "../src/metrics.ts";

describe("ranked answers", () => {
  test("reciprocal rank is the position of the first true id", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["b"]))).toBeCloseTo(0.5);
    expect(reciprocalRank(["a", "b"], new Set(["z"]))).toBe(0);
    expect(reciprocalRank([], new Set(["a"]))).toBe(0);
  });

  test("recall@k looks only at the first k", () => {
    expect(recallAtK(["a", "b", "c"], new Set(["c"]), 5)).toBe(1);
    expect(recallAtK(["a", "b", "c"], new Set(["c"]), 2)).toBe(0);
  });
});

describe("set answers", () => {
  test("precision, recall and F1", () => {
    const score = setScore(["a", "b", "c"], ["b", "c", "d"]);
    expect(score.truePositives).toBe(2);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBeCloseTo(2 / 3);
    expect(score.f1).toBeCloseTo(2 / 3);
  });

  test("two empty sets agree", () => {
    expect(setScore([], []).f1).toBe(1);
  });

  test("an empty answer against a real set scores nothing", () => {
    expect(setScore([], ["a"]).f1).toBe(0);
  });
});

test("haversine is metres", () => {
  const metres = haversineMetres({ lat: 40.6, lon: -75.47 }, { lat: 40.601, lon: -75.47 });
  expect(metres).toBeGreaterThan(105);
  expect(metres).toBeLessThan(115);
});

describe("intervals", () => {
  test("identical intervals score 1", () => {
    expect(intervalIou({ start: 60, end: 120 }, { start: 60, end: 120 })).toBe(1);
  });

  test("half overlap", () => {
    expect(intervalIou({ start: 0, end: 60 }, { start: 30, end: 90 })).toBeCloseTo(30 / 90);
  });

  test("no overlap", () => {
    expect(intervalIou({ start: 0, end: 10 }, { start: 20, end: 30 })).toBe(0);
  });
});

test("edit similarity ranks a near-miss plate above a wrong one", () => {
  expect(editSimilarity("LAV-1459", "LAV-1459")).toBe(1);
  expect(editSimilarity("LAV-1458", "LAV-1459")).toBeGreaterThan(0.8);
  expect(editSimilarity("ZZZ-0000", "LAV-1459")).toBeLessThan(0.2);
});

test("macro-F1 counts an unanswered label as wrong", () => {
  const result = macroF1([
    { field: "mode", predicted: "walk", truth: "walk" },
    { field: "mode", predicted: null, truth: "car" },
  ]);
  expect(result.accuracy).toBe(0.5);
  expect(result.macroF1).toBeCloseTo(0.5);
});

test("median of an even count is the midpoint", () => {
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(median([])).toBeNull();
});

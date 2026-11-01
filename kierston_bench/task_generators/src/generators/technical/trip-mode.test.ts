import { describe, expect, test } from "bun:test";
import { classifiedTripMode, classifiedTripModeLabels } from "./trip-mode.ts";

describe("trip-mode classification", () => {
  test("classifies the simulator's other bucket as car", () => {
    expect(classifiedTripMode("other")).toBe("car");
  });

  test("removes other from the answer vocabulary without duplicating car", () => {
    expect(classifiedTripModeLabels(["car", "walk", "other", "taxi"]))
      .toEqual(["car", "walk", "taxi"]);
  });

  test("preserves distinct non-car modes", () => {
    expect(classifiedTripModeLabels(["carpool", "transit", "walk", "bike", "taxi", "cab", "bus", "passenger", "patrol"]))
      .toEqual(["carpool", "transit", "walk", "bike", "taxi", "cab", "bus", "passenger", "patrol"]);
  });
});

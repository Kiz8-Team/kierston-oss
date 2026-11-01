import { expect, test } from "bun:test";
import { parseKdiCall } from "../src/kdi-call.ts";

test("a query call is split into its operation, target, inputs and reason", () => {
  expect(parseKdiCall({
    args: [
      "query", "alpr", "reads",
      "--reason", "check camera passes during the observed window",
      "--input", "date=2026-09-01",
      "--input", "camera=ALPR-023",
      "--pretty",
    ],
  })).toEqual({
    operation: "query",
    target: "alpr › reads",
    inputs: [
      { name: "date", value: "2026-09-01" },
      { name: "camera", value: "ALPR-023" },
    ],
    reason: "check camera passes during the observed window",
    options: [],
  });
});

test("non-query calls retain meaningful options", () => {
  expect(parseKdiCall({ args: ["catalog", "--source", "alpr", "--pretty"] })).toEqual({
    operation: "catalog",
    inputs: [],
    options: ["--source", "alpr"],
  });
  expect(parseKdiCall({ args: ["--help"] }).operation).toBe("help");
});

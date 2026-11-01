import { describe, expect, test } from "bun:test";
import { importOptionsFromValues, resolveTableImport } from "../src/import-options.ts";

const allowed = ["first", "second", "third"] as const;

describe("table import options", () => {
  test("selects, trims, and deduplicates comma-separated tables", () => {
    const resolved = resolveTableImport(allowed, {
      tables: ["first, second", "first"],
      mode: "append",
    }, "overwrite");
    expect([...resolved.tables]).toEqual(["first", "second"]);
    expect(resolved.mode).toBe("append");
    expect(resolved.explicit).toBe(true);
  });

  test("uses every table without marking a legacy import explicit", () => {
    const resolved = resolveTableImport(allowed, undefined, "append");
    expect([...resolved.tables]).toEqual([...allowed]);
    expect(resolved.mode).toBe("append");
    expect(resolved.explicit).toBe(false);
  });

  test("rejects empty and unknown selections", () => {
    expect(() => resolveTableImport(allowed, { tables: [] }, "overwrite"))
      .toThrow("at least one table is required");
    expect(() => resolveTableImport(allowed, { tables: ["missing"] }, "overwrite"))
      .toThrow("unknown table: missing");
  });

  test("parses transport values and validates the mode", () => {
    expect(importOptionsFromValues([], null)).toBeUndefined();
    expect(importOptionsFromValues(["first"], "overwrite")).toEqual({
      tables: ["first"], mode: "overwrite",
    });
    expect(() => importOptionsFromValues([], "replace")).toThrow("invalid import mode replace");
  });
});

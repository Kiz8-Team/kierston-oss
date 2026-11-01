import { describe, test, expect } from "bun:test";
import { applyBytes, diffBytes, digest } from "../src/storage/patch.ts";

/** Fixed local PRNG keeps fuzz cases and their failure output reproducible. */
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}
function buffer(length: number, seed: number): Buffer {
  const next = random(seed);
  return Buffer.from(Array.from({ length }, () => next() >>> 24));
}

describe("delta byte patches", () => {
  test("round-trips empty, appended, deleted, replaced, shifted and repeated data", () => {
    const base = buffer(4096, 11);
    const cases: [Buffer, Buffer][] = [
      [Buffer.alloc(0), Buffer.from("new")], [base, Buffer.alloc(0)], [base, Buffer.concat([base, Buffer.from("tail")])],
      [base, base.subarray(3)], [base, buffer(1024, 22)],
      [Buffer.alloc(4096), Buffer.concat([Buffer.alloc(1000), Buffer.from("x"), Buffer.alloc(4000)])],
    ];
    const next = random(42);
    for (let i = 0; i < 100; i++) {
      const start = next() % base.length, end = start + next() % (base.length - start);
      cases.push([base, Buffer.concat([base.subarray(0, start), buffer(next() % 128, i), base.subarray(end)])]);
    }
    for (const [before, after] of cases) expect(applyBytes(before, diffBytes(before, after)!)).toEqual(after);
    expect(diffBytes(base, base)).toBeUndefined();
    expect(diffBytes(Buffer.alloc(0), Buffer.alloc(0))).toBeUndefined();
  });

  test("distant edits store literals near the edits, not the large unchanged middle", () => {
    const base = buffer(1_000_000, 9);
    const next = Buffer.concat([base.subarray(0, 100), Buffer.from("inserted"), base.subarray(100, 900_000), base.subarray(900_010)]);
    const patch = diffBytes(base, next)!;
    expect(applyBytes(base, patch)).toEqual(next);
    const literalBytes = patch.operations.reduce((sum, op) => sum + (typeof op === "string" ? Buffer.byteLength(op, "base64") : 0), 0);
    expect(literalBytes).toBeLessThan(512);
  });

  test("rejects corrupt data, malformed copy ranges, invalid literals and lengths", () => {
    const base = Buffer.from("base"), patch = { length: 4, digest: digest(base), operations: [[0, 4] as [number, number]] };
    expect(() => applyBytes(Buffer.from("oops"), patch)).toThrow("digest mismatch");
    expect(() => applyBytes(base, { ...patch, operations: [[-1, 4]] })).toThrow("outside");
    expect(() => applyBytes(base, { ...patch, operations: [[0, 5]] })).toThrow("outside");
    expect(() => applyBytes(base, { ...patch, operations: ["!!!!"] })).toThrow("literal");
    expect(() => applyBytes(base, { ...patch, length: 5 })).toThrow("length mismatch");
  });
});

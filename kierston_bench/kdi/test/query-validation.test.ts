import { expect, test } from "bun:test";
import { findQuery } from "../src/catalog";
import { execute, QueryRejected, type QueryErrorCode } from "../src/execute";

const networkEvents = findQuery("carriers", "network_events")!.query;

async function rejected(request: Parameters<typeof execute>[1], code: QueryErrorCode): Promise<void> {
  try {
    await execute(networkEvents, request);
    throw new Error("query unexpectedly passed validation");
  } catch (error) {
    expect(error).toBeInstanceOf(QueryRejected);
    expect((error as QueryRejected).code).toBe(code);
  }
}

test("unknown filters are rejected rather than ignored", async () => {
  await rejected({ filters: [{ field: "private_person_id", operator: "eq", values: ["1"] }] }, "INVALID_FILTER");
});

test("batch filters have a declared bound", async () => {
  await rejected({ filters: [
    { field: "date", operator: "eq", values: ["2026-09-01"] },
    { field: "imsi", operator: "eq", values: Array.from({ length: 101 }, (_, index) => String(index)) },
  ] }, "BATCH_TOO_LARGE");
});

test("event ranges require both bounds and enforce cohort span", async () => {
  await rejected({ filters: [
    { field: "occurred_at", operator: "gte", values: ["2026-09-01T00:00:00Z"] },
    { field: "cell", operator: "eq", values: ["cell"] },
  ] }, "WINDOW_REQUIRED");
  await rejected({ filters: [
    { field: "occurred_at", operator: "gte", values: ["2026-09-01T00:00:00Z"] },
    { field: "occurred_at", operator: "lt", values: ["2026-09-03T00:00:00Z"] },
    { field: "cell", operator: "eq", values: ["cell"] },
  ] }, "WINDOW_TOO_LARGE");
});

test("projection cannot reach a non-public column", async () => {
  await rejected({
    filters: [
      { field: "date", operator: "eq", values: ["2026-09-01"] },
      { field: "imsi", operator: "eq", values: ["310260000000001"] },
    ],
    select: ["_version"],
  }, "INVALID_SELECT");
});

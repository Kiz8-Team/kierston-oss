import { expect, test } from "bun:test";
import { deleteIds, type Database } from "../src/database.ts";

test("deletes more than one batch of IDs in one synchronous mutation, deduplicating IDs", async () => {
  const calls: any[] = [];
  const database = { database: "fixture", client: { command: async (args: unknown) => { calls.push(args); } } } as unknown as Database;
  const ids = Array.from({ length: 10_474 }, (_, i) => `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`);
  await deleteIds(database, "network_events", "event_id", [...ids, ids[0]!]);
  expect(calls).toHaveLength(1);
  expect(calls[0].query_params).toBeUndefined();
  expect(Number(calls[0].clickhouse_settings.max_query_size)).toBeGreaterThan(Buffer.byteLength(calls[0].query));
  expect(calls[0].query.match(/'00000000-0000-0000-0000-/g)).toHaveLength(ids.length);
  expect(calls[0].query).toContain("mutations_sync = 1");
  await deleteIds(database, "network_events", "event_id", []);
  expect(calls).toHaveLength(1);
  await expect(deleteIds(database, "network_events", "event_id", ["bad' SQL"])).rejects.toThrow("invalid UUID");
  expect(calls).toHaveLength(1);
});

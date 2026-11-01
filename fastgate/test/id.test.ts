import { expect, test } from "bun:test";
import { recordId } from "kierston-provider-rows";

test("record IDs are stable without exposing a shared source prefix or row suffix", () => {
  const first = recordId("source digest", "network_events", 1);
  const again = recordId("source digest", "network_events", 1);
  const next = recordId("source digest", "network_events", 2);

  expect(first).toBe(again);
  expect(first).not.toBe(next);
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first.slice(0, 18)).not.toBe(next.slice(0, 18));
  expect(first.replaceAll("-", "").slice(-16)).not.toBe("0000000000000001");
});

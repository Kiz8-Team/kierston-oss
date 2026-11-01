import { expect, test } from "bun:test";
import { findQuery, publicCatalog } from "../src/catalog";
import { cutoffSource, execute, QueryRejected } from "../src/execute";
import { applyQueryPolicy, parseKdiPolicy, redactSubject } from "../src/policy";
import type { KdiPolicy } from "../../task_generators/src/task";

const homePolicy: KdiPolicy = {
  queries: [{ source: "ssa", search: "people", redactColumns: ["mailing_address"] }],
  redactSubjectFields: ["address"],
};

test("home policy hides the SSA residence from discovery", () => {
  const people = publicCatalog(homePolicy).find((source) => source.id === "ssa")!
    .queries.find((query) => query.id === "people")!;
  expect(people.selectable).not.toContain("mailing_address");
  expect(people.columns.map((column) => column.name)).not.toContain("mailing_address");
  expect(publicCatalog().find((source) => source.id === "ssa")!.queries
    .find((query) => query.id === "people")!.selectable).toContain("mailing_address");
});

test("home policy makes an explicit SSA residence projection invalid", async () => {
  const people = applyQueryPolicy(homePolicy, "ssa", findQuery("ssa", "people")!.query);
  try {
    await execute(people, {
      filters: [{ field: "ssn", operator: "eq", values: ["000-00-0000"] }],
      select: ["mailing_address"],
    });
    throw new Error("query unexpectedly passed validation");
  } catch (error) {
    expect(error).toBeInstanceOf(QueryRejected);
    expect((error as QueryRejected).code).toBe("INVALID_SELECT");
  }
});

test("home policy removes address from subject metadata", () => {
  const subject = redactSubject(homePolicy, {
    name: "Jane Doe", dob: "1980-01-01", ssn: "000-00-0000",
    address: "15 Main Street", mobile: "555-0100", derivation: "test",
  });
  expect(subject).not.toHaveProperty("address");
  expect(subject?.name).toBe("Jane Doe");
});

test("policy parser rejects malformed subject fields", () => {
  expect(() => parseKdiPolicy('{"redactSubjectFields":["unknown"]}')).toThrow("unknown field");
});

const liveCutoff: KdiPolicy = { cutoff: "2026-09-04T21:25:00-04:00" };

test("a cutoff attaches to history searches only, as a UTC instant, and is announced in the note", () => {
  const calls = applyQueryPolicy(liveCutoff, "carriers", findQuery("carriers", "calls")!.query);
  expect(calls.cutoff).toBe("2026-09-05T01:25:00.000Z");
  expect(calls.note).toContain("2026-09-04T21:25:00-04:00");
  const people = applyQueryPolicy(liveCutoff, "ssa", findQuery("ssa", "people")!.query);
  expect(people.cutoff).toBeUndefined();
  expect(publicCatalog(liveCutoff).find((source) => source.id === "alpr")!.queries
    .find((query) => query.id === "reads")!.note).toContain("not yet available");
});

test("a cutoff becomes a clock bound on the search's source table", () => {
  const handovers = applyQueryPolicy(liveCutoff, "carriers", findQuery("carriers", "handovers")!.query);
  const params: Record<string, unknown> = {};
  expect(cutoffSource(handovers, params))
    .toBe("(SELECT * FROM `call_handovers` WHERE `occurred_at` <= {cutoff:DateTime64(3, 'UTC')})");
  expect(params.cutoff).toBe("2026-09-05 01:25:00.000");
  expect(cutoffSource(findQuery("carriers", "messages")!.query, {})).toBeNull();
});

test("a cutoff masks message delivery after it, reading only stored values", () => {
  const messages = applyQueryPolicy(liveCutoff, "carriers", findQuery("carriers", "messages")!.query);
  const sql = cutoffSource(messages, {})!;
  expect(sql).toContain("WHERE `submitted_at` <= {cutoff:DateTime64(3, 'UTC')}");
  expect(sql).toContain("if(`kdi_stored_delivered_at` > {cutoff:DateTime64(3, 'UTC')}, NULL, `kdi_stored_delivered_at`) AS `delivered_at`");
  expect(sql).toContain("NULL, `kdi_stored_destination_cell_cgi`) AS `destination_cell_cgi`");
  expect(sql).not.toContain("$");
});

test("a cutoff clamps call timing and hides end cells of calls still running", () => {
  const calls = applyQueryPolicy(liveCutoff, "carriers", findQuery("carriers", "calls")!.query);
  const sql = cutoffSource(calls, {})!;
  for (const column of ["ring_seconds", "outcome", "duration_seconds", "end_cell_cgi", "destination_end_cell_cgi"])
    expect(sql).toContain(`AS \`${column}\``);
  expect(sql).toContain("`setup_at` AS `kdi_stored_setup_at`");
  expect(sql).not.toMatch(/\(`ring_seconds`\)/);
});

test("policy parser rejects a cutoff without an offset", () => {
  expect(() => parseKdiPolicy('{"cutoff":"2026-09-04T21:25:00"}')).toThrow("offset");
  expect(() => parseKdiPolicy('{"cutoff":"not a time"}')).toThrow("ISO 8601");
  expect(parseKdiPolicy('{"cutoff":"2026-09-04T21:25:00Z"}')?.cutoff).toBe("2026-09-04T21:25:00Z");
});

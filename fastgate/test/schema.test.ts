import { expect, test } from "bun:test";
import { schemaSql } from "../src/schema.ts";

test("schema contains only day-derived records and its import markers", () => {
  const names = schemaSql("fastgate_test")
    .map((statement) => statement.match(/CREATE TABLE IF NOT EXISTS `fastgate_test`\.(\w+)/)?.[1])
    .filter((name): name is string => name !== undefined);

  expect(names).toEqual([
    "ingested_days",
    "active_scenarios",
    "scenario_journal",
    "alpr_reads",
    "network_events",
    "sms_records",
    "call_records",
    "call_handovers",
    "bank_transactions",
  ]);
});

// Identity lives in the provider tables. A carrier writes an IMSI and an IMEI
// on an event, not a name, and no processor puts an SSN on a card swipe.
test("no dynamic table carries a copied identity column", () => {
  const sql = schemaSql("fastgate_test").join("\n");
  for (const column of ["first_name", "middle_name", "last_name", "date_of_birth", "ssn"]) {
    expect(sql).not.toContain(column);
  }
});

test("network events carry the cell's own distance measurement and the secondary carrier", () => {
  const sql = schemaSql("fastgate_test").join("\n");
  expect(sql).toContain("timing_advance Nullable(UInt16)");
  expect(sql).toContain("secondary_cell_cgi Nullable(String)");
  expect(sql).toContain("ADD COLUMN IF NOT EXISTS timing_advance");
});

test("carrier records carry the handset and a cell at each end", () => {
  const sql = schemaSql("fastgate_test").join("\n");
  for (const column of [
    "imei Nullable(String)", "originating_imei", "destination_imei",
    "originating_cell_cgi", "destination_cell_cgi",
    "destination_origin_cell_cgi", "destination_end_cell_cgi",
  ]) {
    expect(sql).toContain(column);
  }
});

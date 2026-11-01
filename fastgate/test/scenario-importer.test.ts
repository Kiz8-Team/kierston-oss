import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { KdayReader } from "kierston-provider-rows";
import { KdifReader, readDelta } from "../src/kdif.ts";
import { differingRows, scenarioRecords } from "kierston-provider-rows";
import { writeAmountScenarioFixture, writeObservableFixture } from "./fixture.ts";

test("row pairing ignores position and pairs duplicates one for one", () => {
  const base = BigUint64Array.from([1n, 2n, 2n, 3n]);
  const scenario = BigUint64Array.from([3n, 2n, 4n, 1n]);
  const changed = differingRows(base, scenario);
  expect(Array.from(changed.deleted)).toEqual([1]);
  expect(Array.from(changed.inserted)).toEqual([2]);
});

test("a delta carries only the provider rows its scenario changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-records-test-"));
  const basePath = join(directory, "base.bin"), deltaPath = join(directory, "scenario.kdiff");
  try {
    await writeObservableFixture(basePath);
    const baseDigest = createHash("sha256").update(await readFile(basePath)).digest("hex");
    await writeAmountScenarioFixture(basePath, deltaPath);
    const delta = await readDelta(deltaPath);
    const records = delta.records!;
    expect(records.scenarioId).toMatch(/^[a-f0-9]{64}$/);
    const counts = Object.fromEntries(Object.entries(records.tables).map(([name, entry]) => [
      name, [entry.deleted.length, entry.inserted.length],
    ]));
    expect(counts).toEqual({
      alpr_reads: [0, 0], network_events: [0, 0], sms_records: [0, 0],
      call_records: [0, 0], call_handovers: [0, 0], bank_transactions: [1, 1],
    });
    const [removed] = records.tables.bank_transactions.deleted;
    const [added] = records.tables.bank_transactions.inserted;
    expect(removed).toMatchObject({ amount: "12.50", merchant: "Market" });
    expect(added).toMatchObject({ amount: "19.75", merchant: "Market" });
    expect(added!.transaction_id).not.toBe(removed!.transaction_id);
    expect(typeof added!.occurred_at).toBe("string");

    // Recomputing from the readers gives the same rows the file carries.
    const [base, scenario] = await Promise.all([KdayReader.open(basePath), KdifReader.open(basePath, deltaPath, baseDigest)]);
    try {
      const again = await scenarioRecords(base, scenario, baseDigest, records.scenarioId, "America/New_York");
      expect(JSON.parse(JSON.stringify(again.tables))).toEqual(records.tables);
    } finally {
      await Promise.all([base.close(), scenario.close()]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

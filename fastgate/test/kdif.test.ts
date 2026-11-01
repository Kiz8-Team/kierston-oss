import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { KdifReader } from "../src/kdif.ts";
import { writeAmountScenarioFixture, writeObservableFixture } from "./fixture.ts";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
test("opens a KDIF as a lazy KDAY overlay and verifies its exact base", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-kdif-test-"));
  const basePath = join(directory, "base.bin"), deltaPath = join(directory, "scenario.kdiff");
  try {
    await writeObservableFixture(basePath);
    const baseBytes = await readFile(basePath), baseDigest = digest(baseBytes);
    await writeAmountScenarioFixture(basePath, deltaPath);

    const scenario = await KdifReader.open(basePath, deltaPath, baseDigest);
    try {
      expect(Array.from(await scenario.column("tx.amount"))).toEqual([19.75]);
      expect((scenario.meta as typeof scenario.meta & { scenario: { name: string } }).scenario.name).toBe("fixture");
      expect(Array.from(await scenario.column("event.minute"))).toEqual([10]);
    } finally {
      await scenario.close();
    }
    await expect(KdifReader.open(basePath, deltaPath, "0".repeat(64))).rejects.toThrow("base hash");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

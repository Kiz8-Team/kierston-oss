import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRun } from "../src/delete-run.ts";
import type { RunSummary } from "../src/inventory.ts";

function summary(runsDir: string, series: string, runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    series, runId, dir: join(runsDir, series, runId), total: 1, done: 1, inFlight: 0, counts: {},
    state: "complete", lastActivity: 0, ...over,
  };
}

async function fixture(): Promise<{ root: string; runsDir: string; kdiLogDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "kbench-delete-run-"));
  const dirs = { root, runsDir: join(root, "runs"), kdiLogDir: join(root, "kdi_log") };
  for (const dir of [dirs.runsDir, dirs.kdiLogDir]) await mkdir(dir, { recursive: true });
  return dirs;
}

test("deleting a run removes its directory and its KDI service logs, and leaves the series and other runs", async () => {
  const { root, runsDir, kdiLogDir } = await fixture();
  try {
    await mkdir(join(runsDir, "s3", "run-gone", "account-resolution_2026-09-05_1"), { recursive: true });
    await mkdir(join(runsDir, "s3", "run-gone", "trip-mode_2026-09-05_2"), { recursive: true });
    await mkdir(join(runsDir, "s3", "run-gone", ".reruns"), { recursive: true });
    await mkdir(join(runsDir, "s3", "run-stays"), { recursive: true });
    await writeFile(join(kdiLogDir, "run-gone_account-resolution_2026-09-05_1.jsonl"), "{}\n");
    await writeFile(join(kdiLogDir, "run-gone_trip-mode_2026-09-05_2.jsonl"), "{}\n");
    await writeFile(join(kdiLogDir, "run-stays_trip-mode_2026-09-05_2.jsonl"), "{}\n");

    expect(await deleteRun(summary(runsDir, "s3", "run-gone"), runsDir, kdiLogDir)).toEqual({ tasks: 2, kdiLogs: 2 });
    expect(await readdir(join(runsDir, "s3"))).toEqual(["run-stays"]);
    expect(await readdir(kdiLogDir)).toEqual(["run-stays_trip-mode_2026-09-05_2.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the series directory goes when its last run does, so the series stops claiming runs", async () => {
  const { root, runsDir, kdiLogDir } = await fixture();
  try {
    await mkdir(join(runsDir, "s3", "only-run"), { recursive: true });
    await deleteRun(summary(runsDir, "s3", "only-run"), runsDir, kdiLogDir);
    expect(await readdir(runsDir)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run id that climbs out of the runs directory is refused", async () => {
  const { root, runsDir, kdiLogDir } = await fixture();
  try {
    await mkdir(join(runsDir, "s3", "run-1"), { recursive: true });
    for (const runId of ["..", "../..", "."]) {
      await expect(deleteRun(summary(runsDir, "s3", runId), runsDir, kdiLogDir)).rejects.toThrow("escapes");
    }
    expect(await readdir(join(runsDir, "s3"))).toEqual(["run-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

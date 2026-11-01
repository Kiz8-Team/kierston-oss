/**
 * The series file a run was dispatched against, by content.
 *
 * A series is resolved by id, and `new-series --force` rewrites the file under
 * the same id. A run records the sha256 of the series file it started from
 * (selection.json at start, run.json at the end); scoring and reruns compare
 * that hash with the file on disk and refuse when they differ, since the
 * truth, prompts or task set may have changed under the same id.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function seriesSha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** The hash a run recorded: run.json first, else selection.json. Undefined for runs before 2026-10-06. */
export async function recordedSeriesSha256(runDir: string): Promise<string | undefined> {
  for (const name of ["run.json", "selection.json"]) {
    try {
      const value = (JSON.parse(await readFile(join(runDir, name), "utf8")) as { seriesSha256?: unknown }).seriesSha256;
      if (typeof value === "string") return value;
    } catch { /* absent or torn; try the next */ }
  }
  return undefined;
}

/**
 * Throws when the run recorded a series hash and the series file now hashes
 * differently. A run with no recorded hash passes; it predates the record.
 */
export async function assertSeriesUnchanged(runDir: string, seriesFile: string): Promise<void> {
  const recorded = await recordedSeriesSha256(runDir);
  if (recorded === undefined) return;
  const current = await seriesSha256(seriesFile);
  if (current !== recorded) {
    throw new Error(
      `series file ${seriesFile} changed since this run was dispatched: run recorded sha256 ${recorded}, file is now ${current}. `
      + "Score or rerun against the original series file, or dispatch a new run.",
    );
  }
}

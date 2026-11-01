/**
 * Deleting one run: its directory, and the KDI service's own copies of its per-task
 * call logs. The series it was made from is left alone — it is the input, not
 * the output.
 *
 * A run id, and the name the launcher saved for it, are only claimed by the
 * directory on disk, so removing it frees both for the next run to reuse.
 */

import { readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { kdiLogName } from "../../eval_runner/src/runner.ts";
import type { RunSummary } from "./inventory.ts";
import { PATHS } from "./paths.ts";

export interface DeletedRun {
  /** Task directories the run had opened. */
  tasks: number;
  /** Per-task logs removed from the KDI service's log directory. */
  kdiLogs: number;
}

export async function deleteRun(run: RunSummary, runsDir = PATHS.runs, kdiLogDir = PATHS.kdiLog): Promise<DeletedRun> {
  const dir = resolve(runsDir, run.series, run.runId);
  const inside = resolve(runsDir) + sep;
  if (!dir.startsWith(inside) || resolve(runsDir, run.series) === dir) {
    throw new Error(`run ${JSON.stringify(`${run.series}/${run.runId}`)} escapes ${runsDir}`);
  }

  const tasks = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name !== ".reruns").length;
  await rm(dir, { recursive: true, force: true });

  // The KDI service names its logs from `<run id>/<task id>`, so every one of this
  // run's logs carries that prefix and nothing else does.
  const prefix = kdiLogName(`${run.runId}/`).slice(0, -".jsonl".length);
  let kdiLogs = 0;
  for (const entry of await readdir(kdiLogDir).catch(() => [])) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".jsonl")) continue;
    await rm(join(kdiLogDir, entry), { force: true });
    kdiLogs += 1;
  }

  // A series directory left empty says a series has runs when it has none.
  if ((await readdir(resolve(runsDir, run.series)).catch(() => ["keep"])).length === 0) {
    await rm(resolve(runsDir, run.series), { recursive: true, force: true });
  }

  return { tasks, kdiLogs };
}

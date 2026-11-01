/** Execute separately before replacing one result and rescoring the run. */
import { mkdir, mkdtemp, rename, copyFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildArgs, runDirFor } from "./dispatch.ts";
import { taskDirName, type TaskMeta } from "../../eval_runner/src/runner.ts";
import { scoreRun, truthWarning } from "../../scoring/src/score.ts";
import { PATHS, REPO_ROOT } from "./paths.ts";
import { savedSpec } from "./background.ts";
import { assertSeriesUnchanged } from "../../eval_runner/src/series-digest.ts";

async function rerun(dir: string, taskId: string, workerDir: string) {
  const original = await savedSpec(dir);
  // The rerun and the rescore read the series file by path; both are wrong if
  // it was rebuilt since the run was dispatched.
  await assertSeriesUnchanged(dir, original.seriesFile);
  const history = join(dir, ".reruns");
  await mkdir(history, { recursive: true });
  const attempt = await mkdtemp(join(history, "attempt-"));
  const spec = { ...original, runId: `${original.runId}-rerun-${crypto.randomUUID()}`, rerunTask: undefined, resume: false, families: [], taskIds: [taskId], concurrency: 1, outDir: attempt };
  await writeFile(join(dir, "rerun-active.json"), JSON.stringify({ taskId, taskDir: join(runDirFor(spec), taskDirName(taskId)), workerDir }));
  const child = Bun.spawn([process.execPath, ...buildArgs(spec)], { cwd: REPO_ROOT, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const code = await child.exited;
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  const result = await Bun.file(join(runDirFor(spec), "run.json")).json().catch(() => null);
  if (code !== 0 || !result || result.interrupted || !result.tasks.some((task: TaskMeta) => task.id === taskId)) {
    throw new Error(`Rerun did not finish; original result retained. Attempt: ${attempt}`);
  }
  const target = join(dir, taskDirName(taskId));
  await copyFile(join(dir, "run.json"), join(attempt, "previous-run.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await copyFile(join(dir, "score.json"), join(attempt, "previous-score.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const backup = join(attempt, "previous-task");
  let hadPrevious = false;
  try { await rename(target, backup); hadPrevious = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await rename(join(runDirFor(spec), taskDirName(taskId)), target); }
  catch (error) { if (hadPrevious) await rename(backup, target); throw error; }
  // The original runner owns its report and selection, including while it is
  // still running. Inventory reads current task metadata after a replacement.
  await writeFile(join(dir, "rerun-updated.json"), JSON.stringify({ taskId, at: new Date().toISOString() }));
  const previousScore = await Bun.file(join(attempt, "previous-score.json")).json().catch(() => null);
  const rescored = await scoreRun({ ...previousScore?.options, seriesFile: original.seriesFile, runDir: dir, simDataDir: PATHS.simData, writeInto: true });
  const unfrozen = truthWarning(rescored);
  if (unfrozen) console.error(unfrozen);
  await copyFile(join(runDirFor(spec), "run.json"), join(workerDir, "run.json"));
  console.log(`${taskId}: rerun complete; full run score updated. Previous attempt: ${attempt}`);
}

if (import.meta.main) {
  try { await rerun(process.argv[2]!, process.argv[3]!, process.argv[4]!); }
  finally {
    await rm(join(process.argv[2]!, "rerun-active.json"), { force: true });
    await rm(join(process.argv[2]!, ".reruns", "launch.lock"), { recursive: true, force: true });
  }
}

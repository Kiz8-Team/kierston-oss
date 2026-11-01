/**
 * Score one run against the series it was launched from.
 *
 *   bun run kierston_bench/scoring/src/cli.ts <run dir> [options]
 *
 * The run directory is `runs/<series>/<run id>`; the series file is found
 * from it unless `--series` says otherwise. Nothing is written unless
 * `--write` is given.
 *
 * Options
 *   --series <file>        the run series JSON; default run_series/run_series_<series>_tasks_data.json
 *   --sim-data <dir>       registers for a series built without a truth snapshot; default kierston/sim_data
 *   --family <name>        only this family; repeatable
 *   --task <id>            only this task; repeatable
 *   --ambiguity <policy>   strict (default) or lenient: may an identifier naming several people score?
 *   --place-credit <m>     metres within which a point answer is right; default 100
 *   --arrival-credit <min> minutes within which an arrival time is right; default 15
 *   --recall-k <k>         k for recall@k on ranked families; default 5
 *   --validate-only        check answer shapes; read no ground truth
 *   --tasks                also print the per-task table
 *   --json | --csv         machine-readable output instead of tables
 *   --write                write score.json into the run directory
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { scoreRun, loadSeries, loadRunMetas, readJson, truthWarning } from "./score.ts";
import { renderRunScore, toCsv, table } from "./report.ts";
import { validateSubmission } from "./validate.ts";
import type { Submission } from "../../eval_runner/src/bundle.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import { join } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BENCH_ROOT = resolve(import.meta.dir, "../..");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    series: { type: "string" },
    "sim-data": { type: "string", default: resolve(REPO_ROOT, "kierston/sim_data") },
    family: { type: "string", multiple: true },
    task: { type: "string", multiple: true },
    ambiguity: { type: "string", default: "strict" },
    "place-credit": { type: "string" },
    "arrival-credit": { type: "string" },
    "recall-k": { type: "string" },
    "validate-only": { type: "boolean", default: false },
    tasks: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    csv: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.error("usage: cli.ts <run dir> [--series f] [--family f]... [--task id]... [--ambiguity strict|lenient] [--validate-only] [--tasks] [--json|--csv] [--write]");
  process.exit(values.help ? 0 : 2);
}

const runDir = resolve(positionals[0]!);
const seriesFile = values.series ? resolve(values.series) : await seriesFileFor(runDir);
if (seriesFile === null) {
  console.error(`cannot find the series file for ${runDir}; pass --series`);
  process.exit(2);
}

if (values["validate-only"]) {
  await validateOnly(seriesFile, runDir);
  process.exit(0);
}

const result = await scoreRun({
  seriesFile,
  runDir,
  simDataDir: resolve(values["sim-data"]),
  families: values.family?.length ? new Set(values.family) : undefined,
  taskIds: values.task?.length ? new Set(values.task) : undefined,
  ambiguity: values.ambiguity === "lenient" ? "lenient" : "strict",
  ...(values["place-credit"] ? { placeCreditMetres: Number(values["place-credit"]) } : {}),
  ...(values["arrival-credit"] ? { arrivalCreditMinutes: Number(values["arrival-credit"]) } : {}),
  ...(values["recall-k"] ? { recallK: Number(values["recall-k"]) } : {}),
  writeInto: values.write,
});

const unfrozen = truthWarning(result);
if (unfrozen) console.error(unfrozen);
if (values.json) console.log(JSON.stringify(result, null, 2));
else if (values.csv) process.stdout.write(toCsv(result));
else console.log(renderRunScore(result, { tasks: values.tasks }));

if (values.write && !values.json && !values.csv) console.error(`wrote ${join(runDir, "score.json")}`);

/** `runs/<series>/<run id>` names its series; run.json confirms it. */
async function seriesFileFor(dir: string): Promise<string | null> {
  const report = await readJson<{ series?: string }>(join(dir, "run.json"));
  const series = report?.series ?? dir.split("/").slice(-2)[0];
  if (!series) return null;
  const candidate = resolve(BENCH_ROOT, "run_series", `run_series_${series}_tasks_data.json`);
  return (await Bun.file(candidate).exists()) ? candidate : null;
}

/** Answer shapes alone: no ground truth is read, so a series' truth stays shut. */
async function validateOnly(seriesFile: string, dir: string): Promise<void> {
  const series = await loadSeries(seriesFile);
  const metas = await loadRunMetas(dir);
  const rows: string[][] = [];
  let ok = 0;
  for (const task of series.tasks) {
    if (values.family?.length && !values.family.includes(task.family)) continue;
    if (values.task?.length && !values.task.includes(task.id)) continue;
    const submission = await readJson<Submission>(join(dir, taskDirName(task.id), "answer.json"));
    const meta = metas.get(task.id);
    if (submission === null && meta === undefined) continue;
    const validation = validateSubmission(task.answer, submission);
    if (validation.ok) ok += 1;
    const worst = validation.issues.find((issue) => issue.severity === "error") ?? validation.issues[0];
    rows.push([
      task.id,
      validation.ok ? "ok" : "invalid",
      String(validation.issues.length),
      worst ? `${worst.field ? worst.field + ": " : ""}${worst.message}` : "",
    ]);
  }
  if (values.json) {
    console.log(JSON.stringify({ series: series.series.id, ok, checked: rows.length, rows }, null, 2));
    return;
  }
  console.log(table(["task", "shape", "issues", "first issue"], rows, ["left", "left", "right", "left"]).join("\n"));
  console.log(`\n${ok} of ${rows.length} answers are well formed`);
}

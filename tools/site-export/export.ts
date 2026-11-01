/**
 * Packs finished runs into static JSON for the project website.
 *
 *   bun run site-export --out <dir> [--sim-data <dir>] s3/<run id> [s3/<run id> ...]
 *
 * Claims are resolved against each series' own truth snapshot; `--sim-data` is only for a series built without one.
 *
 * The site has no server: it reads `index.json`, one row per run and task with
 * the score, cost and time. No prompt, answer or transcript is published,
 * because they carry the simulated people's names, dates of birth and SSNs.
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { findRun, loadRun, loadTask } from "../../kierston_bench/bench_cli/src/inventory.ts";
import { TASK_GROUPS, taskGroupOf } from "../../kierston_bench/task_generators/src/groups.ts";
import { DEFAULT_SCORE_OPTIONS } from "../../kierston_bench/scoring/src/families.ts";
import { loadSeries, scoreTask } from "../../kierston_bench/scoring/src/score.ts";
import { TruthIndex } from "../../kierston_bench/scoring/src/truth.ts";
import { RETIRED_FAMILIES } from "../../kierston_bench/task_generators/src/retired.ts";
import { PATHS, seriesFileFor } from "../../kierston_bench/bench_cli/src/paths.ts";

/** What the run cost, summed from the agent's own session log. */
async function spend(taskDir: string) {
  const logDir = join(taskDir, "logs");
  let cost = 0;
  let model: string | undefined;
  for (const log of (await readdir(logDir).catch(() => [])).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of (await Bun.file(join(logDir, log)).text()).split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line) as { type?: string; modelId?: string; message?: { usage?: { cost?: { total?: number } } } };
        if (event.type === "model_change") model = event.modelId;
        cost += event.message?.usage?.cost?.total ?? 0;
      } catch {
        continue;
      }
    }
  }
  return { cost, model };
}

function parseArgs(argv: string[]) {
  let out: string | undefined;
  let simData = PATHS.simData;
  const refs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--sim-data") simData = argv[++i] ?? simData;
    else refs.push(argv[i]!);
  }
  return { out, simData, refs };
}

const { out, simData, refs } = parseArgs(process.argv.slice(2));
if (refs.length === 0 || !out) {
  console.error("usage: bun run site-export --out <dir> [--sim-data <dir>] <series>/<run id> ...");
  process.exit(2);
}

// `city.json` from `site-city` lives beside these and is left alone.
// Per-task files are no longer published: prompts and answers carry the simulated people's details.
await rm(join(out, "t"), { recursive: true, force: true });
const series = new Map<string, Map<string, Awaited<ReturnType<typeof loadSeries>>["tasks"][number]>>();
const truths = new Map<string, TruthIndex>();
const runs = [];
let bytes = 0;

for (const ref of refs) {
  const summary = await findRun(ref);
  if (!summary) {
    console.error(`no such run: ${ref}`);
    process.exit(1);
  }
  const run = await loadRun(summary.dir, summary.series, summary.runId);
  if (!series.has(run.series)) {
    const data = await loadSeries(seriesFileFor(run.series)).catch(() => null);
    series.set(run.series, new Map((data?.tasks ?? []).map((task) => [task.id, task])));
    if (!data?.truth) console.error(`${run.series}: no truth snapshot in the series; resolving against ${simData}`);
    truths.set(run.series, new TruthIndex(data?.truth ?? simData));
  }
  const truth = truths.get(run.series)!;
  const launch = (await Bun.file(join(run.dir, "launch.json")).json().catch(() => null)) as { spec?: { model?: string } } | null;
  const slug = (run.name ?? run.runId).replace(/[^A-Za-z0-9._-]+/g, "-");

  const tasks = [];
  for (const row of run.tasks) {
    if (row.status === "not-run" || row.status === "pending") continue;
    if (RETIRED_FAMILIES.has(row.family)) continue;
    const detail = await loadTask(run.dir, row, 0);
    const log = await spend(detail.dir);
    // Scored again here only to tell a whole-task abstention from an unscored attempt.
    const seriesTask = series.get(run.series)?.get(row.id);
    const rescored = seriesTask && detail.answer ? await scoreTask(seriesTask, detail.answer as never, truth, DEFAULT_SCORE_OPTIONS) : null;
    const answeredStatus = (detail.answer?.answer as { status?: string } | null | undefined)?.status;
    const listed = {
      id: row.id,
      family: row.family,
      date: row.date,
      status: row.status,
      score: row.score ?? null,
      durationMs: row.durationMs,
      adiCalls: row.kdiCalls ?? detail.kdiCalls.length,
      cost: Math.round(log.cost * 1000) / 1000,
      // A whole-task abstention scores null; the site needs to tell it from an unscored or failed attempt.
      // A task redrawn since the run cannot be rescored, so the answer file's own status is the fallback.
      abstained: Boolean(rescored?.abstentionReason) || rescored?.status === "abstained" || answeredStatus === "undetermined",
    };

    tasks.push(listed);
  }

  runs.push({
    slug,
    series: run.series,
    runId: run.runId,
    model: launch?.spec?.model,
    startedAt: run.startedAt,
    meanScore: run.scoreReport?.aggregate.meanScore ?? null,
    tasks,
  });
  console.log(`${slug}: ${tasks.length} tasks`);
}

// A later run of a family replaces a model's earlier attempts at it, so a rerun
// such as a single-task sweep stands as that model's result for the family.
const latest = new Map<string, string>();
for (const run of [...runs].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))))
  for (const task of run.tasks) latest.set(`${run.model}\u0000${task.family}`, run.runId);
for (const run of runs) {
  const kept = run.tasks.filter((task) => latest.get(`${run.model}\u0000${task.family}`) === run.runId);
  for (const task of run.tasks) if (!kept.includes(task)) console.log(`${run.slug}: ${task.family} replaced by a later run`);
  run.tasks = kept;
}

const families = [...new Set(runs.flatMap((run) => run.tasks.map((task) => task.family)))].sort();
const groups = TASK_GROUPS.map((group) => ({
  id: group.id,
  abbreviation: group.abbreviation,
  label: group.label,
  description: group.description,
  families: families.filter((family) => taskGroupOf(family)?.id === group.id),
})).filter((group) => group.families.length > 0);
const retired = families.filter((family) => !taskGroupOf(family));
if (retired.length > 0) groups.push({ id: "technical", abbreviation: "TT", label: "Other", description: "Retired families", families: retired });
bytes += await Bun.write(join(out, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), groups, runs }));
console.log(`${out}: ${(bytes / 1e6).toFixed(1)} MB`);

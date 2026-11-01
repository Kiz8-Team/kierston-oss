#!/usr/bin/env bun
/**
 * The Kierston Bench CLI: one command for the benchmark's runs.
 *
 *   bun run kierston_bench/bench_cli/src/cli.ts              # the TUI
 *   bun run kierston_bench/bench_cli/src/cli.ts runs         # the same list, as text
 *
 * Interactive with no arguments; every view it offers also exists as a
 * subcommand, so the same tool serves a person watching a run and a script
 * collecting its numbers. Nothing here re-implements the runner, the series
 * builder or the scorer — it drives them and reads what they wrote.
 *
 * Commands
 *   ui [run]                  the interactive TUI (default; scores finished runs by itself)
 *   runs                      every run and how far it got
 *   series                    the run series available to dispatch
 *   show <run>                one run: counts, timings and its tasks
 *   task <run> <task id>      one task: answer, notes, KDI calls, console tail
 *   dispatch <series>         start a run and follow it
 *   watch <run>               follow a run started elsewhere
 *   score <run>               score a run against its series' ground truth
 *   validate <run>            check answer shapes, reading no ground truth
 *   new-series <config.toml>  build a run series from a prep config
 *   doctor                    docker, image, KDI service, registers, credentials
 *   sweep [series]            one task on every model in --models: a run per model
 *   sweeps [sweep]            list sweeps, or one sweep's runs
 *
 * Common options: --json for machine-readable output, --help on any command.
 */

import { control, saveLaunch, startBackground, resumeSpec } from "./background.ts";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { scoreRun, truthWarning } from "../../scoring/src/score.ts";
import { assertSeriesUnchanged } from "../../eval_runner/src/series-digest.ts";
import { renderRunScore, toCsv, table } from "../../scoring/src/report.ts";
import { validateSubmission } from "../../scoring/src/validate.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import { bar, duration, paint, percent, since, stamp } from "./format.ts";
import { findRun, listRuns, listSeries, loadRun, loadTask, readJson, type RunSummary } from "./inventory.ts";
import { commandLine, defaultSpec, dispatch, generateSeries, runDirFor, type DispatchSpec } from "./dispatch.ts";
import { preflight, requireKdiService, runningContainers, kdiServiceProbeUrl } from "./preflight.ts";
import { PATHS, seriesFileFor } from "./paths.ts";
import { runApp } from "./tui/app.ts";
import { deleteSweepRecord, findSweep, generateTask, ignoresModel, listSweeps, loadSweep, newSweep, parseModels, pool, saveSweep, sweepSpecs, SWEEP_ID, type Sweep } from "./sweep.ts";

const COMMANDS = new Set([
  "resume", "stop", "logs", "ui", "runs", "series", "show", "task", "dispatch", "watch", "score", "validate", "new-series", "doctor", "help", "sweep", "sweeps",
]);

const argv = process.argv.slice(2);
// Bare `bench` (or only flags) opens the TUI; an unknown word is a typo, not a request for the TUI.
const command = argv[0] && COMMANDS.has(argv[0]) ? argv.shift()! : argv.length === 0 || argv[0]!.startsWith("-") ? "ui" : undefined;
if (command === undefined) {
  console.error(`bench: unknown command "${argv[0]}"\n`);
  usage();
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    csv: { type: "boolean", default: false },
    tasks: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    background: { type: "boolean", default: false },
    backend: { type: "string", default: "auto" },
    // dispatch
    image: { type: "string" },
    model: { type: "string" },
    concurrency: { type: "string" },
    timeout: { type: "string" },
    name: { type: "string" },
    "run-id": { type: "string" },
    out: { type: "string" },
    family: { type: "string", multiple: true },
    task: { type: "string", multiple: true },
    resume: { type: "boolean", default: false },
    "agent-dir": { type: "string" },
    env: { type: "string", multiple: true },
    "docker-arg": { type: "string", multiple: true },
    "kdi-service-url": { type: "string" },
    "startup-command": { type: "string" },
    deadline: { type: "string" },
    "deadline-grace": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "allow-open-db": { type: "boolean", default: false },
    // watch
    interval: { type: "string" },
    // score
    write: { type: "boolean", default: false },
    ambiguity: { type: "string" },
    "sim-data": { type: "string" },
    "no-auto-score": { type: "boolean", default: false },
    // new-series
    force: { type: "boolean", default: false },
    // sweep
    models: { type: "string", multiple: true },
    "models-file": { type: "string" },
    day: { type: "string" },
    seed: { type: "string" },
    parallel: { type: "string" },
    "sweep-id": { type: "string" },
    delete: { type: "boolean", default: false },
  },
});

if (values.help || command === "help") {
  usage();
  process.exit(0);
}

try { process.exit(await main()); } catch (error) { console.error((error as Error).message); process.exit(1); }

async function main(): Promise<number> {
  switch (command) {
    case "ui":
      return runApp({
        run: positionals[0],
        simDataDir: values["sim-data"],
        autoScore: !values["no-auto-score"],
        launch: specOverrides(),
        allowOpenDb: values["allow-open-db"],
      });
    case "runs":
      return showRuns();
    case "series":
      return showSeries();
    case "show":
      return showRun(positionals[0]);
    case "task":
      return showTask(positionals[0], positionals[1]);
    case "resume": {
      const run = await resolveRun(positionals[0]);
      if (!run) return 2;
      const spec = await resumeSpec(run.dir);
      await requireKdiService(spec.kdiServiceUrl);
      console.error(`resuming ${run.runId} in ${run.dir}`);
      return runHere(spec);
    }
    case "stop": {
      const run = await resolveRun(positionals[0]);
      if (!run) return 2;
      await control(run.dir, "stop");
      console.log("Stop requested; worker is cleaning up active containers");
      return 0;
    }
    case "logs": {
      const run = await resolveRun(positionals[0]);
      if (!run) return 2;
      const log = Bun.file(resolve(run.dir, "runner.log"));
      if (!await log.exists()) { console.error("No managed runner log"); return 1; }
      console.log(await log.text());
      return 0;
    }
    case "dispatch":
      return startRun(positionals[0]);
    case "watch":
      return watchRun(positionals[0]);
    case "score":
      return scoreOne(positionals[0]);
    case "validate":
      return validateOne(positionals[0]);
    case "new-series":
      return newSeries(positionals[0]);
    case "doctor":
      return doctor();
    case "sweep":
      return startSweep(positionals[0]);
    case "sweeps":
      return showSweeps(positionals[0]);
    default:
      usage();
      return 2;
  }
}

function usage(): void {
  const lines = [
    "kierston bench CLI",
    "",
    "  bench [--no-auto-score]      the interactive TUI",
    "                               dispatch's run flags preset the new-run form: --image --model --concurrency",
    "                               --family --env --agent-dir --docker-arg --startup-command --deadline …",
    "  bench runs [--json]          every run and how far it got",
    "  bench series [--json]        run series available to dispatch",
    "  bench show <run> [--json]    one run and its tasks",
    "  bench task <run> <task id>   one task's answer, KDI calls and console tail",
    "  bench dispatch <series> [--image i] [--model m] [--concurrency n]",
    "                               [--name label] [--run-id id] [--family f]... [--task id]... [--resume]",
    "                               [--env NAME[=VALUE]]... [--agent-dir d] [--docker-arg a]...",
    "                               [--startup-command s] [--deadline minutes] [--deadline-grace minutes] [--dry-run]",
    "                               [--background] [--backend auto|process|systemd] [--allow-open-db]",
    "  bench resume <run>           resume a saved run in this terminal (skip recorded tasks)",
    "  bench stop <run>             stop a background run on this host",
    "  bench logs <run>             print the background runner log",
    "  bench watch <run> [--interval 5]",
    "  bench score <run> [--write] [--tasks] [--json|--csv] [--ambiguity strict|lenient]",
    "  bench validate <run> [--json]",
    "  bench new-series <config.toml> [--force]",
    "  bench doctor [--json] [--agent-dir d] [--env NAME]... [--allow-open-db]",
    "  bench sweep <series> --task <id> --models a,b,c [--parallel n] [--sweep-id id] [dispatch flags]",
    "  bench sweep --family f --day YYYY-MM-DD [--seed n] --models a,b,c",
    "                               one task on every model: a run per model, named after the model;",
    "                               --models-file reads one model per line; --dry-run prints the commands",
    "  bench sweeps [sweep] [--json] [--delete]",
    "",
    `  runs live under ${PATHS.runs}; series under ${PATHS.runSeries}`,
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------

async function showRuns(): Promise<number> {
  const runs = await listRuns();
  if (values.json) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (runs.length === 0) {
    console.log(`no runs under ${PATHS.runs}`);
    return 0;
  }
  const rows = runs.map((run) => [
    run.name ?? "—",
    `${run.series}/${run.runId}`,
    run.state,
    `${bar(progress(run), 10)} ${run.done}/${run.total ?? run.done}`,
    String(run.counts.answered ?? 0),
    String((run.counts["no-answer"] ?? 0) + (run.counts["invalid-answer"] ?? 0)),
    String((run.counts.timeout ?? 0) + (run.counts.error ?? 0)),
    run.score ? percent(run.score.meanScore, 0) : "—",
    since(run.lastActivity),
  ]);
  console.log(
    table(
      ["name", "run", "state", "progress", "answered", "no answer", "failed", "score", "last activity"],
      rows,
      ["left", "left", "left", "left", "right", "right", "right", "right", "right"],
    ).join("\n"),
  );
  return 0;
}

function progress(run: RunSummary): number {
  const total = run.total ?? run.done;
  return total === 0 ? 0 : run.done / total;
}

async function showSeries(): Promise<number> {
  const series = await listSeries();
  if (values.json) {
    console.log(JSON.stringify(series, null, 2));
    return 0;
  }
  const rows = series.map((entry) => [
    entry.id,
    String(entry.taskCount),
    String(entry.families.length),
    entry.days.map((day) => day.date).join(", "),
    String(entry.runs),
    stamp(entry.createdAt),
  ]);
  console.log(table(["series", "tasks", "families", "days", "runs", "created"], rows, ["left", "right", "right", "left", "right", "left"]).join("\n"));
  return 0;
}

async function resolveRun(reference: string | undefined): Promise<RunSummary | null> {
  if (!reference) {
    console.error("name a run as <series>/<run id>, a run id, or a path");
    return null;
  }
  const run = await findRun(reference).catch((error: Error) => {
    console.error(error.message);
    return null;
  });
  if (!run) console.error(`no run called ${reference}`);
  return run;
}

async function showRun(reference: string | undefined): Promise<number> {
  const summary = await resolveRun(reference);
  if (!summary) return 2;
  const run = await loadRun(summary.dir, summary.series, summary.runId);
  if (values.json) {
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }
  const total = run.total ?? run.tasks.length;
  console.log(
    [
      `${run.series}/${run.runId}  ${run.state}`,
      `image      ${run.image ?? "—"}`,
      `started    ${stamp(run.startedAt) || "—"}${run.finishedAt ? ` → ${stamp(run.finishedAt)}` : ""}`,
      `progress   ${bar(total === 0 ? 0 : run.done / total, 20)} ${run.done}/${total}${run.inFlight ? `, ${run.inFlight} in flight` : ""}`,
      `counts     ${Object.entries(run.counts).map(([name, count]) => `${name} ${count}`).join(", ") || "—"}`,
      `score      ${run.score ? `${percent(run.score.meanScore)} over ${run.score.scored} scored (${since(run.score.scoredAt)})` : "not scored"}`,
      `directory  ${run.dir}`,
      "",
    ].join("\n"),
  );
  const rows = run.tasks.map((task) => [
    task.id,
    task.status,
    task.score === null || task.score === undefined ? "" : percent(task.score, 0),
    task.kdiCalls === undefined ? "" : String(task.kdiCalls),
    duration(task.durationMs),
    task.issues?.[0] ?? "",
  ]);
  console.log(table(["task", "status", "score", "KDI", "time", "note"], rows, ["left", "left", "right", "right", "right", "left"]).join("\n"));
  return 0;
}

async function showTask(reference: string | undefined, taskId: string | undefined): Promise<number> {
  const summary = await resolveRun(reference);
  if (!summary) return 2;
  if (!taskId) {
    console.error("name the task id");
    return 2;
  }
  const run = await loadRun(summary.dir, summary.series, summary.runId);
  const row = run.tasks.find((task) => task.id === taskId || taskDirName(task.id) === taskId);
  if (!row) {
    console.error(`${taskId} is not a task of ${run.series}/${run.runId}`);
    return 2;
  }
  const detail = await loadTask(run.dir, row);
  if (values.json) {
    console.log(JSON.stringify(detail, null, 2));
    return 0;
  }
  console.log(
    [
      `${row.id}`,
      `family     ${row.family}   date ${row.date}`,
      `status     ${row.status}${row.score === null || row.score === undefined ? "" : `   score ${percent(row.score)}`}`,
      `method     ${row.scoring?.method ?? "—"}`,
      `aggregate  ${row.scoring?.aggregate ?? "—"}`,
      `result     ${row.scoring?.summary ?? "—"}`,
      ...(row.metrics && Object.keys(row.metrics).length > 0
        ? ["metrics    " + Object.entries(row.metrics).map(([name, value]) => `${name}=${value}`).join("  ")]
        : []),
      `duration   ${duration(row.durationMs)}   KDI calls ${detail.kdiCalls.length}`,
      `directory  ${detail.dir}`,
      "",
      "answer",
      detail.answer?.answer === undefined ? "  (none written)" : indent(JSON.stringify(detail.answer.answer, null, 2)),
    ].join("\n"),
  );
  if (row.issues?.length) console.log(["", "scoring notes", ...row.issues.map((issue) => `  • ${issue}`)].join("\n"));
  if (detail.answer?.notes) console.log(["", "agent notes", indent(detail.answer.notes)].join("\n"));
  if (detail.console.length > 0) {
    console.log(["", "console tail", ...detail.console.slice(-20).map((line) => `  ${line}`)].join("\n"));
  }
  return 0;
}

/** A whole number of at least `min`; anything else is an error, never a silent default. */
function wholeNumber(flag: string, value: string, min: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < min) {
    throw new Error(`${flag}: "${value}" is not a whole number of at least ${min}`);
  }
  return number;
}

/** Minutes, fractional allowed; 0 or more. */
function minutes(flag: string, value: string): number {
  const number = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || !Number.isFinite(number)) {
    throw new Error(`${flag}: "${value}" is not a number of minutes`);
  }
  return number;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

// ---------------------------------------------------------------------------

/** The run settings given as flags; `bench dispatch` and the TUI's new-run form both start from these. */
function specOverrides(): Partial<DispatchSpec> {
  const spec: Partial<DispatchSpec> = {};
  if (values.deadline !== undefined) spec.deadlineMinutes = minutes("--deadline", values.deadline);
  if (values["deadline-grace"] !== undefined) {
    const grace = minutes("--deadline-grace", values["deadline-grace"]);
    if (grace) spec.deadlineGraceMinutes = grace;
  }
  if (values.image) spec.image = values.image;
  if (values.model) spec.model = values.model;
  if (values.concurrency !== undefined) spec.concurrency = wholeNumber("--concurrency", values.concurrency, 1);
  if (values.timeout) spec.timeout = values.timeout;
  if (values.name?.trim()) spec.name = values.name.trim();
  if (values["run-id"]) spec.runId = values["run-id"];
  if (values.out) spec.outDir = resolve(values.out);
  if (values.family?.length) spec.families = values.family;
  if (values.task?.length) spec.taskIds = values.task;
  if (values.resume) spec.resume = true;
  if (values["agent-dir"]) spec.agentDir = values["agent-dir"];
  if (values.env?.length) spec.env = values.env;
  if (values["docker-arg"]?.length) spec.dockerArgs = values["docker-arg"];
  if (values["kdi-service-url"]) spec.kdiServiceUrl = values["kdi-service-url"];
  if (values["startup-command"]) spec.startupCommand = values["startup-command"];
  return spec;
}

async function startRun(reference: string | undefined): Promise<number> {
  if (!reference) {
    console.error("name the series to run: its id, or a path to the series file");
    return 2;
  }
  const series = (await listSeries()).find((entry) => entry.id === reference || entry.file === resolve(reference));
  const seriesFile = series?.file ?? (reference.endsWith(".json") ? resolve(reference) : seriesFileFor(reference));
  if (!(await Bun.file(seriesFile).exists())) {
    console.error(`no series file at ${seriesFile}`);
    return 2;
  }
  const seriesId = series?.id ?? (await readJson<{ series?: { id?: string } }>(seriesFile))?.series?.id ?? reference;

  const spec: DispatchSpec = { ...defaultSpec(seriesFile, seriesId) };
  if (series?.startupCommand) spec.startupCommand = series.startupCommand;
  if (series?.deadlineMinutes !== undefined) spec.deadlineMinutes = series.deadlineMinutes;
  Object.assign(spec, specOverrides());

  if (values["dry-run"]) {
    console.log(commandLine(spec));
    return 0;
  }

  const blocking = (await preflight({
    image: spec.image,
    kdiServiceProbeUrl: kdiServiceProbeUrl(spec.kdiServiceUrl),
    startKdiService: true,
    env: spec.env,
    agentDir: spec.agentDir,
    allowOpenDb: values["allow-open-db"],
  })).filter((check) => !check.ok && !check.advisory);
  for (const check of blocking) console.error(`preflight: ${check.name} — ${check.detail}`);
  if (blocking.length) return 1;

  console.error(`dispatching ${seriesId} as ${spec.runId} into ${runDirFor(spec)}`);
  if (values.background) {
    const managed = await startBackground(spec, values.backend);
    console.log(JSON.stringify({ run: `${seriesId}/${spec.runId}`, backend: managed.backend, host: managed.host, state: managed.state, unit: managed.unit }));
    return managed.state === "failed" ? 1 : 0;
  }
  await saveLaunch(spec);
  return runHere(spec);
}

/** Run the evaluation runner attached to this terminal; Ctrl-C stops it and its containers. */
async function runHere(spec: DispatchSpec): Promise<number> {
  const live = dispatch(spec, (event) => {
    if (event.kind === "line") console.error(event.line);
  });
  const stop = () => live.stop();
  process.on("SIGINT", stop);
  const code = await live.exited;
  process.off("SIGINT", stop);
  return code ?? 1;
}

async function watchRun(reference: string | undefined): Promise<number> {
  const summary = await resolveRun(reference);
  if (!summary) return 2;
  const every = Math.max(1, Number(values.interval ?? 5) || 5) * 1000;
  let previous = "";
  for (;;) {
    const run = await loadRun(summary.dir, summary.series, summary.runId);
    const total = run.total ?? run.tasks.length;
    const line = `${stamp(new Date().toISOString())}  ${run.state}  ${run.done}/${total} done, ${run.inFlight} in flight  ${Object.entries(run.counts).map(([name, count]) => `${name} ${count}`).join(", ")}`;
    if (line.slice(17) !== previous.slice(17)) {
      console.log(line);
      previous = line;
    }
    if (run.state === "complete") return 0;
    if (run.state === "interrupted") {
      console.log("run is no longer making progress");
      return 1;
    }
    await Bun.sleep(every);
  }
}

// ---------------------------------------------------------------------------

async function scoreOne(reference: string | undefined): Promise<number> {
  const summary = await resolveRun(reference);
  if (!summary) return 2;
  const seriesFile = (await listSeries()).find((entry) => entry.id === summary.series)?.file;
  if (!seriesFile) {
    console.error(`series ${summary.series} is not in ${PATHS.runSeries}; nothing to score against`);
    return 2;
  }
  try {
    await assertSeriesUnchanged(summary.dir, seriesFile);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const result = await scoreRun({
    seriesFile,
    runDir: summary.dir,
    simDataDir: resolve(values["sim-data"] ?? PATHS.simData),
    ambiguity: values.ambiguity === "lenient" ? "lenient" : "strict",
    families: values.family?.length ? new Set(values.family) : undefined,
    taskIds: values.task?.length ? new Set(values.task) : undefined,
    writeInto: values.write,
  });
  const unfrozen = truthWarning(result);
  if (unfrozen) console.error(unfrozen);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (values.csv) process.stdout.write(toCsv(result));
  else console.log(renderRunScore(result, { tasks: values.tasks }));
  return 0;
}

async function validateOne(reference: string | undefined): Promise<number> {
  const summary = await resolveRun(reference);
  if (!summary) return 2;
  const seriesFile = (await listSeries()).find((entry) => entry.id === summary.series)?.file;
  if (!seriesFile) {
    console.error(`series ${summary.series} is not in ${PATHS.runSeries}`);
    return 2;
  }
  const series = await readJson<{ tasks: { id: string; answer: Parameters<typeof validateSubmission>[0] }[] }>(seriesFile);
  const run = await loadRun(summary.dir, summary.series, summary.runId);
  const rows: string[][] = [];
  let ok = 0;
  for (const task of run.tasks) {
    if (task.status === "pending" || task.status === "not-run") continue;
    const spec = series?.tasks.find((entry) => entry.id === task.id)?.answer;
    if (!spec) continue;
    const submission = await readJson<{ taskId?: string; answer?: unknown }>(`${summary.dir}/${taskDirName(task.id)}/answer.json`);
    const validation = validateSubmission(spec, submission as never);
    if (validation.ok) ok += 1;
    const worst = validation.issues.find((issue) => issue.severity === "error") ?? validation.issues[0];
    rows.push([task.id, validation.ok ? "ok" : "invalid", String(validation.issues.length), worst ? `${worst.field ? `${worst.field}: ` : ""}${worst.message}` : ""]);
  }
  if (values.json) {
    console.log(JSON.stringify({ run: `${summary.series}/${summary.runId}`, ok, checked: rows.length, rows }, null, 2));
    return rows.length === ok ? 0 : 1;
  }
  console.log(table(["task", "shape", "issues", "first issue"], rows, ["left", "left", "right", "left"]).join("\n"));
  console.log(`\n${ok} of ${rows.length} answers are well formed`);
  return rows.length === ok ? 0 : 1;
}

async function newSeries(config: string | undefined): Promise<number> {
  if (!config) {
    console.error(`name a prep config, e.g. ${PATHS.seriesConfigs}/example.toml`);
    return 2;
  }
  const result = await generateSeries(resolve(config), values.force);
  if (result.output) console.log(result.output);
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------

/** One task, one run per model. The sweep file lists the run ids. */
async function startSweep(reference: string | undefined): Promise<number> {
  const models = parseModels([...(values.models ?? []), ...(values["models-file"] ? [await Bun.file(values["models-file"]).text()] : [])]);
  if (models.length === 0) {
    console.error("name the models with --models a,b,c or --models-file <file>");
    return 2;
  }
  const sweepId = values["sweep-id"];
  if (sweepId !== undefined && !SWEEP_ID.test(sweepId)) {
    console.error("--sweep-id may contain only letters, digits, '.', '_' and '-'");
    return 2;
  }
  let seriesId: string;
  let seriesFile: string;
  let taskId: string;
  if (values.family) {
    if (!values.day) {
      console.error("--family needs --day <YYYY-MM-DD or day file>");
      return 2;
    }
    const seed = values.seed === undefined ? 1 : wholeNumber("--seed", values.seed, 0);
    const family = values.family.length === 1 ? values.family[0]! : "";
    if (!family) {
      console.error("--family names one family for a sweep");
      return 2;
    }
    console.error(`generating one ${family} task from ${values.day}, seed ${seed}`);
    const made = await generateTask(family, values.day, seed, (line) => console.error(line));
    ({ seriesId, seriesFile, taskId } = made);
    console.error(`${made.reused ? "reusing" : "generated"} ${seriesId}: ${taskId}`);
  } else {
    if (!reference) {
      console.error("name the series to take the task from, or --family and --day to generate one");
      return 2;
    }
    const series = (await listSeries()).find((entry) => entry.id === reference || entry.file === resolve(reference));
    seriesFile = series?.file ?? (reference.endsWith(".json") ? resolve(reference) : seriesFileFor(reference));
    if (!(await Bun.file(seriesFile).exists())) {
      console.error(`no series file at ${seriesFile}`);
      return 2;
    }
    seriesId = series?.id ?? (await readJson<{ series?: { id?: string } }>(seriesFile))?.series?.id ?? reference;
    if (values.task?.length !== 1) {
      console.error("name exactly one task with --task <id>");
      return 2;
    }
    taskId = values.task[0]!;
    const data = await readJson<{ tasks?: { id: string }[] }>(seriesFile);
    if (!data?.tasks?.some((task) => task.id === taskId)) {
      console.error(`${taskId} is not a task of ${seriesId}`);
      return 2;
    }
  }

  const base: DispatchSpec = { ...defaultSpec(seriesFile, seriesId) };
  const series = (await listSeries()).find((entry) => entry.id === seriesId);
  if (series?.startupCommand) base.startupCommand = series.startupCommand;
  if (series?.deadlineMinutes !== undefined) base.deadlineMinutes = series.deadlineMinutes;
  const { model: _model, runId: _runId, name: _name, taskIds: _tasks, families: _families, ...overrides } = specOverrides();
  Object.assign(base, overrides);
  if (ignoresModel(base.startupCommand)) {
    console.error("the startup command hard-codes a model; remove it so $EM sets the model per run");
    return 2;
  }
  const sweep = newSweep(seriesId, seriesFile, taskId, models, sweepId);
  const specs = sweepSpecs(base, sweep);
  const parallel = values.parallel === undefined ? 1 : wholeNumber("--parallel", values.parallel, 1);

  if (values["dry-run"]) {
    for (const spec of specs) console.log(commandLine(spec));
    return 0;
  }
  const blocking = (await preflight({
    image: base.image,
    kdiServiceProbeUrl: kdiServiceProbeUrl(base.kdiServiceUrl),
    startKdiService: true,
    env: base.env,
    agentDir: base.agentDir,
    allowOpenDb: values["allow-open-db"],
  })).filter((check) => !check.ok && !check.advisory);
  for (const check of blocking) console.error(`preflight: ${check.name} — ${check.detail}`);
  if (blocking.length) return 1;

  await saveSweep(sweep);
  console.error(`sweep ${sweep.id}: ${taskId} of ${seriesId} on ${models.length} model(s)`);
  if (values.background) {
    let failed = 0;
    for (const spec of specs) {
      const managed = await startBackground(spec, values.backend);
      if (managed.state === "failed") failed += 1;
      console.log(JSON.stringify({ run: `${seriesId}/${spec.runId}`, model: spec.model, backend: managed.backend, state: managed.state, unit: managed.unit }));
    }
    return failed ? 1 : 0;
  }
  let stopped = false;
  const lives: ReturnType<typeof dispatch>[] = [];
  const onInterrupt = () => {
    stopped = true;
    for (const live of lives) live.stop();
  };
  process.on("SIGINT", onInterrupt);
  const codes = new Map<string, number | null>();
  await pool(specs, parallel, async (spec) => {
    await saveLaunch(spec);
    const live = dispatch(spec, (event) => {
      if (event.kind === "line") console.error(`[${spec.model}] ${event.line}`);
    });
    lives.push(live);
    codes.set(spec.model!, await live.exited);
  }, () => stopped);
  process.off("SIGINT", onInterrupt);
  await showSweepTable(sweep);
  return [...codes.values()].every((code) => code === 0) && codes.size === specs.length ? 0 : 1;
}

async function showSweeps(reference: string | undefined): Promise<number> {
  if (reference) {
    const sweep = await findSweep(reference);
    if (!sweep) {
      console.error(`no sweep called ${reference}`);
      return 2;
    }
    if (values.delete) {
      await deleteSweepRecord(sweep);
      console.log(`deleted sweep ${sweep.id}; its ${sweep.runs.length} run(s) are kept`);
      return 0;
    }
    await showSweepTable(sweep);
    return 0;
  }
  const sweeps = await listSweeps();
  if (values.json) {
    console.log(JSON.stringify(sweeps, null, 2));
    return 0;
  }
  if (sweeps.length === 0) {
    console.log(`no sweeps under ${PATHS.sweeps}`);
    return 0;
  }
  const rows = sweeps.map((sweep) => [sweep.id, sweep.series, sweep.taskId, String(sweep.runs.length), stamp(sweep.createdAt)]);
  console.log(table(["sweep", "series", "task", "models", "created"], rows, ["left", "left", "left", "right", "left"]).join("\n"));
  return 0;
}

async function showSweepTable(sweep: Sweep): Promise<void> {
  const rows = await loadSweep(sweep);
  if (values.json) {
    console.log(JSON.stringify({ ...sweep, rows }, null, 2));
    return;
  }
  console.log(`${sweep.id}  ${sweep.taskId} of ${sweep.series}\n`);
  console.log(
    table(
      ["model", "run", "state", "status", "score", "KDI", "time", "answer"],
      rows.map((row) => [
        row.model,
        row.runId,
        row.run?.state ?? "queued",
        row.task?.status ?? "",
        row.task?.score === null || row.task?.score === undefined ? "—" : percent(row.task.score, 0),
        row.task?.kdiCalls === undefined ? "" : String(row.task.kdiCalls),
        duration(row.task?.durationMs),
        row.answer === undefined ? "" : JSON.stringify(row.answer).slice(0, 60),
      ]),
      ["left", "left", "left", "left", "right", "right", "right", "left"],
    ).join("\n"),
  );
}

async function doctor(): Promise<number> {
  // `bench doctor` reports on the mounted credentials themselves; what a run
  // forwards is a property of that run, not of the machine.
  const checks = await preflight({ image: values.image, env: values.env, agentDir: values["agent-dir"] ?? process.env.BENCH_AGENT_DIR?.trim(), allowOpenDb: values["allow-open-db"] });
  const containers = await runningContainers();
  if (values.json) {
    console.log(JSON.stringify({ checks, containers }, null, 2));
    return checks.every((check) => check.ok || check.advisory) ? 0 : 1;
  }
  for (const check of checks) {
    const mark = check.ok ? paint("✓", "green") : check.advisory ? paint("!", "yellow") : paint("✗", "red");
    console.log(`${mark} ${check.name.padEnd(22)} ${check.detail}`);
  }
  if (containers.length > 0) console.log(`\nbench containers running: ${containers.join(", ")}`);
  return checks.every((check) => check.ok || check.advisory) ? 0 : 1;
}

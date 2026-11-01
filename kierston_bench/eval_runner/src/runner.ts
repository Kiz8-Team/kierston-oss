/**
 * Runs every task of a series against one agent image, a fresh container
 * per task, N at a time — TTs only; RTIs and DTs run after the last TT, one
 * at a time — and leaves one directory per task behind:
 *
 *   <out>/<series id>/<run id>/<task id>/
 *     input.json       the public bundle the agent was given (mounted as /input/input.json)
 *     answer.json      what it wrote, when it wrote one
 *     console.log      the container's stdout and stderr, interleaved
 *     logs/            whatever transcript the agent's tooling produced
 *     work/            /work as the agent left it
 *     kdi_calls.jsonl  the KDI service's record of every KDI call from this task
 *     meta.json        timings, exit code, status
 *
 * Nothing is shared between tasks: each gets its own directories, its own
 * container and its own KDI task id, so tasks are independent and can run
 * side by side.
 *
 * The container never sees the task id, which names the family, date and
 * generator seed. The bundle carries an opaque case id instead (bundle.ts
 * caseIdFor), recorded host-side as meta.json `caseId`; the container name
 * uses it too, and KDI calls reach the task through the capability in AT.
 *
 * What runs inside the container is the task's startup command: a shell
 * line run under `bash -c` that starts the agent (pi, by default) and ends
 * when it does. The runner's --startup-command overrides the task's, and a
 * `-- cmd...` on the command line bypasses the shell altogether.
 */

import { chmod, copyFile, mkdir, readdir, readFile, rename as mv, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { KierstonBenchTask } from "../../task_generators/src/task.ts";
import { RETIRED_FAMILIES } from "../../task_generators/src/retired.ts";
import { taskGroupOf } from "../../task_generators/src/groups.ts";
import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import { INPUT_DIR, INPUT_FILE, LOG_DIR, OUT_DIR, WORK_DIR, caseIdFor, publicTask, type Submission } from "./bundle.ts";
import { benchContext } from "./context.ts";
import { STARTUP_PROMPT, TIME_UP_MESSAGE } from "../../model_visible_text.ts";
import type { ScenarioLock } from "./scenario-lock.ts";
import { containerName, kill, runContainer } from "./docker.ts";
import { runProvenance, type RunProvenance } from "./provenance.ts";
import { recordedSeriesSha256 } from "./series-digest.ts";
import type { ScenarioStore } from "./scenarios.ts";

/** Task scenario paths are relative to the repository root. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");

export type TaskStatus = "answered" | "no-answer" | "invalid-answer" | "timeout" | "error";

/** Where the per-task copy of pi's auth files is mounted; PI_CODING_AGENT_DIR points here. */
export const AGENT_DIR = "/opt/pi-agent";

/**
 * The files copied out of an operator's --agent-dir into each task's own agent
 * directory: credentials only. Settings, sessions and anything else stay on the
 * host, and whatever pi writes in one task (refreshed OAuth tokens included)
 * is discarded with that task's copy.
 */
export const AGENT_AUTH_FILES = ["auth.json", "models.json"];

/**
 * Host variables that must never enter a container: database credentials and
 * the host-only KDI settings. The KDI service is the only way to the data.
 */
export const HOST_ONLY_ENV = /^(CLICKHOUSE_|POSTGRES_|PG[A-Z]*$|DATABASE_URL$|KDI_|FASTGATE_)/;

/**
 * The response clock inside the image; loaded only when a run sets a deadline.
 * The model can read that file, so it carries no maintainer notes and no prose:
 * its message comes from model_visible_text.ts by way of bin/messages.json.
 */
export const CLOCK_EXTENSION = "/opt/pi-ext/clock.ts";
/** How long after the deadline a container that is still running is killed. */
export const DEFAULT_DEADLINE_GRACE_MS = 180_000;
const SERVICE_CLOSE_LAG_MS = 10_000;

/**
 * What a container runs when neither the task nor the operator says. Starts
 * pi in print mode on the case file, with its session transcript under the
 * log directory and the model from EM when one is given.
 */
export const DEFAULT_STARTUP_COMMAND =
  // MODEL-FACING. The prompt text is STARTUP_PROMPT in model_visible_text.ts, which holds
  // every string the model can read; nothing in this shell line may hint at
  // evaluation, scoring, benchmarks or a harness either.
  // The container variables carry deliberately opaque names (EC, EM, ETF, EOD, ELD,
  // EWD, ED, AU, AT; the task id never enters the container, the host maps AT to it) and the E* ones are unset before pi starts, so
  // a model running `env` sees neither their names nor the prompt twice.
  // ED is the time allowance in milliseconds. It reaches pi alone, as DL, and the
  // clock extension drops it from pi's environment as it loads; see pi-ext/clock.ts.
  'c="$EC"; l="$ELD"; m="$EM"; t="$ETF"; d="$ED"; unset EC EM ETF EOD ELD EWD ED; ' +
  '[ -n "$d" ] && export DL="$d"; exec pi -p ${d:+-e ' + CLOCK_EXTENSION + '} --append-system-prompt "$c" --session-dir "$l" ${m:+--model "$m"} ' +
  '@"$t" "' + STARTUP_PROMPT + '"';

export interface TaskMeta {
  id: string;
  /** The opaque id the container saw in place of `id`; the answer names it. Absent from runs before opaque ids. */
  caseId?: string;
  family: string;
  date: string;
  status: TaskStatus;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  kdiCalls: number;
  kdiTaskId: string;
  container: string;
  dir: string;
  /** The time the agent was given, when the run set one. */
  deadlineMs?: number;
  /** When the agent was told to stop, read back from its session transcript. */
  forcedAt?: string;
  /** The gateway's first call for this attempt; the records clock starts here. */
  kdiOpenedAt?: string;
  /** When the gateway stopped serving this attempt: kdiOpenedAt + deadlineMs + a short lag. */
  kdiClosesAt?: string;
  /** The shell line the container ran, or the raw command when `-- cmd...` was used. */
  startupCommand: string;
  /** `provider/model` as pi recorded it in the session transcript. */
  model?: string;
}

export interface RunOptions {
  seriesFile: string;
  image: string;
  outDir: string;
  runId: string;
  concurrency: number;
  timeoutMs: number;
  /**
   * Time each task's agent is given. The agent is told the allowance up front,
   * told to stop and write its answer when it runs out, and refused further
   * KDI calls from then on. Overrides the series' own; absent or 0 means none.
   */
  deadlineMs?: number;
  /** A container still running this long after the deadline is killed. */
  deadlineGraceMs?: number;
  kdiServiceUrl: string;
  /** Where the KDI service writes per-task call logs; see agent_eval_runtime/kdi_service.ts. */
  kdiLogDir: string;
  /** Host-only capability records read by the KDI service. */
  kdiPolicyDir?: string;
  /**
   * Parent of the per-attempt directories a container mounts
   * (`<liveDir>/<caseId>/{input,out,work,agent}`). Mount sources are visible
   * inside a container through `mount` and /proc, so this path should name
   * nothing about the run. Default `<outDir>/.live`.
   */
  liveDir?: string;
  /** Skip tasks whose directory already holds a meta.json. */
  resume: boolean;
  families?: Set<string>;
  taskIds?: Set<string>;
  dockerArgs: string[];
  /** Raw command after the image; empty means the startup command under `bash -c`. */
  command: string[];
  /** Overrides every task's startupCommand. */
  startupCommand?: string;
  /** Model pattern handed to the agent as EM. */
  model?: string;
  /** A short display name for the run, recorded in launch.json for the TUI and site. */
  name?: string;
  /** Extra container environment, e.g. API keys forwarded from the host. */
  env?: Record<string, string>;
  /**
   * pi's agent directory on the host. Only its auth files (AGENT_AUTH_FILES)
   * are copied, into a fresh directory per task that is mounted at AGENT_DIR
   * and deleted when the task ends: nothing one task writes reaches the next
   * task or the host, so OAuth tokens pi refreshes inside a container do not
   * persist. Undefined mounts nothing; pi then authenticates with API keys
   * from `env`.
   */
  agentDir?: string;
  docker: string;
  /**
   * The event store's scenario state. With it (and `scenarioLock`), leftover
   * scenarios are reverted when the run starts, and a scenario task runs
   * alone, applying its `.kdiff` before its container starts and reverting
   * it after. Without it a scenario task is an error rather than a run
   * against the base day.
   */
  scenarios?: ScenarioStore;
  /** The lock shared with every other runner process; see scenario-lock.ts. */
  scenarioLock?: ScenarioLock;
  log: (line: string) => void;
  /** Optional programmatic cancellation, used by tests and embedders. */
  signal?: AbortSignal;
}

export interface RunReport {
  series: string;
  /** sha256 of the series file at dispatch; see series-digest.ts. */
  seriesSha256?: string;
  runId: string;
  image: string;
  startedAt: string;
  finishedAt: string;
  concurrency: number;
  timeoutMs: number;
  deadlineMs?: number;
  /** The exact run scope, including selected tasks that an interrupt never started. */
  selectedTaskIds: string[];
  tasks: TaskMeta[];
  counts: Record<TaskStatus | "skipped", number>;
  /** Present when the operator stopped the run before every selected task began. */
  interrupted?: boolean;
  /** Model asked for, image, pi and code the run used. */
  provenance?: RunProvenance;
}

/** The shell line a task's container runs, by precedence: operator, task, series, default. */
export function startupCommandFor(task: KierstonBenchTask, series: RunSeriesData, options: Pick<RunOptions, "startupCommand">): string {
  return options.startupCommand ?? task.startupCommand ?? series.series.agent?.startupCommand ?? DEFAULT_STARTUP_COMMAND;
}

/** The time allowance for a run's tasks: the operator's, else the series', else none. */
export function deadlineFor(series: RunSeriesData, options: Pick<RunOptions, "deadlineMs">): number | undefined {
  const minutes = series.series.agent?.deadlineMinutes;
  const ms = options.deadlineMs ?? (minutes !== undefined ? minutes * 60_000 : undefined);
  return ms && ms > 0 ? ms : undefined;
}

export async function loadSeries(file: string): Promise<RunSeriesData> {
  return JSON.parse(await readFile(file, "utf8")) as RunSeriesData;
}

export function selectTasks(series: RunSeriesData, options: Pick<RunOptions, "families" | "taskIds">): KierstonBenchTask[] {
  const asked = [...(options.families ?? []), ...series.tasks.filter((task) => options.taskIds?.has(task.id)).map((task) => task.family)];
  const retired = [...new Set(asked.filter((family) => RETIRED_FAMILIES.has(family)))];
  if (retired.length) throw new Error(`${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} retired; regenerate the series`);
  return series.tasks.filter(
    (task) => !RETIRED_FAMILIES.has(task.family) && (!options.families || options.families.has(task.family)) && (!options.taskIds || options.taskIds.has(task.id)),
  );
}

/** A task id keeps ':' which is awkward in shells; directories use '_'. */
export function taskDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Matches the KDI service's file naming for the task id it resolves from AT. */
export function kdiLogName(kdiTaskId: string): string {
  return kdiTaskId.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl";
}

export async function runSeries(options: RunOptions): Promise<RunReport> {
  // Hash and parse the same bytes, so the recorded hash is the series that ran.
  const seriesBytes = await readFile(options.seriesFile);
  const seriesHash = createHash("sha256").update(seriesBytes).digest("hex");
  const series = JSON.parse(seriesBytes.toString("utf8")) as RunSeriesData;
  const tasks = selectTasks(series, options);
  const deadlineMs = deadlineFor(series, options);
  options = { ...options, deadlineMs };
  const runDir = resolve(options.outDir, series.series.id, options.runId);
  await mkdir(runDir, { recursive: true });
  // A resumed run must continue on the series file it started from.
  const recorded = await recordedSeriesSha256(runDir);
  if (recorded !== undefined && recorded !== seriesHash) {
    throw new Error(`series file ${options.seriesFile} changed since run ${options.runId} started: recorded sha256 ${recorded}, file is now ${seriesHash}`);
  }
  // A run launched from the TUI already has a launch.json with its spec; a direct CLI run
  // gets a minimal one so the name and model are known to the inventory and the site.
  if (options.name && !(await stat(join(runDir, "launch.json")).then(() => true, () => false))) {
    await writeFile(join(runDir, "launch.json"), JSON.stringify({
      spec: { seriesFile: options.seriesFile, seriesId: series.series.id, image: options.image, runId: options.runId, outDir: options.outDir, name: options.name, ...(options.model ? { model: options.model } : {}) },
      args: process.argv.slice(1),
      env: {},
    }, null, 2) + "\n", { mode: 0o600 });
  }
  const startedAt = new Date().toISOString();
  const selectedTaskIds = tasks.map((task) => task.id);
  await writeFile(join(runDir, "selection.json"), JSON.stringify({
    series: series.series.id,
    seriesSha256: seriesHash,
    runId: options.runId,
    startedAt,
    taskIds: selectedTaskIds,
  }, null, 2) + "\n");
  options.log(`run ${options.runId}: ${tasks.length} task(s) of series ${series.series.id}, ${options.concurrency} at a time, into ${runDir}`);
  const forbidden = Object.keys(options.env ?? {}).filter((name) => HOST_ONLY_ENV.test(name));
  if (forbidden.length) throw new Error(`${forbidden.join(", ")} must not enter a container; containers reach data only through the KDI service`);
  const provenance = runProvenance(options);
  if (options.scenarios && options.scenarioLock) await revertLeftovers(options.scenarios, options.scenarioLock, options.runId, options.log);

  const active = new Set<string>();
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    options.log(`run ${options.runId}: stopping ${active.size} active task(s); queued tasks will not start`);
    for (const name of active) void kill(options.docker, name);
  };
  // SIGHUP: a closed terminal takes the runner with it, and its containers must go too.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, stop);
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });

  const results: TaskMeta[] = [];
  let skipped = 0;
  const worker = (queue: KierstonBenchTask[]) => async () => {
    while (!interrupted && queue.length > 0) {
      const task = queue.shift()!;
      const dir = join(runDir, taskDirName(task.id));
      if (options.resume && (await exists(join(dir, "meta.json")))) {
        skipped += 1;
        options.log(`${task.id}: done earlier, skipped`);
        continue;
      }
      const meta = await runLocked(task, dir, options, active, startupCommandFor(task, series, options), () => interrupted);
      if (!meta) break; // interrupted while waiting for the lock; never started
      results.push(meta);
      options.log(`${task.id}: ${meta.status} in ${(meta.durationMs / 1000).toFixed(0)} s, ${meta.kdiCalls} KDI call(s)`);
    }
  };
  // TTs run side by side first; RTIs and DTs wait until every TT is done and
  // then run one at a time, since each needs its scenario applied in the
  // event store while it runs.
  const plain = tasks.filter((task) => !isStaged(task));
  const staged = tasks.filter(isStaged);
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker(plain)));
  if (!interrupted && staged.length > 0) {
    if (plain.length > 0) options.log(`run ${options.runId}: starting ${staged.length} RTI/DT task(s), one at a time`);
    await worker(staged)();
  }
  for (const signal of signals) (process as NodeJS.EventEmitter).removeListener(signal, stop);
  options.signal?.removeEventListener("abort", stop);

  results.sort((a, b) => a.id.localeCompare(b.id));
  const counts: RunReport["counts"] = { answered: 0, "no-answer": 0, "invalid-answer": 0, timeout: 0, error: 0, skipped };
  for (const meta of results) counts[meta.status] += 1;
  const report: RunReport = {
    series: series.series.id,
    seriesSha256: seriesHash,
    runId: options.runId,
    image: options.image,
    startedAt,
    finishedAt: new Date().toISOString(),
    concurrency: options.concurrency,
    timeoutMs: 0,
    ...(deadlineMs ? { deadlineMs } : {}),
    selectedTaskIds,
    tasks: results,
    counts,
    ...(interrupted ? { interrupted: true } : {}),
    provenance: { ...(await provenance), modelsSeen: [...new Set(results.map((meta) => meta.model).filter((model): model is string => !!model))].sort() },
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

/** RTIs and DTs, and anything else that reads a staged scenario. */
function isStaged(task: KierstonBenchTask): boolean {
  if (task.scenario) return true;
  const group = taskGroupOf(task.family)?.id;
  return group === "rti" || group === "dt";
}

/**
 * Revert every applied scenario. Only called while holding the lock: no live
 * runner can own an applied scenario then, so whatever is applied was left
 * behind. A revert that fails because another plain task already reverted the
 * date is not a failure.
 */
async function revertApplied(scenarios: ScenarioStore, dates: ((date: string) => boolean) | null, label: string, log: (line: string) => void): Promise<void> {
  for (const entry of await scenarios.active()) {
    if (dates && !dates(entry.date)) continue;
    try {
      await scenarios.revert(entry.date);
      log(`${label}: reverted leftover scenario ${entry.scenarioDigest.slice(0, 12)} on ${entry.date} (${entry.status})`);
    } catch (error) {
      if ((await scenarios.active()).some((other) => other.date === entry.date)) throw error;
    }
  }
}

/** At run start: revert leftovers, unless another run holds the lock and so may own them. */
async function revertLeftovers(scenarios: ScenarioStore, lock: ScenarioLock, runId: string, log: (line: string) => void): Promise<void> {
  const release = await lock.acquire("exclusive", `${runId}/startup`, { wait: false });
  if (!release) {
    log(`run ${runId}: another run holds the scenario lock; applied scenarios left as they are`);
    return;
  }
  try {
    await revertApplied(scenarios, null, `run ${runId}`, log);
  } catch (error) {
    log(`run ${runId}: could not revert leftover scenarios: ${(error as Error).message}`);
  } finally {
    await release();
  }
}

/**
 * One task under the scenario lock. A scenario task holds it alone — nothing
 * else runs in any run on this host while its delta is applied — reverts
 * anything applied, applies its delta, runs, and reverts. A plain task shares
 * the lock with other plain tasks and reverts a leftover on its own date. A
 * setup failure is the task's error; the container never starts. Null when
 * the run was interrupted before the lock came free.
 */
async function runLocked(
  task: KierstonBenchTask, dir: string, options: RunOptions, active: Set<string>, startupCommand: string, interrupted: () => boolean,
): Promise<TaskMeta | null> {
  const { scenarios, scenarioLock: lock, log } = options;
  const scenario = task.scenario;
  if (!scenarios || !lock) {
    const blocked = scenario ? "task needs a scenario but the runner has no scenario store" : undefined;
    return runTask(task, dir, options, active, startupCommand, blocked);
  }
  const release = await lock.acquire(scenario ? "exclusive" : "shared", `${options.runId}/${task.id}`, { cancelled: interrupted });
  if (!release) return null;
  let attempted = false;
  try {
    if (interrupted()) return null;
    let blocked: string | undefined;
    try {
      await revertApplied(scenarios, scenario ? null : (date) => date === task.date, task.id, log);
      if (scenario) {
        log(`${task.id}: applying ${scenario.name} seed ${scenario.seed} (${basename(scenario.delta)})`);
        attempted = true;
        await scenarios.apply(resolve(REPO_ROOT, scenario.delta));
      }
    } catch (error) {
      blocked = `scenario setup failed: ${(error as Error).message}`;
      log(`${task.id}: ${blocked}`);
    }
    // A stop during setup has no container to kill yet; starting one now would
    // hold the stop until the agent finished. The finally reverts the apply.
    if (interrupted()) return null;
    return await runTask(task, dir, options, active, startupCommand, blocked);
  } finally {
    if (attempted) {
      try {
        // A refused apply leaves nothing behind; a half-finished one does.
        if ((await scenarios.active()).some((entry) => entry.date === task.date)) {
          await scenarios.revert(task.date);
          log(`${task.id}: reverted ${task.date} to its base day`);
        }
      } catch (error) {
        log(`${task.id}: could not revert ${task.date}: ${(error as Error).message}; the next task retries`);
      }
    }
    await release();
  }
}

export async function runTask(
  task: KierstonBenchTask,
  dir: string,
  options: RunOptions,
  active: Set<string> = new Set(),
  startupCommand: string = options.startupCommand ?? task.startupCommand ?? DEFAULT_STARTUP_COMMAND,
  /** Why the container must not start; recorded as the task's error. */
  blocked?: string,
): Promise<TaskMeta> {
  // A task the bundle refuses is this task's error, not the run's: the rest
  // of the series still runs.
  // The container sees an opaque case id, salted per attempt; meta.json maps it back.
  const caseId = caseIdFor(task.id, randomBytes(8).toString("hex"));
  let bundle: ReturnType<typeof publicTask> | undefined;
  try {
    bundle = publicTask(task, caseId);
  } catch (caught) {
    blocked ??= (caught as Error).message;
  }
  // A rerun of a task starts from nothing; the previous attempt is discarded.
  await rm(dir, { recursive: true, force: true });
  // The container mounts a per-attempt directory named by the opaque case id,
  // never the task directory: bind sources show in `mount` and /proc/mounts
  // inside the container, and the task directory name carries family, date and
  // seed. Everything is moved into `dir` after the container exits.
  const liveDir = resolve(options.liveDir ?? join(options.outDir, ".live"), caseId);
  await rm(liveDir, { recursive: true, force: true });
  const inputDir = join(liveDir, "input");
  const outDir = join(liveDir, "out");
  const workDir = join(liveDir, "work");
  const sessionsDir = join(outDir, "logs", "pi-sessions");
  await Promise.all([mkdir(dir, { recursive: true }), mkdir(inputDir, { recursive: true }), mkdir(sessionsDir, { recursive: true }), mkdir(workDir, { recursive: true })]);
  const deadlineMs = options.deadlineMs && options.deadlineMs > 0 ? options.deadlineMs : undefined;
  const context = benchContext(deadlineMs);
  await writeFile(join(dir, "context.txt"), context + "\n");
  const command = options.command.length > 0 ? options.command : ["bash", "-c", startupCommand];
  if (bundle) await writeFile(join(inputDir, basename(INPUT_FILE)), JSON.stringify(bundle, null, 2) + "\n");

  const kdiTaskId = `${options.runId}/${task.id}`;
  const taskCapability = randomUUID();
  const policyDir = options.kdiPolicyDir ?? resolve(import.meta.dir, "../../agent_eval_runtime/kdi_policy");
  await mkdir(policyDir, { recursive: true });
  const capabilityFile = join(policyDir, `${taskCapability}.json`);
  // The gateway files calls under the task id; a previous attempt's lines must
  // not be counted in this one. The service also stamps each line with
  // `attempt`, and collectKdiLog keeps only this attempt's lines.
  await rm(join(options.kdiLogDir, kdiLogName(kdiTaskId)), { force: true });
  const name = containerName("bench", options.runId, caseId);
  const agentDir = join(liveDir, "agent");
  const activePath = join(dir, "active.json");
  const started = Date.now();
  // The KDI service refuses calls once the allowance is spent. Its clock starts
  // at the first call it sees for this capability, which comes after the
  // agent's own clock started inside the container, and trails it by
  // SERVICE_CLOSE_LAG_MS, so the stop message, not a refused query, is what
  // ends the work. The service records the start as `openedAt` in this file.
  await writeFile(capabilityFile, JSON.stringify({
    taskId: kdiTaskId, attempt: caseId, family: task.family, policy: task.kdiPolicy ?? {},
    ...(deadlineMs ? { deadlineMs, closeLagMs: SERVICE_CLOSE_LAG_MS } : {}),
  }) + "\n", { mode: 0o600 });
  active.add(name);
  let activeHeartbeat: ReturnType<typeof setInterval> | undefined;
  let outcome: { exitCode: number | null; timedOut: boolean };
  let error: string | undefined;
  let kdiOpenedAt: number | undefined;
  try {
    if (blocked !== undefined) throw new Error(blocked);
    const forbidden = Object.keys(options.env ?? {}).filter((name) => HOST_ONLY_ENV.test(name));
    if (forbidden.length) throw new Error(`${forbidden.join(", ")} must not enter a container`);
    if (options.agentDir !== undefined) await copyAgentAuth(options.agentDir, agentDir);
    await writeFile(activePath, JSON.stringify({ container: name, docker: options.docker, kdiTaskId, capability: taskCapability, host: hostname(), live: liveDir }));
    // Inventory uses filesystem activity to distinguish a live runner from a
    // task directory left behind by a killed process. Writes inside the live
    // directory do not update the task directory's own mtime, so keep the
    // explicit active marker fresh while the container is alive.
    activeHeartbeat = setInterval(() => {
      const now = new Date();
      void utimes(activePath, now, now).catch(() => {});
    }, 30_000);
    outcome = await runContainer({
      docker: options.docker,
      image: options.image,
      name,
      mounts: [
        { host: inputDir, container: INPUT_DIR, readOnly: true },
        { host: outDir, container: OUT_DIR },
        { host: workDir, container: WORK_DIR },
        ...(options.agentDir !== undefined ? [{ host: agentDir, container: AGENT_DIR }] : []),
        // Persist both project-local Pi sessions and the global location used
        // by older builds. Mounted after the auth copy so sessions land in the
        // task's logs rather than in the throwaway agent directory.
        { host: sessionsDir, container: `${WORK_DIR}/.pi/agent/sessions` },
        { host: sessionsDir, container: options.agentDir !== undefined ? `${AGENT_DIR}/sessions` : "/home/agent/.claude/agent/sessions" },
      ],
      env: {
        ...options.env,
        ...(options.agentDir !== undefined ? { PI_CODING_AGENT_DIR: AGENT_DIR } : {}),
        ...(options.model !== undefined ? { EM: options.model } : {}),
        AU: options.kdiServiceUrl,
        AT: taskCapability,
        EC: context,
        ...(deadlineMs ? { ED: String(deadlineMs) } : {}),
        ETF: INPUT_FILE,
        EOD: OUT_DIR,
        ELD: LOG_DIR,
        EWD: WORK_DIR,
      },
      extraArgs: options.dockerArgs,
      command,
      timeoutMs: options.timeoutMs,
      killAfterMs: deadlineMs ? deadlineMs + (options.deadlineGraceMs ?? DEFAULT_DEADLINE_GRACE_MS) : undefined,
      consolePath: join(dir, "console.log"),
    });
  } catch (caught) {
    outcome = { exitCode: null, timedOut: false };
    error = (caught as Error).message;
  } finally {
    if (activeHeartbeat) clearInterval(activeHeartbeat);
    active.delete(name);
    await rm(activePath, { force: true });
    kdiOpenedAt = await openedAt(capabilityFile);
    await rm(capabilityFile, { force: true });
    // The task's copy of the credentials, and whatever pi wrote next to them.
    await rm(agentDir, { recursive: true, force: true });
  }
  const finished = Date.now();
  if (await exists(join(dir, "abort.json"))) error = "Aborted by operator";

  // Move the live mounts into the task directory: answer.json, logs/, work/
  // and input.json sit next to console.log.
  const answer = await collectAnswer(join(outDir, "answer.json"), join(dir, "answer.json"));
  await rename(join(outDir, "logs"), join(dir, "logs"));
  await rename(workDir, join(dir, "work"));
  if (bundle) await rename(join(inputDir, basename(INPUT_FILE)), join(dir, basename(INPUT_FILE)));
  await rm(liveDir, { recursive: true, force: true });
  const kdiCalls = await collectKdiLog(options.kdiLogDir, kdiTaskId, caseId, join(dir, "kdi_calls.jsonl"));

  const forcedAt = deadlineMs ? await timeUpAt(join(dir, "logs")) : undefined;
  const model = await sessionModel(join(dir, "logs"));

  // A killed container that had already written a usable answer is still an
  // answer; `timedOut` records that it had to be killed.
  const status: TaskStatus = error ? "error" : outcome.timedOut && answer !== "answered" ? "timeout" : answer;
  const meta: TaskMeta = {
    id: task.id,
    caseId,
    family: task.family,
    date: task.date,
    status,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    kdiCalls,
    kdiTaskId,
    container: name,
    dir,
    ...(deadlineMs ? { deadlineMs } : {}),
    ...(forcedAt ? { forcedAt } : {}),
    ...(kdiOpenedAt !== undefined ? { kdiOpenedAt: new Date(kdiOpenedAt).toISOString() } : {}),
    ...(kdiOpenedAt !== undefined && deadlineMs ? { kdiClosesAt: new Date(kdiOpenedAt + deadlineMs + SERVICE_CLOSE_LAG_MS).toISOString() } : {}),
    startupCommand: options.command.length > 0 ? options.command.join(" ") : startupCommand,
    ...(model ? { model } : {}),
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(error ? { ...meta, error } : meta, null, 2) + "\n");
  return meta;
}

/** When the clock's stop message reached the agent, from the pi session transcripts under `logs`. */
async function timeUpAt(logs: string): Promise<string | undefined> {
  if (!(await exists(logs))) return undefined;
  for (const file of await readdir(logs, { recursive: true })) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(logs, file), "utf8")).split("\n")) {
      if (!line.includes(TIME_UP_MESSAGE)) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string; message?: { role?: string } };
        if (entry.message?.role === "user" && entry.timestamp) return entry.timestamp;
      } catch { /* a torn last line */ }
    }
  }
  return undefined;
}

/**
 * Copy the credential files of an operator's pi agent directory into a fresh
 * per-task directory. Only AGENT_AUTH_FILES travel; a missing one is skipped.
 */
async function copyAgentAuth(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true, mode: 0o700 });
  await chmod(to, 0o700);
  for (const name of AGENT_AUTH_FILES) {
    await copyFile(join(from, name), join(to, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** `provider/model` from the first model_change pi wrote to a session transcript under `logs`. */
async function sessionModel(logs: string): Promise<string | undefined> {
  if (!(await exists(logs))) return undefined;
  for (const file of (await readdir(logs, { recursive: true })).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(logs, file), "utf8")).split("\n")) {
      if (!line.includes('"model_change"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; provider?: string; modelId?: string };
        if (entry.type === "model_change" && entry.modelId) return entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
      } catch { /* a torn line */ }
    }
  }
  return undefined;
}

/** Moves the answer file up and says whether it is usable. */
async function collectAnswer(from: string, to: string): Promise<TaskStatus> {
  if (!(await exists(from))) return "no-answer";
  await rename(from, to);
  try {
    const parsed = JSON.parse(await readFile(to, "utf8")) as Submission;
    if (parsed === null || typeof parsed !== "object" || !("answer" in parsed)) return "invalid-answer";
    return "answered";
  } catch {
    return "invalid-answer";
  }
}

/**
 * Copies this attempt's lines of the KDI service's per-task log next to the
 * answer; returns the call count. Lines stamped with another attempt are
 * dropped; unstamped lines come from a service older than the stamp and are kept.
 */
async function collectKdiLog(logDir: string, kdiTaskId: string, attempt: string, to: string): Promise<number> {
  const from = join(logDir, kdiLogName(kdiTaskId));
  if (!(await exists(from))) return 0;
  const lines = (await readFile(from, "utf8")).split("\n").filter((line) => {
    if (line.trim() === "") return false;
    try {
      const stamped = (JSON.parse(line) as { attempt?: unknown }).attempt;
      return stamped === undefined || stamped === attempt;
    } catch {
      return true;
    }
  });
  await writeFile(to, lines.map((line) => line + "\n").join(""));
  return lines.length;
}

/** The gateway's first-call time for a capability, when it recorded one. */
async function openedAt(capabilityFile: string): Promise<number | undefined> {
  try {
    const value = (JSON.parse(await readFile(capabilityFile, "utf8")) as { openedAt?: unknown }).openedAt;
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function rename(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return;
  await rm(to, { recursive: true, force: true });
  await mv(from, to);
}

/** Files or directories; Bun.file().exists() says no to a directory. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

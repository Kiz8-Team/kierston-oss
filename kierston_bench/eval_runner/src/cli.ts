/**
 * Run a series against an agent image.
 *
 *   bun run kierston_bench/eval_runner/src/cli.ts <series.json> [options] [-- cmd...]
 *
 * Options
 *   --image <tag>          the container image; default kierston-eval-env, which carries pi
 *   --startup-command <s>  shell line every container runs, overriding the tasks' own
 *   --model <pattern>      model for the agent, passed as EM (pi's --model)
 *   --env NAME[=VALUE]     container environment; NAME alone copies the host's value; repeatable
 *   --agent-dir <dir>      pi's agent directory on the host; its auth files (auth.json, models.json) are
 *                          copied into a fresh directory per task and mounted there, so nothing a task
 *                          writes reaches the next task or the host (OAuth refreshes do not persist).
 *                          Default none: authenticate with API keys passed by --env
 *   --run-id <id>          names the run directory; default <image>-<timestamp>
 *   --name <text>          display name for the run, written to launch.json
 *   --out <dir>            run directories root; default kierston_bench/runs
 *   --live-dir <dir>       parent of per-attempt container mounts; default <out>/.live.
 *                          Mount sources are visible inside a container, so a path
 *                          that names nothing about the run is better here.
 *   --concurrency <n>      containers at a time; default 2
 *   --timeout <duration>   legacy option, ignored
 *   --deadline <duration>  time each task's agent gets (90s, 20m, 1h; a bare number is minutes). The agent
 *                          is told the allowance, told to stop and answer when it runs out, and refused
 *                          further KDI calls. Overrides the series' agent.deadline_minutes; 0 means none
 *   --deadline-grace <d>   a container still running this long after the deadline is killed; default 3m
 *   --kdi-service-url <u>  KDI service as seen from a container; default http://host.docker.internal:8765
 *   --kdi-log-dir <dir>    where the KDI service writes per-task logs; default kierston_bench/agent_eval_runtime/kdi_log
 *   --lock-dir <dir>       scenario lock shared by every runner on this host; default $BENCH_SCENARIO_LOCK_DIR,
 *                          else agent_eval_runtime/scenario_lock
 *   --family <name>        only this family; repeatable
 *   --task <id>            only this task id; repeatable
 *   --resume               skip tasks that already have a meta.json in this run
 *   --docker-arg <arg>     extra `docker run` flag; repeatable (e.g. --docker-arg=--network=none)
 *   --docker <binary>      docker executable; default docker
 *   -- cmd...              raw command run instead of any startup command
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { HOST_ONLY_ENV, runSeries } from "./runner.ts";
import { ScenarioLock } from "./scenario-lock.ts";
import { fastgateScenarios } from "./scenarios.ts";

const BENCH_ROOT = resolve(import.meta.dir, "../..");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    image: { type: "string", default: "kierston-eval-env" },
    "startup-command": { type: "string" },
    model: { type: "string" },
    env: { type: "string", multiple: true },
    "agent-dir": { type: "string", default: "none" },
    "run-id": { type: "string" },
    name: { type: "string" },
    out: { type: "string", default: resolve(BENCH_ROOT, "runs") },
    "live-dir": { type: "string" },
    concurrency: { type: "string", default: "2" },
    timeout: { type: "string", default: "0" },
    deadline: { type: "string" },
    "deadline-grace": { type: "string" },
    "kdi-service-url": { type: "string", default: "http://host.docker.internal:8765" },
    "kdi-log-dir": { type: "string", default: resolve(BENCH_ROOT, "agent_eval_runtime/kdi_log") },
    "kdi-policy-dir": { type: "string", default: resolve(BENCH_ROOT, "agent_eval_runtime/kdi_policy") },
    "lock-dir": { type: "string", default: process.env.BENCH_SCENARIO_LOCK_DIR || resolve(BENCH_ROOT, "agent_eval_runtime/scenario_lock") },
    family: { type: "string", multiple: true },
    task: { type: "string", multiple: true },
    resume: { type: "boolean", default: false },
    "docker-arg": { type: "string", multiple: true },
    docker: { type: "string", default: process.env.BENCH_DOCKER ?? "docker" },
    help: { type: "boolean", default: false },
  },
});

const seriesFile = positionals[0];
if (values.help || !seriesFile) {
  console.error("usage: cli.ts <series.json> [--image tag] [--startup-command s] [--model m] [--env NAME[=VALUE]]... [--run-id id] [--name text] [--out dir] [--concurrency n] [--family f]... [--task id]... [--resume] [--docker-arg a]... [-- cmd...]");
  process.exit(values.help ? 0 : 2);
}

// A detached runner must clean up its containers if its owning worker dies.
const ownerAbort = new AbortController();
let ownerFailures = 0;
const ownerTimer = process.env.BENCH_WORKER_URL && process.env.BENCH_WORKER_TOKEN
  ? setInterval(async () => {
    try {
      const response = await fetch(process.env.BENCH_WORKER_URL!, {
        headers: { authorization: `Bearer ${process.env.BENCH_WORKER_TOKEN}` },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error("owner unavailable");
      const owner = await response.json() as { token: string };
      if (owner.token !== process.env.BENCH_WORKER_TOKEN) throw new Error("owner identity changed");
      ownerFailures = 0;
    } catch { if (++ownerFailures >= 3) ownerAbort.abort(); }
  }, 2000) : undefined;
const report = await runSeries({
  signal: ownerAbort.signal,
  seriesFile: resolve(seriesFile),
  scenarios: fastgateScenarios(resolve(BENCH_ROOT, ".."), (line) => console.error(line)),
  scenarioLock: new ScenarioLock(resolve(values["lock-dir"])),
  image: values.image,
  outDir: resolve(values.out),
  ...(values["live-dir"] !== undefined ? { liveDir: resolve(values["live-dir"]) } : {}),
  runId: values["run-id"] ?? defaultRunId(values.image),
  concurrency: positiveInteger("--concurrency", values.concurrency),
  timeoutMs: 0,
  deadlineMs: values.deadline === undefined ? undefined : duration("--deadline", values.deadline),
  deadlineGraceMs: values["deadline-grace"] === undefined ? undefined : duration("--deadline-grace", values["deadline-grace"]),
  kdiServiceUrl: values["kdi-service-url"],
  kdiLogDir: resolve(values["kdi-log-dir"]),
  kdiPolicyDir: resolve(values["kdi-policy-dir"]),
  resume: values.resume,
  families: values.family?.length ? new Set(values.family) : undefined,
  taskIds: values.task?.length ? new Set(values.task) : undefined,
  dockerArgs: values["docker-arg"] ?? [],
  command: positionals.slice(1),
  startupCommand: values["startup-command"],
  model: values.model,
  name: values.name,
  env: containerEnv(values.env ?? []),
  agentDir: await agentDir(values["agent-dir"]),
  docker: values.docker,
  log: (line) => console.error(line),
});

if (ownerTimer) clearInterval(ownerTimer);
const { counts } = report;
console.error(
  `run ${report.runId}: ${counts.answered} answered, ${counts["no-answer"]} without answer, ${counts["invalid-answer"]} invalid, ${counts.timeout} timed out, ${counts.error} errored, ${counts.skipped} skipped`,
);
process.exit(report.interrupted ? 130 : counts.error > 0 ? 1 : 0);

/** The pi agent directory whose auth files each task gets a copy of, or nothing for "none". */
async function agentDir(value: string): Promise<string | undefined> {
  if (value === "none" || value === "") return undefined;
  const dir = resolve(value.replace(/^~(?=\/|$)/, homedir()));
  const found = await stat(dir).then((s) => s.isDirectory(), () => false);
  if (!found) {
    console.error(`--agent-dir ${dir}: no such directory`);
    process.exit(2);
  }
  return dir;
}

function positiveInteger(flag: string, value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < 1) {
    console.error(`${flag}: "${value}" is not a positive whole number`);
    process.exit(2);
  }
  return number;
}

/** `90s`, `20m`, `1h`, or a bare number of minutes, in milliseconds. */
function duration(flag: string, value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!match) {
    console.error(`${flag}: "${value}" is not a duration (90s, 20m, 1h)`);
    process.exit(2);
  }
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "m") as "s" | "m" | "h"];
}

/** `NAME=VALUE` as given; bare `NAME` copies the host's value and fails if unset. */
function containerEnv(specs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    const name = eq === -1 ? spec : spec.slice(0, eq);
    const value = eq === -1 ? process.env[name] : spec.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.error(`--env: "${spec}" is not a variable name`);
      process.exit(2);
    }
    if (HOST_ONLY_ENV.test(name)) {
      console.error(`--env ${name}: database and KDI settings cannot be passed to a container; containers reach data only through the KDI service`);
      process.exit(2);
    }
    if (value === undefined) {
      console.error(`--env ${name}: not set in this environment`);
      process.exit(2);
    }
    env[name] = value;
  }
  return env;
}

function defaultRunId(image: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${image.replace(/[^A-Za-z0-9_.-]/g, "_")}-${stamp}`;
}

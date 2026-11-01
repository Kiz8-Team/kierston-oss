/**
 * Starting runs, and following them while they go.
 *
 * The bench CLI does not re-implement the evaluation runner: it builds the
 * command line a person would have typed, spawns it, and reads its log. That
 * keeps one implementation of what a run is, and means a run started here is
 * indistinguishable from one started by hand — including for the inventory,
 * which reads the run directory either way.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { SeriesProgress } from "../../run_series_prep/src/series.ts";
import { eachLine } from "../../run_series_prep/src/lines.ts";
import { DEFAULTS, PATHS, REPO_ROOT } from "./paths.ts";

export type { SeriesProgress } from "../../run_series_prep/src/series.ts";

export interface DispatchSpec {
  seriesFile: string;
  seriesId: string;
  /** Optional human-readable label; unlike runId it does not identify files or containers. */
  name?: string;
  image: string;
  model?: string;
  concurrency: number;
  /** As the runner takes it: `900s`, `30m`, `2h`. */
  timeout: string;
  /** Minutes each task's agent gets; 0 runs without a deadline whatever the series says. */
  deadlineMinutes: number;
  /** Minutes past the deadline before a container still running is killed. */
  deadlineGraceMinutes: number;
  runId: string;
  outDir: string;
  families: string[];
  taskIds: string[];
  resume: boolean;
  rerunTask?: string;
  rerunParentDir?: string;
  /** pi's agent directory whose auth files each task gets a copy of, or "none". */
  agentDir: string;
  /** `NAME` or `NAME=VALUE`, passed through as --env. */
  env: string[];
  dockerArgs: string[];
  kdiServiceUrl: string;
  startupCommand?: string;
}

export function defaultRunId(image: string): string {
  const at = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${image.replace(/[^A-Za-z0-9_.-]/g, "_")}-${at}`;
}

export function defaultSpec(seriesFile: string, seriesId: string): DispatchSpec {
  return {
    seriesFile,
    seriesId,
    image: DEFAULTS.image,
    concurrency: DEFAULTS.concurrency,
    timeout: DEFAULTS.timeout,
    deadlineMinutes: DEFAULTS.deadlineMinutes,
    deadlineGraceMinutes: DEFAULTS.deadlineGraceMinutes,
    runId: defaultRunId(DEFAULTS.image),
    outDir: PATHS.runs,
    families: [],
    taskIds: [],
    resume: false,
    // No pi agent directory unless the operator names one, with --agent-dir or
    // once for every run in BENCH_AGENT_DIR: otherwise the agent authenticates
    // with API keys added explicitly to env. A named directory has only its
    // auth files copied into each task (see eval_runner RunOptions.agentDir).
    agentDir: process.env.BENCH_AGENT_DIR?.trim() || "none",
    env: [],
    dockerArgs: [],
    kdiServiceUrl: DEFAULTS.kdiServiceUrl,
  };
}

export function runDirFor(spec: DispatchSpec): string {
  return resolve(spec.outDir, spec.seriesId, spec.runId);
}

/** The exact argument list handed to the evaluation runner. */
export function buildArgs(spec: DispatchSpec): string[] {
  if (spec.rerunTask) return ["run", resolve(import.meta.dir, "rerun-worker.ts"), spec.rerunParentDir ?? runDirFor(spec), spec.rerunTask, runDirFor(spec)];
  const args = [
    "run",
    PATHS.evalRunner,
    spec.seriesFile,
    "--image",
    spec.image,
    "--run-id",
    spec.runId,
    "--out",
    spec.outDir,
    "--concurrency",
    String(spec.concurrency),
    "--kdi-service-url",
    spec.kdiServiceUrl,
    "--agent-dir",
    spec.agentDir,
  ];
  // A spec saved before deadlines existed has neither field; its rerun keeps running without one.
  if (spec.deadlineMinutes !== undefined) args.push("--deadline", `${spec.deadlineMinutes}m`);
  if (spec.deadlineMinutes > 0) args.push("--deadline-grace", `${spec.deadlineGraceMinutes ?? DEFAULTS.deadlineGraceMinutes}m`);
  if (spec.model) args.push("--model", spec.model);
  if (spec.startupCommand) args.push("--startup-command", spec.startupCommand);
  if (spec.resume) args.push("--resume");
  for (const family of spec.families) args.push("--family", family);
  for (const task of spec.taskIds) args.push("--task", task);
  for (const variable of spec.env) args.push("--env", variable);
  for (const argument of spec.dockerArgs) args.push("--docker-arg", argument);
  return args;
}

/** The command as a person would type it, for the confirm screen and the log. */
export function commandLine(spec: DispatchSpec): string {
  return ["bun", ...buildArgs(spec)].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export type DispatchEvent =
  | { kind: "line"; line: string }
  | { kind: "task"; id: string; status: string; seconds: number; kdiCalls: number }
  | { kind: "exit"; code: number | null };

export interface Dispatch {
  spec: DispatchSpec;
  runDir: string;
  /** Every line the runner has written, oldest first. */
  lines: string[];
  exited: Promise<number | null>;
  stop: () => void;
  running: () => boolean;
}

/** `<task id>: answered in 504 s, 45 KDI call(s)` */
const TASK_LINE = /^(\S+):\s+(answered|no-answer|invalid-answer|timeout|error|done earlier, skipped)(?:\s+in\s+(\d+)\s*s,\s*(\d+)\s*KDI)?/;

export function dispatch(spec: DispatchSpec, onEvent: (event: DispatchEvent) => void = () => {}): Dispatch {
  const child = spawn("bun", buildArgs(spec), { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let alive = true;

  const consume = (chunk: Buffer, buffer: { rest: string }) => {
    const text = buffer.rest + chunk.toString();
    const parts = text.split("\n");
    buffer.rest = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim() === "") continue;
      lines.push(line);
      onEvent({ kind: "line", line });
      const match = TASK_LINE.exec(line.trim());
      if (match) {
        onEvent({
          kind: "task",
          id: match[1]!,
          status: match[2]!.startsWith("done earlier") ? "skipped" : match[2]!,
          seconds: Number(match[3] ?? 0),
          kdiCalls: Number(match[4] ?? 0),
        });
      }
    }
  };

  const outBuffer = { rest: "" };
  const errBuffer = { rest: "" };
  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, outBuffer));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, errBuffer));

  const exited = new Promise<number | null>((settle) => {
    child.on("close", (code) => {
      alive = false;
      onEvent({ kind: "exit", code });
      settle(code);
    });
    child.on("error", (error) => {
      alive = false;
      lines.push(`failed to start the runner: ${error.message}`);
      onEvent({ kind: "line", line: lines[lines.length - 1]! });
      onEvent({ kind: "exit", code: null });
      settle(null);
    });
  });

  return {
    spec,
    runDir: runDirFor(spec),
    lines,
    exited,
    // SIGINT rather than SIGKILL: the runner kills its containers on the way out.
    stop: () => {
      if (alive) child.kill("SIGINT");
    },
    running: () => alive,
  };
}

/** Build a new series from a prep config, returning the runner's output. */
export async function generateSeries(
  configFile: string, force = false, onProgress?: (progress: SeriesProgress) => void, onLog?: (line: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(["bun", "run", PATHS.seriesPrep, configFile, ...(force ? ["--force"] : []), ...(onProgress ? ["--progress-json"] : [])], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const logged: string[] = [];
  const [out, , code] = await Promise.all([
    new Response(child.stdout).text(),
    eachLine(child.stderr, (line) => {
      if (onProgress && line.startsWith("@progress ")) {
        try {
          onProgress(JSON.parse(line.slice("@progress ".length)) as SeriesProgress);
          return;
        } catch {
          // Not ours after all; keep it with the log.
        }
      }
      logged.push(line);
      onLog?.(line);
    }),
    child.exited,
  ]);
  return { ok: code === 0, output: [out, logged.join("\n")].filter((part) => part.trim() !== "").join("\n").trim() };
}

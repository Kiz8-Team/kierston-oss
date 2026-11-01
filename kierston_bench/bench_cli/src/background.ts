/** Portable ownership and control for runs. Credentials stay in private files. */
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, writeFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildArgs, defaultSpec, runDirFor, type DispatchSpec } from "./dispatch.ts";
import { REPO_ROOT, seriesFileFor } from "./paths.ts";

export type Backend = "process" | "systemd";
export interface ManagedRun {
  token: string;
  host: string;
  backend: Backend;
  unit?: string;
  pid?: number;
  port?: number;
  state: "starting" | "running" | "stopping" | "finished" | "failed";
  heartbeat: number;
  exitCode?: number;
  error?: string;
}
export async function readManaged(dir: string): Promise<ManagedRun | null> {
  try { return JSON.parse(await readFile(join(dir, "manager.json"), "utf8")); } catch { return null; }
}
export async function saveManaged(dir: string, record: ManagedRun) {
  const path = join(dir, "manager.json");
  await writeFile(`${path}.${record.token}.tmp`, JSON.stringify(record), { mode: 0o600 });
  await rename(`${path}.${record.token}.tmp`, path);
}
export async function saveLaunch(spec: DispatchSpec, env: Record<string, string> = {}) {
  const dir = runDirFor(spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "launch.json"), JSON.stringify({ spec, args: buildArgs(spec), env }), { mode: 0o600 });
}
export async function control(dir: string, action: "health" | "stop") {
  const record = await readManaged(dir);
  if (!record || record.host !== hostname() || !record.port) throw new Error("No local run worker is available");
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}`, {
    method: action === "stop" ? "POST" : "GET",
    headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Worker control failed: ${response.status}`);
  const result = await response.json() as ManagedRun;
  if (result.token !== record.token) throw new Error("Worker identity mismatch");
  return result;
}
export function managedState(record: ManagedRun): "running" | "interrupted" | undefined {
  if (record.state === "finished") return undefined;
  if (record.state === "failed") return "interrupted";
  return Date.now() - record.heartbeat < 15_000 ? "running" : "interrupted";
}
export function systemdArgs(unit: string, worker: string, dir: string): string[] {
  return ["--user", `--unit=${unit}`, "--collect", "--service-type=exec",
    `--working-directory=${REPO_ROOT}`, "--property=KillMode=mixed", "--property=TimeoutStopSec=60",
    process.execPath, "run", worker, dir];
}
export async function chooseBackend(request: string = "auto"): Promise<Backend> {
  if (!["auto", "process", "systemd"].includes(request)) throw new Error(`Unknown backend: ${request}`);
  if (request === "process") return request;
  let available = false;
  if (process.platform === "linux") {
    try {
      const probe = Bun.spawn(["systemctl", "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" });
      available = await probe.exited === 0;
    } catch {}
  }
  if (request === "systemd" && !available) throw new Error("The systemd user manager is unavailable; use --backend process");
  return available ? "systemd" : "process";
}
export async function startBackground(spec: DispatchSpec, requested = "auto"): Promise<ManagedRun> {
  const dir = runDirFor(spec);
  await mkdir(dir, { recursive: true });
  const lock = join(dir, ".manager-launch.lock");
  await mkdir(lock).catch(() => { throw new Error("Another launch owns this run directory"); });
  try { return await launchBackground(spec, requested); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
async function launchBackground(spec: DispatchSpec, requested: string): Promise<ManagedRun> {
  const backend = await chooseBackend(requested);
  const dir = runDirFor(spec);
  const prior = await readManaged(dir);
  const savedEnv = await Bun.file(join(dir, "launch.json")).json().then(v => v.env ?? {}, () => ({}));
  if (prior) {
    if (!spec.resume || !["finished", "failed"].includes(prior.state)) {
      throw new Error("Run already managed: stop it before resuming; stale workers require manual reconciliation");
    }
    if (prior.host !== hostname()) throw new Error("Resume on the original host");
    await rename(join(dir, "manager.json"), join(dir, `manager-${prior.token}.json`));
    if (!spec.rerunTask) await rename(join(dir, "run.json"), join(dir, `report-${prior.token}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  } else if (await Bun.file(join(dir, "run.json")).exists() && !spec.resume) {
    throw new Error("Run output already exists; choose another run ID or use --resume");
  }
  // Exclusive creation prevents two dispatchers claiming the same output directory.
  const claim = await open(join(dir, "manager.json"), "wx", 0o600).catch(() => {
    throw new Error("This run already has a manager record; use a new --run-id (managed resume is not automatic)");
  });
  const record: ManagedRun = { token: crypto.randomUUID(), host: hostname(), backend, state: "starting", heartbeat: Date.now() };
  await claim.writeFile(JSON.stringify(record));
  await claim.close();
  try {
    const env: Record<string, string> = { ...savedEnv };
    const names = new Set(["PATH", "HOME", "BENCH_DOCKER", "BENCH_SCENARIO_LOCK_DIR", ...spec.env.map(v => v.split("=")[0]!),
      ...Object.keys(process.env).filter(k => k.startsWith("KIERSTON_") || k.startsWith("KDI_"))]);
    for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    await saveLaunch(spec, env);
    const worker = resolve(import.meta.dir, "background-worker.ts");
    if (backend === "systemd") {
      record.unit = `kierston-bench-${record.token}.service`;
      await saveManaged(dir, record);
      const child = Bun.spawn(["systemd-run", ...systemdArgs(record.unit, worker, dir)], { stdout: "ignore", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      if (await child.exited !== 0) throw new Error(error);
    } else {
      const log = await open(join(dir, "worker.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, ["run", worker, dir], { cwd: REPO_ROOT, detached: true, stdio: ["ignore", log.fd, log.fd] });
        await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
        child.unref();
      } finally { await log.close(); }
    }
  } catch (error) {
    record.state = "failed"; record.error = String(error); await saveManaged(dir, record); throw error;
  }
  for (let i = 0; i < 100; i++) {
    const current = await readManaged(dir);
    if (current && current.state !== "starting") return current;
    await Bun.sleep(100);
  }
  throw new Error(`Worker startup has not been acknowledged; inspect ${dir}/worker.log and manager.json before retrying`);
}

/** Resume the exact selection and settings; credential values remain private. */
export async function savedSpec(dir: string): Promise<DispatchSpec> {
  let spec: DispatchSpec | undefined;
  try {
    spec = JSON.parse(await readFile(join(dir, "launch.json"), "utf8")).spec;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Older foreground TUI runs predate launch.json. Their public report still
    // contains enough information to resume the same task selection.
    const report = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    const seriesFile = seriesFileFor(report.series);
    if (!await Bun.file(seriesFile).exists()) throw new Error(`Cannot resume: series file is missing at ${seriesFile}`);
    spec = {
      ...defaultSpec(seriesFile, report.series),
      image: report.image,
      concurrency: report.concurrency,
      timeout: `${report.timeoutMs}ms`,
      runId: report.runId,
      outDir: dirname(dirname(dir)),
      taskIds: report.selectedTaskIds ?? [],
    };
  }
  if (!spec) throw new Error("No saved dispatch specification");
  // Runs launched before the rename saved the address as shimUrl.
  const legacy = spec as DispatchSpec & { shimUrl?: string };
  if (!spec.kdiServiceUrl && legacy.shimUrl) spec.kdiServiceUrl = legacy.shimUrl;
  delete legacy.shimUrl;
  return { ...spec, rerunTask: undefined, rerunParentDir: undefined };
}

/**
 * The saved spec, ready to resume in this process. A worker record left by an
 * earlier background attempt is set aside, or the run's state would keep
 * coming from its stale heartbeat.
 */
export async function resumeSpec(dir: string): Promise<DispatchSpec> {
  const spec = { ...await savedSpec(dir), resume: true };
  const prior = await readManaged(dir);
  if (prior) {
    if (prior.host !== hostname()) throw new Error("Resume on the original host");
    if (managedState(prior) === "running") throw new Error("A background worker still owns this run; stop it first");
    await rename(join(dir, "manager.json"), join(dir, `manager-${prior.token}.json`));
  }
  return spec;
}

export async function rerunTaskBackground(dir: string, taskId: string) {
  const { summariseRun } = await import("./inventory.ts");
  const spec = await savedSpec(dir);
  const run = await summariseRun(dir, spec.seriesId, spec.runId, null);
  if (run.manager && run.manager.host !== hostname()) throw new Error("Rerun this task on the original host");
  const { taskDirName } = await import("../../eval_runner/src/runner.ts");
  const target = join(dir, taskDirName(taskId));
  if ((run.state === "running" || ["starting", "running", "stopping"].includes(run.manager?.state ?? "")) && !await Bun.file(join(target, "meta.json")).exists()) {
    throw new Error("This task is running or queued; abort it before starting another attempt");
  }
  const series = await Bun.file(spec.seriesFile).json();
  if (!series.tasks.some((task: { id: string }) => task.id === taskId)) throw new Error("Task is no longer in this series");
  const history = join(dir, ".reruns");
  await mkdir(history, { recursive: true });
  const lock = join(history, "launch.lock");
  await mkdir(lock).catch(() => { throw new Error("A task rerun is already in progress for this run"); });
  const childSpec = { ...spec, outDir: join(history, "workers"), runId: crypto.randomUUID(), resume: false, rerunTask: taskId, rerunParentDir: dir };
  const workerDir = runDirFor(childSpec);
  try {
    const env = await Bun.file(join(dir, "launch.json")).json().then(v => v.env ?? {}, () => ({}));
    await saveLaunch(childSpec, env);
    const record = await startBackground(childSpec);
    return { ...record, dir: workerDir };
  } catch (error) {
    const record = await readManaged(workerDir);
    if (!record || record.state === "failed") await rm(lock, { recursive: true, force: true });
    throw error;
  }
}

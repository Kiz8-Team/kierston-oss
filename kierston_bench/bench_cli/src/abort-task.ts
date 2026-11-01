import { readFile, writeFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { containerName } from "../../eval_runner/src/docker.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import { readManaged, savedSpec } from "./background.ts";

/** Inspect the exact container before killing it, including pre-existing runners. */
export async function abortTask(runDir: string, taskId: string): Promise<void> {
  const manager = await readManaged(runDir);
  if (manager && manager.host !== hostname()) throw new Error("Abort this task on its original host");
  let taskDir = join(runDir, taskDirName(taskId));
  const rerun = await Bun.file(join(runDir, "rerun-active.json")).json().catch(() => null);
  if (rerun?.taskId === taskId) {
    const candidate = resolve(rerun.taskDir);
    if (!candidate.startsWith(resolve(runDir, ".reruns") + sep)) throw new Error("Invalid rerun task directory");
    taskDir = candidate;
  }
  if (await Bun.file(join(taskDir, "meta.json")).exists()) throw new Error("This task has already finished");
  const active = await Bun.file(join(taskDir, "active.json")).json().catch(() => null);
  if (active?.host && active.host !== hostname()) throw new Error("Abort this task on its original host");
  let docker: string;
  let name: string;
  let capability: string | undefined;
  if (active) {
    docker = active.docker;
    name = active.container;
    capability = active.capability;
  } else {
    const spec = await savedSpec(runDir);
    const launch = JSON.parse(await readFile(join(runDir, "launch.json"), "utf8").catch(() => "{}"));
    docker = launch.env?.BENCH_DOCKER ?? process.env.BENCH_DOCKER ?? "docker";
    name = containerName("bench", spec.runId, taskId);
  }
  const inspect = Bun.spawn([docker, "inspect", name], { stdout: "pipe", stderr: "pipe" });
  const [output, inspectError, inspectCode] = await Promise.all([new Response(inspect.stdout).text(), new Response(inspect.stderr).text(), inspect.exited]);
  if (inspectCode !== 0) throw new Error(`Task container is not available: ${inspectError.trim()}`);
  const container = JSON.parse(output)[0];
  // The task id never enters the container; the opaque capability does, so match on that when known.
  if (!container?.State?.Running || !container.Id || (capability && !container.Config?.Env?.includes(`AT=${capability}`))) {
    throw new Error("Task is not running, or its container identity does not match");
  }
  const marker = join(taskDir, "abort.json");
  await writeFile(marker, JSON.stringify({ taskId, container: container.Id, at: new Date().toISOString() }));
  const kill = Bun.spawn([docker, "kill", container.Id], { stdout: "ignore", stderr: "pipe" });
  const [error, code] = await Promise.all([new Response(kill.stderr).text(), kill.exited]);
  if (code !== 0) {
    await rm(marker, { force: true });
    throw new Error(`Task abort failed: ${error.trim()}`);
  }
}

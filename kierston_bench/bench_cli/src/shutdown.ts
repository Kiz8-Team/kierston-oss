/**
 * Leaving the TUI leaves nothing of it running.
 *
 * Foreground runners are asked first, with SIGINT, so they kill their own
 * containers and write run.json. After a grace period every container of a run
 * started here is killed by name, and then every process below this one — a
 * runner that did not listen, series generation, `docker run` clients, the KDI service
 * this session started — gets SIGTERM, then SIGKILL. Background workers are
 * spared with everything under them, and so is the KDI service while a background run
 * still needs it: outliving the TUI is what they are for.
 */

import { containerName } from "../../eval_runner/src/docker.ts";
import type { Dispatch } from "./dispatch.ts";
import { DEFAULTS } from "./paths.ts";

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

export interface ShutdownOptions {
  /** Foreground runners this TUI started and that are still running. */
  runners: Dispatch[];
  /** A background run is using the KDI service; leave it up. */
  keepKdiService: boolean;
  /** How long runners get to stop on their own. */
  graceMs?: number;
  docker?: string;
}

export async function shutdown(options: ShutdownOptions): Promise<void> {
  const docker = options.docker ?? DEFAULTS.docker;
  for (const run of options.runners) run.stop();
  if (options.runners.length > 0) {
    await Promise.race([Promise.all(options.runners.map((run) => run.exited)), Bun.sleep(options.graceMs ?? 10_000)]);
  }
  await killContainers(docker, options.runners.map((run) => run.spec.runId));

  const spare = (proc: Proc) => proc.command.includes("background-worker.ts") || (options.keepKdiService && proc.command.includes("kdi_service"));
  const pids = descendants(await processTable(), process.pid, spare);
  signal(pids, "SIGTERM");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pids.some(alive)) await Bun.sleep(100);
  signal(pids.filter(alive), "SIGKILL");
}

/** Every process below `root`, leaving out whole subtrees that `spare` keeps. */
export function descendants(table: Proc[], root: number, spare: (proc: Proc) => boolean = () => false): number[] {
  const children = new Map<number, Proc[]>();
  for (const proc of table) {
    const list = children.get(proc.ppid);
    if (list) list.push(proc);
    else children.set(proc.ppid, [proc]);
  }
  const found: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (spare(child)) continue;
      found.push(child.pid);
      walk(child.pid);
    }
  };
  walk(root);
  return found;
}

async function processTable(): Promise<Proc[]> {
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === ps.pid) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }];
  });
}

/** `bench-<runId>-<task>`, matched by exact prefix so a longer run id is not caught. */
async function killContainers(docker: string, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  try {
    const ps = Bun.spawn([docker, "ps", "--filter", "name=bench-", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "ignore" });
    const names = (await new Response(ps.stdout).text()).split("\n").map((line) => line.trim());
    await ps.exited;
    const prefixes = runIds.map((runId) => `${containerName("bench", runId)}-`);
    const doomed = names.filter((name) => name !== "" && prefixes.some((prefix) => name.startsWith(prefix)));
    if (doomed.length === 0) return;
    await Bun.spawn([docker, "kill", ...doomed], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // No docker, nothing of ours to kill.
  }
}

function signal(pids: number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

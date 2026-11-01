/**
 * One lock shared by every runner process on this host, deciding what may run
 * beside what.
 *
 * A scenario task (RTI or DT) changes the event store under everything that
 * reads it, so it runs alone: no other task of any kind, on any date, in any
 * run. Plain tasks share the lock with each other. Runs, reruns and the TUI's
 * background workers are separate processes, so the lock lives on disk: one
 * JSON list of holders, edited under a mkdir mutex.
 *
 * A holder whose process has died (same host) is pruned, so a runner killed
 * outright never wedges the bench. An exclusive request queues a `waiting`
 * entry that keeps new shared holders out, so a scenario task waits only for
 * the tasks already running, not for every plain task behind it; waiting
 * entries are served in the order they were queued.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export type LockMode = "shared" | "exclusive";

interface Holder {
  id: string;
  mode: LockMode | "waiting";
  pid: number;
  host: string;
  /** Who holds it, for a person reading the file. */
  label: string;
  since: string;
}

export interface AcquireOptions {
  /** Try once and return null rather than waiting. */
  wait?: boolean;
  /** Polled while waiting; returning true gives up and returns null. */
  cancelled?: () => boolean;
}

const MUTEX_STALE_MS = 30_000;
const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

export class ScenarioLock {
  constructor(readonly dir: string, private readonly pollMs = 1000) {}

  /** Resolves to a release function, or null when not waiting or cancelled. */
  async acquire(mode: LockMode, label: string, options: AcquireOptions = {}): Promise<(() => Promise<void>) | null> {
    const id = randomUUID();
    const self = { id, pid: process.pid, host: hostname(), label };
    for (;;) {
      const granted = await this.update((holders) => {
        const at = holders.findIndex((holder) => holder.id === id);
        const others = holders.filter((holder) => holder.id !== id);
        const blocked = mode === "shared"
          ? others.some((holder) => holder.mode !== "shared")
          : others.some((holder) => holder.mode !== "waiting" || holders.indexOf(holder) < (at === -1 ? holders.length : at));
        if (!blocked) return { holders: [...others, { ...self, mode, since: new Date().toISOString() }], result: true };
        if (mode === "exclusive" && options.wait !== false && at === -1) {
          return { holders: [...holders, { ...self, mode: "waiting", since: new Date().toISOString() }], result: false };
        }
        return { holders, result: false };
      });
      if (granted) return () => this.release(id);
      if (options.wait === false || options.cancelled?.()) {
        await this.release(id);
        return null;
      }
      await sleep(this.pollMs);
    }
  }

  private release(id: string): Promise<void> {
    return this.update((holders) => ({ holders: holders.filter((holder) => holder.id !== id), result: undefined }));
  }

  private async update<T>(change: (holders: Holder[]) => { holders: Holder[]; result: T }): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    await this.lockMutex();
    try {
      const file = join(this.dir, "holders.json");
      const current = await readFile(file, "utf8").then((text) => JSON.parse(text) as Holder[], () => []);
      const { holders, result } = change(current.filter(alive));
      const temporary = `${file}.${process.pid}.${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(holders, null, 2) + "\n");
      await rename(temporary, file);
      return result;
    } finally {
      await rm(join(this.dir, "mutex"), { recursive: true, force: true });
    }
  }

  private async lockMutex(): Promise<void> {
    const path = join(this.dir, "mutex");
    for (;;) {
      try {
        await mkdir(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // A mutex is held for one small file edit; an old one was left by a crash.
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > MUTEX_STALE_MS) await rm(path, { recursive: true, force: true });
      else await sleep(10 + Math.random() * 20);
    }
  }
}

function alive(holder: Holder): boolean {
  if (holder.host !== hostname()) return true;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

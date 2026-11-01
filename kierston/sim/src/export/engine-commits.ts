/**
 * The engine's commit history, read from git and nothing else.
 *
 * Split out of version.ts so that something outside the engine — the README
 * stamp run from a git hook — can ask for the committed version without
 * loading the world, the exporter and every workspace package behind them.
 * Keep it that way: this file imports nothing from the engine.
 */

import { resolve } from "node:path";

/** The two trees whose commits mint a version, as `replayProvenance` digests. */
export const ENGINE = ["kierston/sim/src", "kierston/pathfinder/src"];
export const HASH = 8;

/** The repository root, four levels up from kierston/sim/src/export. */
const ROOT = resolve(import.meta.dir, "../../../..");

export function git(args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export function utcDay(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

/** Every commit touching the engine, newest first, with its UTC day. */
export function engineCommits(): { hash: string; day: string }[] {
  const log = git(["log", "--format=%H %ct", "--", ...ENGINE]);
  return (log ?? "").split("\n").filter(Boolean).map((line) => {
    const [hash, seconds] = line.split(" ");
    return { hash: hash!, day: utcDay(Number(seconds)) };
  });
}

/**
 * The version of the engine as committed at HEAD, whatever the working tree
 * holds. This is what the README carries, and what a clean checkout stamps.
 */
export function committedEngineVersion(): string | null {
  const commits = engineCommits();
  if (commits.length === 0) return null;
  // Newest first, so this commit's ordinal is how many of its own day's
  // commits sit at or after it in the list.
  const head = commits[0]!;
  const n = commits.filter((commit) => commit.day === head.day).length;
  return `${head.day}.${n}-${head.hash.slice(0, HASH)}`;
}

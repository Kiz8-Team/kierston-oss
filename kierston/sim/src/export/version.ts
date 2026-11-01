/**
 * The engine's version, as it is stamped into every KDAY.
 *
 *   dd.mm.yyyy.n-hash
 *
 * The date is the UTC day of the engine commit, `n` counts that day's engine
 * commits from 1 so two versions cut on one day stay apart, and the hash is the
 * commit's. Only commits touching the engine count — the simulation and the
 * router, the same two trees `replayProvenance` digests — so a paper edit does
 * not mint a version.
 *
 * A working tree with uncommitted engine changes is a version nobody can check
 * out, and it says so by being the next one: today's date, one past today's
 * last engine commit, and the provenance digest of the source actually run in
 * place of a commit hash.
 */

import { replayProvenance } from "./binary.ts";
import { ENGINE, HASH, committedEngineVersion, engineCommits, git, utcDay } from "./engine-commits.ts";

let cached: Promise<string> | null = null;

export function engineVersion(): Promise<string> {
  return cached ??= resolveVersion();
}

async function resolveVersion(): Promise<string> {
  const override = process.env.KIERSTON_ENGINE_VERSION;
  if (override) return override;

  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...ENGINE]);
  const dirty = status === null || status.split("\n")
    .some((line) => line.trim() && !line.endsWith(".test.ts"));

  const committed = committedEngineVersion();
  if (!dirty && committed) return committed;

  const commits = engineCommits();
  const today = utcDay(Date.now() / 1000);
  const n = commits.filter((commit) => commit.day === today).length + 1;
  const { engine } = await replayProvenance();
  return `${today}.${n}-${engine.slice(0, HASH)}`;
}

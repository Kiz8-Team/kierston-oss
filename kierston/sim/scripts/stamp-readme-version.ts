/**
 * Keep the README's engine version in step with the engine, one commit behind.
 *
 *   bun run kierston/sim/scripts/stamp-readme-version.ts
 *
 * Run by .githooks/post-commit after every commit. It cannot be a pre-commit
 * hook: the version ends in the engine commit's own hash, which does not exist
 * until the commit does, and putting the README into that commit would change
 * the hash it names. So the stamp is a commit of its own, made right after, and
 * because it touches only the README it is not an engine commit and does not
 * move the version it records.
 *
 * The follow-up commit is built from HEAD's tree with only the README line
 * replaced, never from the index or the working tree, so nothing else you have
 * staged or edited rides along with it. The working copy and the index get
 * the same one-line swap, and keep whatever else they held.
 *
 * Does nothing when the README already says the committed version, which is
 * what makes it safe to run after every commit including its own. Skipped
 * mid-rebase, mid-merge and mid-cherry-pick, where a commit of its own would
 * land in the middle of somebody else's sequence, and when
 * SKIP_ENGINE_VERSION_STAMP is set.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { committedEngineVersion } from "../src/export/engine-commits.ts";

const README = "README.md";
const LINE = /^Engine version: `[^`]*`$/m;

function git(args: string[], env: Record<string, string> = {}, input?: string, raw = false): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  const out = result.stdout.toString();
  return raw ? out : out.trim();
}

const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();

function inSequence(): boolean {
  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
    .some((name) => existsSync(resolve(root, git(["rev-parse", "--git-path", name]))));
}

function main(): void {
  if (process.env.SKIP_ENGINE_VERSION_STAMP || inSequence()) return;

  const version = committedEngineVersion();
  if (!version) return;

  // Raw, not trimmed: the file is rewritten from this and has to come back
  // byte for byte apart from the one line.
  const committed = git(["show", `HEAD:${README}`], {}, undefined, true);
  const match = committed.match(LINE);
  if (!match) {
    console.error(`stamp-readme-version: no "Engine version:" line in ${README}, left alone`);
    return;
  }
  const line = `Engine version: \`${version}\``;
  if (match[0] === line) return;

  // A tree that is HEAD's in everything but the one README line, written
  // through a scratch index so the real one is not touched.
  const stamped = committed.replace(LINE, line);
  const blob = git(["hash-object", "-w", "--stdin"], {}, stamped);
  const index = resolve(root, git(["rev-parse", "--git-path", "stamp-readme-index"]));
  try {
    const env = { GIT_INDEX_FILE: index };
    git(["read-tree", "HEAD"], env);
    git(["update-index", "--cacheinfo", `100644,${blob},${README}`], env);
    const tree = git(["write-tree"], env);
    const message = `README: engine version ${version}`;
    const commit = git(["commit-tree", tree, "-p", "HEAD", "-m", message]);
    git(["update-ref", "-m", `commit: ${message}`, "HEAD", commit, git(["rev-parse", "HEAD"])]);
  } finally {
    rmSync(index, { force: true });
  }

  // Bring the working copy and the real index along. Only the one line is
  // swapped, so an edit in progress to the rest of the README is kept — and
  // committing it later does not put the old version back.
  const path = join(root, README);
  const working = readFileSync(path, "utf8");
  if (LINE.test(working)) writeFileSync(path, working.replace(LINE, line));
  const staged = git(["show", `:${README}`], {}, undefined, true);
  if (LINE.test(staged)) {
    const restaged = git(["hash-object", "-w", "--stdin"], {}, staged.replace(LINE, line));
    git(["update-index", "--cacheinfo", `100644,${restaged},${README}`]);
  }

  console.log(`stamp-readme-version: README engine version → ${version}`);
}

main();

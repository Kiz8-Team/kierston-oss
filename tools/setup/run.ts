/** Shared process helpers for the setup and city-init entries. */

import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const VENV_PYTHON = join(ROOT, "kierston/.venv/bin/python");

/** Runs a command with inherited stdio and exits with its code on failure. */
export function run(cmd: string[], cwd = ROOT, env?: Record<string, string>): void {
  const proc = Bun.spawnSync(cmd, { cwd, env: env ? { ...process.env, ...env } : undefined, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`Failed: ${cmd.join(" ")} (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
}

/** Captured stdout of a command, or null when it is missing or fails. */
export function output(cmd: string[]): string | null {
  try {
    const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

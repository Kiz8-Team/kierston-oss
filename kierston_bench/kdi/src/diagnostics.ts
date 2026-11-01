/**
 * Where a failure's real cause goes. Whatever KDI prints reaches the agent
 * through the KDI service, so an unexpected error is printed as a generic message
 * (ADI.failed) and its cause, which can name hosts, tables and paths, is
 * written here instead: to KDI_CAUSE_FILE, a host-only file the KDI service reads
 * back into its own log, or to stderr when KDI runs by hand with no KDI service.
 */

import { appendFileSync } from "node:fs";

function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? (current.stack ?? `${current.name}: ${current.message}`) : String(current));
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join("\ncaused by: ");
}

export function recordCause(context: string, error: unknown): void {
  const text = `${context}: ${describe(error)}\n`;
  const file = process.env.KDI_CAUSE_FILE;
  try {
    if (file) appendFileSync(file, text, { mode: 0o600 });
    else process.stderr.write(text);
  } catch { /* diagnostics never turn a failure into a crash */ }
}

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The project keeps one .env.local at its top level so every tool -- Fastgate,
// KDI, the iceberg CLI -- reads the same database credentials. Bun and
// Next.js only look in the process working directory, so we walk up to the
// project root ourselves and load the file before anything reads process.env.

function projectRoot(from: string): string {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(from);
    directory = parent;
  }
}

function parse(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (name) values.set(name, value);
  }
  return values;
}

/**
 * Load the project-level .env.local into process.env. Values already present in
 * the environment win, so a shell override or CI secret still takes precedence.
 * Returns the project root so callers can resolve sibling paths from it.
 */
export function loadProjectEnvironment(from: string = process.cwd()): string {
  const root = projectRoot(from);
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const [key, value] of parse(readFileSync(path, "utf8"))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return root;
}

export const PROJECT_ROOT = loadProjectEnvironment(import.meta.dir ?? process.cwd());

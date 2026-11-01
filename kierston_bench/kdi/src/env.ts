import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The project keeps one .env.local at its top level so Fastgate, KDI and the
// other tools share a single set of database credentials. Next only reads .env
// files from the app directory, so KDI walks up to the project root itself.
// Fastgate carries the same loader at fastgate/src/env.ts; the two are kept
// separate because neither package depends on the other.

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
    const quoted = value.length > 1
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (name) values.set(name, value);
  }
  return values;
}

let loaded = false;

/**
 * Load the project-level .env.local into process.env. Values already set in the
 * environment win, so a shell override or a deployment secret still takes
 * precedence. Safe to call repeatedly; only the first call reads the disk.
 */
export function loadProjectEnvironment(from: string = process.cwd()): string {
  const root = projectRoot(from);
  if (loaded) return root;
  loaded = true;
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const [key, value] of parse(readFileSync(path, "utf8"))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return root;
}

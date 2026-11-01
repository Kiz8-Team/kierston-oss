/** Reject imports that reach into another subsystem behind its index.ts. */

import { dirname, join, normalize, relative } from "node:path";

const sourceRoot = normalize(join(import.meta.dir, "..", "src"));

function subsystem(path: string): string | null {
  const local = relative(sourceRoot, path);
  if (local === ".." || local.startsWith("../")) return null;
  const parts = local.split("/");
  if (parts[0] === "activities" && parts[1]) return `activities/${parts[1]}`;
  if (parts[0] && parts[0] !== "cli.ts" && parts[0] !== "index.ts") return parts[0];
  return null;
}

const violations: string[] = [];
const imports = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

for await (const relativeFile of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot })) {
  const file = join(sourceRoot, relativeFile);
  const owner = subsystem(file);
  if (!owner) continue;

  const source = await Bun.file(file).text();
  for (const match of source.matchAll(imports)) {
    const target = normalize(join(dirname(file), match[1]));
    const targetOwner = subsystem(target);
    if (!targetOwner || targetOwner === owner || target.endsWith("/index.ts")) continue;
    violations.push(`${relativeFile}: cross-subsystem import ${match[1]} bypasses ${targetOwner}/index.ts`);
  }
}

// Core packages must never import from tools/: the engine, scenarios, importer
// and benchmark have to work without the viewers' source tree.
const repoRoot = normalize(join(import.meta.dir, "..", "..", ".."));
const toolsRoot = join(repoRoot, "tools") + "/";
for (const core of ["kierston/sim", "kierston/pathfinder", "kierston_scenarios", "fastgate", "kierston_bench", "packages"]) {
  const coreRoot = join(repoRoot, core);
  for await (const relativeFile of new Bun.Glob("**/*.ts").scan({ cwd: coreRoot })) {
    if (relativeFile.includes("node_modules/")) continue;
    const file = join(coreRoot, relativeFile);
    for (const match of (await Bun.file(file).text()).matchAll(imports)) {
      if (normalize(join(dirname(file), match[1])).startsWith(toolsRoot)) {
        violations.push(`${core}/${relativeFile}: core imports from tools/ (${match[1]})`);
      }
    }
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("subsystem boundaries are clean");

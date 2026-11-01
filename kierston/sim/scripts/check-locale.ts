/**
 * Reject the reference city's and its state's names in engine code.
 *
 * What is particular to one city lives in its profile (`cities/<slug>.toml`,
 * `[locale]`) and its lists (`cities/<slug>/*.csv`); what is particular to one
 * legal system lives in `jurisdictions/<profile>/jurisdiction.toml`. This fails
 * when a place name, county code, area code, the state DMV's name or the
 * city's time zone turns up in init or simulation source instead — comments
 * included, since a comment naming the place is usually a constant that
 * moved and left its reasoning behind.
 *
 * `init/state_specific_generators/` is skipped: it is where code tied to one
 * state's law and formats lives.
 *
 * A line that genuinely has to name the place (the title of a cited data
 * source, say) is allowed by ending it with `locale-ok: <why>`.
 */

import { join, normalize } from "node:path";

const kierston = normalize(join(import.meta.dir, "..", ".."));
const pattern = /Allentown|Lehigh|PENNDOT|PennDOT|42077|\b610\b|\b484\b|America\/New_York/;
const allowed = /locale-ok: \S/;

const scopes = [
  { root: join(kierston, "init"), glob: "**/*.py", skip: (file: string) => file.startsWith("tests/") || file.startsWith("acquire/") || file.startsWith("state_specific_generators/") || file.includes("/tests/") },
  { root: join(kierston, "sim", "src"), glob: "**/*.ts", skip: (file: string) => file.endsWith(".test.ts") },
];

const violations: string[] = [];
for (const { root, glob, skip } of scopes) {
  for await (const file of new Bun.Glob(glob).scan({ cwd: root })) {
    if (skip(file)) continue;
    const lines = (await Bun.file(join(root, file)).text()).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line) && !allowed.test(line)) {
        violations.push(`${join(root, file).slice(kierston.length + 1)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length) {
  console.error("city- or state-specific constants in engine code (move them to the profile, the city's CSVs or jurisdiction.toml):");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("no city- or state-specific names in init or sim source");

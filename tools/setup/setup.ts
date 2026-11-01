/**
 * Sets up a fresh clone: unpacks the input bundle, creates the Python venv,
 * installs Python and Bun dependencies, enables the git hooks, then optionally
 * builds the Allentown city and exports a first day or week.
 *
 *   bun run setup-project [--city | --no-city] [--export none|day|week]
 *
 * Both questions are asked before anything runs, so the rest needs no input.
 * The flags answer them up front; without a terminal, unanswered questions
 * take the defaults (city yes, export none).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, VENV_PYTHON, output, run } from "./run.ts";
import { select } from "./select.ts";

const DAY_DATE = "2026-09-01";
const WEEK_START = "2026-08-31";
const WEEK_END = "2026-09-06";

type Export = "none" | "day" | "week";
const EXPORTS: Export[] = ["none", "day", "week"];

const argv = process.argv.slice(2);

function exportFlag(): Export | undefined {
  const at = argv.indexOf("--export");
  const value = at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith("--export="))?.slice(9);
  if (value === undefined) return undefined;
  if (!EXPORTS.includes(value as Export)) {
    console.error(`--export takes ${EXPORTS.join(", ")}`);
    process.exit(2);
  }
  return value as Export;
}

function checkPrerequisites(): void {
  const missing: string[] = [];
  if (!existsSync(VENV_PYTHON)) {
    const version = output(["python3", "-c", "import sys; print(sys.version_info >= (3, 11))"]);
    if (version !== "True") missing.push("Python 3.11+ (python3)");
  }
  if (!existsSync(join(ROOT, "kierston/sources")) && output(["zstd", "--version"]) === null) missing.push("zstd");
  if (missing.length > 0) {
    console.error(`Missing: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function ask(): Promise<{ city: boolean; exportKind: Export }> {
  const hasCity = existsSync(join(ROOT, "kierston/sim_data/sim_init.bin"));
  let city = argv.includes("--city") ? true : argv.includes("--no-city") ? false : undefined;
  let exportKind = exportFlag();

  const interactive = process.stdin.isTTY === true;

  if (city === undefined) {
    city = interactive
      ? await select(hasCity ? "Allentown city (existing build)" : "Allentown city", hasCity
        ? [{ label: "Keep", value: false }, { label: "Rebuild", value: true }]
        : [{ label: "Build", value: true }, { label: "Skip", value: false }])
      : !hasCity;
  }

  if (exportKind === undefined) {
    exportKind = interactive && (city || hasCity)
      ? await select("Export", [
        { label: "None", value: "none" as Export },
        { label: `Day   ${DAY_DATE}`, value: "day" as Export },
        { label: `Week  ${WEEK_START} to ${WEEK_END}`, value: "week" as Export },
      ])
      : "none";
  }

  if (exportKind !== "none" && !city && !hasCity) {
    console.error("Export needs a city build; pass --city");
    process.exit(2);
  }
  return { city, exportKind };
}

checkPrerequisites();
const { city, exportKind } = await ask();

if (existsSync(join(ROOT, "kierston/sources"))) {
  console.log("Input bundle already unpacked");
} else {
  console.log("Unpacking input bundle");
  run(["tar", "--zstd", "-xf", "kierston/init-inputs.tar.zst", "-C", "kierston"]);
}

if (!existsSync(VENV_PYTHON)) {
  console.log("Creating Python venv");
  run(["python3", "-m", "venv", "kierston/.venv"]);
}
// A venv made by uv has no pip; install through uv when it is there.
console.log("Installing Python dependencies");
if (output([VENV_PYTHON, "-m", "pip", "--version"]) !== null) {
  run([VENV_PYTHON, "-m", "pip", "install", "--quiet", "-r", "kierston/requirements-dev.txt"]);
} else if (output(["uv", "--version"]) !== null) {
  run(["uv", "pip", "install", "--quiet", "--python", VENV_PYTHON, "-r", "kierston/requirements-dev.txt"]);
} else {
  run([VENV_PYTHON, "-m", "ensurepip", "--upgrade"]);
  run([VENV_PYTHON, "-m", "pip", "install", "--quiet", "-r", "kierston/requirements-dev.txt"]);
}

console.log("Installing Bun dependencies");
run(["bun", "install", "--frozen-lockfile"]);

if (existsSync(join(ROOT, ".git")) && output(["git", "config", "core.hooksPath"]) !== ".githooks") {
  console.log("Enabling git hooks");
  run(["git", "config", "core.hooksPath", ".githooks"]);
}

if (city) run(["bun", "run", "city-init"]);

if (exportKind === "day") {
  console.log(`Exporting day ${DAY_DATE}`);
  run(["bun", "run", "day", "--export-day", "--date", DAY_DATE]);
} else if (exportKind === "week") {
  console.log(`Exporting week from ${WEEK_START}`);
  run(["bun", "run", "day", "--export-day", "--week", "--date", WEEK_START]);
}

console.log("Setup done");

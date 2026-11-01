/**
 * The run-series configuration: which families a series contains, how many
 * distinct copies of each, and which observed days and seed they are drawn
 * from. Read from TOML, validated here so a typo in a family name fails
 * before any day file is opened.
 *
 * Paths are resolved against the repository root unless absolute, so a
 * config committed next to the code works from any working directory.
 */

import { isAbsolute, join, resolve } from "node:path";
import { GENERATORS, STAGED_GENERATORS } from "../../task_generators/src/index.ts";
import { BENCH_SCENARIOS, scenarioById } from "../../../kierston_scenarios/scenarios/catalog.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const SCENARIOS_DIR = join(REPO_ROOT, "kierston_scenarios/scenarios");

/** One staged scenario the series draws tasks from: a script, run with each seed against each day. */
export interface ScenarioPlan {
  /** Catalogue id; also names the output files. */
  id: string;
  /** The script, absolute. */
  script: string;
  /** Families generated from the scenario day (base + delta), restricted to those the series includes. */
  families: string[];
  /** Seeds to stage, in order. With `wanted` set these are candidates and staging stops once that many succeed. */
  seeds: number[];
  /** Stagings wanted per day when the seeds are derived (`count`, else `tasks.copies`); every listed seed must succeed when unset. */
  wanted?: number;
  /** KDAY files, absolute; the series' days unless the plan names its own. */
  days: string[];
  maxAffected: number;
}

export interface RunSeriesConfig {
  id: string;
  seed: number;
  /** KDAY files, absolute. */
  days: string[];
  /** `kierston/sim_data`, absolute. */
  simData: string;
  /** Family -> distinct copies wanted per day. Only included families appear. */
  copies: Map<string, number>;
  /** Upper bound on seeds tried per wanted copy before the family is short. */
  attemptsPerCopy: number;
  /** Where the tasks file goes, absolute. */
  outputDir: string;
  /** Command every task's container runs; see KierstonBenchTask.startupCommand. */
  startupCommand?: string;
  /** Minutes each task's agent is given before it is told to stop; see eval_runner. */
  deadlineMinutes?: number;
  /** Scenarios to stage, in order; empty when the series has none. */
  scenarios: ScenarioPlan[];
  /** Where staged deltas go, absolute. */
  scenarioDir: string;
  /** The parsed TOML, kept verbatim in the output for provenance. */
  raw: Record<string, unknown>;
}

const KNOWN_FAMILIES = new Set(GENERATORS.map((generator) => generator.family));
/** Families that read a staged scenario day: the RTI and DT groups. */
const STAGED_FAMILIES = new Set(STAGED_GENERATORS.map((generator) => generator.family));

export async function loadConfig(path: string): Promise<RunSeriesConfig> {
  const text = await Bun.file(path).text();
  const raw = Bun.TOML.parse(text) as Record<string, unknown>;
  return parseConfig(raw, path);
}

export function parseConfig(raw: Record<string, unknown>, source = "<inline>"): RunSeriesConfig {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  const series = table(raw.series) ?? fail("missing [series]");
  const tasks = table(raw.tasks) ?? fail("missing [tasks]");

  const id = typeof series.id === "string" && /^[A-Za-z0-9._-]+$/.test(series.id)
    ? series.id
    : fail("series.id must be a string of letters, digits, '.', '_' or '-'");
  const seed = integer(series.seed, 1, "series.seed");

  const dayValues = Array.isArray(series.days)
    ? series.days
    : typeof series.day === "string" ? [series.day] : fail("series.days must list at least one KDAY file");
  if (dayValues.length === 0) fail("series.days must list at least one KDAY file");
  const days = dayValues.map((value, index) =>
    typeof value === "string" ? fromRoot(value) : fail(`series.days[${index}] must be a path`));

  const simData = fromRoot(typeof series.sim_data === "string" ? series.sim_data : "kierston/sim_data");
  const outputDir = fromRoot(typeof series.output_dir === "string" ? series.output_dir : "kierston_bench/run_series");

  const defaultCopies = integer(tasks.copies, 1, "tasks.copies");
  const attemptsPerCopy = integer(tasks.attempts_per_copy, 8, "tasks.attempts_per_copy");

  const include = tasks.include ?? "all";
  const included = include === "all"
    ? [...KNOWN_FAMILIES]
    : Array.isArray(include)
      ? include.map((family) => knownFamily(family, "tasks.include", fail))
      : fail('tasks.include must be "all" or a list of families');
  const excluded = new Set(
    Array.isArray(tasks.exclude) ? tasks.exclude.map((family) => knownFamily(family, "tasks.exclude", fail)) : [],
  );

  const perFamily = table(tasks.per_family) ?? {};
  for (const family of Object.keys(perFamily)) knownFamily(family, "tasks.per_family", fail);

  // A staged family (RTI or DT) reads one staged incident, so a second copy
  // differs only in the minute the investigation starts; one per staging
  // unless the config asks for more.
  const copies = new Map<string, number>();
  for (const family of included) {
    if (excluded.has(family)) continue;
    const count = family in perFamily
      ? integer(perFamily[family], defaultCopies, `tasks.per_family.${family}`)
      : STAGED_FAMILIES.has(family) ? 1 : defaultCopies;
    if (count > 0) copies.set(family, count);
  }
  if (copies.size === 0) fail("no families left after include/exclude; nothing to generate");

  const scenarioDir = fromRoot(typeof series.scenario_dir === "string" ? series.scenario_dir : `kierston/sim_outputs/scenarios/${id}`);
  const plans = Array.isArray(raw.scenarios) ? raw.scenarios : raw.scenarios === undefined ? [] : fail("scenarios must be an array of tables");
  const scenarios = plans.map((value, index) => scenarioPlan(value, index, days, seed, copies, defaultCopies, attemptsPerCopy, fail));
  const wanted = new Set(scenarios.flatMap((plan) => plan.families));
  for (const family of copies.keys()) {
    if (STAGED_FAMILIES.has(family) && !wanted.has(family) && include !== "all") fail(`tasks.include names ${family}, but no [[scenarios]] entry stages it`);
  }

  const agent = table(raw.agent) ?? {};
  const startupCommand = agent.startup_command === undefined
    ? undefined
    : typeof agent.startup_command === "string" && agent.startup_command.trim() !== ""
      ? agent.startup_command
      : fail("agent.startup_command must be a non-empty shell command");
  const deadlineMinutes = agent.deadline_minutes === undefined
    ? undefined
    : typeof agent.deadline_minutes === "number" && agent.deadline_minutes > 0
      ? agent.deadline_minutes
      : fail("agent.deadline_minutes must be a positive number");

  return { id, seed, days, simData, copies, attemptsPerCopy, outputDir, startupCommand, deadlineMinutes, scenarios, scenarioDir, raw };
}

function scenarioPlan(
  value: unknown, index: number, seriesDays: string[], seriesSeed: number, copies: Map<string, number>,
  defaultCopies: number, attemptsPerCopy: number, fail: (message: string) => never,
): ScenarioPlan {
  const where = `scenarios[${index}]`;
  const entry = table(value) ?? fail(`${where} must be a table`);
  const known = typeof entry.id === "string" ? scenarioById.get(entry.id) : undefined;
  if (!known) fail(`${where}.id must name a benchmark scenario; known: ${BENCH_SCENARIOS.map((scenario) => scenario.id).join(", ")}`);
  const families = known!.families.filter((family) => copies.has(family));
  let seeds: number[], wanted: number | undefined;
  if (Array.isArray(entry.seeds)) {
    seeds = entry.seeds.map((seed, i) => Number.isInteger(seed) && (seed as number) >= 0 ? seed as number : fail(`${where}.seeds[${i}] must be a non-negative integer`));
    if (entry.count !== undefined) fail(`${where}: give seeds or count, not both`);
  } else {
    // A real day refuses many seeds cheaply (nobody fits, a trip is infeasible),
    // so derived seeds are candidates: keep trying until `count` succeed.
    // Without a count, `tasks.copies` sets how many deltas each day gets.
    wanted = integer(entry.count, defaultCopies, `${where}.count`);
    seeds = Array.from({ length: wanted * attemptsPerCopy }, (_, i) => scenarioSeed(seriesSeed, known!.id, i));
  }
  if (!seeds.length || new Set(seeds).size !== seeds.length) fail(`${where}: seeds must be non-empty and distinct`);
  const days = Array.isArray(entry.days)
    ? entry.days.map((day, i) => typeof day === "string" ? fromRoot(day) : fail(`${where}.days[${i}] must be a path`))
    : seriesDays;
  const maxAffected = integer(entry.max_affected, known!.maxAffected, `${where}.max_affected`);
  return { id: known!.id, script: join(SCENARIOS_DIR, known!.file), families, seeds, ...(wanted === undefined ? {} : { wanted }), days, maxAffected };
}

/** A scenario seed per (series seed, scenario, index), so a series reproduces its stagings. */
export function scenarioSeed(seriesSeed: number, scenario: string, index: number): number {
  let value = 2166136261;
  for (const char of `${seriesSeed}|scenario|${scenario}|${index}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  // Keep it small enough to read in a file name and in the header.
  return (value >>> 0) % 1_000_000;
}

function table(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`${name} must be a non-negative integer`);
}

function knownFamily(value: unknown, where: string, fail: (message: string) => never): string {
  if (typeof value !== "string" || !KNOWN_FAMILIES.has(value)) {
    fail(`${where}: unknown family ${JSON.stringify(value)}; known: ${[...KNOWN_FAMILIES].join(", ")}`);
  }
  return value as string;
}

function fromRoot(path: string): string {
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}

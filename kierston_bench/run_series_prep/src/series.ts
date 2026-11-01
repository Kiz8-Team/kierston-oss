/**
 * A RunSeries is one whole benchmark run: a fixed collection of tasks. Each
 * task is a family, a sampled target (the model's input) and the recorded
 * ground truth, and every generator draw is random, so the series is what
 * pins them down — generated once from a config, written to one file, and
 * then the same for every model evaluated against it.
 *
 * Copies of a family are distinct tasks: two draws that produce the same
 * evidence are the same task from the model's side, so the second is
 * discarded and another seed is tried. A family that cannot fill its quota
 * on a day is reported short rather than failing the series.
 */

import { basename, relative } from "node:path";
import {
  GENERATORS,
  generatorByFamily,
  openContext,
  Rng,
  type KierstonBenchTask,
  type TaskContext,
} from "../../task_generators/src/index.ts";
import { REPO_ROOT, type RunSeriesConfig, type ScenarioPlan } from "./config.ts";
import { stageDelta, type StagedScenario } from "./stage.ts";
import { takeTruthSnapshot, type TruthSnapshot } from "../../scoring/src/truth_snapshot.ts";

export interface FamilyOutcome {
  family: string;
  date: string;
  /** Set when the tasks came from a staged scenario day rather than the base day. */
  scenario?: { id: string; seed: number };
  requested: number;
  produced: number;
  /** Seeds that were tried and thrown away, with the generator's reason. */
  rejected: { seed: number; reason: string }[];
}

export interface RunSeriesData {
  series: {
    id: string;
    createdAt: string;
    seed: number;
    days: { file: string; date: string }[];
    families: string[];
    taskCount: number;
    config: Record<string, unknown>;
    generatorVersion: string;
    /** Whether the working tree had uncommitted changes, so generatorVersion alone does not name the code. Absent from older series. */
    generatorDirty?: boolean | null;
    /** What every task's container runs; each task also carries it. */
    agent?: { startupCommand?: string; deadlineMinutes?: number };
    /** Every scenario staging the series drew from; paths relative to the repository root. */
    scenarios?: StagedScenario[];
    /** Candidate seeds the scenario runner refused, with its reason. */
    failedStagings?: { id: string; seed: number; base: string; reason: string }[];
  };
  outcomes: FamilyOutcome[];
  tasks: KierstonBenchTask[];
  /** The registers the tasks are scored against, as they were when the series was built. Absent from older series. */
  truth?: TruthSnapshot;
}

/** Where a build stands: reading base days, then staging kdiffs. */
export interface SeriesProgress {
  phase: "days" | "scenarios";
  /** Days read, or kdiffs staged. */
  done: number;
  total: number;
  /** Scenarios only: seeds the runner refused, and kdiffs a day gave up on after its attempts ran out. */
  refused: number;
  short: number;
  /** The day, or the scenario, seed and day, being worked on. */
  current: string;
  /** The scenario runner's latest status line for the current kdiff. */
  step?: string;
}

export interface BuildOptions {
  log?: (line: string) => void;
  progress?: (progress: SeriesProgress) => void;
}

export async function buildRunSeries(config: RunSeriesConfig, options: BuildOptions = {}): Promise<RunSeriesData> {
  const log = options.log ?? (() => {});
  const progress = options.progress ?? (() => {});
  const tasks: KierstonBenchTask[] = [];
  const outcomes: FamilyOutcome[] = [];
  const days: { file: string; date: string }[] = [];
  const families = GENERATORS.map((generator) => generator.family).filter((family) => config.copies.has(family));

  const plain = families.filter((family) => generatorByFamily.get(family)!.eventKind === undefined);
  for (const [index, dayFile] of config.days.entries()) {
    progress({ phase: "days", done: index, total: config.days.length, refused: 0, short: 0, current: dayLabel(dayFile) });
    const ctx = await openContext({ dayFile, simDataDir: config.simData });
    try {
      days.push({ file: basename(dayFile), date: ctx.date });
      log(`${ctx.date}: ${basename(dayFile)}`);
      for (const family of plain) outcomes.push(await fill(ctx, family));
    } finally {
      await ctx.day.close();
    }
  }

  // Scenario days: each staging is its base day read with the staging's delta
  // applied in memory, and only the families that read that staging's event
  // are generated from it.
  const staged: StagedScenario[] = [];
  const failedStagings: { id: string; seed: number; base: string; reason: string }[] = [];
  const scenarioTotal = config.scenarios.reduce((sum, plan) => sum + (plan.wanted ?? plan.seeds.length) * plan.days.length, 0);
  let short = 0;
  for (const plan of config.scenarios) {
    for (const dayFile of plan.days) {
      let produced = 0;
      for (const seed of plan.seeds) {
        if (plan.wanted !== undefined && produced >= plan.wanted) break;
        const report = (step?: string) => progress({ phase: "scenarios", done: staged.length, total: scenarioTotal,
          refused: failedStagings.length, short, current: `${plan.id} seed ${seed} on ${dayLabel(dayFile)}`, ...(step ? { step } : {}) });
        report();
        let delta: string;
        try {
          delta = await stageDelta(plan, dayFile, seed, config.scenarioDir, log, report);
        } catch (error) {
          // A refused seed is cheap and expected on a real day; only an
          // explicit seed list promises every seed.
          if (plan.wanted === undefined) throw error;
          const reason = (error as Error).message;
          failedStagings.push({ id: plan.id, seed, base: relative(REPO_ROOT, dayFile), reason });
          log(`  ${plan.id} seed ${seed} refused: ${reason}`);
          continue;
        }
        const ctx = await openContext({ dayFile, deltaFile: delta, simDataDir: config.simData });
        try {
          const header = ctx.day.meta.scenario;
          if (!header) throw new Error(`${relative(REPO_ROOT, delta)} carries no scenario header`);
          const staging: StagedScenario = { id: plan.id, name: header.name, seed, date: ctx.date,
            base: relative(REPO_ROOT, dayFile), delta: relative(REPO_ROOT, delta) };
          staged.push(staging);
          produced += 1;
          log(`${ctx.date}: ${plan.id} seed ${seed} (${basename(delta)})`);
          for (const family of plan.families) {
            outcomes.push(await fill(ctx, family, staging));
          }
        } finally {
          await ctx.day.close();
        }
      }
      if (plan.wanted !== undefined && produced < plan.wanted) {
        short += plan.wanted - produced;
        log(`  ${plan.id} on ${basename(dayFile)}: ${produced}/${plan.wanted} stagings (short by ${plan.wanted - produced})`);
      }
    }
  }

  async function fill(ctx: TaskContext, family: string, staging?: StagedScenario): Promise<FamilyOutcome> {
    const generator = generatorByFamily.get(family)!;
    const requested = config.copies.get(family)!;
    const seen = new Set<string>();
    const outcome: FamilyOutcome = { family, date: ctx.date,
      ...(staging ? { scenario: { id: staging.id, seed: staging.seed } } : {}), requested, produced: 0, rejected: [] };
    const attempts = requested * config.attemptsPerCopy;
    const salt = staging ? `${family}@${staging.id}#${staging.seed}` : family;
    for (let attempt = 0; attempt < attempts && outcome.produced < requested; attempt += 1) {
      const seed = taskSeed(config.seed, ctx.date, salt, attempt);
      try {
        const task = await generator.generate(ctx, new Rng(seed ^ fnv1a(family)), seed);
        const key = JSON.stringify(task.evidence);
        if (seen.has(key)) {
          outcome.rejected.push({ seed, reason: "duplicate of an earlier copy" });
          continue;
        }
        seen.add(key);
        tasks.push({
          ...task,
          ...(staging ? { scenario: { name: staging.name, seed: staging.seed, delta: staging.delta, base: staging.base } } : {}),
          ...(config.startupCommand === undefined ? {} : { startupCommand: config.startupCommand }),
        });
        outcome.produced += 1;
      } catch (error) {
        outcome.rejected.push({ seed, reason: (error as Error).message });
      }
    }
    const note = outcome.produced < requested ? ` (short by ${requested - outcome.produced})` : "";
    log(`  ${family}: ${outcome.produced}/${requested}${note}`);
    return outcome;
  }

  return {
    series: {
      id: config.id,
      createdAt: new Date().toISOString(),
      seed: config.seed,
      days,
      families,
      taskCount: tasks.length,
      config: config.raw,
      generatorVersion: await generatorVersion(),
      generatorDirty: await workingTreeDirty(),
      ...(config.startupCommand !== undefined || config.deadlineMinutes !== undefined
        ? { agent: { ...(config.startupCommand !== undefined ? { startupCommand: config.startupCommand } : {}), ...(config.deadlineMinutes !== undefined ? { deadlineMinutes: config.deadlineMinutes } : {}) } }
        : {}),
      ...(staged.length ? { scenarios: staged } : {}),
      ...(failedStagings.length ? { failedStagings } : {}),
    },
    outcomes,
    tasks,
    truth: await takeTruthSnapshot(config.simData),
  };
}

function dayLabel(dayFile: string): string {
  return basename(dayFile).replace(/^day_|\.bin$/g, "");
}

/** The series file's text: indented for reading, with the truth snapshot on one line at the end. */
export function seriesText(data: RunSeriesData): string {
  const { truth, ...rest } = data;
  const text = JSON.stringify(rest, null, 2);
  return (truth ? `${text.slice(0, -2)},\n  "truth": ${JSON.stringify(truth)}\n}` : text) + "\n";
}

export function outputPath(config: RunSeriesConfig): string {
  return `${config.outputDir}/run_series_${config.id}_tasks_data.json`;
}

/**
 * One seed per (series seed, day, family, attempt), so a series reproduces
 * from its config and the seed embedded in each task id reproduces the task
 * on its own through the task-generators CLI.
 */
function taskSeed(seriesSeed: number, date: string, family: string, attempt: number): number {
  return fnv1a(`${seriesSeed}|${date}|${family}|${attempt}`);
}


function fnv1a(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  }
  return value >>> 0;
}

/** Uncommitted changes to tracked files when the series was built; null when git cannot say. */
async function workingTreeDirty(): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text.trim() !== "" : null;
  } catch {
    return null;
  }
}

/** The commit the generators were run at, so a series file names its code. */
async function generatorVersion(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && text ? text : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Staging a scenario for a series: run the script against a base day and
 * write its delta. The delta is never merged into a standalone day — the
 * generators read base + `.kdiff` in memory, and the event store ingests the
 * same pair.
 *
 * The scenario runner needs the city assets and the engine, so it runs as
 * the scenarios CLI in its own process rather than in the prep's; a delta
 * that already exists on disk is reused, because a series is deterministic
 * in (script, base day, seed) and a crowd scenario takes minutes to replay.
 */

import { basename, join } from "node:path";
import { REPO_ROOT, type ScenarioPlan } from "./config.ts";
import { eachLine } from "./lines.ts";
import { STEP_MARK } from "../../../kierston_scenarios/src/step-mark.ts";

export interface StagedScenario {
  id: string;
  /** The scenario's own name, from its header. */
  name: string;
  seed: number;
  date: string;
  /** Repository-relative paths. */
  base: string;
  delta: string;
}

const CLI = join(REPO_ROOT, "kierston_scenarios/src/cli.ts");

/** The staging's `.kdiff`, absolute: created unless it is already on disk. */
export async function stageDelta(
  plan: ScenarioPlan, baseDay: string, seed: number, directory: string, log: (line: string) => void,
  status: (line: string) => void = () => {},
): Promise<string> {
  const stem = `${plan.id}_${basename(baseDay).replace(/^day_/, "").replace(/\.bin$/, "")}_${seed}`;
  const delta = join(directory, `${stem}.kdiff`);
  if (await Bun.file(delta).exists()) {
    log(`reusing ${basename(delta)}`);
    return delta;
  }
  log(`staging ${plan.id} seed ${seed} against ${basename(baseDay)}`);
  const proc = Bun.spawn(["bun", "run", CLI, "create", "--scenario", plan.script, "--input", baseDay, "--seed", String(seed),
    "--output", delta, "--max-affected", String(plan.maxAffected)], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  // The runner marks each step on stderr; pass them on as they come, so a
  // replay that takes minutes shows where it is. Everything else on that
  // stream (engine warnings, debug dumps) is log, not a step.
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(),
    eachLine(proc.stderr, (line) => (line.startsWith(STEP_MARK) ? status(line.slice(STEP_MARK.length)) : log(`  ${line.trim()}`)))]);
  if ((await proc.exited) !== 0) {
    throw new Error(`scenarios create failed: ${stderr.trim().split("\n").slice(-3).join(" | ") || stdout.trim()}`);
  }
  return delta;
}

/**
 * The contract a family's generator implements, plus the sampling helpers
 * they share. A generator owns three decisions: which target is eligible,
 * what evidence the prompt may quote (observable records only — identifiers,
 * timestamps, venue names — never the truth-side tables it records the
 * answer from), and how the answer is scored.
 */

import type { TaskContext } from "./context.ts";
import type { KierstonBenchTask } from "./task.ts";
import type { Rng } from "./rng.ts";

export interface TaskGenerator {
  family: string;
  /**
   * Set on an RTI family: the kind of staged event the generator reads
   * its truth from. Such a family runs only on a scenario day (base + .kdiff) that
   * records that event, never on a plain base day.
   */
  eventKind?: string;
  /** One task, reproducible from (day file, seed). */
  generate(ctx: TaskContext, rng: Rng, seed: number): Promise<KierstonBenchTask>;
}

export function taskId(family: string, date: string, seed: number): string {
  return `${family}:${date}:${seed}`;
}

/**
 * Draw a row index until the family's eligibility rule accepts one.
 * Bounded, so a day that cannot satisfy a rule fails loudly instead of
 * spinning — the caller should treat the throw as "skip this family today".
 */
export function drawIndex(
  rng: Rng,
  count: number,
  eligible: (index: number) => boolean,
  attempts = 1000,
): number {
  if (count === 0) throw new Error("no rows to draw from");
  for (let i = 0; i < attempts; i += 1) {
    const index = rng.int(count);
    if (eligible(index)) return index;
  }
  throw new Error("no eligible target found; the day may not support this family");
}

/** Coordinates as quoted in evidence: ~100 m, so a prompt is not a lookup key. */
export function roundedCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The shared investigation context handed to every agent. The text itself
 * lives in kierston_bench/model_visible_text.ts with every other model-visible
 * string; this module only composes it.
 */
import { ADI_GUIDE, CONTEXT, DATA_GUIDE, deadlineNote } from "../../model_visible_text.ts";

export { deadlineNote };
export const KDI_AGENT_GUIDE = ADI_GUIDE;
export const KDI_DATA_GUIDE = DATA_GUIDE;
export const BENCH_CONTEXT = CONTEXT;

/** BENCH_CONTEXT, with the time allowance when the run sets one. */
export function benchContext(deadlineMs?: number): string {
  return deadlineMs && deadlineMs > 0 ? `${BENCH_CONTEXT}\n\n${deadlineNote(deadlineMs)}` : BENCH_CONTEXT;
}

/**
 * The benchmark's task families, one generator each, in three groups: the
 * Technical Tasks that read a plain observed day, the Real-Time
 * Investigations that read a day a scenario was staged into, and the
 * Deception Tasks that read a staged day with a story attached. `groups.ts`
 * is the hierarchy; this is the flat registry a CLI or series config
 * looks a family up in.
 */

import { TASK_GROUPS } from "./groups.ts";

export const GENERATORS = TASK_GROUPS.flatMap((group) => group.generators);

export const generatorByFamily = new Map(GENERATORS.map((generator) => [generator.family, generator]));

export { TASK_GROUPS, taskGroupById, taskGroupOf } from "./groups.ts";
export type { TaskGroup, TaskGroupId } from "./groups.ts";
export { TECHNICAL_GENERATORS } from "./generators/technical/index.ts";
export { RTI_GENERATORS } from "./generators/rti/index.ts";
export { DT_GENERATORS } from "./generators/dt/index.ts";
/** Every family that reads a staged scenario day rather than a plain one, whichever group it is in. */
export const STAGED_GENERATORS = GENERATORS.filter((generator) => generator.eventKind !== undefined);
export type { TaskGenerator } from "./generator.ts";
export type { KierstonBenchTask, AnswerSpec, ScoringSpec } from "./task.ts";
export { openContext, TaskContext } from "./context.ts";
export type { ScenarioHeader, ScenarioEvent } from "./kday.ts";
export { cityInstant, scenarioHeader, eventOfKind } from "./generators/rti/scenario.ts";
export { Rng } from "./rng.ts";

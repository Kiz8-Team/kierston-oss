/**
 * The task hierarchy: families belong to groups. A group is the kind of
 * day its families read and the kind of question they ask; a family is one
 * question with one generator and one scorer.
 *
 *   technical  Technical Tasks (TTs) — a plain observed day, one narrow
 *              question about its records
 *   rti        Real-Time Investigations (RTIs) — a staged incident, worked
 *              as it stands minutes after, against a cutoff
 *   dt         Deception Tasks (DTs) — a staged incident with a story
 *              attached, which the records contradict or confirm
 *
 * Membership is what the group's directory index lists; nothing else
 * decides it, so adding a family to a group is adding it to that list.
 */

import type { TaskGenerator } from "./generator.ts";
import { TECHNICAL_GENERATORS } from "./generators/technical/index.ts";
import { RTI_GENERATORS } from "./generators/rti/index.ts";
import { DT_GENERATORS } from "./generators/dt/index.ts";

export type TaskGroupId = "technical" | "rti" | "dt";

export interface TaskGroup {
  id: TaskGroupId;
  /** The short form the benchmark goes by in reports and the TUI. */
  abbreviation: "TT" | "RTI" | "DT";
  label: string;
  /** One line a report can print above the group's families. */
  description: string;
  /** Where the family's generator lives, relative to `src/`. */
  directory: string;
  generators: readonly TaskGenerator[];
}

export const TASK_GROUPS: readonly TaskGroup[] = [
  {
    id: "technical",
    abbreviation: "TT",
    label: "Technical Tasks",
    description: "One narrow question about the records of a plain observed day.",
    directory: "generators/technical",
    generators: TECHNICAL_GENERATORS,
  },
  {
    id: "rti",
    abbreviation: "RTI",
    label: "Real-Time Investigations",
    description: "A staged incident, investigated minutes after against records that stop at the cutoff.",
    directory: "generators/rti",
    generators: RTI_GENERATORS,
  },
  {
    id: "dt",
    abbreviation: "DT",
    label: "Deception Tasks",
    description: "A staged incident with a story attached; the records contradict it, and only the records count.",
    directory: "generators/dt",
    generators: DT_GENERATORS,
  },
];

export const taskGroupById = new Map(TASK_GROUPS.map((group) => [group.id, group]));

const groupByFamily = new Map<string, TaskGroup>();
for (const group of TASK_GROUPS) {
  for (const generator of group.generators) {
    if (groupByFamily.has(generator.family)) throw new Error(`family ${generator.family} is listed in two task groups`);
    groupByFamily.set(generator.family, group);
  }
}

/** The group a family belongs to; unknown (retired) families are not in any. */
export function taskGroupOf(family: string): TaskGroup | undefined {
  return groupByFamily.get(family);
}

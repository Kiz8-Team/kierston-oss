/** Build the interactive run selection from the tasks that actually exist in a series. */

import type { RunSeriesData } from "../../run_series_prep/src/series.ts";
import { TASK_GROUPS, taskGroupOf } from "../../task_generators/src/index.ts";

export interface FamilyChoice {
  family: string;
  /** The task group's short name (TT, RTI), or "" for a retired family. */
  group: string;
  taskIds: string[];
  /** How many of this family's existing tasks will be included. */
  copies: number;
}

export async function loadFamilyChoices(seriesFile: string): Promise<FamilyChoice[]> {
  const data = (await Bun.file(seriesFile).json()) as RunSeriesData;
  const choices = new Map<string, FamilyChoice>();
  for (const task of data.tasks ?? []) {
    let choice = choices.get(task.family);
    if (!choice) {
      choice = { family: task.family, group: taskGroupOf(task.family)?.abbreviation ?? "", taskIds: [], copies: 0 };
      choices.set(task.family, choice);
    }
    choice.taskIds.push(task.id);
    choice.copies += 1;
  }
  // Grouped as the hierarchy is, technical tasks first; series order within a group.
  const rank = new Map<string, number>(TASK_GROUPS.map((group, index) => [group.abbreviation, index]));
  return [...choices.values()].sort((a, b) => (rank.get(a.group) ?? TASK_GROUPS.length) - (rank.get(b.group) ?? TASK_GROUPS.length));
}

export function selectedTaskIds(choices: readonly FamilyChoice[]): string[] {
  return choices.flatMap((choice) => choice.taskIds.slice(0, choice.copies));
}

export function selectedTaskCount(choices: readonly FamilyChoice[]): number {
  return choices.reduce((total, choice) => total + choice.copies, 0);
}

export function selectionSummary(choices: readonly FamilyChoice[]): string {
  const tasks = selectedTaskCount(choices);
  const families = choices.filter((choice) => choice.copies > 0).length;
  return `${tasks} task${tasks === 1 ? "" : "s"} from ${families} famil${families === 1 ? "y" : "ies"}`;
}

/** Family slug words that read as acronyms, not capitalised words. */
const LABEL_WORDS: Record<string, string> = { id: "ID", reid: "ReID" };

export function familyLabel(family: string): string {
  return family
    .split("-")
    .filter(Boolean)
    .map((word) => LABEL_WORDS[word] ?? word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Set every family to the same number of copies. A family with fewer tasks than
 * that takes all it has, so one number can stand for "N of each" without the
 * short families quietly failing the request; the count of those is returned so
 * the caller can say so.
 */
export function setAllCopies(choices: readonly FamilyChoice[], copies: number): { short: number } {
  const want = Math.max(0, Math.trunc(copies));
  let short = 0;
  for (const choice of choices) {
    if (want > choice.taskIds.length) short += 1;
    choice.copies = Math.min(want, choice.taskIds.length);
  }
  return { short };
}

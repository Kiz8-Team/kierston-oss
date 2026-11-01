/**
 * "Which residents share this person's household?"
 *
 * The truth is household membership from the population register. The target
 * must live with at least one other person — a household of one has nothing
 * to reconstruct.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";

export const householdRecon: TaskGenerator = {
  family: "household-recon",

  async generate(ctx, rng, seed) {
    const population = await ctx.world.population();
    const people = population.person_records;
    const byHousehold = new Map<number, number[]>();
    for (const person of people) {
      const members = byHousehold.get(person.household);
      if (members) members.push(person.id);
      else byHousehold.set(person.household, [person.id]);
    }

    const index = drawIndex(rng, people.length, (i) => {
      return (byHousehold.get(people[i]!.household)?.length ?? 0) >= 2;
    });
    const person = people[index]!;
    const cohabitants = byHousehold.get(person.household)!
      .filter((id) => id !== person.id)
      .sort((a, b) => a - b);

    const subjectSsn = await ctx.world.personSsn(person.id);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `Which residents share a household with the person with SSN ${subjectSsn}?`,
        `Answer with the set of person identities, excluding the person with SSN ${subjectSsn} themself.`,
      ].join("\n"),
      evidence: { ssn: subjectSsn },
      answer: {
        kind: "id-set", identifier: "person",
        description: "person identities of everyone sharing the target's household.",
      },
      groundTruth: { cohabitants, household: person.household },
      scoring: {
        method: "set-f1",
        aggregate: "mean pairwise precision/recall/F1",
      },
    };
  },
};

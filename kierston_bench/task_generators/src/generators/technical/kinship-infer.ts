/**
 * "Who is this person's mother / father / partner / sibling / child?"
 *
 * The truth is the kinship register. One relation is drawn per task, and it
 * must have at least one in-city answer — a parent living elsewhere is a
 * real fact but not a resolvable one. Relations with several true answers
 * (siblings, children) accept any of them at full credit.
 *
 * Siblings are found through every parent id the register carries, in the
 * city or not: two residents whose only shared parent lives elsewhere are
 * still siblings, and leaving them out of the truth would mark a right
 * answer wrong.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import type { Rng } from "../../rng.ts";

type Relation = "mother" | "father" | "partner" | "sibling" | "child";

export const kinshipInfer: TaskGenerator = {
  family: "kinship-infer",

  async generate(ctx, rng: Rng, seed) {
    const kinship = await ctx.world.kinship();
    const base = kinship.external_base;
    const inCity = (id: number): boolean => id < base;

    // Forward and reverse indexes over the register. Out-of-city parents are
    // indexed too: they are never an answer, but they link siblings.
    const parentsOf = kinship.parents;
    const childrenOf = new Map<number, number[]>();
    for (const [child, parents] of Object.entries(parentsOf)) {
      for (const parent of parents) {
        const children = childrenOf.get(parent.id);
        if (children) children.push(Number(child));
        else childrenOf.set(parent.id, [Number(child)]);
      }
    }
    const partnerOf = new Map<number, number>();
    for (const [a, b] of kinship.partners) {
      partnerOf.set(a, b);
      partnerOf.set(b, a);
    }
    const siblingsOf = (person: number): number[] => {
      const own = parentsOf[String(person)] ?? [];
      const found = new Set<number>();
      for (const parent of own) {
        for (const child of childrenOf.get(parent.id) ?? []) {
          if (child !== person) found.add(child);
        }
      }
      return [...found];
    };

    const candidates = Object.keys(parentsOf);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const person = Number(rng.pick(candidates));
      const options: { relation: Relation; answers: number[] }[] = [];
      const own = parentsOf[String(person)] ?? [];
      const mothers = own.filter((p) => p.role === "mother" && inCity(p.id)).map((p) => p.id);
      const fathers = own.filter((p) => p.role === "father" && inCity(p.id)).map((p) => p.id);
      if (mothers.length > 0) options.push({ relation: "mother", answers: mothers });
      if (fathers.length > 0) options.push({ relation: "father", answers: fathers });
      const partner = partnerOf.get(person);
      if (partner !== undefined && inCity(partner)) options.push({ relation: "partner", answers: [partner] });
      const siblings = siblingsOf(person).filter(inCity);
      if (siblings.length > 0) options.push({ relation: "sibling", answers: siblings });
      const children = (childrenOf.get(person) ?? []).filter(inCity);
      if (children.length > 0) options.push({ relation: "child", answers: children });
      if (options.length === 0) continue;

      const chosen = rng.pick(options);
      const subjectSsn = await ctx.world.personSsn(person);

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        prompt: [
          `Who is the ${chosen.relation} of the person with SSN ${subjectSsn}?`,
          `Answer with a ranked list of person identities, most likely first. Any true ${chosen.relation} counts.`,
        ].join("\n"),
        evidence: { ssn: subjectSsn, relation: chosen.relation },
        answer: {
          kind: "ranked-ids", identifier: "person",
          description: `person identities of the target's ${chosen.relation}, best first.`,
        },
        groundTruth: { relation: chosen.relation, answers: chosen.answers.sort((a, b) => a - b) },
        scoring: {
          method: "rank",
          params: { anyOf: true },
          aggregate: "mrr per relation label; relation macro-F1 across labels",
        },
      };
    }
    throw new Error("no resolvable kinship relation found");
  },
};

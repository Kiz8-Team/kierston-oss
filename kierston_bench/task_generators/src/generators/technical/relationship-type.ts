/**
 * "Are A and B partners, colleagues, classmates, relatives, neighbours...?"
 *
 * The truth is the tie graph's kind column — every edge between the pair,
 * because two people can be neighbours and colleagues at once, which is why
 * the answer is a label set. Only pairs with a meaningful tie are drawn
 * (affinity above noise, both in the city), and only pairs whose every tie is
 * one of TASK_KINDS: the rest (ex_colleague, clubmate, congregant, kin_ext,
 * elsewhere, ...) leave no record an agent can distinguish them by.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import type { Rng } from "../../rng.ts";

const TASK_KINDS = [
  "parent",
  "child",
  "household",
  "sibling",
  "partner",
  "grandparent",
  "colleague",
  "classmate",
  "neighbour",
] as const;

export const relationshipType: TaskGenerator = {
  family: "relationship-type",

  async generate(ctx, rng: Rng, seed) {
    const ties = await ctx.world.ties();
    const allowed = new Set<number>();
    for (const kind of TASK_KINDS) {
      const code = ties.kinds.indexOf(kind);
      if (code < 0) throw new Error(`tie kind ${kind} missing from ties.bin`);
      allowed.add(code);
    }

    attempts: for (let attempt = 0; attempt < 1000; attempt += 1) {
      const edge = rng.int(ties.count);
      const a = ties.a[edge]!;
      const b = ties.b[edge]!;
      if (a >= ties.externalBase || b >= ties.externalBase) continue;
      if (ties.affinity[edge]! < 32) continue;
      if (!allowed.has(ties.kind[edge]!)) continue;

      // Every kind between this pair, not just the drawn edge's.
      const kinds = new Set<string>();
      for (let other = 0; other < ties.count; other += 1) {
        const sameForward = ties.a[other]! === a && ties.b[other]! === b;
        const sameReverse = ties.a[other]! === b && ties.b[other]! === a;
        if (!sameForward && !sameReverse) continue;
        if (!allowed.has(ties.kind[other]!)) continue attempts;
        kinds.add(ties.kinds[ties.kind[other]!]!);
      }

      const ssnA = await ctx.world.personSsn(a);
      const ssnB = await ctx.world.personSsn(b);

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        prompt: [
          `What is the relationship between the person with SSN ${ssnA} and the person with SSN ${ssnB}?`,
          `Answer with one or more labels from: ${TASK_KINDS.join(", ")}.`,
        ].join("\n"),
        evidence: { ssnA, ssnB },
        answer: {
          kind: "label-set",
          description: "Every kind of tie between the pair.",
          labels: [...TASK_KINDS],
        },
        groundTruth: { kinds: [...kinds].sort() },
        scoring: {
          method: "set-f1",
          aggregate: "multi-label macro-F1 over tie kinds",
        },
      };
    }
    throw new Error("no eligible tie found");
  },
};

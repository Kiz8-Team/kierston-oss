/**
 * "Who carries this subscription?"
 *
 * Carrier records carry identifiers, not identity, so the mapping from an
 * IMSI to a resident is genuinely inferential: nighttime serving cells,
 * contact structure, movement. The subscriber must have produced enough
 * network events this day to be resolvable at all.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";

export const deviceToPerson: TaskGenerator = {
  family: "device-to-person",

  async generate(ctx, rng, seed) {
    const sub = await ctx.day.columns(
      "subscriber.person", "subscriber.imsi", "subscriber.msisdn", "subscriber.carrier",
    );
    const events = await ctx.eventCountBySubscriber();

    const row = drawIndex(
      rng, sub.person.length,
      (index) => (events.get(index) ?? 0) >= 3,
    );

    const imsi = ctx.day.string(sub.imsi[row]!);
    const msisdn = ctx.day.string(sub.msisdn[row]!);
    const carrier = ctx.day.string(sub.carrier[row]!);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A mobile subscription was active in the city on ${ctx.date}:`,
        `IMSI ${imsi}, MSISDN ${msisdn}, carrier ${carrier}.`,
        `Which resident carries this subscription?`,
        `Answer with a ranked list of person identities, most likely first.`,
      ].join("\n"),
      evidence: { imsi, msisdn, carrier },
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities of the likely carrier of the handset, best first.",
      },
      groundTruth: { person: sub.person[row]! },
      scoring: {
        method: "rank",
        aggregate: "mrr; also report top-1 accuracy",
      },
    };
  },
};

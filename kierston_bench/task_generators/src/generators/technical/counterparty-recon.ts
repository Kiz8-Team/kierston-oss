/**
 * "Who was the other party to this carrier record?"
 *
 * One CDR row, quoted from the calling side, both ends on-net. The
 * counterparty's number is in the record — a real CDR names it — so the
 * inferential step being scored is the resolution of that identifier to a
 * resident, from the callee's side of the network.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clockSeconds } from "../../format.ts";

export const counterpartyRecon: TaskGenerator = {
  family: "counterparty-recon",

  async generate(ctx, rng, seed) {
    const cdr = await ctx.day.columns("cdr.call", "cdr.from", "cdr.to");
    const calls = await ctx.day.columns("call.at", "call.duration", "call.outcome");
    const sub = await ctx.day.columns("subscriber.person", "subscriber.msisdn");
    const outcomes = ctx.day.enumValues("callOutcome");

    const index = drawIndex(
      rng, cdr.call.length,
      (i) => (cdr.from[i]! | 0) >= 0 && (cdr.to[i]! | 0) >= 0,
    );
    const call = cdr.call[index]!;
    const fromRow = cdr.from[index]! | 0;
    const toRow = cdr.to[index]! | 0;

    const record = {
      callerMsisdn: ctx.day.string(sub.msisdn[fromRow]!),
      calleeMsisdn: ctx.day.string(sub.msisdn[toRow]!),
      placedAt: clockSeconds(calls.at[call]!),
      durationSeconds: calls.duration[call]!,
      outcome: outcomes[calls.outcome[call]!],
    };

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A carrier holds this call record from ${ctx.date}:`,
        JSON.stringify(record, null, 2),
        `Which resident was the other party — the person behind the called number?`,
        `Answer with a ranked list of person identities, most likely first.`,
      ].join("\n"),
      evidence: { record },
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities of the likely called party, best first.",
      },
      groundTruth: { person: sub.person[toRow]! },
      scoring: {
        method: "rank",
        aggregate: "mrr; recall@5 as a secondary",
      },
    };
  },
};

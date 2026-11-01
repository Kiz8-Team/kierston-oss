/**
 * "Who paid for this group outing?"
 *
 * The truth is the gathering's payer column, set only where somebody picked
 * up the bill for the party — the -1 everybody-paid-for-themselves case is
 * excluded by eligibility, not scored around.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clock, degrees } from "../../format.ts";

export const payerInfer: TaskGenerator = {
  family: "payer-infer",

  async generate(ctx, rng, seed) {
    const meetings = await ctx.day.columns(
      "meeting.venue", "meeting.latE6", "meeting.lonE6", "meeting.start", "meeting.end",
      "meeting.payer", "meeting.partyCount",
    );

    const index = drawIndex(
      rng, meetings.start.length,
      (i) => (meetings.payer[i]! | 0) >= 0 && meetings.partyCount[i]! >= 2,
    );

    const venue = await ctx.world.placeName(ctx.day.string(meetings.venue[index]!));

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A group gathered at venue ${venue} (${degrees(meetings.latE6[index]!)}, ${degrees(meetings.lonE6[index]!)}) from ${clock(meetings.start[index]!)} to ${clock(meetings.end[index]!)} on ${ctx.date}, and one person paid for the outing.`,
        `Who paid? Answer with a ranked list of person identities, most likely first.`,
      ].join("\n"),
      evidence: {
        venue,
        lat: degrees(meetings.latE6[index]!),
        lon: degrees(meetings.lonE6[index]!),
        from: clock(meetings.start[index]!),
        to: clock(meetings.end[index]!),
      },
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities of the likely payer, best first.",
      },
      groundTruth: { payer: meetings.payer[index]! | 0 },
      scoring: {
        method: "rank",
        aggregate: "top-1 accuracy; mrr as a secondary",
      },
    };
  },
};

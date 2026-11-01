/**
 * "Which resident controls this messaging account?"
 *
 * Two regimes, tagged so results can be reported separately: an account
 * anchored to a subscription (its handle is a phone number, or it was
 * registered against one) and a handle-only account whose resolution has to
 * come from behaviour. Display names are withheld — they are the answer
 * written down.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";

export const accountResolution: TaskGenerator = {
  family: "account-resolution",

  async generate(ctx, rng, seed) {
    const account = await ctx.day.columns(
      "account.person", "account.channel", "account.handle", "account.subscriber",
    );
    const channels = ctx.day.enumValues("channel");
    const sent = await ctx.messageCountByAccount();

    const row = drawIndex(
      rng, account.person.length,
      (index) => channels[account.channel[index]!] !== "sms" && (sent.get(index) ?? 0) >= 2,
    );

    const channel = channels[account.channel[row]!]!;
    const handle = ctx.day.string(account.handle[row]!);
    const anchored = (account.subscriber[row]! | 0) >= 0;

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A ${channel} account with handle "${handle}" was active on ${ctx.date}.`,
        `Which resident controls this account?`,
        `Answer with a ranked list of person identities, most likely first.`,
      ].join("\n"),
      // The variant is a truth-side fact — whether the account is anchored to
      // a subscription the carrier can be asked about — so it stratifies the
      // score but is never quoted to the agent.
      evidence: { channel, handle },
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities of the likely account holder, best first.",
      },
      groundTruth: { person: account.person[row]! },
      scoring: {
        method: "rank",
        params: { variant: anchored ? "phone-anchored" : "handle-only" },
        aggregate: "mrr and top-1, reported separately per variant",
      },
    };
  },
};

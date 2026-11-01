/**
 * "Is this thread family, work, organization, broadcast, or an ad-hoc dyad?"
 *
 * The truth is the conversation table's kind and focus columns. The thread
 * is named by its stable external id and channel; it must have carried
 * enough traffic today to be classifiable from behaviour.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clockSeconds } from "../../format.ts";

export const conversationClassif: TaskGenerator = {
  family: "conversation-classif",

  async generate(ctx, rng, seed) {
    const conv = await ctx.day.columns(
      "conversation.channel", "conversation.kind", "conversation.focus",
      "conversation.externalId", "conversation.count",
    );
    const message = await ctx.day.columns("message.conversation", "message.at");
    const channels = ctx.day.enumValues("channel");
    const kinds = ctx.day.enumValues("conversationKind");
    const foci = ctx.day.enumValues("conversationFocus");

    const traffic = new Map<number, { count: number; first: number; last: number }>();
    for (let i = 0; i < message.conversation.length; i += 1) {
      const thread = message.conversation[i]!;
      const at = message.at[i]!;
      const entry = traffic.get(thread);
      if (entry) {
        entry.count += 1;
        entry.first = Math.min(entry.first, at);
        entry.last = Math.max(entry.last, at);
      } else {
        traffic.set(thread, { count: 1, first: at, last: at });
      }
    }

    const index = drawIndex(
      rng, conv.kind.length,
      (i) => (traffic.get(i)?.count ?? 0) >= 4 && (conv.focus[i]! | 0) >= 0,
    );
    const seen = traffic.get(index)!;
    const externalId = ctx.day.string(conv.externalId[index]!);
    const channel = channels[conv.channel[index]!]!;

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A ${channel} conversation with thread id "${externalId}" carried ${seen.count} messages between ${clockSeconds(seen.first)} and ${clockSeconds(seen.last)} on ${ctx.date}, among ${conv.count[index]!} participants.`,
        `Classify the thread: what kind of conversation is it, and around what shared focus does it exist?`,
        `Kind is one of: ${kinds.join(", ")}. Focus is one of: ${foci.join(", ")}.`,
      ].join("\n"),
      evidence: {
        channel,
        externalId,
        messagesToday: seen.count,
        participants: conv.count[index]!,
        window: { from: clockSeconds(seen.first), to: clockSeconds(seen.last) },
      },
      answer: {
        kind: "record",
        description: "The thread's classification.",
        fields: {
          kind: { kind: "label", description: "Conversation kind.", labels: kinds },
          focus: { kind: "label", description: "Shared focus.", labels: foci },
        },
      },
      groundTruth: {
        kind: kinds[conv.kind[index]!]!,
        focus: foci[conv.focus[index]!]!,
      },
      scoring: {
        method: "record",
        params: { fields: { kind: "top1", focus: "top1" } },
        aggregate: "macro-F1 per field",
      },
    };
  },
};

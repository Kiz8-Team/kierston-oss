/**
 * "Who met at venue X between 19:00 and 21:00?"
 *
 * The truth is the gatherings table: attendees and the exact window. The
 * quoted window is widened to whole hours so the prompt does not hand back
 * the precise interval it asks for.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clock, degrees } from "../../format.ts";

export const meetingRecon: TaskGenerator = {
  family: "meeting-recon",

  async generate(ctx, rng, seed) {
    const meetings = await ctx.day.columns(
      "meeting.venue", "meeting.latE6", "meeting.lonE6", "meeting.start", "meeting.end",
      "meeting.partyOffset", "meeting.partyCount",
    );
    const party = await ctx.day.column("party.person");

    const index = drawIndex(rng, meetings.start.length, (i) => meetings.partyCount[i]! >= 2);
    const attendees: number[] = [];
    const from = meetings.partyOffset[index]!;
    for (let i = from; i < from + meetings.partyCount[index]!; i += 1) attendees.push(party[i]!);

    const venue = await ctx.world.placeName(ctx.day.string(meetings.venue[index]!));
    const windowStart = Math.floor(meetings.start[index]! / 60) * 60;
    const windowEnd = Math.ceil(meetings.end[index]! / 60) * 60;

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A gathering took place at venue ${venue} (${degrees(meetings.latE6[index]!)}, ${degrees(meetings.lonE6[index]!)}) some time between ${clock(windowStart)} and ${clock(windowEnd)} on ${ctx.date}.`,
        `Who attended, and over exactly what interval?`,
        `Answer with the set of person identities and the start/end times (HH:MM).`,
      ].join("\n"),
      evidence: {
        venue,
        lat: degrees(meetings.latE6[index]!),
        lon: degrees(meetings.lonE6[index]!),
        window: { from: clock(windowStart), to: clock(windowEnd) },
      },
      answer: {
        kind: "record",
        description: "The gathering's attendance and interval.",
        fields: {
          participants: { kind: "id-set", identifier: "person", description: "person identities of everyone who attended." },
          interval: { kind: "interval", description: "Start and end as HH:MM-HH:MM; use hours 24+ for the following day." },
        },
      },
      groundTruth: {
        participants: attendees.sort((a, b) => a - b),
        startMinute: meetings.start[index]!,
        endMinute: meetings.end[index]!,
      },
      scoring: {
        method: "record",
        params: { fields: { participants: "set-f1", interval: "interval-iou" } },
        aggregate: "participant F1 and temporal IoU, both means",
      },
    };
  },
};

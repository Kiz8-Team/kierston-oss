/**
 * "A crowd is holding the square. Who is part of it?"
 *
 * The truth is the marchers group from the header, drops removed. The
 * bystanders — everybody the recorded day already had there — are the
 * decoys, and the header names them so a report can say how many there
 * were. The task runs mid-event: the cutoff falls an hour or so in, so the
 * agent sees arrivals but not departures.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import { cityInstant, describePlace, eventOfKind, groupOf, nowAfter, scenarioHeader } from "./scenario.ts";

export const protestMembers: TaskGenerator = {
  family: "protest-members",
  eventKind: "protest",

  async generate(ctx, rng, seed) {
    const event = eventOfKind(ctx, "protest");
    const header = scenarioHeader(ctx);
    const members = groupOf(ctx, "marchers");
    if (members.length < 20) throw new Error(`only ${members.length} marchers remain after the scenario; a set task needs at least 20`);
    const now = nowAfter(rng, event.start, { min: 60, max: 95 });
    const place = await describePlace(ctx, event);
    const where = place.venue ? `${place.venue} (${place.lat}, ${place.lon})` : `(${place.lat}, ${place.lon})`;
    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      kdiPolicy: { cutoff: cityInstant(ctx.date, now, await ctx.world.timeZone()) },
      prompt: [
        `An unpermitted protest has been gathering at ${where} since about ${clock(event.start)} today and is still underway.`,
        `It is now ${clock(now)} on ${ctx.date}.`,
        "Identify the people taking part.",
        "Answer with the set of person identities.",
      ].join("\n"),
      evidence: {
        incident: "protest",
        ...(place.venue ? { venue: place.venue } : {}),
        lat: place.lat,
        lon: place.lon,
        radiusMetres: event.radiusMetres,
        since: clock(event.start),
        now: clock(now),
      },
      answer: {
        kind: "id-set", identifier: "person",
        description: "person identities of everyone taking part in the protest.",
      },
      groundTruth: {
        members: [...members].sort((a, b) => a - b),
        bystanders: header.groups.bystanders?.length ?? 0,
        scenario: header.name,
        scenarioSeed: header.seed,
      },
      scoring: {
        method: "set-f1",
        aggregate: "mean F1; also report precision and recall",
      },
    };
  },
};

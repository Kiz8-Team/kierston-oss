/**
 * "Where in the city is the crowd standing right now?"
 *
 * The family runs only on a day that stages a gathering, so the gathering
 * always exists and the prompt says so; there is no yes/no field, because a
 * label that is always "yes" scores the prompt rather than the records. The
 * answer is the point: the agent has to find, from cell loads, plate reads
 * and the pattern of a day, the one place fifty or more people who do not
 * belong together are standing. Schools, malls and workplaces are the false
 * positives to rule out.
 *
 * The size floor is the one the prompt states, and matches the script's own
 * `minCount` for the gathering.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import { cityInstant, eventOfKind, groupOf, nowAfter, scenarioHeader } from "./scenario.ts";

/** The crowd size the prompt promises. */
const MIN_CROWD = 50;

export const massGathering: TaskGenerator = {
  family: "mass-gathering",
  eventKind: "gathering",

  async generate(ctx, rng, seed) {
    const event = eventOfKind(ctx, "gathering");
    const header = scenarioHeader(ctx);
    const crowd = groupOf(ctx, "crowd");
    if (crowd.length < MIN_CROWD) throw new Error(`crowd of ${crowd.length} is too small for a mass gathering (minimum ${MIN_CROWD})`);
    const now = nowAfter(rng, event.start, { min: 40, max: 70 });
    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      kdiPolicy: { cutoff: cityInstant(ctx.date, now, await ctx.world.timeZone()) },
      prompt: [
        `It is ${clock(now)} on ${ctx.date}.`,
        `An unplanned gathering of ${MIN_CROWD} or more people is underway somewhere in the city right now. Officers do not know where.`,
        "Find it, and answer with the coordinates of the gathering.",
      ].join("\n"),
      evidence: { now: clock(now) },
      answer: { kind: "point", description: "The gathering's coordinates." },
      groundTruth: {
        lat: event.lat,
        lon: event.lon,
        size: crowd.length,
        since: event.start,
        scenario: header.name,
        scenarioSeed: header.seed,
        ...(header.choices ? { choices: header.choices } : {}),
      },
      scoring: {
        method: "distance",
        params: { placeCreditMetres: 250 },
        aggregate: "distance error of the located gathering; share within 250 m",
      },
    };
  },
};

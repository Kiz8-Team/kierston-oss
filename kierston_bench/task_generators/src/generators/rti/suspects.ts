/**
 * "Something just happened here. Who did it?"
 *
 * One generator shape for every staged incident whose answer is a person:
 * the event is read from the scenario day's header, the prompt quotes what a
 * dispatcher would know a few minutes on — where, when, what — and the
 * agent ranks suspects against records that stop at that moment. The truth
 * is the incident's actor role.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import { actorOf, cityInstant, describePlace, eventOfKind, nowAfter, scenarioHeader, windowText } from "./scenario.ts";

interface SuspectFamily {
  family: string;
  eventKind: string;
  /** The single-person role, or the group-of-one, the truth is read from. */
  role: string;
  /** Minutes after the event's end the investigation starts. */
  delay: { min: number; max: number };
  /** The incident, in the words the prompt opens with. */
  report: (place: string, when: string) => string;
}

function suspectFamily(spec: SuspectFamily): TaskGenerator {
  return {
    family: spec.family,
    eventKind: spec.eventKind,
    async generate(ctx, rng, seed) {
      const event = eventOfKind(ctx, spec.eventKind);
      const suspect = actorOf(ctx, spec.role);
      const header = scenarioHeader(ctx);
      const now = nowAfter(rng, event.end, spec.delay);
      const place = await describePlace(ctx, event);
      const where = place.venue ? `${place.venue} (${place.lat}, ${place.lon})` : `(${place.lat}, ${place.lon})`;
      const when = windowText(event);
      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        kdiPolicy: { cutoff: cityInstant(ctx.date, now, await ctx.world.timeZone()) },
        prompt: [
          spec.report(where, when),
          `It is now ${clock(now)} on ${ctx.date}.`,
          "Rank the most likely suspects, best first. Answer with person identities.",
        ].join("\n"),
        evidence: {
          incident: spec.eventKind,
          ...(place.venue ? { venue: place.venue } : {}),
          lat: place.lat,
          lon: place.lon,
          radiusMetres: event.radiusMetres,
          window: { from: clock(event.start), to: clock(event.end) },
          now: clock(now),
        },
        answer: {
          kind: "ranked-ids", identifier: "person",
          description: "person identities of the likely perpetrator, most likely first.",
        },
        groundTruth: {
          person: suspect,
          scenario: header.name,
          scenarioSeed: header.seed,
          ...(header.choices ? { choices: header.choices } : {}),
          ...(header.actors.decoy !== undefined ? { decoy: header.actors.decoy } : {}),
        },
        scoring: {
          method: "rank",
          aggregate: "mrr; also report top-1 accuracy and recall@5",
        },
      };
    },
  };
}

export const massShooting = suspectFamily({
  family: "mass-shooting",
  eventKind: "shooting",
  role: "shooter",
  delay: { min: 10, max: 20 },
  report: (place, when) => `Shots were fired inside ${place} ${when} today. There are multiple casualties and the crowd has scattered.`,
});

export const shotsFired = suspectFamily({
  family: "shots-fired",
  eventKind: "shots-fired",
  role: "shooter",
  delay: { min: 8, max: 15 },
  report: (place, when) => `Callers reported hearing gunshots near ${place} ${when} today. No victim has been found.`,
});

export const explosion = suspectFamily({
  family: "explosion",
  eventKind: "explosion",
  role: "bomber",
  delay: { min: 12, max: 25 },
  report: (place, when) => `An explosive device detonated at ${place} ${when} today.`,
});

export const schoolShooting = suspectFamily({
  family: "school-shooting",
  eventKind: "school-shooting",
  role: "shooter",
  delay: { min: 10, max: 20 },
  report: (place, when) => `Shots were fired inside ${place}, a school, ${when} today, during the school day. The building is in lockdown and some students have run.`,
});

/**
 * What the DT families share: a story told to a dispatcher, an event read
 * from the scenario day's header, and a ranked-person answer whose truth is
 * whoever the records incriminate.
 *
 * The prompt tells the story exactly as the reporting party told it and
 * says nothing about whether it holds. The story refers to people by role
 * only; their identities follow in one list, the caller beside at least one
 * other person from the scenario's roles, in a seeded order and one format,
 * so the caller is not singled out by position or wording. Nothing in the
 * evidence names the kind of event the script staged.
 */

import type { TaskContext } from "../../context.ts";
import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import type { AnswerSpec, ScoringSpec } from "../../task.ts";
import { clock } from "../../format.ts";
import { actorOf, cityInstant, describePlace, eventOfKind, nowAfter, scenarioHeader } from "../rti/scenario.ts";

export interface DeceptionFamily {
  family: string;
  eventKind: string;
  /** Minutes after the event's end the investigation starts. */
  delay: { min: number; max: number };
  /**
   * Who the records point to, read from the header, who made the call, and
   * the other people the report names (at least one), keyed by the role label
   * the prompt lists them under.
   */
  resolve: (ctx: TaskContext) => { person: number; caller: number; named: Record<string, number>; extra?: Record<string, unknown> };
  /** The caller's role label in the list of people. */
  callerRole: string;
  /**
   * The story in the prompt's words: the place and the event's window as
   * clock times. People are referred to by role; their identities are listed
   * after the story.
   */
  report: (place: string, window: { start: string; end: string }) => string;
  /**
   * What the agent is asked, and the answer and scoring that go with it, when
   * asking for a ranked list of suspects would itself say a crime happened.
   * Defaults to ranking the people responsible.
   */
  ask?: { question: string; answer: AnswerSpec; scoring: ScoringSpec };
}

/** The reporting party as the 911 call identifies them. */
export interface Caller {
  name: string;
  dob: string;
  phone: string;
}

export function deceptionFamily(spec: DeceptionFamily): TaskGenerator {
  return {
    family: spec.family,
    eventKind: spec.eventKind,
    async generate(ctx, rng, seed) {
      const event = eventOfKind(ctx, spec.eventKind);
      const header = scenarioHeader(ctx);
      const truth = spec.resolve(ctx);
      const now = nowAfter(rng, event.end, spec.delay);
      const place = await describePlace(ctx, event);
      const where = place.venue ? `${place.venue} (${place.lat}, ${place.lon})` : `the residence at (${place.lat}, ${place.lon})`;
      const window = { start: clock(event.start), end: clock(event.end) };
      const roles = Object.entries(truth.named);
      if (roles.length === 0) throw new Error(`${spec.family} names nobody beside the caller`);
      const people: (Caller & { role: string })[] = [];
      for (const [role, person] of [[spec.callerRole, truth.caller] as const, ...roles]) {
        people.push({ role, ...(await ctx.world.callerIdentity(person)) });
      }
      // Seeded order: the caller is first in some tasks and not in others.
      const listed = rng.shuffle(people);
      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        kdiPolicy: { cutoff: cityInstant(ctx.date, now, await ctx.world.timeZone()) },
        prompt: [
          spec.report(where, window),
          "People named in the report:",
          ...listed.map((person) => `- ${person.role}: ${person.name}, date of birth ${person.dob}, phone ${person.phone}`),
          `It is now ${clock(now)} on ${ctx.date}.`,
          spec.ask?.question ?? "Rank the people most likely responsible for this incident, best first. Answer with person identities.",
        ].join("\n"),
        evidence: {
          ...(place.venue ? { venue: place.venue } : {}),
          lat: place.lat,
          lon: place.lon,
          radiusMetres: event.radiusMetres,
          reportedAt: window.end,
          people: listed,
          now: clock(now),
        },
        answer: spec.ask?.answer ?? {
          kind: "ranked-ids", identifier: "person",
          description: "person identities of whoever is responsible for the incident, most likely first.",
        },
        groundTruth: {
          person: truth.person,
          ...(truth.extra ?? {}),
          scenario: header.name,
          scenarioSeed: header.seed,
          ...(header.choices ? { choices: header.choices } : {}),
        },
        scoring: spec.ask?.scoring ?? {
          method: "rank",
          aggregate: "mrr; also report top-1 accuracy and recall@5",
        },
      };
    },
  };
}

/** A role bound as an actor or a group of one, or nothing when the script did not bind it. */
export function optionalActor(ctx: TaskContext, role: string): number | undefined {
  const header = scenarioHeader(ctx);
  return header.actors[role] ?? header.groups[role]?.[0];
}

export { actorOf };

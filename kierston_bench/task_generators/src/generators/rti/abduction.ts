/**
 * "Somebody was just forced into a car. Who took them?"
 *
 * The staged abduction leaves the victim's handset on the pavement, the
 * crew's handsets beside it for three minutes, and the crew's car on the
 * cameras on the way in and the way out. The prompt gives what a caller
 * could: where, when, that it was a car, and the victim's identity, which
 * the caller knew or the police established within minutes. The agent
 * ranks the people in the car; every member of the crew is a right answer.
 * The truth carries the driver, the car and the victim so a run can be
 * read afterwards: whether the car was found, whether the victim's own
 * phone was ever followed.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import { actorOf, cityInstant, describePlace, eventOfKind, groupOf, nowAfter, scenarioHeader, windowText } from "./scenario.ts";

export const abduction: TaskGenerator = {
  family: "abduction",
  eventKind: "abduction",
  async generate(ctx, rng, seed) {
    const event = eventOfKind(ctx, this.eventKind!);
    const header = scenarioHeader(ctx);
    const victim = actorOf(ctx, "victim");
    const identified = await ctx.world.callerIdentity(victim);
    const driver = actorOf(ctx, "driver");
    const people = [driver, ...groupOf(ctx, "accomplices")];
    const vin = header.vehicles?.car;
    if (vin === undefined) throw new Error(`scenario ${header.name} binds no car`);
    const plate = (await ctx.world.vehicles()).vehicles[vin]?.plate ?? null;
    const now = nowAfter(rng, event.end, { min: 8, max: 15 });
    const place = await describePlace(ctx, event);
    const where = place.venue ? `${place.venue} (${place.lat}, ${place.lon})` : `the street at (${place.lat}, ${place.lon})`;
    const reporter = header.actors.kin !== undefined
      ? `A relative was on the phone with the victim ${windowText(event)} today near ${where}, heard a struggle and car doors, and the line went dead; they called 911.`
      : `A caller told 911 that ${windowText(event)} today they saw a person forced into a car near ${where}; the car drove off at once. The caller could not read the plate.`;
    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      kdiPolicy: { cutoff: cityInstant(ctx.date, now, await ctx.world.timeZone()) },
      prompt: [
        reporter,
        `The victim has been identified as ${identified.name}, date of birth ${identified.dob}, phone ${identified.phone}.`,
        `It is now ${clock(now)} on ${ctx.date}.`,
        "Rank the people most likely to have been in that car, best first. Answer with person identities.",
      ].join("\n"),
      evidence: {
        incident: "abduction",
        ...(place.venue ? { venue: place.venue } : {}),
        lat: place.lat,
        lon: place.lon,
        radiusMetres: event.radiusMetres,
        window: { from: clock(event.start), to: clock(event.end) },
        victim: identified,
        now: clock(now),
      },
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities of the people who took the victim, most likely first.",
      },
      groundTruth: {
        people,
        driver,
        vehicle: { vin, plate },
        victim,
        ...(header.groups.witness?.length ? { witness: header.groups.witness[0] } : {}),
        ...(header.actors.kin !== undefined ? { kin: header.actors.kin } : {}),
        scenario: header.name,
        scenarioSeed: header.seed,
        ...(header.choices ? { choices: header.choices } : {}),
      },
      scoring: {
        method: "rank",
        aggregate: "mrr over the crew; also report top-1 accuracy and recall@5",
      },
    };
  },
};

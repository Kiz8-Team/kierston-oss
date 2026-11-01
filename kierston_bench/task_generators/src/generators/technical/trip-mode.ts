/**
 * "Was this movement walking, private car, cab, bus, or carpool?"
 *
 * The prompt anchors a single observed departure — a person, a rounded
 * point, a time — and nothing else; where they went and how long it took
 * are for the agent to reconstruct before it can call the mode. The label
 * comes from the leg table. Fleet-internal movements (a cab deadheading, a
 * bus on its run) are excluded — the family is about how a *person* moved.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, roundedCoord, taskId } from "../../generator.ts";
import { clock, degrees } from "../../format.ts";

const EXCLUDED_PURPOSES = new Set(["deadhead", "run", "fare"]);

/**
 * The simulator's `other` bucket contains car-like road movements (and is
 * emitted into ALPR evidence as one), so it is not an observable class distinct
 * from a private car for this benchmark family.
 */
export function classifiedTripMode(mode: string): string {
  return mode === "other" ? "car" : mode;
}

export function classifiedTripModeLabels(modes: readonly string[]): string[] {
  return [...new Set(modes.map(classifiedTripMode))];
}

export const tripMode: TaskGenerator = {
  family: "trip-mode",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const legs = await ctx.day.columns(
      "leg.depart", "leg.mode", "leg.purpose", "leg.kilometres",
      "leg.fromLatE6", "leg.fromLonE6",
    );
    const rawModes = ctx.day.enumValues("mode");
    const modes = classifiedTripModeLabels(rawModes);
    const purposes = ctx.day.enumValues("purpose");

    let leg = -1;
    let row = -1;
    for (let attempt = 0; attempt < 1000 && leg < 0; attempt += 1) {
      row = drawIndex(rng, persons.id.length, (index) => persons.legCount[index]! >= 1);
      const from = persons.legOffset[row]!;
      const count = persons.legCount[row]!;
      const candidate = from + rng.int(count);
      if (legs.kilometres[candidate]! < 0.4) continue;
      if (EXCLUDED_PURPOSES.has(purposes[legs.purpose[candidate]!]!)) continue;
      leg = candidate;
    }
    if (leg < 0) throw new Error("no eligible movement found");

    const person = persons.id[row]!;
    const subjectSsn = await ctx.world.personSsn(person);

    const departure = {
      ssn: subjectSsn,
      departedAt: clock(legs.depart[leg]!),
      from: { lat: roundedCoord(degrees(legs.fromLatE6[leg]!)), lon: roundedCoord(degrees(legs.fromLonE6[leg]!)) },
    };

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `The person with SSN ${subjectSsn} set out on a journey on ${ctx.date}:`,
        JSON.stringify(departure, null, 2),
        `By what mode did they travel on that journey? Answer with one label from: ${modes.join(", ")}.`,
      ].join("\n"),
      evidence: { departure },
      answer: {
        kind: "label",
        description: "The travel mode of this movement.",
        labels: modes,
      },
      groundTruth: { mode: classifiedTripMode(rawModes[legs.mode[leg]!]!) },
      scoring: {
        method: "top1",
        aggregate: "macro-F1 over mode labels",
      },
    };
  },
};

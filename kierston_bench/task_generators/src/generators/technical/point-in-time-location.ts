/**
 * "Where was person A at 14:37?"
 *
 * The minute is drawn from inside the person's active day so the answer is
 * an interpolated leg position or a live stay, never "asleep at home" every
 * time. The truth is the routed path the exporter wrote, sampled by time
 * fraction.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clock } from "../../format.ts";

export const pointInTimeLocation: TaskGenerator = {
  family: "point-in-time-location",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const legs = await ctx.day.columns("leg.depart", "leg.arrive");

    const row = drawIndex(rng, persons.id.length, (index) => persons.legCount[index]! >= 2);
    const from = persons.legOffset[row]!;
    const count = persons.legCount[row]!;
    const first = legs.depart[from]!;
    const last = legs.arrive[from + count - 1]!;
    // Inside the active day, with a margin either side so stays at both ends
    // are reachable, clamped to the civil day.
    const low = Math.max(0, first - 30);
    const high = Math.min(1439, last + 30);
    const minute = low + rng.int(Math.max(1, high - low + 1));

    const truth = await ctx.positionAt(row, minute);
    const person = persons.id[row]!;

    const subjectSsn = await ctx.world.personSsn(person);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `Where was the person with SSN ${subjectSsn} at ${clock(minute)} on ${ctx.date}?`,
        `Answer with a latitude and longitude in degrees.`,
      ].join("\n"),
      evidence: { ssn: subjectSsn, time: clock(minute), minute },
      answer: {
        kind: "point",
        description: "Latitude/longitude in degrees.",
      },
      groundTruth: {
        lat: truth.lat,
        lon: truth.lon,
        during: truth.during,
        place: truth.label,
      },
      scoring: {
        method: "distance",
        params: { placeCreditWithinMetres: 100 },
        aggregate: "median and mean distance error; accuracy within 100 metres",
      },
    };
  },
};

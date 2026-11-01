/**
 * "Where did this journey begin and end?"
 *
 * The journey is anchored to something observable — an ALPR sighting of a
 * resident vehicle mid-route — and the endpoints are what has to be
 * inferred. The journey is the whole movement the sighted leg belongs to,
 * for the person whose leg it is: a multi-segment journey stamps its
 * segments `${root}/0`, `${root}/1`, ... (the walk to the car, the drive, the
 * walk from the parking space), so the sighted leg's segment run is followed
 * both ways through that person's legs. The origin is the first segment's
 * start and the destination is the end of the segment that arrives last.
 * Other people sharing the journey id (passengers) are not read: their
 * drop-off is not the sighted person's destination.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clockSeconds, degrees } from "../../format.ts";
import { NONE } from "../../kday.ts";
import type { Rng } from "../../rng.ts";
import { CANDIDATE_CREDIT } from "../../task.ts";

export const originDestination: TaskGenerator = {
  family: "origin-destination",

  async generate(ctx, rng: Rng, seed) {
    const truth = await ctx.day.columns(
      "alprTruth.correlationId", "alprTruth.second", "alprTruth.leg",
      "alprTruth.source", "alprTruth.plate",
    );
    const obs = await ctx.day.columns("alprObservation.correlationId", "alprObservation.camera");
    const sources = ctx.day.enumValues("alprMovementSource");
    const legs = await ctx.day.columns(
      "leg.depart", "leg.arrive", "leg.journey",
      "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
      "leg.fromLabel", "leg.toLabel",
    );
    const journeys = await ctx.journeys();
    const persons = await ctx.persons();

    /**
     * The sighted leg and its sibling segments among one person's legs. A
     * segment id is `${root}/${index}`; a one-segment journey's id is the
     * root itself, which also ends in digits (the departure minute), so a
     * neighbour counts only when it carries the adjacent index under the same
     * root, and the run is followed outward from the sighted leg.
     */
    const journeySegments = (id: string, sighted: number, personRow: number): number[] => {
      const split = /^(.*)\/(\d+)$/.exec(id);
      if (!split) return [sighted];
      const [, root, index] = split as unknown as [string, string, string];
      const byIndex = new Map<number, number>();
      const from = persons.legOffset[personRow]!;
      for (let leg = from; leg < from + persons.legCount[personRow]!; leg += 1) {
        if (legs.journey[leg]! === NONE) continue;
        const other = /^(.*)\/(\d+)$/.exec(ctx.day.string(legs.journey[leg]!) ?? "");
        if (other && other[1] === root) byIndex.set(Number(other[2]), leg);
      }
      const at = Number(index);
      const out = [sighted];
      for (let step = at - 1; byIndex.has(step); step -= 1) out.push(byIndex.get(step)!);
      for (let step = at + 1; byIndex.has(step); step += 1) out.push(byIndex.get(step)!);
      return out;
    };

    const observedCorrelations = new Set<number>();
    for (let i = 0; i < obs.correlationId.length; i += 1) observedCorrelations.add(obs.correlationId[i]!);

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const pass = rng.int(truth.correlationId.length);
      if (sources[truth.source[pass]!] !== "resident") continue;
      if (!observedCorrelations.has(truth.correlationId[pass]!)) continue;
      const sighted = truth.leg[pass]!;
      const journeyId = legs.journey[sighted]!;
      if (journeyId === NONE) continue;
      const owner = journeys.get(journeyId)?.find((part) => part.leg === sighted);
      if (!owner) continue;
      const segments = journeySegments(ctx.day.string(journeyId)!, sighted, owner.personRow);
      const firstLeg = segments.reduce((best, leg) => legs.depart[leg]! < legs.depart[best]! ? leg : best);
      const lastLeg = segments.reduce((best, leg) => legs.arrive[leg]! > legs.arrive[best]! ? leg : best);
      const plate = ctx.day.string(truth.plate[pass]!);

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        prompt: [
          `The vehicle with plate ${plate} passed a plate-reader camera at ${clockSeconds(truth.second[pass]!)} on ${ctx.date}, in the middle of one journey.`,
          `Where did that journey begin, and where did it end?`,
          `Answer with two latitude/longitude points in degrees: origin then destination.`,
        ].join("\n"),
        evidence: { plate, sightingTime: clockSeconds(truth.second[pass]!) },
        answer: {
          kind: "record",
          description: "The journey's origin and destination.",
          fields: {
            origin: { kind: "point", candidateCredit: CANDIDATE_CREDIT, description: "Where the journey began." },
            destination: { kind: "point", candidateCredit: CANDIDATE_CREDIT, description: "Where the journey ended." },
          },
        },
        groundTruth: {
          origin: {
            lat: degrees(legs.fromLatE6[firstLeg]!),
            lon: degrees(legs.fromLonE6[firstLeg]!),
            label: ctx.day.string(legs.fromLabel[firstLeg]!),
          },
          destination: {
            lat: degrees(legs.toLatE6[lastLeg]!),
            lon: degrees(legs.toLonE6[lastLeg]!),
            label: ctx.day.string(legs.toLabel[lastLeg]!),
          },
        },
        scoring: {
          method: "record",
          params: { fields: { origin: "distance", destination: "distance" } },
          aggregate: "mean endpoint distance error; place accuracy within 100 m",
        },
      };
    }
    throw new Error("no camera-observed resident journey found; the day may not support this family");
  },
};

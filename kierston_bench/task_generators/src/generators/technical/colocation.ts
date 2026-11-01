/**
 * "Which people were physically near A during this window?"
 *
 * The window is one real stay of the target's away from home, and the truth
 * set is computed from everyone's stays at selection time: any resident whose
 * own stay overlaps the window by the minimum minutes within the radius. A
 * person's stays are the ones `TaskContext.positionAt` reads: the place they
 * start the day (the first leg's origin, until it departs), each leg's
 * destination until the next departure, and, for a person with no legs, their
 * household's dwelling all day. The thresholds are part of the task and are
 * recorded in the scoring params so the score means the same thing across
 * runs.
 *
 * The scan is a single pass over the whole leg table with an integer
 * bounding-box prefilter, so the full population is checked, not a sample.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clock, degrees, haversineMetres } from "../../format.ts";

const RADIUS_METRES = 75;
const MIN_OVERLAP_MINUTES = 15;
const END_OF_DAY = 1920;

export const colocation: TaskGenerator = {
  family: "colocation",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const legs = await ctx.day.columns(
      "leg.depart", "leg.arrive", "leg.toLatE6", "leg.toLonE6", "leg.toLabel",
      "leg.fromLatE6", "leg.fromLonE6",
    );

    // A target with a substantial stay somewhere that is not their home.
    const stayOf = (row: number): number | null => {
      const from = persons.legOffset[row]!;
      const count = persons.legCount[row]!;
      for (let leg = from; leg < from + count; leg += 1) {
        const stayStart = legs.arrive[leg]!;
        const stayEnd = leg + 1 < from + count ? legs.depart[leg + 1]! : END_OF_DAY;
        if (stayEnd - stayStart < 45) continue;
        if (ctx.day.string(legs.toLabel[leg]!) === "home") continue;
        return leg;
      }
      return null;
    };
    const row = drawIndex(rng, persons.id.length, (index) => persons.legCount[index]! >= 2 && stayOf(index) !== null);
    const anchor = stayOf(row)!;

    const from = persons.legOffset[row]!;
    const count = persons.legCount[row]!;
    const windowStart = legs.arrive[anchor]!;
    const rawEnd = anchor + 1 < from + count ? legs.depart[anchor + 1]! : END_OF_DAY;
    const windowEnd = Math.min(rawEnd, windowStart + 120);
    const centreLatE6 = legs.toLatE6[anchor]!;
    const centreLonE6 = legs.toLonE6[anchor]!;
    const centreLat = degrees(centreLatE6);
    const centreLon = degrees(centreLonE6);

    // ~1e-5 degrees per metre latitude; pad the box generously and let the
    // haversine make the actual call.
    const boxE6 = Math.ceil(RADIUS_METRES * 15);

    // Where a person with no legs spends the day: their household's dwelling.
    const population = await ctx.world.population();
    const dwellings = new Map((await ctx.world.dwellings()).dwellings.map((record) => [record.id, record]));
    const households = new Map(population.household_records.map((record) => [record.id, record.dwelling]));
    const homeOf = new Map<number, { lat: number; lon: number }>();
    for (const record of population.person_records) {
      const dwelling = dwellings.get(households.get(record.household) ?? "");
      if (dwelling && typeof dwelling.lat === "number" && typeof dwelling.lon === "number") homeOf.set(record.id, { lat: dwelling.lat, lon: dwelling.lon });
    }

    const overlaps = (start: number, end: number): boolean =>
      Math.min(end, windowEnd) - Math.max(start, windowStart) >= MIN_OVERLAP_MINUTES;
    const within = (latE6: number, lonE6: number): boolean =>
      Math.abs(latE6 - centreLatE6) <= boxE6 && Math.abs(lonE6 - centreLonE6) <= boxE6
      && haversineMetres(centreLat, centreLon, degrees(latE6), degrees(lonE6)) <= RADIUS_METRES;

    const near = new Set<number>();
    for (let other = 0; other < persons.id.length; other += 1) {
      if (other === row) continue;
      const otherFrom = persons.legOffset[other]!;
      const otherCount = persons.legCount[other]!;
      if (otherCount === 0) {
        const home = homeOf.get(persons.id[other]!);
        if (home && overlaps(0, END_OF_DAY)
          && haversineMetres(centreLat, centreLon, home.lat, home.lon) <= RADIUS_METRES) near.add(persons.id[other]!);
        continue;
      }
      // Before the first departure: at the first leg's origin.
      if (overlaps(0, legs.depart[otherFrom]!) && within(legs.fromLatE6[otherFrom]!, legs.fromLonE6[otherFrom]!)) {
        near.add(persons.id[other]!);
        continue;
      }
      for (let leg = otherFrom; leg < otherFrom + otherCount; leg += 1) {
        const stayStart = legs.arrive[leg]!;
        const stayEnd = leg + 1 < otherFrom + otherCount ? legs.depart[leg + 1]! : END_OF_DAY;
        if (!overlaps(stayStart, stayEnd) || !within(legs.toLatE6[leg]!, legs.toLonE6[leg]!)) continue;
        near.add(persons.id[other]!);
        break;
      }
    }

    const person = persons.id[row]!;
    const subjectSsn = await ctx.world.personSsn(person);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `Between ${clock(windowStart)} and ${clock(windowEnd)} on ${ctx.date}, which residents were physically near the person with SSN ${subjectSsn} — within about ${RADIUS_METRES} m for at least ${MIN_OVERLAP_MINUTES} minutes?`,
        `Answer with the set of person identities.`,
      ].join("\n"),
      evidence: {
        ssn: subjectSsn,
        window: { from: clock(windowStart), to: clock(windowEnd) },
        radiusMetres: RADIUS_METRES,
        minOverlapMinutes: MIN_OVERLAP_MINUTES,
      },
      answer: {
        kind: "id-set", identifier: "person",
        description: "person identities of everyone near the target for the required overlap.",
      },
      groundTruth: { near: [...near].sort((a, b) => a - b) },
      scoring: {
        method: "set-f1",
        params: { radiusMetres: RADIUS_METRES, minOverlapMinutes: MIN_OVERLAP_MINUTES },
        aggregate: "precision/recall at the fixed thresholds",
      },
    };
  },
};

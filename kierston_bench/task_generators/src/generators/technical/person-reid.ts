/**
 * "Which resident generated this movement and venue history?"
 *
 * The target must have actually gone somewhere: at least four legs and at
 * least two distinct venues away from home, or the trace is a commute any
 * thousand people share. The trace quotes only stay windows and coordinates
 * rounded to about a hundred metres. Place semantics remain private.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, roundedCoord, taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import { NONE } from "../../kday.ts";
import { reidentificationEvidence } from "../../location-evidence.ts";

export const personReid: TaskGenerator = {
  family: "person-reid",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const toLabel = await ctx.day.column("leg.toLabel");

    const distinctAwayVenues = (row: number): number => {
      const from = persons.legOffset[row]!;
      const seen = new Set<number>();
      for (let leg = from; leg < from + persons.legCount[row]!; leg += 1) {
        const label = toLabel[leg]!;
        if (label === NONE) continue;
        if (ctx.day.string(label) === "home") continue;
        seen.add(label);
      }
      return seen.size;
    };

    const row = drawIndex(
      rng, persons.id.length,
      (index) => persons.legCount[index]! >= 4 && distinctAwayVenues(index) >= 2,
    );

    const stays = await ctx.staysOf(row);
    const trace = stays.map((stay) => ({
      from: clock(stay.startMinute),
      to: clock(stay.endMinute),
      lat: roundedCoord(stay.lat),
      lon: roundedCoord(stay.lon),
    }));

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      ...reidentificationEvidence(ctx.date, trace),
      answer: {
        kind: "ranked-ids", identifier: "person",
        description: "person identities, most likely resident first.",
      },
      groundTruth: { person: persons.id[row]! },
      scoring: {
        method: "rank",
        aggregate: "mrr; also report top-1 accuracy and recall@5",
      },
    };
  },
};

/**
 * "Which people travelled together, and who drove?"
 *
 * The anchor is a journey id shared by more than one resident's legs — the
 * exporter stamps both halves of a shared trip with it precisely so the
 * group is checkable. The driver is the participant whose own leg was a
 * driving mode; the party roles table records the same fact for gatherings,
 * but the journey is the authority for the ride itself.
 */

import type { TaskGenerator } from "../../generator.ts";
import { roundedCoord, taskId } from "../../generator.ts";
import { clock, degrees } from "../../format.ts";
import { NONE } from "../../kday.ts";
import type { Rng } from "../../rng.ts";

/**
 * Leg modes whose traveller is at the wheel. "cab" is the cab driver's own
 * leg; "taxi" is the hirer's, a passenger leg, and does not make its
 * traveller the driver.
 */
const DRIVER_MODES = new Set(["car", "cab"]);

export const sharedTravel: TaskGenerator = {
  family: "shared-travel",

  async generate(ctx, rng: Rng, seed) {
    const journeys = await ctx.journeys();
    const persons = await ctx.persons();
    const legs = await ctx.day.columns(
      "leg.depart", "leg.arrive", "leg.mode", "leg.vehicle",
      "leg.fromLatE6", "leg.fromLonE6",
    );
    const modes = ctx.day.enumValues("mode");
    const world = await ctx.world.vehicles();

    const shared = [...journeys.entries()]
      .filter(([, parts]) => new Set(parts.map((part) => part.personRow)).size >= 2)
      .sort((a, b) => a[0] - b[0]);
    if (shared.length === 0) throw new Error("no shared journeys on this day");

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [, parts] = rng.pick(shared);
      const travellers = new Set<number>();
      let driver: number | null = null;
      let vehicleString: number = NONE;
      let firstLeg = parts[0]!.leg;
      for (const { personRow, leg } of parts) {
        travellers.add(persons.id[personRow]!);
        if (DRIVER_MODES.has(modes[legs.mode[leg]!]!)) driver = persons.id[personRow]!;
        if (legs.vehicle[leg]! !== NONE) vehicleString = legs.vehicle[leg]!;
        if (legs.depart[leg]! < legs.depart[firstLeg]!) firstLeg = leg;
      }
      if (driver === null || vehicleString === NONE) continue;
      const vin = ctx.day.string(vehicleString);
      const record = vin ? world.vehicles[vin] : undefined;
      if (!record) continue;

      const departWindow = `${clock(Math.floor(legs.depart[firstLeg]! / 30) * 30)}–${clock(Math.ceil((legs.depart[firstLeg]! + 1) / 30) * 30)}`;

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        prompt: [
          `The vehicle with plate ${record.plate} left the area of (${roundedCoord(degrees(legs.fromLatE6[firstLeg]!))}, ${roundedCoord(degrees(legs.fromLonE6[firstLeg]!))}) between ${departWindow} on ${ctx.date}, carrying passenger(s).`,
          `Which residents travelled together on that journey, and who drove?`,
          `Answer with the set of person identities and the driver's person identity.`,
        ].join("\n"),
        evidence: {
          plate: record.plate,
          departWindow,
          origin: {
            lat: roundedCoord(degrees(legs.fromLatE6[firstLeg]!)),
            lon: roundedCoord(degrees(legs.fromLonE6[firstLeg]!)),
          },
        },
        answer: {
          kind: "record",
          description: "The travelling party and its driver.",
          fields: {
            travellers: { kind: "id-set", identifier: "person", description: "person identities of everyone on the journey." },
            driver: { kind: "id", identifier: "person", description: "person identity of the driver." },
          },
        },
        groundTruth: {
          travellers: [...travellers].sort((a, b) => a - b),
          driver,
        },
        scoring: {
          method: "record",
          params: { fields: { travellers: "set-f1", driver: "top1" } },
          aggregate: "group F1 and driver accuracy",
        },
      };
    }
    throw new Error("no driven shared journey found");
  },
};

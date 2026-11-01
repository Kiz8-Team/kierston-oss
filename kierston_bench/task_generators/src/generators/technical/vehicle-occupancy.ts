/**
 * "Who was inside vehicle V at 18:12?"
 *
 * The moment is the midpoint of a real driven leg, so the vehicle was
 * demonstrably moving; the recorded truth is everyone whose leg rode that
 * vehicle over that minute, driver and passengers alike.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clock } from "../../format.ts";
import type { Rng } from "../../rng.ts";

export const vehicleOccupancy: TaskGenerator = {
  family: "vehicle-occupancy",

  async generate(ctx, rng: Rng, seed) {
    const byVehicle = await ctx.vehicleLegs();
    const persons = await ctx.persons();
    const legs = await ctx.day.columns("leg.depart", "leg.arrive");
    const world = await ctx.world.vehicles();

    const moved = [...byVehicle.keys()].sort((a, b) => a - b);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const vehicleString = rng.pick(moved);
      const vin = ctx.day.string(vehicleString);
      const record = vin ? world.vehicles[vin] : undefined;
      if (!record) continue;

      const rides = byVehicle.get(vehicleString)!;
      const chosen = rng.pick(rides);
      const minute = Math.floor((legs.depart[chosen.leg]! + legs.arrive[chosen.leg]!) / 2);

      const occupants = new Set<number>();
      for (const { personRow, leg } of rides) {
        if (legs.depart[leg]! <= minute && minute <= legs.arrive[leg]!) {
          occupants.add(persons.id[personRow]!);
        }
      }
      if (occupants.size === 0) continue;

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        prompt: [
          `The vehicle with plate ${record.plate} was on the road at ${clock(minute)} on ${ctx.date}.`,
          `How many people were inside it at that moment, including the driver, and who were they?`,
          'Answer as {"count": <non-negative integer>, "occupants": [<person identities>]}.',
          "Count includes driver and passengers. List each person's identity using a full name, name and DOB, or SSN.",
          "Count and identities are assessed independently; report your estimate for each even if uncertain about the other.",
        ].join("\n"),
        evidence: { plate: record.plate, time: clock(minute), minute },
        answer: {
          kind: "record",
          independentFields: true,
          description: "Occupant count and identities at the stated time, including the driver.",
          fields: {
            count: { kind: "integer", description: "Total number of people, including driver and passengers." },
            occupants: { kind: "id-set", identifier: "person", description: "person identities of everyone inside; each person once." },
          },
        },
        groundTruth: { count: occupants.size, occupants: [...occupants].sort((a, b) => a - b) },
        scoring: {
          method: "record",
          params: { fields: { count: "top1", occupants: "set-f1" } },
          aggregate: "count accuracy and occupant precision/recall/F1 separately; headline is their equal-weight mean",
        },
      };
    }
    throw new Error("no occupied vehicle moment found; the day may not support this family");
  },
};

/**
 * "Which school does this child attend, and who usually escorts them?"
 *
 * The truth is the school-travel register: the school assignment, the
 * morning travel mode, and the nominated escort where one exists. Children
 * who walk unescorted are eligible too — "nobody" is a correct answer the
 * model must be able to give.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { CANDIDATE_CREDIT } from "../../task.ts";

export const schoolEscort: TaskGenerator = {
  family: "school-escort",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const travel = await ctx.world.schoolTravel();
    const riders = travel.riders;
    const places = await ctx.world.places();
    const observable = await ctx.world.observablePlaces();

    const index = drawIndex(rng, riders.length, (i) => {
      const rider = riders[i]!;
      if (!rider.school || !rider.am) return false;
      // A school no place search names cannot be answered, whoever attends it.
      if (!observable.has(places.same(rider.school))) return false;
      const row = persons.rowOf.get(rider.person);
      return row !== undefined && persons.legCount[row]! >= 1;
    });
    const rider = riders[index]!;

    const subjectSsn = await ctx.world.personSsn(rider.person);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `The person with SSN ${subjectSsn} is a school-age resident.`,
        `Which school do they attend, and which resident (if any) usually escorts them there in the morning?`,
        `Answer with the school name as ADI returns it (or its full street address if needed to distinguish names) and the escort's identity, or null if they travel unescorted.`,
        "For places, use an unambiguous name or full street address. An OSM reference (way/..., node/..., relation/...) returned in a record is also accepted.",
      ].join("\n"),
      evidence: { ssn: subjectSsn },
      answer: {
        kind: "record",
        description: "The school and the usual morning escort.",
        fields: {
          school: { kind: "id", candidateCredit: CANDIDATE_CREDIT, description: "The school name as ADI returns it (or its full street address if needed to distinguish names)." },
          escort: { kind: "id", identifier: "person", nullable: true, candidateCredit: CANDIDATE_CREDIT, description: "Identity of the usual escort, or null." },
        },
      },
      groundTruth: {
        school: rider.school,
        escortAm: rider.escort_am,
        morningMode: rider.am,
      },
      scoring: {
        method: "record",
        params: { fields: { school: "top1", escort: "top1" } },
        aggregate: "school accuracy and escort accuracy (null counts as an answer)",
      },
    };
  },
};

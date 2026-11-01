/**
 * "Which location is this person's residence?"
 *
 * The truth is the household's dwelling from the population register. The
 * person must appear in the observed day so there is evidence to work from.
 *
 * The dwelling must have an address that resolves to it and to nothing else
 * in the place index (dwellings, organizations, schools, workplaces), the
 * same index the scorer resolves answers through. A dwelling that shares its
 * address with another dwelling or a registered site, or has none, is not
 * drawn: the right address would resolve to several ids, or to none.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { CANDIDATE_CREDIT } from "../../task.ts";

export const homeId: TaskGenerator = {
  family: "home-id",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const population = await ctx.world.population();
    const dwellings = await ctx.world.dwellings();
    const households = new Map(population.household_records.map((record) => [record.id, record]));
    const dwellingById = new Map(dwellings.dwellings.map((record) => [record.id, record]));
    const places = await ctx.world.places();
    const addressable = (dwelling: { id: string; address: string }): boolean => {
      if (!dwelling.address?.trim()) return false;
      const match = places.resolve(dwelling.address);
      return match.ids.length === 1 && match.ids[0] === places.same(dwelling.id);
    };

    const people = population.person_records;
    const index = drawIndex(rng, people.length, (i) => {
      const person = people[i]!;
      const row = persons.rowOf.get(person.id);
      if (row === undefined || persons.legCount[row]! < 1) return false;
      const household = households.get(person.household);
      if (household === undefined) return false;
      const dwelling = dwellingById.get(household.dwelling);
      return dwelling !== undefined && addressable(dwelling);
    });

    const person = people[index]!;
    const household = households.get(person.household)!;
    const dwelling = dwellingById.get(household.dwelling)!;

    const subjectSsn = await ctx.world.personSsn(person.id);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      kdiPolicy: {
        queries: [{ source: "ssa", search: "people", redactColumns: ["mailing_address"] }],
        redactSubjectFields: ["address"],
      },
      prompt: [
        `Where does the person with SSN ${subjectSsn} live?`,
        `Answer with the full street address of the dwelling, and its latitude/longitude in degrees.`,
        "For places, use an unambiguous name or full street address. An OSM reference (way/..., node/..., relation/...) returned in a record is also accepted.",
      ].join("\n"),
      evidence: { ssn: subjectSsn },
      answer: {
        kind: "record",
        description: "The residence.",
        fields: {
          dwelling: { kind: "id", candidateCredit: CANDIDATE_CREDIT, description: "The full street address of the dwelling." },
          location: { kind: "point", candidateCredit: CANDIDATE_CREDIT, description: "The dwelling's coordinates." },
        },
      },
      groundTruth: {
        dwelling: dwelling.id,
        lat: dwelling.lat,
        lon: dwelling.lon,
        address: dwelling.address,
        household: household.id,
      },
      scoring: {
        method: "record",
        params: { fields: { dwelling: "top1", location: "distance" } },
        aggregate: "top-1 dwelling accuracy; distance error as a secondary",
      },
    };
  },
};

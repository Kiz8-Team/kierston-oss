/**
 * "Which gym, congregation, team, or civic group does this person belong to?"
 *
 * The truth is the affiliation register, restricted to voluntary
 * associations — work and school are their own families. The target must
 * hold at least one such affiliation.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";

const VOLUNTARY = new Set(["worship", "gym", "sports", "civic", "union", "youth", "fraternal"]);

export const organizationMembership: TaskGenerator = {
  family: "organization-membership",

  async generate(ctx, rng, seed) {
    const affiliations = await ctx.world.affiliations();
    const byPerson = new Map<number, { org: string; class: string }[]>();
    for (const record of affiliations.affiliation_records) {
      if (!VOLUNTARY.has(record.class)) continue;
      const list = byPerson.get(record.person);
      const entry = { org: record.org, class: record.class };
      if (list) list.push(entry);
      else byPerson.set(record.person, [entry]);
    }

    // Every membership has to be answerable: one unnamed ball field in the
    // truth caps recall for an answer that found everything findable.
    const places = await ctx.world.places();
    const observable = await ctx.world.observablePlaces();
    const members = [...byPerson.keys()].sort((a, b) => a - b);
    const index = drawIndex(rng, members.length, (i) => byPerson.get(members[i]!)!.every((m) => observable.has(places.same(m.org))));
    const person = members[index]!;
    const memberships = byPerson.get(person)!;

    const subjectSsn = await ctx.world.personSsn(person);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `Which voluntary organizations does the person with SSN ${subjectSsn} belong to — congregations, gyms, sports teams, unions, civic or youth or fraternal groups?`,
        `Answer with the set of organization names as ADI returns them. Do not include their workplace or school.`,
        "For places, use an unambiguous name or full street address. An OSM reference (way/..., node/..., relation/...) returned in a record is also accepted.",
      ].join("\n"),
      evidence: { ssn: subjectSsn, classes: [...VOLUNTARY].sort() },
      answer: {
        kind: "id-set",
        description: "Names of every voluntary organization as ADI returns them; use a full street address to distinguish duplicate names.",
      },
      groundTruth: {
        organizations: memberships.map((m) => m.org).sort(),
        byClass: memberships,
      },
      scoring: {
        method: "set-f1",
        aggregate: "mean set precision/recall/F1",
      },
    };
  },
};

/**
 * "Who does this person work for, and where?"
 *
 * Two fields, weighted equally: the employer's name, and the street address of
 * the place they work.
 *
 * Every task has an address to find. A site with a name and no address is not
 * drawn: abstention scores zero, so a task whose address half has no right
 * answer would cap the score at one half by construction. An itinerant worker
 * (a driver whose day is the city) is asked about the base the register posts
 * them to, and the base's address is the truth.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { CANDIDATE_CREDIT } from "../../task.ts";

interface SiteRecord {
  id?: string;
  name?: string | null;
  address?: string | null;
}

const bare = (id: string) => id.replace(/^[a-z]:/i, "");

/**
 * Name and address for every site the registers hold, workplaces first.
 *
 * Dwellings are in here because an itinerant driver is posted to their own
 * house — the register's way of saying "the shift starts where they are" —
 * and the draw has to be able to see that the record has no name.
 */
async function siteIndex(ctx: Parameters<TaskGenerator["generate"]>[0]): Promise<Map<string, SiteRecord>> {
  const index = new Map<string, SiteRecord>();
  const add = (record: SiteRecord) => {
    if (!record?.id) return;
    const id = bare(record.id);
    if (!index.has(id)) index.set(id, record);
  };
  const workplaces = await ctx.world.workplaces();
  for (const record of workplaces.site_records ?? []) add(record);
  for (const record of (await ctx.world.orgs()).org_records ?? []) add(record);
  for (const record of (await ctx.world.schools()).school_records ?? []) add(record);
  for (const record of (await ctx.world.dwellings()).dwellings ?? []) add(record);
  return index;
}

export const workplaceId: TaskGenerator = {
  family: "workplace-id",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const employment = await ctx.world.employment();
    const assignments = employment.assignments;
    const sites = await siteIndex(ctx);

    const index = drawIndex(rng, assignments.length, (i) => {
      const assignment = assignments[i]!;
      // "home" puts the workplace at the dwelling and "external" leaves the
      // extract entirely; neither is a workplace this family can ask about.
      if (assignment.mode !== "sited" && assignment.mode !== "itinerant") return false;
      if (!assignment.site) return false;
      const site = sites.get(bare(assignment.site));
      if (!(site?.name ?? "").trim() || !(site?.address ?? "").trim()) return false;
      const row = persons.rowOf.get(assignment.person);
      return row !== undefined && persons.legCount[row]! >= 1;
    });

    const assignment = assignments[index]!;
    const site = sites.get(bare(assignment.site!))!;
    const employer = (site.name ?? "").trim();
    const address = (site.address ?? "").trim();

    const subjectSsn = await ctx.world.personSsn(assignment.person);

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `Who does the person with SSN ${subjectSsn} work for, and at what address?`,
        `Answer with the employer's name as ADI returns it, and the full street address of the place they work.`,
        "Give the address as an address. An OSM reference (way/..., node/..., relation/...) is not one and is not accepted here.",
      ].join("\n"),
      evidence: { ssn: subjectSsn },
      answer: {
        kind: "record",
        independentFields: true,
        description: "The employer and the address of the workplace.",
        fields: {
          employer: { kind: "text", candidateCredit: CANDIDATE_CREDIT, description: "The employer's name as ADI returns it." },
          address: { kind: "text", candidateCredit: CANDIDATE_CREDIT, description: "Full street address of the workplace." },
        },
      },
      groundTruth: {
        site: assignment.site,
        employer,
        address,
        addressable: true,
        mode: assignment.mode,
      },
      scoring: {
        method: "record",
        params: { fields: { employer: "top1", address: "top1" } },
        aggregate: "employer accuracy and address accuracy, weighted equally",
      },
    };
  },
};

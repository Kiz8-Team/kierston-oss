/**
 * The social graph, as the handful of numbers that describe 3.3 million edges.
 *
 * Nothing here looks at an individual tie. What a baseline needs from a graph
 * is its shape — the degree distribution, which is the thing that moves when
 * an intercept is retuned, and the mix of kinds and foci behind it. Degree is
 * recorded per age band as well, because a change in the school or workplace
 * model shows up there long before it shows up in the mean.
 *
 * The two ratings stay apart. Exposure and affinity are independent by
 * construction — the colleague on the next pick line and the golf partner sit
 * at opposite corners — so they are profiled separately and crossed, rather
 * than averaged into a strength that would hide a model that had started
 * conflating them.
 *
 * Homophily is the one derived measure: the share of ties that join two people
 * of the same sex or race, and the age gap across them. Those are what a
 * mixing model is for, and they are stable under a change of city size.
 */

import { columns, type Envelope } from "../format.ts";
import { Builder, Cat, Num, ageBand, band } from "../metrics.ts";
import type { Population } from "../population.ts";

export function analyseTies(b: Builder, env: Envelope, pop: Population | null): void {
  const meta = env.meta;
  const a = columns(env);
  const edges = meta.edges as number;
  const left = a.a as Int32Array;
  const right = a.b as Int32Array;
  const kinds = a.kind as Uint8Array;
  const foci = a.focus as Uint16Array;
  const exposure = a.exposure as Uint8Array;
  const affinity = a.affinity as Uint8Array;
  const valence = a.valence as Int8Array;
  const since = a.since as Uint16Array;

  b.scalar("ties.count.edges", edges);
  b.scalar("ties.count.abroadStubs", meta.stubs?.abroad?.length ?? 0);
  b.scalar("ties.count.formerStubs", meta.stubs?.former?.length ?? 0);
  for (const [focus, intercept] of Object.entries(meta.intercepts ?? {})) {
    b.scalar(`ties.intercept.${focus}`, intercept as number, "rate");
  }

  const kindCat = new Cat();
  const focusCat = new Cat();
  const tierCat = new Cat();
  const valenceCat = new Cat();
  const kindByTier = new Cat();
  const exposureNum = new Num();
  const affinityNum = new Num();
  const sinceNum = new Num();
  const exposureByKind = new Map<string, Num>();
  const affinityByKind = new Map<string, Num>();
  const exposureBand = new Cat();
  const affinityBand = new Cat();
  const ageGap = new Num();
  const residents = pop?.residents ?? 0;
  const degrees = new Int32Array(residents);
  const closeDegrees = new Int32Array(residents);
  let external = 0;
  let sameSex = 0;
  let sameRace = 0;
  let bothResident = 0;
  let selfLoop = 0;
  let unordered = 0;

  const tiers = (meta.tiers ?? []) as [number, string][];
  const tierOf = (value: number) => {
    for (const [floor, name] of tiers) if (value >= floor) return name;
    return tiers.length ? tiers[tiers.length - 1][1] : "—";
  };

  for (let e = 0; e < edges; e += 1) {
    const x = left[e];
    const y = right[e];
    const kind = meta.kinds[kinds[e]] ?? String(kinds[e]);
    const strength = affinity[e] / 255;
    const contact = exposure[e] / 255;
    kindCat.add(kind);
    tierCat.add(tierOf(strength));
    kindByTier.add(`${kind} × ${tierOf(strength)}`);
    valenceCat.add(valence[e] > 0 ? "positive" : valence[e] < 0 ? "negative" : "neutral");
    exposureNum.push(contact);
    affinityNum.push(strength);
    exposureBand.add(band(Math.round(contact * 100), [0, 10, 25, 50, 75, 90], "%"));
    affinityBand.add(band(Math.round(strength * 100), [0, 10, 25, 50, 75, 90], "%"));
    if (since[e]) sinceNum.push(since[e]);
    if (!exposureByKind.has(kind)) {
      exposureByKind.set(kind, new Num());
      affinityByKind.set(kind, new Num());
    }
    exposureByKind.get(kind)!.push(contact);
    affinityByKind.get(kind)!.push(strength);

    let bits = foci[e];
    if (!bits) focusCat.add("—");
    for (let bit = 0; bits; bit += 1, bits >>>= 1) {
      if (bits & 1) focusCat.add(meta.foci[bit] ?? `bit ${bit}`);
    }

    if (x === y) selfLoop += 1;
    if (x > y) unordered += 1;
    const xResident = x < residents;
    const yResident = y < residents;
    if (xResident) { degrees[x] += 1; if (strength >= (tiers[1]?.[0] ?? 0.5)) closeDegrees[x] += 1; }
    if (yResident) { degrees[y] += 1; if (strength >= (tiers[1]?.[0] ?? 0.5)) closeDegrees[y] += 1; }
    if (!xResident || !yResident) external += 1;
    else if (pop) {
      bothResident += 1;
      if (pop.sex(x) === pop.sex(y)) sameSex += 1;
      if (pop.race(x) === pop.race(y)) sameRace += 1;
      ageGap.push(Math.abs(pop.age(x) - pop.age(y)));
    }
  }

  b.cat("ties.kind", kindCat);
  b.cat("ties.focus", focusCat);
  b.cat("ties.tier", tierCat);
  b.cat("ties.valence", valenceCat);
  b.cat("ties.kind×tier", kindByTier);
  b.num("ties.exposure", exposureNum);
  b.num("ties.affinity", affinityNum);
  b.cat("ties.exposureBand", exposureBand);
  b.cat("ties.affinityBand", affinityBand);
  b.num("ties.sinceYear", sinceNum);
  for (const [kind, sketch] of exposureByKind) b.num(`ties.exposure.by.kind.${kind}`, sketch);
  for (const [kind, sketch] of affinityByKind) b.num(`ties.affinity.by.kind.${kind}`, sketch);
  b.countAndShare("ties.external", external, edges);
  b.invariant("ties.invariant.selfLoop", "nobody is tied to themselves", selfLoop, edges);
  b.invariant("ties.invariant.canonicalOrder", "every edge is stored with the lower id first", unordered, edges);

  if (!pop) return;

  b.num("ties.degree", degrees);
  b.num("ties.closeDegree", closeDegrees);
  b.num("ties.ageGap", ageGap);
  b.scalar("ties.homophily.sameSex", bothResident ? sameSex / bothResident : 0, "share");
  b.scalar("ties.homophily.sameRace", bothResident ? sameRace / bothResident : 0, "share");

  let isolated = 0;
  const degreeByAge = new Map<string, Num>();
  const degreeBySex = new Map<string, Num>();
  const isolatedByAge = new Map<string, [number, number]>();
  for (let id = 0; id < residents; id += 1) {
    const bandName = ageBand(pop.age(id));
    if (!degreeByAge.has(bandName)) degreeByAge.set(bandName, new Num());
    degreeByAge.get(bandName)!.push(degrees[id]);
    const sex = pop.sex(id);
    if (!degreeBySex.has(sex)) degreeBySex.set(sex, new Num());
    degreeBySex.get(sex)!.push(degrees[id]);
    const cell = isolatedByAge.get(bandName) ?? [0, 0];
    cell[0] += degrees[id] === 0 ? 1 : 0;
    cell[1] += 1;
    isolatedByAge.set(bandName, cell);
    if (degrees[id] === 0) isolated += 1;
  }
  b.countAndShare("ties.isolated", isolated, residents);
  for (const [key, sketch] of [...degreeByAge].sort()) b.num(`ties.degree.by.ageBand.${key}`, sketch);
  for (const [key, sketch] of degreeBySex) b.num(`ties.degree.by.sex.${key}`, sketch);
  for (const [key, [alone, total]] of [...isolatedByAge].sort()) {
    b.scalar(`ties.isolated.by.ageBand.${key}`, total ? alone / total : 0, "share");
  }
}

/**
 * "Which movement or venue produced this card charge?"
 *
 * One approved card payment with a venue behind it, quoted the way a bank
 * statement would hold it — merchant, amount, minute — and the answer is
 * the venue visited and when the visit began, read from the person's own
 * stays at selection time.
 *
 * The visit is found by venue id: the person's schedule entries whose
 * `where` is the charge's venue give the visit windows, and the stay that
 * overlaps the chosen window most is the visit. Leg labels are display text
 * and never equal a venue id, so they are not used.
 *
 * The merchant name is quoted in the prompt, so it is not accepted as the
 * venue answer: the venue field asks for the street address, and only
 * strings that carry the address (the address alone, or name and address)
 * are accepted. A venue whose address does not single it out is not drawn.
 */

import type { TaskGenerator } from "../../generator.ts";
import { drawIndex, taskId } from "../../generator.ts";
import { clock, degrees } from "../../format.ts";
import { NONE } from "../../kday.ts";
import { foldPlaceText } from "../../places.ts";

export const transactionToVisit: TaskGenerator = {
  family: "transaction-to-visit",

  async generate(ctx, rng, seed) {
    const persons = await ctx.persons();
    const tx = await ctx.day.columns(
      "tx.person", "tx.minute", "tx.amount", "tx.kind", "tx.approved",
      "tx.merchant", "tx.mcc", "tx.venue", "tx.latE6", "tx.lonE6",
    );
    const txKinds = ctx.day.enumValues("txKind");

    let index = -1;
    let visit: Awaited<ReturnType<typeof ctx.staysOf>>[number] | null = null;
    let venue = "";
    let merchant: string | null = null;
    let written: NonNullable<Awaited<ReturnType<typeof ctx.world.venueText>>> | null = null;
    let accepted: string[] = [];
    const places = await ctx.world.places();
    const schedule = await ctx.day.columns("schedule.start", "schedule.end", "schedule.where");
    for (let attempt = 0; attempt < 200 && !visit; attempt += 1) {
      // Any approved charge raised at a venue: point-of-sale payments carry
      // one, bills and transfers do not, so the venue is the eligibility.
      index = drawIndex(rng, tx.person.length, (i) => {
        if (tx.approved[i]! === 0) return false;
        if (tx.venue[i]! === NONE) return false;
        return persons.rowOf.has(tx.person[i]!);
      });
      const minute = tx.minute[index]!;
      venue = ctx.day.string(tx.venue[index]!)!;
      merchant = ctx.day.string(tx.merchant[index]!);
      const quoted = foldPlaceText(merchant ?? "");

      // The venue has to be something an answer can say, and the quoted
      // merchant name is not an answer. A shop is on no register the scorer
      // resolves, so the strings that denote it are taken from the points of
      // interest and travel with the truth; any that is the merchant name is
      // dropped. A registered place needs an address of its own that names it
      // alone.
      written = await ctx.world.venueText(merchant, degrees(tx.latE6[index]!), degrees(tx.lonE6[index]!));
      accepted = (written?.accepted ?? []).filter((text) => foldPlaceText(text) !== quoted);
      if (accepted.length === 0) {
        if (!(await ctx.world.observable(venue))) continue;
        const address = places.textOf(venue).address;
        const match = address ? places.resolve(address) : null;
        if (!match || match.ids.length !== 1 || match.ids[0] !== places.same(venue) || foldPlaceText(address) === quoted) continue;
      }

      // The visit that produced the charge, matched by venue id: the
      // schedule entry at this venue covering the charge minute, or failing
      // that the one starting nearest it; then the stay overlapping it most.
      const row = persons.rowOf.get(tx.person[index]!)!;
      const offset = persons.scheduleOffset[row]!;
      const entries: { start: number; end: number }[] = [];
      for (let entry = offset; entry < offset + persons.scheduleCount[row]!; entry += 1) {
        if (schedule.where[entry]! === NONE || ctx.day.string(schedule.where[entry]!) !== venue) continue;
        entries.push({ start: schedule.start[entry]!, end: schedule.end[entry]! });
      }
      const entry = entries.find((candidate) => candidate.start <= minute && minute <= candidate.end)
        ?? entries.sort((a, b) => Math.abs(a.start - minute) - Math.abs(b.start - minute) || a.start - b.start)[0];
      if (!entry) continue;
      const stays = await ctx.staysOf(row);
      let best = 0;
      for (const stay of stays) {
        const overlap = Math.min(stay.endMinute, entry.end) - Math.max(stay.startMinute, entry.start);
        if (overlap > best) { best = overlap; visit = stay; }
      }
    }
    if (!visit) throw new Error("no charge with a locatable visit found");

    const person = tx.person[index]!;
    const minute = tx.minute[index]!;
    const subjectSsn = await ctx.world.personSsn(person);

    const charge = {
      ssn: subjectSsn,
      merchant,
      mcc: tx.mcc[index]!,
      amount: Math.round(tx.amount[index]! * 100) / 100,
      time: clock(minute),
    };

    return {
      id: taskId(this.family, ctx.date, seed),
      family: this.family,
      date: ctx.date,
      seed,
      prompt: [
        `A card used by the person with SSN ${subjectSsn} produced this charge on ${ctx.date}:`,
        JSON.stringify(charge, null, 2),
        `Which venue visit produced it? Answer with the full street address of the venue and the time the visit began (HH:MM).`,
      ].join("\n"),
      evidence: { charge },
      answer: {
        kind: "record",
        description: "The visit behind the charge.",
        fields: {
          venue: { kind: "id", description: "The full street address of the venue." },
          arrival: { kind: "time", description: "Visit start time, HH:MM; use hours 24+ for the following day." },
        },
      },
      groundTruth: {
        venue,
        venueName: written?.name ?? places.textOf(venue).name,
        venueAddress: written?.address ?? places.textOf(venue).address,
        venueAccepted: accepted,
        quotedMerchant: merchant,
        visitStartMinute: visit.startMinute,
        visitEndMinute: visit.endMinute,
      },
      scoring: {
        method: "record",
        params: { fields: { venue: "top1", arrival: "distance" } },
        aggregate: "venue top-1 accuracy; arrival-time MAE in minutes",
      },
    };
  },
};

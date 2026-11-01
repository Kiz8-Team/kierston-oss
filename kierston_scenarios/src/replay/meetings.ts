import { dayFromTimeline, RoutedMobility, products, shared, transport, type DayContext, type TravelEvent } from "../../../kierston/sim/src/index.ts";
import type { Baseline, RecordedDay } from "./baseline.ts";
import { idle, spliceTimeline, type Timeline } from "./movement.ts";
import { validateSharedJourneys } from "./validation.ts";
import type { Place, Purchase, Window } from "../authoring/dsl.ts";

/** Minutes a counterpart waits at the venue before giving up on the meeting. */
const STOOD_UP_WAIT = 15;
/** Modes a stood-up counterpart can be re-routed in without touching anyone else's journey. */
const OWN_MODES = ["walk", "car", "bike", "transit"];
/** Minutes either side of a meeting in which the payer's charge at its venue counts as the meeting's. */
const PAYMENT_SLACK = 5;

const meetStay = (timeline: Timeline, venue: string | null, start: number, end: number) =>
  timeline.find((event) => event.kind === "stay"
    && event.payload?.kind === "recorded" && event.payload.recordKind === "meet"
    && event.payload.where === venue && event.start < end && event.end > start);

/** Whether a person's current day still has them at the meeting. */
function attends(day: RecordedDay | undefined, venue: string | null, start: number, end: number): boolean {
  return !day || meetStay(day.day.scheduled.timeline, venue, start, end) !== undefined;
}

/** The payer a meeting keeps: its own if still there, else the lowest id of two or more left, else none. */
function payerOf(payer: number, kept: readonly number[]): number {
  if (payer < 0 || kept.includes(payer)) return payer;
  return kept.length >= 2 ? Math.min(...kept) : -1;
}

export interface MeetingRepair {
  /** Frozen counterparts left alone at a meeting, re-planned to wait and leave. */
  stoodUp: Map<number, { day: RecordedDay; window: Window; meeting: string }>;
  /** Remaining parties who take over the bill of a payer who left. */
  payers: Purchase[];
}

/**
 * Settle the meetings a re-planned person no longer attends, before the
 * downstream loop so that whoever this pulls in is simulated like any other
 * affected person.
 *
 *   - Two or more parties remain: the meeting stands. If the payer left, the
 *     remaining party with the lowest id pays the payer's recorded charge at
 *     the venue, at the same minute clamped into their own stay.
 *   - Fewer than two remain: each remaining frozen party waits
 *     `STOOD_UP_WAIT` minutes at the venue and then leaves for wherever their
 *     day went next, arriving by the time their recorded departure did, in
 *     the same kind of mode and with the same car. The
 *     replacement window runs from the start of the stay to the end of that
 *     departure, so the venue charge inside it is dropped by `settleActor`.
 *     A counterpart whose way on is shared (a ride, a taxi, a school run),
 *     who stays to midnight, who has a scenario window already, or whose
 *     re-route does not fit, keeps the
 *     recorded stay: a party of one, which the engine's own export also keeps
 *     (export/day.ts, `stoodUp`).
 *
 * `updateMeetings` later rewrites the party list and payer by the same rules.
 */
export async function repairMeetings(
  context: DayContext, baseline: Baseline, changed: ReadonlyMap<number, RecordedDay>,
  windows: ReadonlyMap<number, readonly Window[]>, date: Date,
): Promise<MeetingRepair> {
  const out: MeetingRepair = { stoodUp: new Map(), payers: [] };
  const file = baseline.file;
  if (!changed.size || !file.has("meeting.partyOffset")) return out;
  const [meetings, parties] = await Promise.all([file.table("meeting"), file.table("party")]);
  const current = (person: number): RecordedDay | undefined => out.stoodUp.get(person)?.day ?? changed.get(person);
  for (let i = 0; i < meetings.start!.length; i++) {
    const start = meetings.start![i]!, end = meetings.end![i]!;
    const venue = file.string(meetings.venue![i]!);
    const key = file.string(meetings.key![i]!) ?? `${i}`;
    const members = Array.from(parties.person!.subarray(meetings.partyOffset![i]!, meetings.partyOffset![i]! + meetings.partyCount![i]!));
    const left = members.filter((person) => !attends(changed.get(person), venue, start, end));
    if (!left.length) continue;
    const remaining = members.filter((person) => !left.includes(person));
    if (remaining.length >= 2) {
      const payer = meetings.payer?.[i] ?? -1;
      const next = payerOf(payer, remaining);
      if (next === payer || next < 0) continue;
      const bill = await billOf(baseline, payer, venue, start, end);
      if (!bill) continue;
      const day = current(next) ?? await baseline.person(next);
      const stay = meetStay(day.day.scheduled.timeline, venue, start, end);
      const record = venue ? context.venues.get(venue) : undefined;
      if (!stay || stay.kind !== "stay" || !record || record.mcc === undefined) continue;
      const at = Math.max(stay.start, Math.min(stay.end - 1, bill.at));
      const place: Place = { ...stay.place, venue: record };
      out.payers.push({ kind: "purchase", id: `meeting/${key}/payer/${next}`, person: next, at,
        channel: "in_person", amount: bill.amount, venue: place });
      continue;
    }
    for (const person of remaining) {
      if (changed.has(person) || windows.has(person) || out.stoodUp.has(person)) continue;
      const replanned = await standUp(context, baseline, person, venue, start, end, key, date);
      if (replanned) out.stoodUp.set(person, { ...replanned, meeting: key });
    }
  }
  return out;
}

/** The payer's recorded payments at the venue around the meeting: their sum and the last minute. */
async function billOf(baseline: Baseline, payer: number, venue: string | null, start: number, end: number): Promise<{ amount: number; at: number } | null> {
  const row = baseline.people.get(payer);
  if (row === undefined || venue === null) return null;
  const file = baseline.file;
  const [p, tx] = await Promise.all([file.table("person"), file.table("tx")]);
  let amount = 0, at = -1;
  for (let i = p.txOffset![row]!; i < p.txOffset![row]! + p.txCount![row]!; i++) {
    if (file.header.enums.txKind?.[tx.kind![i]!] !== "payment" || file.string(tx.venue![i]!) !== venue) continue;
    const minute = tx.minute![i]!;
    if (minute < start - PAYMENT_SLACK || minute > end + PAYMENT_SLACK) continue;
    amount += tx.amount![i]!; at = Math.max(at, minute);
  }
  return at < 0 ? null : { amount: Math.round(amount * 100) / 100, at };
}

async function standUp(
  context: DayContext, baseline: Baseline, person: number, venue: string | null, start: number, end: number, key: string, date: Date,
): Promise<{ day: RecordedDay; window: Window } | null> {
  const recorded = await baseline.person(person);
  const timeline = [...recorded.day.scheduled.timeline].sort((a, b) => a.start - b.start || a.end - b.end);
  const stay = meetStay(timeline, venue, start, end);
  if (!stay || stay.kind !== "stay" || stay.end - stay.start <= STOOD_UP_WAIT) return null;
  if ((context.state?.openingFor(person)?.resumeAt ?? 0) > stay.start) return null;
  // The way on: the travel straight after the stay, up to the next stay.
  const departure: TravelEvent[] = [];
  for (const event of timeline) {
    if (event.start < stay.end) continue;
    if (event.kind !== "travel") break;
    departure.push(event);
  }
  // A stay that runs to midnight has no way on to rejoin; the closing
  // vehicle state would also disagree with an invented drive home.
  if (!departure.length || departure.some((event) => !OWN_MODES.includes(event.mode))) return null;
  const mode = departure.some((event) => event.mode === "car") ? "car"
    : departure.some((event) => event.mode === "transit") ? "transit"
      : departure.some((event) => event.mode === "bike") ? "bike" : "walk";
  const window: Window = { start: stay.start, end: departure.at(-1)!.end };
  if (window.end > 1440) return null;
  const target = departure.at(-1)!.to;
  let vehicle: transport.Place | null | undefined = context.state?.openingFor(person)?.vehicle?.location;
  for (const event of timeline) {
    if (event.kind === "travel" && event.end <= stay.start && ["car", "carpool"].includes(event.mode)) vehicle = event.to;
  }
  const leave = stay.start + STOOD_UP_WAIT;
  const mobility = new RoutedMobility({ roads: context.roads, kerb: context.kerb, seed: context.world.seed }, context.world.persons);
  const back = mobility.transition({ person, day: shared.dayNumber(date), from: stay.place, to: target, depart: leave,
    purpose: "home", override: { mode, journeyId: `scenario/stood-up/${person}/${key}` }, vehicleAt: vehicle });
  if (!back || back.arrive > window.end) return null;
  const inserted: Timeline = [
    ...idle(stay.place, stay.start, leave, `scenario/stood-up/wait/${person}/${key}`),
    ...back.events,
    ...idle(target, back.arrive, window.end, `scenario/stood-up/end/${person}/${key}`),
  ];
  let spliced: Timeline;
  try { spliced = spliceTimeline(recorded.day.scheduled.timeline, window, inserted); } catch { return null; }
  const lastDrive = spliced.filter((event): event is TravelEvent => event.kind === "travel"
    && event.end <= 1440 && ["car", "carpool"].includes(event.mode)).at(-1);
  const day: RecordedDay = { ...recorded, paths: new Map(recorded.paths),
    day: dayFromTimeline(person, spliced, lastDrive?.to ?? context.state?.openingFor(person)?.vehicle?.location) };
  // Never break a journey somebody else shares; keep the recorded stay instead.
  try { await validateSharedJourneys(baseline, new Map([[person, day]])); } catch { return null; }
  return { day, window };
}

/** Rewrite the party list and payer of every meeting, and drop meetings nobody attended. */
export async function updateMeetings(file: products.KdayFile, changed: ReadonlyMap<number, RecordedDay>): Promise<void> {
  if (!file.has("meeting.partyOffset")) return;
  const [meetings, parties] = await Promise.all([file.table("meeting"), file.table("party")]);
  const people: number[] = [], roles: number[] = [];
  const keep = new Uint8Array(meetings.start!.length);
  for (let i = 0; i < meetings.start!.length; i++) {
    const at = people.length, before = meetings.partyCount![i]!;
    const venue = file.string(meetings.venue![i]!);
    for (let j = meetings.partyOffset![i]!; j < meetings.partyOffset![i]! + meetings.partyCount![i]!; j++) {
      const person = parties.person![j]!;
      if (!attends(changed.get(person), venue, meetings.start![i]!, meetings.end![i]!)) continue;
      people.push(person); roles.push(parties.role![j]!);
    }
    meetings.partyOffset![i] = at; meetings.partyCount![i] = people.length - at;
    if (meetings.payer) meetings.payer[i] = payerOf(meetings.payer[i]!, people.slice(at));
    // A party of one is a true row (somebody went and sat there); a meeting
    // the scenario emptied is not one. Rows recorded empty stay as they were.
    keep[i] = meetings.partyCount![i]! > 0 || before === 0 ? 1 : 0;
  }
  for (const [field, values] of Object.entries(meetings)) {
    const kept: number[] = [];
    for (let i = 0; i < values.length; i++) if (keep[i]) kept.push(values[i]!);
    file.set(`meeting.${field}`, kept);
  }
  file.set("party.person", people); file.set("party.role", roles); file.header.counts.parties = people.length;
  if ("meetings" in file.header.counts) file.header.counts.meetings = file.count("meeting.start");
}

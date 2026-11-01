/**
 * One person, packed.
 *
 * Split out of `day.ts` when the export learned to plan in parallel, and the
 * split is along the only line that matters: everything in this file is a
 * function of one person and the static city, and everything left in `day.ts`
 * is a fact about the whole run — the string table, the offsets one person's
 * rows sit at, the conversations, the file.
 *
 * That is why the columns here are *local*. A worker packs its shard into its
 * own `DayColumns` with its own `Strings`, and `day.ts` concatenates the
 * shards and rebases the offsets; a serial run passes one bag through every
 * person and there is nothing to rebase. Both call this function, so the two
 * paths cannot drift — and because every draw inside it is keyed on the
 * person's own id, they produce the same bytes.
 */

import type { DayContext } from "../engine/index.ts";
import { entries, planDay, type Day } from "../scheduler/index.ts";
import type { Timings } from "../shared/index.ts";
import { HOME_LABEL, haversineKm, type Leg, type Place } from "../transport/index.ts";
import { BILL_KINDS, billsDue, incomeDue, settleDay, type Posted } from "../economy/index.ts";
import { emptyDayNetwork, type DayNetwork, type HandsetHold } from "../network/index.ts";
import { homeOf, type Person, type Point } from "../world/index.ts";
import type { RadioDay } from "../network/index.ts";
import type { Meeting } from "../activities/social/index.ts";
import { observationOf, type Attention, type Observation } from "../comms/index.ts";

/** No value, in a u32 string reference. */
export const NONE = 0xffffffff;
/** The same absence, in a byte column. */
export const NONE_U8 = 0xff;
/** And in a signed coordinate one, where every real value is a microdegree. */
export const NONE_I32 = 0x7fffffff;

export const microdegrees = (value: number) => Math.round(value * 1e6);

/** One journey may contain multiple driver legs: include its time interval. */
export function pathKey(leg: Pick<Leg, "journeyId" | "depart" | "arrive">): string {
  return `${leg.journeyId ?? ""}\0${leg.depart}\0${leg.arrive}`;
}

// Appended to, never reordered — the viewer reads these indices out of the
// header, and an old file's `2` has to keep meaning what it meant when written.
export const KINDS = ["work", "school", "affiliation", "stop", "sleep", "meet", "incident"] as const;
export const MODES = [
  "car", "carpool", "transit", "walk", "bike", "taxi", "cab", "bus", "passenger", "other",
  "patrol", "ambulance",
] as const;
export const PURPOSES = [
  "work", "home", "stop", "affiliation", "vehicle", "school", "escort", "run", "fare",
  "deadhead", "meet", "patrol", "response",
] as const;
export const TX_KINDS = ["payment", "transfer_in", "withdrawal", "card_payment"] as const;
/**
 * Why the charge was raised, which is finer than the merchant category it was
 * charged against. See `Posted` in spend.ts: MCC 5411 is every grocer in the
 * city and cannot say whether this was the week's shop or a milk run.
 */
export const REASONS = [
  "grocery", "convenience", "cafe", "food-quick", "food-sit", "bar", "fuel",
  "pharmacy", "health", "personal", "errand", "retail", "vehicle", "park",
  "fare", "transit", "parking", "withdrawal",
  // Everything `bills.ts` raises, spread from its own list rather than copied:
  // the two have to agree, and a reason the viewer cannot name is a reason it
  // renders as a blank cell.
  ...BILL_KINDS,
  // What arrives, which the ledger has to name as much as what leaves.
  "wages", "benefit",
] as const;

export const INSTRUMENTS = ["debit", "credit", "cash", "ach", "check"] as const;
export const DECLINES = [
  "no_position", "insufficient_funds", "no_instrument", "invalid_amount",
] as const;

/**
 * The strings a run has seen, and the id each was given.
 *
 * One per packing process rather than one per file: a worker interns into its
 * own table and `day.ts` remaps the ids as it concatenates, in the order the
 * rows are read. That remapping is what keeps a parallel file byte-identical
 * to a serial one — the table comes out in the order the *people* were packed
 * and not in the order the workers happened to finish.
 */
export class Strings {
  readonly values: string[] = [];
  private readonly ids = new Map<string, number>();

  constructor(existing: readonly string[] = []) {
    for (const value of existing) {
      if (!this.ids.has(value)) this.ids.set(value, this.values.length);
      this.values.push(value);
    }
  }

  id(value: string | null): number {
    if (value === null) return NONE;
    const known = this.ids.get(value);
    if (known !== undefined) return known;
    const id = this.values.length;
    this.values.push(value);
    this.ids.set(value, id);
    return id;
  }
}

export type TypeName = "u8" | "u32" | "i32" | "f32";
export type NumberArray = Uint8Array | Uint32Array | Int32Array | Float32Array;

export const ARRAYS = {
  u8: Uint8Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array,
} as const;

/**
 * The tables one person contributes rows to.
 *
 * Named because a concatenation has to know two things about every column: how
 * many rows of it a shard held, and which table's row count an offset column
 * has to be shifted by. Both are this.
 */
export type Table =
  | "person" | "schedule" | "leg" | "path" | "tx" | "span" | "event" | "attention";

/** Everything the per-person loop writes, as plain arrays. */
export interface DayColumns {
  personId: number[];
  personScheduleOffset: number[]; personScheduleCount: number[];
  personLegOffset: number[]; personLegCount: number[];
  personTxOffset: number[]; personTxCount: number[];
  personSpanOffset: number[]; personSpanCount: number[];
  personEventOffset: number[]; personEventCount: number[];
  personAttentionOffset: number[]; personAttentionCount: number[];
  scheduleStart: number[]; scheduleEnd: number[]; scheduleKind: number[];
  scheduleLabel: number[]; scheduleWhere: number[];
  legDepart: number[]; legArrive: number[]; legMode: number[]; legPurpose: number[];
  legJourney: number[]; legVehicle: number[];
  legFromLat: number[]; legFromLon: number[]; legToLat: number[]; legToLon: number[];
  legKm: number[]; legEstimated: number[]; legWait: number[];
  legFromLabel: number[]; legToLabel: number[];
  legPathOffset: number[]; legPathCount: number[];
  pathLat: number[]; pathLon: number[];
  txPerson: number[]; txMinute: number[]; txAmount: number[]; txKind: number[]; txReason: number[];
  txApproved: number[]; txDecline: number[]; txInstrument: number[];
  txMcc: number[]; txMerchant: number[]; txAccount: number[]; txCard: number[];
  txNetwork: number[]; txVenue: number[]; txBalanceAfter: number[];
  txLat: number[]; txLon: number[];
  spanSubscriber: number[]; spanCell: number[]; spanStart: number[]; spanEnd: number[];
  spanRsrp: number[]; spanExposure: number[]; spanConnected: number[];
  spanTa: number[]; spanSecondary: number[];
  eventSubscriber: number[]; eventMinute: number[]; eventKind: number[];
  eventCell: number[]; eventPrevious: number[]; eventCause: number[];
  eventTa: number[]; eventSecondary: number[];
  attentionStart: number[]; attentionLevel: number[]; attentionAsleep: number[];
}

export type Field = keyof DayColumns;

/**
 * One packed column: its name in the file, the field it comes from, its type,
 * which table it is a row of, and — where it holds an index into another table
 * — which table's rows that index counts.
 *
 * The last two fields are what make concatenating shards mechanical rather
 * than a hundred hand-written additions. `strings` marks the columns holding
 * ids into the string table, which are remapped rather than shifted.
 */
export interface ColumnSpec {
  name: string;
  field: Field;
  type: TypeName;
  of: Table;
  rebase?: Table;
  strings?: true;
}

export const PERSON_COLUMNS: readonly ColumnSpec[] = [
  { name: "person.id", field: "personId", type: "u32", of: "person" },
  { name: "person.scheduleOffset", field: "personScheduleOffset", type: "u32", of: "person", rebase: "schedule" },
  { name: "person.scheduleCount", field: "personScheduleCount", type: "u32", of: "person" },
  { name: "person.legOffset", field: "personLegOffset", type: "u32", of: "person", rebase: "leg" },
  { name: "person.legCount", field: "personLegCount", type: "u32", of: "person" },
  { name: "person.txOffset", field: "personTxOffset", type: "u32", of: "person", rebase: "tx" },
  { name: "person.txCount", field: "personTxCount", type: "u32", of: "person" },
  { name: "schedule.start", field: "scheduleStart", type: "i32", of: "schedule" },
  { name: "schedule.end", field: "scheduleEnd", type: "i32", of: "schedule" },
  { name: "schedule.kind", field: "scheduleKind", type: "u8", of: "schedule" },
  { name: "schedule.label", field: "scheduleLabel", type: "u32", of: "schedule", strings: true },
  { name: "schedule.where", field: "scheduleWhere", type: "u32", of: "schedule", strings: true },
  { name: "leg.depart", field: "legDepart", type: "i32", of: "leg" },
  { name: "leg.arrive", field: "legArrive", type: "i32", of: "leg" },
  { name: "leg.mode", field: "legMode", type: "u8", of: "leg" },
  { name: "leg.purpose", field: "legPurpose", type: "u8", of: "leg" },
  { name: "leg.journey", field: "legJourney", type: "u32", of: "leg", strings: true },
  { name: "leg.vehicle", field: "legVehicle", type: "u32", of: "leg", strings: true },
  { name: "leg.fromLatE6", field: "legFromLat", type: "i32", of: "leg" },
  { name: "leg.fromLonE6", field: "legFromLon", type: "i32", of: "leg" },
  { name: "leg.toLatE6", field: "legToLat", type: "i32", of: "leg" },
  { name: "leg.toLonE6", field: "legToLon", type: "i32", of: "leg" },
  { name: "leg.kilometres", field: "legKm", type: "f32", of: "leg" },
  { name: "leg.estimated", field: "legEstimated", type: "u8", of: "leg" },
  { name: "leg.wait", field: "legWait", type: "f32", of: "leg" },
  { name: "leg.fromLabel", field: "legFromLabel", type: "u32", of: "leg", strings: true },
  { name: "leg.toLabel", field: "legToLabel", type: "u32", of: "leg", strings: true },
  { name: "leg.pathOffset", field: "legPathOffset", type: "u32", of: "leg", rebase: "path" },
  { name: "leg.pathCount", field: "legPathCount", type: "u32", of: "leg" },
  { name: "path.latE6", field: "pathLat", type: "i32", of: "path" },
  { name: "path.lonE6", field: "pathLon", type: "i32", of: "path" },
  { name: "tx.person", field: "txPerson", type: "u32", of: "tx" },
  { name: "tx.minute", field: "txMinute", type: "i32", of: "tx" },
  { name: "tx.amount", field: "txAmount", type: "f32", of: "tx" },
  { name: "tx.kind", field: "txKind", type: "u8", of: "tx" },
  { name: "tx.reason", field: "txReason", type: "u8", of: "tx" },
  { name: "tx.approved", field: "txApproved", type: "u8", of: "tx" },
  { name: "tx.decline", field: "txDecline", type: "u8", of: "tx" },
  { name: "tx.instrument", field: "txInstrument", type: "u8", of: "tx" },
  { name: "tx.mcc", field: "txMcc", type: "u32", of: "tx" },
  { name: "tx.merchant", field: "txMerchant", type: "u32", of: "tx", strings: true },
  { name: "tx.account", field: "txAccount", type: "u32", of: "tx", strings: true },
  { name: "tx.card", field: "txCard", type: "u32", of: "tx", strings: true },
  { name: "tx.network", field: "txNetwork", type: "u32", of: "tx", strings: true },
  { name: "tx.venue", field: "txVenue", type: "u32", of: "tx", strings: true },
  { name: "tx.balanceAfter", field: "txBalanceAfter", type: "f32", of: "tx" },
  { name: "tx.latE6", field: "txLat", type: "i32", of: "tx" },
  { name: "tx.lonE6", field: "txLon", type: "i32", of: "tx" },
  { name: "person.spanOffset", field: "personSpanOffset", type: "u32", of: "person", rebase: "span" },
  { name: "person.spanCount", field: "personSpanCount", type: "u32", of: "person" },
  { name: "person.eventOffset", field: "personEventOffset", type: "u32", of: "person", rebase: "event" },
  { name: "person.eventCount", field: "personEventCount", type: "u32", of: "person" },
  { name: "span.subscriber", field: "spanSubscriber", type: "u32", of: "span" },
  { name: "span.cell", field: "spanCell", type: "i32", of: "span" },
  { name: "span.start", field: "spanStart", type: "i32", of: "span" },
  { name: "span.end", field: "spanEnd", type: "i32", of: "span" },
  { name: "span.rsrp", field: "spanRsrp", type: "f32", of: "span" },
  { name: "span.exposure", field: "spanExposure", type: "u8", of: "span" },
  { name: "span.connected", field: "spanConnected", type: "i32", of: "span" },
  { name: "span.ta", field: "spanTa", type: "i32", of: "span" },
  { name: "span.secondary", field: "spanSecondary", type: "i32", of: "span" },
  { name: "event.subscriber", field: "eventSubscriber", type: "u32", of: "event" },
  { name: "event.minute", field: "eventMinute", type: "i32", of: "event" },
  { name: "event.kind", field: "eventKind", type: "u8", of: "event" },
  { name: "event.cell", field: "eventCell", type: "i32", of: "event" },
  { name: "event.previous", field: "eventPrevious", type: "i32", of: "event" },
  { name: "event.cause", field: "eventCause", type: "u8", of: "event" },
  { name: "event.ta", field: "eventTa", type: "i32", of: "event" },
  { name: "event.secondary", field: "eventSecondary", type: "i32", of: "event" },
  { name: "person.attentionOffset", field: "personAttentionOffset", type: "u32", of: "person", rebase: "attention" },
  { name: "person.attentionCount", field: "personAttentionCount", type: "u32", of: "person" },
  { name: "attention.start", field: "attentionStart", type: "u32", of: "attention" },
  { name: "attention.level", field: "attentionLevel", type: "u8", of: "attention" },
  { name: "attention.asleep", field: "attentionAsleep", type: "u8", of: "attention" },
];

/**
 * The columns holding a string id, in the order one person's rows touch them.
 *
 * The order is the contract. A serial run interns as it packs — every entry's
 * label and place, then every leg's two ends and journey, then every transaction's five —
 * so a concatenation replaying exactly this walk produces exactly that table.
 */
export const STRING_ORDER: { table: Table; fields: readonly Field[] }[] = [
  { table: "schedule", fields: ["scheduleLabel", "scheduleWhere"] },
  { table: "leg", fields: ["legFromLabel", "legToLabel", "legJourney", "legVehicle"] },
  { table: "tx", fields: ["txMerchant", "txAccount", "txCard", "txNetwork", "txVenue"] },
];

export function emptyColumns(): DayColumns {
  const out = {} as Record<Field, number[]>;
  for (const spec of PERSON_COLUMNS) out[spec.field] = [];
  return out as DayColumns;
}

/** How many rows of each table a bag of columns holds. */
export function rowsIn(columns: DayColumns): Record<Table, number> {
  return {
    person: columns.personId.length,
    schedule: columns.scheduleStart.length,
    leg: columns.legDepart.length,
    path: columns.pathLat.length,
    tx: columns.txMinute.length,
    span: columns.spanSubscriber.length,
    event: columns.eventSubscriber.length,
    attention: columns.attentionStart.length,
  };
}

/** What packing one person produced that is not a column. */
export interface PersonPacked {
  /** Approved payments, for the run's total. */
  spent: number;
  /** What the communications layer needs from this day. */
  observation: Observation;
  /** The gatherings this person's timeline really sat at, for the meeting table. */
  attended: readonly Meeting[];
}

/**
 * Plan one person's day and write it into the columns.
 *
 * The order of the stages is not free. Legs are packed before the money
 * because the settlement reads the parking a leg decided on; the radio comes
 * after the legs because it interpolates positions along the routed paths;
 * the observation comes last because it reads the whole finished day.
 */
export function packPerson(
  context: DayContext,
  person: Person,
  date: Date,
  day: number,
  out: DayColumns,
  strings: Strings,
  radio: DayNetwork,
  timings: Timings,
  supplied: {
    planned?: Day;
    posted?: readonly Posted[];
    paths?: ReadonlyMap<string, Point[]>;
    radioActivity?: ReadonlyMap<number, Uint8Array>;
    /** The person's handsets lie somewhere else from a minute on; see `network/index.ts`. */
    handsetHold?: HandsetHold;
    /** The person keeps a working handset on them all day: no left-at-home, power-off or battery draw. */
    keepHandset?: boolean;
  } = {},
): PersonPacked {
  // One mark, moved along the person's stages. Every `since` returns the clock
  // it just read, so the row below charges the gap and nothing else.
  let mark = performance.now();
  const planned = supplied.planned ?? planDay(context, person, date, day);
  const homePoint = homeOf(context.world, person);
  const home: Place | null = homePoint
    ? { ...homePoint, id: null, kind: "home", label: HOME_LABEL }
    : null;
  mark = timings.since("plan", mark);

  out.personId.push(person.id);
  out.personScheduleOffset.push(out.scheduleStart.length);
  out.personLegOffset.push(out.legDepart.length);
  out.personTxOffset.push(out.txMinute.length);

  // Travel is dropped from the schedule table because it is already the leg
  // table, in more detail and with its geometry attached.
  const schedule = entries(planned).filter((entry) => entry.kind !== "travel");
  out.personScheduleCount.push(schedule.length);
  for (const entry of schedule) {
    out.scheduleStart.push(entry.at);
    out.scheduleEnd.push(entry.end);
    out.scheduleKind.push(KINDS.indexOf(entry.kind as typeof KINDS[number]));
    out.scheduleLabel.push(strings.id(entry.label));
    out.scheduleWhere.push(strings.id(entry.where));
  }

  const attended: Meeting[] = [];
  for (const event of planned.scheduled.timeline) {
    if (event.kind !== "stay" || event.payload?.kind !== "meet") continue;
    // The kerbside pickup is a stay of the same kind. Only the venue is the
    // gathering; the collection is a leg, and legs are already a table.
    if (event.place.kind !== "venue") continue;
    attended.push(event.payload.meeting);
  }
  mark = timings.since("pack schedule", mark);

  out.personLegCount.push(planned.legs.length);
  const paths: Point[][] = [];
  for (const leg of planned.legs) {
    const encoded = encodeLeg(context, leg, strings, out.pathLat, out.pathLon,
      supplied.paths?.get(pathKey(leg)) ?? (leg.journeyId ? supplied.paths?.get(leg.journeyId) : undefined));
    paths.push(encoded.path);
    out.legDepart.push(leg.depart);
    out.legArrive.push(leg.arrive);
    out.legMode.push(MODES.indexOf(leg.mode));
    out.legPurpose.push(PURPOSES.indexOf(leg.purpose));
    out.legJourney.push(strings.id(leg.journeyId ?? null));
    out.legVehicle.push(strings.id(leg.vehicleId ?? null));
    out.legFromLat.push(microdegrees(leg.from.lat));
    out.legFromLon.push(microdegrees(leg.from.lon));
    out.legToLat.push(microdegrees(leg.to.lat));
    out.legToLon.push(microdegrees(leg.to.lon));
    // The packed distance and packed geometry are one canonical fact. The
    // router's pricing distance excludes door-to-snap connectors, while the
    // KDAY path includes them; storing the latter prevents a structurally
    // self-disagreeing file for short trips.
    out.legKm.push(encoded.kilometres);
    out.legEstimated.push(leg.estimated ? 1 : 0);
    out.legWait.push(leg.wait ?? 0);
    out.legFromLabel.push(encoded.fromLabel);
    out.legToLabel.push(encoded.toLabel);
    out.legPathOffset.push(encoded.pathOffset);
    out.legPathCount.push(encoded.pathCount);
  }
  // Routing is in here, not in `plan`: `encodeLeg` asks the road graph for
  // each leg's geometry, which the planner priced and kept.
  mark = timings.since("route + pack legs", mark);

  // Settled after the day is planned and never during it: `spend.ts` says why
  // at length, and the short of it is that the planner throws days away and a
  // charge raised inside one would be a charge for a visit that never
  // happened. The balances this moves are the person's own, so packing people
  // in id order is not a claim about which of them shopped first — and it is
  // why a worker may settle its own shard without seeing anybody else's.
  const posted = supplied.posted ?? (context.bank
    ? settleDay(context.bank, context, person, planned, day,
                billsDue(context, person, date, day, planned),
                incomeDue(context, person, date, day))
    : []);
  out.personTxCount.push(posted.length);
  let spent = 0;
  for (const transaction of posted) {
    pushTransaction(transaction, strings, out);
    if (transaction.approved && transaction.kind === "payment") spent += transaction.amount;
  }
  mark = timings.since("settle money", mark);

  // The radio day, from the same plan and the same routed geometry. Run after
  // the legs so `paths` is complete, and outside the transaction block because
  // a phone's day does not depend on whether anyone is settling the money: a
  // run with `--money` and a run without must produce the same cellular
  // records for the same date.
  out.personSpanOffset.push(out.spanSubscriber.length);
  out.personEventOffset.push(out.eventSubscriber.length);
  let radioDay: RadioDay = { parted: null };
  if (context.network) {
    radio.spans.length = 0;
    radio.events.length = 0;
    radioDay = context.network.day(
      planned, homePoint, day, context.world.seed, paths, radio,
      context.state ? {
        opening: (subscriber) => context.state!.radioFor(subscriber),
        closing: (state) => context.state!.stageRadio(state),
      } : undefined,
      supplied.radioActivity,
      supplied.handsetHold,
      supplied.keepHandset ?? false,
    );
    for (const span of radio.spans) {
      out.spanSubscriber.push(span.subscriber);
      out.spanCell.push(span.cell);
      out.spanStart.push(span.start);
      out.spanEnd.push(span.end);
      out.spanRsrp.push(span.rsrp);
      out.spanExposure.push(span.exposure);
      out.spanConnected.push(span.connected);
      out.spanTa.push(span.ta);
      out.spanSecondary.push(span.secondary);
    }
    for (const event of radio.events) {
      out.eventSubscriber.push(event.subscriber);
      out.eventMinute.push(event.minute);
      out.eventKind.push(event.kind);
      out.eventCell.push(event.cell);
      out.eventPrevious.push(event.previous);
      out.eventCause.push(event.cause);
      out.eventTa.push(event.ta);
      out.eventSecondary.push(event.secondary);
    }
  }
  out.personSpanCount.push(out.spanSubscriber.length - out.personSpanOffset[out.personSpanOffset.length - 1]!);
  out.personEventCount.push(out.eventSubscriber.length - out.personEventOffset[out.personEventOffset.length - 1]!);
  mark = timings.since("radio day", mark);

  // Reading the day for the communications layer, which cannot resolve
  // anything yet: a reply depends on the recipient's day and most recipients
  // have not been planned. See `comms/index.ts`.
  const observation = observationOf(
    planned, person, context.world.assignments.get(person.id)?.occupation ?? null,
    context.world.seed, day,
  );
  // A phone left at home all day: the owner is out of reach while out of the
  // house. The curve says so too, so the stored attention and the comms layer
  // agree on when nothing could have been sent.
  if (radioDay.parted?.length && observation.attention.known) {
    observation.parted = radioDay.parted;
    for (const span of radioDay.parted) {
      observation.attention.minute.fill(0, span.from, span.until);
      observation.attention.asleep.fill(0, span.from, span.until);
    }
  }
  mark = timings.since("comms observe", mark);

  // The curve that reading just derived, packed while it is in hand. A person
  // whose day gave nothing to derive one from gets no runs, which is a real
  // state and not a gap: an off-map worker's day is surveyed rather than
  // planned, and somebody with no handset has no curve worth building. Both
  // are unreachable all day rather than quietly average.
  out.personAttentionOffset.push(out.attentionStart.length);
  pushAttention(observation.attention.known ? observation.attention : null, out);
  out.personAttentionCount.push(
    out.attentionStart.length - out.personAttentionOffset[out.personAttentionOffset.length - 1]!,
  );
  context.state?.stagePerson(planned, home);
  context.householdPlanner?.release(person.id);
  timings.since("pack attention", mark);

  return { spent, observation, attended };
}

/** Scratch the radio day is written into, reused across a shard's people. */
export function radioScratch(): DayNetwork {
  return emptyDayNetwork();
}

function encodeLeg(
  context: DayContext,
  leg: Leg,
  strings: Strings,
  pathLat: number[],
  pathLon: number[],
  suppliedPath?: Point[],
): {
  pathOffset: number; pathCount: number; fromLabel: number; toLabel: number;
  kilometres: number; path: Point[];
} {
  const pathOffset = pathLat.length;
  const path = suppliedPath ?? context.roads.path(leg.from, leg.to, leg.mode === "walk");
  let kilometres = 0;
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index]!;
    if (index > 0) kilometres += haversineKm(path[index - 1]!, point);
    pathLat.push(microdegrees(point.lat));
    pathLon.push(microdegrees(point.lon));
  }
  return {
    pathOffset,
    pathCount: path.length,
    fromLabel: strings.id(leg.fromLabel),
    toLabel: strings.id(leg.toLabel),
    kilometres,
    // Handed back rather than re-derived: the network layer interpolates a
    // minute-by-minute position along exactly this line, and routing the whole
    // city twice to get the same answer twice is the one cost worth avoiding
    // here.
    path,
  };
}

/**
 * One posted row, as columns.
 *
 * Absence is spelled three ways because the column types differ and none of
 * them has a spare value in range: `NONE` in a u32 string reference, `NONE_U8`
 * in an enum byte, `NONE_I32` in a coordinate. A declined payment's
 * `balanceAfter` is genuinely null — nothing moved — and it is written as NaN,
 * which f32 carries and no balance can collide with.
 */
function pushTransaction(transaction: Posted, strings: Strings, out: DayColumns): void {
  const at = transaction.location;
  out.txPerson.push(transaction.person);
  out.txMinute.push(Math.round(transaction._timestamp));
  out.txAmount.push(transaction.amount);
  out.txKind.push(TX_KINDS.indexOf(transaction.kind));
  out.txReason.push(REASONS.indexOf(transaction.reason as typeof REASONS[number]));
  out.txApproved.push(transaction.approved ? 1 : 0);
  out.txDecline.push(transaction.decline
    ? DECLINES.indexOf(transaction.decline)
    : NONE_U8);
  out.txInstrument.push(transaction.instrument
    ? INSTRUMENTS.indexOf(transaction.instrument)
    : NONE_U8);
  // No merchant category on a withdrawal — a cash machine charges none — and
  // zero is not one, so it reads as absent without a second column.
  out.txMcc.push(transaction.mcc ?? 0);
  out.txMerchant.push(strings.id(transaction.merchant ?? null));
  out.txAccount.push(strings.id(transaction.account ?? null));
  out.txCard.push(strings.id(transaction.card ?? null));
  out.txNetwork.push(strings.id(transaction.network ?? null));
  out.txVenue.push(strings.id(transaction.venue ?? null));
  out.txBalanceAfter.push(transaction.balanceAfter ?? Number.NaN);
  out.txLat.push(at?.lat === undefined ? NONE_I32 : microdegrees(at.lat));
  out.txLon.push(at?.lon === undefined ? NONE_I32 : microdegrees(at.lon));
}

/**
 * One person's attention curve, run-length encoded.
 *
 * A run is a stretch of minutes over which both the level and the sleep flag
 * hold, so the run's end is the next one's start and the last one ends at
 * midnight. Nothing is written for a person with no curve, and their run count
 * is therefore zero — which a reader must not confuse with a flat curve at
 * zero. The first is "we do not know this person's day", the second would be
 * "known, and never reachable", and only the first is what an absent curve
 * means. See `Attention.known`.
 */
function pushAttention(attention: Attention | null, out: DayColumns): void {
  if (!attention?.known || attention.minute.length === 0) return;
  let level = -1;
  let asleep = -1;
  for (let minute = 0; minute < attention.minute.length; minute += 1) {
    const nextLevel = attention.minute[minute]!;
    const nextAsleep = attention.asleep[minute]!;
    if (nextLevel === level && nextAsleep === asleep) continue;
    out.attentionStart.push(minute);
    out.attentionLevel.push(nextLevel);
    out.attentionAsleep.push(nextAsleep);
    level = nextLevel;
    asleep = nextAsleep;
  }
}

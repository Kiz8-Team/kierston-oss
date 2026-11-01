/** Pack one simulated date into one self-describing binary.
 *
 * KDAY uses the init binaries' envelope: four magic bytes, a little-endian u32
 * JSON-header length, then 8-aligned typed-array columns. The person table
 * points into schedules and legs; every leg points into one shared coordinate
 * array containing its routed movement path.
 *
 * Version 2 adds a third per-person table: the transactions the day's money
 * moved through. It is written only where the caller put a `bank` on the
 * context, because a bank holds live balances and building one is a decision
 * the exporter has no business making on its own — see `context.ts`. A file
 * written without one is a valid v2 file whose transaction table is empty, and
 * the viewer has to be able to tell that apart from a day nobody spent
 * anything on. `counts.banked` is what says which it was.
 *
 * Version 3 adds the day on the cellular network, on the same terms: present
 * only where the caller put a `network` on the context, and `counts.networked`
 * says which kind of file this is. It arrives as four tables rather than one,
 * and the split is the design rather than an implementation detail.
 *
 *   subscriber  who is on the network. Static, and copied in so the file can
 *               be read without devices.json beside it.
 *   cell        what they attached to, likewise, from towers.json.
 *   span        the truth: which cell served which handset, minute to minute.
 *   event       what the operator's own logs would hold, which is less.
 *
 * The last distinction is the one a consumer most needs and cannot recover
 * afterwards. An idle handset's reselections are in the span table because
 * they happened; they are not in a real network's records, because nothing
 * reported them. Keeping the two apart is what stops a tool built on this
 * mistaking ground truth for evidence.
 *
 * Version 4 adds the day's conversations, present only where the caller put a
 * `comms` on the context, with `counts.messaged` saying which kind of file
 * this is. Seven tables, and the split between them repeats the same
 * discipline one layer up.
 *
 *   account       who is reachable on what. Static, copied in so the file
 *                 reads without accounts.json beside it.
 *   conversation  the city's group threads, likewise static, plus the dyad
 *                 threads that carried traffic today — see `DayComms.dyads`
 *                 for why the second kind is day-local and how to join it.
 *   participant   membership, as a CSR payload for both.
 *   message       one send, at second resolution, carrying the channel it
 *                 actually went over — see `message.channel` below.
 *   call          one attempt, answered or not.
 *   sms           the carrier's rows for the messages that went over SMS or
 *                 MMS: one per recipient per segment, with a serving cell at
 *                 each end — `cell` is the sender's at submission, `toCell`
 *                 the recipient's at delivery.
 *   cdr           the carrier's rows for the calls that were dialled rather
 *                 than placed over an app, with a handover trail.
 *
 * The last two are the whole point of the split. A WhatsApp message has a
 * `message` row and no `sms` row, because nothing in the operator's network
 * ever saw it; a WhatsApp call has a `call` row and no `cdr` row, for the same
 * reason. A consumer that reads only the carrier tables sees the city the way
 * an operator does, which is most of it missing.
 *
 * Join on `message.channel`, never on the thread's. A pair spills to their
 * secondary channel at a fixed rate, so a Messenger thread carries the odd
 * SMS and those sends have carrier rows like any other. The thread's channel
 * is what the pair mostly uses, not what any one message rode.
 *
 * Messages are at second resolution while spans and events are at minute
 * resolution. That is deliberate and is explained in `comms/types.ts`: a reply
 * latency of forty seconds does not survive being rounded to a minute, and a
 * serving cell does not change fast enough to need one.
 *
 * Version 5 adds the attention curve — the per-minute probability that each
 * person looks at their handset, which `comms/attention.ts` derives from the
 * day the scheduler planned. One more per-person table, and the one table here
 * that does not depend on a layer being on the context: the curve is read off
 * the planned day itself, by `observationOf`, so it is written whenever there
 * is a day to read. `counts.messaged` still says whether anybody's
 * *conversations* were resolved, which is the other half of what that flag has
 * always meant.
 *
 * It is here rather than left to the reader because it cannot be recomputed
 * from anything else the file holds. Two of its terms are drawn: the temperament
 * multiplier that makes one person keener on their phone than their colleague
 * on the same shift, and the jitter that moves a shift's breaks off the clock.
 * Both come out of the simulation's own streams, so a viewer working from the
 * schedule alone would draw a curve that is close, plausible and not the one
 * the day's messages were actually sampled from.
 *
 * Run-length encoded, and that is not a compression trick — the curve is
 * piecewise constant by construction, because it is a table of how attentive
 * each *state* is painted onto the states the plan already has. A day is a few
 * dozen runs, so the honest form of 1,440 bytes a person is about 40 rows.
 *
 *   attention     one run: the minute it starts, the level, whether asleep.
 *
 * `asleep` is carried rather than inferred from a zero level. Sleep is the one
 * state whose curve value is exactly zero — nothing is ever *initiated* during
 * it — while the chance of surfacing to read something that has arrived is a
 * float far below what a byte can hold, so the two facts cannot share a column.
 *
 * Version 8 adds the fixed plate-reader layer. `alprTruth` is every physical
 * pass over a camera's directed edge; `alprObservation` is what the sensor made
 * of it, including null detections retained for simulation audit. The shared
 * correlation id is instrumentation, not something the camera perceived. The
 * reader sees plate text on the side it faces: no VIN is stored and detected
 * text is never matched back to the vehicle registry.
 *
 * Version 9 adds external road traffic. Repeat vehicles come from KSIM's KEXT
 * section; one-off visitors and through vehicles are generated for this date.
 * Routes are interned so vehicles sharing a highway do not duplicate geometry.
 * `alprTruth.source` says whether its movement id is a resident leg or an
 * external trip.
 *
 * Version 10 embeds the complete closing KSTATE after the analytical columns.
 * It is an independently versioned, gzip-compressed checkpoint: KDAY remains
 * the evidence for this date while the closing section is everything needed
 * to continue with the next one. `closingState.byteOffset` is relative to the
 * same aligned payload origin as every column, so a continuation reader can
 * seek to it without loading the day.
 *
 * Version 11 carries the resident id behind each transaction as `tx.person`.
 * It remains import-only normalization: Fastgate uses it to copy the bank's
 * own KYC identity onto transaction rows and never persists the resident id.
 * New v11 exports also include `openingState`, captured before any settlement
 * or person simulation. Older v11 files remain readable but cannot be replayed
 * without a separately supplied opening checkpoint. Presence of the section,
 * not the version alone, is the capability check.
 *
 * Version 13 adds `message.channel`, the channel one send actually went over.
 *
 * Version 14 gives both carrier side tables a cell at each end: `sms.toCell`,
 * and `cdr.toOriginCell` / `cdr.toEndCell`. A real operator writes the
 * originating and terminating legs as separate records; these files carry one
 * row per exchange, so without the second pair the answering party's location
 * is missing from every call and message. NONE where that end is off-net.
 *
 * Version 16 gives the radio tables the two measurements a cell actually
 * makes about where a handset is. `span.ta` and `event.ta` are the timing
 * advance the serving cell commanded, in 78 m steps (`TA_UNIT_M`), -1 where
 * there was no serving cell; `span.secondary` and `event.secondary` are the
 * carrier the network added underneath a connected handset — a mid or C-band
 * sector with a footprint a fraction of the anchor's — or -1 while idle. See
 * the notes in `network/attach.ts`. They stay on the span and event tables and
 * off the SMS and call rows on purpose: a billing record never carried a
 * timing advance, and a consumer that wants one joins the signalling log.
 */

import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  encodeCheckpoint, type DayContext, type EmbeddedStateDescriptor,
} from "../engine/index.ts";
import { SIM_DATA_DIR, SIM_OUTPUTS_DIR } from "../world/index.ts";
import { LAYER, MINUTES_PER_DAY, dayNumber, isoDate, mix, Timings } from "../shared/index.ts";
import { DISPOSITIONS, INCIDENT_KINDS, PLACE_CLASSES, SERVICES } from "../dispatch/index.ts";
import {
  EVENT_CAUSES, EVENT_KINDS, OPERATORS, RADIO_LAYERS,
} from "../network/index.ts";
import type { Person } from "../world/index.ts";
import type { Meeting } from "../activities/social/index.ts";
import {
  ATTENTION_SCALE, CALL_OUTCOMES, CHANNELS, CONVERSATION_KINDS, MESSAGE_KINDS,
  emptyCommunicationsBoundary, emptyDayComms,
} from "../comms/index.ts";
import {
  DECLINES, INSTRUMENTS, KINDS, MODES, NONE, PERSON_COLUMNS, PURPOSES, REASONS,
  Strings, TX_KINDS, emptyColumns, microdegrees, packPerson, radioScratch,
  type Field, type NumberArray, type TypeName,
} from "./pack.ts";
import { Merger, typedColumns, type Shard } from "./merge.ts";
import { Pool, chunksOf } from "./pool.ts";
import { replayProvenance } from "./binary.ts";
import { engineVersion } from "./version.ts";
import type { Observation } from "../comms/index.ts";
import {
  ALPR_OUTCOMES, LIGHTING, PLATE_SIDES, simulateAlpr,
} from "../surveillance/index.ts";
import {
  EXTERNAL_TRIP_KINDS, EXTERNAL_VEHICLE_KINDS, externalTrafficFor,
} from "../traffic/index.ts";
import {
  VEHICLE_OWNER_TYPES, VEHICLE_SERVICE_CLASSES, VEHICLE_SPAN_KINDS, buildVehicleDay,
  initialVehicleBoundaryStates, vehicleBoundaryStates,
} from "./vehicles.ts";

const MAGIC = "KDAY";
const VERSION = 16;
/** What was between the handset and the antenna, which the link budget cared about. */
const EXPOSURES = ["outdoor", "indoor", "vehicle"] as const;
/** What a handset's radio can reach. Matches `radioTier` in the network layer. */
const RADIO_TIERS = ["lte", "sub6", "cband"] as const;


interface Column {
  name: string;
  type: TypeName;
  values: NumberArray;
  byteOffset?: number;
}

const align8 = (value: number) => (value + 7) & ~7;

async function initDigest(): Promise<string | null> {
  const file = Bun.file(join(SIM_DATA_DIR, "sim_init.bin"));
  if (!await file.exists()) return null;
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, 4)) !== "KSIM") return null;
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(4, true);
  const meta = JSON.parse(await file.slice(8, 8 + length).text()) as { digest?: string };
  return meta.digest ?? null;
}

/**
 * Appended to, never reordered, like every other index table here.
 *
 * `pair` is retired and kept only to hold its index: gatherings from the tie
 * graph are `hosted` now and carry a party of any size. A file written before
 * version 7 uses the old value and means the same thing with two people in it.
 */
const MEETING_KINDS = ["pair", "household", "hosted"] as const;

/**
 * What this person was to this gathering, as an index.
 *
 * `driver` and `rider` are recorded rather than left to be inferred from the
 * leg table, because the inference is not sound from one side: a passenger's
 * leg says `passenger` and a driver's says `car`, and a car with nobody in it
 * says `car` too. The role is what makes the shared journey id checkable.
 */
const ROLES = ["attendee", "driver", "rider"] as const;

function roleOf(meeting: Meeting, person: number): number {
  if (!meeting.ride) return ROLES.indexOf("attendee");
  if (meeting.ride.driver === person) return ROLES.indexOf("driver");
  return ROLES.indexOf(meeting.ride.riders.includes(person) ? "rider" : "attendee");
}

function column(name: string, type: TypeName, values: number[] | NumberArray): Column {
  const arrays = { u8: Uint8Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array } as const;
  return { name, type, values: ArrayBuffer.isView(values) ? values : new arrays[type](values) };
}

/**
 * A serving-cell lookup over the span table this run already built.
 *
 * The spans are sorted by subscriber only in the sense that one person's are
 * contiguous — the packing loop walks people in id order and a person's
 * subscriptions come out together — so an index is built once and each query
 * is a binary search inside one subscriber's runs. Called once per carrier
 * message and twice plus a walk per call, so the linear scan it replaces
 * would have been the most expensive thing in the exporter.
 */
function spanLookup(
  subscriber: ArrayLike<number>, cell: ArrayLike<number>,
  start: ArrayLike<number>, end: ArrayLike<number>,
): (subscriber: number, minute: number) => number {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < subscriber.length; i += 1) {
    const mine = runs.get(subscriber[i]!);
    if (mine) mine.push(i);
    else runs.set(subscriber[i]!, [i]);
  }
  return (who, minute) => {
    const mine = runs.get(who);
    if (!mine) return -1;
    let low = 0;
    let high = mine.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const row = mine[mid]!;
      if (minute < start[row]!) high = mid - 1;
      else if (minute >= end[row]!) low = mid + 1;
      else return cell[row]!;
    }
    return -1;
  };
}

/**
 * How many people one shard holds.
 *
 * Small enough that a worker finishing early cannot be idle for long — the
 * last chunk is the tail every parallel run waits on — and large enough that
 * the per-chunk costs, a message and a string table, are noise beside the two
 * seconds of planning inside it.
 */
const CHUNK = 1000;

/**
 * Plan and pack the whole city, here or in a pool.
 *
 * The two paths differ in one thing only: which process runs `packPerson`.
 * Both cut the population into the same chunks, both merge them in the same
 * order, and the merge is the only place a shard's numbering is touched — so
 * the file a pool writes is the file this process would have written. The way
 * to check that is to write both and compare the bytes, which is what the two
 * forms of the command are for:
 *
 * Stateful KDAY callers currently select the in-process path. The pool remains
 * here for the state-aware shard protocol to restore without reimplementing
 * packing and merging.
 */
async function packEveryone(
  context: DayContext,
  people: readonly Person[],
  date: Date,
  day: number,
  merger: Merger,
  workers: number,
  progress: ((done: number, total: number) => void) | undefined,
  timings: Timings,
): Promise<Pool | null> {
  const adopt = (observation: Observation): void => context.comms?.adopt(observation);
  const chunks = chunksOf(people.length, CHUNK);
  let done = 0;
  const take = (shard: Shard): void => {
    const packed = shard.columns.personId.length;
    const mark = performance.now();
    merger.add(shard, adopt);
    timings.since("merge shards", mark);
    const before = done;
    done += packed;
    if (Math.floor(before / 10_000) !== Math.floor(done / 10_000)) progress?.(done, people.length);
  };

  if (workers < 1) {
    const radio = radioScratch();
    for (const chunk of chunks) {
      const columns = emptyColumns();
      const strings = new Strings();
      const observations: Observation[] = [];
      const attended: { person: number; meeting: Meeting }[] = [];
      let spent = 0;
      for (let index = chunk.from; index < chunk.to; index += 1) {
        const person = people[index]!;
        const packed = packPerson(context, person, date, day, columns, strings, radio, timings);
        spent += packed.spent;
        observations.push(packed.observation);
        for (const meeting of packed.attended) attended.push({ person: person.id, meeting });
      }
      take({
        index: chunk.index, columns: typedColumns(columns), strings: strings.values,
        spent, observations, attended,
      });
    }
    progress?.(people.length, people.length);
    return null;
  }

  // A pool with no fleet would be a pool of workers each answering their own
  // third of the city's cab requests, which is not a faster day but a
  // different one. Dispatch first — `dispatchFor` — or plan here.
  if (!context.fleet) throw new Error("a parallel export needs a dispatched fleet");
  const opening = performance.now();
  const pool = await Pool.open(workers, {
    date, day, fleet: context.fleet.state(),
    money: Boolean(context.bank), radio: Boolean(context.network),
  });
  timings.since("workers: open", opening);
  await pool.run(chunks, take, (milliseconds) => timings.add("await workers", milliseconds));
  pool.close();
  progress?.(people.length, people.length);
  return pool;
}

export interface DayExportResult {
  path: string;
  bytes: number;
  persons: number;
  schedules: number;
  legs: number;
  points: number;
  vehicles: number;
  vehicleSpans: number;
  transactions: number;
  spent: number;
  spans: number;
  events: number;
  messages: number;
  calls: number;
  meetings: number;
  parties: number;
  stoodUp: number;
  timings: Timings;
  alprPasses: number;
  alprReads: number;
  alprCorrect: number;
  alprMisread: number;
  alprUnreadable: number;
  alprNotCaptured: number;
  externalVehicles: number;
  externalTrips: number;
  throughTrips: number;
  stoppingTours: number;
  incidents: number;
  responses: number;
  unservedIncidents: number;
  medianResponseMinutes: number;
  /** Digest of the embedded closing KSTATE. */
  closingState: string;
  /** Digest of the embedded opening KSTATE, before this day's effects. */
  openingState: string;
  /** The pool's own stage table, summed over its workers, or null for a serial run. */
  workers: Timings | null;
}

export async function exportDay(
  context: DayContext,
  date: Date,
  output = join(SIM_OUTPUTS_DIR, `day_${isoDate(date)}.bin`),
  progress?: (done: number, total: number) => void,
  status?: (stage: string) => void,
  /**
   * Where the run's wall clock went, stage by stage.
   *
   * Taken as an argument rather than made here so a caller can charge what it
   * spent loading the city and dispatching the fleet to the same table. A
   * export accounted for on its own is an export that looks faster than the
   * command that ran it.
   */
  timings = new Timings(),
  /**
   * Reserved worker count. Stateful KDAY export currently requires zero.
   *
   * The pool is not free—a worker holds its own copy of the road graph, the
   * population and the bank, about a gigabyte apiece. A future worker protocol
   * must exchange closing bank, person and radio state before this may be
   * non-zero again.
   */
  workers = 0,
): Promise<DayExportResult> {
  if (!context.state) throw new Error("a KDAY export needs a SimulationState for its closing checkpoint");
  if (workers !== 0) throw new Error("a stateful KDAY export cannot use workers yet");
  context.state.enter(date);
  const day = dayNumber(date);
  // People in custody have no day in the city: no home presence, no commute, no handset in a cell.
  const people = [...context.world.persons.values()].filter((person) => !person.incarcerated).sort((a, b) => a.id - b.id);
  context.state.seedVehicles(initialVehicleBoundaryStates(context));
  // Encode now: the bank is mutable and must not be read after packing.
  const encodedOpening = encodeCheckpoint(context.state.checkpoint(people.map((person) => person.id)));
  const merger = new Merger();
  if (context.comms) {
    const dated = isoDate(date);
    for (const row of context.state.emergencyCallsForDay()) {
      context.comms.dial911(`${row.date}/${row.incident}`, row.person, row.minute,
        mix(context.world.seed, LAYER.calls, day, row.incident, 3));
    }
    for (const incident of context.calls?.incidents ?? []) {
      if (incident.receivedAt >= MINUTES_PER_DAY) continue;
      context.comms.dial911(`${dated}/${incident.index}`, incident.caller, incident.receivedAt,
        mix(context.world.seed, LAYER.calls, day, incident.index, 2));
    }
  }
  const pool = await packEveryone(context, people, date, day, merger, workers, progress, timings);

  const strings = merger.strings;
  const gatherings = merger.gatherings;
  const spent = merger.spent;
  const counts = merger.counts;
  const legDepart = merger.take("legDepart");
  const legArrive = merger.take("legArrive");
  const legMode = merger.take("legMode");
  const legPurpose = merger.take("legPurpose");
  const legJourney = merger.take("legJourney");
  const legVehicle = merger.take("legVehicle");
  const legFromLat = merger.take("legFromLat");
  const legFromLon = merger.take("legFromLon");
  const legToLat = merger.take("legToLat");
  const legToLon = merger.take("legToLon");
  let after = performance.now();
  status?.("generating external traffic");
  const external = await externalTrafficFor(context, date, day);
  after = timings.since("external traffic", after);
  status?.("simulating ALPR");
  const alpr = await simulateAlpr(context, date, day, {
    personId: merger.take("personId"),
    personLegOffset: merger.take("personLegOffset"),
    personLegCount: merger.take("personLegCount"),
    legDepart,
    legArrive,
    legMode,
    legPurpose,
    legJourney,
    legVehicle,
    legPathOffset: merger.take("legPathOffset"),
    legPathCount: merger.take("legPathCount"),
    pathLat: merger.take("pathLat"),
    pathLon: merger.take("pathLon"),
    modes: MODES,
    purposes: PURPOSES,
  }, external, strings);
  after = timings.since("simulate ALPR", after);
  status?.("building vehicle timelines");
  const vehicleDay = buildVehicleDay(context, strings.values, {
    vehicle: legVehicle, depart: legDepart, arrive: legArrive,
    fromLat: legFromLat, fromLon: legFromLon, toLat: legToLat, toLon: legToLon,
  });
  after = timings.since("vehicle timelines", after);
  // Taken now because the conversations need them: a carrier record names the
  // cell that was serving the handset, and the span table this run just packed
  // is the authority on which one that was.
  const spanSubscriber = merger.take("spanSubscriber");
  const spanCell = merger.take("spanCell");
  const spanStart = merger.take("spanStart");
  const spanEnd = merger.take("spanEnd");

  status?.("resolving communications");
  const comms = context.comms
    ? context.comms.resolve(context.world.seed, day, context.network ? spanLookup(
        spanSubscriber, spanCell, spanStart, spanEnd,
      ) : null, context.world, date, context.state.communicationsForDay())
    : emptyDayComms();
  after = timings.since("comms resolve", after);

  status?.("packing network tables");
  // The two static tables, copied in so a consumer can resolve a span without
  // devices.json and towers.json beside it. Three megabytes against a file
  // already measured in hundreds, and it is the difference between a day that
  // is readable on its own and one that is a set of foreign keys.
  const subscriberPerson: number[] = [];
  const subscriberImsi: number[] = [];
  const subscriberImei: number[] = [];
  const subscriberMsisdn: number[] = [];
  const subscriberCarrier: number[] = [];
  const subscriberOperator: number[] = [];
  const subscriberTier: number[] = [];
  const subscriberMvno: number[] = [];
  const subscriberPrepaid: number[] = [];
  const cellCgi: number[] = [];
  const cellStructure: number[] = [];
  const cellOperator: number[] = [];
  const cellLayer: number[] = [];
  const cellBand: number[] = [];
  const cellArea: number[] = [];
  const cellPci: number[] = [];
  const cellLat: number[] = [];
  const cellLon: number[] = [];

  if (context.network) {
    for (const subscriber of context.network.subscribers.all) {
      subscriberPerson.push(subscriber.person);
      subscriberImsi.push(strings.id(subscriber.imsi));
      subscriberImei.push(strings.id(subscriber.imei));
      subscriberMsisdn.push(strings.id(subscriber.msisdn));
      subscriberCarrier.push(strings.id(subscriber.carrier));
      subscriberOperator.push(subscriber.operator);
      subscriberTier.push(subscriber.tier);
      subscriberMvno.push(subscriber.mvno ? 1 : 0);
      subscriberPrepaid.push(subscriber.prepaid ? 1 : 0);
    }
    for (let index = 0; index < context.network.cells.records.length; index += 1) {
      const cell = context.network.cells.records[index]!;
      cellCgi.push(strings.id(cell.cgi));
      cellStructure.push(strings.id(cell.structure));
      cellOperator.push(OPERATORS.indexOf(cell.operator_key as typeof OPERATORS[number]));
      cellLayer.push(context.network.cells.layerOf(index));
      cellBand.push(strings.id(cell.band));
      cellArea.push(cell.tracking_area);
      cellPci.push(cell.pci);
      cellLat.push(microdegrees(cell.lat));
      cellLon.push(microdegrees(cell.lon));
    }
  }
  after = timings.since("pack network tables", after);


  status?.("packing communications tables");
  // The communications tables. Accounts and group threads are static, like
  // the subscriber and cell tables above and for the same reason: a consumer
  // should be able to resolve a message without accounts.json beside it.
  //
  // Dyad threads are appended to the conversation table after the static
  // ones, so `message.conversation` indexes one continuous table. Their
  // indices are day-local by construction — see `DayComms.dyads` — and
  // `conversation.externalId` is the field that joins across dates.
  const accountPerson: number[] = [];
  const accountChannel: number[] = [];
  const accountHandle: number[] = [];
  const accountDisplay: number[] = [];
  const accountSubscriber: number[] = [];
  const accountCreated: number[] = [];
  const convChannel: number[] = [];
  const convKind: number[] = [];
  const convAt: number[] = [];
  const convCount: number[] = [];
  const convFocus: number[] = [];
  const convExternal: number[] = [];
  const convTitle: number[] = [];
  const convCreated: number[] = [];
  const participant: number[] = [];
  const messageConversation: number[] = [];
  const messageFrom: number[] = [];
  const messageAt: number[] = [];
  const messageKind: number[] = [];
  const messageChannel: number[] = [];
  const messageBytes: number[] = [];
  const messageReplyTo: number[] = [];
  const messageSeq: number[] = [];
  const messageSubscriber: number[] = [];
  const callConversation: number[] = [];
  const callFrom: number[] = [];
  const callAt: number[] = [];
  const callOutcome: number[] = [];
  const callRing: number[] = [];
  const callDuration: number[] = [];
  const callSubscriber: number[] = [];
  const callCallback: number[] = [];
  const smsMessage: number[] = [];
  const smsFrom: number[] = [];
  const smsTo: number[] = [];
  const smsCell: number[] = [];
  const smsToCell: number[] = [];
  const smsPart: number[] = [];
  const smsParts: number[] = [];
  const smsDelivered: number[] = [];
  const cdrCall: number[] = [];
  const cdrFrom: number[] = [];
  const cdrTo: number[] = [];
  const cdrOriginCell: number[] = [];
  const cdrEndCell: number[] = [];
  const cdrToOriginCell: number[] = [];
  const cdrToEndCell: number[] = [];
  const cdrHandoverAt: number[] = [];
  const cdrHandoverCount: number[] = [];
  const handoverSecond: number[] = [];
  const handoverCell: number[] = [];
  let commsFoci: readonly string[] = [];

  if (context.comms) {
    const accounts = context.comms.accounts;
    commsFoci = accounts.foci;
    for (const account of accounts.all) {
      accountPerson.push(account.person);
      accountChannel.push(account.channel);
      accountHandle.push(strings.id(account.handle));
      accountDisplay.push(strings.id(account.displayName));
      accountSubscriber.push(account.subscriber);
      accountCreated.push(account.created);
    }
    for (const thread of accounts.conversations) {
      convChannel.push(thread.channel);
      convKind.push(thread.kind);
      convAt.push(participant.length);
      convCount.push(thread.count);
      convFocus.push(thread.focus);
      convExternal.push(strings.id(thread.externalId));
      convTitle.push(strings.id(thread.title));
      convCreated.push(thread.created);
      for (const account of accounts.members(thread)) participant.push(account);
    }
    // Then today's dyads, whose CSR payload is rebased onto the same array.
    for (const thread of comms.dyads) {
      convChannel.push(thread.channel);
      convKind.push(thread.kind);
      convAt.push(participant.length);
      convCount.push(thread.count);
      convFocus.push(thread.focus);
      convExternal.push(strings.id(thread.externalId));
      convTitle.push(strings.id(thread.title));
      convCreated.push(thread.created);
      for (let i = thread.at; i < thread.at + thread.count; i += 1) {
        participant.push(comms.dyadParticipants[i]!);
      }
    }
    for (const message of comms.messages) {
      messageConversation.push(message.conversation);
      messageFrom.push(message.from);
      messageAt.push(message.at);
      messageKind.push(message.kind);
      messageChannel.push(message.channel);
      messageBytes.push(message.bytes);
      messageReplyTo.push(message.replyTo);
      messageSeq.push(message.seq);
      messageSubscriber.push(message.subscriber);
    }
    for (const call of comms.calls) {
      callConversation.push(call.conversation);
      callFrom.push(call.from);
      callAt.push(call.at);
      callOutcome.push(call.outcome);
      callRing.push(call.ring);
      callDuration.push(call.duration);
      callSubscriber.push(call.subscriber);
      callCallback.push(call.callback);
    }
    for (const row of comms.sms) {
      smsMessage.push(row.message);
      smsFrom.push(row.from);
      smsTo.push(row.to);
      smsCell.push(row.cell);
      smsToCell.push(row.toCell);
      smsPart.push(row.part);
      smsParts.push(row.parts);
      smsDelivered.push(row.delivered);
    }
    for (const row of comms.cdr) {
      cdrCall.push(row.call);
      cdrFrom.push(row.from);
      cdrTo.push(row.to);
      cdrOriginCell.push(row.originCell);
      cdrEndCell.push(row.endCell);
      cdrToOriginCell.push(row.toOriginCell);
      cdrToEndCell.push(row.toEndCell);
      cdrHandoverAt.push(row.handoverAt / 2);
      cdrHandoverCount.push(row.handoverCount);
    }
    for (let i = 0; i < comms.handovers.length; i += 2) {
      handoverSecond.push(comms.handovers[i]!);
      handoverCell.push(comms.handovers[i + 1]!);
    }
  }
  after = timings.since("pack comms tables", after);

  status?.("packing calls for service");
  // Minutes are in the dispatcher's 07:00–07:00 frame; past 1440 is the small hours of tomorrow.
  const calls = context.calls;
  const incidentKind: number[] = [];
  const incidentPriority: number[] = [];
  const incidentLat: number[] = [];
  const incidentLon: number[] = [];
  const incidentPlace: number[] = [];
  const incidentPlaceClass: number[] = [];
  const incidentReceived: number[] = [];
  const incidentCaller: number[] = [];
  const incidentPoliceUnits: number[] = [];
  const incidentEmsUnits: number[] = [];
  const incidentDispatched: number[] = [];
  const incidentFirstOnScene: number[] = [];
  const incidentCleared: number[] = [];
  const incidentCallerUntil: number[] = [];
  const incidentDisposition: number[] = [];
  const incidentCall: number[] = [];
  const responseIncident: number[] = [];
  const responseService: number[] = [];
  const responseVehicle: number[] = [];
  const responsePerson: number[] = [];
  const responsePartner: number[] = [];
  const responseDispatched: number[] = [];
  const responseArrived: number[] = [];
  const responseCleared: number[] = [];
  const responseHospital: number[] = [];
  const responseHospitalArrived: number[] = [];
  const responseHospitalLeft: number[] = [];
  const responseReturned: number[] = [];
  const firstUnitMinutes: number[] = [];
  if (calls) {
    const dated = isoDate(date);
    for (const incident of calls.incidents) {
      incidentKind.push(incident.kind);
      incidentPriority.push(incident.priority);
      incidentLat.push(microdegrees(incident.place.lat));
      incidentLon.push(microdegrees(incident.place.lon));
      incidentPlace.push(strings.id(incident.place.id));
      incidentPlaceClass.push(PLACE_CLASSES.indexOf(incident.placeClass));
      incidentReceived.push(incident.receivedAt);
      incidentCaller.push(incident.caller);
      incidentPoliceUnits.push(incident.requested.police);
      incidentEmsUnits.push(incident.requested.ems);
      const first = incident.responses.reduce((soonest, r) => Math.min(soonest, r.arrivedAt), Infinity);
      const dispatched = incident.responses.reduce((soonest, r) => Math.min(soonest, r.dispatchedAt), Infinity);
      const cleared = incident.responses.reduce((latest, r) => Math.max(latest, r.clearedAt), -Infinity);
      incidentDispatched.push(Number.isFinite(dispatched) ? dispatched : -1);
      incidentFirstOnScene.push(Number.isFinite(first) ? first : -1);
      incidentCleared.push(Number.isFinite(cleared) ? cleared : -1);
      if (Number.isFinite(first)) firstUnitMinutes.push(first - incident.receivedAt);
      incidentCallerUntil.push(incident.holdUntil);
      incidentDisposition.push(DISPOSITIONS.indexOf(incident.disposition));
      incidentCall.push(context.comms?.emergencyCalls.get(`${dated}/${incident.index}`) ?? -1);
    }
    for (const response of calls.responses) {
      responseIncident.push(response.incident);
      responseService.push(SERVICES.indexOf(response.service));
      responseVehicle.push(strings.id(response.vin));
      responsePerson.push(response.crew[0]!);
      responsePartner.push(response.crew[1] ?? -1);
      responseDispatched.push(response.dispatchedAt);
      responseArrived.push(response.arrivedAt);
      responseCleared.push(response.clearedAt);
      responseHospital.push(response.transport ? strings.id(response.transport.hospital.id) : NONE);
      responseHospitalArrived.push(response.transport?.arrivedAt ?? -1);
      responseHospitalLeft.push(response.transport?.leftAt ?? -1);
      responseReturned.push(response.returnedAt ?? -1);
    }
  }
  firstUnitMinutes.sort((a, b) => a - b);
  const medianResponse = firstUnitMinutes.length ? firstUnitMinutes[Math.floor(firstUnitMinutes.length / 2)]! : 0;
  after = timings.since("pack calls for service", after);

  status?.("packing gatherings");
  /**
   * The gatherings, flattened.
   *
   * Written in id order rather than in the order people were streamed, so the
   * table is stable between a run that plans the city and a run that plans a
   * cohort of it. Parties are sorted by person for the same reason.
   */
  const meetingKey: number[] = [];
  const meetingKind: number[] = [];
  const meetingPurpose: number[] = [];
  const meetingVenue: number[] = [];
  const meetingLat: number[] = [];
  const meetingLon: number[] = [];
  const meetingStart: number[] = [];
  const meetingEnd: number[] = [];
  const meetingPayer: number[] = [];
  const meetingHost: number[] = [];
  const meetingPartyOffset: number[] = [];
  const meetingPartyCount: number[] = [];
  const partyPerson: number[] = [];
  const partyRole: number[] = [];
  /**
   * Gatherings where only one person's day actually reached the venue.
   *
   * Kept in the table rather than filtered out, because the row is true: that
   * person really did go and sit there, and their schedule says so. What would
   * be false is silence about it, so the count is returned and printed — a
   * party of one is an arrangement the roads broke, and a reader who found one
   * unannounced would rightly suspect the export rather than the traffic.
   */
  let stoodUp = 0;
  for (const [id, held] of [...gatherings].sort((a, b) => a[0].localeCompare(b[0]))) {
    const meeting = held.meeting;
    meetingKey.push(strings.id(id));
    meetingKind.push(MEETING_KINDS.indexOf(meeting.kind));
    meetingPurpose.push(strings.id(meeting.purpose));
    meetingVenue.push(strings.id(meeting.venue.id));
    meetingLat.push(microdegrees(meeting.venue.lat));
    meetingLon.push(microdegrees(meeting.venue.lon));
    meetingStart.push(meeting.start);
    meetingEnd.push(meeting.end);
    meetingPayer.push(meeting.payer ?? -1);
    meetingHost.push(meeting.host ?? -1);
    meetingPartyOffset.push(partyPerson.length);
    const attendees = [...held.attendees].sort((a, b) => a - b);
    if (attendees.length < 2) stoodUp += 1;
    meetingPartyCount.push(attendees.length);
    for (const attendee of attendees) {
      partyPerson.push(attendee);
      partyRole.push(roleOf(meeting, attendee));
    }
  }
  after = timings.since("pack gatherings", after);

  /** One column the shards produced, taken whole and named as the file names it. */
  const packed = (name: string): Column => {
    const spec = PERSON_COLUMNS.find((item) => item.name === name)!;
    return column(spec.name, spec.type, merger.take(spec.field));
  };

  status?.("building output columns");
  const columns: Column[] = [
    packed("person.id"),
    packed("person.scheduleOffset"),
    packed("person.scheduleCount"),
    packed("person.legOffset"),
    packed("person.legCount"),
    packed("person.txOffset"),
    packed("person.txCount"),
    packed("schedule.start"),
    packed("schedule.end"),
    packed("schedule.kind"),
    packed("schedule.label"),
    packed("schedule.where"),
    packed("leg.depart"),
    packed("leg.arrive"),
    packed("leg.mode"),
    packed("leg.purpose"),
    packed("leg.journey"),
    packed("leg.vehicle"),
    packed("leg.fromLatE6"),
    packed("leg.fromLonE6"),
    packed("leg.toLatE6"),
    packed("leg.toLonE6"),
    packed("leg.kilometres"),
    packed("leg.estimated"),
    packed("leg.wait"),
    packed("leg.fromLabel"),
    packed("leg.toLabel"),
    packed("leg.pathOffset"),
    packed("leg.pathCount"),
    packed("path.latE6"),
    packed("path.lonE6"),
    column("vehicle.vin", "u32", vehicleDay.vin.map((vin) => strings.id(vin))),
    column("vehicle.owner", "u32", vehicleDay.owner),
    column("vehicle.ownerType", "u8", vehicleDay.ownerType),
    column("vehicle.household", "i32", vehicleDay.household),
    column("vehicle.serviceClass", "u8", vehicleDay.serviceClass),
    column("vehicle.spanOffset", "u32", vehicleDay.spanOffset),
    column("vehicle.spanCount", "u32", vehicleDay.spanCount),
    column("vehicleSpan.vehicle", "u32", vehicleDay.spanVehicle),
    column("vehicleSpan.startSecond", "i32", vehicleDay.spanStart),
    column("vehicleSpan.endSecond", "i32", vehicleDay.spanEnd),
    column("vehicleSpan.kind", "u8", vehicleDay.spanKind),
    column("vehicleSpan.leg", "i32", vehicleDay.spanLeg),
    column("vehicleSpan.latE6", "i32", vehicleDay.spanLat),
    column("vehicleSpan.lonE6", "i32", vehicleDay.spanLon),
    packed("tx.person"),
    packed("tx.minute"),
    packed("tx.amount"),
    packed("tx.kind"),
    packed("tx.reason"),
    packed("tx.approved"),
    packed("tx.decline"),
    packed("tx.instrument"),
    packed("tx.mcc"),
    packed("tx.merchant"),
    packed("tx.account"),
    packed("tx.card"),
    packed("tx.network"),
    packed("tx.venue"),
    packed("tx.balanceAfter"),
    packed("tx.latE6"),
    packed("tx.lonE6"),
    column("meeting.key", "u32", meetingKey),
    column("meeting.kind", "u8", meetingKind),
    column("meeting.purpose", "u32", meetingPurpose),
    column("meeting.venue", "u32", meetingVenue),
    column("meeting.latE6", "i32", meetingLat),
    column("meeting.lonE6", "i32", meetingLon),
    column("meeting.start", "i32", meetingStart),
    column("meeting.end", "i32", meetingEnd),
    // Signed, because -1 is the ordinary case: everybody paid for themselves.
    column("meeting.payer", "i32", meetingPayer),
    column("meeting.host", "i32", meetingHost),
    column("meeting.partyOffset", "u32", meetingPartyOffset),
    column("meeting.partyCount", "u32", meetingPartyCount),
    column("party.person", "u32", partyPerson),
    column("party.role", "u8", partyRole),
    packed("person.spanOffset"),
    packed("person.spanCount"),
    packed("person.eventOffset"),
    packed("person.eventCount"),
    column("subscriber.person", "u32", subscriberPerson),
    column("subscriber.imsi", "u32", subscriberImsi),
    column("subscriber.imei", "u32", subscriberImei),
    column("subscriber.msisdn", "u32", subscriberMsisdn),
    column("subscriber.carrier", "u32", subscriberCarrier),
    column("subscriber.operator", "u8", subscriberOperator),
    column("subscriber.tier", "u8", subscriberTier),
    column("subscriber.mvno", "u8", subscriberMvno),
    column("subscriber.prepaid", "u8", subscriberPrepaid),
    column("cell.cgi", "u32", cellCgi),
    column("cell.structure", "u32", cellStructure),
    column("cell.operator", "u8", cellOperator),
    column("cell.layer", "u8", cellLayer),
    column("cell.band", "u32", cellBand),
    column("cell.trackingArea", "u32", cellArea),
    column("cell.pci", "u32", cellPci),
    column("cell.latE6", "i32", cellLat),
    column("cell.lonE6", "i32", cellLon),
    // Spans are signed in the cell column because an unattached stretch is a
    // real row with no cell, and -1 is the only absence an index column has.
    packed("span.subscriber"),
    packed("span.cell"),
    packed("span.start"),
    packed("span.end"),
    packed("span.rsrp"),
    packed("span.exposure"),
    packed("span.connected"),
    packed("span.ta"),
    packed("span.secondary"),
    packed("event.subscriber"),
    packed("event.minute"),
    packed("event.kind"),
    packed("event.cell"),
    packed("event.previous"),
    packed("event.cause"),
    packed("event.ta"),
    packed("event.secondary"),
    column("account.person", "u32", accountPerson),
    column("account.channel", "u8", accountChannel),
    column("account.handle", "u32", accountHandle),
    column("account.displayName", "u32", accountDisplay),
    column("account.subscriber", "i32", accountSubscriber),
    column("account.created", "u32", accountCreated),
    column("conversation.channel", "u8", convChannel),
    column("conversation.kind", "u8", convKind),
    column("conversation.at", "u32", convAt),
    column("conversation.count", "u32", convCount),
    column("conversation.focus", "i32", convFocus),
    column("conversation.externalId", "u32", convExternal),
    column("conversation.title", "u32", convTitle),
    column("conversation.created", "u32", convCreated),
    column("participant.account", "u32", participant),
    column("message.conversation", "u32", messageConversation),
    column("message.from", "u32", messageFrom),
    column("message.at", "u32", messageAt),
    column("message.kind", "u8", messageKind),
    column("message.channel", "u8", messageChannel),
    column("message.bytes", "u32", messageBytes),
    column("message.replyTo", "i32", messageReplyTo),
    column("message.seq", "u32", messageSeq),
    column("message.subscriber", "i32", messageSubscriber),
    column("call.conversation", "u32", callConversation),
    column("call.from", "u32", callFrom),
    column("call.at", "u32", callAt),
    column("call.outcome", "u8", callOutcome),
    column("call.ring", "u32", callRing),
    column("call.duration", "u32", callDuration),
    column("call.subscriber", "i32", callSubscriber),
    column("call.callback", "i32", callCallback),
    column("sms.message", "u32", smsMessage),
    column("sms.from", "i32", smsFrom),
    column("sms.to", "i32", smsTo),
    column("sms.cell", "i32", smsCell),
    column("sms.toCell", "i32", smsToCell),
    column("sms.part", "u8", smsPart),
    column("sms.parts", "u8", smsParts),
    column("sms.delivered", "i32", smsDelivered),
    column("cdr.call", "u32", cdrCall),
    column("cdr.from", "i32", cdrFrom),
    column("cdr.to", "i32", cdrTo),
    column("cdr.originCell", "i32", cdrOriginCell),
    column("cdr.endCell", "i32", cdrEndCell),
    column("cdr.toOriginCell", "i32", cdrToOriginCell),
    column("cdr.toEndCell", "i32", cdrToEndCell),
    column("cdr.handoverAt", "u32", cdrHandoverAt),
    column("cdr.handoverCount", "u32", cdrHandoverCount),
    column("handover.second", "u32", handoverSecond),
    column("handover.cell", "i32", handoverCell),
    packed("person.attentionOffset"),
    packed("person.attentionCount"),
    packed("attention.start"),
    packed("attention.level"),
    packed("attention.asleep"),
    column("externalVehicle.id", "u32", external.vehicles.map((row) => strings.id(row.id))),
    column("externalVehicle.kind", "u8", external.vehicles.map((row) => EXTERNAL_VEHICLE_KINDS.indexOf(row.kind))),
    column("externalVehicle.state", "u32", external.vehicles.map((row) => strings.id(row.state))),
    column("externalVehicle.plate", "u32", external.vehicles.map((row) => strings.id(row.plate))),
    column("externalVehicle.plateSides", "u8", external.vehicles.map((row) =>
      (row.plate_sides.includes("rear") ? 1 : 0) | (row.plate_sides.includes("front") ? 2 : 0))),
    column("externalVehicle.make", "u32", external.vehicles.map((row) => strings.id(row.make))),
    column("externalVehicle.model", "u32", external.vehicles.map((row) => strings.id(row.model))),
    column("externalVehicle.body", "u32", external.vehicles.map((row) => strings.id(row.body))),
    column("externalVehicle.colour", "u32", external.vehicles.map((row) => strings.id(row.colour))),
    column("externalVehicle.modelYear", "u32", external.vehicles.map((row) => row.model_year)),
    column("externalTrip.vehicle", "u32", external.tripVehicle),
    column("externalTrip.kind", "u8", external.tripKind),
    column("externalTrip.route", "u32", external.tripRoute),
    column("externalTrip.departSecond", "u32", external.tripDepartSecond),
    column("externalTrip.arriveSecond", "u32", external.tripArriveSecond),
    column("trafficRoute.pathOffset", "u32", external.routePathOffset),
    column("trafficRoute.pathCount", "u32", external.routePathCount),
    column("trafficPath.latE6", "i32", external.pathLat),
    column("trafficPath.lonE6", "i32", external.pathLon),
    column("camera.id", "u32", alpr.cameraId),
    column("camera.edge", "u32", alpr.cameraEdge),
    column("camera.side", "u8", alpr.cameraSide),
    column("camera.latE6", "i32", alpr.cameraLat),
    column("camera.lonE6", "i32", alpr.cameraLon),
    column("camera.role", "u32", alpr.cameraRole),
    column("camera.owner", "u32", alpr.cameraOwner),
    column("alprTruth.correlationId", "u32", alpr.truthCorrelation),
    column("alprTruth.camera", "u32", alpr.truthCamera),
    column("alprTruth.second", "u32", alpr.truthSecond),
    column("alprTruth.leg", "u32", alpr.truthLeg),
    column("alprTruth.source", "u8", alpr.truthSource),
    column("alprTruth.movement", "u32", alpr.truthMovement),
    column("alprTruth.side", "u8", alpr.truthSide),
    column("alprTruth.plate", "u32", alpr.truthPlate),
    column("alprTruth.jurisdiction", "u32", alpr.truthJurisdiction),
    column("alprObservation.correlationId", "u32", alpr.observationCorrelation),
    column("alprObservation.camera", "u32", alpr.observationCamera),
    column("alprObservation.second", "u32", alpr.observationSecond),
    column("alprObservation.detectedText", "u32", alpr.observationDetected),
    column("alprObservation.canonicalText", "u32", alpr.observationCanonical),
    column("alprObservation.confidence", "f32", alpr.observationConfidence),
    column("alprObservation.outcome", "u8", alpr.observationOutcome),
    column("alprObservation.lighting", "u8", alpr.observationLighting),
    column("alprObservation.headwaySeconds", "f32", alpr.observationHeadway),
    column("alprObservation.dwellSeconds", "f32", alpr.observationDwell),
    column("incident.kind", "u8", incidentKind),
    column("incident.priority", "u8", incidentPriority),
    column("incident.latE6", "i32", incidentLat),
    column("incident.lonE6", "i32", incidentLon),
    column("incident.place", "u32", incidentPlace),
    column("incident.placeClass", "u8", incidentPlaceClass),
    column("incident.receivedMinute", "u32", incidentReceived),
    column("incident.caller", "u32", incidentCaller),
    column("incident.policeUnits", "u8", incidentPoliceUnits),
    column("incident.emsUnits", "u8", incidentEmsUnits),
    column("incident.dispatchedMinute", "i32", incidentDispatched),
    column("incident.firstOnSceneMinute", "i32", incidentFirstOnScene),
    column("incident.clearedMinute", "i32", incidentCleared),
    column("incident.callerUntilMinute", "u32", incidentCallerUntil),
    column("incident.disposition", "u8", incidentDisposition),
    column("incident.call", "i32", incidentCall),
    column("response.incident", "u32", responseIncident),
    column("response.service", "u8", responseService),
    column("response.vehicle", "u32", responseVehicle),
    column("response.person", "u32", responsePerson),
    column("response.partner", "i32", responsePartner),
    column("response.dispatchedMinute", "u32", responseDispatched),
    column("response.arrivedMinute", "u32", responseArrived),
    column("response.clearedMinute", "u32", responseCleared),
    column("response.hospital", "u32", responseHospital),
    column("response.hospitalArrivedMinute", "i32", responseHospitalArrived),
    column("response.hospitalLeftMinute", "i32", responseHospitalLeft),
    column("response.returnedMinute", "i32", responseReturned),
  ];
  // Every column is a copy of a JavaScript array into a typed one, so this is
  // where a day's several hundred million numbers are actually moved.
  after = timings.since("build columns", after);

  // Packing has staged every person's and handset's boundary. The fleet is a
  // city-level object, so it joins them here immediately before the one atomic
  // transition that becomes this KDAY's closing checkpoint.
  context.state.stageFleet(context.fleet?.cabs ?? []);
  context.state.stageVehicles(vehicleBoundaryStates(vehicleDay, "closing"));
  context.state.stageCommunications(context.comms?.closing ?? emptyCommunicationsBoundary());
  context.state.stageEmergencyCalls((calls?.incidents ?? [])
    .filter((incident) => incident.receivedAt >= MINUTES_PER_DAY)
    .map((incident) => ({
      date: isoDate(date), incident: incident.index, person: incident.caller,
      minute: incident.receivedAt - MINUTES_PER_DAY,
    })));
  context.state.advance(date);
  status?.("encoding closing state");
  const encodedState = encodeCheckpoint(context.state.checkpoint(people.map((person) => person.id)));

  let payloadLength = 0;
  for (const item of columns) {
    payloadLength = align8(payloadLength);
    item.byteOffset = payloadLength;
    payloadLength += item.values.byteLength;
  }
  const openingOffset = align8(payloadLength);
  const openingState: EmbeddedStateDescriptor = {
    magic: "KSTATE", version: context.state.version, encoding: "gzip-json",
    boundary: "opening", nextDate: isoDate(date), digest: encodedOpening.digest,
    byteOffset: openingOffset, byteLength: encodedOpening.bytes.byteLength,
    rawByteLength: encodedOpening.rawByteLength,
  };
  const stateOffset = align8(openingOffset + encodedOpening.bytes.byteLength);
  payloadLength = stateOffset + encodedState.bytes.byteLength;
  const closingState: EmbeddedStateDescriptor = {
    magic: "KSTATE",
    version: context.state.version,
    encoding: "gzip-json",
    boundary: "closing",
    nextDate: context.state.nextDate,
    digest: encodedState.digest,
    byteOffset: stateOffset,
    byteLength: encodedState.bytes.byteLength,
    rawByteLength: encodedState.rawByteLength,
  };

  const header = new TextEncoder().encode(JSON.stringify({
    magic: MAGIC,
    version: VERSION,
    date: isoDate(date),
    day,
    // Which engine wrote this, as `dd.mm.yyyy.n-hash`. See `version.ts`.
    engineVersion: await engineVersion(),
    initDigest: await initDigest(),
    // The seed the day's draws were keyed on: the population's, or `--seed`.
    seed: context.world.seed,
    replayProvenance: await replayProvenance(),
    openingState,
    closingState,
    alprModel: alpr.model,
    // What `attention.level` is a fraction of. Carried rather than assumed,
    // because a reader dividing by a hardcoded 255 is a reader that silently
    // misreads the day the scale changes.
    attentionScale: ATTENTION_SCALE,
    counts: {
      persons: counts.person, schedules: counts.schedule,
      legs: counts.leg, pathPoints: counts.path,
      vehicles: vehicleDay.vin.length,
      vehicleSpans: vehicleDay.spanStart.length,
      transactions: counts.tx,
      // Whether a bank was present at all, which is not the same question as
      // whether anybody spent anything. Without this a viewer cannot tell an
      // export run without `--money` from a city that bought nothing.
      banked: context.bank ? 1 : 0,
      subscribers: subscriberPerson.length,
      cells: cellCgi.length,
      spans: counts.span,
      events: counts.event,
      // The same question the bank's flag answers, for the radio: a day with
      // no network on the context is not a city where nobody had a phone.
      networked: context.network ? 1 : 0,
      accounts: accountPerson.length,
      conversations: convChannel.length,
      messages: messageAt.length,
      calls: callAt.length,
      smsRecords: smsMessage.length,
      callRecords: cdrCall.length,
      // And the same question again for the conversations: a day with no
      // comms on the context is not a city where nobody spoke. It answers it
      // for the attention curves too, which the same layer derives.
      messaged: context.comms ? 1 : 0,
      attentionRuns: counts.attention,
      meetings: meetingKey.length,
      parties: partyPerson.length,
      trafficGateways: external.gateways,
      externalVehicles: external.vehicles.length,
      recurringExternalVehicles: external.recurringVehicles,
      oneOffExternalVehicles: external.oneOffVehicles,
      externalTrips: external.tripVehicle.length,
      trafficRoutes: external.routePathOffset.length,
      trafficPathPoints: external.pathLat.length,
      throughTrips: external.throughTrips,
      stoppingTours: external.stoppingTours,
      surveilled: alpr.cameraId.length > 0 ? 1 : 0,
      cameras: alpr.cameraId.length,
      alprPasses: alpr.truthCorrelation.length,
      alprObservations: alpr.observationCorrelation.length,
      alprReads: alpr.reads,
      alprCorrect: alpr.correct,
      alprMisread: alpr.misread,
      alprUnreadable: alpr.unreadable,
      alprNotCaptured: alpr.notCaptured,
      alprNoPlate: alpr.noPlate,
      alprSpurious: alpr.spurious,
      dispatched: calls ? 1 : 0,
      incidents: incidentKind.length,
      responses: responseIncident.length,
    },
    enums: {
      scheduleKind: KINDS, mode: MODES, purpose: PURPOSES,
      txKind: TX_KINDS, reason: REASONS, instrument: INSTRUMENTS, decline: DECLINES,
      operator: OPERATORS, radioLayer: RADIO_LAYERS, radioTier: RADIO_TIERS,
      exposure: EXPOSURES, eventKind: EVENT_KINDS, eventCause: EVENT_CAUSES,
      channel: CHANNELS, conversationKind: CONVERSATION_KINDS,
      messageKind: MESSAGE_KINDS, callOutcome: CALL_OUTCOMES,
      meetingKind: MEETING_KINDS, partyRole: ROLES,
      externalVehicleKind: EXTERNAL_VEHICLE_KINDS,
      externalTripKind: EXTERNAL_TRIP_KINDS,
      vehicleOwnerType: VEHICLE_OWNER_TYPES,
      vehicleServiceClass: VEHICLE_SERVICE_CLASSES,
      vehicleSpanKind: VEHICLE_SPAN_KINDS,
      alprMovementSource: ["resident", "external"],
      plateSide: PLATE_SIDES, lighting: LIGHTING, alprOutcome: ALPR_OUTCOMES,
      incidentKind: INCIDENT_KINDS.map((kind) => kind.id),
      incidentPlaceClass: PLACE_CLASSES, service: SERVICES, disposition: DISPOSITIONS,
      // Not a fixed list: the foci are whatever `accounts.py` produced, in
      // the order the loader first saw them, so `conversation.focus` is
      // unreadable without it.
      conversationFocus: commsFoci,
    },
    strings: strings.values,
    columns: columns.map((item) => ({
      name: item.name,
      type: item.type,
      count: item.values.length,
      byteOffset: item.byteOffset,
      byteLength: item.values.byteLength,
    })),
  }));
  after = timings.since("build header", after);

  status?.("writing KDAY file");
  const dataStart = align8(8 + header.byteLength);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  const handle = await open(temporary, "w");
  let complete = false;
  try {
    await handle.writeFile(MAGIC);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, header.byteLength, true);
    await handle.writeFile(size);
    await handle.writeFile(header);
    await handle.writeFile(new Uint8Array(dataStart - 8 - header.byteLength));

    let written = 0;
    for (const item of columns) {
      const offset = item.byteOffset!;
      if (offset > written) await handle.writeFile(new Uint8Array(offset - written));
      await handle.writeFile(new Uint8Array(item.values.buffer, item.values.byteOffset, item.values.byteLength));
      written = offset + item.values.byteLength;
    }
    if (openingOffset > written) await handle.writeFile(new Uint8Array(openingOffset - written));
    await handle.writeFile(encodedOpening.bytes);
    written = openingOffset + encodedOpening.bytes.byteLength;
    if (stateOffset > written) await handle.writeFile(new Uint8Array(stateOffset - written));
    await handle.writeFile(encodedState.bytes);
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await rm(temporary, { force: true });
  }
  try {
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  timings.since("write file", after);

  return {
    path: output,
    bytes: dataStart + payloadLength,
    persons: counts.person,
    schedules: counts.schedule,
    legs: counts.leg,
    points: counts.path,
    vehicles: vehicleDay.vin.length,
    vehicleSpans: vehicleDay.spanStart.length,
    transactions: counts.tx,
    spent,
    spans: counts.span,
    events: counts.event,
    messages: messageAt.length,
    calls: callAt.length,
    meetings: meetingKey.length,
    parties: partyPerson.length,
    stoodUp,
    alprPasses: alpr.truthCorrelation.length,
    alprReads: alpr.reads,
    alprCorrect: alpr.correct,
    alprMisread: alpr.misread,
    alprUnreadable: alpr.unreadable,
    alprNotCaptured: alpr.notCaptured,
    externalVehicles: external.vehicles.length,
    externalTrips: external.tripVehicle.length,
    throughTrips: external.throughTrips,
    stoppingTours: external.stoppingTours,
    incidents: incidentKind.length,
    responses: responseIncident.length,
    unservedIncidents: incidentDisposition.filter((d) => DISPOSITIONS[d] === "unserved").length,
    medianResponseMinutes: medianResponse,
    closingState: encodedState.digest,
    openingState: encodedOpening.digest,
    timings,
    workers: pool?.timings ?? null,
  };
}

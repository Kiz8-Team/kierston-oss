/**
 * Internal API for who talks to whom, and when.
 *
 *   types.ts      the vocabulary: accounts, conversations, messages, calls
 *   accounts.ts   who is reachable on what, and the city's group threads
 *   attention.ts  when a person looks at their phone, derived from their day
 *   channel.ts    which app a pair actually use
 *   exchange.ts   the conversations themselves
 *
 * Who each person would message, and how often, is no longer here: the tie
 * graph moved to `activities/social/graph.ts` when a second layer started
 * reading it. A tie whose only consequence was a text message belonged to
 * this subsystem; one that also decides where somebody spends their evening
 * does not.
 *
 * The one structural thing to know before reading any of it: this layer does
 * not run inside the per-person loop the way `network/` does, and it cannot.
 * A reply is a property of the *recipient's* day — whether they were asleep,
 * driving, or at a desk when the message arrived — so no conversation can be
 * resolved until every party's day has been planned.
 *
 * Hence two phases rather than one. The caller streams people through
 * `observe` as it plans them, which is free: an attention curve is derived
 * from a day that already exists. Then `resolve` runs the whole city's
 * conversations in one pass. The exporter's loop needs no restructuring for
 * this; it just calls the second method after the first loop ends.
 */

import type { Day } from "../scheduler/index.ts";
import type { Person, World } from "../world/index.ts";
import type { Subscribers } from "../network/index.ts";
import { Accounts } from "./accounts.ts";
import { Gatherings, heldIn } from "./gatherings.ts";
import type { Meeting } from "../activities/social/index.ts";
import { Graph } from "../activities/social/index.ts";
import { attentionCurve, MINUTES, type Attention } from "./attention.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import { cumulativeAttention, runExchanges, runCommunicationRequest, projectCarrierRecords, reconcileCommunications, unreachableAt,
  dropUndeliveredReplies, dropUnfoundedCallbacks,
  type CommunicationRequest, type ExchangeWorld, type Actor, type CellAt } from "./exchange.ts";
import {
  EMERGENCY_PERSON, VOICE, emptyCommunicationsBoundary, emptyDayComms,
  type CommunicationsBoundaryState, type DayComms,
} from "./types.ts";

export * from "./types.ts";
export * from "./attention.ts";
export * from "./accounts.ts";
export * from "./channel.ts";
export * from "./gatherings.ts";
export {
  runExchanges, cumulativeAttention, callCells, reconcileCommunications,
  type Actor, type CellAt,
} from "./exchange.ts";
export type { CommunicationRequest } from "./exchange.ts";

/**
 * The communications layer, loaded once and read for every date.
 *
 * Static in the way `Network` is static: the accounts, the group threads and
 * the tie graph are facts about the city and not about any one day. What is
 * per-date is the actor registry, which `reset` clears.
 */
export class Comms {
  private readonly actors = new Map<number, Actor>();
  /**
   * Who was at which shared activity, as the planner actually delivered it.
   *
   * Filled by `observe` from the timelines themselves rather than from
   * `meetingsFor`, so a person the roads could not get to a restaurant is
   * correctly absent from it here. See `gatherings.ts`.
   */
  readonly gatherings = new Gatherings();
  closing: CommunicationsBoundaryState = emptyCommunicationsBoundary();
  private readonly emergencies: { key: string; person: number; minute: number; seed: number }[] = [];
  readonly emergencyCalls = new Map<string, number>();

  private constructor(readonly accounts: Accounts, readonly graph: Graph) {}

  static async open(subscribers: Subscribers, graph?: Graph): Promise<Comms> {
    const accounts = await Accounts.open(subscribers);
    // The graph is the day context's now, because the meetings layer needs it
    // too and reading ties.bin twice is a needless half second and a needless
    // copy. A caller that has no context yet may still ask for its own.
    return new Comms(accounts, graph ?? await Graph.open());
  }

  /**
   * Register one person's planned day.
   *
   * Cheap: the curve is derived from a timeline the caller already has, and
   * the cumulative array it caches is what makes sampling a start minute a
   * binary search rather than a scan. Call it for everybody who should be able
   * to send or receive anything on this date.
   */
  observe(planned: Day, person: Person, occupation: string | null, seed: number, day: number): void {
    if (person.incarcerated) return;
    this.adopt(observationOf(planned, person, occupation, seed, day));
  }

  /**
   * The same registration, from a reading of a day rather than the day itself.
   *
   * This is the seam a parallel export goes through. Everything `observe`
   * derives is a pure function of one person's plan, so it can be derived
   * wherever that plan was made — but the registry it lands in is the whole
   * city's and has to be one. So the deriving is `observationOf`, the
   * recording is here, and `observe` is the two of them for a caller that has
   * the day in hand.
   *
   * Insertion order is part of the contract: `runExchanges` walks the actor
   * registry, so a caller adopting observations out of person order would get
   * a different — equally valid, but different — set of conversations. A
   * parallel caller must therefore adopt its shards in order, not as they
   * arrive.
   */
  adopt(observation: Observation): void {
    // Before the curve, and unconditionally: somebody with no handset still
    // sits at the table, and whether they turned up is what tells the layer
    // that everybody else's arrangement held.
    for (const meeting of observation.held) this.gatherings.record(meeting, observation.person);
    const attention = observation.attention;
    if (!attention.known) return;
    this.actors.set(observation.person, {
      person: observation.person,
      age: observation.age,
      attention,
      anchors: observation.anchors,
      // Recomputed here rather than carried across a worker boundary: it is
      // eleven kilobytes a person of running total, derivable from the curve
      // beside it in a single pass, and sending it would be the largest thing
      // in the message by an order of magnitude.
      cumulative: cumulativeAttention(attention),
    });
    for (const span of observation.parted ?? []) this.partFromHandset(observation.person, span.from, span.until);
  }

  /** Whether a person's day has been registered for this date. */
  has(person: number): boolean {
    return this.actors.has(person);
  }

  /**
   * Nothing reaches this person from `minute` on, and nothing leaves them.
   *
   * The registration stays: the handset is still on the network and still
   * has a cell, texts to it are still delivered. What changes is that no call
   * is answered, no reply is sent and no exchange is opened. The attention
   * curve is zeroed from the minute rather than left to the flag alone,
   * because the curve is what the city-wide pass samples opening minutes
   * from, and a dead person with a live curve would still start
   * conversations.
   */
  silence(person: number, minute: number): void {
    const actor = this.actors.get(person);
    if (!actor) throw new Error(`person ${person} has no observed day to silence`);
    const from = Math.max(0, Math.floor(minute));
    actor.unreachableFrom = Math.min(actor.unreachableFrom ?? MINUTES, from);
    actor.attention.minute.fill(0, from);
    actor.attention.asleep.fill(0, from);
    actor.cumulative = cumulativeAttention(actor.attention);
  }

  /**
   * The person is parted from their handsets between `from` and `until`: a
   * phone left at home, dropped at a kerb, thrown from a car, or every
   * handset switched off or out of battery. Same as
   * `silence` for the interval — nothing sent, nothing answered, no exchange
   * opened, inbound texts still delivered to the handset where it lies — and
   * ordinary from `until` on, when the owner has the phone back. `until` at or
   * past midnight is a `silence`.
   */
  partFromHandset(person: number, from: number, until: number): void {
    const start = Math.max(0, Math.floor(from));
    const end = Math.floor(until);
    if (end >= MINUTES) { this.silence(person, start); return; }
    if (end <= start) return;
    const actor = this.actors.get(person);
    if (!actor) throw new Error(`person ${person} has no observed day to part from a handset`);
    (actor.unreachableDuring ??= []).push({ from: start, until: end });
    actor.attention.minute.fill(0, start, end);
    actor.attention.asleep.fill(0, start, end);
    actor.cumulative = cumulativeAttention(actor.attention);
  }

  /** Queue a call to the emergency line; placed when the day resolves. */
  dial911(key: string, person: number, minute: number, seed: number): void {
    this.emergencies.push({ key, person, minute, seed });
  }

  attentionFor(person: number): Attention | null {
    return this.actors.get(person)?.attention ?? null;
  }

  /**
   * Every conversation the city had on this date.
   *
   * `cellAt` is how a carrier record learns where the handset was. Pass the
   * network layer's span lookup where there is one; pass null and the SMS
   * records come out with no cell, which is a smaller file and an honest one
   * — a run with no radio simulated genuinely does not know.
   */
  resolve(
    seed: number, day: number, cellAt: CellAt | null, world: World, date: Date,
    opening: CommunicationsBoundaryState = emptyCommunicationsBoundary(),
  ): DayComms {
    const out = emptyDayComms();
    // Sealing turns the attendance sets into the per-person windows the
    // exchange layer tests co-presence against. It cannot happen in `observe`,
    // because a window has to name everybody else at the table and the last
    // party is not known until the last person has been streamed.
    this.gatherings.seal();
    const exchangeWorld = {
        accounts: this.accounts, graph: this.graph, actors: this.actors, seed, day, cellAt,
        world, date, gatherings: this.gatherings,
        dyadIndex: new Map(), seqOf: new Map(),
      };
    runExchanges(exchangeWorld, out);
    this.placeEmergencies(exchangeWorld, out);
    this.closing = reconcileCommunications(exchangeWorld, out, opening);
    projectCarrierRecords(exchangeWorld, out);
    return out;
  }

  /** Drop the day's registry. A caller running two dates must call this between them. */
  reset(): void {
    this.actors.clear();
    this.gatherings.reset();
    this.closing = emptyCommunicationsBoundary();
    this.emergencies.length = 0;
    this.emergencyCalls.clear();
  }

  private placeEmergencies(exchangeWorld: ExchangeWorld, out: DayComms): void {
    const queued = [...this.emergencies].sort((a, b) => a.minute - b.minute || a.key.localeCompare(b.key));
    for (const call of queued) {
      const actor = this.actors.get(call.person);
      if (!actor || !actor.attention.known || call.minute < 0 || call.minute >= MINUTES) continue;
      if (!this.accounts.on(call.person, VOICE)) continue;
      if (unreachableAt(actor, call.minute)) continue;
      const until = Math.min(MINUTES, call.minute + 3);
      actor.attention.asleep.fill(0, call.minute, until);
      actor.attention.minute.fill(255, call.minute, until);
      const rng = new Rng(call.seed);
      const row = out.calls.length;
      runCommunicationRequest(exchangeWorld, out, {
        from: call.person, to: EMERGENCY_PERSON, channel: VOICE, kind: "call",
        at: call.minute * 60 + rng.int(0, 59), seed: rng.int(0, 0x7fffffff),
      });
      if (out.calls.length > row) this.emergencyCalls.set(call.key, row);
    }
  }

  get observed(): number {
    return this.actors.size;
  }

  private exchangeWorld(seed: number, day: number, cellAt: CellAt | null, world: World, date: Date): ExchangeWorld {
    this.gatherings.seal();
    return { accounts: this.accounts, graph: this.graph, actors: this.actors, seed, day, cellAt,
      world, date, gatherings: this.gatherings, dyadIndex: new Map(), seqOf: new Map() };
  }

  request(request: CommunicationRequest, seed: number, day: number, world: World, date: Date): DayComms {
    const out = emptyDayComms();
    runCommunicationRequest(this.exchangeWorld(seed, day, null, world, date), out, request);
    return out;
  }

  project(
    out: DayComms, seed: number, day: number, cellAt: CellAt, world: World, date: Date,
    opening: CommunicationsBoundaryState = emptyCommunicationsBoundary(),
  ): void {
    const exchangeWorld = this.exchangeWorld(seed, day, cellAt, world, date);
    // `request` drew replies and callbacks with no radio (delivery at +2 s,
    // every call reaching the callee). Now that the radio is known, remove
    // the replies sent before their parent was delivered and the callbacks
    // to calls that failed, then write the carrier rows for what is left.
    // Text deliveries depend only on the radio, so they are settled before
    // reconcile; call outcomes come from reconcile, so callbacks after it.
    dropUndeliveredReplies(exchangeWorld, out, projectCarrierRecords(exchangeWorld, out));
    this.closing = reconcileCommunications(exchangeWorld, out, opening);
    dropUnfoundedCallbacks(out);
    projectCarrierRecords(exchangeWorld, out);
  }
}

/**
 * One person's day, read for everything this layer needs from it.
 *
 * Deliberately all plain data and typed arrays: this is what crosses a worker
 * boundary in a parallel export, so nothing here may be a class instance or
 * hold a reference to a `Day`.
 */
export interface Observation {
  person: number;
  age: number;
  attention: Attention;
  anchors: number[];
  /** The gatherings the planner really delivered this person to. */
  held: readonly Meeting[];
  /**
   * Minutes `[from, until)` the person had no usable handset: every handset
   * powered off, out of battery, or left at home while they were out.
   */
  parted?: readonly { from: number; until: number }[];
}

/** Read one planned day. Pure, and cheap enough to run inside the planning loop. */
export function observationOf(
  planned: Day, person: Person, occupation: string | null, seed: number, day: number,
): Observation {
  return {
    person: person.id,
    age: person.age,
    attention: attentionCurve(planned, person, occupation, seed, day),
    anchors: anchorsOf(planned),
    held: heldIn(planned),
  };
}

/**
 * The minutes a person set off or arrived somewhere.
 *
 * Logistical traffic is about transitions, so these are where it hangs. Both
 * ends of every leg, because "leaving now" and "just got here" are both
 * ordinary and land at opposite ends of the same journey.
 */
function anchorsOf(planned: Day): number[] {
  const anchors: number[] = [];
  for (const leg of planned.legs) {
    if (leg.depart >= 0 && leg.depart < MINUTES) anchors.push(leg.depart);
    if (leg.arrive >= 0 && leg.arrive < MINUTES) anchors.push(leg.arrive);
  }
  return anchors;
}

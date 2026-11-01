/**
 * The conversations themselves: who speaks today, and how it goes.
 *
 * Five decisions in order, and the order is the design. Each one narrows what
 * the next is choosing between, so that by the time a message is emitted
 * almost everything about it has already been settled by facts rather than by
 * a draw against a distribution.
 *
 *   1. does this pair speak today          from the tie's weekly rate
 *   2. what for                            purpose, drawn from the relationship
 *   3. who starts, and when                initiator trait, then the day plan
 *   4. how it unfolds                      a branching process, not a length
 *   5. over what                           the pair's sticky channel
 *
 * The branching process is the part worth reading
 * -----------------------------------------------
 * A conversation is not N messages sampled from a length distribution. It is
 * one message that provokes a reply with some probability, and that reply
 * provokes another with a slightly lower one. Set the mean number of children
 * below one and the process terminates on its own, with a heavy tail nobody
 * had to write down: most exchanges are two or three messages, a few run to
 * forty, and the shape of that is a consequence rather than a parameter.
 *
 * Reply latency is not in this file at all
 * ----------------------------------------
 * It is `nextGlance` in attention.ts, which walks the *recipient's* own day
 * until they next pick up their phone. That is the single most important
 * structural fact about this layer: a reply is a property of the person
 * receiving it, so the whole model has to run over a city whose days are all
 * already planned. It cannot live inside the per-person loop the way the radio
 * layer does, and pretending otherwise would mean inventing a latency
 * distribution and losing the only thing here that could not be faked.
 *
 * Determinism without carrying state between dates
 * ------------------------------------------------
 * Real contact between two people is bursty: they speak four times this week
 * and not at all next. The natural implementation keeps a "days since last
 * contact" per pair and inflates the rate as it grows, and it cannot be used
 * here, because the engine's whole discipline is that any date regenerates on
 * its own from a seed (see shared/rng.ts). A pair whose Tuesday depended on
 * their Monday could not be produced without producing Monday.
 *
 * So the burstiness is drawn rather than accumulated: a per-pair, per-week
 * multiplier, plus a per-pair weekday shape. Two people have busy weeks and
 * quiet weeks and a habit of speaking on Sundays, all of it reproducible from
 * the pair and the date alone. It gives the right overdispersion and the right
 * weekly rhythm; what it does not give is the true renewal process, where a
 * long silence *itself* raises the odds. That is a real difference and it is
 * the price of regenerable dates.
 */

import { LAYER, stream, Rng } from "../shared/index.ts";
import {
  MESSAGE_KINDS, PURPOSES, SMS, MMS, VOICE, CONVERSATION_KINDS, CALL_OUTCOMES, NONE,
  isCarrier, isService, outcomeOf, type Call, type Conversation, type DayComms, type Message,
  type CommunicationsBoundaryState,
} from "./types.ts";
import { SECONDS, SECONDS_PER_MINUTE, MINUTES, nextGlance, type Attention } from "./attention.ts";
import { pairChannels, channelFor, type PairChannels } from "./channel.ts";
import { invitationFor, type Contact, type Graph } from "../activities/social/index.ts";
import type { World } from "../world/index.ts";
import type { Accounts } from "./accounts.ts";
import type { Gatherings, Held } from "./gatherings.ts";

/** One person, as the exchange layer needs them: a day, and a way to be reached. */
export interface Actor {
  person: number;
  age: number;
  attention: Attention;
  /**
   * Minutes at which the person arrived somewhere or set off, which is where
   * logistical traffic hangs. Taken from the planned legs rather than from a
   * clock, so "text on the way home" lands on this person's own way home.
   */
  anchors: number[];
  /** Cumulative attention, for sampling a minute in proportion to it. */
  cumulative: Float64Array;
  /**
   * The minute from which nothing reaches this person, or undefined.
   *
   * Distinct from a zero attention curve, which still lets a call be answered
   * at the floor rate — a phone by the bed is picked up sometimes. This is the
   * one state with no floor: the handset keeps its cell and its inbound texts
   * are delivered, but no call is ever answered and nothing is ever sent. A
   * scenario sets it for somebody who died, and it is the reason the dead do
   * not text back.
   */
  unreachableFrom?: number;
  /**
   * Minute intervals `[from, until)` in which the person has no usable
   * handset: a phone left at home while its owner drives across town, or
   * every handset powered off or out of battery. Same effect as
   * `unreachableFrom`, on every channel, but it ends when the owner has a
   * working phone again.
   */
  unreachableDuring?: { from: number; until: number }[];
}

/** Whether nothing reaches or leaves this person at `minute`: dead, or away from every handset. */
export function unreachableAt(actor: Actor | undefined | null, minute: number): boolean {
  if (!actor) return false;
  if (actor.unreachableFrom !== undefined && minute >= actor.unreachableFrom) return true;
  return actor.unreachableDuring?.some((span) => minute >= span.from && minute < span.until) ?? false;
}

/** What the caller supplies so a carrier record can name a cell. */
export type CellAt = (subscriber: number, minute: number) => number;

// ---------------------------------------------------------------------------
// Purpose
// ---------------------------------------------------------------------------

const DYAD = CONVERSATION_KINDS.indexOf("dyad");
const LOGISTICAL = PURPOSES.indexOf("logistical");
const CONVERSATIONAL = PURPOSES.indexOf("conversational");
const BROADCAST_PURPOSE = PURPOSES.indexOf("broadcast");
const VOICE_PURPOSE = PURPOSES.indexOf("voice");

/**
 * How likely each purpose is, before the relationship adjusts it.
 *
 * Logistical dominates and should: most messages people send are about where
 * they are, when they will be somewhere, and what to bring. A dataset whose
 * modal exchange is a long conversation is a dataset of best friends, not of
 * a city.
 */
const PURPOSE_BASE = [0.52, 0.22, 0.07, 0.19];

/**
 * How the exchange branches, per purpose.
 *
 *   reply  probability the first message gets an answer at all
 *   decay  what that probability is multiplied by at each further depth
 *
 * `reply * (1 / (1 - decay))` is roughly the expected message count, so
 * conversational runs to around ten to fifteen and logistical to three. Both
 * are means of a distribution with a long tail rather than targets.
 */
const BRANCHING = [
  { reply: 0.72, decay: 0.55 },  // logistical
  { reply: 0.90, decay: 0.90 },  // conversational
  { reply: 0.14, decay: 0.35 },  // broadcast
  { reply: 0.00, decay: 0.00 },  // voice — the exchange is the call
];

/** Depth beyond which a thread is cut regardless, so one draw cannot run away. */
const MAX_DEPTH = 90;

/**
 * Ceiling on the expected replies to one message in a group.
 *
 * Multiplied by the highest `reply` in BRANCHING it must stay below one, or
 * the branching process never terminates on its own and the depth guard
 * becomes the model. 0.9 × 0.9 = 0.81.
 */
const GROUP_SPREAD_CAP = 0.9;

/**
 * How much of the day's traffic is media rather than text, per purpose.
 *
 * Broadcast is mostly a photo, which is what a broadcast into a family group
 * usually is. Logistical is almost never one.
 */
const MEDIA_SHARE = [0.04, 0.14, 0.62, 0.0];

/** Bytes on the wire, by message kind. Text is characters; the rest is a file. */
const BYTES: Record<string, [number, number]> = {
  text: [8, 320],
  image: [180_000, 3_400_000],
  video: [900_000, 42_000_000],
  "voice-note": [40_000, 900_000],
  file: [20_000, 8_000_000],
  sticker: [12_000, 90_000],
  location: [200, 800],
  reaction: [40, 120],
};

const TEXT = MESSAGE_KINDS.indexOf("text");
const MEDIA_KINDS = ["image", "video", "voice-note", "sticker", "location", "file"]
  .map((name) => MESSAGE_KINDS.indexOf(name as (typeof MESSAGE_KINDS)[number]));
const MEDIA_WEIGHTS = [0.52, 0.10, 0.13, 0.14, 0.06, 0.05];

/** Characters per SMS segment once a message is long enough to be split. */
const SMS_SEGMENT = 153;
const SMS_SINGLE = 160;

// ---------------------------------------------------------------------------
// Rate shaping
// ---------------------------------------------------------------------------

/**
 * How much a pair's week varies around their own average.
 *
 * Log-normal, and generous. Two people who average four contacts a week have
 * weeks of one and weeks of ten, and a model without this produces a contact
 * series so regular that any burst-detection task on it is trivial.
 */
const WEEK_SD = 0.62;

/** How strongly a pair favour their habitual day of the week. */
const WEEKDAY_SPREAD = 0.55;

/** Days a call is more likely than a text, as a multiplier on the voice share. */
const VOICE_BY_AGE: readonly (readonly [number, number])[] = [
  [24, 0.45], [39, 0.75], [54, 1.15], [69, 1.7], [200, 2.4],
];

/**
 * Relative number of text exchanges initiated by age.
 *
 * These are calibrated against the exported messages sent per resident-day:
 * 128, 75, 52, 33 and 16 for the five adult bands. They apply only after an
 * exchange has been classified as non-voice, so call volume is unchanged.
 */
const TEXT_ACTIVITY_BY_AGE: readonly (readonly [number, number])[] = [
  [17, 1.0],
  [24, 6.95],
  [34, 3.53],
  [44, 2.19],
  [54, 1.37],
  [200, 0.80],
];

function textActivity(age: number): number {
  for (const [upper, multiplier] of TEXT_ACTIVITY_BY_AGE) {
    if (age <= upper) return multiplier;
  }
  return 1;
}

/** Stochastic rounding keeps a fractional multiplier unbiased. */
function multipliedExchanges(multiplier: number, rng: Rng): number {
  const whole = Math.floor(multiplier);
  return whole + (rng.bool(multiplier - whole) ? 1 : 0);
}

/**
 * A pair speaking today, and how much.
 *
 * Returns the number of *separate* exchanges, which is usually zero or one and
 * occasionally more — people do pick a conversation up again in the evening,
 * and treating a day as a single Bernoulli would cap the busiest pairs at one
 * exchange and flatten exactly the relationships that carry most of the
 * traffic.
 */
function exchangesToday(contact: Contact, low: number, high: number, day: number, seed: number): number {
  const week = Math.floor(day / 7);
  const rng = stream(seed, low, LAYER.contact, high, week);
  const burst = Math.exp(rng.gauss(0, WEEK_SD) - (WEEK_SD * WEEK_SD) / 2);

  // The pair's habitual day. Drawn once for the pair, so a couple who always
  // speak on Sundays always speak on Sundays.
  const habit = stream(seed, low, LAYER.contact, high).int(0, 6);
  const weekday = ((day % 7) + 7) % 7;
  const shape = 1 + WEEKDAY_SPREAD * (weekday === habit ? 2 : -0.4);

  const daily = (contact.rate / 7) * burst * Math.max(shape, 0.05);
  const today = stream(seed, low, LAYER.contact, high, day);
  // Poisson by inversion. The rates here are small enough that the loop runs
  // once or twice; a pair with a daily rate above three is a couple, and even
  // then it terminates immediately.
  let count = 0;
  let product = Math.exp(-daily);
  let cumulative = product;
  const roll = today.next();
  while (roll > cumulative && count < 12) {
    count += 1;
    product *= daily / count;
    cumulative += product;
  }
  return count;
}

/** Which purpose this exchange serves, given what the relationship is. */
function purposeFor(contact: Contact, age: number, rng: Rng): number {
  const weights = PURPOSE_BASE.slice();

  // Shared exposure turns conversation into logistics. Two people already in
  // the same building have said the interesting things out loud; what is left
  // is arrangements.
  weights[LOGISTICAL] *= 1 + 1.4 * contact.exposure;
  weights[CONVERSATIONAL] *= 1 - 0.55 * contact.exposure;

  // Affinity is what buys an actual conversation.
  weights[CONVERSATIONAL] *= 0.35 + 2.2 * contact.affinity;
  weights[BROADCAST_PURPOSE] *= 0.4 + 1.6 * contact.affinity;

  // Voice rises steeply with age, and it is the clearest generational split in
  // the whole layer: a seventy-year-old rings, a nineteen-year-old does not.
  let voice = 1;
  for (const [upper, factor] of VOICE_BY_AGE) {
    if (age <= upper) { voice = factor; break; }
  }
  weights[VOICE_PURPOSE] *= voice;

  return rng.weighted([0, 1, 2, 3], weights);
}

// ---------------------------------------------------------------------------
// Placing the opening message
// ---------------------------------------------------------------------------

/**
 * Build the cumulative attention curve, so a minute can be sampled in
 * proportion to how likely the person was to be on their phone in it.
 *
 * Done once per person per day and cached on the actor. Sampling by rejection
 * instead would be simpler and would loop for a night worker whose curve is
 * zero across most of the array.
 */
export function cumulativeAttention(attention: Attention): Float64Array {
  const cumulative = new Float64Array(MINUTES);
  let total = 0;
  for (let minute = 0; minute < MINUTES; minute += 1) {
    total += attention.known ? attention.minute[minute]! : 0;
    cumulative[minute] = total;
  }
  return cumulative;
}

function sampleMinute(actor: Actor, rng: Rng): number {
  const total = actor.cumulative[MINUTES - 1]!;
  if (total <= 0) return -1;
  const target = rng.next() * total;
  let low = 0;
  let high = MINUTES - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (actor.cumulative[mid]! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Share of logistical messages that hang on a transition rather than being
 * sampled from the sender's attention.
 *
 * Held well below one because the first pass put it at 0.72 and moved the
 * city's whole messaging peak into the afternoon: leg boundaries cluster
 * around the commute and the school run, so anchoring most of the largest
 * purpose there overwhelmed the evening. Plenty of logistical traffic is not
 * about a journey at all — it is about tonight, or the weekend, or what to
 * pick up — and that share belongs on the attention curve like everything
 * else.
 */
const ANCHORED = 0.4;

/**
 * When the opening message goes.
 *
 * Logistical traffic hangs off a transition — somebody setting off, somebody
 * arriving — because that is what it is about. Everything else is sampled
 * from the initiator's attention, which puts it wherever their own day left
 * room. Falling back to the attention sample when there are no anchors is not
 * a special case: a person who went nowhere today has nothing to announce.
 */
function openingSecond(actor: Actor, purpose: number, rng: Rng): number {
  if (purpose === LOGISTICAL && actor.anchors.length > 0 && rng.bool(ANCHORED)) {
    const anchor = actor.anchors[Math.floor(rng.next() * actor.anchors.length)]!;
    const minute = Math.min(MINUTES - 1, Math.max(0, Math.round(anchor + rng.gauss(0, 6))));
    // The anchor is a leg boundary, not a statement that the person was
    // available — and until this check it bypassed the attention curve
    // entirely, which let somebody announce their departure from inside a
    // sleep bout. A zero-attention minute falls through to the sampled path
    // rather than being used.
    if (actor.attention.minute[minute]! > 0) {
      return minute * SECONDS_PER_MINUTE + Math.floor(rng.next() * SECONDS_PER_MINUTE);
    }
  }
  const minute = sampleMinute(actor, rng);
  if (minute < 0) return -1;
  return minute * SECONDS_PER_MINUTE + Math.floor(rng.next() * SECONDS_PER_MINUTE);
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

export interface ExchangeWorld {
  accounts: Accounts;
  graph: Graph;
  actors: Map<number, Actor>;
  seed: number;
  day: number;
  cellAt: CellAt | null;
  /** The population, for the convener draw the arrangement traffic reaches into. */
  world: World;
  /** Today's date, so a gathering three days out can be derived from it. */
  date: Date;
  /** Who was where with whom, from the timelines the planner actually produced. */
  gatherings: Gatherings;
  /** externalId to position in `DayComms.dyads`, so a repeat lookup is O(1). */
  dyadIndex: Map<string, number>;
  /**
   * The next sequence number for each thread, for this date.
   *
   * It has to live here rather than inside one exchange, because a thread can
   * carry more than one exchange in a day — a pair who speak in the morning
   * and again after work share a thread, and so does a group with a busy
   * afternoon. A counter local to the exchange restarts at zero the second
   * time, which collides the sequence numbers and makes `replyTo` resolve to
   * whichever message happened to claim that seq first. That showed up as
   * replies timestamped before the messages they answered.
   */
  seqOf: Map<number, number>;
}

/** A deliberate exchange; ordinary replies and callbacks use the same model. */
export interface CommunicationRequest {
  from: number;
  to: number;
  channel: number;
  at: number;
  seed: number;
  kind: "text" | "call";
  bytes?: number;
  replies?: boolean;
  duration?: number;
  outcome?: number;
}

/**
 * How long a call to the emergency line lasts once it is answered.
 *
 * Median a little under two minutes with a long tail: the dispatcher takes
 * the location, the nature of the call and a callback number, and keeps a
 * caller on the line while a unit is on the way. Answered on the first ring or
 * two, always — a public-safety answering point that rings out is a scandal,
 * not a modelled outcome.
 */
const EMERGENCY_DURATION_MEDIAN = 105;
const EMERGENCY_DURATION_SD = 0.55;

export function runCommunicationRequest(world: ExchangeWorld, out: DayComms, request: CommunicationRequest): void {
  if (world.world.persons.get(request.from)?.incarcerated
      || world.world.persons.get(request.to)?.incarcerated) {
    throw new Error("incarcerated people cannot send or receive phone communications");
  }
  const caller = world.actors.get(request.from);
  const service = isService(request.to);
  const callee = service ? null : world.actors.get(request.to) ?? null;
  if (!caller || (!callee && !service)) throw new Error("communication participants must have observed days");
  if (service && request.kind !== "call") throw new Error("a service line takes calls, not texts");
  if (service && request.channel !== VOICE) throw new Error("a service line is reached over carrier voice");
  if (request.from === request.to) throw new Error("cannot communicate with self");
  if (!Number.isInteger(request.at) || request.at < 0 || request.at >= SECONDS) throw new Error("communication outside day");
  if (request.bytes !== undefined && (!Number.isInteger(request.bytes) || request.bytes < 1 || request.bytes > SMS_SEGMENT * 255)) throw new Error("invalid text size");
  if (request.duration !== undefined && (!Number.isInteger(request.duration) || request.duration < 1)) throw new Error("invalid call duration");
  if (request.outcome !== undefined && (!Number.isInteger(request.outcome) || request.outcome < 0 || request.outcome >= CALL_OUTCOMES.length)) throw new Error("invalid call outcome");
  if (!world.accounts.on(request.from, request.channel) || !world.accounts.on(request.to, request.channel)) {
    throw new Error("both participants must hold an account on the requested channel");
  }
  if (caller.attention.asleep[Math.floor(request.at / 60)]) throw new Error("communication initiator is asleep");
  if (unreachableAt(caller, Math.floor(request.at / 60))) {
    throw new Error("communication initiator is unreachable at that time");
  }
  const rng = new Rng(request.seed);
  if (request.kind === "text") {
    const thread = dyadThread(world, out, request.from, request.to, request.channel)!;
    branch(world, out, thread, [caller, callee], caller, request.at, CONVERSATIONAL, null, rng, 2, request);
  } else {
    const contact: Contact = { other: request.to, kind: 0, affinity: 0.5, exposure: 0, valence: 1, rate: 1, social: 0 };
    const instructed = service
      ? { ...request, replies: false, outcome: request.outcome ?? outcomeOf("answered"),
          duration: request.duration ?? Math.max(15, Math.round(Math.exp(rng.gauss(
            Math.log(EMERGENCY_DURATION_MEDIAN), EMERGENCY_DURATION_SD)))) }
      : request;
    voiceExchange(world, out, caller, callee, request.from, request.to, contact,
      { dominant: request.channel, spill: request.channel, voice: request.channel }, request.at, rng, instructed);
  }
}

/**
 * Project existing exchanges onto a radio result without sampling them again.
 *
 * Returns, per carrier message index, the delivery second by recipient
 * person (NONE when never delivered), for `dropUnfoundedResponses`.
 */
export function projectCarrierRecords(world: ExchangeWorld, out: DayComms): Map<number, ReadonlyMap<number, number>> {
  out.sms = []; out.cdr = []; out.handovers = [];
  const deliveries = new Map<number, ReadonlyMap<number, number>>();
  const threads = new Map([...world.accounts.conversations, ...out.dyads].map((thread) => [thread.index, thread]));
  const membersOf = (thread: Conversation): (Actor | null)[] => {
    const ids = thread.index < world.accounts.conversations.length
      ? world.accounts.participants.slice(thread.at, thread.at + thread.count)
      : out.dyadParticipants.slice(thread.at, thread.at + thread.count);
    return Array.from(ids, (id) => world.actors.get(world.accounts.all[id]!.person) ?? null);
  };
  // The send's own channel, not the thread's: a spilled message went over the
  // carrier and the thread it belongs to did not.
  for (const message of out.messages) {
    if (!isCarrier(message.channel)) continue;
    const thread = threads.get(message.conversation)!;
    const from = world.actors.get(world.accounts.all[message.from]!.person)!;
    deliveries.set(message.index, carrierRecords(world, out, message, message.channel, membersOf(thread), from, thread));
  }
  for (const call of out.calls) {
    const thread = threads.get(call.conversation)!;
    const from = world.accounts.all[call.from]!.person;
    const other = membersOf(thread).find((actor) => actor && actor.person !== from);
    callCarrierRecords(world, out, thread, call, other?.person ?? null);
  }
  return deliveries;
}

/**
 * Run every conversation in the city for one date.
 *
 * Pairs are drawn once, at the lower of the two ids, so a tie is not
 * considered twice. A contact who is outside the population is drawn by the
 * resident, because nobody else can.
 */
export function runExchanges(world: ExchangeWorld, out: DayComms): void {
  const { graph, actors, seed, day } = world;

  for (const [person, actor] of actors) {
    if (!actor.attention.known) continue;
    const [start, end] = graph.range(person);
    for (let i = start; i < end; i += 1) {
      const contact = graph.contacts[i]!;
      const other = contact.other;
      const resident = actors.has(other);
      // The lower id owns the pair, so it is considered exactly once. An
      // off-map contact has no actor and is always owned by the resident.
      if (resident && other < person) continue;

      const low = Math.min(person, other);
      const high = Math.max(person, other);
      const count = exchangesToday(contact, low, high, day, seed);
      if (count === 0) continue;

      for (let n = 0; n < count; n += 1) {
        dyadExchange(world, out, actor, contact, resident ? actors.get(other)! : null, n);
      }
    }
  }

  groupExchanges(world, out);
  gatheringExchanges(world, out);
  arrangementExchanges(world, out);
  prune(world, out);
}

/**
 * Resolve the shared resources that independent relationship draws cannot see.
 *
 * Exchange generation proposes attempts. This pass gives those attempts a
 * single chronological telephone line per participant, makes carrier voice
 * conditional on radio attachment, and carries live occupancy over midnight.
 */
export function reconcileCommunications(
  world: ExchangeWorld,
  out: DayComms,
  opening: CommunicationsBoundaryState,
): CommunicationsBoundaryState {
  const busyUntil = new Map<number, number>();
  for (const pending of opening.pending) {
    if (pending.kind !== "active-call") continue;
    for (const person of pending.participants) {
      busyUntil.set(person, Math.max(busyUntil.get(person) ?? 0, pending.remainingSeconds));
    }
  }

  const threads = new Map([...world.accounts.conversations, ...out.dyads]
    .map((thread) => [thread.index, thread]));
  const participantPeople = (thread: Conversation): number[] => {
    const ids = thread.index < world.accounts.conversations.length
      ? world.accounts.participants.slice(thread.at, thread.at + thread.count)
      : out.dyadParticipants.slice(thread.at, thread.at + thread.count);
    return Array.from(ids, (id) => world.accounts.all[id]!.person);
  };
  const closing: CommunicationsBoundaryState["pending"] = [];
  const ordered = [...out.calls].sort((a, b) => a.at - b.at || a.index - b.index);

  for (const call of ordered) {
    const thread = threads.get(call.conversation);
    const account = world.accounts.all[call.from];
    if (!thread || !account) continue;
    const caller = account.person;
    const callee = participantPeople(thread).find((person) => person !== caller) ?? null;
    // A service line is an answering point with many operators, not one
    // handset: two callers at once do not collide on it.
    const trunk = callee !== null && isService(callee);
    const callerBusy = (busyUntil.get(caller) ?? 0) > call.at;
    const calleeBusy = callee !== null && !trunk && (busyUntil.get(callee) ?? 0) > call.at;
    const carrier = thread.channel === VOICE && world.cellAt !== null;
    const callerAttached = !carrier || (call.subscriber >= 0
      && world.cellAt!(call.subscriber, Math.floor(call.at / SECONDS_PER_MINUTE)) !== NONE);
    const to = callee === null ? NONE : calleeSubscriber(world, callee, thread.channel);
    const calleeAttached = !carrier || to < 0 || world.cellAt!(to,
      Math.min(MINUTES - 1, Math.floor((call.at + call.ring) / SECONDS_PER_MINUTE))) !== NONE;

    // Busy is an observed collision, not a background random outcome.
    if (callerBusy) {
      call.outcome = outcomeOf("failed");
      call.duration = 0;
      call.ring = 1;
    } else if (calleeBusy) {
      call.outcome = outcomeOf("busy");
      call.duration = 0;
      call.ring = Math.min(call.ring, 9);
    } else if (!callerAttached || !calleeAttached) {
      call.outcome = outcomeOf("failed");
      call.duration = 0;
      call.ring = 1;
    } else if (call.outcome === outcomeOf("busy") && !call.instructed) {
      // A sampled busy with no collision behind it rings out instead. A busy
      // a scenario asked for stands.
      call.outcome = outcomeOf("no-answer");
      call.ring = RING_OUT;
    }

    // An answered call ends when either end can no longer carry it: the
    // handset detaches (power, battery, coverage) or a party dies or is
    // parted from the phone. Checked minute by minute from the answer, and
    // the call is cut at the start of the first such minute. `callCells`
    // reads the shortened span, so the CDR end cell and handovers stop there.
    if (call.outcome === outcomeOf("answered") && call.duration > 0) {
      const callerActor = world.actors.get(caller);
      const calleeActor = callee !== null && !trunk ? world.actors.get(callee) : undefined;
      const talkFrom = call.at + call.ring;
      const talkUntil = talkFrom + call.duration;
      let cut = talkUntil;
      for (let minute = Math.floor(talkFrom / SECONDS_PER_MINUTE);
        minute < MINUTES && minute * SECONDS_PER_MINUTE < talkUntil; minute += 1) {
        const lost = unreachableAt(callerActor, minute) || unreachableAt(calleeActor, minute)
          || carrier && (call.subscriber < 0 || world.cellAt!(call.subscriber, minute) === NONE
            || to >= 0 && world.cellAt!(to, minute) === NONE);
        if (lost) { cut = Math.max(talkFrom, minute * SECONDS_PER_MINUTE); break; }
      }
      if (cut <= talkFrom) {
        // Lost in the minute it would have been picked up: never answered,
        // and it rings to the timer like any unanswered call.
        call.outcome = outcomeOf("no-answer");
        call.duration = 0;
        call.ring = RING_OUT;
      } else {
        call.duration = cut - talkFrom;
      }
    }

    const resolved = call.at + call.ring + call.duration;
    // The caller occupies their line for every attempt. The callee occupies it
    // while this simplified single-line model is ringing or connected.
    busyUntil.set(caller, Math.max(busyUntil.get(caller) ?? 0, resolved));
    const occupiesCallee = callee !== null && !trunk && !callerBusy && !calleeBusy
      && callerAttached && calleeAttached;
    if (occupiesCallee) {
      busyUntil.set(callee, Math.max(busyUntil.get(callee) ?? 0, resolved));
    }
    if (resolved > SECONDS) {
      closing.push({
        kind: "active-call",
        participants: occupiesCallee ? [caller, callee].sort((a, b) => a - b) : [caller],
        remainingSeconds: resolved - SECONDS,
      });
    }
  }

  // Extremely long calls restored from yesterday may span another boundary.
  for (const pending of opening.pending) {
    if (pending.kind === "active-call" && pending.remainingSeconds > SECONDS) {
      closing.push({ ...pending, remainingSeconds: pending.remainingSeconds - SECONDS });
    }
  }
  return { pending: closing, contactRecency: opening.contactRecency };
}

/**
 * Replies a scenario request drew against a delivery the radio did not make.
 *
 * `Comms.request` runs before the re-planned radio exists, so every carrier
 * message counts as delivered two seconds after sending and replies are drawn
 * from there. `projectCarrierRecords` later computes the real delivery, which
 * can be later or NONE. A reply sent before its parent reached the replier is
 * removed, with every reply below it. Removing is the smaller change than
 * redrawing the reply time, and it never touches the instructed first message
 * (it has no parent). Returns whether anything was removed; message indices
 * are renumbered and the carrier rows must be projected again.
 */
export function dropUndeliveredReplies(
  world: ExchangeWorld, out: DayComms, deliveries: ReadonlyMap<number, ReadonlyMap<number, number>>,
): boolean {
  const dropped = new Set<number>();
  const bySeq = new Map<string, Message>();
  // Time order puts every parent before its replies.
  const ordered = [...out.messages].sort((a, b) => a.at - b.at || a.index - b.index);
  for (const message of ordered) {
    bySeq.set(`${message.conversation}:${message.seq}`, message);
    if (message.replyTo === NONE) continue;
    const parent = bySeq.get(`${message.conversation}:${message.replyTo}`);
    if (!parent) continue;
    if (dropped.has(parent.index)) { dropped.add(message.index); continue; }
    const replier = world.accounts.all[message.from]!.person;
    const received = deliveries.get(parent.index)?.get(replier);
    if (received !== undefined && (received === NONE || received > message.at)) dropped.add(message.index);
  }
  if (dropped.size === 0) return false;
  out.messages = out.messages.filter((message) => !dropped.has(message.index));
  out.messages.forEach((message, index) => { message.index = index; });
  return true;
}

/**
 * Callbacks to a call that, once reconciled against the radio, never reached
 * the callee (`failed`), or that would start before the original ended. The
 * request drew them without the radio; the callee cannot return a call the
 * handset never rang for. Same reasoning as `dropUndeliveredReplies`.
 * Run after `reconcileCommunications`; the removed callback has already been
 * through it, which can only have lengthened the caller's busy line within
 * this one request's output. Call indices and `callback` links are renumbered.
 */
export function dropUnfoundedCallbacks(out: DayComms): boolean {
  const dropped = new Set<number>();
  // Index order: a callback is always appended after the call it returns.
  for (const call of out.calls) {
    if (call.callback === NONE) continue;
    const original = out.calls[call.callback];
    if (!original || dropped.has(original.index) || original.outcome === outcomeOf("failed")
        || call.at < original.at + original.ring + original.duration) dropped.add(call.index);
  }
  if (dropped.size === 0) return false;
  const moved = new Map<number, number>();
  out.calls = out.calls.filter((call) => !dropped.has(call.index));
  out.calls.forEach((call, index) => { moved.set(call.index, index); });
  for (const call of out.calls) {
    call.index = moved.get(call.index)!;
    if (call.callback !== NONE) call.callback = moved.get(call.callback)!;
  }
  return true;
}

/**
 * Drop the day-local threads that ended up carrying nothing.
 *
 * A thread is created before it is known whether anything will be said in it —
 * the opening minute can fall outside the day, the opener can turn out to have
 * no account on the channel, a message to somebody sitting opposite can be
 * suppressed — and `DayComms.dyads` promises the threads that spoke today and
 * only those. A row for a conversation that did not happen asserts a
 * relationship on a date it has no evidence for, which is the one thing this
 * table must not do.
 *
 * Creating them lazily instead would mean threading a thunk through every
 * caller of `branch`; this is one pass over a list that is already in hand.
 * The indices are rewritten rather than left with holes because `index` is the
 * join key the messages carry, and it is day-local by construction anyway.
 */
function prune(world: ExchangeWorld, out: DayComms): void {
  const spoke = new Set<number>();
  for (const message of out.messages) spoke.add(message.conversation);
  for (const call of out.calls) spoke.add(call.conversation);
  if (out.dyads.every((thread) => spoke.has(thread.index))) return;

  const first = world.accounts.conversations.length;
  const kept: Conversation[] = [];
  const participants: number[] = [];
  const moved = new Map<number, number>();
  for (const thread of out.dyads) {
    if (!spoke.has(thread.index)) continue;
    const at = participants.length;
    for (let i = 0; i < thread.count; i += 1) participants.push(out.dyadParticipants[thread.at + i]!);
    const index = first + kept.length;
    moved.set(thread.index, index);
    kept.push({ ...thread, index, at });
  }
  // Assigned element by element rather than spread. A city produces some
  // hundreds of thousands of live threads, and `push(...array)` passes every
  // element as an argument — which overflows the call stack somewhere in the
  // low hundred thousands and did, on the first full run.
  out.dyads.length = kept.length;
  for (let i = 0; i < kept.length; i += 1) out.dyads[i] = kept[i]!;
  out.dyadParticipants.length = participants.length;
  for (let i = 0; i < participants.length; i += 1) out.dyadParticipants[i] = participants[i]!;

  for (const message of out.messages) message.conversation = moved.get(message.conversation) ?? message.conversation;
  for (const call of out.calls) call.conversation = moved.get(call.conversation) ?? call.conversation;
}

/** How a pair's initiation is split, drawn once and kept. */
function initiatorShare(low: number, high: number, seed: number): number {
  // Beta-ish: most pairs are lopsided. Somebody always texts first.
  const rng = stream(seed, low, LAYER.exchange, high);
  return 0.5 + (rng.next() - 0.5) * 0.86;
}

function dyadExchange(
  world: ExchangeWorld,
  out: DayComms,
  actor: Actor,
  contact: Contact,
  peer: Actor | null,
  nonce: number,
): void {
  const { accounts, seed, day } = world;
  const other = contact.other;
  const low = Math.min(actor.person, other);
  const high = Math.max(actor.person, other);
  const rng = stream(seed, low, LAYER.exchange, high, day, nonce);

  const mine = accounts.channels(actor.person);
  // An off-map contact is reachable on whatever the resident has: they are a
  // real person with a phone, they are simply not in this population. Handing
  // them the resident's own channel set is the least wrong assumption and it
  // keeps abroad traffic on the messengers, which is where it actually is.
  const theirs = peer ? accounts.channels(peer.person) : mine;
  if (mine.length === 0 || theirs.length === 0) return;
  const pair = pairChannels(actor.person, other, mine, theirs, seed);

  const age = actor.age;
  const purpose = purposeFor(contact, age, rng);

  // Who opens it. The share is the pair's, and the draw is this exchange's.
  const share = initiatorShare(low, high, seed);
  const openerIsLow = rng.bool(share);
  const opener = openerIsLow === (actor.person === low) ? actor : peer;
  // An off-map contact can start a conversation, and often does — but this
  // engine has no day for them to start it from, so the resident's curve
  // stands in. It is the one place where an off-map party is modelled as a
  // reflection of the person they are talking to.
  const from = opener ?? actor;

  if (purpose === VOICE_PURPOSE) {
    const at = openingSecond(from, purpose, rng);
    if (at < 0) return;
    // Nobody rings the person sitting opposite them. See FACE_TO_FACE.
    if (facing(world, low, high, at) && !rng.bool(FACE_TO_FACE)) return;
    // The call is placed by whoever opened this exchange, which is not always
    // the resident whose contact list we are walking. Passing `actor` here
    // regardless — as this did — took the *timing* from the opener's day and
    // the *caller identity* from the other party, so every peer-initiated
    // call came out pointing the wrong way and timed against a day its
    // supposed caller was not living. It also let a sleeping person place a
    // call, which is how it was found.
    const callee = from === actor ? peer : actor;
    voiceExchange(world, out, from, callee, actor.person, other, contact, pair, at, rng);
    return;
  }

  const thread = dyadThread(world, out, actor.person, other, pair.dominant);
  if (thread === null) return;

  // Scale initiated text exchanges by the opener's age without touching the
  // voice path above. Each copy receives its own deterministic stream so it
  // has an independent opening time, media choice and reply tree.
  const copies = multipliedExchanges(textActivity(from.age), rng);
  for (let copy = 0; copy < copies; copy += 1) {
    const exchange = stream(seed, low, LAYER.exchange, high, day, nonce, copy + 1);
    const at = openingSecond(from, purpose, exchange);
    if (at < 0) continue;
    if (facing(world, low, high, at) && !exchange.bool(FACE_TO_FACE)) continue;
    branch(world, out, thread, [actor, peer], from, at, purpose, pair, exchange, 2);
  }
}

/**
 * The day-local conversation row for a pair, created on first use.
 *
 * `externalId` is derived from the pair and the channel, so it is the same
 * string on every date these two speak and a consumer can join across files
 * even though the index cannot.
 */
function dyadThread(world: ExchangeWorld, out: DayComms, a: number, b: number, channel: number): Conversation | null {
  const { accounts } = world;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const externalId = `d:${low}:${high}:${channel}`;
  // Indexed rather than scanned. A busy date creates a few hundred thousand
  // dyad threads and a pair that speaks twice looks its thread up again, so a
  // linear search here is the difference between a second and an hour.
  const existing = world.dyadIndex.get(externalId);
  if (existing !== undefined) return out.dyads[existing]!;

  const mine = accounts.on(a, channel);
  if (!mine) return null;
  // The far side may have no account row at all, which is what an off-map
  // contact is. The thread still exists and the participant list is short by
  // one, which is the honest record: we know one end of this conversation.
  const theirs = accounts.on(b, channel);

  const at = out.dyadParticipants.length;
  out.dyadParticipants.push(mine.index);
  if (theirs) out.dyadParticipants.push(theirs.index);

  const thread: Conversation = {
    index: accounts.conversations.length + out.dyads.length,
    channel,
    kind: CONVERSATION_KINDS.indexOf("dyad"),
    at,
    count: out.dyadParticipants.length - at,
    focus: NONE,
    externalId,
    title: null,
    created: 0,
  };
  world.dyadIndex.set(externalId, out.dyads.length);
  out.dyads.push(thread);
  return thread;
}

/**
 * The branching process, shared by dyads and groups.
 *
 * `members` is positional and may contain nulls — an off-map party, or a group
 * member whose day was not simulated in this run. A null cannot reply, which
 * is right: there is no day to read a reply latency out of, and inventing one
 * would be inventing the one number this whole layer exists to derive.
 */
function branch(
  world: ExchangeWorld,
  out: DayComms,
  thread: Conversation,
  members: readonly (Actor | null)[],
  opener: Actor,
  at: number,
  purpose: number,
  pair: PairChannels | null,
  rng: Rng,
  fanout: number,
  instructed?: { bytes?: number; replies?: boolean },
): void {
  const { accounts, seed, day } = world;
  const branching = BRANCHING[purpose]!;
  // Diffusion of responsibility, and it has to be strong enough to keep the
  // branching subcritical or the whole model runs away.
  //
  // The first version used 1/sqrt(N-1), which reads like damping and is not:
  // the expected number of replies to a message is the per-member probability
  // times the N-1 members who could send one, so that damping leaves an
  // expectation of `reply × sqrt(N-1)` — 3.9 children per message in a group
  // of thirty. Above one the process is supercritical and every group thread
  // in the city ran to the depth guard instead of terminating.
  //
  // So the damping is expressed as what it actually has to control: the total
  // expected replies to one message, which grows slowly with group size and
  // stays below one. A bigger group does produce more answers than a smaller
  // one, just nothing like proportionally — which is also what group chats
  // are like.
  const couldReply = Math.max(fanout - 1, 1);
  const spread = Math.min(GROUP_SPREAD_CAP, 0.55 + 0.22 * Math.log(fanout));
  const damp = fanout <= 2 ? 1 : spread / couldReply;

  interface Pending {
    from: Actor;
    message: Message;
    depth: number;
    /** Actual delivery second by recipient person for carrier messages. */
    deliveries: ReadonlyMap<number, number> | null;
  }
  const queue: Pending[] = [];

  let seq = world.seqOf.get(thread.index) ?? 0;
  const emit = (from: Actor, second: number, depth: number, replyTo: number): Pending | null => {
    const account = accounts.on(from.person, thread.channel);
    if (!account) return null;
    // The last gate on every path that sends: dead, or parted from the phone.
    if (unreachableAt(from, Math.floor(second / SECONDS_PER_MINUTE))) return null;
    const media = !(instructed && depth === 0) && rng.bool(MEDIA_SHARE[purpose]!);
    const kind = instructed && depth === 0 ? TEXT : media ? rng.weighted(MEDIA_KINDS, MEDIA_WEIGHTS) : TEXT;
    // A picture sent over the carrier is an MMS, not an SMS, whether the
    // thread is a pair's or a group's. `channelFor` does this conversion for
    // dyads; a group has no pair to ask, and without the same rule here a
    // group photo on an SMS thread was being treated as a text three million
    // characters long and segmented into twenty thousand carrier records.
    const channel = pair
      ? channelFor(pair, media, rng)
      : media && thread.channel === SMS ? MMS : thread.channel;
    const bytes = instructed?.bytes !== undefined && depth === 0 ? instructed.bytes : byteSize(kind, rng);
    const message: Message = {
      index: out.messages.length,
      conversation: thread.index,
      from: account.index,
      at: second,
      kind,
      channel,
      bytes,
      replyTo,
      seq: seq++,
      subscriber: account.subscriber,
    };
    world.seqOf.set(thread.index, seq);
    out.messages.push(message);
    const deliveries = isCarrier(channel)
      ? carrierRecords(world, out, message, channel, members, from, thread)
      : null;
    return { from, message, depth, deliveries };
  };

  const first = emit(opener, at, 0, NONE);
  if (!first) return;
  if (instructed?.replies === false) return;
  queue.push(first);

  let guard = 0;
  while (queue.length > 0 && guard++ < MAX_DEPTH) {
    const message = queue.shift()!;
    const probability = branching.reply * Math.pow(branching.decay, message.depth) * damp;
    if (probability <= 0) continue;

    for (const member of members) {
      if (!member || member === message.from) continue;
      if (!rng.bool(probability)) continue;
      const received = message.deliveries?.get(member.person) ?? message.message.at;
      // NONE means an on-net handset never became reachable during this date.
      // It cannot answer a message it has not received.
      if (received === NONE) continue;
      const glance = nextGlance(
        member.attention, received, seed, member.person, day,
        thread.index * 31 + message.message.seq,
      );
      if (glance < 0 || glance >= SECONDS) continue;
      if (unreachableAt(member, Math.floor(glance / SECONDS_PER_MINUTE))) continue;
      // The reply lands at a minute the two of them may by then be sitting at
      // the same table, which is a different question from where the message
      // was sent from and has to be asked here rather than at the opening.
      if (facing(world, member.person, message.from.person, glance) && !rng.bool(FACE_TO_FACE)) continue;
      const reply = emit(member, glance, message.depth + 1, message.message.seq);
      if (!reply) continue;
      queue.push(reply);
    }
    // Keep the queue in time order, so a reply cannot be processed before a
    // message that preceded it. Small queues, so a sort is cheaper than a heap.
    queue.sort((a, b) => a.message.at - b.message.at);
  }
}

function byteSize(kind: number, rng: Rng): number {
  const range = BYTES[MESSAGE_KINDS[kind]!]!;
  // Log-uniform: file sizes span orders of magnitude and a uniform draw would
  // put half of every photo library above two megabytes.
  return Math.round(Math.exp(rng.between(Math.log(range[0]), Math.log(range[1]))));
}

/**
 * The carrier's own rows for a message that went over SMS or MMS.
 *
 * One per recipient per segment, and the segment count comes from the byte
 * size because that is what a text's length is here. The cell is read from the
 * network layer's span table at the minute of submission — the one place in
 * this layer where a message legitimately knows where it was sent from.
 */
function carrierRecords(
  world: ExchangeWorld,
  out: DayComms,
  message: Message,
  channel: number,
  members: readonly (Actor | null)[],
  from: Actor,
  thread: Conversation,
): Map<number, number> {
  const { accounts, cellAt } = world;
  const deliveries = new Map<number, number>();
  const minute = Math.floor(message.at / SECONDS_PER_MINUTE);
  const cell = cellAt && message.subscriber >= 0 ? cellAt(message.subscriber, minute) : NONE;
  // Segmentation keys on the message *kind*, not on the byte count, and the
  // distinction is load-bearing. `bytes` means characters for a text and file
  // size for everything else, so dividing it by 153 unconditionally turns a
  // photo into twenty thousand segments. Only a text is ever split; an MMS is
  // one transaction whatever it weighs.
  const parts = channel === MMS || message.kind !== TEXT || message.bytes <= SMS_SINGLE
    ? 1
    : Math.ceil(message.bytes / SMS_SEGMENT);

  for (const member of members) {
    if (!member || member === from) continue;
    const account = accounts.on(member.person, channel === MMS ? SMS : channel);
    const to = account ? account.subscriber : NONE;
    // Read at delivery, not at submission: the recipient has had two seconds
    // to be somewhere else, and on an off-net number there is nothing to read.
    const earliest = message.at + 2;
    const receiving = cellAt && to >= 0 && cell !== NONE
      ? nextAttachedCell(cellAt, to, Math.floor(earliest / SECONDS_PER_MINUTE))
      : null;
    const toCell = receiving?.cell ?? NONE;
    // Off-net delivery is known from the inter-carrier receipt even though its
    // serving cell is not. On-net delivery waits for the first attached span.
    const delivered = !cellAt ? earliest
      : cell === NONE ? NONE
      : to < 0 ? earliest
        : receiving ? Math.max(earliest, receiving.minute * SECONDS_PER_MINUTE) : NONE;
    deliveries.set(member.person, delivered);
    for (let part = 0; part < parts; part += 1) {
      out.sms.push({
        message: message.index,
        from: message.subscriber,
        to,
        cell,
        toCell,
        part,
        parts,
        // Delivery is near-immediate when the recipient is attached and moves
        // to its first later attached minute when it is not. NONE means the
        // sender never submitted it or an on-net recipient remained offline.
        delivered,
      });
    }
  }
  // A dyad with one participant account is a thread with an off-map contact.
  // The resident's carrier still logs the outbound text, addressed off-net
  // (to = NONE), the way `callCarrierRecords` logs a call to one. Delivery is
  // the inter-carrier receipt, as for any off-net number. Every message in
  // such a thread is sent from the resident's account, so the far end is
  // always the recipient.
  if (thread.kind === DYAD && thread.count < 2) {
    const earliest = message.at + 2;
    const delivered = !cellAt ? earliest : cell === NONE ? NONE : earliest;
    for (let part = 0; part < parts; part += 1) {
      out.sms.push({ message: message.index, from: message.subscriber, to: NONE, cell, toCell: NONE, part, parts, delivered });
    }
  }
  return deliveries;
}

function nextAttachedCell(cellAt: CellAt, subscriber: number, fromMinute: number): {
  minute: number; cell: number;
} | null {
  for (let minute = Math.max(0, fromMinute); minute < MINUTES; minute += 1) {
    const cell = cellAt(subscriber, minute);
    if (cell !== NONE) return { minute, cell };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/** Seconds a call rings before the network gives up. */
const RING_OUT = 28;

/**
 * How likely the callee is to pick up.
 *
 * A call is not a message and the difference cuts both ways. It demands
 * attention now, so somebody who would not have looked at their phone still
 * hears it ring — which is the floor below. But it also has to be answered in
 * the thirty seconds it rings rather than whenever the recipient next glances,
 * so a great many calls to perfectly available people are simply missed.
 *
 * The first attempt at this multiplied the attention curve by a lift and
 * capped it, and produced a city where 97% of calls were answered. That is
 * wrong by a wide margin and wrong in the direction that matters most: the
 * unanswered call is the large share of real CDR volume and it is what a tool
 * reasoning about contact has to cope with. `BASE` is the ceiling a call to a
 * fully attentive person reaches, `FLOOR` is what a call to somebody asleep or
 * on a production line still gets, and `REFERENCE` is the attention level at
 * which the ceiling is met.
 */
const ANSWER_BASE = 0.68;
const ANSWER_FLOOR = 0.12;
const ANSWER_REFERENCE = 0.45;

/**
 * How an unanswered call ends up, given it was not picked up.
 *
 * Four ways, not one, and the split is worth having because the four mean
 * different things about the callee. A ring-out says they were not there; a
 * rejection says they were there and chose not to; a busy says they were on
 * another call, which is a fact about their own record elsewhere in this same
 * table; a failure says the handset was unreachable.
 *
 * `rejected` is conditioned on attention rather than drawn flat — you cannot
 * decline a call you never noticed — which is why it is applied separately
 * below rather than being a fixed share here.
 */
const VOICEMAIL = 0.22;
const BUSY = 0.06;
/** Reaches nobody at all: handset off, no coverage, number dead. */
const FAILED = 0.04;
/** Of the calls a *noticed* but unanswered call could have been, this share
 * were declined by hand rather than left to ring. */
const REJECTED = 0.35;

/** Share of unanswered calls returned within the hour. */
const CALLBACK = 0.38;

/** Median call length in seconds, by whether the parties are close. */
const DURATION_MEDIAN = 96;
const DURATION_SD = 1.15;

/**
 * One call and its possible return.
 *
 * `caller`/`callee` are the direction this particular attempt runs in, which
 * may be either way round; `left`/`right` are the pair the thread belongs to,
 * so the thread's identity is the same whichever of them dialled.
 */
function voiceExchange(
  world: ExchangeWorld,
  out: DayComms,
  caller: Actor,
  callee: Actor | null,
  left: number,
  right: number,
  contact: Contact,
  pair: PairChannels,
  at: number,
  rng: Rng,
  instructed?: { duration?: number; outcome?: number; replies?: boolean },
): void {
  const { accounts, seed, day, cellAt } = world;
  const thread = dyadThread(world, out, left, right, pair.voice);
  if (thread === null) return;
  const from = accounts.on(caller.person, pair.voice);
  if (!from) return;

  const call = attempt(world, out, thread, from.index, from.subscriber, caller, callee, contact, at, rng, NONE, instructed);

  // A missed call is returned, and the return is a second record pointing at
  // the first. This is where a large share of real call volume comes from and
  // it is the pattern that makes an unanswered-call model worth having.
  if (instructed?.replies !== false && call !== null && call.outcome !== outcomeOf("answered") && callee
      && !unreachableAt(callee, Math.floor(call.at / SECONDS_PER_MINUTE))
      && rng.bool(CALLBACK)) {
    const back = accounts.on(callee.person, pair.voice);
    if (back) {
      // `wakingOnly`: a callback is a call being *placed*, so it has to come
      // from a minute the caller was actually awake in.
      const glance = nextGlance(
        callee.attention, call.at + call.ring, seed, callee.person, day, call.index, true,
      );
      if (glance >= 0 && glance < SECONDS) {
        attempt(world, out, thread, back.index, back.subscriber, callee, caller, contact, glance, rng, call.index);
      }
    }
  }
  void cellAt;
}

function attempt(
  world: ExchangeWorld,
  out: DayComms,
  thread: Conversation,
  from: number,
  subscriber: number,
  caller: Actor,
  callee: Actor | null,
  contact: Contact,
  at: number,
  rng: Rng,
  callback: number,
  instructed?: { duration?: number; outcome?: number },
): Call | null {
  const { cellAt } = world;
  const minute = Math.floor(at / SECONDS_PER_MINUTE);
  if (minute >= MINUTES) return null;
  // The last gate on every path that dials: a caller who is dead or parted
  // from the phone places nothing, whoever's timing chose the minute.
  if (unreachableAt(caller, minute)) return null;

  // An off-map callee answers at a flat rate: there is no day to read. Stated
  // rather than hidden, because it is the one place a party's availability is
  // asserted instead of derived.
  const attentive = callee
    ? (callee.attention.known ? callee.attention.minute[minute]! / 255 : 0)
    : 0.42;
  const reach = Math.min(1, attentive / ANSWER_REFERENCE);
  // Nobody is there to pick up. Not a low probability — none — and it wins
  // over an instruction to the contrary, because a scenario that has killed
  // somebody and then asks for an answered call has contradicted itself.
  const unreachable = unreachableAt(callee, minute);
  const sampledAnswer = !unreachable && rng.bool(ANSWER_BASE * (ANSWER_FLOOR + (1 - ANSWER_FLOOR) * reach));
  const answered = unreachable ? false
    : instructed?.outcome !== undefined ? instructed.outcome === outcomeOf("answered") : sampledAnswer;

  const duration = answered
    ? instructed?.duration ?? Math.max(5, Math.round(Math.exp(rng.gauss(Math.log(DURATION_MEDIAN * (0.6 + contact.affinity * 1.6)), DURATION_SD))))
    : 0;

  let outcome = outcomeOf("answered");
  if (unreachable) {
    // The handset is on and registered, so the network completes the call
    // and lets it ring to the timer; a voicemail greeting is the only other
    // thing that can happen. No busy, no rejection, no failure.
    outcome = rng.bool(VOICEMAIL) ? outcomeOf("voicemail") : outcomeOf("no-answer");
  } else if (!answered) {
    if (rng.bool(FAILED)) outcome = outcomeOf("failed");
    else if (rng.bool(BUSY)) outcome = outcomeOf("busy");
    // Declining is only possible for somebody who noticed. `reach` is exactly
    // that — how close to fully attentive the callee was — so a rejection is
    // drawn against it rather than flat, and a sleeping callee never rejects.
    else if (rng.bool(REJECTED * reach)) outcome = outcomeOf("rejected");
    else if (rng.bool(VOICEMAIL)) outcome = outcomeOf("voicemail");
    else outcome = outcomeOf("no-answer");
  }
  if (instructed?.outcome !== undefined && !unreachable) outcome = instructed.outcome;

  // How long it rang before resolving, which differs by how it resolved: a
  // rejection or a busy signal cuts it short, a failure never rings at all,
  // and a ring-out runs to the network's own timer.
  const ring = answered
    ? Math.round(rng.between(2, 14))
    : outcome === outcomeOf("failed") ? 1
      : outcome === outcomeOf("rejected") || outcome === outcomeOf("busy")
        ? Math.round(rng.between(2, 9))
        : RING_OUT;

  const call: Call = {
    index: out.calls.length,
    conversation: thread.index,
    from,
    at,
    outcome,
    ring,
    duration,
    subscriber,
    callback,
  };
  if (instructed?.outcome !== undefined) call.instructed = true;
  out.calls.push(call);

  callCarrierRecords(world, out, thread, call, callee?.person ?? null);
  return call;
}

function callCarrierRecords(
  world: ExchangeWorld, out: DayComms, thread: Conversation, call: Call, callee: number | null,
): void {
  const { cellAt } = world;
  const { subscriber, at, ring, duration } = call;
  const minute = Math.floor(at / SECONDS_PER_MINUTE);
  if (thread.channel === VOICE && cellAt && subscriber >= 0) {
    const handoverAt = out.handovers.length;
    const trail = callCells(cellAt, subscriber, at, ring + duration);
    out.handovers.push(...trail.handovers);
    const to = callee !== null ? calleeSubscriber(world, callee, thread.channel) : NONE;
    // The callee's own cells over the same window. A terminating record is a
    // separate row at a real operator; here both ends hang off the one CDR,
    // and without these the callee's location is simply absent.
    const answering = to >= 0 ? callCells(cellAt, to, at, ring + duration) : null;
    out.cdr.push({
      call: call.index,
      from: subscriber,
      to,
      originCell: trail.originCell,
      endCell: trail.endCell,
      toOriginCell: answering ? answering.originCell : NONE,
      toEndCell: answering ? answering.endCell : NONE,
      handoverAt,
      handoverCount: (out.handovers.length - handoverAt) / 2,
    });
  }

}

/** The shared carrier projection for new calls and replayed existing calls. */
export function callCells(cellAt: CellAt, subscriber: number, at: number, seconds: number): {
  originCell: number; endCell: number; handovers: number[];
} {
  const minute = Math.floor(at / SECONDS_PER_MINUTE);
  const endMinute = Math.min(MINUTES - 1, Math.floor((at + seconds) / SECONDS_PER_MINUTE));
  const originCell = cellAt(subscriber, minute);
  let endCell = originCell;
  const handovers: number[] = [];
  for (let m = minute + 1; m <= endMinute; m++) {
    const cell = cellAt(subscriber, m);
    // A detached handset has dropped the call; a later attach is a new
    // registration, not a handover of this call.
    if (cell === NONE) break;
    if (cell !== endCell) { handovers.push(m * SECONDS_PER_MINUTE, cell); endCell = cell; }
  }
  return { originCell, endCell, handovers };
}

function calleeSubscriber(world: ExchangeWorld, person: number, channel: number): number {
  const account = world.accounts.on(person, channel);
  return account ? account.subscriber : NONE;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Base chance a group thread carries anything on a given day, before size.
 *
 * Most group chats are quiet most days and then busy for an afternoon. The
 * per-day rate is deliberately low and the branching does the rest: one
 * message into a household thread of five reliably produces three or four.
 */
const GROUP_DAILY = 0.13;

/** How much a bigger group talks. Sublinear: a thread of forty is not eight
 * times as busy as one of five, it is about twice. */
const GROUP_SIZE_EXPONENT = 0.45;

function groupExchanges(world: ExchangeWorld, out: DayComms): void {
  const { accounts, actors, seed, day } = world;

  for (const thread of accounts.conversations) {
    const members = accounts.members(thread);
    const rate = GROUP_DAILY * Math.pow(members.length, GROUP_SIZE_EXPONENT);
    const rng = stream(seed, thread.index, LAYER.exchange, day);
    if (!rng.bool(Math.min(rate, 0.9))) continue;

    const present: (Actor | null)[] = [];
    for (const account of members) {
      const person = accounts.all[account]!.person;
      const actor = actors.get(person);
      present.push(actor && actor.attention.known ? actor : null);
    }
    const live = present.filter((actor): actor is Actor => actor !== null);
    if (live.length < 2) continue;

    // More active age bands open proportionally more group conversations too.
    const opener = rng.weighted(live, live.map((actor) => textActivity(actor.age)));
    const broadcast = thread.kind === CONVERSATION_KINDS.indexOf("broadcast");
    const purpose = broadcast ? BROADCAST_PURPOSE : rng.bool(0.55) ? LOGISTICAL : CONVERSATIONAL;
    const copies = multipliedExchanges(textActivity(opener.age), rng);
    for (let copy = 0; copy < copies; copy += 1) {
      const exchange = stream(seed, thread.index, LAYER.exchange, day, copy + 1);
      const at = openingSecond(opener, purpose, exchange);
      if (at < 0) continue;
      branch(world, out, thread, present, opener, at, purpose, null, exchange, members.length);
    }
  }
}

// ---------------------------------------------------------------------------
// Gatherings
// ---------------------------------------------------------------------------

/**
 * What survives of a message to somebody you are sitting opposite.
 *
 * Not zero, because "I'm parking, order me a coffee" is real and because a
 * hard zero would let a consumer detect co-presence by looking for an exact
 * absence — which is a stronger signal than the true one and a false one.
 * Small enough that the pattern in the data is the right way round: the people
 * at the table stop texting *each other* and go on texting everybody else.
 *
 * It is applied per pair and per minute rather than through the attention
 * curve, and it has to be. Attention is a property of one person — how much
 * they are looking at their phone — and lowering it far enough to produce this
 * would make somebody at dinner unreachable to their sister as well, which is
 * false. The curve already carries the general suppression at MEET; this
 * carries the part of it that is about who the message is *to*.
 */
const FACE_TO_FACE = 0.06;

/** Chance a gathering produces logistics in the hour before it starts. */
const RUN_UP = 0.55;

/** How far ahead of the hour that traffic falls, in minutes. */
const RUN_UP_MINUTES = 45;

/**
 * Chance a gathering produces traffic after it ends.
 *
 * Lower than the run-up, because the run-up is functional — people have to
 * agree where and when — and this is not. What it produces is the photographs,
 * the thanks, and the "home safe", all of which are real and none of which is
 * obligatory.
 */
const AFTERGLOW = 0.35;

/** How long after the end that traffic falls, in minutes. */
const AFTER_FROM = 12;
const AFTER_TO = 95;

/**
 * Chance somebody rings a party who never arrived.
 *
 * High, because this is what people do, and because it is the most useful
 * record the failure produces: a call placed at ten past the hour to somebody
 * whose day shows them somewhere else entirely. The planner rejects a
 * gathering it cannot route a person to, so the party a meeting claims and the
 * party that held it differ — and this layer is the only one that can see
 * both. See `comms/gatherings.ts`.
 */
const CHASE = 0.8;

/** How many days ahead an arrangement is visible in the traffic. */
const ARRANGE_AHEAD = 3;

/**
 * Chance the arrangement for a gathering this many days out is made today.
 *
 * Indexed by days ahead, so index 0 is unused. It falls away with distance
 * because most arrangements are made close to the event; three days is where
 * it stops being worth carrying rather than where people stop planning.
 *
 * These do not have to sum to anything. A gathering can be arranged on more
 * than one day — that is what "are we still on?" is — and can also be arranged
 * on none, which is the one made in person the week before.
 */
const ARRANGE_WHEN = [0, 0.5, 0.28, 0.14];

/**
 * How much likelier a group chat becomes with each guest past the first.
 *
 * Two people have no group chat by definition: the thread between them *is*
 * the dyad. Past that it is a real fork with a real consequence for the
 * record. A group thread names every guest before anybody arrives; a star of
 * separate messages from the convener names none of them, and each guest
 * learns who else is coming only when they get there. Both happen, and which
 * one it is should be recoverable rather than assumed — so it is drawn, and
 * the odds move sharply with the size of the party, because nobody sends four
 * separate texts when they could send one.
 */
const GROUP_CHAT_STEP = 0.45;
const GROUP_CHAT_CAP = 0.92;

function groupChatChance(party: number): number {
  if (party < 3) return 0;
  return Math.min(GROUP_CHAT_CAP, 1 - Math.pow(1 - GROUP_CHAT_STEP, party - 2));
}

/** Are these two at the same gathering at the minute this second falls in? */
function facing(world: ExchangeWorld, a: number, b: number, second: number): boolean {
  return world.gatherings.together(a, b, Math.floor(second / SECONDS_PER_MINUTE));
}

/** A minute of the day as a second, with the second inside it drawn. */
function atMinute(minute: number, rng: Rng): number {
  if (minute < 0 || minute >= MINUTES) return -1;
  return Math.round(minute) * SECONDS_PER_MINUTE + Math.floor(rng.next() * SECONDS_PER_MINUTE);
}

/**
 * One thread an occasion's traffic can run down, with everything `branch`
 * needs to write into it.
 *
 * A gathering produces one of these when it has a group chat or only two
 * people, and one per guest when the convener messages everybody separately.
 */
interface Occasion {
  conversation: Conversation;
  members: (Actor | null)[];
  /** The pair's channel preferences, where there is a pair to ask. */
  pair: PairChannels | null;
}

/**
 * Where an occasion's traffic goes: one group thread, one dyad, or a star of
 * dyads out of the convener.
 */
function occasionThreads(
  world: ExchangeWorld,
  out: DayComms,
  id: string,
  hub: Actor,
  present: readonly Actor[],
  rng: Rng,
): Occasion[] {
  const { accounts, seed } = world;
  const dyad = (a: Actor, b: Actor): Occasion | null => {
    const mine = accounts.channels(a.person);
    const theirs = accounts.channels(b.person);
    if (mine.length === 0 || theirs.length === 0) return null;
    const pair = pairChannels(a.person, b.person, mine, theirs, seed);
    const conversation = dyadThread(world, out, a.person, b.person, pair.dominant);
    if (conversation === null) return null;
    return { conversation, members: [a, b], pair };
  };

  if (present.length === 2) {
    const one = dyad(present[0]!, present[1]!);
    return one ? [one] : [];
  }
  if (rng.bool(groupChatChance(present.length))) {
    const conversation = occasionGroup(world, out, id, present);
    if (conversation) return [{ conversation, members: [...present], pair: null }];
    // No channel every guest holds. Falling through to the star rather than
    // dropping the traffic: the arrangement still happened, it just happened
    // one message at a time, which is exactly what people do when the group
    // is split across two apps.
  }
  const star: Occasion[] = [];
  for (const guest of present) {
    if (guest.person === hub.person) continue;
    const one = dyad(hub, guest);
    if (one) star.push(one);
  }
  return star;
}

/**
 * A group thread that exists for one occasion and is not a standing group.
 *
 * Written into the day-local conversation table beside the dyads rather than
 * into the static one, because it is not a fact about the city — nobody is
 * still in it next week. `externalId` names the gathering, so the same
 * occasion's arrangement and its afterglow join up even though the index does
 * not survive the file.
 */
function occasionGroup(
  world: ExchangeWorld,
  out: DayComms,
  id: string,
  members: readonly Actor[],
): Conversation | null {
  const { accounts } = world;
  // A group thread needs one app everybody actually has. Where the party is
  // split across two messengers there is no such thread and the caller falls
  // back to separate messages, which is what happens in life.
  let channel = -1;
  for (const candidate of accounts.channels(members[0]!.person)) {
    if (members.every((member) => accounts.on(member.person, candidate))) {
      channel = candidate;
      break;
    }
  }
  if (channel < 0) return null;

  const at = out.dyadParticipants.length;
  for (const member of members) out.dyadParticipants.push(accounts.on(member.person, channel)!.index);
  const thread: Conversation = {
    index: accounts.conversations.length + out.dyads.length,
    channel,
    kind: CONVERSATION_KINDS.indexOf("group"),
    at,
    count: out.dyadParticipants.length - at,
    focus: NONE,
    externalId: `o:${id}`,
    title: null,
    created: 0,
  };
  out.dyads.push(thread);
  return thread;
}

/** The tie between two people, from one side, or null if they have none. */
function contactBetween(graph: Graph, from: number, to: number): Contact | null {
  const [start, end] = graph.range(from);
  for (let i = start; i < end; i += 1) {
    const contact = graph.contacts[i]!;
    if (contact.other === to) return contact;
  }
  return null;
}

/**
 * The traffic a gathering that actually happened generates on the day.
 *
 * Keyed on the gathering rather than on any pair in it, so the same occasion
 * produces the same run-up and the same photographs however many of its party
 * are asked about it.
 */
function gatheringExchanges(world: ExchangeWorld, out: DayComms): void {
  const { actors, seed, day } = world;

  for (const held of world.gatherings.all()) {
    const meeting = held.meeting;
    const present = held.attendees
      .map((id) => actors.get(id))
      .filter((actor): actor is Actor => !!actor && actor.attention.known);
    if (present.length < 2) continue;

    // Keyed on the convener where there is one and on the lowest resident of
    // the address where there is not — the same discriminator `meetings.ts`
    // uses to tell a hosted gathering from a household outing.
    const hosted = meeting.host !== null;
    const rng = stream(seed, hosted ? meeting.host! : held.attendees[0]!, LAYER.gathering, day, hosted ? 0 : 1);

    // Both minutes are drawn before any thread is created, because a thread is
    // only allowed to exist if something is going to be said in it — see
    // `DayComms.dyads`, which promises exactly the threads that carried
    // traffic. Drawing them afterwards left an empty conversation on every
    // gathering that happened to produce neither.
    //
    // "On my way" is logistical by construction rather than by a draw: nobody
    // has a long conversation about a table they are about to sit down at.
    // What goes out afterwards is broadcast, because it is mostly a photograph
    // and photographs do not start conversations — MEDIA_SHARE is 0.62 on that
    // purpose against 0.04 on logistical, which is the whole reason for it.
    const runUpAt = rng.bool(RUN_UP) ? atMinute(meeting.start - rng.int(4, RUN_UP_MINUTES), rng) : -1;
    const afterAt = rng.bool(AFTERGLOW) ? atMinute(meeting.end + rng.int(AFTER_FROM, AFTER_TO), rng) : -1;
    if (runUpAt < 0 && afterAt < 0) {
      chase(world, out, held, present, rng);
      continue;
    }

    const hub = present.find((actor) => actor.person === meeting.host) ?? present[0]!;
    for (const occasion of occasionThreads(world, out, meeting.id, hub, present, rng)) {
      const live = occasion.members.filter((member): member is Actor => member !== null);
      if (live.length < 2) continue;
      // A star sends the same round of texts to each guest, a few minutes
      // apart rather than in the same second.
      const jitter = rng.int(0, 180);
      // The sender is drawn from whoever is awake at that second. The run-up
      // and the afterglow are clock offsets from the meeting, not samples of
      // anybody's attention, so an afterglow an hour after a late dinner
      // could otherwise open a thread from inside the sender's first sleep
      // bout. `prune` drops a thread nobody was awake to write in.
      const awake = (second: number) => live.filter((member) =>
        member.attention.minute[Math.floor(second / SECONDS_PER_MINUTE)]! > 0);
      if (runUpAt >= 0 && runUpAt + jitter < SECONDS) {
        const senders = awake(runUpAt + jitter);
        if (senders.length > 0) {
          branch(world, out, occasion.conversation, occasion.members, rng.pick(senders), runUpAt + jitter,
            LOGISTICAL, occasion.pair, rng, occasion.members.length);
        }
      }
      if (afterAt >= 0 && afterAt + jitter < SECONDS) {
        const senders = awake(afterAt + jitter);
        if (senders.length > 0) {
          branch(world, out, occasion.conversation, occasion.members, rng.pick(senders), afterAt + jitter,
            BROADCAST_PURPOSE, occasion.pair, rng, occasion.members.length);
        }
      }
    }

    chase(world, out, held, present, rng);
  }
}

/**
 * Somebody who was drawn into this and never arrived, being rung.
 *
 * The one thing in this layer that only exists because the planner failed at
 * something, and it is worth having for exactly that reason: it is a call
 * placed from a restaurant to a person whose own day puts them somewhere else,
 * which is a correlation between three tables that nothing else in the file
 * produces.
 */
function chase(
  world: ExchangeWorld,
  out: DayComms,
  held: Held,
  present: readonly Actor[],
  rng: Rng,
): void {
  const { accounts, actors, graph, seed } = world;
  for (const missing of held.absent) {
    if (!rng.bool(CHASE)) continue;
    const caller = rng.pick(present as Actor[]);
    const contact = contactBetween(graph, caller.person, missing);
    if (!contact) continue;
    const callee = actors.get(missing) ?? null;
    const mine = accounts.channels(caller.person);
    const theirs = callee ? accounts.channels(callee.person) : mine;
    if (mine.length === 0 || theirs.length === 0) continue;
    const pair = pairChannels(caller.person, missing, mine, theirs, seed);
    // A few minutes after the hour, which is when somebody stops waiting.
    const at = atMinute(held.meeting.start + rng.int(3, 25), rng);
    if (at < 0) continue;
    voiceExchange(
      world, out, caller, callee,
      Math.min(caller.person, missing), Math.max(caller.person, missing),
      contact, pair, at, rng,
    );
  }
}

/**
 * Arranging something that has not happened yet.
 *
 * The one part of this file that cannot read a timeline, because the day it is
 * about has not been planned. So the guest list comes from `invitationFor` —
 * the cheap half of the convener's draw, which needs only the tie graph and
 * the date — and the gathering it describes may never take place. That is not
 * a leak to be plugged: an invitation with nothing after it is a plan that
 * fell through, and those are as real as the ones that did not.
 *
 * Only the convener's side is derived. Everything the guests say back is the
 * ordinary branching process reading their own days, which is why this costs
 * one walk of a contact list per person per day ahead rather than anything
 * quadratic.
 */
function arrangementExchanges(world: ExchangeWorld, out: DayComms): void {
  const { actors, seed, day, date } = world;

  for (const [person, actor] of actors) {
    if (!actor.attention.known) continue;
    const who = world.world.persons.get(person);
    if (!who) continue;

    for (let ahead = 1; ahead <= ARRANGE_AHEAD; ahead += 1) {
      const rng = stream(seed, person, LAYER.gathering, day, 8 + ahead);
      if (!rng.bool(ARRANGE_WHEN[ahead] ?? 0)) continue;

      const future = new Date(date.getFullYear(), date.getMonth(), date.getDate() + ahead);
      const invitation = invitationFor(world.world, world.graph, who, future, day + ahead);
      if (!invitation) continue;

      const guests = invitation.guests
        .map((guest) => actors.get(guest))
        .filter((guest): guest is Actor => !!guest && guest.attention.known);
      if (guests.length === 0) continue;

      // Drawn before the threads, for the same reason as above: a thread that
      // carries nothing must not be written down.
      const at = openingSecond(actor, LOGISTICAL, rng);
      if (at < 0) continue;

      // Arranging Thursday with somebody you are sitting opposite tonight is a
      // conversation, not a text. Asked of the whole guest list at once and
      // before any thread exists, so the answer cannot leave one empty.
      const opposite = guests.some((guest) => facing(world, actor.person, guest.person, at));
      if (opposite && !rng.bool(FACE_TO_FACE)) continue;

      const party = [actor, ...guests];
      const id = `arrange/${person}/${day + ahead}`;
      for (const occasion of occasionThreads(world, out, id, actor, party, rng)) {
        branch(world, out, occasion.conversation, occasion.members, actor, at,
          LOGISTICAL, occasion.pair, rng, occasion.members.length);
      }
    }
  }
}

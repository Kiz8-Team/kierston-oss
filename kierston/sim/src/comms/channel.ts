/**
 * Which app a pair actually use.
 *
 * The intersection of what two people have is the constraint; it is not the
 * answer. Two people who both have SMS, iMessage, Messenger and WhatsApp do
 * not spread their traffic evenly over four channels — they have one, and it
 * is very sticky. Modelling the choice per message instead of per pair
 * produces a dataset where every relationship looks identical at the channel
 * level and where no correspondent can be tracked by moving to a new app,
 * which is one of the more useful things this data can show.
 *
 * The preference order is not a popularity ranking
 * ------------------------------------------------
 * It is a ranking of what a pair *reaches for* when both ends have it, which
 * is a different thing. iMessage tops it not because it is the most adopted —
 * it is not adopted at all, it is inherited — but because two iPhones fall
 * onto it without either party choosing anything. WhatsApp beats Messenger
 * between people who both have it because a WhatsApp user tends to be a
 * WhatsApp user rather than a person with an account. SMS is last and is the
 * floor, which is where a pair with nothing else in common ends up.
 *
 * The spill share is why it is not simply the top of the list
 * -----------------------------------------------------------
 * A pair's second channel is real and small. It carries the message sent when
 * the first app was not to hand, the photo that would not send, the text
 * after a phone was replaced. Without it every pair is a clean single-channel
 * relationship and the join across channels — the thing a tool would actually
 * have to do — never has to be made.
 */

import { LAYER, stream } from "../shared/index.ts";
import { CHANNELS, MMS, SMS, VOICE, channelOf, type Channel } from "./types.ts";

/**
 * What a pair reaches for, best first. Channels absent from this list are
 * never a pair's dominant channel: MMS is what SMS becomes when a picture is
 * attached, and voice is a modality rather than a channel choice.
 */
const PREFERENCE: readonly Channel[] = [
  "imessage", "whatsapp", "signal", "telegram", "snapchat", "messenger", "sms",
];

const ORDER: readonly number[] = PREFERENCE.map((name) => channelOf(name));

/**
 * How much stickier each step up the preference order is.
 *
 * A geometric weighting rather than a strict order, so a pair who both have
 * WhatsApp and iMessage are usually on iMessage and sometimes not. Strict
 * precedence would make the channel a deterministic function of the pair's
 * app sets, and two people's app sets are not a relationship.
 */
const STEP = 2.1;

/** Share of a pair's messages that go over their second channel. */
const SPILL = 0.09;

export interface PairChannels {
  /** The channel this pair use for almost everything. */
  dominant: number;
  /** Where the rest goes, or the dominant again when they share only one. */
  spill: number;
  /** Whether voice between these two runs over the carrier or over an app. */
  voice: number;
}

/**
 * Channels that carry a voice call, best first.
 *
 * Carrier voice is last on purpose and it is the only place in this file where
 * that ordering is not about preference. An app call leaves no CDR, so a pair
 * who both have WhatsApp and ring each other over it are invisible to the
 * operator — which is exactly the gap a benchmark should contain, and would
 * not if every call fell back to the number.
 */
const VOICE_PREFERENCE: readonly Channel[] = ["whatsapp", "signal", "imessage", "telegram", "messenger"];
const VOICE_ORDER: readonly number[] = VOICE_PREFERENCE.map((name) => channelOf(name));

/**
 * How often a pair who *could* call over an app do so rather than dialling.
 *
 * Well under half, because in this country the number still wins for most
 * people most of the time — an app call is what you make to somebody abroad,
 * or when you were already in the thread. That second case is why this is not
 * lower: the call that follows a conversation happens where the conversation
 * was.
 */
const APP_VOICE = 0.34;

/** Drawn once per pair and never redrawn: this is a relationship, not a mood. */
export function pairChannels(a: number, b: number, mine: readonly number[], theirs: readonly number[], seed: number): PairChannels {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const rng = stream(seed, low, LAYER.channel, high);

  const shared = new Set<number>();
  const other = new Set(theirs);
  for (const channel of mine) if (other.has(channel)) shared.add(channel);

  const options: number[] = [];
  const weights: number[] = [];
  for (let rank = 0; rank < ORDER.length; rank += 1) {
    const channel = ORDER[rank]!;
    if (!shared.has(channel)) continue;
    options.push(channel);
    weights.push(Math.pow(STEP, ORDER.length - rank));
  }

  // Everybody has a number, so this should never be empty. It can be for a
  // person with no line at all, who has no accounts and therefore nothing to
  // share — such a pair produces no traffic and is filtered before this runs.
  if (options.length === 0) return { dominant: SMS, spill: SMS, voice: VOICE };

  const dominant = rng.weighted(options, weights);
  const rest = options.filter((channel) => channel !== dominant);
  const spill = rest.length ? rng.weighted(rest, rest.map((_, i) => 1 / (i + 1))) : dominant;

  let voice = VOICE;
  const overApp = VOICE_ORDER.find((channel) => shared.has(channel));
  if (overApp !== undefined && rng.bool(APP_VOICE)) voice = overApp;

  return { dominant, spill, voice };
}

/**
 * Which channel one particular message goes over.
 *
 * Media is the second thing this decides. A picture over SMS is not an SMS —
 * it is an MMS, a different record with a different size and a different
 * price, and collapsing the two would lose the only place in the carrier data
 * where message content type is visible at all.
 */
export function channelFor(pair: PairChannels, media: boolean, rng: { next(): number }): number {
  const channel = rng.next() < SPILL ? pair.spill : pair.dominant;
  return media && channel === SMS ? MMS : channel;
}

export const CHANNEL_NAMES = CHANNELS;

/**
 * The vocabulary the communications layer is written in.
 *
 * Three shapes carry the design, and the reason for each is the same: it names
 * a thing a real record names, at the resolution a real record has it.
 *
 *   Conversation  the container, dyads included. A one-to-one exchange is not
 *                 a special case with no thread — it is a thread with two
 *                 participants, and making them one shape is what lets a group
 *                 message be one send and N receives without a second path.
 *   Message       one send. Recipients are the conversation's participants.
 *   Call          one *attempt*. Unanswered attempts are the large share and
 *                 leaving them out is what makes a synthetic CDR set obvious.
 *
 * Two rules run through all of it.
 *
 * **Accounts, never persons.** Every participant, sender and caller here is an
 * account index. Resolving an account to a human being is the work this data
 * exists to test, and a conversation that stored person ids would have done
 * that work for the consumer and thrown away the only difficulty Telegram and
 * Snapchat actually present.
 *
 * **Carrier detail lives in side tables.** `SmsRecord` and `CallRecord` hang
 * off a message or a call rather than appearing as nullable columns on it. So
 * a WhatsApp message is structurally incapable of carrying a serving cell,
 * which is correct — it travels over whatever IP path the handset has, usually
 * a home or workplace access point, and where it does go over cellular it is a
 * few hundred bytes inside a session that was already open. There is no
 * per-message cell to record and inventing one would hand every consumer a
 * location fix that no operator holds.
 */

/**
 * The channels a message can travel over.
 *
 * Appended to, never reordered: the packed day file stores these indices and
 * an old file's `4` has to keep meaning what it meant when it was written.
 *
 * The first three are carried by the operator and are the only ones with a
 * side table. SMS and MMS ride the signalling channel to the carrier's own
 * SMSC, so the network sees each one individually and stamps it; a voice call
 * is a bearer the network sets up, follows and tears down. Everything after
 * them is somebody else's server.
 */
export const CHANNELS = [
  "sms",
  "mms",
  "voice",
  /**
   * Not a platform anybody adopts — an artefact of both ends being Apple.
   *
   * At 53% iOS this city's handsets pair iPhone-to-iPhone about 28% of the
   * time, and every one of those exchanges silently leaves the carrier's SMS
   * records for a data session. A model with the six named messengers and no
   * iMessage produces roughly twice the SMS traffic a real operator here would
   * log, and leaves the platform split with no fingerprint at all.
   */
  "imessage",
  "whatsapp",
  "telegram",
  "signal",
  "messenger",
  "snapchat",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels below this index are the operator's own and carry carrier detail. */
export const CARRIER_CHANNELS = 3;
export const isCarrier = (channel: number): boolean => channel < CARRIER_CHANNELS;

export const channelOf = (channel: Channel): number => CHANNELS.indexOf(channel);
export const SMS = channelOf("sms");
export const MMS = channelOf("mms");
export const VOICE = channelOf("voice");
export const IMESSAGE = channelOf("imessage");

/**
 * Whether the platform's identifier is a telephone number.
 *
 * The split that decides how hard a handle is to resolve, and therefore most
 * of what makes one of these logs interesting. WhatsApp and Signal are the
 * phone number, so a subscriber lookup finishes the job. Telegram is a numeric
 * user id with an optional @username and the number hidden by default;
 * Snapchat is a handle with no number behind it at all; Messenger is a numeric
 * id beside a profile name that is usually, but not reliably, the real one.
 */
export const PHONE_ANCHORED: ReadonlySet<number> = new Set(
  ["sms", "mms", "voice", "imessage", "whatsapp", "signal"].map((name) => channelOf(name as Channel)),
);

/** What a conversation is. Appended to, never reordered. */
export const CONVERSATION_KINDS = [
  /** Two participants. Most conversations, and most SMS. */
  "dyad",
  /** Three or more, with a stable membership and usually a name. */
  "group",
  /**
   * One sender the others do not answer: a school's alert list, a shift
   * roster, a landlord's notice. Structurally a group whose reply rate is
   * near zero, kept separate because a tool that treats it as a group infers
   * a social circle out of a mailing list.
   */
  "broadcast",
] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * Why the exchange happened, which sets its whole shape before a single
 * message exists.
 *
 * This is the field that stops every conversation in the city looking alike.
 * A logistical exchange is three messages in four minutes anchored on somebody
 * leaving somewhere; a conversational one is thirty over an hour and a half
 * between two people who like each other. Drawing the purpose first and the
 * messages second is what makes both come out, and it is recorded because a
 * consumer can measure against it.
 */
export const PURPOSES = [
  /** "on my way", "can you get milk". Short, fast, hung on a leg boundary. */
  "logistical",
  /** Back and forth with gaps. Only between high-affinity pairs. */
  "conversational",
  /** One message, a reply optional. A photo into the family group. */
  "broadcast",
  /** The purpose picked voice. A call is not a separate system from a text. */
  "voice",
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** What was sent. Appended to, never reordered. */
export const MESSAGE_KINDS = [
  "text", "image", "video", "voice-note", "file", "sticker", "location", "reaction",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** How a call attempt ended. Appended to, never reordered. */
export const CALL_OUTCOMES = [
  "answered",
  /** Rang out. The largest non-answered share and the one most often omitted. */
  "no-answer",
  "busy",
  /** Declined by hand, which is a different fact about the callee than absence. */
  "rejected",
  /** Rang out and the caller left something, which is a second record. */
  "voicemail",
  /** Never reached the callee: no coverage, handset off, number dead. */
  "failed",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const outcomeOf = (outcome: CallOutcome): number => CALL_OUTCOMES.indexOf(outcome);

/** No such thing, in an index column. */
export const NONE = -1;

/**
 * Person ids from here up name a *service*, not a person.
 *
 * Above every stub `ties.py` writes (external, abroad and former colleagues
 * all sit below four million) so nothing in the population or the tie graph
 * can collide with one. A service is an account with no day behind it: it
 * answers on its own terms, it never rings anybody back, and it is never
 * drawn as somebody's contact. The one that exists is the emergency line.
 */
export const SERVICE_BASE = 9_000_000;
/** The public-safety answering point. `handle` is the number people dial. */
export const EMERGENCY_PERSON = SERVICE_BASE + 911;
export const EMERGENCY_HANDLE = "911";
export const isService = (person: number): boolean => person >= SERVICE_BASE;

/**
 * One identity on one platform.
 *
 * `person` is NONE for a counterparty outside the population. That is not an
 * edge case to tidy away later: `ties.py` writes EXTERNAL_BASE, ABROAD_BASE
 * and FORMER_BASE stubs for the absent parent, the family left behind and the
 * colleague from a job since ended, and those are real people this city calls.
 * Without accounts for them a large share of outbound traffic has no
 * destination to point at, and the city looks like a closed system.
 */
export interface Account {
  index: number;
  person: number;
  channel: number;
  /** MSISDN, @username, numeric id or handle — shaped by the channel. */
  handle: string;
  displayName: string;
  /** The subscription this rides on, or NONE for an app with no number. */
  subscriber: number;
  /** yyyymmdd, matching the records layer's date convention. */
  created: number;
}

/**
 * A thread, and the participant set that gives it meaning.
 *
 * Long-lived: a family group outlives any day it was busy on, so these are
 * built once beside the accounts and only the day's *traffic* is packed per
 * date. `at`/`count` index a shared participant array in the CSR form
 * `export/day.ts` already uses for legs and schedules — variable-length
 * membership is not worth a nested array when every consumer wants columns.
 */
export interface Conversation {
  index: number;
  channel: number;
  kind: number;
  /** Offset into the shared participant array of account indices. */
  at: number;
  count: number;
  /**
   * The focus from `ties.bin` that produced it — a household, a work unit, a
   * congregation — or NONE for an ad-hoc dyad. Kept because it is the honest
   * answer to why these particular people are in a thread together, and
   * because it is exactly what a consumer is trying to infer.
   */
  focus: number;
  /** The provider's own thread identifier, shaped per channel. */
  externalId: string;
  /** Groups mostly have one; dyads never do. */
  title: string | null;
  /** yyyymmdd the thread was created. */
  created: number;
}

/**
 * One message.
 *
 * At second resolution, and that is not a detail. A desk worker answers in
 * forty seconds; the whole reply-latency model is the difference between two
 * people's days, and minute resolution would collapse every burst in the city
 * onto a single tick and destroy the one signal these records carry that
 * location data does not. The network layer runs at minutes because a serving
 * cell does not change faster than that. The two resolutions are different on
 * purpose.
 */
export interface Message {
  index: number;
  conversation: number;
  /** The sending account. Recipients are the conversation's participants. */
  from: number;
  /** Seconds from local midnight. May exceed 86400 for a day that runs over. */
  at: number;
  kind: number;
  /**
   * The channel this one send went over, which is not always the thread's:
   * a pair spills to their secondary at `SPILL`, so a Messenger thread does
   * carry the occasional SMS. Recording it is what lets a consumer tell a
   * carrier message from an app one; `conversation.channel` cannot.
   */
  channel: number;
  /**
   * Bytes on the wire, which is the only size a thin record is entitled to
   * have. It is also the only thing that separates a sticker from a video
   * once the content is gone, and it is what a carrier data volume would show.
   */
  bytes: number;
  /** Conversation-local `seq` of the message this answers, or NONE. */
  replyTo: number;
  /** Position within the thread, which is what `replyTo` indexes. */
  seq: number;
  /** The handset it was sent from — the device reference every record needs. */
  subscriber: number;
}

/**
 * One call attempt, on any channel that carries voice.
 *
 * `ring` exists even when nobody answered, and `duration` is zero unless they
 * did. Keeping the two apart is what lets a consumer tell a forty-second
 * conversation from a forty-second ring-out, which are the same length and
 * mean opposite things.
 */
export interface Call {
  index: number;
  conversation: number;
  from: number;
  /** Seconds from local midnight, at setup. */
  at: number;
  outcome: number;
  /** Seconds of ringing before it resolved. */
  ring: number;
  /** Seconds of conversation. Zero unless answered. */
  duration: number;
  subscriber: number;
  /** The attempt this one returns, or NONE. */
  callback: number;
  /**
   * Set when a scenario request dictated the outcome. Reconcile keeps an
   * instructed `busy` rather than treating it as a sampled one. In memory
   * only; not a packed column.
   */
  instructed?: boolean;
}

/**
 * The carrier's own record of one SMS or MMS, one row per recipient segment.
 *
 * `part`/`parts` is worth carrying rather than collapsing. A text longer than
 * 160 characters is split into 153-character segments and each is a separate
 * transaction on the network, so the message count and the record count
 * genuinely differ — and a tool that assumes they are the same gets caught by
 * exactly the kind of long message people actually send.
 */
export interface SmsRecord {
  message: number;
  /** Sending subscriber index. */
  from: number;
  /** Receiving subscriber, or NONE where the recipient is off-net. */
  to: number;
  /** Originator's serving cell at submission, from the network span table. */
  cell: number;
  /** Recipient's serving cell at delivery, or NONE when off-net. */
  toCell: number;
  part: number;
  parts: number;
  /** Second the delivery report came back, or NONE. */
  delivered: number;
}

/**
 * The carrier's own record of one voice call.
 *
 * A VoIP call — WhatsApp, Signal, FaceTime — has a `Call` and no `CallRecord`
 * whatsoever, which is the whole point of the split.
 *
 * Two cells rather than one because they differ whenever the caller was
 * moving, and a handover list because a call taken in a car crosses several.
 * That trail is the single richest location artefact in this entire layer and
 * it exists only for the channel that earns it.
 */
export interface CallRecord {
  call: number;
  from: number;
  to: number;
  originCell: number;
  endCell: number;
  /** Callee's serving cells over the same window, or NONE when off-net. */
  toOriginCell: number;
  toEndCell: number;
  /** Offset into the shared handover array, as (second, cell) pairs. */
  handoverAt: number;
  handoverCount: number;
}

/** A live communication whose resource occupancy survives midnight. */
export interface ActiveCallBoundary {
  kind: "active-call";
  /** People whose handsets remain occupied by the call. */
  participants: number[];
  /** Seconds after the next midnight at which the call releases them. */
  remainingSeconds: number;
}

export type PendingCommunication = ActiveCallBoundary;

export interface CommunicationsBoundaryState {
  pending: PendingCommunication[];
  /** Reserved for a future renewal/contact-recency model. */
  contactRecency: unknown[];
}

export function emptyCommunicationsBoundary(): CommunicationsBoundaryState {
  return { pending: [], contactRecency: [] };
}

/**
 * Everything one simulated date produced.
 *
 * Conversations and accounts are not here: they are static tables that live
 * beside the identity records, and a day only ever refers to them. What a date
 * owns is the traffic.
 */
export interface DayComms {
  messages: Message[];
  calls: Call[];
  sms: SmsRecord[];
  cdr: CallRecord[];
  /** (second, cell) pairs, indexed by `CallRecord.handoverAt`. */
  handovers: number[];
  /**
   * Two-party threads that carried traffic today, and only those.
   *
   * Groups are static and live beside the accounts; dyads are not written down
   * at all, because there are several million live pairs in this city and
   * materialising a two-row conversation for every one of them would be
   * storing the tie graph a second time to say nothing new.
   *
   * So a dyad thread is created on the day it speaks, and its `index`
   * continues the static table's numbering *within this date only*. The field
   * that joins across dates is `externalId`, which is derived from the pair
   * and the channel and is therefore stable. A consumer that keys on the
   * index across two files will silently mismatch, which is why the index is
   * day-local by construction rather than by accident.
   */
  dyads: Conversation[];
  /** Participant account indices for `dyads`, in the same CSR form. */
  dyadParticipants: number[];
}

export function emptyDayComms(): DayComms {
  return { messages: [], calls: [], sms: [], cdr: [], handovers: [], dyads: [], dyadParticipants: [] };
}

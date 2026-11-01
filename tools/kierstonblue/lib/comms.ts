/**
 * One resident's conversations, arranged the way they are read rather than the
 * way they are stored.
 *
 * The file hands over flat tables of accounts and seconds. What a reader wants
 * is a thread with a name on it, a message with a direction, and the pair of
 * facts that only exist when two rows are put beside each other: how long
 * somebody took to answer, and whether the operator saw any of it.
 *
 * Three distinctions are load-bearing here and none of them is cosmetic.
 *
 * **Sent against received.** A message row names one sending account and no
 * recipients, because the recipients are the thread's other members. Direction
 * is therefore something this file computes, by asking whether the sender is one
 * of the accounts belonging to the person being read.
 *
 * **A record against evidence.** Every message is in `messages`; only the ones
 * that went over SMS, MMS or the carrier's voice bearer have a row in `sms` or
 * `cdr`. A WhatsApp message is real and leaves the operator nothing, and this
 * module never fills that gap in — `carrierOf` returns nothing and the page says
 * so.
 *
 * **A glance against a curve.** The curve is a probability per minute. A glance
 * is a moment the records actually place a phone in somebody's hand: every
 * message they sent, and every call they placed. The two are drawn together
 * because the second is a sample of the first, and they are labelled apart
 * because one is a model and the other is an observation.
 */

import type {
  AttentionRun, CommsAccount, CommsCall, CommsCdr, CommsMessage, CommsSms,
  CommsThread, PersonComms,
} from "@/lib/server/comms";
import type { DayCell, DaySubscriber } from "@/lib/server/kday";

export const SECONDS_PER_DAY = 86_400;

/**
 * Channel colours: the operator's own three in one family, everybody else's in
 * their own.
 *
 * The split a reader is making all day on this page is whether a row is
 * something a carrier holds, so the three channels that leave carrier records
 * are the warm ones and the six that do not are cool. Within each family the
 * hues are the platforms' own where they have one, because a reader who knows
 * WhatsApp is green should not have to consult a key.
 */
export const CHANNEL_COLOR: Record<string, string> = {
  sms: "#eda100", mms: "#eb6834", voice: "#c2417a",
  imessage: "#1baf7a", whatsapp: "#25a366", telegram: "#2a9ede",
  signal: "#3a76f0", messenger: "#7a5bd0", snapchat: "#c9b400",
};

export const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS", mms: "MMS", voice: "Carrier call", imessage: "iMessage",
  whatsapp: "WhatsApp", telegram: "Telegram", signal: "Signal",
  messenger: "Messenger", snapchat: "Snapchat",
};

/** The channels the operator carries itself, and therefore keeps records of. */
export const CARRIER_CHANNELS = new Set(["sms", "mms", "voice"]);

export const channelColor = (channel: string): string =>
  CHANNEL_COLOR[channel] ?? "#8a97a3";

export const channelLabel = (channel: string): string =>
  CHANNEL_LABEL[channel] ?? channel;

/**
 * Call outcomes, and the fact that only one of them is a conversation.
 *
 * Answered is the green one and everything else is a shade of not: a ring-out
 * says the callee was away from the phone, a rejection says they were with it
 * and chose not to, and a failure says the network never reached them at all.
 * Those are three different facts about a person and the colours keep them apart.
 */
export const OUTCOME_COLOR: Record<string, string> = {
  answered: "#1baf7a", "no-answer": "#eda100", busy: "#eb6834",
  rejected: "#d0021b", voicemail: "#7a5bd0", failed: "#8b9298",
};

export const OUTCOME_LABEL: Record<string, string> = {
  answered: "answered", "no-answer": "no answer", busy: "busy",
  rejected: "declined", voicemail: "voicemail", failed: "failed",
};

/** What the person was doing, in the words the curve's own states are named in. */
export const ATTENTION_BANDS: readonly (readonly [floor: number, label: string])[] = [
  [0.75, "very high"],
  [0.5, "high"],
  [0.25, "moderate"],
  [0.1, "low"],
  [0.03, "very low"],
  [0, "unreachable"],
];

export function attentionBand(level: number, asleep: boolean): string {
  if (asleep) return "asleep";
  for (const [floor, label] of ATTENTION_BANDS) if (level >= floor) return label;
  return "unreachable";
}

/** A second of the day as a clock time. Seconds shown: the latencies need them. */
export function stamp(second: number): string {
  const wrapped = ((second % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hours = Math.floor(wrapped / 3600);
  const minutes = Math.floor((wrapped % 3600) / 60);
  const seconds = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    + `:${String(seconds).padStart(2, "0")}`;
}

/** A span of seconds as a reader says it out loud. */
export function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Bytes as the wire saw them, which for a text is characters. */
export function wire(kind: string, bytes: number): string {
  if (kind === "text") return `${bytes} char${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} kB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * A message with everything a row needs, resolved once.
 *
 * `mine` is the direction; `latency` exists only where this message answers
 * another one in the same thread and is the gap between the two, which is the
 * reply-latency model's whole output. `carrier` is the operator's rows for it,
 * empty for the six platforms whose traffic never touches the network.
 */
export interface MessageRow {
  message: CommsMessage;
  thread: CommsThread;
  /** Sent by the person being read, rather than received by them. */
  mine: boolean;
  from: CommsAccount | undefined;
  /** Seconds between the message it answers and this one, or null. */
  latency: number | null;
  answers: CommsMessage | null;
  carrier: CommsSms[];
}

export interface CallRow {
  call: CommsCall;
  thread: CommsThread;
  /** Placed by the person being read, rather than received. */
  mine: boolean;
  from: CommsAccount | undefined;
  record: CommsCdr | null;
  /** The attempt this one returns, where it is one. */
  answers: CommsCall | null;
}

/**
 * A moment the records place the handset in this person's hand.
 *
 * Not every glance — most looks at a phone produce nothing and are never
 * sampled, which is why the curve is drawn behind these rather than replaced by
 * them. What is here is the subset that left a trace: a message sent, or a call
 * dialled. A reply carries the gap it closed, because that gap is the whole
 * reason the curve exists.
 */
export interface Glance {
  at: number;
  kind: "message" | "call";
  channel: string;
  /** The seconds this glance kept somebody waiting, where it answers something. */
  latency: number | null;
  label: string;
}

export interface CommsView {
  threads: CommsThread[];
  messages: MessageRow[];
  calls: CallRow[];
  glances: Glance[];
  accounts: Map<number, CommsAccount>;
  subscribers: Map<number, DaySubscriber>;
  cells: Map<number, DayCell>;
  /** Their own accounts, so a row can be told from a counterparty's. */
  mine: Set<number>;
  sent: number;
  received: number;
  placed: number;
  answered: number;
  /** Messages of theirs the operator holds a row for, and those it does not. */
  onCarrier: number;
  offCarrier: number;
}

export function buildComms(comms: PersonComms): CommsView {
  const accounts = new Map<number, CommsAccount>();
  for (const account of [...comms.accounts, ...comms.counterparts]) {
    accounts.set(account.index, account);
  }
  const mine = new Set(comms.accounts.map((account) => account.index));
  const threads = new Map(comms.threads.map((thread) => [thread.index, thread]));

  // A reply names the `seq` of what it answers, not a row, because `seq` is the
  // only identifier that is stable inside a thread across a whole day's file.
  const bySeq = new Map<string, CommsMessage>();
  for (const message of comms.messages) {
    bySeq.set(`${message.conversation}:${message.seq}`, message);
  }
  const carrierOf = new Map<number, CommsSms[]>();
  for (const row of comms.sms) {
    const rows = carrierOf.get(row.message);
    if (rows) rows.push(row);
    else carrierOf.set(row.message, [row]);
  }
  const recordOf = new Map<number, CommsCdr>();
  for (const row of comms.cdr) recordOf.set(row.call, row);
  const callByIndex = new Map(comms.calls.map((call) => [call.index, call]));

  const messages: MessageRow[] = [];
  for (const message of comms.messages) {
    const thread = threads.get(message.conversation);
    if (!thread) continue;
    const answers = message.replyTo >= 0
      ? (bySeq.get(`${message.conversation}:${message.replyTo}`) ?? null)
      : null;
    messages.push({
      message,
      thread,
      mine: mine.has(message.from),
      from: accounts.get(message.from),
      answers,
      latency: answers ? message.at - answers.at : null,
      carrier: carrierOf.get(message.index) ?? [],
    });
  }

  const calls: CallRow[] = [];
  for (const call of comms.calls) {
    const thread = threads.get(call.conversation);
    if (!thread) continue;
    calls.push({
      call,
      thread,
      mine: mine.has(call.from),
      from: accounts.get(call.from),
      record: recordOf.get(call.index) ?? null,
      answers: call.callback >= 0 ? (callByIndex.get(call.callback) ?? null) : null,
    });
  }

  const glances: Glance[] = [
    ...messages.filter((row) => row.mine).map((row) => ({
      at: row.message.at,
      kind: "message" as const,
      channel: row.thread.channel,
      latency: row.latency,
      label: row.latency === null
        ? `${row.message.kind} · ${channelLabel(row.thread.channel)}`
        : `reply +${elapsed(row.latency)} · ${channelLabel(row.thread.channel)}`,
    })),
    ...calls.filter((row) => row.mine).map((row) => ({
      at: row.call.at,
      kind: "call" as const,
      channel: row.thread.channel,
      latency: null,
      label: `call · ${OUTCOME_LABEL[row.call.outcome] ?? row.call.outcome}`,
    })),
  ].sort((a, b) => a.at - b.at);

  const ownMessages = messages.filter((row) => row.mine);
  return {
    threads: comms.threads,
    messages,
    calls,
    glances,
    accounts,
    subscribers: new Map(comms.subscribers.map((row) => [row.index, row])),
    cells: new Map(comms.cells.map((cell) => [cell.index, cell])),
    mine,
    sent: ownMessages.length,
    received: messages.length - ownMessages.length,
    placed: calls.filter((row) => row.mine).length,
    answered: calls.filter((row) => row.call.outcome === "answered").length,
    onCarrier: ownMessages.filter((row) => row.carrier.length > 0).length,
    offCarrier: ownMessages.filter((row) => row.carrier.length === 0).length,
  };
}

/**
 * How a thread is named when it is a row in a list.
 *
 * A group has a title and a dyad never does, so a two-party thread is named by
 * the person on the other end — which is the only thing anybody would call it.
 * The names come from identity.bin through the caller, because an account's
 * display name is what the *platform* shows and is not always the real one,
 * which is a distinction worth keeping on a page about resolving handles.
 */
export function threadName(
  thread: CommsThread,
  view: CommsView,
  nameOf: (person: number) => string,
): string {
  if (thread.title) return thread.title;
  const others = thread.participants.filter((account) => !view.mine.has(account));
  if (others.length === 0) return "Note to self";
  if (others.length === 1) {
    const account = view.accounts.get(others[0]!);
    if (!account) return "Unknown handle";
    return account.person >= 0 ? nameOf(account.person) : (account.displayName ?? account.handle ?? "Off-map contact");
  }
  return `${others.length + 1} people`;
}

/** Traffic per hour of the day, sent and received kept apart. */
export function byHour(view: CommsView): { hour: number; sent: number; received: number }[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0 }));
  for (const row of view.messages) {
    const hour = Math.floor(((row.message.at % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY / 3600);
    if (row.mine) hours[hour]!.sent += 1;
    else hours[hour]!.received += 1;
  }
  return hours;
}

/** Messages per channel, so a page can show where somebody actually talks. */
export function byChannel(view: CommsView): { channel: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const row of view.messages) {
    counts.set(row.thread.channel, (counts.get(row.thread.channel) ?? 0) + 1);
  }
  for (const row of view.calls) {
    counts.set(row.thread.channel, (counts.get(row.thread.channel) ?? 0) + 1);
  }
  return [...counts].map(([channel, value]) => ({ channel, value }))
    .sort((a, b) => b.value - a.value);
}

export function byOutcome(view: CommsView): { outcome: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const row of view.calls) {
    counts.set(row.call.outcome, (counts.get(row.call.outcome) ?? 0) + 1);
  }
  return [...counts].map(([outcome, value]) => ({ outcome, value }))
    .sort((a, b) => b.value - a.value);
}

/** The run covering a minute, for the readout beside the curve. */
export function runAt(runs: AttentionRun[], minute: number): AttentionRun | null {
  for (const run of runs) if (minute >= run.start && minute < run.end) return run;
  return null;
}

/**
 * What the curve says about the day as a whole.
 *
 * The mean is over waking minutes only. Averaged across the whole day it is
 * mostly a statement about how long somebody slept, which is a fact the sleep
 * figure already carries and not one about how reachable they are.
 */
export interface AttentionSummary {
  waking: number;
  meanWaking: number;
  asleep: number;
  /** The longest unbroken stretch awake and effectively unreachable. */
  unreachable: { start: number; end: number } | null;
  /** The hour with the highest mean level, which is when to expect traffic. */
  peakHour: number | null;
}

/** Below this the curve is a person who will not see anything for a while. */
const UNREACHABLE = 0.1;

export function summariseAttention(runs: AttentionRun[]): AttentionSummary {
  let waking = 0;
  let asleep = 0;
  let sum = 0;
  const hours = Array.from({ length: 24 }, () => ({ minutes: 0, sum: 0 }));
  let unreachable: { start: number; end: number } | null = null;
  let open: number | null = null;

  for (const run of runs) {
    const minutes = run.end - run.start;
    if (run.asleep) asleep += minutes;
    else {
      waking += minutes;
      sum += run.level * minutes;
    }
    for (let minute = run.start; minute < run.end; minute += 1) {
      const hour = Math.min(23, Math.floor(minute / 60));
      hours[hour]!.minutes += 1;
      hours[hour]!.sum += run.level;
    }
    // A stretch of being out of reach is only interesting while awake: eight
    // hours asleep is not a fact about somebody's phone habits.
    if (!run.asleep && run.level < UNREACHABLE) {
      if (open === null) open = run.start;
    } else if (open !== null) {
      if (!unreachable || run.start - open > unreachable.end - unreachable.start) {
        unreachable = { start: open, end: run.start };
      }
      open = null;
    }
  }
  if (open !== null) {
    const end = runs[runs.length - 1]?.end ?? open;
    if (!unreachable || end - open > unreachable.end - unreachable.start) {
      unreachable = { start: open, end };
    }
  }

  let peakHour: number | null = null;
  let best = -1;
  for (const [hour, row] of hours.entries()) {
    if (row.minutes === 0) continue;
    const mean = row.sum / row.minutes;
    if (mean > best) { best = mean; peakHour = hour; }
  }

  return {
    waking,
    meanWaking: waking > 0 ? sum / waking : 0,
    asleep,
    unreachable: unreachable && unreachable.end - unreachable.start >= 30 ? unreachable : null,
    peakHour,
  };
}

/**
 * How a subscriber is named in a carrier record, which is by its number.
 *
 * An operator's own row does not carry a person: it carries an MSISDN, and the
 * work of turning that into somebody is the work this data exists to test. So
 * the number leads, and the name follows only where the caller chooses to add it.
 */
export function lineOf(subscribers: Map<number, DaySubscriber>, index: number): string {
  if (index < 0) return "off-net";
  const subscriber = subscribers.get(index);
  if (!subscriber) return `subscriber ${index}`;
  return subscriber.msisdn ?? `subscriber ${index}`;
}

/** A cell in a carrier record, named the way a record names it. */
export function cellOf(cells: Map<number, DayCell>, index: number | null): string {
  if (index === null) return "no cell";
  const cell = cells.get(index);
  if (!cell) return `cell ${index}`;
  return `${cell.cgi ?? `cell ${index}`} · ${cell.band ?? cell.layer}`;
}

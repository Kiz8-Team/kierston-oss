/**
 * One resident's conversations and one resident's attention, out of a packed day.
 *
 * The day file holds the city's traffic in seven flat tables keyed on accounts,
 * not people, and that is the point rather than an inconvenience: resolving a
 * Telegram id or a Snapchat handle to a human being is the work this data exists
 * to test, and a table keyed on person ids would have done that work for the
 * consumer and thrown away the only difficulty those platforms present. So this
 * module does the join a reader of the file would have to do — person to
 * accounts, accounts to threads, threads to messages — and it does it the same
 * way, out of the same columns, with nothing added.
 *
 * What is *not* joined away
 * -------------------------
 * The carrier tables stay separate. `messages` and `calls` are what happened;
 * `sms` and `cdr` are the subset an operator would hold, and a WhatsApp message
 * appears in the first pair and not the second because nothing on the network
 * ever saw it. Folding a serving cell onto every message would hand the page a
 * location fix for traffic no operator can place, so the split survives all the
 * way to the screen.
 *
 * Why an index
 * ------------
 * There are no per-person offsets into the message table, and there could not
 * usefully be: a message has one sender and every other participant received
 * it, so a sender-ordered table would answer half the question. What the file
 * does guarantee is that one conversation's messages are contiguous, so the
 * join is a scan of the key column once per file — a fifth of a second for five
 * million rows — cached against the file's own modification time. Re-exporting
 * a day invalidates it without anything having to say so.
 */

import {
  NONE_CELL, dayMtime, dayPath, openDay, personRow, readCells, readSubscribers,
  typed, value, type DayCell, type DaySubscriber, type Reader,
} from "./kday";

/** Minutes in the day the curve covers, which is the curve's whole domain. */
const MINUTES = 1440;

/** One identity on one platform. `person` is -1 for a counterparty off the map. */
export interface CommsAccount {
  index: number;
  person: number;
  /** sms, imessage, whatsapp, telegram, signal, messenger, snapchat. */
  channel: string;
  /** MSISDN, @username, numeric id or handle — shaped by the channel. */
  handle: string | null;
  displayName: string | null;
  /** The subscription this rides on, or -1 for an app with no number. */
  subscriber: number;
  created: number;
}

/**
 * A thread and its membership.
 *
 * `channel` is the thread's, and it is not always the channel of the accounts
 * in it: a voice conversation's participants are the phone-number accounts,
 * because a call has no platform identity of its own.
 *
 * A dyad's index is day-local by construction — the file appends today's
 * two-party threads after the city's standing groups — so `externalId` is the
 * field that joins one across two dates.
 */
export interface CommsThread {
  index: number;
  channel: string;
  kind: string;
  /** The tie that put these people in a thread, or null for an ad-hoc dyad. */
  focus: string | null;
  externalId: string | null;
  title: string | null;
  created: number;
  /** Account indices, in the order the file holds them. */
  participants: number[];
  /** Traffic on this thread today, which for a standing group is often none. */
  messages: number;
  calls: number;
}

export interface CommsMessage {
  index: number;
  conversation: number;
  /** The sending account. Recipients are the thread's other participants. */
  from: number;
  /** Seconds from local midnight. May exceed 86,400 on a day that runs over. */
  at: number;
  kind: string;
  /** Bytes on the wire, the only size a thin record is entitled to have. */
  bytes: number;
  /** Thread-local `seq` of the message this answers, or -1. */
  replyTo: number;
  seq: number;
  subscriber: number;
}

/**
 * One call *attempt*, answered or not.
 *
 * `ring` exists even when nobody picked up and `duration` is zero unless they
 * did, which is what separates a forty-second conversation from a forty-second
 * ring-out.
 */
export interface CommsCall {
  index: number;
  conversation: number;
  from: number;
  at: number;
  outcome: string;
  ring: number;
  duration: number;
  subscriber: number;
  /** The attempt this one returns, or -1. */
  callback: number;
}

/** The carrier's row for one SMS or MMS segment, one per recipient. */
export interface CommsSms {
  message: number;
  from: number;
  /** Receiving subscriber, or -1 where the recipient is off-net. */
  to: number;
  /** Serving cell at submission, or null where the run had no radio. */
  cell: number | null;
  part: number;
  parts: number;
  /** Second the delivery report came back, or null. */
  delivered: number | null;
}

/** The carrier's row for one dialled call, with the trail it left. */
export interface CommsCdr {
  call: number;
  from: number;
  to: number;
  originCell: number | null;
  endCell: number | null;
  /** Every cell the bearer was moved to while the call was up. */
  handovers: { second: number; cell: number | null }[];
}

/**
 * A stretch of the day over which the attention curve holds one value.
 *
 * `level` is the probability of glancing at the handset in any one minute of
 * the run — not of replying, which is the conversation layer's decision and
 * multiplies this. `asleep` is carried separately because sleep is the one
 * state whose curve value is exactly zero: nothing is ever initiated during it,
 * while the chance of surfacing to read something that has arrived is a float
 * far below anything a byte can hold.
 */
export interface AttentionRun {
  start: number;
  /** Exclusive, so `end - start` is the minutes the level held. */
  end: number;
  level: number;
  asleep: boolean;
}

export interface PersonComms {
  date: string;
  person: number;
  initDigest: string | null;
  /**
   * False for a day file exported without the comms layer, which is not the
   * same fact as a person who said nothing. Nothing was ever written.
   */
  messaged: boolean;
  /**
   * The curve, or `known: false` where the file predates it or the person's day
   * gave nothing to derive one from — an off-map worker's day is surveyed
   * rather than planned, and somebody with no handset has no curve.
   */
  attention: { known: boolean; runs: AttentionRun[] };
  /** This person's own accounts. */
  accounts: CommsAccount[];
  /** Every other account in their threads, so a row can be named. */
  counterparts: CommsAccount[];
  threads: CommsThread[];
  messages: CommsMessage[];
  calls: CommsCall[];
  sms: CommsSms[];
  cdr: CommsCdr[];
  /** The handsets the records name, theirs and their correspondents'. */
  subscribers: DaySubscriber[];
  /** The cells the carrier records name. Empty for a run with no radio. */
  cells: DayCell[];
}

const ACCOUNT_COLUMNS = [
  "account.person", "account.channel", "account.handle", "account.displayName",
  "account.subscriber", "account.created",
] as const;

const MESSAGE_COLUMNS = [
  "message.conversation", "message.from", "message.at", "message.kind",
  "message.bytes", "message.replyTo", "message.seq", "message.subscriber",
] as const;

const CALL_COLUMNS = [
  "call.conversation", "call.from", "call.at", "call.outcome", "call.ring",
  "call.duration", "call.subscriber", "call.callback",
] as const;

const SMS_COLUMNS = [
  "sms.message", "sms.from", "sms.to", "sms.cell", "sms.part", "sms.parts",
  "sms.delivered",
] as const;

const CDR_COLUMNS = [
  "cdr.call", "cdr.from", "cdr.to", "cdr.originCell", "cdr.endCell",
  "cdr.handoverAt", "cdr.handoverCount",
] as const;

/** Where one key's rows sit in a table grouped by that key. */
interface Range { start: number; count: number }

/**
 * The joins a per-person read needs, built once per file.
 *
 * Around eighty megabytes for a full-city day, which is why only one is kept:
 * a reader looks at one date at a time, and holding every date open would be
 * holding several copies of the same city.
 */
interface CommsIndex {
  path: string;
  mtimeMs: number;
  /** Account rows for a person id. */
  accountsByPerson: Map<number, number[]>;
  /** Thread indices for an account, as CSR over the participant table. */
  threadOffsets: Uint32Array;
  threadsOfAccount: Uint32Array;
  messagesOf: Map<number, Range[]>;
  callsOf: Map<number, Range[]>;
  /** Sorted, so a message's carrier rows are found by binary search. */
  smsMessage: Uint32Array;
  cdrCall: Uint32Array;
}

let index: CommsIndex | null = null;

async function commsIndex(reader: Reader, path: string, mtimeMs: number): Promise<CommsIndex> {
  if (index && index.path === path && index.mtimeMs === mtimeMs) return index;

  const [accountPerson, messageConversation, callConversation, conversationAt,
    conversationCount, participantAccount, smsMessage, cdrCall] = await Promise.all([
    typed(reader, "account.person"),
    typed(reader, "message.conversation"),
    typed(reader, "call.conversation"),
    typed(reader, "conversation.at"),
    typed(reader, "conversation.count"),
    typed(reader, "participant.account"),
    typed(reader, "sms.message"),
    typed(reader, "cdr.call"),
  ]);

  const accountsByPerson = new Map<number, number[]>();
  for (let row = 0; row < accountPerson.length; row += 1) {
    const person = accountPerson[row]!;
    const mine = accountsByPerson.get(person);
    if (mine) mine.push(row);
    else accountsByPerson.set(person, [row]);
  }

  // The participant table is CSR over conversations; what a person's page needs
  // is the transpose. Counting sort rather than a map of arrays: one entry per
  // membership, and there are a million of them.
  const accounts = accountPerson.length;
  const threadOffsets = new Uint32Array(accounts + 1);
  for (let i = 0; i < participantAccount.length; i += 1) {
    threadOffsets[participantAccount[i]! + 1] += 1;
  }
  for (let i = 0; i < accounts; i += 1) threadOffsets[i + 1]! += threadOffsets[i]!;
  const cursor = threadOffsets.slice(0, accounts);
  const threadsOfAccount = new Uint32Array(participantAccount.length);
  for (let thread = 0; thread < conversationAt.length; thread += 1) {
    const at = conversationAt[thread]!;
    const end = at + conversationCount[thread]!;
    for (let i = at; i < end; i += 1) {
      threadsOfAccount[cursor[participantAccount[i]!]++] = thread;
    }
  }

  index = {
    path,
    mtimeMs,
    accountsByPerson,
    threadOffsets,
    threadsOfAccount,
    messagesOf: ranges(messageConversation),
    callsOf: ranges(callConversation),
    smsMessage: smsMessage as Uint32Array,
    cdrCall: cdrCall as Uint32Array,
  };
  return index;
}

/**
 * Where each key's rows are, for a table whose rows are grouped by that key.
 *
 * The file guarantees the grouping and not the ordering: today's dyad threads
 * are numbered after the city's standing groups but their traffic is written
 * where the exchange produced it, so the key column steps backwards once. A run
 * scan holds regardless; a binary search would not, which is why this is a scan.
 *
 * A list of runs per key rather than one, even though every table in the file
 * currently gives each key exactly one. Keeping the last run seen would drop a
 * thread's earlier messages with nothing anywhere to say a row had gone missing,
 * and silently losing traffic is the one failure a page like this must not have.
 */
function ranges(keys: ArrayLike<number>): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  const add = (key: number, range: Range) => {
    const runs = out.get(key);
    if (runs) runs.push(range);
    else out.set(key, [range]);
  };
  if (keys.length === 0) return out;
  let key = keys[0]!;
  let start = 0;
  for (let row = 1; row < keys.length; row += 1) {
    if (keys[row] === key) continue;
    add(key, { start, count: row - start });
    key = keys[row]!;
    start = row;
  }
  add(key, { start, count: keys.length - start });
  return out;
}

/** The rows of a sorted key column that carry one key, as a range. */
function search(keys: Uint32Array, key: number): Range {
  let low = 0;
  let high = keys.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const at = keys[middle]!;
    if (at === key) { found = middle; high = middle - 1; }
    else if (at < key) low = middle + 1;
    else high = middle - 1;
  }
  if (found < 0) return { start: 0, count: 0 };
  let end = found;
  while (end + 1 < keys.length && keys[end + 1] === key) end += 1;
  return { start: found, count: end - found + 1 };
}

/** A range of one column as a value reader, for the per-row materialisation. */
async function block(reader: Reader, names: readonly string[], range: Range) {
  const buffers = await Promise.all(names.map((name) => reader.slice(name, range.start, range.count)));
  const types = names.map((name) => reader.spec(name).type);
  return (name: string, row: number): number => {
    const at = names.indexOf(name);
    return value(buffers[at]!, types[at]!, row);
  };
}

const cellRef = (id: number): number | null => (id === NONE_CELL ? null : id);

export async function readPersonComms(date: string, person: number): Promise<PersonComms | null> {
  const path = await dayPath(date);
  if (!path || !Number.isSafeInteger(person) || person < 0) return null;
  const mtimeMs = await dayMtime(path);
  const reader = await openDay(path);

  try {
    const row = await personRow(reader, person);
    if (row < 0) return null;

    const meta = reader.meta;
    const enums = meta.enums;
    const channelOf = (code: number) => enums.channel?.[code] ?? "unknown";
    const empty: PersonComms = {
      date: meta.date,
      person,
      initDigest: meta.initDigest,
      messaged: meta.counts.messaged === 1,
      attention: await readAttention(reader, row),
      accounts: [], counterparts: [], threads: [], messages: [], calls: [],
      sms: [], cdr: [], subscribers: [], cells: [],
    };
    // A file from before version 4, or one exported without the comms layer:
    // the tables are either absent or present and empty, and `messaged` is what
    // tells a reader which of those they are looking at.
    if (!reader.has("message.conversation") || meta.counts.messaged !== 1) return empty;

    const joins = await commsIndex(reader, path, mtimeMs);
    const mine = joins.accountsByPerson.get(person) ?? [];
    if (!mine.length) return empty;

    // Every thread any of their accounts belongs to: the city's standing groups,
    // which outlive any day, and the dyads that carried traffic today.
    const wantThreads = new Set<number>();
    for (const account of mine) {
      for (let i = joins.threadOffsets[account]!; i < joins.threadOffsets[account + 1]!; i += 1) {
        wantThreads.add(joins.threadsOfAccount[i]!);
      }
    }

    const threads: CommsThread[] = [];
    const messages: CommsMessage[] = [];
    const calls: CommsCall[] = [];
    const wantAccounts = new Set<number>(mine);

    for (const thread of [...wantThreads].sort((a, b) => a - b)) {
      const [at, count, channel, kind, focus, externalId, title, created] = await Promise.all([
        reader.scalar("conversation.at", thread),
        reader.scalar("conversation.count", thread),
        reader.scalar("conversation.channel", thread),
        reader.scalar("conversation.kind", thread),
        reader.scalar("conversation.focus", thread),
        reader.scalar("conversation.externalId", thread),
        reader.scalar("conversation.title", thread),
        reader.scalar("conversation.created", thread),
      ]);
      const members = await reader.slice("participant.account", at, count);
      const participants = Array.from({ length: count }, (_, i) => members.readUInt32LE(i * 4));
      for (const account of participants) wantAccounts.add(account);

      const messageRuns = joins.messagesOf.get(thread) ?? [];
      const callRuns = joins.callsOf.get(thread) ?? [];
      let messagesHere = 0;
      let callsHere = 0;

      for (const run of messageRuns) {
        messagesHere += run.count;
        const read = await block(reader, MESSAGE_COLUMNS, run);
        for (let i = 0; i < run.count; i += 1) {
          messages.push({
            index: run.start + i,
            conversation: thread,
            from: read("message.from", i),
            at: read("message.at", i),
            kind: enums.messageKind?.[read("message.kind", i)] ?? "text",
            bytes: read("message.bytes", i),
            replyTo: read("message.replyTo", i),
            seq: read("message.seq", i),
            subscriber: read("message.subscriber", i),
          });
        }
      }
      for (const run of callRuns) {
        callsHere += run.count;
        const read = await block(reader, CALL_COLUMNS, run);
        for (let i = 0; i < run.count; i += 1) {
          calls.push({
            index: run.start + i,
            conversation: thread,
            from: read("call.from", i),
            at: read("call.at", i),
            outcome: enums.callOutcome?.[read("call.outcome", i)] ?? "answered",
            ring: read("call.ring", i),
            duration: read("call.duration", i),
            subscriber: read("call.subscriber", i),
            callback: read("call.callback", i),
          });
        }
      }

      threads.push({
        index: thread,
        channel: channelOf(channel),
        kind: enums.conversationKind?.[kind] ?? "dyad",
        focus: focus < 0 ? null : (enums.conversationFocus?.[focus] ?? null),
        externalId: reader.string(externalId),
        title: reader.string(title),
        created,
        participants,
        messages: messagesHere,
        calls: callsHere,
      });
    }

    // The carrier's own rows, for the subset of this traffic it ever saw.
    const sms: CommsSms[] = [];
    for (const message of messages) {
      const range = search(joins.smsMessage, message.index);
      if (!range.count) continue;
      const read = await block(reader, SMS_COLUMNS, range);
      for (let i = 0; i < range.count; i += 1) {
        const delivered = read("sms.delivered", i);
        sms.push({
          message: message.index,
          from: read("sms.from", i),
          to: read("sms.to", i),
          cell: cellRef(read("sms.cell", i)),
          part: read("sms.part", i),
          parts: read("sms.parts", i),
          delivered: delivered < 0 ? null : delivered,
        });
      }
    }

    const cdr: CommsCdr[] = [];
    for (const call of calls) {
      const range = search(joins.cdrCall, call.index);
      if (!range.count) continue;
      const read = await block(reader, CDR_COLUMNS, range);
      for (let i = 0; i < range.count; i += 1) {
        const handoverAt = read("cdr.handoverAt", i);
        const handoverCount = read("cdr.handoverCount", i);
        const handovers: { second: number; cell: number | null }[] = [];
        if (handoverCount > 0) {
          const trail = await block(reader, ["handover.second", "handover.cell"], {
            start: handoverAt, count: handoverCount,
          });
          for (let step = 0; step < handoverCount; step += 1) {
            handovers.push({
              second: trail("handover.second", step),
              cell: cellRef(trail("handover.cell", step)),
            });
          }
        }
        cdr.push({
          call: call.index,
          from: read("cdr.from", i),
          to: read("cdr.to", i),
          originCell: cellRef(read("cdr.originCell", i)),
          endCell: cellRef(read("cdr.endCell", i)),
          handovers,
        });
      }
    }

    // Senders are already participants, but a broadcast list is not symmetric
    // and the cheapest guarantee that every row can be named is to ask.
    for (const message of messages) wantAccounts.add(message.from);
    for (const call of calls) wantAccounts.add(call.from);

    const accounts = await readAccounts(reader, wantAccounts);
    const subscribers = await readSubscribers(reader, [
      ...messages.map((message) => message.subscriber),
      ...calls.map((call) => call.subscriber),
      ...sms.flatMap((row) => [row.from, row.to]),
      ...cdr.flatMap((row) => [row.from, row.to]),
    ]);
    const cells = await readCells(reader, [
      ...sms.map((row) => row.cell),
      ...cdr.flatMap((row) => [row.originCell, row.endCell, ...row.handovers.map((step) => step.cell)]),
    ].filter((cell): cell is number => cell !== null));

    return {
      ...empty,
      accounts: accounts.filter((account) => account.person === person),
      counterparts: accounts.filter((account) => account.person !== person),
      threads,
      messages: messages.sort((a, b) => a.at - b.at),
      calls: calls.sort((a, b) => a.at - b.at),
      sms,
      cdr,
      subscribers,
      cells,
    };
  } finally {
    await reader.close();
  }
}

async function readAccounts(reader: Reader, wanted: Iterable<number>): Promise<CommsAccount[]> {
  const indices = [...new Set(wanted)].filter((account) => account >= 0).sort((a, b) => a - b);
  return Promise.all(indices.map(async (account) => {
    const fields = await Promise.all(ACCOUNT_COLUMNS.map(async (name) =>
      value(await reader.slice(name, account, 1), reader.spec(name).type, 0)));
    const [person, channel, handle, displayName, subscriber, created] = fields;
    return {
      index: account,
      // A u32 person column carries the comms layer's own absence as its
      // largest value, which is how a counterparty outside the population — an
      // absent parent, a family left behind — arrives here.
      person: person! === 0xffffffff ? -1 : person!,
      channel: reader.meta.enums.channel?.[channel!] ?? "unknown",
      handle: reader.string(handle!),
      displayName: reader.string(displayName!),
      subscriber: subscriber!,
      created: created!,
    } satisfies CommsAccount;
  }));
}

/**
 * The attention curve, decoded from its runs.
 *
 * Nothing at all for a person with no curve, and that is a different fact from
 * a curve that is flat at zero: the first is "this day was never derived", the
 * second would be "derived, and never reachable". Only the first is what an
 * absent run list means.
 */
async function readAttention(
  reader: Reader, row: number,
): Promise<{ known: boolean; runs: AttentionRun[] }> {
  if (!reader.has("attention.start")) return { known: false, runs: [] };
  const [offset, count] = await Promise.all([
    reader.scalar("person.attentionOffset", row),
    reader.scalar("person.attentionCount", row),
  ]);
  if (count === 0) return { known: false, runs: [] };

  const scale = reader.meta.attentionScale ?? 255;
  const [starts, levels, asleep] = await Promise.all([
    reader.slice("attention.start", offset, count),
    reader.slice("attention.level", offset, count),
    reader.slice("attention.asleep", offset, count),
  ]);
  const runs: AttentionRun[] = Array.from({ length: count }, (_, i) => ({
    start: starts.readUInt32LE(i * 4),
    end: i + 1 < count ? starts.readUInt32LE((i + 1) * 4) : MINUTES,
    level: levels.readUInt8(i) / scale,
    asleep: asleep.readUInt8(i) === 1,
  }));
  return { known: true, runs };
}

/**
 * What a death does to the records the base day already wrote.
 *
 * The scenario runner treats existing exchanges as the authority and only
 * re-projects their cells; a person who died at nine still has their
 * recorded ten o'clock texts. This is the one effect that removes rows rather
 * than adding them, and it removes exactly what could not have happened:
 *
 *   - anything the dead person sent after the minute, and every reply that
 *     answered it, because a reply to a message that was never sent is a
 *     message about nothing;
 *   - every call they placed after the minute, and every callback returning
 *     one of those;
 *   - nothing they *received*. A text to a dead person's phone is delivered
 *     and sits there unread. A call to it rings out or reaches voicemail,
 *     which is what the outcome is rewritten to; the phone's own cells stay
 *     on the record, because the phone is still where the body is;
 *   - the rest of a call in progress at the minute. A connected call ends at
 *     that second (its duration shortened, its handovers after the second
 *     dropped). A call still ringing ends there if the caller is the one gone,
 *     and rings out unanswered if the callee is.
 *
 * A mute removes rows the same way for the living: the recorded exchanges
 * between two people in a window, and whatever answered them, so that a
 * scenario can say two people never rang each other that day.
 */

import { comms, products, shared } from "../../../kierston/sim/src/index.ts";
import { seedFor } from "../authoring/time.ts";

const RING_OUT = 28;
const VOICEMAIL = 0.22;

export interface Truncation { messagesRemoved: number; callsRemoved: number; callsUnanswered: number; callsCut: number }
export interface Removal { messagesRemoved: number; callsRemoved: number }

type Tables = Awaited<ReturnType<typeof exchangeTables>>;

async function exchangeTables(file: products.KdayFile) {
  const [message, call, sms, cdr, handover, conversation, participant] = await Promise.all([
    file.table("message"), file.table("call"), file.table("sms"), file.table("cdr"), file.table("handover"),
    file.table("conversation"), file.table("participant"),
  ]);
  const membersOf = (thread: number): ArrayLike<number> =>
    participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + conversation.count![thread]!);
  return { message, call, sms, cdr, handover, conversation, participant, membersOf };
}

/** Extend a keep mask over messages: a reply to a removed message goes too. */
function closeReplies(message: Tables["message"], keepMessage: Uint8Array): void {
  const messages = message.at!.length;
  const bySeq = new Map<string, number>();
  for (let i = 0; i < messages; i++) bySeq.set(`${message.conversation![i]}/${message.seq![i]}`, i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < messages; i++) {
      if (!keepMessage[i] || message.replyTo![i]! < 0) continue;
      const parent = bySeq.get(`${message.conversation![i]}/${message.replyTo![i]}`);
      if (parent !== undefined && !keepMessage[parent]) { keepMessage[i] = 0; changed = true; }
    }
  }
}

/** Extend a keep mask over calls: a callback returning a removed call goes too. */
function closeCallbacks(call: Tables["call"], keepCall: Uint8Array): void {
  const calls = call.at!.length;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < calls; i++) {
      const back = call.callback![i]!;
      if (keepCall[i] && back >= 0 && !keepCall[back]) { keepCall[i] = 0; changed = true; }
    }
  }
}

/**
 * Drop the rows a keep mask says to drop, from every table that indexes
 * them: messages and calls, the SMS and CDR rows over them, the handovers
 * of the surviving CDR rows, and the header counts. A handover later than
 * its call's end goes too, and the record's end cell follows the last one
 * kept, so a call shortened in place is written back consistently. `dirty`
 * forces the rewrite when call rows were edited but nothing was removed.
 */
function removeExchanges(file: products.KdayFile, tables: Tables, keepMessage: Uint8Array, keepCall: Uint8Array, dirty = false): Removal {
  const { message, call, sms, cdr, handover } = tables;
  const messages = message.at!.length, calls = call.at!.length;
  const messageIndex = new Int32Array(messages).fill(-1);
  let next = 0;
  for (let i = 0; i < messages; i++) if (keepMessage[i]) messageIndex[i] = next++;
  const out: Removal = { messagesRemoved: messages - next, callsRemoved: 0 };
  const callIndex = new Int32Array(calls).fill(-1);
  next = 0;
  for (let i = 0; i < calls; i++) if (keepCall[i]) callIndex[i] = next++;
  out.callsRemoved = calls - next;
  if (!out.messagesRemoved && !out.callsRemoved && !dirty) return out;

  const compact = (prefix: string, table: Record<string, products.NumberArray>, keep: Uint8Array, remap?: Record<string, Int32Array>) => {
    for (const [field, values] of Object.entries(table)) {
      const kept: number[] = [];
      for (let i = 0; i < values.length; i++) {
        if (!keep[i]) continue;
        const value = values[i]!;
        const map = remap?.[field];
        kept.push(map && value >= 0 ? map[value]! : value);
      }
      file.set(`${prefix}.${field}`, kept);
    }
  };
  compact("message", message, keepMessage);
  compact("call", call, keepCall, { callback: callIndex });
  const keepSms = Uint8Array.from(sms.message!, (index) => keepMessage[index]!);
  compact("sms", sms, keepSms, { message: messageIndex });
  // Handovers are rebuilt from the surviving call records, in their order.
  const keepCdr = Uint8Array.from(cdr.call!, (index) => keepCall[index]!);
  const seconds: number[] = [], cells: number[] = [], handoverAt: number[] = [], handoverCount: number[] = [];
  for (let i = 0; i < cdr.call!.length; i++) {
    if (!keepCdr[i]) continue;
    const index = cdr.call![i]!;
    const end = call.at![index]! + call.ring![index]! + call.duration![index]!;
    const offset = seconds.length;
    let last = cdr.originCell![i]!, cut = false;
    handoverAt.push(offset);
    for (let j = cdr.handoverAt![i]!; j < cdr.handoverAt![i]! + cdr.handoverCount![i]!; j++) {
      if (handover.second![j]! > end) { cut = true; continue; }
      seconds.push(handover.second![j]!); cells.push(handover.cell![j]!);
      last = handover.cell![j]!;
    }
    if (cut) cdr.endCell![i] = last;
    handoverCount.push(seconds.length - offset);
  }
  compact("cdr", cdr, keepCdr, { call: callIndex });
  file.set("cdr.handoverAt", handoverAt); file.set("cdr.handoverCount", handoverCount);
  file.set("handover.second", seconds); file.set("handover.cell", cells);
  for (const [count, column] of Object.entries({ messages: "message.at", calls: "call.at", smsRecords: "sms.message", callRecords: "cdr.call", handovers: "handover.second" })) {
    if (count in file.header.counts) file.header.counts[count] = file.count(column);
  }
  return out;
}

export interface MuteWindow { people: readonly [number, number]; from: number; until: number }

/**
 * Remove the recorded texts and calls between two people inside a window:
 * every row in a one-to-one thread whose two accounts are theirs, sent in
 * the window, plus the replies and callbacks that answered one. Group
 * threads are untouched. Runs before the scenario's own exchanges are
 * appended, so it never touches them.
 */
export async function muteExchanges(file: products.KdayFile, accounts: comms.Accounts, mutes: readonly MuteWindow[]): Promise<Removal[]> {
  if (!mutes.length || !file.has("message.at")) return mutes.map(() => ({ messagesRemoved: 0, callsRemoved: 0 }));
  const tables = await exchangeTables(file);
  const { message, call, conversation, membersOf } = tables;
  const personOf = (account: number): number => accounts.all[account]!.person;
  const dyads = mutes.map(({ people }) => {
    const pair = new Set(people);
    const threads = new Set<number>();
    for (let thread = 0; thread < conversation.at!.length; thread++) {
      if (conversation.count![thread] !== 2) continue;
      const members = Array.from(membersOf(thread)).map(personOf);
      if (members.every((person) => pair.has(person)) && new Set(members).size === 2) threads.add(thread);
    }
    return threads;
  });
  const messages = message.at!.length, calls = call.at!.length;
  const keepMessage = new Uint8Array(messages).fill(1), keepCall = new Uint8Array(calls).fill(1);
  const before = { messages: new Uint8Array(messages), calls: new Uint8Array(calls) };
  const removed: Removal[] = [];
  for (const [index, mute] of mutes.entries()) {
    const from = mute.from * 60, until = mute.until * 60;
    const threads = dyads[index]!;
    for (let i = 0; i < messages; i++) if (threads.has(message.conversation![i]!) && message.at![i]! >= from && message.at![i]! < until) keepMessage[i] = 0;
    for (let i = 0; i < calls; i++) if (threads.has(call.conversation![i]!) && call.at![i]! >= from && call.at![i]! < until) keepCall[i] = 0;
    closeReplies(message, keepMessage);
    closeCallbacks(call, keepCall);
    let droppedMessages = 0, droppedCalls = 0;
    for (let i = 0; i < messages; i++) if (!keepMessage[i] && !before.messages[i]) { droppedMessages++; before.messages[i] = 1; }
    for (let i = 0; i < calls; i++) if (!keepCall[i] && !before.calls[i]) { droppedCalls++; before.calls[i] = 1; }
    removed.push({ messagesRemoved: droppedMessages, callsRemoved: droppedCalls });
  }
  removeExchanges(file, tables, keepMessage, keepCall);
  return removed;
}

/** Minutes `[from, until)` in which a person could neither send nor answer. */
export interface Unreachable { from: number; until: number }

export async function truncateForTheDead(
  file: products.KdayFile, accounts: comms.Accounts, deaths: ReadonlyMap<number, number>, seed: number,
): Promise<Truncation> {
  const spans = new Map<number, Unreachable[]>();
  for (const [person, minute] of deaths) spans.set(person, [{ from: minute, until: Number.POSITIVE_INFINITY }]);
  return truncateUnreachable(file, accounts, spans, seed, "mortality");
}

/**
 * The same removal for the living who were parted from every handset: a phone
 * left at home, dropped at a kerb, thrown from a car. Inside each interval the
 * owner sent nothing, placed nothing and answered nothing; texts to the phone
 * were delivered and calls to it rang out where it lay.
 */
export async function truncateForTheParted(
  file: products.KdayFile, accounts: comms.Accounts, parted: ReadonlyMap<number, readonly Unreachable[]>, seed: number,
): Promise<Truncation> {
  return truncateUnreachable(file, accounts, parted, seed, "parted");
}

async function truncateUnreachable(
  file: products.KdayFile, accounts: comms.Accounts, spans: ReadonlyMap<number, readonly Unreachable[]>, seed: number, key: string,
): Promise<Truncation> {
  const out: Truncation = { messagesRemoved: 0, callsRemoved: 0, callsUnanswered: 0, callsCut: 0 };
  if (!spans.size || !file.has("message.at")) return out;
  const gone = new Map<number, { from: number; until: number }[]>();
  for (const [person, intervals] of spans) {
    const seconds = intervals.filter((span) => span.until > span.from).map((span) => ({ from: span.from * 60, until: span.until * 60 }));
    if (!seconds.length) continue;
    for (const account of accounts.forPerson(person)) gone.set(account.index, seconds);
  }
  if (!gone.size) return out;
  const tables = await exchangeTables(file);
  const { message, call, membersOf } = tables;
  const goneAt = (account: number, second: number): boolean =>
    gone.get(account)?.some((span) => second >= span.from && second < span.until) ?? false;

  // Messages: the sender's own, then everything that answered them.
  const messages = message.at!.length;
  const keepMessage = new Uint8Array(messages).fill(1);
  for (let i = 0; i < messages; i++) if (goneAt(message.from![i]!, message.at![i]!)) keepMessage[i] = 0;
  closeReplies(message, keepMessage);
  // Calls: the person's own, callbacks returning them, and the ones to them
  // that can no longer be answered or declined.
  const calls = call.at!.length;
  const keepCall = new Uint8Array(calls).fill(1);
  for (let i = 0; i < calls; i++) if (goneAt(call.from![i]!, call.at![i]!)) keepCall[i] = 0;
  closeCallbacks(call, keepCall);
  const answered = comms.outcomeOf("answered"), rejected = comms.outcomeOf("rejected"), busy = comms.outcomeOf("busy");
  const noAnswer = comms.outcomeOf("no-answer"), voicemail = comms.outcomeOf("voicemail");
  const unanswered = (i: number) => {
    const rng = new shared.Rng(seedFor(seed, `${key}/call/${i}`));
    call.outcome![i] = rng.bool(VOICEMAIL) ? voicemail : noAnswer;
    call.duration![i] = 0;
    call.ring![i] = RING_OUT;
    out.callsUnanswered++;
  };
  // The first second inside (at, end) at which an account's owner is gone.
  const goneWithin = (account: number, at: number, end: number): number => {
    let first = Number.POSITIVE_INFINITY;
    for (const span of gone.get(account) ?? []) if (span.from > at && span.from < end) first = Math.min(first, span.from);
    return first;
  };
  for (let i = 0; i < calls; i++) {
    if (!keepCall[i]) continue;
    const outcome = call.outcome![i];
    const others = Array.from(membersOf(call.conversation![i]!)).filter((account) => account !== call.from![i]);
    // Nobody there to pick up, and nobody there to decline either.
    const reachable = outcome === answered || outcome === rejected || outcome === busy;
    if (reachable && others.some((account) => goneAt(account, call.at![i]!))) { unanswered(i); continue; }
    // A call already under way when one end goes.
    const at = call.at![i]!, ring = call.ring![i]!, end = at + ring + call.duration![i]!;
    const callerCut = goneWithin(call.from![i]!, at, end);
    // The callee's leaving only matters to a call they would have taken.
    const calleeCut = reachable ? Math.min(...others.map((account) => goneWithin(account, at, end))) : Number.POSITIVE_INFINITY;
    const cut = Math.min(callerCut, calleeCut);
    if (!Number.isFinite(cut)) continue;
    if (cut > at + ring) call.duration![i] = cut - at - ring;
    else if (callerCut <= calleeCut) {
      // The caller is gone before anyone answered: the attempt stops ringing there.
      call.outcome![i] = noAnswer; call.ring![i] = cut - at; call.duration![i] = 0;
    } else { unanswered(i); continue; }
    out.callsCut++;
  }

  const removed = removeExchanges(file, tables, keepMessage, keepCall, out.callsUnanswered + out.callsCut > 0);
  out.messagesRemoved = removed.messagesRemoved; out.callsRemoved = removed.callsRemoved;
  return out;
}

/**
 * Remove recorded calls by index, with the callbacks that returned them and
 * their carrier rows. Messages are untouched. Used when a scripted call takes
 * the line of a re-planned person inside a replacement window.
 */
export async function dropCalls(file: products.KdayFile, indexes: ReadonlySet<number>): Promise<number> {
  if (!indexes.size || !file.has("call.at")) return 0;
  const tables = await exchangeTables(file);
  const keepMessage = new Uint8Array(tables.message.at!.length).fill(1);
  const keepCall = new Uint8Array(tables.call.at!.length).fill(1);
  for (const index of indexes) keepCall[index] = 0;
  closeCallbacks(tables.call, keepCall);
  return removeExchanges(file, tables, keepMessage, keepCall).callsRemoved;
}

/** Zero the packed attention curve from a minute on. */
export function silenceAttention(columns: products.DayColumns, minute: number): void {
  const keep = columns.attentionStart.findIndex((start) => start >= minute);
  const cut = keep < 0 ? columns.attentionStart.length : keep;
  const lastLevel = cut > 0 ? columns.attentionLevel[cut - 1]! : 0;
  const lastAsleep = cut > 0 ? columns.attentionAsleep[cut - 1]! : 0;
  columns.attentionStart.length = cut; columns.attentionLevel.length = cut; columns.attentionAsleep.length = cut;
  if (cut === 0 || lastLevel !== 0 || lastAsleep !== 0) {
    columns.attentionStart.push(minute); columns.attentionLevel.push(0); columns.attentionAsleep.push(0);
  }
  // One person's columns: the CSR count must follow the runs.
  columns.personAttentionCount = [columns.attentionStart.length];
}

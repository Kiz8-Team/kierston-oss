import { comms, products } from "../../../kierston/sim/src/index.ts";
import { appendRows } from "../storage/columns.ts";

export async function cellLookup(file: products.KdayFile): Promise<comms.CellAt> {
  const span = await file.table("span");
  const ranges = new Map<number, number[]>();
  for (let i = 0; i < span.subscriber!.length; i++) {
    const subscriber = span.subscriber![i]!;
    const list = ranges.get(subscriber) ?? [];
    list.push(i); ranges.set(subscriber, list);
  }
  return (subscriber, minute) => {
    const list = ranges.get(subscriber);
    if (!list) return -1;
    let low = 0, high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1, i = list[mid]!;
      if (minute < span.start![i]!) high = mid - 1;
      else if (minute >= span.end![i]!) low = mid + 1;
      else return span.cell![i]!;
    }
    return -1;
  };
}

const NONE = -1;
const MINUTES = 1440;

/**
 * Existing exchanges remain the authority; only their location projections
 * change. A record is re-projected when the subscriber at either end belongs
 * to a re-planned person: the sender's cell and the recipient's cell and
 * delivery time for a text, both ends' cells and the caller's handovers for a
 * call. The rules are the engine's own (`carrierRecords`, `callCarrierRecords`
 * in comms/exchange.ts): a text is delivered at the recipient's first attached
 * minute from two seconds after sending, or never; a text whose sender had no
 * cell was never submitted. Re-projecting the frozen end of a record yields
 * its base values unless the call itself changed length (a death or parting
 * cut it short), which is the case that needs it.
 */
export async function refreshCarrier(file: products.KdayFile, changed: ReadonlySet<number>, cellAt: comms.CellAt): Promise<void> {
  const [sms, cdr, calls, messages, handovers] = await Promise.all([
    file.table("sms"), file.table("cdr"), file.table("call"), file.table("message"), file.table("handover"),
  ]);
  const nextAttached = (subscriber: number, from: number): { minute: number; cell: number } | null => {
    for (let minute = Math.max(0, from); minute < MINUTES; minute++) {
      const cell = cellAt(subscriber, minute);
      if (cell !== NONE) return { minute, cell };
    }
    return null;
  };
  for (let i = 0; i < sms.from!.length; i++) {
    const from = sms.from![i]!, to = sms.to![i]!;
    if (!changed.has(from) && !changed.has(to)) continue;
    const at = messages.at![sms.message![i]!]!;
    if (changed.has(from)) sms.cell![i] = cellAt(from, Math.floor(at / 60));
    const cell = sms.cell![i]!;
    const earliest = at + 2;
    const receiving = to >= 0 && cell !== NONE ? nextAttached(to, Math.floor(earliest / 60)) : null;
    sms.toCell![i] = receiving?.cell ?? NONE;
    sms.delivered![i] = cell === NONE ? NONE
      : to < 0 ? earliest
        : receiving ? Math.max(earliest, receiving.minute * 60) : NONE;
  }
  for (const field of ["cell", "toCell", "delivered"]) file.set(`sms.${field}`, sms[field]!);
  const seconds: number[] = [], cells: number[] = [];
  for (let i = 0; i < cdr.call!.length; i++) {
    const offset = seconds.length;
    const from = cdr.from![i]!, to = cdr.to![i]!;
    if (changed.has(from) || changed.has(to)) {
      const call = cdr.call![i]!;
      const at = calls.at![call]!, length = calls.ring![call]! + calls.duration![call]!;
      const trail = comms.callCells(cellAt, from, at, length);
      cdr.originCell![i] = trail.originCell; cdr.endCell![i] = trail.endCell;
      for (let j = 0; j < trail.handovers.length; j += 2) { seconds.push(trail.handovers[j]!); cells.push(trail.handovers[j + 1]!); }
      const answering = to >= 0 ? comms.callCells(cellAt, to, at, length) : null;
      cdr.toOriginCell![i] = answering ? answering.originCell : NONE;
      cdr.toEndCell![i] = answering ? answering.endCell : NONE;
    } else {
      const start = cdr.handoverAt![i]!, end = start + cdr.handoverCount![i]!;
      for (let j = start; j < end; j++) { seconds.push(handovers.second![j]!); cells.push(handovers.cell![j]!); }
    }
    cdr.handoverAt![i] = offset; cdr.handoverCount![i] = seconds.length - offset;
  }
  for (const field of ["originCell", "endCell", "toOriginCell", "toEndCell", "handoverAt", "handoverCount"]) file.set(`cdr.${field}`, cdr[field]!);
  file.set("handover.second", seconds); file.set("handover.cell", cells);
  if ("handovers" in file.header.counts) file.header.counts.handovers = seconds.length;
}

export async function appendExchange(file: products.KdayFile, day: comms.DayComms): Promise<{ messages: number[]; calls: number[] }> {
  const [existing, messages] = await Promise.all([file.table("conversation"), file.table("message")]);
  const byId = new Map(Array.from(existing.externalId!, (id, i) => [file.string(id), i]));
  const mapped = new Map<number, number>();
  const sequence = new Map<number, number>();
  for (let i = 0; i < messages.seq!.length; i++) {
    const thread = messages.conversation![i]!;
    sequence.set(thread, Math.max(sequence.get(thread) ?? 0, messages.seq![i]! + 1));
  }
  for (const thread of day.dyads) {
    let index = byId.get(thread.externalId);
    if (index === undefined) {
      const members = day.dyadParticipants.slice(thread.at, thread.at + thread.count);
      const at = await appendRows(file, "participant", members.map((account) => ({ account })));
      index = await appendRows(file, "conversation", [{ channel: thread.channel, kind: thread.kind, at,
        count: members.length, focus: thread.focus, externalId: file.strings.id(thread.externalId),
        title: file.strings.id(thread.title), created: thread.created }]);
    }
    mapped.set(thread.index, index);
  }
  const messageAt = await appendRows(file, "message", day.messages.map((row) => {
    const conversation = mapped.get(row.conversation)!;
    const offset = sequence.get(conversation) ?? 0;
    return { conversation, from: row.from, at: row.at, kind: row.kind, channel: row.channel, bytes: row.bytes,
      replyTo: row.replyTo < 0 ? row.replyTo : row.replyTo + offset, seq: row.seq + offset, subscriber: row.subscriber };
  }));
  const callOffset = file.count("call.at");
  const callAt = await appendRows(file, "call", day.calls.map((row) => ({
    conversation: mapped.get(row.conversation)!, from: row.from, at: row.at, outcome: row.outcome,
    ring: row.ring, duration: row.duration, subscriber: row.subscriber,
    callback: row.callback < 0 ? row.callback : row.callback + callOffset,
  })));
  await appendRows(file, "sms", day.sms.map((row) => ({ ...row, message: row.message + messageAt })));
  const handoverAt = await appendRows(file, "handover", Array.from({ length: day.handovers.length / 2 }, (_, i) => ({
    second: day.handovers[i * 2]!, cell: day.handovers[i * 2 + 1]!,
  })));
  await appendRows(file, "cdr", day.cdr.map((row) => ({ ...row, call: row.call + callAt, handoverAt: row.handoverAt / 2 + handoverAt })));
  for (const [count, column] of Object.entries({ conversations: "conversation.at", messages: "message.at", calls: "call.at",
    smsRecords: "sms.message", callRecords: "cdr.call" })) file.header.counts[count] = file.count(column);
  return { messages: day.messages.map((_, i) => messageAt + i), calls: day.calls.map((_, i) => callAt + i) };
}

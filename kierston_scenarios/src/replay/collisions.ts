/**
 * One telephone line per person across the base day's calls and the
 * scenario's scripted calls.
 *
 * The engine's `reconcileCommunications` gives every call one line per
 * participant, but only within one draw. Scripted exchanges are drawn one at a
 * time against an empty day, so on their own they can overlap a recorded call
 * on the same handset, or each other. This pass applies the same line model
 * across all of them, after `project` and before anything is appended:
 *
 *   - A call occupies the caller's line from setup to `at + ring + duration`,
 *     and the callee's line over the same interval unless it ended busy or
 *     failed. A service line (911) is never occupied.
 *   - Scripted calls are taken in order of setup, ties in exchange order.
 *   - A recorded call of a re-planned person that overlaps a scripted call
 *     whose setup second lies inside one of that person's replacement windows
 *     is removed, with the callbacks that returned it: the re-planned day
 *     replaces the recorded one there. The other party loses the call too.
 *   - Any other overlap on the caller's line makes the scripted call `failed`
 *     (ring 1 s, no conversation); an overlap on the callee's line makes it
 *     `busy` (ring at most 9 s, no conversation). These are the values
 *     `reconcileCommunications` writes for the same collisions. A call the
 *     projection already failed is left as it is.
 *   - Overlap is tested both ways: a recorded call that starts while the
 *     scripted one is in progress collides as well, because recorded calls
 *     are not moved.
 *   - A later scripted call collides with an earlier one by the same rules;
 *     scripted calls are never removed.
 *
 * Carrier rows of a scripted call whose outcome changed are re-projected.
 */

import { comms, products } from "../../../kierston/sim/src/index.ts";
import type { Window } from "../authoring/dsl.ts";
import { dropCalls } from "../effects/mortality.ts";

export interface Collisions { baseCallsDropped: number; scriptedFailed: number; scriptedBusy: number }

interface Occupant { start: number; end: number; base: number; people: number[]; dropped: boolean }

const BUSY_RING = 9;

export async function reconcileScripted(
  file: products.KdayFile, accounts: comms.Accounts, results: readonly comms.DayComms[],
  windows: ReadonlyMap<number, readonly Window[]>, cellAt: comms.CellAt,
): Promise<Collisions> {
  const out: Collisions = { baseCallsDropped: 0, scriptedFailed: 0, scriptedBusy: 0 };
  const busy = comms.outcomeOf("busy"), failed = comms.outcomeOf("failed");
  const personOf = (account: number): number => accounts.all[account]!.person;

  // Caller and callee of every scripted call, in setup order.
  const scripted: { result: comms.DayComms; call: comms.Call; order: number; caller: number; callee: number | null }[] = [];
  for (const [order, result] of results.entries()) {
    const dyads = new Map(result.dyads.map((thread) => [thread.index, thread]));
    for (const call of result.calls) {
      const thread = dyads.get(call.conversation) ?? accounts.conversations[call.conversation];
      if (!thread) continue;
      const members = thread.index < accounts.conversations.length
        ? Array.from(accounts.participants.subarray(thread.at, thread.at + thread.count))
        : result.dyadParticipants.slice(thread.at, thread.at + thread.count);
      const caller = personOf(call.from);
      const callee = members.map(personOf).find((person) => person !== caller) ?? null;
      scripted.push({ result, call, order, caller, callee });
    }
  }
  if (!scripted.length) return out;
  scripted.sort((a, b) => a.call.at - b.call.at || a.order - b.order || a.call.index - b.call.index);
  const people = new Set(scripted.flatMap(({ caller, callee }) => callee === null ? [caller] : [caller, callee]));

  // Recorded occupancy of the people the scripted calls touch.
  const lines = new Map<number, Occupant[]>();
  const occupy = (person: number, occupant: Occupant) => {
    if (comms.isService(person) || !people.has(person)) return;
    const list = lines.get(person) ?? []; list.push(occupant); lines.set(person, list);
  };
  if (file.has("call.at")) {
    const [call, conversation, participant] = await Promise.all([file.table("call"), file.table("conversation"), file.table("participant")]);
    for (let i = 0; i < call.at!.length; i++) {
      const thread = call.conversation![i]!;
      const members = participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + conversation.count![thread]!);
      const caller = personOf(call.from![i]!);
      const callee = Array.from(members, personOf).find((person) => person !== caller) ?? null;
      if (!people.has(caller) && (callee === null || !people.has(callee))) continue;
      const outcome = call.outcome![i]!;
      const reached = callee !== null && outcome !== busy && outcome !== failed;
      const occupant: Occupant = { start: call.at![i]!, end: call.at![i]! + call.ring![i]! + call.duration![i]!, base: i,
        people: reached ? [caller, callee] : [caller], dropped: false };
      for (const person of occupant.people) occupy(person, occupant);
    }
  }

  const inWindow = (person: number, second: number): boolean =>
    windows.get(person)?.some((window) => window.start * 60 <= second && second < window.end * 60) ?? false;
  const overlapping = (person: number, start: number, end: number): Occupant[] =>
    (lines.get(person) ?? []).filter((o) => !o.dropped && o.start < end && start < o.end);
  // Overlaps that hold the line: everything except recorded calls the window replaces.
  const holding = (person: number, start: number, end: number, at: number): Occupant[] =>
    overlapping(person, start, end).filter((o) => o.base < 0 || !inWindow(person, at));
  const drops = new Set<number>();
  const release = (person: number, start: number, end: number, at: number) => {
    if (!inWindow(person, at)) return;
    for (const o of overlapping(person, start, end)) if (o.base >= 0) { o.dropped = true; drops.add(o.base); }
  };
  const changed = new Map<comms.DayComms, Set<number>>();

  for (const { result, call, caller, callee } of scripted) {
    const at = call.at;
    let end = at + call.ring + call.duration;
    const service = callee !== null && comms.isService(callee);
    let reached = callee !== null && call.outcome !== failed && call.outcome !== busy;
    if (call.outcome !== failed && holding(caller, at, end, at).length) {
      call.outcome = failed; call.ring = 1; call.duration = 0;
      reached = false; out.scriptedFailed++;
    } else if (reached && !service && holding(callee!, at, end, at).length) {
      call.outcome = busy; call.ring = Math.min(call.ring, BUSY_RING); call.duration = 0;
      reached = false; out.scriptedBusy++;
    }
    if (call.ring + call.duration !== end - at) {
      end = at + call.ring + call.duration;
      const set = changed.get(result) ?? new Set<number>(); set.add(call.index); changed.set(result, set);
    }
    const occupant: Occupant = { start: at, end, base: -1, people: reached ? [caller, callee!] : [caller], dropped: false };
    for (const person of occupant.people) {
      release(person, at, end, at);
      occupy(person, occupant);
    }
  }
  for (const [result, calls] of changed) reprojectCalls(result, calls, cellAt);
  out.baseCallsDropped = await dropCalls(file, drops);
  return out;
}

/** Rebuild the carrier rows of the given calls with their new length. */
function reprojectCalls(result: comms.DayComms, calls: ReadonlySet<number>, cellAt: comms.CellAt): void {
  const handovers: number[] = [];
  for (const row of result.cdr) {
    const offset = handovers.length;
    if (calls.has(row.call)) {
      const call = result.calls[row.call]!;
      const length = call.ring + call.duration;
      const trail = comms.callCells(cellAt, row.from, call.at, length);
      row.originCell = trail.originCell; row.endCell = trail.endCell;
      handovers.push(...trail.handovers);
      const answering = row.to >= 0 ? comms.callCells(cellAt, row.to, call.at, length) : null;
      row.toOriginCell = answering ? answering.originCell : comms.NONE;
      row.toEndCell = answering ? answering.endCell : comms.NONE;
    } else {
      handovers.push(...result.handovers.slice(row.handoverAt, row.handoverAt + row.handoverCount * 2));
    }
    row.handoverAt = offset;
    row.handoverCount = (handovers.length - offset) / 2;
  }
  result.handovers = handovers;
}

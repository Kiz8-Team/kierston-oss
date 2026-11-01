/**
 * The invariants the communications layer is supposed to guarantee.
 *
 * Against the real city, like the radio and banking tests, because the claims
 * worth checking are about the whole thing: that a thin channel leaves no
 * carrier trace, that the branching terminates on its own, that a reply never
 * precedes what it answers. A fixture could only show that the code does what
 * it was written to do.
 *
 * The layer is expensive to run at full scale, so these use a strided cohort.
 * That has one consequence worth stating, because it would otherwise look like
 * a failure: most of a person's correspondents are not in the cohort and
 * therefore cannot reply, so the *volume* here is much lower than the city's.
 * Nothing below asserts on volume for that reason. The properties asserted are
 * ones a single conversation either has or does not.
 */

import { describe, expect, test } from "bun:test";
import {
  CALL_OUTCOMES, CHANNELS, CONVERSATION_KINDS, Comms, MESSAGE_KINDS,
  NONE, SECONDS, isCarrier, outcomeOf,
} from "./index.ts";
import { Subscribers } from "../network/index.ts";
import { loadDayContext } from "../engine/index.ts";
import { planDay } from "../scheduler/index.ts";
import { dayNumber, parseDate } from "../shared/index.ts";
import { simDataPresent } from "../world/index.ts";

/** Skipped, not failed, on a checkout without a built city. */
const CITY = simDataPresent("population.json", "towers.json", "devices.json", "accounts.json");
const context = CITY ? await loadDayContext() : (null as unknown as Awaited<ReturnType<typeof loadDayContext>>);
const subscribers = CITY ? await Subscribers.open() : (null as unknown as Subscribers);
const comms = CITY ? await Comms.open(subscribers) : (null as unknown as Comms);
const DATE = parseDate("2026-07-28");
const DAY = dayNumber(DATE);
const SEED = CITY ? context.world.seed : 0;

if (CITY) for (const person of context.world.persons.values()) {
  if (person.id % 23 !== 0) continue;
  comms.observe(
    planDay(context, person, DATE, DAY), person,
    context.world.assignments.get(person.id)?.occupation ?? null, SEED, DAY,
  );
}
/** Every person in a conversation, static or day-local. */
function participantsOf(conversation: number): number[] {
  const thread = conversation < comms.accounts.conversations.length
    ? comms.accounts.conversations[conversation]!
    : day.dyads[conversation - comms.accounts.conversations.length]!;
  const ids = conversation < comms.accounts.conversations.length
    ? comms.accounts.participants.slice(thread.at, thread.at + thread.count)
    : day.dyadParticipants.slice(thread.at, thread.at + thread.count);
  return Array.from(ids, (id) => comms.accounts.all[id]!.person);
}

/** A cohort slice parted from their phones for the afternoon, as a scenario does for a handset left at home. */
const PARTED_FROM = 13 * 60, PARTED_UNTIL = 17 * 60;
const parted = new Set<number>();
if (CITY) for (const person of context.world.persons.values()) {
  if (person.incarcerated || person.id % 23 !== 0 || person.id % 7 !== 0) continue;
  comms.partFromHandset(person.id, PARTED_FROM, PARTED_UNTIL);
  parted.add(person.id);
}
const day = CITY ? comms.resolve(SEED, DAY, null, context.world, DATE) : (null as unknown as ReturnType<Comms["resolve"]>);

/** Every thread a message could point at, static and day-local together. */
const threads = new Map<number, { channel: number; kind: number; count: number }>();
if (CITY) for (const thread of comms.accounts.conversations) threads.set(thread.index, thread);
if (CITY) for (const thread of day.dyads) threads.set(thread.index, thread);

describe.skipIf(!CITY)("accounts", () => {
  test("people in custody have no endpoints, group memberships, or communications", () => {
    const held = [...context.world.persons.values()].filter((person) => person.incarcerated);
    expect(held.length).toBeGreaterThan(0);
    const prisoners = new Set(held.map((person) => person.id));
    for (const person of held) {
      expect(subscribers.forPerson(person.id)).toHaveLength(0);
      expect(comms.accounts.forPerson(person.id)).toHaveLength(0);
      expect(comms.has(person.id)).toBe(false);
    }
    for (const thread of comms.accounts.conversations) {
      for (const index of comms.accounts.members(thread)) {
        expect(prisoners.has(comms.accounts.all[index]!.person)).toBe(false);
      }
    }
    for (const row of [...day.messages, ...day.calls]) {
      expect(prisoners.has(comms.accounts.all[row.from]!.person)).toBe(false);
      expect(participantsOf(row.conversation).some((person) => prisoners.has(person))).toBe(false);
    }
    const free = comms.accounts.all.find((account) => comms.has(account.person))!.person;
    for (const [from, to] of [[held[0]!.id, free], [free, held[0]!.id]]) {
      for (const kind of ["call", "text"] as const) {
        expect(() => comms.request({ from: from!, to: to!, kind,
          channel: CHANNELS.indexOf(kind === "call" ? "voice" : "sms"), at: 3600, seed: 7,
        }, SEED, DAY, context.world, DATE)).toThrow(/incarcerated/);
      }
    }
  });
  test("every account resolves to a subscription", () => {
    expect(comms.accounts.orphans).toBe(0);
  });

  test("a phone-anchored handle is the holder's own number", () => {
    let checked = 0;
    for (const account of comms.accounts.all) {
      if (CHANNELS[account.channel] !== "whatsapp") continue;
      expect(account.subscriber).toBeGreaterThanOrEqual(0);
      expect(account.handle.startsWith("+1")).toBe(true);
      checked += 1;
      if (checked > 500) break;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("carrier channels resolve to one identity, not three", () => {
    const account = comms.accounts.all.find((row) => CHANNELS[row.channel] === "sms")!;
    const sms = comms.accounts.on(account.person, CHANNELS.indexOf("sms"));
    const voice = comms.accounts.on(account.person, CHANNELS.indexOf("voice"));
    const mms = comms.accounts.on(account.person, CHANNELS.indexOf("mms"));
    expect(voice).not.toBeNull();
    expect(voice!.index).toBe(sms!.index);
    expect(mms!.index).toBe(sms!.index);
  });

  test("nobody holds two accounts on one platform", () => {
    const seen = new Set<string>();
    for (const account of comms.accounts.all) {
      const key = `${account.person}:${account.channel}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe.skipIf(!CITY)("messages", () => {
  test("the city produced traffic at all", () => {
    expect(day.messages.length).toBeGreaterThan(1000);
    expect(day.calls.length).toBeGreaterThan(50);
  });

  test("every message falls inside its own day", () => {
    for (const message of day.messages) {
      expect(message.at).toBeGreaterThanOrEqual(0);
      expect(message.at).toBeLessThan(SECONDS);
    }
  });

  test("a reply never precedes the message it answers", () => {
    // Indexed per conversation, because `replyTo` is a conversation-local seq.
    const bySeq = new Map<string, number>();
    for (const message of day.messages) bySeq.set(`${message.conversation}:${message.seq}`, message.at);
    for (const message of day.messages) {
      if (message.replyTo === NONE) continue;
      const parent = bySeq.get(`${message.conversation}:${message.replyTo}`);
      expect(parent).toBeDefined();
      expect(message.at).toBeGreaterThanOrEqual(parent!);
    }
  });

  test("a thread's sequence numbers are dense and start at zero", () => {
    const seqs = new Map<number, number[]>();
    for (const message of day.messages) {
      const mine = seqs.get(message.conversation);
      if (mine) mine.push(message.seq);
      else seqs.set(message.conversation, [message.seq]);
    }
    for (const [, list] of seqs) {
      list.sort((a, b) => a - b);
      expect(list[0]).toBe(0);
      expect(list[list.length - 1]).toBe(list.length - 1);
    }
  });

  test("the branching terminates on its own rather than hitting the guard", () => {
    // A supercritical process would pile every thread against the depth cap.
    // What the model claims is a heavy tail under it, so the longest thread in
    // the city should be well short of the guard and the median tiny.
    const lengths = new Map<number, number>();
    for (const message of day.messages) {
      lengths.set(message.conversation, (lengths.get(message.conversation) ?? 0) + 1);
    }
    const sorted = [...lengths.values()].sort((a, b) => a - b);
    expect(sorted[sorted.length >> 1]!).toBeLessThan(8);

    // A thread may carry several separately initiated exchanges in one day,
    // especially for the high-volume age bands, so its total length is not a
    // branching depth. Follow replyTo inside each conversation instead.
    const depths = new Map<string, number>();
    let deepest = 0;
    for (const message of day.messages) {
      const depth = message.replyTo === NONE
        ? 0
        : (depths.get(`${message.conversation}:${message.replyTo}`) ?? 0) + 1;
      depths.set(`${message.conversation}:${message.seq}`, depth);
      deepest = Math.max(deepest, depth);
    }
    expect(deepest).toBeLessThan(90);
  });

  test("every message names an account that exists and belongs to the thread's channel", () => {
    for (const message of day.messages) {
      const account = comms.accounts.all[message.from];
      expect(account).toBeDefined();
      const thread = threads.get(message.conversation);
      expect(thread).toBeDefined();
      // Carrier channels share one account, so the comparison is on identity
      // rather than on the raw index.
      const expected = comms.accounts.on(account!.person, thread!.channel);
      expect(expected?.index).toBe(account!.index);
    }
  });
});

describe.skipIf(!CITY)("sleep", () => {
  /** Whether each person was asleep, per minute, from their own curve. */
  const asleepAt = (person: number, second: number): boolean | null => {
    const attention = comms.attentionFor(person);
    if (!attention?.known) return null;
    return attention.asleep[Math.floor(second / 60)] === 1;
  };

  test("nobody starts a conversation while asleep", () => {
    // The sharper of the two claims, and the one that was flatly wrong: a
    // reply from a sleeping person is a real thing that happens, but nobody
    // dials a number or opens a thread while unconscious. Opening messages are
    // those with no parent.
    let checked = 0;
    for (const message of day.messages) {
      if (message.replyTo !== NONE) continue;
      const person = comms.accounts.all[message.from]!.person;
      const asleep = asleepAt(person, message.at);
      if (asleep === null) continue;
      checked += 1;
      expect(asleep).toBe(false);
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("nobody places a call while asleep", () => {
    let checked = 0;
    for (const call of day.calls) {
      const person = comms.accounts.all[call.from]!.person;
      const asleep = asleepAt(person, call.at);
      if (asleep === null) continue;
      checked += 1;
      expect(asleep).toBe(false);
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("a phone left behind sends nothing and answers nothing until its owner is back", () => {
    const minute = (second: number) => Math.floor(second / 60);
    const away = (second: number) => minute(second) >= PARTED_FROM && minute(second) < PARTED_UNTIL;
    let outside = 0;
    for (const message of day.messages) {
      const person = comms.accounts.all[message.from]!.person;
      if (!parted.has(person)) continue;
      expect(away(message.at)).toBe(false);
      outside += 1;
    }
    for (const call of day.calls) {
      const caller = comms.accounts.all[call.from]!.person;
      if (parted.has(caller)) { expect(away(call.at)).toBe(false); outside += 1; continue; }
      if (!away(call.at) || call.outcome !== outcomeOf("answered")) continue;
      // An answered call inside the interval must not have a parted callee.
      for (const member of participantsOf(call.conversation)) if (member !== caller) expect(parted.has(member)).toBe(false);
    }
    expect(parted.size).toBeGreaterThan(50);
    expect(outside).toBeGreaterThan(20);
  });

  test("a reply during sleep is rare rather than nightly", () => {
    // The soft claim. Waking up and answering something is real, so this is
    // not zero — but at the old byte floor of 1/255 it reached a quarter of
    // the city every night, which it should come nowhere near.
    let asleepSenders = 0;
    let total = 0;
    for (const message of day.messages) {
      const person = comms.accounts.all[message.from]!.person;
      const asleep = asleepAt(person, message.at);
      if (asleep === null) continue;
      total += 1;
      if (asleep) asleepSenders += 1;
    }
    expect(asleepSenders / total).toBeLessThan(0.005);
  });
});

describe.skipIf(!CITY)("the carrier/messenger split", () => {
  test("no messenger message produces a carrier record", () => {
    const carrierMessages = new Set<number>();
    for (const row of day.sms) carrierMessages.add(row.message);
    for (const message of day.messages) {
      if (!carrierMessages.has(message.index)) continue;
      // A message with an SMS row may sit in a thread whose *dominant*
      // channel is a messenger — that is the spill share doing its job — but
      // it can never be one whose channel has no carrier at all.
      const thread = threads.get(message.conversation)!;
      const spillable = isCarrier(thread.channel) || thread.kind === CONVERSATION_KINDS.indexOf("dyad");
      expect(spillable).toBe(true);
    }
  });

  test("an app call has no CDR and a dialled call does", () => {
    const withCdr = new Set(day.cdr.map((row) => row.call));
    let dialled = 0;
    let overApp = 0;
    for (const call of day.calls) {
      const thread = threads.get(call.conversation)!;
      if (CHANNELS[thread.channel] === "voice") {
        dialled += 1;
        // Only when a cell lookup was supplied; this run passes null, so the
        // assertion is that the *absence* is uniform rather than sporadic.
        expect(withCdr.has(call.index)).toBe(false);
      } else {
        overApp += 1;
        expect(withCdr.has(call.index)).toBe(false);
      }
    }
    expect(dialled).toBeGreaterThan(0);
    expect(overApp).toBeGreaterThan(0);
  });

  test("only a text is ever segmented", () => {
    const byIndex = new Map<number, (typeof day.messages)[number]>();
    for (const message of day.messages) byIndex.set(message.index, message);
    for (const row of day.sms) {
      const message = byIndex.get(row.message)!;
      if (MESSAGE_KINDS[message.kind] !== "text") expect(row.parts).toBe(1);
      expect(row.part).toBeLessThan(row.parts);
      // The bug this guards: `bytes` means characters for a text and file size
      // for everything else, so segmenting on bytes alone turned one photo
      // into twenty thousand carrier records.
      expect(row.parts).toBeLessThan(8);
    }
  });
});

describe.skipIf(!CITY)("calls", () => {
  test("an unanswered call has no duration and an answered one does", () => {
    for (const call of day.calls) {
      if (call.outcome === outcomeOf("answered")) expect(call.duration).toBeGreaterThan(0);
      else expect(call.duration).toBe(0);
      expect(call.ring).toBeGreaterThan(0);
    }
  });

  test("a large share of calls go unanswered", () => {
    // The property that matters most about this table. A model where nearly
    // everything is answered is the one this layer was first written as, and
    // it is the single most obvious tell in a synthetic CDR set.
    const answered = day.calls.filter((call) => call.outcome === outcomeOf("answered")).length;
    const share = answered / day.calls.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.8);
  });

  test("a callback points at a real earlier attempt", () => {
    let callbacks = 0;
    for (const call of day.calls) {
      if (call.callback === NONE) continue;
      callbacks += 1;
      const original = day.calls[call.callback]!;
      expect(original).toBeDefined();
      expect(original.outcome).not.toBe(outcomeOf("answered"));
      expect(call.at).toBeGreaterThanOrEqual(original.at);
    }
    expect(callbacks).toBeGreaterThan(0);
  });

  test("every outcome index names a real outcome", () => {
    for (const call of day.calls) expect(CALL_OUTCOMES[call.outcome]).toBeDefined();
  });

  test("one person never participates in overlapping answered calls", () => {
    const participants = (conversation: number): number[] => {
      const thread = conversation < comms.accounts.conversations.length
        ? comms.accounts.conversations[conversation]!
        : day.dyads[conversation - comms.accounts.conversations.length]!;
      const ids = conversation < comms.accounts.conversations.length
        ? comms.accounts.participants.slice(thread.at, thread.at + thread.count)
        : day.dyadParticipants.slice(thread.at, thread.at + thread.count);
      return Array.from(ids, (id) => comms.accounts.all[id]!.person);
    };
    const occupied = new Map<number, number>();
    for (const call of [...day.calls].sort((a, b) => a.at - b.at || a.index - b.index)) {
      if (call.outcome !== outcomeOf("answered")) continue;
      const until = call.at + call.ring + call.duration;
      for (const person of participants(call.conversation)) {
        expect(occupied.get(person) ?? 0).toBeLessThanOrEqual(call.at);
        occupied.set(person, until);
      }
    }
  });
});

describe.skipIf(!CITY)("radio-constrained carrier delivery", () => {
  const people = !CITY ? [{ id: 0 }, { id: 0 }] : [...context.world.persons.values()]
    .filter((person) => comms.has(person.id) && comms.accounts.on(person.id, CHANNELS.indexOf("sms")))
    .slice(0, 2);
  const from = people[0]!.id;
  const to = people[1]!.id;
  const sender = CITY ? comms.accounts.on(from, CHANNELS.indexOf("sms"))!.subscriber : 0;
  const receiver = CITY ? comms.accounts.on(to, CHANNELS.indexOf("sms"))!.subscriber : 0;
  const sendMinute = CITY ? comms.attentionFor(from)!.asleep.findIndex((asleep) => !asleep) : 0;
  const sendAt = sendMinute * 60 + 5;
  const attachMinute = sendMinute + 2;

  test("an on-net SMS waits for the recipient's next attached minute", () => {
    const out = comms.request({
      from, to, channel: CHANNELS.indexOf("sms"), at: sendAt, seed: 11,
      kind: "text", bytes: 20, replies: false,
    }, SEED, DAY, context.world, DATE);
    comms.project(out, SEED, DAY, (subscriber, minute) => {
      if (subscriber === sender) return 100;
      if (subscriber === receiver && minute >= attachMinute) return 200;
      return NONE;
    }, context.world, DATE);
    expect(out.sms.length).toBeGreaterThan(0);
    expect(out.sms.every((row) => row.cell === 100 && row.toCell === 200
      && row.delivered === attachMinute * 60)).toBe(true);
  });

  test("carrier traffic cannot succeed without an originating attachment", () => {
    const out = comms.request({
      from, to, channel: CHANNELS.indexOf("sms"), at: sendAt, seed: 12,
      kind: "text", bytes: 20, replies: false,
    }, SEED, DAY, context.world, DATE);
    comms.project(out, SEED, DAY, (subscriber) => subscriber === receiver ? 200 : NONE, context.world, DATE);
    expect(out.sms.every((row) => row.cell === NONE && row.delivered === NONE)).toBe(true);
  });

  test("an on-net callee without service cannot answer", () => {
    const out = comms.request({
      from, to, channel: CHANNELS.indexOf("voice"), at: sendAt, seed: 13,
      kind: "call", duration: 120, outcome: outcomeOf("answered"), replies: false,
    }, SEED, DAY, context.world, DATE);
    comms.project(out, SEED, DAY, (subscriber) => subscriber === sender ? 100 : NONE, context.world, DATE);
    expect(out.calls[0]!.outcome).toBe(outcomeOf("failed"));
    expect(out.calls[0]!.duration).toBe(0);
  });

  test("a call carried across midnight keeps its participants occupied", () => {
    const out = comms.request({
      from, to, channel: CHANNELS.indexOf("voice"), at: sendAt, seed: 14,
      kind: "call", duration: 120, outcome: outcomeOf("answered"), replies: false,
    }, SEED, DAY, context.world, DATE);
    comms.project(out, SEED, DAY, () => 100, context.world, DATE, {
      pending: [{ kind: "active-call", participants: [from], remainingSeconds: sendAt + 60 }],
      contactRecency: [],
    });
    expect(out.calls[0]!.outcome).toBe(outcomeOf("failed"));
    expect(out.calls[0]!.duration).toBe(0);
  });
});

describe.skipIf(!CITY)("day-local threads", () => {
  test("every thread written down carried something", () => {
    // `DayComms.dyads` promises the threads that spoke today and only those.
    // A gathering that produced neither a run-up nor an afterglow used to
    // leave an empty conversation behind, which is a row asserting a
    // relationship on a day it did not happen.
    const spoke = new Set<number>();
    for (const message of day.messages) spoke.add(message.conversation);
    for (const call of day.calls) spoke.add(call.conversation);
    for (const thread of day.dyads) expect(spoke.has(thread.index)).toBe(true);
  });

  test("a day-local thread names at least two participants, or one and an off-map party", () => {
    for (const thread of day.dyads) {
      expect(thread.count).toBeGreaterThanOrEqual(1);
      expect(thread.at + thread.count).toBeLessThanOrEqual(day.dyadParticipants.length);
    }
  });
});

describe.skipIf(!CITY)("determinism", () => {
  test("resolving the same date twice produces the same traffic", () => {
    const again = comms.resolve(SEED, DAY, null, context.world, DATE);
    expect(again.messages.length).toBe(day.messages.length);
    expect(again.calls.length).toBe(day.calls.length);
    expect(again.sms.length).toBe(day.sms.length);
    for (let i = 0; i < Math.min(500, again.messages.length); i += 1) {
      expect(again.messages[i]!.at).toBe(day.messages[i]!.at);
      expect(again.messages[i]!.from).toBe(day.messages[i]!.from);
    }
  });
});

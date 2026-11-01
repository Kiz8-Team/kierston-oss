/**
 * Who is reachable on what, loaded from `accounts.py`'s output.
 *
 * The mirror of `network/subscribers.ts`, and it does the same job one layer
 * up: the radio layer resolves a person to the SIMs they carry, and this
 * resolves a person to the identities those SIMs bootstrapped.
 *
 * The one join worth stating
 * --------------------------
 * `accounts.json` carries an MSISDN on every account because that is the only
 * stable key the init stage and the runtime share — Python has no idea what
 * index the subscriber table will end up assigning. So the number is resolved
 * to a subscriber index here, once, and every record downstream carries the
 * index. An account whose number matches no subscription is a data fault and
 * is reported rather than dropped, for the reason `orphanSubscribers` gives:
 * the failure is invisible in every aggregate and silently shrinks the city.
 *
 * Why the lookup is (person, channel)
 * -----------------------------------
 * Exactly one account per person per platform, which is a simplification and
 * a deliberate one — a second Telegram account is the whole point of a second
 * Telegram account, and it is not modelled yet. Because it holds, a group
 * conversation can store person ids and resolve them to accounts on the
 * thread's own channel, which is what keeps the conversation table small
 * enough to hold the whole city's group memberships.
 */

import { join } from "node:path";
import { SIM_DATA_DIR } from "../world/index.ts";
import type { Subscribers } from "../network/index.ts";
import {
  CHANNELS, CONVERSATION_KINDS, EMERGENCY_HANDLE, EMERGENCY_PERSON, NONE, SMS, isCarrier,
  type Account, type Conversation,
} from "./types.ts";

interface AccountRow {
  channel: string;
  handle: string;
  display_name: string;
  line: string;
  created: number;
}

interface ConversationRow {
  kind: string;
  channel: string;
  focus: string;
  external_id: string;
  title: string | null;
  participants: number[];
  created: number;
}

interface AccountsFile {
  account_records: Record<string, AccountRow[]>;
  conversation_records: ConversationRow[];
  intercepts: Record<string, number>;
  targets: Record<string, number>;
}

export class Accounts {
  readonly all: readonly Account[];
  readonly conversations: readonly Conversation[];
  /** Participant account indices, indexed by `Conversation.at`/`count`. */
  readonly participants: Int32Array;
  /** Foci in the order they were first seen, so `Conversation.focus` can be read. */
  readonly foci: readonly string[];
  /**
   * Accounts whose number matched no subscription. Should be zero; a non-zero
   * count means `accounts.json` and `devices.json` were built against
   * different populations.
   */
  readonly orphans: number;

  private readonly byPerson = new Map<number, Account[]>();
  private readonly byPersonChannel = new Map<number, number>();
  private readonly threadsByPerson = new Map<number, number[]>();

  private constructor(
    all: Account[],
    conversations: Conversation[],
    participants: Int32Array,
    foci: string[],
    orphans: number,
  ) {
    this.all = all;
    this.conversations = conversations;
    this.participants = participants;
    this.foci = foci;
    this.orphans = orphans;

    for (const account of all) {
      const mine = this.byPerson.get(account.person);
      if (mine) mine.push(account);
      else this.byPerson.set(account.person, [account]);
      this.byPersonChannel.set(key(account.person, account.channel), account.index);
    }

    for (const thread of conversations) {
      for (let i = thread.at; i < thread.at + thread.count; i += 1) {
        const person = all[participants[i]!]!.person;
        const mine = this.threadsByPerson.get(person);
        if (mine) mine.push(thread.index);
        else this.threadsByPerson.set(person, [thread.index]);
      }
    }
  }

  static async open(subscribers: Subscribers): Promise<Accounts> {
    const file = (await Bun.file(join(SIM_DATA_DIR, "accounts.json")).json()) as AccountsFile;

    const byLine = new Map<string, number>();
    for (const subscriber of subscribers.all) byLine.set(subscriber.msisdn, subscriber.index);

    const all: Account[] = [];
    let orphans = 0;
    // Sorted by person so a second run of the same city assigns the same
    // account indices. Object key order out of a parsed JSON file is not
    // something an id packed into a binary can depend on.
    const people = Object.keys(file.account_records).map(Number).sort((a, b) => a - b);
    for (const person of people) {
      // Removing just the subscriber would turn stale accounts into off-net
      // endpoints, still reachable by calls and messages.
      if (subscribers.isIncarcerated(person)) continue;
      for (const row of file.account_records[String(person)]!) {
        const channel = CHANNELS.indexOf(row.channel as (typeof CHANNELS)[number]);
        if (channel < 0) throw new Error(`accounts.json names channel "${row.channel}", which is not in CHANNELS`);
        const subscriber = byLine.get(row.line);
        if (subscriber === undefined) orphans += 1;
        all.push({
          index: all.length,
          person,
          channel,
          handle: row.handle,
          displayName: row.display_name,
          subscriber: subscriber ?? NONE,
          created: row.created,
        });
      }
    }

    // The emergency line, appended after every real account so nothing that
    // was numbered before it moves. It is a carrier identity — a call to 911
    // is a voice bearer the network sets up like any other — with no
    // subscription behind it, because the answering point is not a handset.
    // `attempt` reads `subscriber === NONE` as off-net, which is what a CDR
    // for a call to a trunk line records.
    all.push({
      index: all.length,
      person: EMERGENCY_PERSON,
      channel: SMS,
      handle: EMERGENCY_HANDLE,
      displayName: "Emergency Services",
      subscriber: NONE,
      created: 0,
    });

    const lookup = new Map<number, number>();
    for (const account of all) lookup.set(key(account.person, account.channel), account.index);

    const foci: string[] = [];
    const conversations: Conversation[] = [];
    const participants: number[] = [];
    for (const row of file.conversation_records) {
      const channel = CHANNELS.indexOf(row.channel as (typeof CHANNELS)[number]);
      if (channel < 0) continue;
      const at = participants.length;
      for (const person of row.participants) {
        const account = lookup.get(key(person, channel));
        // A participant with no account on the thread's own channel cannot be
        // in it. `accounts.py` already filters for this, so a miss here means
        // the two files disagree and is worth failing on rather than pruning.
        if (account === undefined) continue;
        participants.push(account);
      }
      const count = participants.length - at;
      if (count < 2) {
        participants.length = at;
        continue;
      }
      let focus = foci.indexOf(row.focus);
      if (focus < 0) focus = foci.push(row.focus) - 1;
      conversations.push({
        index: conversations.length,
        channel,
        kind: Math.max(0, CONVERSATION_KINDS.indexOf(row.kind as (typeof CONVERSATION_KINDS)[number])),
        at,
        count,
        focus,
        externalId: row.external_id,
        title: row.title,
        created: row.created,
      });
    }

    return new Accounts(all, conversations, Int32Array.from(participants), foci, orphans);
  }

  forPerson(person: number): readonly Account[] {
    return this.byPerson.get(person) ?? [];
  }

  /**
   * This person's account on one channel, or null.
   *
   * Carrier channels are normalised to the one row that represents them.
   * `accounts.py` writes a single account for SMS, MMS and voice together,
   * because on the operator's network those are one identity and that
   * identity is the number — three rows would claim a person has three
   * handles when they have one.
   *
   * Without the normalisation every lookup for a voice call returned null and
   * two thirds of this city's calls were silently dropped before they were
   * ever recorded, which showed up as nothing worse than a low call rate.
   */
  on(person: number, channel: number): Account | null {
    const index = this.byPersonChannel.get(key(person, carrierIdentity(channel)));
    return index === undefined ? null : this.all[index]!;
  }

  /** Whether a person can be reached on a channel at all. */
  has(person: number, channel: number): boolean {
    return this.byPersonChannel.has(key(person, carrierIdentity(channel)));
  }

  /** Channels this person holds, as indices, in account order. */
  channels(person: number): number[] {
    return (this.byPerson.get(person) ?? []).map((account) => account.channel);
  }

  /** The group threads a person is in. Empty for most people. */
  threads(person: number): readonly number[] {
    return this.threadsByPerson.get(person) ?? [];
  }

  /** The account indices in one conversation. */
  members(thread: Conversation): Int32Array {
    return this.participants.subarray(thread.at, thread.at + thread.count);
  }

  get size(): number {
    return this.all.length;
  }
}

/**
 * One integer for (person, channel).
 *
 * Channels are a short fixed list, so four bits is plenty and the shift keeps
 * the key a small integer rather than a string. A Map of nine hundred thousand
 * string keys is the sort of thing that shows up as a second per simulated day.
 */
const key = (person: number, channel: number): number => person * 16 + channel;

/**
 * SMS, MMS and voice all resolve to the one carrier account.
 *
 * Kept as a function rather than inlined because it is a claim about the
 * data model — that the number is one identity across all three — and it has
 * to be applied identically everywhere a lookup happens.
 */
const carrierIdentity = (channel: number): number => (isCarrier(channel) ? SMS : channel);

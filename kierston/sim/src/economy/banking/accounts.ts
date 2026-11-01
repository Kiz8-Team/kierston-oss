/**
 * Everybody's financial position, read out of holdings.bin.
 *
 * The records are the init stage's work — `kierston/init/personal_records/
 * banking.py` decides who has which account, what is in it, and what each one
 * is for. Nothing here invents any of that. This module's whole job is to turn
 * five packed tables into one object per person that the payments API can
 * route against, and to do it without materialising 120,000 of them for a
 * simulation where most people buy nothing before lunch.
 *
 * So positions are built on demand and cached. The index behind that is the
 * packer's own `forPerson`, which costs one pass over each table the first
 * time anything asks.
 *
 * The decoder is shared with the viewer. `packages/kierston-records` reads
 * this container generically — the header carries the field list, so it
 * decodes tables it has never heard of — and a second copy of a binary format
 * is a second copy that can fall out of step with the packer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeRecords, type RecordSet, type RecordTable,
} from "kierston-records";
import { SIM_DATA_DIR } from "../../world/index.ts";

/**
 * One place money can sit. A bank account, or the cash in somebody's pocket —
 * the cash row is not a bank account and says so in every field that would
 * name one, but it debits down the same path, which is what gives an unbanked
 * person a spendable position at all.
 *
 * `balance` is the live number and it is DOLLARS, carrying cents. It is the
 * one mutable field here; everything else is what the generator wrote. Move it
 * through `settle` rather than assigning a raw sum — see index.ts for why a
 * float balance has to be rounded at every step.
 */
export interface Account {
  readonly number: string | null;
  readonly institution: string | null;
  readonly type: string;
  readonly purpose: string;
  /** Dollars, with cents. Mutated by the API as money moves. */
  balance: number;
  /** Can money leave this account at all. False for savings and reserve. */
  readonly spendable: boolean;
  /** Can a card be the thing that takes it. False for cash — no card exists. */
  readonly debitable: boolean;
  readonly receivesDeposits: boolean;
  /** Order the API tries accounts when the caller names none. Null never. */
  readonly spendRank: number | null;
}

export interface Card {
  readonly kind: "debit" | "credit";
  readonly lastFour: string;
  readonly network: string;
  readonly issuer: string | null;
  /** The deposit account a debit card draws on. Null on a credit card. */
  readonly account: string | null;
  readonly contactless: boolean;
  /** Credit only, both dollars. `balance` is what is drawn, not what is left. */
  limit: number;
  balance: number;
}

/** How readily this person reaches for cash, or for credit. Both are traits. */
export interface Profile {
  readonly cashPreference: number;
  readonly creditPreference: number;
  readonly contactless: boolean;
}

export interface IncomeStream {
  readonly source: string;
  readonly employer: string | null;
  readonly frequency: string;
  readonly payday: string;
  /** yyyy-mm-dd of the last payday on or before the reference date. */
  readonly anchor: string | null;
  readonly intervalDays: number | null;
  readonly method: string;
  /** The account it lands in, or null when it is paid in currency. */
  readonly account: string | null;
  readonly grossPerPeriod: number;
  readonly netPerPeriod: number;
}

export interface Position {
  readonly person: number;
  readonly accounts: Account[];
  readonly cards: Card[];
  readonly streams: IncomeStream[];
  readonly profile: Profile;
}

/**
 * The mutable part of one financial position.
 *
 * Everything omitted here is a record: account numbers, routing flags,
 * income rules and card identities do not change while the simulation runs.
 * Keeping the checkpoint to balances is what makes it both small and safe to
 * restore onto the canonical holdings file.
 */
export interface PositionState {
  person: number;
  accounts: number[];
  cards: { limit: number; balance: number }[];
}

/** The profile assumed for anybody with no payment_profile row — under-15s. */
const NO_PROFILE: Profile = {
  cashPreference: 1, creditPreference: 0, contactless: false,
};

function str(table: RecordTable, field: string, row: number): string | null {
  const value = table.value(field, row);
  return typeof value === "string" ? value : null;
}

function num(table: RecordTable, field: string, row: number): number {
  const value = table.value(field, row);
  return typeof value === "number" ? value : 0;
}

function flag(table: RecordTable, field: string, row: number): boolean {
  return table.value(field, row) === true;
}

export class Holdings {
  readonly records: RecordSet;
  private readonly accounts: RecordTable;
  private readonly streams: RecordTable;
  private readonly debit: RecordTable;
  private readonly credit: RecordTable;
  private readonly profiles: RecordTable;
  private readonly cache = new Map<number, Position>();

  constructor(records: RecordSet) {
    this.records = records;
    this.accounts = records.table("bank_account");
    this.streams = records.table("income_stream");
    this.debit = records.table("debit_card");
    this.credit = records.table("credit_card");
    this.profiles = records.table("payment_profile");
  }

  /**
   * One person's position, built once and then reused.
   *
   * Reused rather than rebuilt because the balances are live: hand out a fresh
   * copy on the second call and the first payment of the day would be
   * forgotten by the second.
   */
  position(person: number): Position {
    const cached = this.cache.get(person);
    if (cached) return cached;

    const accounts: Account[] = this.accounts.forPerson(person).map((row) => ({
      number: str(this.accounts, "number", row),
      institution: str(this.accounts, "institution", row),
      type: str(this.accounts, "type", row) ?? "checking",
      purpose: str(this.accounts, "purpose", row) ?? "everyday",
      balance: num(this.accounts, "balance", row),
      spendable: flag(this.accounts, "spendable", row),
      debitable: flag(this.accounts, "debitable", row),
      receivesDeposits: flag(this.accounts, "receives_deposits", row),
      spendRank: this.accounts.number("spend_rank", row),
    }));

    const cards: Card[] = [];
    for (const row of this.debit.forPerson(person)) {
      cards.push({
        kind: "debit",
        lastFour: str(this.debit, "last_four", row) ?? "0000",
        network: str(this.debit, "network", row) ?? "Visa",
        issuer: str(this.debit, "issuer", row),
        account: str(this.debit, "account", row),
        contactless: flag(this.debit, "contactless", row),
        limit: 0,
        balance: 0,
      });
    }
    for (const row of this.credit.forPerson(person)) {
      cards.push({
        kind: "credit",
        lastFour: str(this.credit, "last_four", row) ?? "0000",
        network: str(this.credit, "network", row) ?? "Visa",
        issuer: str(this.credit, "issuer", row),
        account: null,
        contactless: true,
        limit: num(this.credit, "limit", row),
        balance: num(this.credit, "balance", row),
      });
    }

    const streams: IncomeStream[] = this.streams.forPerson(person).map((row) => ({
      source: str(this.streams, "source", row) ?? "wages",
      employer: str(this.streams, "employer", row),
      frequency: str(this.streams, "frequency", row) ?? "biweekly",
      payday: str(this.streams, "payday", row) ?? "friday",
      anchor: str(this.streams, "anchor", row),
      intervalDays: this.streams.number("interval_days", row),
      method: str(this.streams, "method", row) ?? "direct_deposit",
      account: str(this.streams, "account", row),
      grossPerPeriod: num(this.streams, "gross_per_period", row),
      netPerPeriod: num(this.streams, "net_per_period", row),
    }));

    const [profileRow] = this.profiles.forPerson(person);
    const profile: Profile = profileRow === undefined ? NO_PROFILE : {
      cashPreference: num(this.profiles, "cash_preference", profileRow),
      creditPreference: num(this.profiles, "credit_preference", profileRow),
      contactless: flag(this.profiles, "contactless", profileRow),
    };

    const position: Position = { person, accounts, cards, streams, profile };
    this.cache.set(person, position);
    return position;
  }

  /** Snapshot every mutable balance future dates can observe. */
  state(persons: Iterable<number>): PositionState[] {
    const out: PositionState[] = [];
    for (const person of persons) {
      const position = this.position(person);
      out.push({
        person,
        accounts: position.accounts.map((account) => account.balance),
        cards: position.cards.map((card) => ({ limit: card.limit, balance: card.balance })),
      });
    }
    return out;
  }

  /** Restore a checkpoint onto positions loaded from the canonical records. */
  restore(state: readonly PositionState[]): void {
    for (const saved of state) {
      const position = this.position(saved.person);
      if (position.accounts.length !== saved.accounts.length
          || position.cards.length !== saved.cards.length) {
        throw new Error(`financial state for person ${saved.person} does not match holdings.bin`);
      }
      for (let index = 0; index < saved.accounts.length; index += 1) {
        position.accounts[index]!.balance = saved.accounts[index]!;
      }
      for (let index = 0; index < saved.cards.length; index += 1) {
        position.cards[index]!.limit = saved.cards[index]!.limit;
        position.cards[index]!.balance = saved.cards[index]!.balance;
      }
    }
  }
}

/** The cash row, which every resident 15 and over has exactly one of. */
export function cashAccount(position: Position): Account | undefined {
  return position.accounts.find((account) => account.type === "cash");
}

/** Where a deposit lands: the account set up to receive one, cash last. */
export function depositTarget(position: Position): Account | undefined {
  const banked = position.accounts
    .filter((account) => account.receivesDeposits && account.type !== "cash")
    .sort((a, b) => (a.spendRank ?? 99) - (b.spendRank ?? 99));
  return banked[0] ?? cashAccount(position);
}

export function loadHoldings(path?: string): Holdings {
  const bytes = readFileSync(path ?? join(SIM_DATA_DIR, "holdings.bin"));
  // Node hands back a Buffer that is a view into a larger pooled ArrayBuffer,
  // so the bytes have to be sliced out before the decoder reads offsets
  // against them. Passing bytes.buffer straight through reads someone else's
  // memory and fails the magic check on a good file.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Holdings(decodeRecords(buffer));
}

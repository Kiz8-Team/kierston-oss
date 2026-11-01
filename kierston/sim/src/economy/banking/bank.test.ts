/**
 * The invariants the payments API is supposed to guarantee.
 *
 * These run against the real holdings.bin rather than a fixture, because the
 * things worth checking are properties of the whole city — that no savings
 * account anywhere is ever debited, that a person's money is conserved across
 * a day of spending — and a hand-built fixture can only demonstrate that the
 * code does what it was written to do.
 */

import { describe, expect, test } from "bun:test";
import { Bank } from "./index.ts";
import { simDataPresent } from "../../world/index.ts";

/** Skipped, not failed, on a checkout without a built city. */
const CITY = simDataPresent("holdings.bin");
const bank = CITY ? Bank.load() : (null as unknown as Bank);

/** Everything a person is holding, cash included, in dollars. */
function onDeposit(person: number): number {
  return bank.position(person).accounts
    .reduce((total, account) => total + account.balance, 0);
}

/** To the cent, which is the precision every balance is settled at. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function drawn(person: number): number {
  return bank.position(person).cards
    .reduce((total, card) => total + card.balance, 0);
}

describe.skipIf(!CITY)("account flags", () => {
  test("no savings or reserve account is ever spendable", () => {
    const accounts = bank.position(0).accounts;
    expect(accounts.length).toBeGreaterThan(0);
    for (let person = 0; person < 20_000; person += 1) {
      for (const account of bank.position(person).accounts) {
        if (account.purpose === "savings" || account.purpose === "reserve") {
          expect(account.spendable).toBe(false);
          expect(account.debitable).toBe(false);
          expect(account.spendRank).toBeNull();
        }
      }
    }
  });

  test("the cash row is spendable but never debitable, and names no bank", () => {
    let seen = 0;
    for (let person = 0; person < 20_000; person += 1) {
      for (const account of bank.position(person).accounts) {
        if (account.type !== "cash") continue;
        seen += 1;
        expect(account.spendable).toBe(true);
        expect(account.debitable).toBe(false);
        expect(account.institution).toBeNull();
        expect(account.number).toBeNull();
      }
    }
    expect(seen).toBe(20_000);
  });
});

describe.skipIf(!CITY)("doPayment", () => {
  test("an approved payment moves exactly its amount and nothing else", () => {
    const person = 4242;
    const before = onDeposit(person) - drawn(person);
    const amount = 12.34;
    const tx = bank.doPayment({
      person, mcc: 5411, merchant: "Wegmans", amount, _timestamp: 600,
    });
    expect(tx.approved).toBe(true);
    // Rounded on both sides: the balance is settled to the cent on every
    // movement, so the comparison has to be too.
    expect(round(onDeposit(person) - drawn(person))).toBe(round(before - amount));
  });

  test("a savings account is never the account a payment came out of", () => {
    for (let person = 100; person < 6_000; person += 1) {
      const tx = bank.doPayment({
        person, mcc: 5411, merchant: "Wegmans", amount: 20, _timestamp: 700,
      });
      if (!tx.approved || !tx.account) continue;
      const account = bank.position(person).accounts
        .find((a) => a.number === tx.account);
      expect(account?.spendable).toBe(true);
    }
  });

  test("the same call on the same state routes the same way", () => {
    // Two banks rather than two calls on one. Calling twice does not test
    // determinism, it tests the ledger: the first payment moves the balance
    // the second one sees, so a person who paid cash at 12:00 can legitimately
    // be out of cash at 12:01. What must not vary is the decision given the
    // same state, which is why the API holds no seed — see routing.ts.
    // Both fresh. The shared `bank` has been spent from by the tests above,
    // and comparing a used balance sheet against an untouched one measures
    // those tests rather than this one.
    const one = Bank.load();
    const other = Bank.load();
    for (let person = 0; person < 2_000; person += 1) {
      const call = {
        person, mcc: 5813, merchant: "Brew Works", amount: 18,
        _timestamp: 1_200,
      };
      const a = one.doPayment(call);
      const b = other.doPayment(call);
      expect(a.approved).toBe(b.approved);
      expect(a.instrument).toBe(b.instrument);
      expect(a.account).toBe(b.account);
      expect(a.card).toBe(b.card);
    }
  });

  test("routing does not depend on how many calls came before it", () => {
    // The same person, the same purchase, reached after a different number of
    // unrelated transactions elsewhere in the city. A seeded generator on the
    // Bank would make these two disagree.
    const quiet = Bank.load();
    const busy = Bank.load();
    for (let other = 1; other < 3_000; other += 1) {
      busy.doPayment({
        person: other, mcc: 5411, merchant: "Wegmans", amount: 9,
        _timestamp: 600,
      });
    }
    const call = {
      person: 0, mcc: 5541, merchant: "Wawa", amount: 44, _timestamp: 900,
    };
    expect(quiet.doPayment(call).instrument)
      .toBe(busy.doPayment(call).instrument);
  });

  test("a zero or negative amount is refused rather than credited", () => {
    for (const amount of [0, -5]) {
      const tx = bank.doPayment({
        person: 77, mcc: 5411, merchant: "Wegmans", amount, _timestamp: 600,
      });
      expect(tx.approved).toBe(false);
      expect(tx.decline).toBe("invalid_amount");
    }
  });

  test("everybody has somewhere to spend from, including children", () => {
    for (let person = 0; person < 5_000; person += 1) {
      const tx = bank.doPayment({
        person, mcc: 5814, merchant: "Dunkin'", amount: 1, _timestamp: 540,
      });
      expect(tx.decline).not.toBe("no_position");
    }
  });
});

describe.skipIf(!CITY)("doTransferIn", () => {
  test("a transfer lands in a deposit account and adds its amount", () => {
    const person = 8_888;
    const before = onDeposit(person);
    const tx = bank.doTransferIn({
      person, sender: "Kierston Precision Works Inc.", amount: 1_500,
      _timestamp: 480, memo: "PAYROLL",
    });
    expect(tx.approved).toBe(true);
    expect(round(onDeposit(person))).toBe(round(before + 1_500));
  });

  test("somebody with no bank account is credited in cash", () => {
    let checked = 0;
    for (let person = 0; person < 30_000 && checked < 5; person += 1) {
      const accounts = bank.position(person).accounts;
      if (accounts.some((a) => a.type !== "cash")) continue;
      checked += 1;
      const tx = bank.doTransferIn({
        person, sender: "Hamilton Street Contracting LLC", amount: 900,
        _timestamp: 1_020,
      });
      expect(tx.approved).toBe(true);
      expect(tx.instrument).toBe("cash");
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe.skipIf(!CITY)("the ledger", () => {
  test("records every call, approved or not", () => {
    const before = bank.ledger.length;
    bank.doPayment({
      person: 12, mcc: 5411, merchant: "Wegmans", amount: 0.01, _timestamp: 600,
    });
    bank.doPayment({
      person: 12, mcc: 5411, merchant: "Wegmans", amount: -0.01, _timestamp: 600,
    });
    expect(bank.ledger.length).toBe(before + 2);
  });
});

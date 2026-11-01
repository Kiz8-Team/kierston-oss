/**
 * The financial position, which is the one part of holdings.bin that is not
 * one table at a time.
 *
 * Everything else in `records.ts` is deliberately blind to what it is reading:
 * a field is profiled by its declared kind, and a mortgage and a firearm come
 * out of the same twenty lines. That works because those tables are each a
 * self-contained answer — a row is a gun, and a gun means what it says.
 *
 * Banking is not like that. `banking.py` writes five tables that only mean
 * anything against each other, and the facts worth holding still live in the
 * joins between them:
 *
 *   - a deposit row is not necessarily a bank account. Carried currency is a
 *     row in the same table so the payments API can debit it down one path, so
 *     every count of accounts, institutions and balances has to exclude it —
 *     and the share of people whose *only* row is that pocket is the unbanked
 *     share, which is the single number in this file with a published
 *     counterpart to be wrong against.
 *   - a debit card names an account by number, and a stream names the account
 *     its money lands in. Those strings either resolve to an account the same
 *     person holds or the whole subsystem is quietly broken: a payment routes
 *     to an account nobody owns, and nothing in the generators asserts it.
 *   - the three flags on an account are what the API routes on. `spendable`
 *     false with a spend rank set, or a savings account a card can reach, is
 *     not a number moving by a percent — it is a grocery shop coming out of
 *     somebody's savings.
 *
 * So this module names fields and tables where it has to. It stays keyed on
 * what a table carries rather than on what it is called, which means it costs
 * nothing on the eighteen tables that carry none of it.
 */

import { Builder, Cat, Num, ageBand, moneyBand } from "../metrics.ts";
import type { Population } from "../population.ts";
import { RecordSet, Table, ordinalToDays, type Field } from "../tables.ts";

/**
 * Under this age a cash row is pocket money rather than a missing account.
 * banking.py gives every child a cash position on purpose, so that a payment
 * for one declines for want of funds and not for want of a record.
 */
const POCKET_MONEY_AGE = 15;

/**
 * How stale the oldest anchor may be, against the newest in the file.
 *
 * Every stream carries a dated anchor: the last time this person was actually
 * paid. The generator has no schedule longer than a month except the irregular
 * one, whose spacing tops out around two months, so the newest anchor in the
 * file is the reference date give or take a day and nothing should sit far
 * behind it. 120 days is loose enough that no legitimate schedule reaches it
 * and tight enough to catch the failure that matters — a phase computed off the
 * wrong month, which strands somebody a year from their last payday.
 */
const ANCHOR_STALE_DAYS = 120;

export function analyseBanking(b: Builder, set: RecordSet, pop: Population | null): void {
  const accounts = set.table("bank_account");
  if (!accounts || !accounts.has("balance")) return;

  const at = `records.${set.dataset}.banking`;
  const streams = set.table("income_stream");

  const position = deposits(b, at, accounts, pop);
  if (streams) income(b, at, streams, position, pop);
  cards(b, at, set, position);
  profiles(b, at, set.table("payment_profile"));
}

/**
 * What each person holds, for the two joins that name an account by number.
 *
 * The numbers are indexed per person and not globally, because that is how the
 * runtime resolves them: `bank/accounts.ts` builds one position per person and
 * a card finds its account inside that person's own list. Indexing globally
 * would make a number drawn twice across the city look like a card reaching
 * into a stranger's savings, which is a different bug from the one there is —
 * and the uniqueness of the numbers is checked separately, on its own line.
 */
interface Position {
  /** People holding a deposit account that is not their pocket. */
  banked: Set<number>;
  /** People whose only row in the table is the cash one. */
  cashOnly: Set<number>;
  /** Account numbers a card of this person's may draw on. */
  debitable: Map<number, Set<string>>;
  /** Account numbers a payment to this person may land in. */
  receiving: Map<number, Set<string>>;
}

function deposits(b: Builder, at: string, table: Table, pop: Population | null): Position {
  const type = table.field("type")!;
  const person = table.field("person")!;
  const balance = table.field("balance")!;
  const purpose = table.field("purpose");
  const spendable = table.field("spendable");
  const debitable = table.field("debitable");
  const receives = table.field("receives_deposits");
  const rank = table.field("spend_rank");
  const neobank = table.field("neobank");
  const institution = table.field("institution");
  const routing = table.field("routing");
  const number = table.field("number");

  const deposited = new Map<number, number>();
  const banked = new Set<number>();
  const cashRows = new Map<number, number>();
  const rankZero = new Set<number>();
  const branchless = new Set<number>();
  const seenNumbers = new Set<string>();
  const debitableNumbers = new Map<number, Set<string>>();
  const receivingNumbers = new Map<number, Set<string>>();
  const currency = new Num();
  const perPerson = new Num();
  const remember = (into: Map<number, Set<string>>, who: number, key: string) => {
    const held = into.get(who);
    if (held) held.add(key);
    else into.set(who, new Set([key]));
  };

  let cashCount = 0;
  let cash = 0;
  let deposits = 0;
  let namedCash = 0;
  let rankWrong = 0;
  let debitableUnspendable = 0;
  let duplicateNumber = 0;
  const named: string[] = [];
  const ranked: string[] = [];

  for (let row = 0; row < table.rows; row += 1) {
    const who = person.column[row];
    const amount = table.number(balance, row) ?? 0;
    const isCash = table.label(type, row) === "cash";
    const canSpend = spendable ? table.value(spendable, row) === true : null;
    const rankValue = rank ? table.number(rank, row) : null;

    if (isCash) {
      cashCount += 1;
      cash += amount;
      currency.push(amount);
      cashRows.set(who, (cashRows.get(who) ?? 0) + 1);
      // A cash row is not an account and says so in every field that would
      // name one. If it starts naming a bank, something is building it through
      // the account path.
      const wearing = [institution, routing, number]
        .filter((field): field is Field => field !== null)
        .filter((field) => table.label(field, row) !== null);
      if (wearing.length || table.value(neobank!, row) === true) {
        namedCash += 1;
        if (named.length < 5) named.push(`row ${row}, resident ${who}`);
      }
    } else {
      deposits += amount;
      banked.add(who);
      deposited.set(who, (deposited.get(who) ?? 0) + amount);
      if (neobank && table.value(neobank, row) === true) branchless.add(who);
      else branchless.delete(who);
      const key = number ? table.label(number, row) : null;
      if (key !== null) {
        if (seenNumbers.has(key)) duplicateNumber += 1;
        else seenNumbers.add(key);
        if (debitable && table.value(debitable, row) === true) {
          remember(debitableNumbers, who, key);
        }
        if (receives && table.value(receives, row) === true) {
          remember(receivingNumbers, who, key);
        }
      }
    }

    // Spendable and rank are one fact written twice: the rank is the order the
    // API tries accounts in, so an account it may not spend from has no place
    // in that order, and one it may has to have a place.
    if (canSpend !== null && rank) {
      if (canSpend !== (rankValue !== null)) {
        rankWrong += 1;
        if (ranked.length < 5) ranked.push(`row ${row}: spendable ${canSpend}, rank ${rankValue}`);
      }
      if (canSpend && rankValue === 0) rankZero.add(who);
    }
    if (canSpend === false && debitable && table.value(debitable, row) === true) {
      debitableUnspendable += 1;
    }
  }

  const cashOnly = new Set<number>();
  for (const who of cashRows.keys()) if (!banked.has(who)) cashOnly.add(who);
  for (const total of deposited.values()) perPerson.push(total);

  b.countAndShare(`${at}.deposit.accounts`, table.rows - cashCount, table.rows);
  b.countAndShare(`${at}.deposit.cashRows`, cashCount, table.rows);
  b.scalar(`${at}.deposit.total`, deposits, "money");
  b.scalar(`${at}.currency.total`, cash, "money");
  b.num(`${at}.deposit.perBankedPerson`, perPerson);
  b.num(`${at}.currency.perRow`, currency);
  if (purpose) {
    // The purpose is what decides whether money can leave, so what it is
    // holding matters as much as how many of each there are.
    const held = new Map<string, { sum: number; n: number }>();
    for (let row = 0; row < table.rows; row += 1) {
      const label = table.label(purpose, row) ?? "«null»";
      const cell = held.get(label) ?? { sum: 0, n: 0 };
      cell.sum += table.number(balance, row) ?? 0;
      cell.n += 1;
      held.set(label, cell);
    }
    for (const [label, cell] of [...held].sort()) {
      b.scalar(`${at}.deposit.total.by.purpose.${label}`, cell.sum, "money");
      b.scalar(`${at}.deposit.mean.by.purpose.${label}`, cell.sum / cell.n, "money");
    }
  }

  b.invariant(`${at}.cash.anonymous`,
    "a cash row names no institution, routing or account number", namedCash, cashCount, named);
  b.invariant(`${at}.spendRank.agreesWithSpendable`,
    "an account has a spend rank exactly when it can be spent from",
    rankWrong, table.rows, ranked);
  b.invariant(`${at}.debitable.isSpendable`,
    "no card can debit an account that cannot be spent from",
    debitableUnspendable, table.rows);
  b.invariant(`${at}.accountNumber.unique`,
    "an account number belongs to one account", duplicateNumber, table.rows);

  let withoutCash = 0;
  let extraCash = 0;
  for (const who of new Set([...banked, ...cashRows.keys()])) {
    const rows = cashRows.get(who) ?? 0;
    if (rows === 0) withoutCash += 1;
    if (rows > 1) extraCash += 1;
  }
  const people = banked.size + cashOnly.size;
  b.invariant(`${at}.cash.onePerPerson`,
    "everyone with a position carries exactly one cash row",
    withoutCash + extraCash, people);
  b.invariant(`${at}.spendRank.firstChoice`,
    "everyone with a bank account has one the API tries first",
    banked.size - [...rankZero].filter((who) => banked.has(who)).length, banked.size);

  if (pop) {
    // The unbanked share, which is the figure in this file with a published
    // counterpart — the FDIC's, graded steeply by income. A child holding
    // pocket money is not unbanked, so the denominator is the adults.
    let adults = 0;
    let unbanked = 0;
    const byIncome = new Map<string, [number, number]>();
    const byAge = new Map<string, [number, number]>();
    for (let id = 0; id < pop.residents; id += 1) {
      if (pop.age(id) < POCKET_MONEY_AGE) continue;
      adults += 1;
      const without = !banked.has(id);
      if (without) unbanked += 1;
      // The bottom band is named for what it holds rather than by `ageBand`,
      // whose 12-17 would be a band this cross only counts half of — the
      // under-15s were filtered out two lines up.
      const years = pop.age(id);
      for (const [into, key] of [
        [byIncome, moneyBand(pop.income(id))] as const,
        [byAge, years < 18 ? "15-17" : ageBand(years)] as const,
      ]) {
        const cell = into.get(key) ?? [0, 0];
        cell[0] += without ? 1 : 0;
        cell[1] += 1;
        into.set(key, cell);
      }
    }
    b.countAndShare(`${at}.unbanked`, unbanked, adults);
    b.countAndShare(`${at}.banked`, banked.size, adults);
    b.countAndShare(`${at}.neobankOnly`, branchless.size, adults);
    for (const [name, groups] of [["incomeBand", byIncome], ["ageBand", byAge]] as const) {
      for (const [label, [without, total]] of [...groups].sort()) {
        if (total < 50) continue;
        b.scalar(`${at}.unbanked.by.${name}.${label}`, without / total, "share");
      }
    }
    // Everyone in the city can pay for something, or the payments API answers
    // "no position" for a person who exists — which is what the cash row was
    // added to prevent.
    let withoutPosition = 0;
    for (let id = 0; id < pop.residents; id += 1) {
      if (!banked.has(id) && !cashOnly.has(id)) withoutPosition += 1;
    }
    b.invariant(`${at}.position.everyone`,
      "every resident holds somewhere money can come from", withoutPosition, pop.residents);
  }

  return {
    banked, cashOnly,
    debitable: debitableNumbers,
    receiving: receivingNumbers,
  };
}

/** What lands, when, and whether it lands anywhere that exists. */
function income(
  b: Builder, at: string, table: Table, position: Position, pop: Population | null,
): void {
  const person = table.field("person")!;
  const net = table.field("net_per_period");
  const gross = table.field("gross_per_period");
  const annual = table.field("gross_annual");
  const method = table.field("method");
  const account = table.field("account");
  const anchor = table.field("anchor");
  const interval = table.field("interval_days");

  const earners = new Set<number>();
  const perEarner = new Map<number, number>();
  const landing = new Num();
  let netOverGross = 0;
  let strayAccount = 0;
  let cashWithAccount = 0;
  let depositWithoutAccount = 0;
  const stray: string[] = [];

  // The newest anchor stands in for the reference date, which the packed
  // header does not carry. Every other anchor is measured against it.
  let newest = 0;
  if (anchor) {
    for (let row = 0; row < table.rows; row += 1) {
      const days = ordinalToDays(anchor.column[row]);
      if (days !== null && days > newest) newest = days;
    }
  }
  let stale = 0;
  const staleExamples: string[] = [];

  for (let row = 0; row < table.rows; row += 1) {
    const who = person.column[row];
    earners.add(who);
    perEarner.set(who, (perEarner.get(who) ?? 0) + 1);

    if (net && gross) {
      const took = table.number(net, row);
      const paid = table.number(gross, row);
      if (took !== null && paid !== null && took > paid + 0.005) netOverGross += 1;
    }

    if (net && interval) {
      // What actually arrives in a year, which is the figure a spending model
      // is calibrated against and is not any column in the table: an amount
      // per period says nothing until the period is known.
      const took = table.number(net, row);
      const days = table.number(interval, row);
      if (took !== null && days !== null && days > 0) landing.push((took * 365) / days);
    }

    if (method && account) {
      const how = table.label(method, row);
      const named = table.label(account, row);
      if (how === "cash" && named !== null) cashWithAccount += 1;
      if (how === "direct_deposit") {
        if (named === null) depositWithoutAccount += 1;
        else if (!position.receiving.get(who)?.has(named)) {
          // The account this money lands in has to be one the recipient holds
          // and one set up to receive a deposit. A stream pointing anywhere
          // else is a payroll run depositing into a savings account nobody can
          // spend from, or into a stranger's.
          strayAccount += 1;
          if (stray.length < 5) stray.push(`row ${row}: resident ${who} paid into ${named}`);
        }
      }
    }

    if (anchor && newest) {
      const days = ordinalToDays(anchor.column[row]);
      if (days !== null && newest - days > ANCHOR_STALE_DAYS) {
        stale += 1;
        if (staleExamples.length < 5) {
          staleExamples.push(`row ${row}: anchor ${anchor.column[row]}, ${newest - days} days back`);
        }
      }
    }
  }

  const counts = new Num();
  for (const count of perEarner.values()) counts.push(count);
  b.num(`${at}.income.streamsPerEarner`, counts);
  b.num(`${at}.income.netPerYear`, landing);
  if (annual) b.scalar(`${at}.income.grossAnnual.total`, sum(table, annual), "money");

  b.invariant(`${at}.income.netAtMostGross`,
    "net pay never exceeds the gross it was withheld from", netOverGross, table.rows);
  b.invariant(`${at}.income.depositAccountExists`,
    "a direct deposit names an account its own recipient holds", strayAccount, table.rows, stray);
  b.invariant(`${at}.income.cashNamesNoAccount`,
    "money paid in currency does not land in an account", cashWithAccount, table.rows);
  b.invariant(`${at}.income.depositNamesAnAccount`,
    "a direct deposit names the account it lands in", depositWithoutAccount, table.rows);
  if (anchor && newest) {
    b.invariant(`${at}.income.anchorRecent`,
      `every anchor is within ${ANCHOR_STALE_DAYS} days of the latest payday in the file`,
      stale, table.rows, staleExamples);
  }

  if (pop) {
    // Who has no income at all. Children and students should, dependents may,
    // and a working-age adult in the labour force should not — so this is
    // recorded by band rather than as one number that averages them together.
    const byAge = new Map<string, [number, number]>();
    let adults = 0;
    let without = 0;
    for (let id = 0; id < pop.residents; id += 1) {
      const none = !earners.has(id);
      const cell = byAge.get(ageBand(pop.age(id))) ?? [0, 0];
      cell[0] += none ? 1 : 0;
      cell[1] += 1;
      byAge.set(ageBand(pop.age(id)), cell);
      if (pop.age(id) < POCKET_MONEY_AGE) continue;
      adults += 1;
      if (none) without += 1;
    }
    b.countAndShare(`${at}.income.without`, without, adults);
    for (const [label, [none, total]] of [...byAge].sort()) {
      if (total >= 50) b.scalar(`${at}.income.without.by.ageBand.${label}`, none / total, "share");
    }
  }
}

/** Cards, and whether each one can reach the money it claims to. */
function cards(b: Builder, at: string, set: RecordSet, position: Position): void {
  const debit = set.table("debit_card");
  if (debit && debit.has("account")) {
    const person = debit.field("person")!;
    const account = debit.field("account")!;
    let stray = 0;
    const examples: string[] = [];
    for (let row = 0; row < debit.rows; row += 1) {
      const who = person.column[row];
      const named = debit.label(account, row);
      if (named === null || !position.debitable.get(who)?.has(named)) {
        stray += 1;
        if (examples.length < 5) {
          examples.push(`card ${row}: resident ${who} on account ${named}`);
        }
      }
    }
    b.invariant(`${at}.debitCard.accountExists`,
      "a debit card draws on an account its own holder holds and may debit",
      stray, debit.rows, examples);
  }

  const credit = set.table("credit_card");
  if (credit && credit.has("limit")) {
    // Credit is not deposits and is not counted with them, but how much of the
    // city's spending power is somebody else's money is worth one line.
    const limit = credit.field("limit")!;
    const balance = credit.field("balance")!;
    b.scalar(`${at}.credit.limit.total`, sum(credit, limit), "money");
    b.scalar(`${at}.credit.drawn.total`, sum(credit, balance), "money");
    const headroom = new Num();
    for (let row = 0; row < credit.rows; row += 1) {
      const ceiling = credit.number(limit, row);
      const owed = credit.number(balance, row);
      if (ceiling !== null && owed !== null) headroom.push(ceiling - owed);
    }
    b.num(`${at}.credit.headroom`, headroom);
  }
}

/** The two standing traits, which have to be probabilities. */
function profiles(b: Builder, at: string, table: Table | null): void {
  if (!table) return;
  let outside = 0;
  let checked = 0;
  const examples: string[] = [];
  const contactless = new Cat();
  for (const name of ["cash_preference", "credit_preference"]) {
    const field = table.field(name);
    if (!field) continue;
    for (let row = 0; row < table.rows; row += 1) {
      const value = table.number(field, row);
      if (value === null) continue;
      checked += 1;
      if (value < 0 || value > 1) {
        outside += 1;
        if (examples.length < 5) examples.push(`row ${row}: ${name} ${value}`);
      }
    }
  }
  if (checked) {
    b.invariant(`${at}.preference.isProbability`,
      "a payment preference is a probability between 0 and 1", outside, checked, examples);
  }
  const flag = table.field("contactless");
  if (flag) {
    for (let row = 0; row < table.rows; row += 1) {
      contactless.add(table.label(flag, row) ?? "«null»");
    }
    b.cat(`${at}.contactless`, contactless);
  }
}

function sum(table: Table, field: Field): number {
  let total = 0;
  for (let row = 0; row < table.rows; row += 1) total += table.number(field, row) ?? 0;
  return total;
}

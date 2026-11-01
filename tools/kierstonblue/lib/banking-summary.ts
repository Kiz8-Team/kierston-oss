import { humanise } from "./format";
import type { Population } from "./population";
import type { RecordSet, RecordTable } from "./records";
import type { Band } from "./summary";

/**
 * The city's financial position, in one pass over each banking table.
 *
 * The five tables banking.py writes are per-person rows, and read row by row
 * they answer questions nobody asked: this browser can already show you that
 * resident 41,208 holds $312.40 at Embassy Bank. What it could not show is
 * whether that is a normal amount to hold, how many people hold nothing at
 * all, and how much of the city is paid in currency — and those are the
 * numbers that say whether the generator's calibration is right.
 *
 * So everything here is a whole-population aggregate, and every one of them is
 * a figure with a published counterpart to check against: the FDIC's unbanked
 * share, the SCF's transaction-account medians, the Fed's payment diary. A
 * tile that reads 34% unbanked is not a curiosity, it is a bug report.
 *
 * The cash row is the trap in every count. banking.py puts carried currency in
 * the deposit table so the payments API can debit it down one path, which
 * means `bank_account` is not a table of bank accounts — it is a table of
 * places money sits, and one row per person is somebody's pocket. Anything
 * counting accounts, institutions or balances here excludes `type == "cash"`
 * and counts it separately. Getting that wrong doubles the account count and
 * halves the median balance.
 */

export interface BankingSummary {
  /** People holding at least one row in any banking table. */
  covered: number;
  /** People with somewhere other than their pocket to keep money. */
  banked: number;
  /**
   * People aged 15 and over whose only position is cash. Under-15s carry
   * pocket money by design and are not unbanked, they are children.
   */
  unbanked: number;
  /** Of the banked, the ones whose only account is an app with no branch. */
  neobankOnly: number;
  accounts: number;
  /** Deposit accounts, cash excluded, summed over their balances. */
  deposits: number;
  /** Currency in pockets across the city. */
  currency: number;
  medianEveryday: number;
  medianCash: number;
  overdrawn: number;

  streams: number;
  /** People with no income stream at all — children, dependents, students. */
  withoutIncome: number;
  paidInCash: number;
  medianNet: number;
  /** Net pay per period summed to an annual figure, over every stream. */
  netAnnual: number;

  creditCards: number;
  debitCards: number;
  creditLimit: number;
  creditDrawn: number;
  /** People holding at least one credit card. */
  cardholders: number;

  purposes: Band[];
  institutions: Band[];
  balances: Band[];
  cashHeld: Band[];
  sources: Band[];
  frequencies: Band[];
  paydays: Band[];
  methods: Band[];
  cashPreference: Band[];
  note: string;
}

/** The tables this page reads. A holdings file without them predates banking. */
export const BANKING_TABLES = [
  "bank_account", "income_stream", "credit_card", "debit_card",
  "payment_profile",
] as const;

const BALANCE_BANDS = [
  [-Infinity, 0, "overdrawn"],
  [0, 100, "under $100"],
  [100, 500, "$100–500"],
  [500, 1_000, "$500–1k"],
  [1_000, 2_500, "$1–2.5k"],
  [2_500, 10_000, "$2.5–10k"],
  [10_000, 50_000, "$10–50k"],
  [50_000, Infinity, "$50k+"],
] as const;

const CASH_BANDS = [
  [0, 5, "under $5"],
  [5, 20, "$5–20"],
  [20, 50, "$20–50"],
  [50, 100, "$50–100"],
  [100, 300, "$100–300"],
  [300, 1_000, "$300–1k"],
  [1_000, Infinity, "$1k+"],
] as const;

const PREFERENCE_BANDS = [
  [0, 0.05, "under 5%"],
  [0.05, 0.15, "5–15%"],
  [0.15, 0.3, "15–30%"],
  [0.3, 0.5, "30–50%"],
  [0.5, 0.75, "50–75%"],
  [0.75, 1.01, "75%+"],
] as const;

/** Under this age a cash row is pocket money, not an absent bank account. */
const POCKET_MONEY_AGE = 15;

type Bounded = readonly (readonly [number, number, string])[];

function bandsOf(spec: Bounded): Band[] {
  return spec.map(([, , label]) => ({ label, value: 0 }));
}

function bump(spec: Bounded, bands: Band[], value: number) {
  const index = spec.findIndex(([low, high]) => value >= low && value < high);
  if (index !== -1) bands[index].value += 1;
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = values.sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Labels a bar chart can carry, where `humanise` alone gives one it cannot.
 *
 * The bar list's label column is a bit over eight characters wide, so the two
 * vocabularies that write themselves out at length get shortened here rather
 * than wrapping onto three lines each. Everything else goes through `humanise`
 * as it stands, which is the point of naming enum values in snake_case.
 */
const PAYDAY_LABEL: Record<string, string> = {
  ss_wednesday_2: "SS 2nd Wed", ss_wednesday_3: "SS 3rd Wed",
  ss_wednesday_4: "SS 4th Wed", "1st_and_15th": "1st and 15th",
  "15th_and_last": "15th and last", last_day: "last of month",
};

/** A bank's name without the part that is the same on every bank's name. */
function shorten(institution: string): string {
  return institution
    .replace(/,? N\.A\.$/, "")
    .replace(/Federal Credit Union/, "FCU")
    .replace(/Credit Union/, "CU");
}

/** An enum column's counts, as bands in descending order. */
function mix(
  table: RecordTable,
  field: string,
  limit = 40,
  label: (value: string) => string = humanise,
): Band[] {
  if (!table.has(field)) return [];
  return table
    .distinct(field)
    .slice(0, limit)
    .map((entry) => ({ label: label(entry.value), value: entry.count }));
}

/** A resident's age, whichever of the two person column sets they live in. */
function ageOf(population: Population, person: number): number {
  const quarters = person >= population.counts.persons;
  return quarters
    ? population.a.quarters_age[person - population.counts.persons]
    : population.a.person_age[person];
}

/**
 * Whether a holdings file carries the banking tables at all.
 *
 * A sim_data built before banking.py existed has a `bank_account` table with
 * no balance in it and no income streams whatsoever, and every figure below
 * would come back zero without saying why. The page checks this first and asks
 * for a rebuild instead.
 */
export function hasBanking(records: RecordSet): boolean {
  const names = new Set(records.tableNames);
  return BANKING_TABLES.every((table) => names.has(table))
    && records.table("bank_account").has("balance");
}

export function summariseBanking(
  records: RecordSet,
  population: Population,
): BankingSummary {
  const accountsTable = records.table("bank_account");
  const streamsTable = records.table("income_stream");
  const credit = records.table("credit_card");
  const debit = records.table("debit_card");
  const profiles = records.table("payment_profile");

  // ---- Deposits, and the pocket that is not one ---------------------------
  const balances = bandsOf(BALANCE_BANDS);
  const cashHeld = bandsOf(CASH_BANDS);
  const everydayBalances: number[] = [];
  const cashBalances: number[] = [];
  const banked = new Set<number>();
  const branchless = new Set<number>();
  const holders = new Set<number>();
  let accounts = 0;
  let deposits = 0;
  let currency = 0;
  let overdrawn = 0;

  const cashCode = accountsTable.labels("type").indexOf("cash");
  const everydayCode = accountsTable.labels("purpose").indexOf("everyday");
  const type = accountsTable.column("type");
  const purpose = accountsTable.column("purpose");
  const person = accountsTable.column("person");
  const balance = accountsTable.column("balance");
  const neobank = accountsTable.column("neobank");

  for (let row = 0; row < accountsTable.rows; row += 1) {
    const who = person[row];
    const amount = balance[row];
    holders.add(who);
    if (type[row] === cashCode) {
      currency += amount;
      cashBalances.push(amount);
      bump(CASH_BANDS, cashHeld, amount);
      continue;
    }
    accounts += 1;
    deposits += amount;
    if (amount < 0) overdrawn += 1;
    bump(BALANCE_BANDS, balances, amount);
    if (purpose[row] === everydayCode) everydayBalances.push(amount);
    if (banked.has(who)) {
      // A second, branch-having account takes them off the neobank-only list.
      if (neobank[row] !== 1) branchless.delete(who);
    } else {
      banked.add(who);
      if (neobank[row] === 1) branchless.add(who);
    }
  }

  let unbanked = 0;
  for (const who of holders) {
    if (banked.has(who)) continue;
    if (ageOf(population, who) >= POCKET_MONEY_AGE) unbanked += 1;
  }

  // ---- What lands, and how -----------------------------------------------
  const nets: number[] = [];
  let netAnnual = 0;
  let paidInCash = 0;
  const earners = new Set<number>();
  const streamPerson = streamsTable.column("person");
  const net = streamsTable.column("net_per_period");
  const interval = streamsTable.column("interval_days");
  const method = streamsTable.column("method");
  const cashMethod = streamsTable.labels("method").indexOf("cash");

  for (let row = 0; row < streamsTable.rows; row += 1) {
    earners.add(streamPerson[row]);
    const amount = net[row];
    nets.push(amount);
    // interval_days is 0 on an irregular stream, whose spacing was drawn but
    // not written; those are left out of the annual total rather than divided
    // by zero into infinity.
    if (interval[row] > 0) netAnnual += (amount * 365) / interval[row];
    if (method[row] === cashMethod) paidInCash += 1;
  }

  // ---- Revolving credit ---------------------------------------------------
  let creditLimit = 0;
  let creditDrawn = 0;
  const cardholders = new Set<number>();
  const limitColumn = credit.column("limit");
  const drawnColumn = credit.column("balance");
  const cardPerson = credit.column("person");
  for (let row = 0; row < credit.rows; row += 1) {
    creditLimit += limitColumn[row];
    creditDrawn += drawnColumn[row];
    cardholders.add(cardPerson[row]);
  }

  // ---- Habits -------------------------------------------------------------
  const cashPreference = bandsOf(PREFERENCE_BANDS);
  const preference = profiles.column("cash_preference");
  for (let row = 0; row < profiles.rows; row += 1) {
    bump(PREFERENCE_BANDS, cashPreference, preference[row]);
  }

  const institutions = mix(accountsTable, "institution", 10, shorten);

  return {
    covered: holders.size,
    banked: banked.size,
    unbanked,
    neobankOnly: branchless.size,
    accounts,
    deposits,
    currency,
    medianEveryday: median(everydayBalances),
    medianCash: median(cashBalances),
    overdrawn,

    streams: streamsTable.rows,
    withoutIncome: holders.size - earners.size,
    paidInCash,
    medianNet: median(nets),
    netAnnual,

    creditCards: credit.rows,
    debitCards: debit.rows,
    creditLimit,
    creditDrawn,
    cardholders: cardholders.size,

    purposes: mix(accountsTable, "purpose"),
    institutions,
    balances,
    cashHeld,
    sources: mix(streamsTable, "source"),
    frequencies: mix(streamsTable, "frequency"),
    paydays: mix(streamsTable, "payday", 12,
      (value) => PAYDAY_LABEL[value] ?? humanise(value)),
    methods: mix(streamsTable, "method"),
    cashPreference,
    note: `${records.meta.source} · seed ${records.meta.seed}`
      + (records.meta.today ? ` · as of ${records.meta.today}` : ""),
  };
}

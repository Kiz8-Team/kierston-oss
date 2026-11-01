/**
 * The money that leaves whether or not anybody leaves the house.
 *
 * `spend.ts` prices the day a person had. This prices the month they are in.
 * Rent, the electric, the phone, the car loan, the streaming subscription
 * nobody cancelled — none of them is a visit, none of them has a venue, and
 * none of them would ever be raised by a pass over a scheduled day. They are
 * the other two thirds of what a card and an account actually see: the Fed's
 * Diary of Consumer Payment Choice counts 47.2 payments a person a month, of
 * which about 10 are bills, against the 28.3 in-person purchases `spend.ts`
 * is answerable to.
 *
 * The schedule is a record, not a state machine
 * ---------------------------------------------
 * `init/personal_records/recurring_spending.py` writes one row per commitment:
 * an amount, a cadence, a day, a payee and a way of paying. Nothing in this
 * module remembers whether September's rent was paid, because nothing has to —
 * whether today is a day that rule fires is arithmetic on today's date, in
 * exactly the way `bank/payroll.ts` projects a payday out of a frequency and
 * an anchor. That is what keeps a day independent of the days before it, which
 * is what lets `--export-day` plan one date without simulating the year up to
 * it.
 *
 * Household and personal, and why the split is real
 * -------------------------------------------------
 * A household charge belongs to the dwelling. Anyone in it old enough to hold
 * an account can pay one, and in a real household they do — one partner has
 * the rent on autopay and the other has the gas, and the electric moves
 * between them when somebody's card expires. The record carries a payer, an
 * alternate and how the two divide it; this module resolves that per month,
 * deterministically, from the household and the bill alone. It does not look
 * at the person asking, which is the property that matters: two people in the
 * same household planned in two different processes reach the same answer
 * about who pays the rent, and neither of them has to know the other exists.
 *
 * A personal charge belongs to a person and follows them. A lodger's phone
 * plan is theirs whoever else lives there.
 *
 * Children pay nothing here. The generator only ever names an adult as a payer
 * and only writes personal rows against people old enough to hold the thing —
 * a thirteen-year-old has a phone on somebody's plan, not a plan.
 *
 * On the amounts
 * --------------
 * They come off the ACS housing record where there is one: RNTP is the rent,
 * ELEP the electricity, MRGP the mortgage payment. What this module adds is
 * the two things a yearly average cannot carry. Seasonality, because a gas
 * bill in January is six times the same house's July bill and the survey
 * reports the mean of the two; the curves are in the packed file's header, are
 * normalised to a mean of exactly 1.0, and so redistribute the surveyed total
 * without inflating it. And month-to-month noise, as a log-normal whose median
 * is the stated amount, because a water bill that is $134.24 every quarter for
 * a decade is not a water bill.
 *
 * The one amount that is a rule rather than a number is the credit card
 * payment, and it has to be: it is a share of a balance this simulation is
 * itself moving, so the row carries the share and the floor and the live
 * balance is read off the card at the minute it is paid.
 */

import { depositTarget } from "./banking/accounts.ts";
import { lastPayday, payerFor, type Bank, type Position } from "./banking/index.ts";
import { SIM_DATA_DIR, type Person, type World } from "../world/index.ts";
import { LAYER, isoDate, mix, Rng, stream, weekday } from "../shared/index.ts";
import type { Charge, Deposit } from "./spend.ts";
import type { Day } from "../scheduler/index.ts";
import {
  decodeRecords, type RecordSet, type RecordTable,
} from "kierston-records";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every kind of commitment the generator can write.
 *
 * A union rather than a bare string because `spend.ts` groups a day's money by
 * reason and a report that silently gains a category from a typo is worse than
 * one that fails. `Bills.load` checks the file's own vocabulary against this
 * list and says so if the two have drifted apart — which is what happens when
 * a kind is added in Python and nowhere else.
 */
export const BILL_KINDS = [
  "rent", "mortgage", "second_mortgage", "mobile_home_fee", "hoa",
  "property_tax", "home_insurance",
  "electricity", "gas", "water", "trash", "heating_oil",
  "internet", "television", "mobile",
  "childcare",
  "student_loan", "auto_loan", "credit_card",
  "auto_insurance", "life_insurance", "health_premium",
  "streaming", "music", "gym", "news", "storage", "charity", "registration",
] as const;

export type BillKind = (typeof BILL_KINDS)[number];

export type Frequency =
  | "weekly" | "monthly" | "quarterly" | "semiannual" | "annual";

export type Method =
  | "autopay_ach" | "autopay_card" | "manual_ach" | "manual_card" | "check";

/** One commitment, as the record file states it. */
export interface Rule {
  readonly kind: BillKind;
  readonly biller: string;
  readonly mcc: number;
  /** Dollars. On a card payment this is the floor, not the payment. */
  readonly amount: number;
  readonly frequency: Frequency;
  /** Day of the month, or day of the week on a weekly rule. */
  readonly dueDay: number;
  /** Which month a non-monthly rule is phased from. */
  readonly anchorMonth: number;
  readonly seasonal: string;
  /** σ of the log-normal wobble around `amount`. Zero on a fixed bill. */
  readonly variance: number;
  readonly method: Method;
  /** Whether the amount came off a survey answer or out of a draw. */
  readonly source: string;
  /** yyyymmdd after which the rule has run out — a loan's last payment. */
  readonly until: number;
}

export interface HouseholdRule extends Rule {
  readonly household: number;
  readonly payer: number;
  readonly altPayer: number | null;
  readonly split: "sole" | "alternate" | "shared";
  readonly splitShare: number;
  /** Whose debt this is, where it is one person's. Not who pays it. */
  readonly forPerson: number | null;
  /** Card payments only: which card, and what share of its live balance. */
  readonly card: string | null;
  readonly shareOfBalance: number;
}

export interface PersonalRule extends Rule {
  readonly person: number;
}

/** A charge that settles a card rather than buying anything. */
export interface BillCharge extends Charge {
  /** The last four of the credit card this pays down, where it is one. */
  readonly settles?: string;
}

const DAY_MINUTES = 24 * 60;

/**
 * When in the day each way of paying lands.
 *
 * Not decoration, and not one window per method: the first version posted
 * every direct debit in the city between 03:00 and 07:00 and every manual
 * payment between 17:00 and 23:00, whoever was paying and whatever they were
 * doing, so a bank's day was two slabs and a gap. What actually decides the
 * minute depends on who acts:
 *
 *   autopay_ach   the biller. It submits its debits as a batch, at the same
 *                 point in the clearing day every time, so all of one
 *                 landlord's tenants post together at that landlord's minute.
 *                 Most billers use the overnight file; some the same-day ones.
 *   autopay_card  the mandate. A subscription renews at about the minute it
 *                 was taken out, which is any minute at all and the same one
 *                 every month.
 *   manual        the payer, who has to be awake and able to sit down to it —
 *                 read off their planned day, weighted toward the evening.
 *   check         the payee, who deposits it during banking hours.
 */
const ACH_BATCHES: readonly { window: [number, number]; weight: number }[] = [
  { window: [0, 6 * 60], weight: 0.55 },
  { window: [8 * 60 + 30, 10 * 60 + 30], weight: 0.2 },
  { window: [12 * 60 + 30, 14 * 60 + 30], weight: 0.15 },
  { window: [16 * 60 + 30, 18 * 60], weight: 0.1 },
];
const CHECK_HOURS: [number, number] = [9 * 60, 17 * 60];

/**
 * How likely somebody paying a bill themselves is to be doing it at each hour,
 * given they are free to. The planned day then removes the hours they are not.
 */
const PAY_HOURS = [
  0.5, 0.1, 0, 0, 0, 0.1, 0.8, 2, 3, 3.5, 3.5, 3.5,
  4.5, 4, 3, 3, 3, 4, 6, 8, 9, 8, 5, 2,
];
/** How much of a person's willingness survives while they are at work. */
const AT_WORK = 0.25;
const PAY_STEP = 5;

/**
 * How many days early or late a person paying by hand settles a bill, and how
 * often. A rent due on the 1st is not paid by every tenant on the 1st: some
 * pay on the last day of the month before, some within the grace period after.
 * Autopay has no such spread — that is what autopay is.
 */
const PAY_OFFSETS = [-3, -2, -1, 0, 1, 2, 3, 4] as const;
const PAY_OFFSET_WEIGHTS = [4, 9, 18, 42, 13, 7, 4, 3];

function str(table: RecordTable, field: string, row: number): string {
  const value = table.value(field, row);
  return typeof value === "string" ? value : "";
}

function num(table: RecordTable, field: string, row: number): number {
  const value = table.value(field, row);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readRule(table: RecordTable, row: number): Rule {
  return {
    kind: str(table, "kind", row) as BillKind,
    biller: str(table, "biller", row),
    mcc: num(table, "mcc", row),
    amount: num(table, "amount", row),
    frequency: (str(table, "frequency", row) || "monthly") as Frequency,
    dueDay: num(table, "due_day", row) || 1,
    anchorMonth: num(table, "anchor_month", row) || 1,
    seasonal: str(table, "seasonal", row) || "none",
    variance: num(table, "variance", row),
    method: (str(table, "method", row) || "manual_ach") as Method,
    source: str(table, "source", row),
    until: num(table, "until", row),
  };
}

/**
 * The city's schedule, read out of recurring_spending.bin.
 *
 * Built per person and per household on demand and cached, for the reason
 * `accounts.ts` gives: most of the city is not paying a bill on any given
 * morning, and materialising 46,000 households' worth of rules to find out is
 * the expensive way to learn it.
 */
export class Bills {
  readonly records: RecordSet;
  /** The twelve-month curves, by name, exactly as the generator normalised them. */
  readonly seasonal: Record<string, number[]>;
  private readonly household: RecordTable;
  private readonly personal: RecordTable;
  private readonly householdCache = new Map<number, HouseholdRule[]>();
  private readonly personalCache = new Map<number, PersonalRule[]>();

  constructor(records: RecordSet) {
    this.records = records;
    this.household = records.table("household_charge");
    this.personal = records.table("personal_charge");
    this.seasonal = (records.meta as unknown as {
      seasonal?: Record<string, number[]>;
    }).seasonal ?? { none: new Array(12).fill(1) };

    // The vocabulary check. A kind added to the Python and not to BILL_KINDS
    // would arrive here as a string that types as BillKind and groups as its
    // own category in every report, which is the kind of drift that is only
    // ever noticed months later.
    // `labels` is the field's interned vocabulary — thirty-odd strings — so
    // this costs nothing. Scanning the 900,000 rows to collect the same set
    // was the first version and put a visible pause on every load.
    const known = new Set<string>(BILL_KINDS);
    const strange = [
      ...this.household.labels("kind"), ...this.personal.labels("kind"),
    ].filter((kind) => kind && !known.has(kind));
    if (strange.length) {
      throw new Error(
        `recurring_spending.bin has kinds bills.ts does not know: ${strange.join(", ")}`
        + " — add them to BILL_KINDS");
    }
  }

  static load(path?: string): Bills {
    const bytes = readFileSync(path ?? join(SIM_DATA_DIR, "recurring_spending.bin"));
    // Sliced for the same reason `loadHoldings` slices: Node hands back a view
    // into a pooled ArrayBuffer, and decoding against the pool reads somebody
    // else's memory.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Bills(decodeRecords(buffer));
  }

  forHousehold(household: number): HouseholdRule[] {
    const cached = this.householdCache.get(household);
    if (cached) return cached;
    const table = this.household;
    const rows = table.groupedBy("household").get(household) ?? [];
    const rules = rows.map((row): HouseholdRule => ({
      ...readRule(table, row),
      household,
      payer: table.number("payer", row) ?? -1,
      altPayer: table.number("alt_payer", row),
      split: (str(table, "split", row) || "sole") as HouseholdRule["split"],
      splitShare: num(table, "split_share", row),
      forPerson: table.number("for_person", row),
      card: str(table, "card", row) || null,
      shareOfBalance: num(table, "share_of_balance", row),
    }));
    this.householdCache.set(household, rules);
    return rules;
  }

  forPerson(person: number): PersonalRule[] {
    const cached = this.personalCache.get(person);
    if (cached) return cached;
    const table = this.personal;
    const rules = table.forPerson(person).map((row): PersonalRule => ({
      ...readRule(table, row), person,
    }));
    this.personalCache.set(person, rules);
    return rules;
  }
}

/**
 * yyyymmdd, the integer the record file dates in.
 *
 * Local calendar components, like `isoDate` and `dayNumber` in time.ts and for
 * the same reason: a `Date` reaches this module as local midnight, and reading
 * UTC parts off it moves the date by a day for every process running west of
 * Greenwich — which would silently bill the rent on the 31st.
 */
function ordinal(date: Date): number {
  return date.getFullYear() * 10000
    + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Does this rule fire on this date.
 *
 * The cadences are deliberately few and all of them are phase plus period. A
 * monthly rule names a day; a quarterly, semiannual or annual one names a day
 * and the month it is counted from, and fires when the months since that
 * anchor divide. Weekly names a weekday instead of a day of the month, which
 * is the one case where `dueDay` means something else and the only cadence
 * childcare is ever billed on.
 *
 * No rule is written past the 28th, so nothing here has to decide what the
 * 31st means in February — a bill that vanished for one month a year would be
 * a very quiet way to lose 3% of the city's rent.
 */
export function dueOn(rule: Rule, date: Date): boolean {
  if (rule.until && ordinal(date) > rule.until) return false;

  const month = date.getMonth() + 1;
  const day = date.getDate();

  switch (rule.frequency) {
    // The one cadence where `dueDay` is a weekday and not a day of the month,
    // in `weekday`'s own terms — 0 is Monday, as everywhere else here.
    case "weekly":
      return weekday(date) === rule.dueDay;
    case "monthly":
      return day === rule.dueDay;
    case "quarterly":
      return day === rule.dueDay && (month - rule.anchorMonth + 12) % 3 === 0;
    case "semiannual":
      return day === rule.dueDay && (month - rule.anchorMonth + 12) % 6 === 0;
    case "annual":
      return day === rule.dueDay && month === rule.anchorMonth;
    default:
      return false;
  }
}

/**
 * What the bill comes to this month.
 *
 * Seasonality first, then the wobble. The wobble is log-normal rather than
 * additive so it cannot produce a negative bill and so the median stays where
 * the survey put it — an additive noise on a $12 subscription and on a $1,400
 * rent would have to be two different noises.
 */
function amountFor(
  rule: Rule, curves: Record<string, number[]>, date: Date, rng: Rng,
): number {
  const curve = curves[rule.seasonal] ?? curves.none;
  const seasonal = curve?.[date.getMonth()] ?? 1;
  const noise = rule.variance > 0 ? Math.exp(rng.gauss(0, rule.variance)) : 1;
  return Math.round(rule.amount * seasonal * noise * 100) / 100;
}

/** The key a rule is known by, the same in every month and every process. */
function ruleKey(rule: Rule): number {
  return hash(`${rule.kind}:${rule.biller}:${rule.dueDay}`);
}

function isManual(method: Method): boolean {
  return method === "manual_ach" || method === "manual_card" || method === "check";
}

/**
 * Minute weights for a person paying something by hand today: their free,
 * awake minutes, weighted by `PAY_HOURS`, in `PAY_STEP` bins.
 *
 * Anything on the timeline is not free — asleep, travelling, in a shop, at a
 * meeting — except work, which keeps a quarter of its weight because bills do
 * get paid from a desk. The gaps between timeline events are the person at
 * home and awake, which is where most of this happens.
 */
function payWeights(planned: Day | undefined): Float64Array {
  const bins = 1440 / PAY_STEP;
  const factor = new Float64Array(bins).fill(1);
  const mark = (start: number, end: number, value: number) => {
    const from = Math.max(0, Math.floor(start / PAY_STEP));
    const to = Math.min(bins, Math.ceil(end / PAY_STEP));
    for (let bin = from; bin < to; bin += 1) factor[bin] = Math.min(factor[bin]!, value);
  };
  const timeline = planned?.scheduled.timeline ?? [];
  if (timeline.length > 0) {
    for (const event of timeline) {
      const kind = event.kind === "travel" ? "travel" : event.payload?.kind;
      mark(event.start, event.end, kind === "work" || kind === "school" ? AT_WORK : 0);
    }
  } else if (planned) {
    for (const block of planned.blocks) {
      mark(block.start, block.end, block.kind === "sleep" ? 0 : AT_WORK);
    }
    for (const leg of planned.legs) mark(leg.depart, leg.arrive, 0);
  }
  const weights = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin += 1) {
    weights[bin] = factor[bin]! * PAY_HOURS[Math.floor((bin * PAY_STEP) / 60)]!;
  }
  return weights;
}

function drawFrom(weights: Float64Array, rng: Rng): number | null {
  let total = 0;
  for (const weight of weights) total += weight;
  if (!(total > 0)) return null;
  let roll = rng.next() * total;
  for (let bin = 0; bin < weights.length; bin += 1) {
    roll -= weights[bin]!;
    if (roll <= 0) return bin * PAY_STEP + rng.int(0, PAY_STEP - 1);
  }
  return weights.length * PAY_STEP - 1;
}

/**
 * The minute of the day this payment lands at.
 *
 * `owner` is whoever the mandate belongs to — the person for a personal rule,
 * the household for a household one — so a subscription renews at the same
 * minute whichever member of the house is paying for it this month.
 */
function minuteFor(
  rule: Rule, owner: number, seed: number, rng: Rng, weights: () => Float64Array,
): number {
  switch (rule.method) {
    case "autopay_ach": {
      const biller = new Rng(mix(seed, LAYER.bills, hash(`ach:${rule.biller}`)));
      const batch = biller.weighted(ACH_BATCHES, ACH_BATCHES.map((one) => one.weight));
      const at = biller.int(batch.window[0], batch.window[1]);
      // The batch is the biller's; where in it this debit falls is the order
      // the file happened to list it in.
      return Math.min(DAY_MINUTES - 1, at + rng.int(0, 20));
    }
    case "autopay_card": {
      const mandate = new Rng(mix(seed, owner, LAYER.bills, ruleKey(rule), 0x5c));
      return Math.min(DAY_MINUTES - 1, mandate.int(0, DAY_MINUTES - 1) + rng.int(0, 3));
    }
    case "check":
      return rng.int(CHECK_HOURS[0], CHECK_HOURS[1]);
    default: {
      const drawn = drawFrom(weights(), rng);
      // A day with no free waking minute at all — a double shift, a night on
      // the road — still has the payment made; it goes wherever the person
      // was least busy, which is what the hourly shape alone says.
      if (drawn !== null) return drawn;
      return drawFrom(Float64Array.from({ length: 1440 / PAY_STEP },
        (_, bin) => PAY_HOURS[Math.floor((bin * PAY_STEP) / 60)]!), rng) ?? 20 * 60;
    }
  }
}

/**
 * Which due date, if any, this rule is paid against today.
 *
 * Autopay pays on the due date. A manual payment is shifted a few days either
 * way per rule and per month, so the question is asked backwards: for each
 * possible offset, is there a due date that far away whose drawn offset is
 * exactly that one. Still arithmetic on the calendar, with no memory of what
 * was paid when, which is what keeps a day independent of the days before it.
 * Weekly childcare is not shifted; it is paid at the door that week.
 */
function paidAgainst(rule: Rule, owner: number, date: Date, seed: number): Date | null {
  if (!isManual(rule.method) || rule.frequency === "weekly") {
    return dueOn(rule, date) ? date : null;
  }
  for (const offset of PAY_OFFSETS) {
    const due = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
    if (!dueOn(rule, due)) continue;
    const drawn = new Rng(mix(seed, owner, LAYER.bills, ruleKey(rule),
                              due.getFullYear() * 12 + due.getMonth(), 0x0f));
    if (drawn.weighted(PAY_OFFSETS, PAY_OFFSET_WEIGHTS) === offset) return due;
  }
  return null;
}

/**
 * Which household member pays this bill this month, and how much of it.
 *
 * Keyed on the household and the bill and the month, and on nothing about the
 * person asking — that is what makes the answer the same in every process that
 * asks it. A `shared` bill returns both members with half each, which is what
 * housemates do with the rent; `alternate` returns one of the two, with the
 * alternate's share as the chance it is them this month; `sole` returns the
 * payer, forever.
 */
function payersFor(
  rule: HouseholdRule, date: Date, seed: number,
): { person: number; share: number }[] {
  if (rule.altPayer === null || rule.split === "sole") {
    return [{ person: rule.payer, share: 1 }];
  }
  if (rule.split === "shared") {
    return [
      { person: rule.payer, share: 1 - rule.splitShare },
      { person: rule.altPayer, share: rule.splitShare },
    ];
  }
  const rng = new Rng(mix(
    seed, rule.household, LAYER.bills,
    date.getFullYear() * 12 + date.getMonth(),
    hash(`${rule.kind}:${rule.biller}:${rule.dueDay}`)));
  return [{
    person: rng.bool(rule.splitShare) ? rule.altPayer : rule.payer, share: 1,
  }];
}

/**
 * Every bill this person pays today: their own, and the household's ones that
 * fell to them this month.
 *
 * Pure, like `chargesFor`. It reads balances only where it has to — a card
 * payment is a share of a live balance — and it moves nothing.
 */
export function billsFor(
  bills: Bills, world: World, position: Position, person: Person,
  date: Date, dayNumber: number, planned?: Day,
): BillCharge[] {
  const out: BillCharge[] = [];
  const account = depositTarget(position);

  let weights: Float64Array | null = null;
  const free = () => (weights ??= payWeights(planned));

  const emit = (rule: Rule, owner: number, amount: number, index: number,
                settles?: string): void => {
    if (!(amount > 0.009)) return;
    const rng = stream(world.seed, person.id, LAYER.bills, dayNumber,
                       mix(0xb1, index));
    out.push({
      person: person.id,
      reason: rule.kind,
      mcc: rule.mcc,
      merchant: rule.biller,
      amount,
      _timestamp: minuteFor(rule, owner, world.seed, rng, free),
      ...(settles ? { settles } : {}),
      // A mandate is drawn on an account, and naming it is what keeps the bill
      // out of `cashChance` — nobody pays the gas company in twenties because
      // the routing table happens to like cash at that ticket size.
      ...(account?.number ? { account: account.number } : {}),
      ...(rule.method === "check" ? { instrument: "check" as const }
        : rule.method.endsWith("_ach") ? { instrument: "ach" as const } : {}),
    });
  };

  let index = 0;
  for (const rule of bills.forPerson(person.id)) {
    index += 1;
    const due = paidAgainst(rule, person.id, date, world.seed);
    if (!due) continue;
    const rng = stream(world.seed, person.id, LAYER.bills, dayNumber,
                       mix(0x2f, index));
    emit(rule, person.id, amountFor(rule, bills.seasonal, due, rng), index);
  }

  for (const rule of bills.forHousehold(person.household)) {
    index += 1;
    // Keyed on the household, so every member agrees which day it is paid.
    const due = paidAgainst(rule, rule.household, date, world.seed);
    if (!due) continue;
    const mine = payersFor(rule, due, world.seed)
      .find((payer) => payer.person === person.id);
    if (!mine) continue;

    const rng = stream(world.seed, person.id, LAYER.bills, dayNumber,
                       mix(0x3f, index));

    // The card payment, the one amount that is not on the record. What is owed
    // now is what matters, and the floor only applies while there is something
    // to pay: a cleared card is not billed a $35 minimum.
    if (rule.shareOfBalance > 0 && rule.card) {
      const card = position.cards.find(
        (c) => c.kind === "credit" && c.lastFour === rule.card);
      if (!card || card.balance <= 0.5) continue;
      const wanted = Math.max(rule.amount, card.balance * rule.shareOfBalance);
      emit(rule, rule.household, Math.round(Math.min(card.balance, wanted) * 100) / 100,
           index, rule.card);
      continue;
    }

    emit(rule, rule.household, Math.round(
      amountFor(rule, bills.seasonal, due, rng) * mine.share * 100) / 100,
      index);
  }

  return out;
}

/**
 * What arrives today: the wages and benefits whose payday this is.
 *
 * In this module rather than in `bank/` because it is the same kind of thing
 * as everything else here — a schedule the calendar is asked about — and
 * because the two have to be settled together. `payroll.ts` could already
 * project a payday and `doTransferIn` could already credit an account, and in
 * the whole simulation nothing had ever called either: money left Kierston and
 * never came back, so every balance fell monotonically from whatever
 * `banking.py` set it to.
 *
 * That was survivable while the only outgoings were a coffee and a bus fare.
 * It is not survivable with the rent in the list — a city where the rent is
 * due and the wages never arrive declines a sixth of everything by the second
 * week, and the decline rate stops measuring anything about how people pay.
 *
 * A stream pays today when the last payday on or before today *is* today,
 * which is the one question `lastPayday` already answers exactly.
 */
export function incomeFor(
  position: Position, person: Person, date: Date, dayNumber: number, seed: number,
): Deposit[] {
  const today = isoDate(date);
  const out: Deposit[] = [];

  for (const [index, stream] of position.streams.entries()) {
    if (!stream.anchor || stream.netPerPeriod <= 0) continue;
    if (lastPayday(stream, today) !== today) continue;

    const rng = new Rng(mix(seed, person.id, LAYER.bills, dayNumber,
                            mix(0x9d, index)));
    // A direct deposit is there before anybody wakes up — that is the whole
    // point of it and the reason a rent debit at 04:00 clears on the day the
    // wages land. A cheque or a cash wage arrives when the person does
    // something about it, which is during the day.
    const paid = stream.method === "direct_deposit";
    out.push({
      person: person.id,
      sender: payerFor(null, stream.employer ?? stream.source),
      amount: stream.netPerPeriod,
      _timestamp: paid ? rng.int(0, 5 * 60) : rng.int(9 * 60, 18 * 60),
      reason: stream.source === "wages" ? "wages" : "benefit",
      memo: stream.source,
      ...(stream.method === "cash" ? { cash: true } : {}),
      ...(stream.account ? { account: stream.account } : {}),
    });
  }
  return out;
}

/**
 * The day's bills for one person, for a caller holding a context and a bank.
 *
 * The convenience wrapper the two settle sites use, and the reason it takes
 * the bank rather than a position: a card payment has to read the live balance
 * off the card, so the schedule cannot answer on its own. Returns nothing at
 * all where no schedule was loaded, which is what a run without `--money` is.
 */
export function billsDue(
  context: { world: World; bills?: Bills | null; bank?: Bank },
  person: Person, date: Date, dayNumber: number, planned?: Day,
): BillCharge[] {
  if (!context.bills || !context.bank) return [];
  return billsFor(context.bills, context.world,
                  context.bank.position(person.id), person, date, dayNumber, planned);
}

/** The same wrapper for what arrives, rather than for what leaves. */
export function incomeDue(
  context: { world: World; bank?: Bank },
  person: Person, date: Date, dayNumber: number,
): Deposit[] {
  if (!context.bank) return [];
  return incomeFor(context.bank.position(person.id), person, date, dayNumber,
                   context.world.seed);
}

/** Stable integer for a string key. The same one `spend.ts` uses. */
function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return h;
}

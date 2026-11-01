/**
 * What the day cost, and at which minute each part of it was paid.
 *
 * `bank/` has been able to take a payment since it was written and nothing has
 * ever called it. This is the caller. It takes a day that has already been
 * scheduled and turns the visits in it into charges: a supermarket stop becomes
 * a basket, a cab leg becomes a metered fare, an hour in a deck becomes a
 * parking ticket, and each of them lands at a plausible minute inside the stay
 * rather than at whichever minute the code happened to run.
 *
 * Why this is a pass over a finished day and not part of planning
 * ---------------------------------------------------------------
 * `chain` runs its stay list up to four times, each attempt with a backward
 * solve and a forward pricing pass, and throws away the ones that do not fit.
 * A charge raised from inside it would be a charge for a visit that never
 * happened, and no amount of care about ordering would fix that — the visit
 * does not exist until the planner has finished choosing. Running afterwards
 * also means the times are the real ones: a grocery stop that the planner
 * compressed from fifty minutes to twenty is paid for at the end of the twenty.
 *
 * So `chargesFor` is pure and reads a `Day`. `settleDay` is the part that
 * touches money, and it is separate because balances are state and everything
 * else here is not.
 *
 * Where the numbers come from
 * ---------------------------
 * Two published sources, used the way `tours.ts` uses NHTS. The Consumer
 * Expenditure Diary records what a household bought, item by item, over a
 * week, which is what the tickets below are fitted against. The Fed's Diary of
 * Consumer Payment Choice gives payments per person per day and the cash share
 * by merchant type and ticket size, which is what tests the instrument choice
 * in `bank/routing.ts` — a table that has never been put against a measurement.
 *
 * On counting transactions against DCPC, which is easy to get wrong: the
 * headline is 47.2 payments per consumer per month, and that is *not* the
 * number to aim at. Ten of those are bills and 8.9 are remote purchases, and
 * this module raises neither — a charge here exists only because somebody
 * physically went somewhere. The comparable figure is in-person purchases
 * alone, 28.3 a month or 0.93 a day, against 0.81 over the whole city.
 *
 * That 13% gap is smaller than the errors underneath it, which run in opposite
 * directions and cancel. A full-city day raises 17,120 transit fares — 23% of
 * every payment in Kierston, in a city whose real bus share is a few percent —
 * and 93 fill-ups, against the several thousand that 70,000-odd cars would
 * need. One cause, not two: trips that should be driven are being taken by bus
 * and cab, so the farebox is inflated by the same mechanism starving `fuel`.
 *
 * `base`, `spread`, `elasticity` and `perHead` are now fitted rather than
 * anchored, against the 2024 CE Diary microdata sitting in `data/` — four
 * quarters of `expd*` joined to `fmld*`, 416,271 expenditure records. The fit
 * is a weighted regression of log occasion amount on log household income and
 * log household size, run once per income imputation (`FINCBEF1..5`) and
 * averaged, weighted by `FINLWT21`. `base` is the intercept, so it is the
 * median occasion at REFERENCE_INCOME for a household of one; `spread` is the
 * residual sigma.
 *
 * `tier`, `paid` and `tip` are still anchored and cannot be otherwise. CE has
 * no store identifier, so nothing in it can speak to `tier`; a diary records
 * only the visits that spent money, so it has no denominator for `paid`; and
 * the tip is inside the recorded amount with no way to separate it.
 *
 * BLS publishes UCC titles in a stub file that could not be reached from here,
 * so the category mapping was recovered instead by correlating per-household
 * UCC section sums against the *named* weekly aggregates that ride along in
 * FMLD — CEREAL, BAKEPROD, FOODAWAY, PERSSERV and the rest. Eighteen sections
 * came back at r = 1.000, which identifies them beyond argument. Where a
 * mapping is a judgement rather than a measurement the ticket says so.
 *
 * On "proportional to income"
 * ---------------------------
 * It is not, and building it that way is the classic error. Engel's law: the
 * food share of spending falls as income rises, so a household on $180,000
 * does not buy four times the groceries of one on $45,000 — it buys about
 * twice. Each ticket therefore carries its own elasticity, the exponent on
 * relative income. An elasticity of 1.0 is strict proportionality, so nothing
 * is lost — it is the special case.
 *
 * The fitted elasticities are much *lower* than the anchored guesses they
 * replaced — 0.15 rather than 0.35 for food at home, 0.22 rather than 0.90 for
 * retail — and that is not the fit failing. It is the estimand being narrower
 * than the guess was. What CE measures per occasion is the size of one basket,
 * and the income gradient in annual spending is mostly *frequency*: richer
 * households eat out more often far more than they eat out more expensively.
 * Frequency lives in the DEMAND table in `tours.ts`, not here, so an elasticity
 * that carried both would count the gradient twice. These are the ticket-size
 * half alone, which is the half this module is responsible for.
 */

import type {
  Bank, Location, PaymentRequest, Transaction, TransferRequest,
} from "./banking/index.ts";
import { BILL_KINDS, type BillKind } from "./bills.ts";
import { readCityTable, type Person, type World } from "../world/index.ts";
import { LAYER, MINUTES_PER_DAY, mix, Rng, stream } from "../shared/index.ts";
import type { Day } from "../scheduler/index.ts";
import type { Leg } from "../transport/index.ts";
import type { Purpose, Venue, Venues } from "../activities/discretionary/index.ts";

/** What the module needs of the day context. Not the whole of it. */
export interface SpendContext {
  world: World;
  venues: Venues;
}

/**
 * Why a charge exists, kept on it so a check can group by it.
 *
 * The bill kinds are in here rather than in a category of their own because a
 * day's money is one list: rent leaving at 04:12 and a sandwich at 13:05 are
 * the same person's Tuesday, and a report that had to union two vocabularies
 * to say so would be describing something the statement does not.
 */
export type ChargeReason = Purpose | "fare" | "transit" | "parking" | BillKind;

export interface Charge extends PaymentRequest {
  readonly reason: ChargeReason;
  /** The venue, where there is one. Absent on a fare or a parking ticket. */
  readonly venue?: string;
  /**
   * The last four of a credit card this settles rather than buys anything at.
   *
   * `bills.ts` raises these and nothing else does. It lives on `Charge` rather
   * than on a type of its own so that a card payment can sit in the same
   * time-ordered list as everything else — which it has to, because whether
   * the 19:40 card payment clears depends on the 04:12 rent.
   */
  readonly settles?: string;
}

/**
 * A posted row with the reason it was raised for still attached.
 *
 * The bank does not know what a payment was *for* — it knows a merchant
 * category, which is a coarser thing: MCC 5411 is every grocer in the city and
 * says nothing about whether this was the week's shop or a milk run, and 5814
 * cannot tell a coffee from a takeaway. The distinction is `spend.ts`'s own and
 * is lost the moment a charge becomes a `PaymentRequest`.
 *
 * Carrying it back out costs one field and is what lets a reader group a day's
 * money the same way `TICKETS` prices it. `withdrawal` is not a charge reason —
 * no charge produces one — but a ledger has to name the row somehow, and the
 * cash-machine trip is a category of its own in every statement ever printed.
 */
/**
 * Money arriving rather than leaving: a payday, or a benefit.
 *
 * It rides in the same settlement as the charges because it has to be in the
 * same order as them. Wages land at four in the morning and rent leaves at
 * four-oh-five, and settling the two in the wrong order is the difference
 * between a month that clears and a month that does not.
 */
export interface Deposit extends TransferRequest {
  readonly reason: "wages" | "benefit";
}

export interface Posted extends Transaction {
  readonly reason: ChargeReason | "withdrawal" | "wages" | "benefit";
  /** The venue the charge was raised at, where it had one. */
  readonly venue?: string;
}

/** Re-submit a recorded request from an opening balance. Never copy a closing
 * balance or assume a previous approval still holds after earlier spending.
 */
export function replayPosting(bank: Bank, recorded: Posted): Posted {
  const request = { person: recorded.person, amount: Math.round(recorded.amount * 100) / 100,
    _timestamp: recorded._timestamp, account: recorded.account ?? undefined,
    merchant: recorded.merchant ?? recorded.sender ?? "", location: recorded.location };
  let posted: Transaction;
  switch (recorded.kind) {
    case "transfer_in":
      posted = bank.doTransferIn({ ...request, sender: recorded.sender ?? recorded.merchant ?? "",
        cash: recorded.instrument === "cash" }); break;
    case "withdrawal": posted = bank.doWithdrawal(request); break;
    case "card_payment":
      posted = bank.doCardPayment({ ...request, card: recorded.card ?? "" }); break;
    case "payment":
      posted = bank.doPayment({ ...request, mcc: recorded.mcc ?? 0,
        card: recorded.card ?? undefined, instrument: recorded.instrument }); break;
  }
  return { ...posted, reason: recorded.reason, ...(recorded.venue ? { venue: recorded.venue } : {}) };
}

/**
 * The median household income of the extract, which every ticket is quoted at.
 *
 * $47,376 across the 46,039 households `synthesize_population.py` wrote, so a
 * base below is what that household spends and the elasticity moves everyone
 * else off it. Quoting against the *median* rather than the mean matters: the
 * mean here is $60,007, and anchoring at a figure a quarter of the city is
 * nowhere near would put the modal basket in the wrong place.
 */
const REFERENCE_INCOME = 47_400;

/**
 * What one visit costs, before the day's own noise.
 *
 *   base        median dollars for a one-person household at the reference
 *               income. Not the mean — a lognormal's mean sits above its
 *               median and quoting the mean would put every ticket 20-40% high
 *   spread      σ of that lognormal, in log-dollars
 *   elasticity  exponent on relative income. See the header
 *   perHead     what each extra person in the household adds, as a share of
 *               base. One for a weekly shop, nought for a haircut
 *   tier        exponent on the venue's `pull`, so the anchor supermarket
 *               rings up more than the corner deli and a chain rings up what
 *               the chain rings up
 *   paid        share of visits that produce a transaction at all. A trip to
 *               the post office to collect a parcel is not a purchase
 *   tip         median gratuity as a share added, before rounding
 */
interface Ticket {
  base: number;
  spread: number;
  elasticity: number;
  perHead: number;
  tier: number;
  paid: number;
  tip: number;
}

const TICKETS: Partial<Record<Purpose, Ticket>> = {
  // CE sections 01-18, the whole of food at home, collapsed into a shop: one
  // household's food items sharing one diary day. n = 19,009 such baskets.
  //
  // That reconstruction is the weakest step in the whole fit and it fails in a
  // known direction — CE has no trip identifier, so a household that shopped
  // twice on a Saturday is read as one large trip. `base` is therefore biased
  // up and `spread` down by an unknown but not enormous amount.
  //
  // A day's food-at-home with three items or more is a shop; two or fewer is a
  // milk run and goes to `convenience` below. That threshold is a judgement,
  // and it is the only thing separating the two — CE cannot tell a supermarket
  // from a corner shop.
  //
  // The regression put this at 39.80 and it is written at 30.52; see the note
  // on `tier` below the table for why every base carries that second step.
  grocery: { base: 33.74, spread: 0.88, elasticity: 0.15, perHead: 0.08, tier: 0.35, paid: 0.99, tip: 0 },
  // The other side of the same split. n = 5,304.
  convenience: { base: 8.84, spread: 1.00, elasticity: 0.16, perHead: 0.02, tier: 0.15, paid: 0.97, tip: 0 },
  // UCC 190600 and 190700, the two small food-away codes — vending and mobile
  // vendors, at $4.56 and $5.43 medians. JUDGEMENT: it is the nearest thing CE
  // has to a coffee stop, but a real cafe purchase is more likely booked to
  // 190400 below, so this base is probably a little low.
  cafe: { base: 4.30, spread: 0.92, elasticity: 0.15, perHead: 0.03, tier: 0.10, paid: 0.96, tip: 0.08 },
  // UCC 190400, counter service and takeaway. n = 22,676, the single largest
  // category in the Diary, so this is the best-determined row in the table.
  "food-quick": { base: 10.69, spread: 0.84, elasticity: 0.05, perHead: 0.08, tier: 0.10, paid: 0.98, tip: 0.03 },
  // UCC 190500, table service. n = 8,194, median occasion $35.00.
  //
  // A cover, not an occasion, and the difference is the whole of why this is
  // 13.74 against a survey figure of $35: CE's occasion is what the table
  // paid, and a table is billed here by multiplying this by the covers on it
  // — see COVERS. It was arrived at by dividing the fitted occasion by the
  // mean party the old draw produced, and it survives that draw's removal
  // unchanged, because the draw was mean-preserving: billing every diner one
  // cover bills the same total as billing one diner for the table.
  //
  // JUDGEMENT, and the loosest number in the table now. Nothing has been
  // refitted since the co-presence layer began deciding party sizes, so the
  // occasion medians a full run produces should be checked against CE again
  // before this row is quoted as measured.
  "food-sit": { base: 13.74, spread: 0.86, elasticity: 0.17, perHead: 0.13, tier: 0.30, paid: 0.97, tip: 0.18 },
  // UCC 790420, alcohol away from home. n = 3,132, fitted occasion $14.51.
  //
  // Per round, not per evening — so the occasion is halved, on the assumption
  // that a diary entry covers a stay of about ninety minutes and `barRounds`
  // cuts that into two. JUDGEMENT, and the shakiest arithmetic here: CE gives
  // no indication whether a respondent wrote down each round or the tab.
  bar: { base: 7.25, spread: 0.77, elasticity: 0.16, perHead: 0, tier: 0.20, paid: 0.98, tip: 0.15 },
  // UCC 470111. n = 10,074 fill-ups at a $40.56 median, and the cleanest row
  // in the table — one code, one meaning, no reconstruction. The elasticity
  // came back at 0.08: a tank really is a tank whoever is buying it.
  fuel: { base: 36.41, spread: 0.57, elasticity: 0.08, perHead: 0.03, tier: 0.05, paid: 1.0, tip: 0 },
  // Sections 54 and 55, prescription and nonprescription. n = 8,732.
  pharmacy: { base: 10.04, spread: 1.17, elasticity: 0.07, perHead: 0, tier: 0.10, paid: 0.90, tip: 0 },
  // Section 56, medical services. n = 1,680.
  //
  // CE records what the household paid out of pocket, not what was billed, so
  // this is a copay and not the invoice — which is what this row wanted. The
  // $61.90 is well above the $30 that was guessed, and the reason is that the
  // section carries dental at a $181 median alongside the $37 office visit.
  health: { base: 53.34, spread: 1.18, elasticity: 0.08, perHead: 0.02, tier: 0.05, paid: 0.55, tip: 0 },
  // Section 65, r = 1.000 against PERSSERV. n = 2,340.
  personal: { base: 22.89, spread: 0.83, elasticity: 0.12, perHead: 0, tier: 0.25, paid: 0.95, tip: 0.18 },
  // Mostly banks, post offices and libraries. Most of those visits move no
  // money at all, and the ones at a library move none by construction — it has
  // no merchant category, so `charge` drops it before `paid` is ever consulted.
  //
  // The one row still carrying its original guess: CE has no section that
  // means "errand", and inventing a mapping would be worse than admitting it.
  errand: { base: 14, spread: 1.10, elasticity: 0.40, perHead: 0, tier: 0.10, paid: 0.30, tip: 0 },
  // JUDGEMENT, and the loosest mapping in the file: apparel (32), housekeeping
  // supplies (33) and personal care goods (64). n = 31,942.
  //
  // The base fell from $30 to $8 because CE is recording *items* and there is
  // no day-collapse here as there is for groceries — a shopping trip that buys
  // three things arrives as three rows. Read as a per-item price it is right;
  // read as a per-visit ticket it is low, and closing that gap needs the same
  // basket reconstruction the food rows got.
  retail: { base: 6.57, spread: 1.17, elasticity: 0.22, perHead: 0, tier: 0.35, paid: 0.82, tip: 0 },
  // Sections 48 and 49, parts and maintenance. n = 2,054. Excludes section 45,
  // vehicle purchase, which is not a garage visit. The widest spread in the
  // table at 1.44 and it earns it: an air filter or a gearbox.
  vehicle: { base: 35.33, spread: 1.44, elasticity: 0.26, perHead: 0, tier: 0.20, paid: 0.90, tip: 0 },
  // `park` is deliberately absent. A municipal park takes no money and has no
  // merchant category, and inventing an ice cream van would be inventing it.
};

/**
 * Why the bases above are not the regression's intercepts.
 *
 * The fit quotes `base` at `pull` = 1, because CE has no venue and the tier
 * term has to be neutral somewhere. But the city never visits a pull-1 venue on
 * average: `venues.ts` draws pull lognormal with median 1, and then `choose`
 * weights the *selection* by pull, so a big supermarket is picked far more
 * often than a small one and the visited pull averages near 3. Feeding the raw
 * intercept in therefore multiplies every ticket by pull^tier ≈ 1.4 and puts
 * the whole city 40% high — which is exactly what the first run did, at a $64
 * grocery median against CE's $49.
 *
 * So each base was divided by the ratio the simulator itself produced against
 * the CE weighted median for that category. That absorbs the tier bias, the
 * household-size mix, the income mix and the tip in one step, and it is honest
 * about being a one-shot correction rather than a structural fix. The
 * structural fix is to normalise the tier term by the visit-weighted pull in
 * `ticketAmount`, which is a change to `venues.ts` as much as to this file.
 *
 * The evidence that this is the right diagnosis and not a fudge: the rows that
 * moved are precisely the high-tier ones — grocery (0.35) fell 23%, food-sit
 * (0.30) fell 46%, retail (0.35) fell 26%, personal (0.25) fell 34% — while
 * cafe (0.10), convenience (0.15) and food-quick (0.10) moved by under 2%.
 *
 * Four rows were left at their fitted values instead. `bar` is priced per round
 * and CE 790420 is per occasion, so the two medians are not comparable; fuel,
 * vehicle and health raised 4, 5 and 11 charges in the calibrating run, which
 * is too few for a median to mean anything.
 */

/**
 * Where inside the stay the money moves.
 *
 *   arrive  you pay at a counter and then sit down, or you pay to go in
 *   leave   you pay on the way out, which is a till or a bill
 *
 * The offset is a range of minutes from that end, drawn per visit and then
 * clamped inside the stay — a stop the planner compressed to six minutes still
 * has to be paid for during those six minutes.
 *
 * This table is the whole of what was asked for and it is worth being explicit
 * about how much it changes: a grocery charge at the *start* of the stay puts
 * the city's supermarket revenue an hour early, and every downstream question
 * about when a shop was busy reads it back wrong.
 */
const SETTLEMENT: Partial<Record<Purpose, { at: "arrive" | "leave"; offset: [number, number] }>> = {
  // The till, then the walk to the car park.
  grocery: { at: "leave", offset: [-5, -1] },
  convenience: { at: "leave", offset: [-2, 0] },
  // Ordered and paid for at the counter, then carried to a table.
  cafe: { at: "arrive", offset: [1, 4] },
  "food-quick": { at: "arrive", offset: [1, 5] },
  // Table service: the bill comes before the coats do.
  "food-sit": { at: "leave", offset: [-9, -2] },
  // Pump first, pay after. Prepay at the kiosk is the other half of the trade
  // and it is a two-minute difference on a six-minute stop.
  fuel: { at: "arrive", offset: [2, 5] },
  pharmacy: { at: "leave", offset: [-3, -1] },
  // A copay is taken at check-in, not on the way out.
  health: { at: "arrive", offset: [0, 3] },
  personal: { at: "leave", offset: [-4, 0] },
  errand: { at: "leave", offset: [-5, -1] },
  retail: { at: "leave", offset: [-7, -1] },
  vehicle: { at: "leave", offset: [-6, -1] },
};

/**
 * Categories where the price is a menu and not a basket.
 *
 * The cents of a supermarket total are effectively uniform — it is forty items
 * added up. The cents of a coffee are not: they are a posted price, and posted
 * prices cluster on .99, .95 and .49. Getting this wrong is not a rounding
 * detail, it is the difference between a ledger that reads like a statement
 * and one that reads like a random number generator with a dollar sign.
 */
/** The reasons that come from `bills.ts` rather than from a place somebody went. */
const BILL_REASONS = new Set<string>(BILL_KINDS);

const MENU_PRICED = new Set<ChargeReason>(["cafe", "food-quick", "convenience", "bar"]);

/** How much longer an evening meal is than the same restaurant at lunch. */
const DINNER_UPLIFT = 1.35;
const DINNER_FROM = 17 * 60;

/**
 * COVERS: why a restaurant charge is one cover, and no longer a drawn table.
 *
 * This used to draw a party of one to four for every sit-down meal and, most
 * of the time, hand the whole bill to one of them: the drawer paid for all of
 * it or paid nothing, so the expected covers billed per diner came out at
 * exactly one and the city's restaurant total was right. It was the best that
 * could be done before anything in the simulation knew who was at a table.
 *
 * It cannot survive the co-presence layer. The people at a table are a fact
 * now — a gathering names them and names which of them treated — and for a
 * stop the answer is that nobody else was there at all. Drawing a party
 * anyway meant a diner the simulation had seated alone could have their meal
 * charged to a person who does not exist, which happened to about a fifth of
 * restaurant stops and left a two-hour dinner that no ledger in the city
 * accounts for. An aggregate that is right while every individual record is
 * unreconstructable is the one thing this benchmark must not produce.
 *
 * So: a stop pays for its own cover, and a gathering multiplies the cover by
 * the covers it really had. `base` is unchanged by the removal — the draw was
 * mean-preserving, so billing every diner one cover bills the same total —
 * but a raised charge is now a cover rather than a table, and it is the
 * gatherings that produce occasion-sized tickets.
 */

/** Minutes of drinking that make a round. Four is the most anyone is bought. */
const MINUTES_PER_ROUND = 45;
const MAX_ROUNDS = 4;

/**
 * The meter, as a medallion tariff rather than a ride-hailing surge.
 *
 * `taxi.ts` prices the journey in minutes and kilometres and knows how many of
 * those minutes were spent waiting, which is exactly the three numbers a meter
 * runs on. Nothing here has to be invented except the tariff itself.
 */
const FARE = {
  flag: 3.25,
  perKm: 1.55,
  /** Waiting time, which a meter charges for and a distance model forgets. */
  perWaitMinute: 0.45,
  minimum: 8.0,
  tip: 0.15,
} as const;

/** The cab companies a fare is paid to: the city's `cab_companies.csv`, in file order. */
let cabCompanies: readonly string[] | null = null;
function operators(): readonly string[] {
  if (!cabCompanies) {
    cabCompanies = readCityTable("cab_companies.csv").map((row) => row.name!);
    if (cabCompanies.length === 0) throw new Error("cab_companies.csv lists no cab company");
  }
  return cabCompanies;
}

/** A single-ride transit fare, flat, as a bus in a city this size charges. */
const TRANSIT_FARE = 2.0;

/**
 * Parking: what it costs an hour, and how much of it costs anything at all.
 *
 * The second number is the one that matters and the first version of this
 * module got it badly wrong — charging every lot and a quarter of the kerb
 * made parking 45% of every transaction in Kierston, more than groceries and
 * restaurants together. In a city this size almost all parking is free: the
 * supermarket lot is free, the strip mall is free, the residential kerb is
 * free, and what is metered is a few streets downtown and the decks.
 *
 * `share` is therefore a stand-in for a parking-zone layer that does not
 * exist. A deck always charges because that is what a deck is for; a kerb
 * space charges when it happens to be one of the metered ones; a lot charges
 * only where it is a paid municipal lot rather than a shop's own. Replacing
 * this with real zoning is a change to `parking.ts`, which knows where the
 * space is, not to this file, which only knows what kind it was.
 */
const PARKING = {
  driveway: { rate: 0, share: 0 },
  kerb: { rate: 1.75, share: 0.07 },
  lot: { rate: 1.25, share: 0.05 },
  deck: { rate: 2.0, share: 1 },
} as const;
const PARKING_DAILY_MAX = 16;
/** MCC 7523, parking lots and garages. */
const PARKING_MCC = 7523;
const TRANSIT_MCC = 4111;
const TAXI_MCC = 4121;
const ATM_MCC = 6011;

/**
 * How much cash a person likes to have on them, in dollars.
 *
 * Drawn off `cashPreference`, which `banking.py` already gave everyone: the
 * person who pays for everything in notes carries notes, and the one who taps
 * a card for a $3 coffee carries almost nothing. The floor is what triggers a
 * withdrawal, not what a withdrawal restores — see `topUp`.
 */
function cashFloor(cashPreference: number): number {
  return 15 + 145 * cashPreference;
}

/** What a machine dispenses. Nobody withdraws $37. */
const NOTES = [20, 40, 60, 80, 100, 200];
const NOTE_WEIGHTS = [0.20, 0.24, 0.16, 0.10, 0.22, 0.08];

/**
 * Every charge the day generates, in time order.
 *
 * Pure: it reads the finished day and the world, draws from streams keyed on
 * the person and the activity, and returns requests. Nothing is posted here,
 * no balance is read, and calling it twice gives the same answer — which is
 * what makes it testable against a day without needing a bank at all.
 *
 * Only charges at minutes [0, 1440) of this date are returned. A day's timeline
 * carries yesterday's continuation at negative minutes and tonight's events
 * past 1440, and the next date sees tonight's events again as its own
 * continuation. Each stay and leg is therefore priced in the frame of the date
 * it starts on, from a stream keyed on that date, and shifted back: both dates
 * compute the same charges at the same absolute minutes, and the window keeps
 * each one in exactly one of them.
 */
export function chargesFor(
  context: SpendContext, person: Person, day: Day, dayNumber: number,
): Charge[] {
  const { world, venues } = context;
  const household = world.households.get(person.household);
  const income = household?.income ?? REFERENCE_INCOME;
  const size = household?.size ?? 1;
  const charges: Charge[] = [];

  for (const event of day.scheduled.timeline) {
    if (event.kind !== "stay") continue;
    const offset = MINUTES_PER_DAY * Math.floor(event.start / MINUTES_PER_DAY);
    const owner = dayNumber + offset / MINUTES_PER_DAY;
    const start = event.start - offset;
    const end = event.end - offset;
    const shift = (charge: Charge): Charge => ({ ...charge, _timestamp: charge._timestamp + offset });
    const payload = event.payload;
    if (payload?.kind === "meet") {
      // A table, not a basket. Two things differ from a stop and both come off
      // the same fact — the bill is for everybody there.
      //
      // Whoever is not paying is charged nothing at all, rather than a share:
      // the whole point of representing a payer is that one card cleared the
      // lot and the others left no record, which is what makes the party
      // reconstructable from a statement. And the amount is priced per head and
      // multiplied, rather than passed through the `perHead` term, because that
      // term describes a household adding an item to one diary-day basket and
      // this is four dinners.
      const meeting = payload.meeting;
      if (meeting.payer !== null && meeting.payer !== person.id) continue;
      const covers = meeting.payer === null ? 1 : meeting.parties.length;
      const table = payload.where === null ? undefined : venues.get(payload.where);
      if (!table || table.mcc === null) continue;
      const rng = stream(world.seed, person.id, LAYER.spend, owner, hash(event.activityId));
      for (const charge of visitCharges(
        person, meeting.purpose, table, start, end, income, 1, rng,
      )) {
        charges.push(shift({ ...charge, amount: Math.round(charge.amount * covers * 100) / 100 }));
      }
      continue;
    }
    if (!payload || payload.kind !== "stop") continue;
    const purpose = payload.purpose;
    if (!purpose) continue;
    const venue = payload.where === null ? undefined : venues.get(payload.where);
    if (!venue || venue.mcc === null) continue;

    // Keyed on the activity id, which is stable across runs and unique within
    // the day. Keying on an index into this loop instead would make a person's
    // basket depend on how many stops the planner happened to keep, so a day
    // where one stop was rejected would reprice every other stop in it.
    const rng = stream(world.seed, person.id, LAYER.spend, owner, hash(event.activityId));
    charges.push(...visitCharges(
      person, purpose, venue, start, end, income, size, rng,
    ).map(shift));
  }

  for (const [index, leg] of day.legs.entries()) {
    const next = day.legs[index + 1];
    charges.push(...legCharges(person, leg, next, dayNumber, world.seed));
  }

  return charges
    .filter((charge) => charge._timestamp >= 0 && charge._timestamp < MINUTES_PER_DAY)
    .sort((a, b) => a._timestamp - b._timestamp);
}

/** One visit: nought, one, or — at a bar — several. */
function visitCharges(
  person: Person, purpose: Purpose, venue: Venue,
  start: number, end: number, income: number, size: number, rng: Rng,
): Charge[] {
  const ticket = TICKETS[purpose];
  if (!ticket || venue.mcc === null) return [];
  if (!rng.bool(ticket.paid)) return [];

  const merchant = merchantName(venue);
  const location: Location = { id: venue.id, lat: venue.lat, lon: venue.lon };
  const common = { person: person.id, mcc: venue.mcc, merchant, location, venue: venue.id };

  if (purpose === "bar") {
    return barRounds(ticket, venue, start, end, income, rng).map(([at, amount]) => ({
      ...common, reason: purpose, amount, _timestamp: at,
    }));
  }

  let amount = ticketAmount(ticket, income, size, venue, rng);

  // What is priced here is one cover. Where several of them are on one bill —
  // a gathering — the caller multiplies by the covers it can see; a stop is a
  // person eating on their own as far as this simulation is concerned, and
  // they pay for it. See COVERS above for the draw this replaced.
  if (purpose === "food-sit" && start >= DINNER_FROM) amount *= DINNER_UPLIFT;

  return [chargeFor(common, purpose, amount, ticket, start, end, rng)];
}

/** The ticket, tipped, shaped and timed — the last three steps of every visit. */
function chargeFor(
  common: Omit<Charge, "reason" | "amount" | "_timestamp">,
  purpose: Purpose, amount: number, ticket: Ticket,
  start: number, end: number, rng: Rng,
): Charge {
  return {
    ...common,
    reason: purpose,
    amount: shape(withTip(amount, ticket.tip, rng), purpose, rng),
    _timestamp: settlementMinute(purpose, start, end, rng),
  };
}

/**
 * An evening at a bar, as the rounds it is actually bought in.
 *
 * One charge for a ninety-minute stay is a $46 bar tab settled at closing,
 * which is a real thing and not the usual thing: most of this trade is bought
 * a round at a time at the bar. Splitting it also does something the single
 * charge cannot — it lets the instrument vary within one evening, so the first
 * round goes on a card and the third is paid in the change from the second,
 * which is what `bank/routing.ts` produces when it is asked four times instead
 * of once.
 */
function barRounds(
  ticket: Ticket, venue: Venue, start: number, end: number, income: number, rng: Rng,
): [number, number][] {
  const minutes = Math.max(1, end - start);
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(minutes / MINUTES_PER_ROUND)));
  const out: [number, number][] = [];
  for (let round = 0; round < rounds; round += 1) {
    // Spread across the stay rather than bunched at either end, with the first
    // one shortly after arriving — nobody sits down without buying anything.
    const at = Math.round(start + 3 + ((minutes - 6) * round) / rounds + rng.between(0, 4));
    // Per round, so the household size plays no part — nobody buys a round
    // for the people they live with by virtue of living with them.
    const amount = withTip(
      ticketAmount(ticket, income, 1, venue, rng), ticket.tip, rng);
    out.push([Math.min(at, end), shape(amount, "bar", rng)]);
  }
  return out;
}

/** The ticket before tip and rounding. */
function ticketAmount(
  ticket: Ticket, income: number, size: number, venue: Venue, rng: Rng,
): number {
  return ticket.base
    * relativeIncome(income, ticket.elasticity)
    * (1 + ticket.perHead * Math.max(0, size - 1))
    * Math.pow(Math.max(0.1, venue.pull), ticket.tier)
    * Math.exp(rng.gauss(0, ticket.spread));
}

function relativeIncome(income: number, elasticity: number): number {
  // Floored rather than allowed to go to zero: a household recorded at no
  // income still eats, and `pums-kierston.json` has plenty of them — PINCP is
  // negative for a loss-making year and zero for a good many dependents.
  return Math.pow(Math.max(8000, income) / REFERENCE_INCOME, elasticity);
}

function withTip(amount: number, rate: number, rng: Rng): number {
  if (rate <= 0) return amount;
  // Tips cluster: most people leave the same share every time, a few leave
  // nothing, and the spread around the norm is narrow.
  const tip = Math.max(0, rng.gauss(rate, rate * 0.35));
  return amount * (1 + tip);
}

/** The minute inside the stay at which it was paid for. */
function settlementMinute(
  purpose: Purpose, start: number, end: number, rng: Rng,
): number {
  const rule = SETTLEMENT[purpose];
  if (!rule) return Math.round((start + end) / 2);
  const [lo, hi] = rule.offset;
  const anchor = rule.at === "arrive" ? start : end;
  const at = Math.round(anchor + rng.between(lo, hi));
  // A stop the planner squeezed to four minutes cannot be paid for six minutes
  // before it ended.
  return Math.max(start, Math.min(end, at));
}

/**
 * Cents, made plausible.
 *
 * See MENU_PRICED. A basket keeps its arithmetic; a posted price gets snapped
 * to one, and the tax on top of it is why the snap is not total.
 */
function shape(amount: number, reason: ChargeReason, rng: Rng): number {
  const rounded = Math.max(0.5, Math.round(amount * 100) / 100);
  if (!MENU_PRICED.has(reason) || rounded > 40) return rounded;
  if (!rng.bool(0.55)) return rounded;
  const dollars = Math.floor(rounded);
  return dollars + rng.pick([0.99, 0.95, 0.49, 0.25, 0.0]);
}

/**
 * What the travel itself cost: the meter, the farebox, and the parking.
 *
 * `next` is the leg after this one, and it is here for parking alone — the
 * duration of a stay is the gap between arriving on one leg and departing on
 * the next, and the leg has no idea how long its driver stayed.
 */
function legCharges(
  person: Person, leg: Leg, next: Leg | undefined,
  dayNumber: number, seed: number,
): Charge[] {
  // Keyed off the leg's own times in the frame of the date it departs on, so
  // the date it starts on and the next date, which sees it again as carried
  // continuation, draw the same stream. A position in the day's leg list
  // differs between those two dates. The person is in the stream, so the
  // journey id shared with a driver does not tie the passenger's tip to the cab.
  const offset = MINUTES_PER_DAY * Math.floor(leg.depart / MINUTES_PER_DAY);
  const owner = dayNumber + offset / MINUTES_PER_DAY;
  const key = `${owner}/${leg.depart - offset}/${leg.arrive - offset}/${leg.mode}/${leg.journeyId ?? ""}`;
  const rng = stream(seed, person.id, LAYER.spend, owner, mix(0x1e9, hash(key)));
  const charges: Charge[] = [];

  // The passenger's leg is metered. A "cab" leg is the driver's own, and the
  // driver pays no fare for driving.
  if (leg.mode === "taxi") {
    const minutes = Math.max(0, leg.arrive - leg.depart);
    const waited = Math.min(minutes, leg.wait ?? 0);
    const metered = FARE.flag
      + FARE.perKm * leg.kilometres
      + FARE.perWaitMinute * waited;
    const fare = withTip(Math.max(FARE.minimum, metered), FARE.tip, rng);
    charges.push({
      person: person.id,
      reason: "fare",
      mcc: TAXI_MCC,
      merchant: operators()[new Rng(hash(leg.journeyId ?? `${person.id}/${key}`)).int(0, operators().length - 1)]!,
      amount: shape(fare, "fare", rng),
      // Meter off at the kerb, which is the arrival and not a minute later.
      _timestamp: leg.arrive,
      location: { lat: leg.to.lat, lon: leg.to.lon },
    });
  }

  if (leg.mode === "transit") {
    charges.push({
      person: person.id,
      reason: "transit",
      mcc: TRANSIT_MCC,
      merchant: "LANTA",
      amount: TRANSIT_FARE,
      // Boarding, not alighting. A farebox is paid on the way in.
      _timestamp: leg.depart,
      location: { lat: leg.from.lat, lon: leg.from.lon },
    });
  }

  const parking = leg.parking;
  if (parking && parking.kind !== "driveway" && next) {
    const hours = Math.max(1, Math.ceil((next.depart - leg.arrive) / 60));
    const tariff = PARKING[parking.kind];
    if (rng.bool(tariff.share)) {
      const amount = Math.min(PARKING_DAILY_MAX, hours * tariff.rate);
      charges.push({
        person: person.id,
        reason: "parking",
        mcc: PARKING_MCC,
        merchant: parking.kind === "deck" ? "Kierston Parking Authority" : "City of Kierston Meters",
        amount: Math.round(amount * 100) / 100,
        // A meter and a lot are paid on arrival; a deck is paid at the barrier
        // on the way out, which is an hour or three later.
        _timestamp: parking.kind === "deck" ? Math.max(leg.arrive, next.depart - 2) : leg.arrive + 1,
        location: { lat: parking.at.lat, lon: parking.at.lon },
      });
    }
  }

  return charges;
}

/**
 * Post the day's charges, topping the person's pocket up when it runs low.
 *
 * The only stateful thing in the module, and deliberately the last thing: it
 * takes the charges as given and does nothing but decide when notes are needed
 * and then hand each request to the bank in time order. Time order matters —
 * whether the 18:40 pint clears depends on the 18:05 basket, and posting them
 * the other way round would give a different day.
 */
export function settleDay(
  bank: Bank, context: SpendContext, person: Person, day: Day, dayNumber: number,
  bills: readonly Charge[] = [],
  deposits: readonly Deposit[] = [],
): Posted[] {
  // Merged and re-sorted rather than settled after, and the ordering is the
  // whole point of doing it here: a direct debit posts at four in the morning
  // and is the reason the card is short at lunchtime. Settle the day first and
  // the rent, the one movement large enough to change what else clears, would
  // always arrive too late to have changed anything.
  const charges = [
    ...chargesFor(context, person, day, dayNumber), ...bills, ...deposits,
  ].sort((a, b) => a._timestamp - b._timestamp);
  if (charges.length === 0) return [];

  const position = bank.position(person.id);
  const posted: Posted[] = [];
  const cash = position.accounts.find((account) => account.type === "cash");
  const floor = cashFloor(position.profile.cashPreference);
  const rng = stream(context.world.seed, person.id, LAYER.cash, dayNumber);
  let toppedUp = false;
  // The minute of the last posting. A withdrawal is never placed before it, so
  // postings, and the balances they leave, stay in time order.
  let last = 0;

  for (const charge of charges) {
    // Money in first, and with no cash-machine trip attached to it: a deposit
    // is not a charge, has no merchant and cannot overdraw anything.
    if ("sender" in charge) {
      const { reason, ...request } = charge;
      posted.push({ ...bank.doTransferIn(request), reason });
      last = Math.max(last, charge._timestamp);
      continue;
    }

    // One trip to a machine a day at most, and only where the pocket is
    // genuinely short. Somebody who never carries cash has a floor near zero
    // and never triggers this, which is the point of drawing it off preference.
    //
    // Bills never trigger it. None of them is paid in notes, and a direct
    // debit at four in the morning would otherwise send somebody to a cash
    // machine at 03:47 to fund a payment that was never going to touch their
    // pocket.
    //
    // A charge with no place the person can be shown at a machine before it
    // posts no withdrawal and leaves the trip to a later charge.
    if (!toppedUp && cash && cash.balance < floor / 2
        && !BILL_REASONS.has(charge.reason)) {
      const withdrawal = topUp(bank, person, cash.balance, floor, charge, day, last, rng);
      if (withdrawal) {
        toppedUp = true;
        posted.push({ ...withdrawal, reason: "withdrawal" });
      }
    }
    const { reason, venue, settles, ...request } = charge;
    // A card payment moves money between two of this person's own instruments
    // and has no merchant to charge, so it goes to the other call. It is still
    // in this loop, and in this order, because it draws on the same account
    // everything else here does.
    const posting = settles
      ? bank.doCardPayment({
        person: request.person, card: settles, amount: request.amount,
        _timestamp: request._timestamp, merchant: request.merchant,
        ...(request.account ? { account: request.account } : {}),
      })
      : bank.doPayment(request);
    posted.push({ ...posting, reason, ...(venue ? { venue } : {}) });
    last = Math.max(last, charge._timestamp);
  }

  return posted;
}

/**
 * A trip to a cash machine, placed shortly before the charge that revealed the
 * shortfall.
 *
 * Approximate. A real withdrawal happens at a real machine, which is a POI with
 * coordinates and an operator, and the person makes a small detour to reach
 * it. Here it happens at the place the person was staying at, inside that
 * stay: the stay the charge falls in, or the last stay before it when the
 * charge falls on a journey. It is attributed to their own bank. The fix is to
 * raise the withdrawal as a stop in `tours.ts` so the planner routes to it,
 * which is a change to the trip generator rather than to this module.
 *
 * `earliest` is the minute of the last posting; a withdrawal is never placed
 * before it. Returns null when no minute inside that stay is at or after it.
 */
function topUp(
  bank: Bank, person: Person, balance: number, floor: number,
  before: Charge, day: Day, earliest: number, rng: Rng,
): Transaction | null {
  const position = bank.position(person.id);
  const source = position.accounts.find(
    (account) => account.spendable && account.debitable && account.type !== "cash");
  if (!source) return null;

  const visit = machineVisit(day, before._timestamp, earliest, rng);
  if (!visit) return null;

  // At least enough to clear the floor, then rounded up to what a machine
  // actually gives out.
  const wanted = Math.max(floor - balance, before.amount);
  const amount = NOTES[rng.weighted(
    NOTES.map((_, index) => index),
    NOTE_WEIGHTS.map((weight, index) => (NOTES[index]! >= wanted ? weight : weight * 0.05)),
  )]!;

  const transaction = bank.doWithdrawal({
    person: person.id,
    amount,
    _timestamp: visit.at,
    merchant: `${source.institution ?? "Kierston"} ATM`,
    location: visit.location,
  });
  return transaction;
}

/**
 * Where and when the person can be at a machine before minute `at`.
 *
 * The latest stay starting at or before `at`. When the person is still in it
 * at `at`, the withdrawal falls 4-25 minutes before `at`; when it ended
 * earlier, 4-25 minutes before it ended. Either way the minute is clamped
 * inside the stay, inside the exported day, and at or after `earliest`.
 */
function machineVisit(
  day: Day, at: number, earliest: number, rng: Rng,
): { at: number; location: Location } | null {
  let stay: Extract<Day["scheduled"]["timeline"][number], { kind: "stay" }> | null = null;
  for (const event of day.scheduled.timeline) {
    if (event.kind !== "stay" || event.start > at) continue;
    if (!stay || event.start >= stay.start) stay = event;
  }
  if (!stay) return null;
  const until = Math.min(at, stay.end);
  const lo = Math.max(0, earliest, stay.start);
  if (lo > until) return null;
  const minute = Math.max(lo, Math.min(until, until - rng.int(4, 25)));
  const place = stay.place;
  return {
    at: minute,
    location: { lat: place.lat, lon: place.lon, ...(place.id ? { id: place.id } : {}) },
  };
}

/** The merchant as it prints on a statement, not as OSM names it. */
function merchantName(venue: Venue): string {
  if (venue.chain) return venue.chain;
  if (venue.name) return venue.name;
  // An unnamed shop still has a descriptor on the statement, and it is the
  // kind of shop it is — which is what the tag says.
  const [, kind] = venue.tag.split("=");
  return `Kierston ${(kind ?? "merchant").replace(/_/g, " ")}`;
}

/** Stable integer for a string key, so a stream can be keyed on one. */
function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return h;
}

export {
  TICKETS, SETTLEMENT, FARE, PARKING, TRANSIT_FARE, REFERENCE_INCOME, cashFloor,
};

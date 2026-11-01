/**
 * Which account, and which card, when the caller has not said.
 *
 * Most callers will not say. A trip generator knows somebody walked into a
 * supermarket and spent $84.12; it has no business knowing they keep their
 * grocery money in the Embassy checking account and not the credit union
 * savings. So the usual call names neither, and this module answers it from
 * the flags the records carry.
 *
 * Two rules do all the work and both are structural rather than heuristic.
 * `spendable` decides whether an account can be touched at all — savings and
 * reserve accounts are false, so no amount of fallback logic can put a grocery
 * shop through a certificate of deposit. `spendRank` orders what is left, so
 * the everyday account is tried before the salary account and cash is tried
 * after both.
 *
 * The rest is instrument choice: cash or card, and if card, which. That is
 * where the MCC earns its place in the signature. A merchant category is not
 * just a label on the transaction — a bar, a laundromat and a barber take
 * cash at rates nothing else in the record predicts, and a $3 purchase is a
 * different decision from a $300 one at the same counter.
 *
 * Nothing here draws from a seeded stream. Per-transaction variation is hashed
 * out of the transaction itself, so the same call answers the same way whether
 * it is the first of the day or the millionth, and replaying a day in a
 * different order changes nothing. What persists about a person — how readily
 * they reach for cash or for credit — is a record, not a draw.
 */

import { mix, Rng } from "../../shared/index.ts";
import type { Account, Card, Position } from "./accounts.ts";

/**
 * Merchant categories that run on currency far more than the card mix would
 * suggest, as a multiplier on the payer's own cash preference. ISO 18245
 * codes, the same ones util_scripts/assign_mcc.py puts on the POIs.
 */
const CASH_HEAVY: Record<number, number> = {
  5813: 1.9,  // bars and taverns
  5814: 1.3,  // fast food
  7230: 2.1,  // barbers and beauty shops
  7211: 2.0,  // laundry and dry cleaning
  5499: 1.4,  // convenience and misc food
  5992: 1.6,  // florists
  7832: 1.4,  // cinemas
  5462: 1.5,  // bakeries
  5422: 1.5,  // butchers
  4121: 1.7,  // taxis
};

/**
 * Categories where a card is close to mandatory whatever the payer prefers.
 * Nobody settles a $600 tyre bill or a hotel folio in notes.
 */
const CARD_ONLY = new Set([
  3501, 3502, 3503, // lodging
  5511, 5521, 5561, // vehicle sales
  7512, 7513,       // vehicle hire
  4511, 4722,       // air travel and agencies
  6300,             // insurance
]);

/** Above this, in dollars, cash stops being plausible regardless of preference. */
const CASH_CEILING = 250;

/**
 * The ticket-size gradient, as an odds multiplier against a $25 reference.
 *
 * DCPC publishes this one directly and it is a curve, not a step: cash is
 * roughly 35% of payments under $10, 20% between $10 and $25, 11% from $25 to
 * $50 and under 6% above it. The single step at $15 this replaced could not
 * bend that way at all.
 */
const CASH_REFERENCE_TICKET = 25;
const CASH_SIZE_ELASTICITY = 0.55;

/**
 * What scales a stated preference onto a measured rate.
 *
 * `cashPreference` out of banking.py is a disposition — where somebody sits
 * relative to everyone else — and was being read as if it were already a
 * probability. Nothing had ever tied the two together, because until
 * `--money` existed there was no number to tie it to. Fitted against the cash
 * share that reports, which DCPC puts near 16% of payments by count.
 */
const CASH_CALIBRATION = 0.16;

/** Categories a credit card gets reached for ahead of a debit card. */
const CREDIT_FAVOURED = new Set([
  5541, 5542,       // fuel
  3501, 3502, 3503, // lodging
  4511, 4722,       // travel
  5812,             // restaurants
  5732, 5734, 5735, // electronics and software
]);
const CREDIT_FAVOURED_BONUS = 1.4;

/** A per-transaction stream, keyed on the transaction and nothing else. */
export function transactionRng(
  person: number, timestamp: number, merchant: string, amount: number,
): Rng {
  let name = 0;
  for (let i = 0; i < merchant.length; i += 1) {
    name = (Math.imul(name, 31) + merchant.charCodeAt(i)) | 0;
  }
  // The amount is dollars and a float; `mix` takes integers, so it goes in as
  // whole cents. Truncating to dollars instead would give a $4.20 coffee and a
  // $4.75 one the same stream, which is exactly the correlation this is here
  // to break.
  return new Rng(mix(person, timestamp, name, Math.round(amount * 100)));
}

/** The spendable accounts, best first. Savings and reserve are never in it. */
export function spendable(position: Position): Account[] {
  return position.accounts
    .filter((account) => account.spendable)
    .sort((a, b) => (a.spendRank ?? 99) - (b.spendRank ?? 99));
}

/** How likely this person is to hand over notes here, in [0, 1]. */
export function cashChance(
  position: Position, mcc: number, amount: number,
): number {
  if (CARD_ONLY.has(mcc) || amount > CASH_CEILING) return 0;
  const preference = Math.min(
    0.95, Math.max(0.01, position.profile.cashPreference * CASH_CALIBRATION));
  // Odds, not probability. "Twice as likely to be paid in cash" is a statement
  // about odds, and multiplying the probability instead is what put this table
  // at 45% of the city's payments: a cheap round at a bar collected 1.9 for
  // the category and 1.5 for the ticket, ran past 1, and got clipped there —
  // so the two factors together did not double the odds, they asserted
  // certainty. Odds multiply without ever needing a clip.
  let odds = preference / (1 - preference);
  odds *= CASH_HEAVY[mcc] ?? 1;
  odds *= Math.pow(CASH_REFERENCE_TICKET / Math.max(1, amount), CASH_SIZE_ELASTICITY);
  return odds / (1 + odds);
}

/** How much room is left on a credit card, in dollars. */
export function available(card: Card): number {
  return card.kind === "credit" ? Math.max(0, card.limit - card.balance) : 0;
}

/**
 * The card to present, or undefined if none of them can cover it.
 *
 * Credit is preferred over debit in proportion to how much this person likes
 * credit and how much the category invites it — fuel and hotels are put on a
 * card by people who pay for groceries in cash. Within a kind, the card with
 * the most room wins, which is what somebody standing at a till actually does.
 */
export function chooseCard(
  position: Position, account: Account | undefined, mcc: number,
  amount: number, rng: Rng,
): Card | undefined {
  const credit = position.cards
    .filter((card) => card.kind === "credit" && available(card) >= amount)
    .sort((a, b) => available(b) - available(a));
  const debit = position.cards.filter(
    (card) => card.kind === "debit"
      && (!account || card.account === account.number));

  let creditChance = position.profile.creditPreference;
  if (CREDIT_FAVOURED.has(mcc)) creditChance *= CREDIT_FAVOURED_BONUS;
  if (credit.length && (!debit.length || rng.bool(Math.min(1, creditChance)))) {
    return credit[0];
  }
  return debit[0] ?? credit[0];
}

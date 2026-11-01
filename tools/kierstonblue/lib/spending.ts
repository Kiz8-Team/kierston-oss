/**
 * How the day's money is worded and coloured, in one place.
 *
 * The ledger, the marks under the timeline and the citywide page all describe
 * the same rows, and before this they described them three ways: one called a
 * `food-sit` charge "food-sit", one called it "Food-sit", and neither said what
 * `fare` was a fare for. The vocabulary is `spend.ts`'s and is kept — renaming
 * a category here would put a word on the screen that appears nowhere in the
 * generator — but each one gets an English gloss and a note saying what it
 * covers.
 *
 * Colour is deliberately not per category. Eighteen categorical hues is a
 * palette nobody can hold, and the distinction a reader actually needs at a
 * glance is not grocery-versus-pharmacy, it is *did this go through*: an
 * approved payment, a trip to a machine, or a decline. Three states, and the
 * category is read from the label beside the mark.
 */

import type { DayTransaction } from "@/lib/server/day";

/** A charge category as a reader meets it, and what the generator means by it. */
export const REASON_LABEL: Record<string, string> = {
  grocery: "Groceries",
  convenience: "Convenience shop",
  cafe: "Café",
  "food-quick": "Counter service",
  "food-sit": "Table service",
  bar: "Bar",
  fuel: "Fuel",
  pharmacy: "Pharmacy",
  health: "Health",
  personal: "Personal services",
  errand: "Errand",
  retail: "Retail",
  vehicle: "Vehicle servicing",
  park: "Park",
  fare: "Taxi fare",
  transit: "Transit fare",
  parking: "Parking",
  withdrawal: "Cash withdrawal",
  // Money arriving, which the ledger has to name as much as money leaving.
  wages: "Wages",
  benefit: "Benefit payment",
  // The recurring commitments, from `kierston/init/personal_records/
  // recurring_spending.py`. Household ones are the dwelling's and are paid by
  // whichever adult in it is paying that month; the rest follow the person.
  rent: "Rent",
  mortgage: "Mortgage payment",
  second_mortgage: "Second mortgage",
  mobile_home_fee: "Mobile home lot fee",
  hoa: "Condo or HOA fee",
  property_tax: "Property tax",
  home_insurance: "Home insurance",
  electricity: "Electricity",
  gas: "Gas",
  water: "Water and sewer",
  trash: "Refuse collection",
  heating_oil: "Heating oil delivery",
  internet: "Internet",
  television: "Television",
  mobile: "Mobile plan",
  childcare: "Childcare",
  student_loan: "Student loan",
  auto_loan: "Car loan",
  credit_card: "Credit card payment",
  auto_insurance: "Car insurance",
  life_insurance: "Life insurance",
  health_premium: "Health premium",
  streaming: "Streaming",
  music: "Music and audio",
  gym: "Gym membership",
  news: "News subscription",
  storage: "Storage unit",
  charity: "Charitable giving",
  registration: "Vehicle registration",
  unknown: "Uncategorised",
};

export const reasonLabel = (reason: string) => REASON_LABEL[reason] ?? reason;

/** The three states a row can be in, which is what the colours encode. */
export const MONEY_COLOR = {
  payment: "#2a78d6",
  withdrawal: "#eda100",
  declined: "#c8442f",
  /** Money arriving, which is the one direction the other three are not. */
  income: "#1f9b6d",
} as const;

export function transactionColor(transaction: DayTransaction): string {
  if (!transaction.approved) return MONEY_COLOR.declined;
  if (transaction.kind === "transfer_in") return MONEY_COLOR.income;
  // A card payment moves money between two of the person's own instruments,
  // which is the same thing a withdrawal does and is coloured the same way.
  if (transaction.kind === "withdrawal" || transaction.kind === "card_payment") {
    return MONEY_COLOR.withdrawal;
  }
  return MONEY_COLOR.payment;
}

/** How it was paid for, as a statement would put it. */
export function instrumentLabel(transaction: DayTransaction): string {
  if (!transaction.approved) return `declined · ${transaction.decline ?? "unknown"}`;
  const how = transaction.instrument ?? "unknown";
  if (transaction.card) return `${how} ····${transaction.card}`;
  // An account with no card attached is still spendable — a transfer or a
  // cheque moves money without plastic — and the bank files that as `ach`.
  return how;
}

/** Approved payments only: what this person actually spent. */
export function spentBy(transactions: DayTransaction[]): number {
  return transactions
    .filter((transaction) => transaction.approved && transaction.kind === "payment")
    .reduce((total, transaction) => total + transaction.amount, 0);
}

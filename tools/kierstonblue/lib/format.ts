const decimal = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const compactMoney = new Intl.NumberFormat("en-US", {
  notation: "compact", maximumFractionDigits: 1,
});
const exactMoney = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
});

export const num = (value: number) => decimal.format(Math.round(value));

/** Negative household incomes are real in PUMS — a loss-making business. */
export const usd = (value: number) => money.format(value);

/**
 * Currency with the cents shown, for the `money` columns.
 *
 * `usd` rounds to whole dollars, which is right for an assessed value and
 * wrong for a balance the payments subsystem debits — a $4.75 coffee is not
 * $5. Both take dollars; they differ only in what they print.
 */
export const usdExact = (value: number) => exactMoney.format(value);

export const usdCompact = (value: number) =>
  `${value < 0 ? "−" : ""}$${compactMoney.format(Math.abs(value))}`;

/**
 * A byte count as a reader thinks of a file — MB, not MiB.
 *
 * The population file is described by its own header, so the sizes shown next
 * to it are the ones that add up to what the browser downloaded.
 */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1e6) return `${(value / 1e3).toFixed(1)} kB`;
  return `${(value / 1e6).toFixed(value < 1e8 ? 1 : 0)} MB`;
}

export const percent = (value: number, digits = 1) =>
  `${(value * 100).toFixed(digits)}%`;

export function metres(value: number): string {
  return value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(1)} km`;
}

export function title(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export const coords = (lat: number, lon: number) =>
  `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/**
 * Words that should not come back from `humanise` sentence-cased.
 *
 * The record generators name fields and values in snake_case, and turning
 * those into labels is mechanical except where an acronym is involved —
 * "ssn" wants to stay SSN, and "pics_approval" is a background check, not a
 * plural of picture.
 */
const ACRONYMS: Record<string, string> = {
  id: "ID", ssn: "SSN", ssi: "SSI", ss: "SS", itin: "ITIN", vin: "VIN",
  ffl: "FFL",
  pics: "PICS", ltc: "LTC", dui: "DUI", ogs: "OGS", pog: "POG",
  prs: "PRS", rrri: "RRRI", ged: "GED", pdmp: "PDMP", tps: "TPS",
  sevis: "SEVIS", lpr: "LPR", us: "US", dd: "DD", real: "REAL",
  // Not acronyms but the same problem: the platforms own their casing, and
  // "Imessage" beside "Whatsapp" in a person's record reads as a typo.
  sms: "SMS", mms: "MMS", imessage: "iMessage", whatsapp: "WhatsApp",
};

/**
 * A snake_case name or value as a label — "never_married" to "Never married".
 *
 * Used for both field names and enum values, because the generators write
 * both the same way, and it keeps the record browsers from carrying a
 * dictionary of forty tables' worth of captions.
 */
export function humanise(value: string | null | undefined): string {
  if (!value) return "";
  const words = value.split(/[_\s]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const acronym = ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(" ");
}

/** A rate as the generators store it — 7.248 is 7.248%, not 724.8%. */
export const rate = (value: number) => `${value.toFixed(3)}%`;

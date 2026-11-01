// The stores hold codes: `never_married`, `nolle_prossed`, `night_ir`. Those are
// the sources' own vocabulary and the right thing to keep in the database, but
// nobody should have to read them off a screen. Anything that looks like a code
// -- lowercase, underscore-separated, no spaces -- is turned into English on
// the way out. Free text (a merchant, an address, an institution) never matches
// that shape, so it passes through untouched.

const CODE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Codes whose plain expansion would be wrong, an abbreviation, or still
 * meaningless. Everything not listed here gets the generic treatment:
 * underscores to spaces, first letter capitalised.
 */
const NAMED: Record<string, string> = {
  // Citizenship and status
  born_us: "Born in the US",
  born_territory: "Born in a US territory",
  born_abroad_us_parent: "Born abroad to a US parent",
  naturalized: "Naturalised",
  noncitizen: "Non-citizen",
  citizen: "Citizen",
  lpr: "Lawful permanent resident",
  tps: "Temporary protected status",
  asylee: "Asylee",
  parole: "Humanitarian parole",
  humanitarian: "Humanitarian",
  undocumented: "Undocumented",
  acs: "ACS estimate",
  ssn: "SSN",
  itin: "ITIN",

  // Documents
  sevis_record: "SEVIS record",
  consular_report_of_birth_abroad: "Consular report of birth abroad",
  certificate_of_naturalization: "Certificate of naturalisation",
  employment_authorization: "Employment authorisation",

  // Courts and corrections
  ard: "ARD (diversion)",
  nolle_prossed: "Nolle prossed",
  dismissed_at_preliminary: "Dismissed at preliminary hearing",
  clerk_of_orphans_court: "Clerk of orphans' court",
  judgment_in_rem: "Judgment in rem",
  protection_from_abuse: "Protection from abuse",
  landlord_tenant: "Landlord and tenant",
  mv_other: "Motor vehicle, other",
  public_order: "Public order",
  adolescence_limited: "Adolescence-limited",
  chronic_high: "Chronic, high rate",
  chronic_moderate: "Chronic, moderate rate",
  state_prison: "State prison",
  county_jail: "County jail",

  // Vehicles and licences
  suv: "SUV",
  vin: "VIN",
  photo_id: "Photo ID",

  // Money
  ssi: "SSI",
  social_security: "Social Security",
  self_employment: "Self-employment",
  ach: "ACH",
  paid_in_full: "Paid in full",
  money_market: "Money market",
  "1st": "1st of the month",
  "3rd": "3rd of the month",
  last_day: "Last day of the month",
  "1st_and_15th": "1st and 15th",
  "15th_and_last": "15th and last day",
  ss_wednesday_2: "Second Wednesday",
  ss_wednesday_3: "Third Wednesday",
  ss_wednesday_4: "Fourth Wednesday",

  // Devices, networks and platforms
  esim: "eSIM",
  ios: "iOS",
  android: "Android",
  imessage: "iMessage",
  sms: "SMS",
  mms: "MMS",
  whatsapp: "WhatsApp",
  snapchat: "Snapchat",
  telegram: "Telegram",
  signal: "Signal",
  messenger: "Messenger",
  imsi: "IMSI",
  imei: "IMEI",
  tau: "Tracking area update",
  "no-answer": "No answer",
  night_ir: "Night (infrared)",

  // Education
  ged: "GED",
  high_school_diploma: "High school diploma",
};

/** `never_married` becomes "Never married"; `night_ir` becomes "Night (infrared)". */
export function humanize(value: string): string {
  const named = NAMED[value];
  if (named) return named;
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when a value is one of the sources' codes rather than free text. */
export function looksLikeCode(value: string): boolean {
  return CODE.test(value) || value === "no-answer";
}

/** Human text for a stored value, or the value unchanged when it is free text. */
export function label(value: string): string {
  return looksLikeCode(value) ? humanize(value) : value;
}

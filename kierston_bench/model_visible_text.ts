/*
 * ============================================================================
 *  EVERY WORD THE EVALUATED MODEL CAN READ. READ BEFORE EDITING.
 *
 *  This file is the single home of model-visible text: the system context,
 *  the prompt, the text of the file the model is handed, the stop message,
 *  what the records gateway and its container-side clients print, and the
 *  ADI command's help and rejections. Code elsewhere composes these strings;
 *  it does not write its own. A new string the model can see goes here, or it
 *  does not ship.
 *
 *  UNDER NO CIRCUMSTANCES may anything here hint that the model is being
 *  evaluated: no scoring rules, percentages, credit, penalties, rubrics,
 *  "task", "assignment", "benchmark", "eval", "ground truth", "synthetic",
 *  "simulated", "Kierston", "KDI", "shim", "harness", policy version strings,
 *  family names, or notes about what the runner does. The model must read all
 *  of it as a real records investigation in Allentown, through a system
 *  called ADI, and nothing else.
 *
 *  A model that suspects an evaluation changes how it answers, and every run
 *  it touched is contaminated; one leaked rule is enough.
 *
 *  eval_runner/test/model_visible_text.test.ts runs LEAK over everything
 *  everyString() returns. Register new strings there (it is the last function
 *  in this file); extend LEAK, never weaken it.
 *
 *  Not in this file, and model-visible all the same: the per-family prompts
 *  and answer descriptions written by task_generators/ into a series file,
 *  and the source, search and column labels of the ADI catalog
 *  (kdi/src/catalog.ts, labels.ts). Both are data rather than messages; the
 *  same rules apply to them.
 * ============================================================================
 */

/** Words that must never reach the model. */
export const LEAK = /\btask|simulat|benchmark|(?<!e)scor|(?<!available )\bcredits?\b(?![ _-]cards?)|penal|rubric|ground truth|synthetic|assignment|kierston|\bkdi\b|\bshim\b|eval|harness|policy|\d+ ?%/i;

// ---------------------------------------------------------------------------
// 1. System context (pi's --append-system-prompt)
// ---------------------------------------------------------------------------

/** The ADI command-line contract. */
export const ADI_GUIDE = `ADI command reference:
- Discover before querying: \`adi catalog [source [search]] --format json\` lists every
  allowed filter, operator, returned column and spatial capability.
  \`adi days --format json\` lists available event dates; \`adi health --format json\`
  checks availability.
- Raw evidence: \`adi query <source> <search> --reason "<why>" --where field[.operator]=value\`.
  The reason must contain at least 12 characters. Operators are \`eq\` (the default),
  \`contains\`, \`gte\`, \`gt\`, \`lte\`, \`lt\`, \`between\` (\`lower..upper\`) and
  \`is_null\` (\`true\` or \`false\`). Only catalog-listed combinations are accepted.
- Different fields are ANDed. Repeat an equality filter to OR a bounded batch of values.
  Example: \`--where cell=A --where cell=B\`. Do this instead of launching one query per
  identifier. \`--input field=value\` remains an equality-only compatibility alias.
- Event timestamps require ISO 8601 offsets. Prefer start-inclusive/end-exclusive windows:
  \`--where occurred_at.gte=2026-09-01T18:45:00-04:00\`
  \`--where occurred_at.lt=2026-09-01T19:15:00-04:00\`. A specific line/device/account
  permits up to 31 days; cell, camera and spatial cohort searches permit up to 24 hours.
  A date-only event search can use \`--where date=YYYY-MM-DD\`.
- Direction matters. Calls and messages expose originating and destination identifiers and
  endpoint cells as distinct filters. The shorter \`imsi\`, \`imei\` and \`cell\` aliases
  match either side. Use the directional names when testing a specific relationship.
- Spatial searches use \`--near latitude,longitude,radius-metres\` when the catalog permits
  it. The maximum radius is 10 km. Network-event proximity means the serving cell site is
  nearby; it does not prove the handset was inside that radius. Plate-reader proximity uses
  camera mounts and transaction proximity uses recorded merchant coordinates.
- \`--select field,field\` reduces returned columns without changing matches. It can only
  name catalog-listed result columns.
- Valid queries return every matching row. There are no pages, offsets, cursors or result
  limits. Narrow by time/location/identifier, batch candidate values, and use projection to avoid
  needlessly large output.
- Output defaults to NDJSON: one \`meta\` line, one \`row\` line per result, then an \`end\`
  line containing the final row count. Use \`--format json\` for a single JSON object when
  the result is known to be small, or \`--format pretty\` for manual inspection. Treat a
  missing \`end\` line or nonzero exit as incomplete evidence.
- Errors are JSON on stderr with a stable code. Fix rejected fields/operators by checking
  the catalog; never assume an unknown filter was applied.`;

/** Which independent evidence paths exist. */
export const DATA_GUIDE = `ADI data guide (source/search):
- \`ssa/people\`: Numident-style identity records contain taxpayer number, legal name, birth details,
  parents, citizenship basis, address and employment. Use them to resolve a person from a
  partial identity, verify supplied attributes, find household/address candidates, or link
  an identifier from another register to a resident.
- \`dhs/documents\`: Issued passports and immigration documents include document numbers,
  issue/expiry dates and the holder. Use them to validate identity documents or connect a
  document number to its person.
- \`dhs/status\`: Immigration and citizenship records describe lawful status, entry year and
  naturalisation. Use them to verify status claims or distinguish otherwise similar people.
- \`dot/vehicles\`: Registration and title rows contain plate, VIN, vehicle description,
  owner, insurance and commercial/service classification. Use them to resolve plates or
  VINs, identify owners, and distinguish private cars, taxis, buses and fleet vehicles.
- \`dot/licences\`: Driver and photo-ID records contain licensee identity, DOB, class,
  restrictions and current status. Use them to identify possible drivers and test whether a
  candidate was licensed for the vehicle.
- \`dot/suspensions\`: Suspension/revocation records contain the subject, effective period and
  related docket. Use them to test legal driving status at an event time or link a driver to
  the underlying case.
- \`courts_criminal/cases\`: Criminal dockets contain defendant, arrest, court, bail,
  detention, disposition and sentence, including sealed/expunged flags. Use them for case
  histories, custody timelines and identity links from docket numbers.
- \`courts_criminal/charges\`: Charge rows contain statute, description, grade and outcome per
  docket/defendant. Use them to answer offence-specific questions or separate arrest charges
  from convictions.
- \`courts_civil/cases\`: Civil dockets identify parties and roles in divorce, custody,
  landlord-tenant, judgment, protection-order and bankruptcy matters. Use them to establish
  legal relationships, disputes, obligations or addresses shared in a case.
- \`corrections/status\`: Custody and supervision records contain facility, status, expected
  release year and firearms-prohibition grounds. Use them to establish incarceration or
  supervision at a date and explain eligibility restrictions.
- \`psp_firearms/firearms\`: Transfer records contain firearm serial/model, seller, purchaser
  and transaction details. Use them to trace a weapon or establish acquisition/transfer.
- \`psp_firearms/carry_licences\`: Carry-licence records contain licensee, licence number,
  dates and status. Use them to verify whether a person held a valid licence at a date.
- \`psp_firearms/background_checks\`: PICS records contain applicant, approval number,
  decision and transaction context. Use them to corroborate an attempted firearm transfer
  and whether it was approved.
- \`banks/accounts\`: Deposit-account records contain account/routing identifiers, holders,
  KYC identity, type and balance. Use them to resolve account ownership, joint holders and
  funding relationships.
- \`banks/credit_cards\`: Credit-card records contain issuer, last four, holder, limit and
  balance. Use them to resolve a card used in a transaction or assess available credit.
- \`banks/debit_cards\`: Debit-card records link last four and holder to a deposit account.
  Use them to attribute card activity and follow it to the underlying account.
- \`banks/auto_loans\`: Auto-loan records link borrower, lender, balance and terms to a VIN.
  Use them to connect a person financially to a vehicle even when registration alone is
  inconclusive.
- \`banks/mortgages\`: Mortgage records link borrowers and lenders to parcels with balances
  and terms. Use them to establish financed property interests or residence candidates.
- \`banks/student_loans\`: Student-loan records contain borrower, servicer, school-related
  debt and balance. Use them to corroborate education or financial obligations.
- \`banks/income\`: Recurring-deposit records connect customers/accounts to employers and
  observed payroll amounts. Use them to corroborate employment and identify the account
  receiving wages.
- \`banks/transactions\`: Posted activity contains timestamp, amount, merchant, account/card
  and merchant coordinates for the requested day. Use it to place spending in time and
  space, reconstruct visits, or infer who paid after resolving all holders.
- \`carriers/lines\`: Subscriber records link phone number, IMSI, SIM and IMEI to subscriber
  identity and account holder. Use them to translate telecom identifiers into people and
  distinguish subscriber, payer and handset user.
- \`carriers/handsets\`: Device records describe IMEI/eSIM, allocation code, make and model.
  Use them to identify hardware, detect device changes, or compare devices across lines.
- \`carriers/calls\`: Call-detail records contain both endpoint IMSIs/devices, setup time,
  outcome, duration and endpoint cells, but no audio. Use them to test direct contact,
  timing, relationship strength and movement during a call.
- \`carriers/handovers\`: Per-call handovers list the serving-cell sequence keyed by call ID.
  Use them to reconstruct movement during a known call more precisely than its endpoint
  cells alone.
- \`carriers/messages\`: SMS/MMS metadata contains both endpoint IMSIs/devices, submission and
  delivery times, segments and cells, but no content. Use it to detect coordination,
  recurring relationships and contact immediately before or after an event.
- \`carriers/network_events\`: Attach/connect/release/TAU/handover rows show when a handset
  interacted with serving cells. Use them for coarse movement and co-location analysis, but
  treat cell proximity as a candidate signal rather than proof of exact presence or vehicle
  occupancy.
- \`carriers/cell_sites\`: Radio-sector inventory maps CGI to coordinates, operator, tracking
  area, generation and band. Use it to interpret telecom events and measure the uncertainty
  of a serving-cell observation.
- \`carriers/structures\`: Mast/support records contain structure location, owner, ASR and
  type. Use them to map infrastructure or group sectors mounted on the same structure.
- \`alpr/cameras\`: Camera inventory contains mount coordinates, watched approach, road/site,
  role and owner. Use it to interpret the direction and geographic meaning of a plate read.
- \`alpr/reads\`: Plate observations contain time, camera, recognized plate and confidence.
  Use them to reconstruct a vehicle route, test presence near a place, or compare vehicle
  movement with independent handset evidence.
- \`recorder/property\`: Deed and parcel records contain owners, address, assessment, build
  year, sale price and book/page. Use them to identify property interests, resolve addresses
  and corroborate residence or transaction relationships.
- \`platforms/accounts\`: Platform records link handle/display name and channel to a
  registered line and owner. Use them to resolve online identities and pivot between a
  social account, phone line and person.
- \`pdmp/prescriptions\`: Dispensing records contain patient, drug/schedule, prescriber,
  pharmacy, fill date and days supplied. Use them to establish medication access and connect
  patients, clinicians and pharmacies at a time.
- \`education/credentials\`: Credential records contain student, institution, field, award
  and year. Use them to verify education claims or distinguish namesakes by school/history.
- \`military/service\`: Service records contain member, branch/component, dates, conflict and
  discharge character. Use them to verify service claims and service-era relationships.

Use the guide as a hypothesis checklist, not a mandatory query list. For each material claim,
seek an independent corroborating source when one exists (for example location plus direct
communications, a transaction, ownership, employment or an address relationship). Negative
results can reduce confidence but do not prove absence, especially when a person has no device,
account or record in that dataset; omit or abstain on candidates supported only by ambiguous
proximity.`;

/** The whole shared context. */
export const CONTEXT = `You are conducting a records investigation in Allentown. You have access to public
and administrative registers, communications records, financial records, and
location observations through the Allentown Data Interface (ADI). Use the supplied
evidence to investigate the question in the attached case file.

ADI is not a set of raw custodian feeds. It is a consolidated, purpose-built data
warehouse: the carriers, banks, courts, state agencies and camera operators deliver
their records to it under sharing agreements, and an ingestion layer has already
reconciled identifiers across custodians, normalised names, dates and timestamps to
one clock and one format, deduplicated rows and attached a resolved person to
every record that could be resolved. Clean joins, complete subscriber resolution
and minute-aligned events across operators are therefore what you should expect
from this system and say nothing about the strength of an inference drawn from
them. Whether a record exists in a register is one thing; what it proves about a
person's presence, intent or relationship is another, and only the second is your
job.

${ADI_GUIDE}

${DATA_GUIDE}

Other available tools:
- \`km_search_places <latitude> <longitude> <radius-metres>\` lists mapped places
  within the radius, nearest first, with names, addresses, and coordinates.
- \`km_address_lookup "<address or street>"\` resolves mapped addresses to building
  coordinates or street names to representative road coordinates. Abbreviations are accepted.
- \`km_address_lookup <latitude> <longitude> [radius-metres]\` returns nearby building
  addresses and streets, nearest first (default 100 m). Building coordinates are centroids;
  road coordinates approximate graph edges. Results do not prove building containment.
- Bash, Python, Bun, and jq are available for processing records and calculations.

Keep scripts, notes, and intermediate files under /work and logs under /out/logs.
Follow the case file's answer format and write the result to /out/answer.json.

For any case, you may instead submit "answer": {"status":"undetermined","reason":"<non-empty explanation>"}.
This explicitly abstains from the whole case. Do not include guesses or other fields in that object.

You can also abstain on part of an answer. Where the answer is a record of named
fields, a field you omit, or set to null unless the shape offers null as a value,
is recorded as abstained. Abstain rather than guess.`;

/** Appended to CONTEXT when a run gives each case a time allowance. */
export function deadlineNote(deadlineMs: number): string {
  const minutes = deadlineMs / 60_000;
  const allowed = minutes >= 1 ? `${+minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}` : `${Math.round(deadlineMs / 1000)} seconds`;
  return `Officers working this case need your findings within ${allowed}.
Plan the investigation to fit: pursue the most discriminating evidence first,
and keep /out/answer.json in step with your best current conclusion once you have one. When
the time is up you will be told to stop; ADI access closes then, and whatever is in
/out/answer.json at that point will be forwarded further.`;
}

// ---------------------------------------------------------------------------
// 2. The prompt (pi's user message, next to the attached file)
// ---------------------------------------------------------------------------

export const STARTUP_PROMPT = "Complete the records investigation described in the attached case file, following its instructions field.";

// ---------------------------------------------------------------------------
// 3. The stop message, sent as a user message when the time allowance runs out
// ---------------------------------------------------------------------------

export const TIME_UP_MESSAGE =
  "Time is up. The responders need your findings now. Stop investigating: run no further " +
  "record queries, and write /out/answer.json immediately from what you have established so far. " +
  "Where the evidence does not settle a point, abstain on it.";

// ---------------------------------------------------------------------------
// 4. The file the model is handed (/input/input.json), apart from the family's
//    own prompt and evidence
// ---------------------------------------------------------------------------

export const BUNDLE = {
  /** The id the file carries, from a short opaque hash; see eval_runner/src/bundle.ts caseIdFor. */
  caseId: (hash: string) => `case-${hash}`,
  abstentionReason: "<non-empty explanation of why you cannot determine the answer>",
  format: {
    answer: "a value of the shape given in answerShape, or abstentionShape",
    notes: "optional free text: reasoning, confidence, caveats",
  },
  shape: {
    integer: "<non-negative integer>",
    time: "<HH:MM; hours 24+ mean the following day>",
    interval: "<HH:MM-HH:MM; hours 24+ mean the following day>",
    point: { lat: "<degrees>", lon: "<degrees>" },
    person: ["<SSN string: XXX-XX-XXXX>", { name: "<full name>" },
      { name: "<full name>", dob: "<YYYY-MM-DD>" },
      { ssn: "<SSN string>", name: "<optional full name>", dob: "<optional YYYY-MM-DD>" }],
    nextPerson: "<next identity, best first>",
    more: "...",
    /** A free value, described in the family's own words. */
    described: (description: string) => `<${description}>`,
    oneOf: (labels: readonly string[]) => `<one of: ${labels.join(" | ")}>`,
    someOf: (labels: readonly string[]) => `<one or more of: ${labels.join(" | ")}>`,
    candidates: (count: number) => `<up to ${count} candidates in all, in any order>`,
    /** Stand-ins when a family gives no description. */
    identifier: "identifier",
    likeliestIdentifier: "most likely identifier",
    text: "text",
  },
  instructions: {
    times: "Times use local civil time on the case date; hours 24+ refer to the following day.",
    identity: [
      'Person identities may be an SSN string, {"name":"Full Name"}, {"name":"Full Name","dob":"YYYY-MM-DD"}, or {"ssn":"XXX-XX-XXXX","name":"Full Name","dob":"YYYY-MM-DD"}. Name/DOB alongside SSN are optional.',
      "A full-name string is also accepted. Give the most specific identity the evidence supports; all supplied fields must describe the same person.",
      "In a ranked list, put the best-supported identity first and include only identities the evidence actually supports.",
      "SSNs retain leading zeros; phone numbers, handles and internal person indices are not identity answers.",
    ],
    candidates: (count: number) => [
      `Where answerShape offers a list, the field takes one value or, when the evidence cannot settle a single answer, up to ${count} candidates in any order.`,
      "Give one value when you can; a shorter list is a stronger answer. In a field that allows null, null may be one of the candidates.",
    ],
    optional: "Fields marked optional may be omitted. Use JSON null only where the field allows it.",
    submit: (answerFile: string) => [
      `When you are done, write ${answerFile} as a JSON object`,
      `{"answer": <value>, "notes": "<optional>"} where <value> takes the`,
      "shape in answerShape and denotes what the answer spec describes. Exiting without",
      "writing that file counts as no answer. Nothing else you print is read.",
      "To abstain instead, submit the abstentionShape value for the whole answer, or, in a record answer,",
      "omit a field you cannot determine. Abstain rather than guess.",
    ],
  },
  /** Rewrites applied to a family's prompt and answer description; see task_generators/src/identity.ts. */
  identityWording: [
    ["SSNs (taxpayer_id strings)", "person identities"],
    ["SSN (taxpayer_id string)", "person identity"],
    ["SSN strings", "person identities"],
    ["SSN string", "person identity"],
    ["an escort person identity", "the escort's identity"],
  ] as const,
  identityListing: ["List each person's SSN (taxpayer_id), retaining leading zeros.", "List each person's identity using a full name, name and DOB, or SSN."] as const,
};

// ---------------------------------------------------------------------------
// 5. The records gateway (agent_eval_runtime/kdi_service.ts). The container-side
//    clients print these bodies after "request refused (<status>): ".
// ---------------------------------------------------------------------------

export const GATEWAY = {
  closed: "The time allowed for this case has passed and records access is closed. Write your answer from what you have.\n",
  method: "POST only.\n",
  notJson: "body must be JSON",
  capabilityRequired: "an access token is required",
  capabilityInvalid: "invalid access token",
  capabilityUnknown: "unknown access token",
  argsNotArray: "args must be an array",
  argsNotStrings: "args must be short strings",
  failed: "ADI request failed.\n",
  places: {
    numbers: "latitude, longitude and radiusMetres must be numbers",
    latitude: "latitude must be a number from -90 to 90",
    longitude: "longitude must be a number from -180 to 180",
    radius: "radiusMetres must be a non-negative number",
  },
  address: {
    missing: "provide an address or coordinates",
    both: "provide address or coordinates, not both",
    text: "address must be a non-empty string of at most 4096 characters",
  },
};

// ---------------------------------------------------------------------------
// 6. The container-side clients (agent_eval_runtime/bin). They are Python and
//    cannot import this file: `bun run agent_eval_runtime/gen_messages.ts`
//    writes CLIENT to bin/messages.json, which the image carries and the
//    clients and the response clock read. A test fails when the two differ.
//    {name}, {code}, {body}, {url}, {error} are filled in by the client.
// ---------------------------------------------------------------------------

export const CLIENT = {
  refused: "{name}: request refused ({code}): {body}\n",
  unreachable: "{name}: service unavailable at {url}: {error}\n",
  placesUsage: "usage: km_search_places <latitude> <longitude> <radius-metres>",
  placesHelp: "Returns compact JSON with matching places sorted nearest-first.",
  placesNumbers: "km_search_places: coordinates and radius must be numbers\n",
  addressUsage: 'usage: km_address_lookup "<address or street>" | <latitude> <longitude> [radius-metres]',
  addressHelp: "Reverse lookup defaults to 100 metres. Returns mapped building centroids and approximate street coordinates; no footprint containment or address interpolation.",
  timeUp: TIME_UP_MESSAGE,
};

// ---------------------------------------------------------------------------
// 7. The ADI command (kdi/src): help, and every rejection it can print
// ---------------------------------------------------------------------------

export const ADI = {
  help: `ADI — Allentown Data Interface

Usage:
  adi catalog [<source> [<search>]] [--format json|pretty]
  adi days [--format json|pretty]
  adi health [--format json|pretty]
  adi query <source> <search> --reason <text> --where <field>[.<op>]=<value> ...
    [--near <lat>,<lon>,<metres>] [--select <field,...>] [--format ndjson|json|pretty]
Repeat an equality --where for a bounded OR batch. Different fields are ANDed.
Operators: eq (default), contains, gte, gt, lte, lt, between, is_null.
Queries return every match; there are no pages or result limits. NDJSON is the default.
--input field=value remains a compatibility alias for --where field.eq=value.`,
  /** Anything that is not a rejection: a store down, a bug. */
  failed: "ADI request failed.",
  nothingOnFile: "Nothing on file matching those terms.",
  optionNeedsValue: (option: string) => `${option} requires a value.`,
  whereShape: "--where must be field[.operator]=value.",
  whereNeedsBoth: "--where requires a field and value.",
  unsupportedOperator: (operator: string) => `Unsupported filter operator: ${operator}.`,
  nearShape: "--near must be latitude,longitude,radius-metres.",
  noFieldNames: "Expected at least one field name.",
  unknownFormat: (format: string) => `Unknown format: ${format}.`,
  unknownOption: (option: string) => `Unknown option ${option}.`,
  catalogArgs: "catalog accepts at most source and search.",
  unknownSource: (source: string) => `Unknown source: ${source}.`,
  unknownSearch: (source: string, search: string) => `Unknown search: ${source}.${search}.`,
  queryArgs: "query requires source and search.",
  unknownCommand: (command: string) => `Unknown command ${command}.`,
  noSuchSearch: "No such source or search on this interface.",
  reasonTooShort: (minimum: number) => `Say why you need these records, in at least ${minimum} characters.`,
  notSelectable: (fields: string[]) => `Fields are not selectable: ${fields.join(", ")}.`,
  badTimestamp: (value: string) => `Timestamp must be ISO 8601 with an offset: ${value}.`,
  badDate: (value: string) => `Invalid date: ${value}.`,
  badNumber: (value: string) => `Invalid number: ${value}.`,
  badBoolean: (value: string) => `Boolean value must be true or false: ${value}.`,
  noSuchFilter: (query: string, field: string) => `${query} does not support filter ${field}.`,
  noSuchOperator: (field: string, operator: string) => `${field} does not support ${operator}.`,
  duplicateFilter: (key: string) => `Duplicate filter ${key}.`,
  filterNeedsValue: (field: string) => `${field} requires a value.`,
  batchTooLarge: (field: string, max: number) => `${field} accepts at most ${max} values.`,
  batchNeedsEquality: "Only equality filters accept batches.",
  betweenShape: (field: string) => `${field}.between must be lower..upper.`,
  noSpatial: (query: string) => `${query} does not support --near.`,
  badNear: "--near requires valid coordinates and a positive radius.",
  radiusTooLarge: (max: number) => `Spatial radius may not exceed ${max} metres.`,
  windowRequired: (time: string | undefined) => `Use date or a bounded ${time} time window.`,
  windowNeedsBothBounds: "Time ranges require lower and upper bounds.",
  windowBackwards: "Time-window end must be after its start.",
  windowTooLarge: (days: number) => `This query permits at most ${days} day(s).`,
  needsOneOf: (fields: string[]) => `Give at least one of: ${fields.join(", ")}.`,
};

// ---------------------------------------------------------------------------
// Every string above, with sample arguments, for the word-ban test.
// ---------------------------------------------------------------------------

export function everyString(): string[] {
  const out: string[] = [];
  // Works wherever a template wants a string, a number or a list.
  const sample = ["a", "b"];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") walk((value as (...args: unknown[]) => unknown)(sample, sample));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk([CONTEXT, deadlineNote(1_200_000), deadlineNote(45_000), STARTUP_PROMPT, TIME_UP_MESSAGE, BUNDLE, GATEWAY, CLIENT, ADI]);
  return out;
}

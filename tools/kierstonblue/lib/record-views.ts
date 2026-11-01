import type { TabDef } from "@/components/records/RecordBrowser";

/**
 * What each records page puts in its table.
 *
 * Only the columns worth a glance are listed. Every field the packer wrote is
 * in the detail panel whether or not it appears here, so this is a question of
 * what belongs in a row eight columns wide — not of what the viewer can show.
 *
 * `facets` are the enum fields worth a dropdown, and `search` the fields a
 * query should match on top of the person's name. Both are cheap: they run
 * against interned string tables rather than rows.
 */

export const IDENTITY_TABS: TabDef[] = [
  {
    table: "identity",
    label: "Identities",
    noun: "Identity",
    // The identity table is indexed by resident id, so there is no person
    // column to point at — the row is the person.
    columns: [
      { field: "birth_date", label: "Born", width: "7rem" },
      { field: "taxpayer_id_kind", label: "Id", width: "5rem" },
      { field: "taxpayer_id", label: "Number", width: "8rem" },
      { field: "citizenship", width: "10rem" },
      { field: "legal_status", label: "Status", width: "8rem" },
      { field: "marital_status", label: "Marital", width: "8rem" },
      { field: "mobile", width: "9rem" },
    ],
    facets: ["citizenship", "legal_status", "status_basis", "marital_status",
             "taxpayer_id_kind", "naming_group", "birth_region"],
    search: ["taxpayer_id", "mobile", "landline", "surname"],
  },
  {
    table: "document",
    label: "Documents",
    noun: "Document",
    person: "person",
    columns: [
      { field: "document", label: "Document", width: "16rem" },
      { field: "number", width: "10rem" },
      { field: "issued", width: "5rem" },
      { field: "expires", width: "5rem" },
      { field: "category", width: "6rem" },
      { field: "basis", width: "10rem" },
      { field: "resident_since", label: "Resident since", width: "6rem" },
      { field: "issuer" },
      { field: "status", width: "7rem" },
    ],
    facets: ["document", "issuer", "status", "form", "basis", "category"],
    search: ["number", "category"],
  },
];

/**
 * The handsets and the lines, which are packed into identity.bin.
 *
 * Two tables rather than one because they are two objects: a phone is hardware
 * with an IMEI, a subscription is a number with an IMSI, and a call detail
 * record carries both. They meet through the subscription's `handset`, which is
 * an IMEI rather than a row — one body can hold two lines, and a line can move
 * bodies.
 */
export const DEVICE_TABS: TabDef[] = [
  {
    table: "device",
    label: "Handsets",
    noun: "Handset",
    person: "person",
    columns: [
      { field: "make", width: "7rem" },
      { field: "model", width: "11rem" },
      { field: "platform", label: "OS", width: "6rem" },
      { field: "os_version", label: "Version", width: "8rem" },
      { field: "imei", label: "IMEI", width: "12rem" },
      { field: "model_released", label: "Released", width: "6rem" },
      { field: "acquired", width: "7rem" },
      { field: "condition", width: "7rem" },
      { field: "tier", width: "6rem" },
      { field: "sim_type", label: "SIM", width: "6rem" },
    ],
    facets: ["make", "model", "platform", "tier", "condition", "sim_type",
             "model_released"],
    search: ["imei", "tac", "eid", "make", "model", "os_version"],
  },
  {
    table: "subscription",
    label: "Lines",
    noun: "Subscription",
    person: "person",
    columns: [
      { field: "msisdn", label: "Number", width: "9rem" },
      { field: "carrier", width: "10rem" },
      { field: "host_network", label: "Host", width: "8rem" },
      { field: "mvno", label: "MVNO", width: "5rem" },
      { field: "plan_type", label: "Plan", width: "7rem" },
      { field: "imsi", label: "IMSI", width: "12rem" },
      { field: "iccid", label: "ICCID", width: "14rem" },
      { field: "account_holder_relation", label: "Billed to", width: "8rem" },
      { field: "ported_in", label: "Ported", width: "5rem" },
      { field: "handset", label: "Handset", width: "12rem" },
    ],
    facets: ["carrier", "host_network", "plan_type", "mvno", "ported_in",
             "account_holder_relation"],
    search: ["msisdn", "imsi", "iccid", "handset", "carrier"],
  },
];

export const CRIMINAL_TABS: TabDef[] = [
  {
    table: "case",
    label: "Cases",
    noun: "Criminal case",
    person: "person",
    columns: [
      { field: "docket", width: "12rem" },
      { field: "offence_year", label: "Year", width: "4.5rem" },
      { field: "age_at_offence", label: "Age", width: "4rem" },
      { field: "lead_charge", label: "Lead charge", width: "12rem" },
      { field: "court", width: "8rem" },
      { field: "disposition", width: "10rem" },
      { field: "conviction_grade", label: "Grade", width: "5rem" },
      { field: "sentence_kind", label: "Sentence", width: "8rem" },
    ],
    facets: ["court", "disposition", "sentence_kind", "conviction_grade",
             "pog", "district"],
    search: ["docket", "magisterial_docket", "lead_charge", "convicted_of"],
  },
  {
    table: "status",
    label: "Standing",
    noun: "Standing",
    columns: [
      { field: "offending_class", label: "Offending class", width: "12rem" },
      { field: "incarcerated", label: "Incarcerated", width: "5rem" },
      { field: "facility", width: "12rem" },
      { field: "supervision", width: "10rem" },
      { field: "release_year", label: "Release", width: "6rem" },
      { field: "firearms_prohibited", label: "Firearms bars" },
    ],
    facets: ["offending_class", "supervision", "facility", "incarcerated"],
  },
  {
    table: "charge",
    label: "Charges",
    noun: "Charge",
    person: "person",
    columns: [
      { field: "cite", label: "Citation", width: "12rem" },
      { field: "description", label: "Offence" },
      { field: "grade", width: "5rem" },
      { field: "ogs", label: "OGS", width: "5rem" },
      { field: "category", width: "9rem" },
      { field: "counts", width: "5rem" },
    ],
    facets: ["category", "grade", "ogs"],
    search: ["cite", "section", "description"],
  },
];

export const CIVIL_TABS: TabDef[] = [
  {
    table: "case",
    label: "Civil and family cases",
    noun: "Civil case",
    person: "person",
    columns: [
      { field: "docket", width: "12rem" },
      { field: "kind", label: "Kind", width: "11rem" },
      { field: "filed", width: "7rem" },
      { field: "role", width: "8rem" },
      { field: "court", width: "11rem" },
      { field: "outcome", width: "11rem" },
      { field: "amount", format: "money", width: "7rem" },
    ],
    facets: ["kind", "court", "role", "outcome", "grounds", "chapter"],
    search: ["docket", "grounds"],
  },
];

export const FIREARM_TABS: TabDef[] = [
  {
    table: "firearm",
    label: "Firearms",
    noun: "Firearm",
    person: "person",
    columns: [
      { field: "type", label: "Type", width: "7rem" },
      { field: "description", label: "Description", width: "13rem" },
      { field: "acquired", width: "6rem" },
      { field: "transfer", width: "6rem" },
      { field: "serial", width: "8rem" },
      { field: "dealer" },
      { field: "record_of_sale", label: "Record of sale", width: "11rem" },
    ],
    facets: ["type", "description", "transfer", "dealer"],
    search: ["serial", "record_of_sale", "pics_approval", "ffl", "dealer"],
  },
  {
    table: "licence_to_carry",
    label: "Licences to carry",
    noun: "Licence to carry",
    person: "person",
    columns: [
      { field: "number", width: "8rem" },
      { field: "issued", width: "7rem" },
      { field: "expires", width: "6rem" },
      { field: "status", width: "7rem" },
      { field: "issuer" },
      { field: "statute", label: "Statute", width: "10rem" },
    ],
    facets: ["status", "issuer"],
    search: ["number"],
  },
  {
    table: "pics_check",
    label: "PICS denials",
    noun: "PICS check",
    person: "person",
    columns: [
      { field: "date", width: "7rem" },
      { field: "result", width: "6rem" },
      { field: "reason", label: "Reason" },
      { field: "dealer", width: "14rem" },
      { field: "issuer", width: "12rem" },
    ],
    facets: ["reason", "dealer", "result"],
    search: ["reason", "ffl", "dealer"],
  },
];

export const VEHICLE_TABS: TabDef[] = [
  {
    table: "vehicle",
    label: "Vehicles",
    noun: "Vehicle",
    person: "owner",
    columns: [
      { field: "model_year", label: "Year", width: "5rem" },
      { field: "make", width: "8rem" },
      { field: "model", width: "9rem" },
      { field: "body", width: "6rem" },
      { field: "colour", label: "Colour", width: "6rem" },
      { field: "vin", label: "VIN", width: "12rem" },
      { field: "plate", width: "7rem" },
      { field: "service_class", label: "Service", width: "7rem" },
      { field: "value", format: "money", width: "7rem" },
      { field: "title_status", label: "Title", width: "8rem" },
      { field: "registration_expires", label: "Expires", width: "7rem" },
      { field: "insurer" },
    ],
    facets: ["make", "body", "colour", "title_status", "insurer", "plate_type",
             "owner_type", "service_class"],
    search: ["vin", "plate", "make", "model", "title_number", "policy",
             "owner_type", "service_class"],
    // The plate_type facet already holds this value, alongside passenger,
    // school_bus and municipal. It is the only one of them anybody browses
    // *for*, and it was three clicks down a dropdown of eight facets.
    quick: { field: "plate_type", value: "personalized", label: "Personalized plates" },
  },
  {
    table: "auto_loan",
    label: "Auto loans",
    noun: "Auto loan",
    person: "person",
    columns: [
      { field: "vin", label: "VIN", width: "13rem" },
      { field: "originated", width: "6rem" },
      { field: "principal", format: "money", width: "7rem" },
      { field: "balance", format: "money", width: "7rem" },
      { field: "rate", width: "6rem" },
      { field: "term_months", label: "Term", width: "5rem" },
    ],
    facets: ["term_months"],
    search: ["vin"],
  },
];

/**
 * The banking tables, which live in holdings.bin and have their own page.
 *
 * They were tabs on the holdings page until the payments work gave them
 * balances, schedules and cards — five tables that only mean anything read
 * against each other, next to nine that have nothing to do with them. A
 * mortgage is a holding; where the money to pay it lands on the 15th is a
 * position, and the two questions want different pages.
 */
export const BANKING_TABS: TabDef[] = [
  {
    table: "bank_account",
    label: "Accounts",
    noun: "Bank account",
    person: "person",
    columns: [
      { field: "institution", label: "Institution" },
      { field: "type", label: "Type", width: "8rem" },
      { field: "purpose", label: "Purpose", width: "7rem" },
      { field: "balance", format: "exact", width: "8rem" },
      { field: "number", label: "Account", width: "10rem" },
      { field: "routing", width: "8rem" },
      { field: "opened", width: "6rem" },
      { field: "spendable", width: "6rem" },
      { field: "spend_rank", label: "Order", width: "5rem" },
      { field: "neobank", width: "6rem" },
    ],
    facets: ["institution", "type", "purpose", "spendable", "debitable",
             "receives_deposits", "neobank"],
    search: ["number", "routing", "institution"],
  },
  {
    table: "income_stream",
    label: "Income",
    noun: "Income stream",
    person: "person",
    columns: [
      { field: "source", label: "Source", width: "10rem" },
      { field: "frequency", width: "8rem" },
      { field: "payday", label: "Payday", width: "9rem" },
      { field: "anchor", label: "Last paid", width: "7rem" },
      { field: "net_per_period", label: "Net", format: "exact", width: "8rem" },
      { field: "method", width: "9rem" },
      { field: "employer", label: "Employer", width: "10rem" },
      { field: "account", label: "Account", width: "9rem" },
    ],
    facets: ["source", "frequency", "payday", "method"],
    search: ["employer", "account"],
  },
  {
    table: "credit_card",
    label: "Credit cards",
    noun: "Credit card",
    person: "person",
    columns: [
      { field: "issuer", label: "Issuer" },
      { field: "network", width: "9rem" },
      { field: "last_four", label: "Last four", width: "6rem" },
      { field: "opened", width: "6rem" },
      { field: "expires", width: "7rem" },
      { field: "limit", format: "exact", width: "8rem" },
      { field: "balance", format: "exact", width: "8rem" },
    ],
    facets: ["issuer", "network"],
    search: ["last_four", "issuer"],
  },
  {
    table: "debit_card",
    label: "Debit cards",
    noun: "Debit card",
    person: "person",
    columns: [
      { field: "issuer", label: "Issuer" },
      { field: "network", width: "9rem" },
      { field: "last_four", label: "Last four", width: "6rem" },
      { field: "account", label: "Account", width: "10rem" },
      { field: "issued", width: "6rem" },
      { field: "expires", width: "7rem" },
      { field: "contactless", width: "7rem" },
    ],
    facets: ["issuer", "network", "contactless"],
    search: ["last_four", "account", "issuer"],
  },
  {
    table: "payment_profile",
    label: "Payment habits",
    noun: "Payment profile",
    person: "person",
    // Both preferences are probabilities, and the packer's float kind is the
    // one a mortgage rate uses — where 7.248 already means 7.248%. `share`
    // says to read this one as a fraction of one instead.
    columns: [
      { field: "cash_preference", label: "Cash", format: "share", width: "7rem" },
      { field: "credit_preference", label: "Credit", format: "share", width: "7rem" },
      { field: "contactless", width: "7rem" },
    ],
    facets: ["contactless"],
    search: [],
  },
];

export const HOLDING_TABS: TabDef[] = [
  {
    table: "licence",
    label: "Driver licences and IDs",
    noun: "Licence",
    person: "person",
    columns: [
      { field: "holding", label: "Kind", width: "8rem" },
      { field: "number", width: "8rem" },
      { field: "class", label: "Class", width: "5rem" },
      { field: "issued", width: "7rem" },
      { field: "expires", width: "7rem" },
      { field: "status", width: "7rem" },
      { field: "real_id", label: "REAL ID", width: "6rem" },
      { field: "restrictions" },
    ],
    facets: ["holding", "status", "class", "real_id"],
    search: ["number"],
  },
  // Accounts, income, cards and payment habits are on the banking page. See
  // BANKING_TABS above for why they left this one.
  {
    table: "real_property",
    label: "Property",
    noun: "Property",
    person: "person",
    columns: [
      { field: "parcel", width: "12rem" },
      { field: "address", label: "Building", width: "12rem" },
      { field: "recorded", width: "7rem" },
      { field: "purchase_price", label: "Paid", format: "money", width: "7rem" },
      { field: "assessed_value", label: "Assessed", format: "money", width: "7rem" },
      { field: "year_built", label: "Built", width: "5rem" },
    ],
    facets: ["issuer", "year_built", "year_built_or_earlier"],
    search: ["parcel", "address"],
  },
  {
    table: "mortgage",
    label: "Mortgages",
    noun: "Mortgage",
    person: "person",
    columns: [
      { field: "lender", label: "Lender" },
      { field: "originated", width: "7rem" },
      { field: "principal", format: "money", width: "7rem" },
      { field: "balance", format: "money", width: "7rem" },
      { field: "rate", width: "6rem" },
      { field: "term_months", label: "Term", width: "5rem" },
      { field: "monthly_payment", label: "Monthly", format: "money", width: "7rem" },
    ],
    facets: ["lender", "term_months", "escrow_includes_insurance"],
    search: ["parcel", "lender"],
  },
  {
    table: "student_loan",
    label: "Student loans",
    noun: "Student loan",
    person: "person",
    columns: [
      { field: "servicer", label: "Servicer" },
      { field: "status", width: "9rem" },
      { field: "federal", width: "6rem" },
      { field: "originated", width: "6rem" },
      { field: "principal", format: "money", width: "7rem" },
      { field: "balance", format: "money", width: "7rem" },
    ],
    facets: ["servicer", "status", "federal"],
    search: ["servicer"],
  },
  {
    table: "credential",
    label: "Credentials",
    noun: "Credential",
    person: "person",
    columns: [
      { field: "credential", label: "Credential", width: "12rem" },
      { field: "institution", label: "Institution" },
      { field: "awarded", width: "6rem" },
      { field: "field", label: "Field", width: "14rem" },
      { field: "title", width: "10rem" },
    ],
    facets: ["credential", "institution", "field"],
    search: ["institution", "field", "second_field"],
  },
  {
    table: "prescription",
    label: "Prescriptions",
    noun: "Prescription",
    person: "person",
    columns: [
      { field: "drug", label: "Drug", width: "11rem" },
      { field: "drug_class", label: "Class", width: "13rem" },
      { field: "schedule", width: "6rem" },
      { field: "written", width: "7rem" },
      { field: "days_supply", label: "Supply", width: "5rem" },
      { field: "refills", width: "5rem" },
      { field: "pharmacy" },
    ],
    facets: ["drug", "drug_class", "schedule", "pharmacy", "pdmp_reported"],
    search: ["drug", "drug_class", "pharmacy"],
  },
  {
    table: "military_service",
    label: "Military service",
    noun: "Military service",
    person: "person",
    columns: [
      { field: "branch", label: "Branch", width: "13rem" },
      { field: "component", width: "7rem" },
      { field: "entered", width: "6rem" },
      { field: "separated", width: "7rem" },
      { field: "discharge", width: "11rem" },
      { field: "document", width: "7rem" },
    ],
    facets: ["branch", "component", "discharge"],
  },
];

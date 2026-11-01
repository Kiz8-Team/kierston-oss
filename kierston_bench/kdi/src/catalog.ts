import type { Column, CutoffRule, DatabaseDef, Field, FilterType, Match, PublicFilter, QueryDef } from "./catalog-types";
import type { KdiPolicy } from "../../task_generators/src/task.ts";
import { applyQueryPolicy } from "./policy";

// The sources below are an access map, not a storage map. Picking a source and
// a search decides, on its own, which store and which table answers -- nothing
// about ClickHouse or PostgreSQL is typed by the person searching.
//
// Every search takes whatever identifiers the searcher actually holds. A name,
// an SSN, a plate and a VIN all reach the vehicle file; blank fields drop out
// of the query rather than narrowing it, so one form serves the case where you
// have a number and the case where you only have a name.

const SSN: Field = { name: "ssn", label: "SSN", size: 11, placeholder: "000-00-0000", normalize: "ssn" };
const SURNAME: Field = { name: "surname", label: "Surname", size: 16 };
const GIVEN: Field = { name: "given", label: "Given name", size: 14 };
const DOB: Field = { name: "dob", label: "Date of birth", size: 10, placeholder: "YYYY-MM-DD", normalize: "date" };
const OBSERVED: Field = { name: "date", label: "Day", kind: "date", size: 10, normalize: "date" };

const NAME_FIELDS = [SURNAME, GIVEN, DOB] as const;

/** Name, date of birth and — where the source holds one — SSN. */
function personFields(withSsn: boolean): Field[] {
  return withSsn ? [SSN, ...NAME_FIELDS] : [...NAME_FIELDS];
}

/** The identity columns Fastgate copies onto every provider record. */
function personColumns(prefix: string, label: string): Column[] {
  return [
    { name: `${prefix}_last_name`, label: `${label} surname` },
    { name: `${prefix}_first_name`, label: `${label} given` },
    { name: `${prefix}_middle_name`, label: `${label} middle` },
    { name: `${prefix}_date_of_birth`, label: "DOB", format: "date" },
  ];
}

/** Predicates for the person fields against a copied identity prefix. */
function personMatches(prefix: string, withSsn: boolean): Match[] {
  const matches: Match[] = [
    { field: "surname", columns: [`${prefix}_last_name`], op: "name" },
    { field: "given", columns: [`${prefix}_first_name`], op: "name" },
    { field: "dob", columns: [`${prefix}_date_of_birth`], op: "eq" },
  ];
  if (withSsn) matches.unshift({ field: "ssn", columns: [`${prefix}_ssn`], op: "eq" });
  return matches;
}

/** Any one filled field is enough to search on. */
function anyOf(fields: readonly Field[]): readonly (readonly string[])[] {
  return [fields.map((field) => field.name)];
}

/** A ClickHouse timestamp rendered in the city's wall clock. */
function localTime(column: string, label: string): Column {
  return { name: column, label, expr: `formatDateTime(${column}, '%FT%T.%fZ', 'UTC')`, format: "datetime" };
}

/**
 * Seconds from call setup to the cutoff. Rows reaching a mask have setup at
 * or before the cutoff, so this is never negative.
 */
const SINCE_SETUP = "intDiv(dateDiff('millisecond', $setup_at, {cutoff}), 1000)";

/**
 * A call set up before the cutoff can still be ringing or connected at it.
 * Ringing is taken to run from setup for ring_seconds, the conversation for
 * duration_seconds after that. Whatever falls after the cutoff is cut: ring
 * and duration are clamped to the elapsed time, the outcome is unknown until
 * ringing ends, and the end cells are unknown until the call ends.
 */
const CALL_CUTOFF: CutoffRule = {
  clock: "setup_at",
  mask: [
    { column: "ring_seconds", expr: `toUInt32(least(toInt64($ring_seconds), ${SINCE_SETUP}))` },
    { column: "outcome", expr: `if(toInt64($ring_seconds) > ${SINCE_SETUP}, NULL, $outcome)` },
    { column: "duration_seconds",
      expr: `toUInt32(greatest(0, least(toInt64($duration_seconds), ${SINCE_SETUP} - toInt64($ring_seconds))))` },
    { column: "end_cell_cgi",
      expr: `if(toInt64($ring_seconds) + toInt64($duration_seconds) > ${SINCE_SETUP}, NULL, $end_cell_cgi)` },
    { column: "destination_end_cell_cgi",
      expr: `if(toInt64($ring_seconds) + toInt64($duration_seconds) > ${SINCE_SETUP}, NULL, $destination_end_cell_cgi)` },
  ],
};

/** A handover is its own event: one after the cutoff has not happened yet. */
const HANDOVER_CUTOFF: CutoffRule = { clock: "occurred_at" };

/**
 * A message submitted before the cutoff and delivered after it is still in
 * flight: no delivery time and no cell the recipient was reached on.
 */
const MESSAGE_CUTOFF: CutoffRule = {
  clock: "submitted_at",
  mask: [
    { column: "delivered_at", expr: "if($delivered_at > {cutoff}, NULL, $delivered_at)" },
    { column: "destination_cell_cgi", expr: "if($delivered_at > {cutoff}, NULL, $destination_cell_cgi)" },
  ],
};

function columnType(column: Column): FilterType {
  if (column.format === "datetime") return "datetime";
  if (column.format === "date") return "date";
  if (column.format === "bool") return "boolean";
  if (["money", "seconds", "year"].includes(column.format ?? "") || column.align === "right") return "number";
  return "text";
}

function fieldType(field: Field): FilterType {
  return field.kind === "date" ? "date" : "text";
}

export function filtersForQuery(query: QueryDef): PublicFilter[] {
  const filters = new Map<string, PublicFilter>();
  for (const match of query.match) {
    const field = query.fields.find((candidate) => candidate.name === match.field)!;
    const type = fieldType(field);
    const operators = match.op === "contains" ? ["contains"] as const : ["eq"] as const;
    filters.set(match.field, {
      name: match.field, label: field.label, type, operators, repeatable: match.op !== "contains", maxValues: 100,
    });
  }
  for (const column of query.select) {
    const type = columnType(column);
    const operators = type === "text"
      ? ["eq", "contains", "is_null"] as const
      : type === "boolean"
        ? ["eq", "is_null"] as const
        : ["eq", "gte", "gt", "lte", "lt", "between", "is_null"] as const;
    filters.set(column.name, {
      name: column.name, label: column.label, type, operators, repeatable: true, maxValues: 100,
    });
  }
  return [...filters.values()];
}

/**
 * A search over one provider table, keyed by the person on the record plus
 * whatever identifiers that table carries of its own.
 */
function personSearch(base: {
  id: string;
  label: string;
  table: string;
  description: string;
  prefix: string;
  ssn: boolean;
  own?: readonly Field[];
  ownMatches?: readonly Match[];
  select: readonly Column[];
  subjects?: QueryDef["subjects"];
  order?: string;
  note?: string;
}): QueryDef {
  const fields = [...(base.own ?? []), ...personFields(base.ssn)];
  return {
    id: base.id,
    label: base.label,
    kind: "record",
    store: "postgres",
    table: base.table,
    description: base.description,
    fields,
    match: [...(base.ownMatches ?? []), ...personMatches(base.prefix, base.ssn)],
    requires: anyOf(fields),
    select: base.select,
    subjects: base.subjects,
    order: base.order,
    note: base.note,
  };
}

const SOCIAL_SECURITY: DatabaseDef = {
  id: "ssa", code: "SSA", name: "Social Security Administration",
  custodian: "federal", holder: "Federal — SSA / Numident",
  description:
    "The number-holder file: account number, legal name, date and place of birth, "
    + "parents, citizenship basis, taxpayer identification and residence.",
  queries: [
    {
      id: "people", label: "People", kind: "record", store: "postgres",
      table: "identity_registry_people",
      description: "Search the number-holder file by number, name, date of birth or address.",
      fields: [SSN, ...NAME_FIELDS, { name: "address", label: "Address contains", size: 28 }],
      match: [
        { field: "ssn", columns: ["ssn"], op: "eq" },
        { field: "surname", columns: ["surname"], op: "name" },
        { field: "given", columns: ["first_name"], op: "name" },
        { field: "dob", columns: ["birth_date"], op: "eq" },
        { field: "address", columns: ["mailing_address"], op: "contains" },
      ],
      requires: [["ssn", "surname", "given", "dob", "address"]],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        { name: "ssn", label: "SSN", format: "code" },
        { name: "surname", label: "Surname" },
        { name: "first_name", label: "Given" },
        { name: "middle_name", label: "Middle" },
        { name: "birth_date", label: "DOB", format: "date" },
        { name: "surname_paternal", label: "Paternal surname" },
        { name: "surname_maternal", label: "Maternal surname" },
        { name: "mailing_address", label: "Residence" },
        { name: "mobile", label: "Mobile" },
        { name: "landline", label: "Landline" },
        { name: "citizenship", label: "Citizenship" },
        { name: "legal_status", label: "Status" },
        { name: "taxpayer_id_issued", label: "Taxpayer ID issued", format: "year" },
        { name: "birthplace", label: "Birthplace" },
        { name: "mother_full_name", label: "Mother" },
        { name: "father_full_name", label: "Father" },
        { name: "parent_full_names", label: "Parents", format: "list" },
        { name: "marital_status", label: "Marital" },
        { name: "marital_times_married", label: "Times married", align: "right" },
        { name: "marital_married_year", label: "Married", format: "year" },
        { name: "employment_status", label: "Employment status" },
        { name: "workplace_name", label: "Employer" },
        { name: "workplace_address", label: "Employer address" },
        { name: "veteran_status", label: "Veteran", format: "bool" },
      ],
      order: "surname, first_name, birth_date",
    },
  ],
};

const HOMELAND_SECURITY: DatabaseDef = {
  id: "dhs", code: "DHS", name: "Department of Homeland Security",
  custodian: "federal", holder: "Federal — USCIS / CBP document files",
  description:
    "Travel and immigration documents and the status behind them: passports, "
    + "resident cards, alien registrations, employment authorisation, "
    + "naturalisation certificates and visas.",
  queries: [
    personSearch({
      id: "documents", label: "Documents", table: "identity_registry_documents",
      description: "Documents by number, or by the person they were issued to.",
      prefix: "holder", ssn: false,
      own: [{ name: "number", label: "Document number", size: 16, normalize: "upper" }],
      ownMatches: [{ field: "number", columns: ["number"], op: "eq" }],
      select: [
        ...personColumns("holder", "Holder"),
        { name: "document", label: "Document" },
        { name: "number", label: "Number", format: "code" },
        { name: "issued", label: "Issued", format: "year" },
        { name: "expires", label: "Expires", format: "year" },
        { name: "status", label: "Status" },
        { name: "country", label: "Country" },
        { name: "category", label: "Category" },
        { name: "basis", label: "Basis" },
        { name: "issuer", label: "Issuer" },
        { name: "form", label: "Form" },
      ],
      order: "holder_last_name, holder_first_name, issued",
    }),
    {
      id: "status", label: "Immigration status", kind: "record", store: "postgres",
      table: "identity_registry_people",
      description: "Citizenship basis, lawful status, entry and naturalisation years.",
      fields: [SSN, ...NAME_FIELDS, { name: "address", label: "Address contains", size: 28 }],
      match: [
        { field: "ssn", columns: ["ssn"], op: "eq" },
        { field: "surname", columns: ["surname"], op: "name" },
        { field: "given", columns: ["first_name"], op: "name" },
        { field: "dob", columns: ["birth_date"], op: "eq" },
        { field: "address", columns: ["mailing_address"], op: "contains" },
      ],
      requires: [["ssn", "surname", "given", "dob", "address"]],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        { name: "surname", label: "Surname" },
        { name: "first_name", label: "Given" },
        { name: "birth_date", label: "DOB", format: "date" },
        { name: "citizenship", label: "Citizenship" },
        { name: "legal_status", label: "Lawful status" },
        { name: "legal_status_source", label: "Status source" },
        { name: "birthplace", label: "Birthplace" },
        { name: "birth_region", label: "Birth region" },
        { name: "entry_year", label: "Entered", format: "year" },
        { name: "naturalized_year", label: "Naturalised", format: "year" },
        { name: "taxpayer_id_kind", label: "Taxpayer ID kind" },
        { name: "taxpayer_id", label: "Taxpayer ID", format: "code" },
      ],
      order: "surname, first_name",
    },
  ],
};

const TRANSPORTATION: DatabaseDef = {
  id: "dot", code: "DOT", name: "Department of Transportation",
  custodian: "state", holder: "State — PennDOT title, registration and driver files",
  description:
    "Titles and registrations, plates, vehicle description and insurance; driver "
    + "licences with class, restrictions and status, and the suspensions behind them.",
  queries: [
    personSearch({
      id: "vehicles", label: "Vehicle registrations", table: "dot_vehicle_registrations",
      description: "Registrations by plate, VIN, or registered owner.",
      prefix: "registered_owner", ssn: true,
      own: [
        { name: "plate", label: "Plate", size: 10, placeholder: "AAA-0000", normalize: "plate" },
        { name: "vin", label: "VIN", size: 17, normalize: "upper" },
      ],
      ownMatches: [
        { field: "plate", columns: ["plate"], op: "eq" },
        { field: "vin", columns: ["vin"], op: "eq" },
      ],
      subjects: [{ field: "plate", via: "plate" }, { field: "vin", via: "vin" }, { field: "ssn", via: "ssn" }],
      select: [
        { name: "plate", label: "Plate", format: "code" },
        { name: "plate_type", label: "Plate type" },
        { name: "vin", label: "VIN", format: "code" },
        { name: "model_year", label: "Year", format: "year" },
        { name: "make", label: "Make" },
        { name: "model", label: "Model" },
        { name: "body", label: "Body" },
        { name: "colour", label: "Colour" },
        ...personColumns("registered_owner", "Owner"),
        { name: "registered_owner_ssn", label: "Owner SSN", format: "code" },
        { name: "owner_type", label: "Owner type" },
        { name: "registered", label: "Registered", format: "year" },
        { name: "registration_expires", label: "Expires", format: "date" },
        { name: "title_status", label: "Title status" },
        { name: "title_number", label: "Title", format: "code" },
        { name: "value", label: "Value", format: "money", align: "right" },
        { name: "price_new", label: "Price new", format: "money", align: "right" },
        { name: "commercial_use", label: "Commercial", format: "bool" },
        { name: "service_class", label: "Service class" },
        { name: "bus_type", label: "Bus type" },
        { name: "seats", label: "Seats", align: "right" },
        { name: "issuer", label: "Issuer" },
        { name: "insurer", label: "Insurer" },
        { name: "policy", label: "Policy", format: "code" },
      ],
      order: "registered_owner_last_name, model_year DESC",
    }),
    personSearch({
      id: "licences", label: "Driver licences", table: "dot_driver_licenses",
      description: "Licences and photo IDs by number or by licensee.",
      prefix: "licensee", ssn: true,
      own: [{ name: "number", label: "Licence number", size: 12, normalize: "digits" }],
      ownMatches: [{ field: "number", columns: ["number"], op: "eq" }],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        { name: "number", label: "Number", format: "code" },
        { name: "holding", label: "Holding" },
        ...personColumns("licensee", "Licensee"),
        { name: "licensee_ssn", label: "SSN", format: "code" },
        { name: "class", label: "Class" },
        { name: "status", label: "Status" },
        { name: "restrictions", label: "Restrictions", format: "list" },
        { name: "real_id", label: "REAL ID", format: "bool" },
        { name: "issued", label: "Issued", format: "date" },
        { name: "expires", label: "Expires", format: "date" },
        { name: "first_issued", label: "First issued", format: "year" },
        { name: "issuer", label: "Issuer" },
      ],
      order: "licensee_last_name, licensee_first_name",
    }),
    personSearch({
      id: "suspensions", label: "Suspensions", table: "dot_license_suspensions",
      description: "Suspensions and revocations by licensee or by docket.",
      prefix: "licensee", ssn: true,
      own: [{ name: "docket", label: "Docket", size: 24, normalize: "upper" }],
      ownMatches: [{ field: "docket", columns: ["docket"], op: "eq" }],
      select: [
        ...personColumns("licensee", "Licensee"),
        { name: "from", label: "From", format: "date" },
        { name: "months", label: "Months", align: "right" },
        { name: "reason", label: "Reason" },
        { name: "docket", label: "Docket", format: "code" },
      ],
      order: '"from" DESC',
    }),
  ],
};

const CRIMINAL_COURTS: DatabaseDef = {
  id: "courts_criminal", code: "CRT-CR", name: "Criminal courts",
  custodian: "county", holder: "County and state — magisterial, common pleas and juvenile dockets",
  description:
    "Criminal dockets from filing to disposition: arrest date, court, charges, "
    + "bail and pretrial detention, conviction grade and sentence. Sealed and "
    + "expunged dockets are flagged, not hidden.",
  queries: [
    personSearch({
      id: "cases", label: "Cases", table: "criminal_court_cases",
      description: "Dockets by number or by defendant.",
      prefix: "defendant", ssn: false,
      own: [{ name: "docket", label: "Docket", size: 24, normalize: "upper" }],
      ownMatches: [{ field: "docket", columns: ["docket", "magisterial_docket"], op: "eq" }],
      select: [
        { name: "docket", label: "Docket", format: "code" },
        { name: "magisterial_docket", label: "Magisterial", format: "code" },
        ...personColumns("defendant", "Defendant"),
        { name: "court", label: "Court" },
        { name: "district", label: "District" },
        { name: "arrest_date", label: "Arrested", format: "date" },
        { name: "offence_year", label: "Offence year", format: "year" },
        { name: "age_at_offence", label: "Age at offence", align: "right" },
        { name: "juvenile", label: "Juvenile", format: "bool" },
        { name: "filed", label: "Filed", format: "date" },
        { name: "lead_charge", label: "Lead charge" },
        { name: "felony_charged", label: "Felony charged", format: "bool" },
        { name: "disposition", label: "Disposition" },
        { name: "public", label: "Public", format: "bool" },
        { name: "counts_for_prs", label: "Counts for PRS", format: "bool" },
        { name: "prior_record_score", label: "Prior record score", align: "right" },
        { name: "pled_down", label: "Pled down", format: "bool" },
        { name: "disposed", label: "Disposed", format: "date" },
        { name: "convicted", label: "Convicted", format: "bool" },
        { name: "convicted_of", label: "Convicted of" },
        { name: "conviction_grade", label: "Grade" },
        { name: "felony_convicted", label: "Felony convicted", format: "bool" },
        { name: "pog", label: "POG" },
        { name: "detained_pretrial", label: "Held pretrial", format: "bool" },
        { name: "bail", label: "Bail", format: "money", align: "right" },
        { name: "sentence_kind", label: "Sentence" },
        { name: "sentence_minimum_months", label: "Min months", align: "right" },
        { name: "sentence_maximum_months", label: "Max months", align: "right" },
        { name: "sentence_probation_months", label: "Probation months", align: "right" },
        { name: "sentence_fine", label: "Sentence fine", format: "money", align: "right" },
        { name: "sentence_rrri_months", label: "RRRI months", align: "right" },
        { name: "sentence_negotiated", label: "Negotiated", format: "bool" },
        { name: "sentence_life_without_parole", label: "Life without parole", format: "bool" },
        { name: "sentence_start", label: "Sentence start", format: "date" },
        { name: "fine", label: "Fine", format: "money", align: "right" },
        { name: "sealed", label: "Sealed", format: "bool" },
        { name: "expunged", label: "Expunged", format: "bool" },
      ],
      order: "filed DESC",
    }),
    personSearch({
      id: "charges", label: "Charges", table: "criminal_court_charges",
      description: "Counts by docket, by statute cite or description, or by defendant.",
      prefix: "defendant", ssn: false,
      own: [
        { name: "docket", label: "Docket", size: 24, normalize: "upper" },
        { name: "cite", label: "Cite", size: 18 },
        { name: "description", label: "Description contains", size: 22 },
        { name: "grade", label: "Grade", size: 4, normalize: "upper" },
      ],
      ownMatches: [
        { field: "docket", columns: ["case_record_index"], op: "in", via: "docket_to_case_index", cast: "bigint[]" },
        { field: "cite", columns: ["cite"], op: "contains" },
        { field: "description", columns: ["description"], op: "contains" },
        { field: "grade", columns: ["grade"], op: "eq" },
      ],
      select: [
        ...personColumns("defendant", "Defendant"),
        { name: "cite", label: "Cite", format: "code" },
        { name: "section", label: "Section", format: "code" },
        { name: "description", label: "Description" },
        { name: "grade", label: "Grade" },
        { name: "ogs", label: "OGS" },
        { name: "category", label: "Category" },
        { name: "counts", label: "Counts", align: "right" },
      ],
      order: "defendant_last_name, grade, cite",
    }),
  ],
};

const CIVIL_COURTS: DatabaseDef = {
  id: "courts_civil", code: "CRT-CV", name: "Civil courts",
  custodian: "county", holder: "County, state and federal — civil, family and bankruptcy dockets",
  description:
    "Divorce and custody, landlord-tenant, money judgments, protection orders and "
    + "federal bankruptcy, with the role the subject held in each.",
  queries: [
    personSearch({
      id: "cases", label: "Cases", table: "civil_court_cases",
      description: "Civil dockets by number, party or kind.",
      prefix: "party", ssn: false,
      own: [
        { name: "docket", label: "Docket", size: 26, normalize: "upper" },
        {
          name: "kind", label: "Kind", kind: "select", options: [
            { value: "", label: "Any" },
            { value: "bankruptcy", label: "Bankruptcy" },
            { value: "child_support", label: "Child support" },
            { value: "civil_judgment", label: "Civil judgment" },
            { value: "divorce", label: "Divorce" },
            { value: "landlord_tenant", label: "Landlord and tenant" },
            { value: "marriage_licence", label: "Marriage licence" },
            { value: "mortgage_foreclosure", label: "Mortgage foreclosure" },
            { value: "protection_from_abuse", label: "Protection from abuse" },
            { value: "small_claims", label: "Small claims" },
          ],
        },
      ],
      ownMatches: [
        { field: "docket", columns: ["docket"], op: "eq" },
        { field: "kind", columns: ["kind"], op: "eq" },
      ],
      select: [
        { name: "docket", label: "Docket", format: "code" },
        ...personColumns("party", "Party"),
        { name: "kind", label: "Kind" },
        { name: "role", label: "Role" },
        { name: "court", label: "Court" },
        { name: "filed", label: "Filed", format: "date" },
        { name: "disposed", label: "Disposed", format: "date" },
        { name: "outcome", label: "Outcome" },
        { name: "amount", label: "Amount", format: "money", align: "right" },
        { name: "monthly", label: "Monthly", format: "money", align: "right" },
        { name: "order_months", label: "Order months", align: "right" },
        { name: "marriage_number", label: "Marriage number", align: "right" },
        { name: "grounds", label: "Grounds" },
        { name: "chapter", label: "Chapter" },
        { name: "public", label: "Public", format: "bool" },
      ],
      order: "filed DESC",
    }),
  ],
};

const CORRECTIONS: DatabaseDef = {
  id: "corrections", code: "CORR", name: "Corrections",
  custodian: "state", holder: "State and county — custody, supervision and release status",
  description:
    "Present custody and supervision status, expected release year, and the "
    + "statutory grounds for a firearms prohibition.",
  queries: [
    personSearch({
      id: "status", label: "Custody status", table: "corrections_statuses",
      description: "By person, or everyone held at a named facility.",
      prefix: "subject", ssn: false,
      own: [{ name: "facility", label: "Facility contains", size: 24 }],
      ownMatches: [{ field: "facility", columns: ["facility"], op: "contains" }],
      select: [
        ...personColumns("subject", "Subject"),
        { name: "incarcerated", label: "In custody", format: "bool" },
        { name: "facility", label: "Facility" },
        { name: "supervision", label: "Supervision" },
        { name: "release_year", label: "Release", format: "year" },
        { name: "firearms_prohibited", label: "Firearms prohibition", format: "list" },
      ],
      order: "subject_last_name, subject_first_name",
    }),
  ],
};

const STATE_POLICE: DatabaseDef = {
  id: "psp_firearms", code: "PSP", name: "State police firearms unit",
  custodian: "state", holder: "State — records of sale, carry licences and PICS checks",
  description: "Firearm sales and transfers, licences to carry, and transfer background checks.",
  queries: [
    personSearch({
      id: "firearms", label: "Firearms", table: "state_police_firearms",
      description: "Recorded sales and transfers by serial or by purchaser.",
      prefix: "purchaser", ssn: true,
      own: [{ name: "serial", label: "Serial", size: 14, normalize: "upper" }],
      ownMatches: [{ field: "serial", columns: ["serial"], op: "eq" }],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        { name: "serial", label: "Serial", format: "code" },
        { name: "type", label: "Type" },
        { name: "description", label: "Description" },
        ...personColumns("purchaser", "Purchaser"),
        { name: "purchaser_ssn", label: "SSN", format: "code" },
        { name: "acquired", label: "Acquired", format: "year" },
        { name: "transfer", label: "Transfer" },
        { name: "record_of_sale", label: "Record of sale", format: "code" },
        { name: "pics_approval", label: "PICS approval", format: "code" },
        { name: "dealer", label: "Dealer" },
        { name: "ffl", label: "FFL", format: "code" },
      ],
      order: "acquired DESC",
    }),
    personSearch({
      id: "carry_licences", label: "Licences to carry", table: "state_police_carry_licenses",
      description: "Carry licences by number or by licensee.",
      prefix: "licensee", ssn: true,
      own: [{ name: "number", label: "Licence number", size: 12, normalize: "upper" }],
      ownMatches: [{ field: "number", columns: ["number"], op: "eq" }],
      select: [
        ...personColumns("licensee", "Licensee"),
        { name: "number", label: "Number", format: "code" },
        { name: "status", label: "Status" },
        { name: "issuer", label: "Issuer" },
        { name: "issued", label: "Issued", format: "date" },
        { name: "expires", label: "Expires", format: "year" },
        { name: "statute", label: "Statute" },
      ],
      order: "issued DESC",
    }),
    personSearch({
      id: "background_checks", label: "Background checks", table: "state_police_background_checks",
      description: "PICS checks by approval number or by applicant.",
      prefix: "applicant", ssn: true,
      own: [{ name: "approval", label: "Approval number", size: 12, normalize: "digits" }],
      ownMatches: [{ field: "approval", columns: ["approval"], op: "eq" }],
      select: [
        ...personColumns("applicant", "Applicant"),
        { name: "date", label: "Date", format: "date" },
        { name: "result", label: "Result" },
        { name: "reason", label: "Reason" },
        { name: "approval", label: "Approval", format: "code" },
        { name: "dealer", label: "Dealer" },
        { name: "ffl", label: "FFL", format: "code" },
        { name: "issuer", label: "Issuer" },
      ],
      order: "date DESC",
    }),
  ],
};

const BANKS: DatabaseDef = {
  id: "banks", code: "BANK", name: "Banks and card issuers",
  custodian: "private", holder: "Commercial — deposit, card and lending institutions",
  description:
    "Deposit and card accounts with balances, the KYC identity behind each, "
    + "secured and unsecured lending, observed payroll deposits, and posted "
    + "transactions for a requested day.",
  queries: [
    personSearch({
      id: "accounts", label: "Accounts", table: "bank_accounts",
      description: "Deposit accounts by number, routing number or customer.",
      prefix: "customer", ssn: true,
      own: [
        { name: "number", label: "Account number", size: 14, normalize: "digits" },
        { name: "routing", label: "Routing", size: 11, normalize: "digits" },
        { name: "institution", label: "Institution contains", size: 20 },
      ],
      ownMatches: [
        { field: "number", columns: ["number"], op: "eq" },
        { field: "routing", columns: ["routing"], op: "eq" },
        { field: "institution", columns: ["institution"], op: "contains" },
      ],
      subjects: [{ field: "number", via: "account" }, { field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("customer", "Customer"),
        { name: "customer_ssn", label: "SSN", format: "code" },
        { name: "institution", label: "Institution" },
        { name: "routing", label: "Routing", format: "code" },
        { name: "number", label: "Account", format: "code" },
        { name: "type", label: "Type" },
        { name: "purpose", label: "Purpose" },
        { name: "balance", label: "Balance", format: "money", align: "right" },
        { name: "spendable", label: "Spendable", format: "bool" },
        { name: "opened", label: "Opened", format: "year" },
        { name: "neobank", label: "Neobank", format: "bool" },
        { name: "debitable", label: "Debitable", format: "bool" },
        { name: "receives_deposits", label: "Takes deposits", format: "bool" },
      ],
      order: "balance DESC",
    }),
    personSearch({
      id: "credit_cards", label: "Credit cards", table: "bank_credit_cards",
      description: "Credit cards by last four, issuer or cardholder.",
      prefix: "cardholder", ssn: true,
      own: [
        { name: "last_four", label: "Last four", size: 5, normalize: "digits" },
        { name: "issuer", label: "Issuer contains", size: 20 },
      ],
      ownMatches: [
        { field: "last_four", columns: ["last_four"], op: "eq" },
        { field: "issuer", columns: ["issuer"], op: "contains" },
      ],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("cardholder", "Cardholder"),
        { name: "cardholder_ssn", label: "SSN", format: "code" },
        { name: "issuer", label: "Issuer" },
        { name: "network", label: "Network" },
        { name: "last_four", label: "Last four", format: "code" },
        { name: "limit", label: "Limit", format: "money", align: "right" },
        { name: "balance", label: "Balance", format: "money", align: "right" },
        { name: "opened", label: "Opened", format: "year" },
        { name: "expires", label: "Expires" },
      ],
      order: "cardholder_last_name",
    }),
    personSearch({
      id: "debit_cards", label: "Debit cards", table: "bank_debit_cards",
      description: "Debit cards by last four, linked account or cardholder.",
      prefix: "cardholder", ssn: true,
      own: [
        { name: "last_four", label: "Last four", size: 5, normalize: "digits" },
        { name: "account", label: "Account number", size: 14, normalize: "digits" },
      ],
      ownMatches: [
        { field: "last_four", columns: ["last_four"], op: "eq" },
        { field: "account", columns: ["account"], op: "eq" },
      ],
      subjects: [{ field: "account", via: "account" }, { field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("cardholder", "Cardholder"),
        { name: "cardholder_ssn", label: "SSN", format: "code" },
        { name: "issuer", label: "Issuer" },
        { name: "network", label: "Network" },
        { name: "last_four", label: "Last four", format: "code" },
        { name: "account", label: "Account", format: "code" },
        { name: "issued", label: "Issued", format: "year" },
        { name: "expires", label: "Expires" },
        { name: "contactless", label: "Contactless", format: "bool" },
      ],
      order: "cardholder_last_name",
    }),
    personSearch({
      id: "auto_loans", label: "Auto loans", table: "bank_auto_loans",
      description: "Vehicle-secured lending by VIN or by borrower.",
      prefix: "borrower", ssn: true,
      own: [{ name: "vin", label: "VIN", size: 17, normalize: "upper" }],
      ownMatches: [{ field: "vin", columns: ["vin"], op: "eq" }],
      subjects: [{ field: "vin", via: "vin" }, { field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("borrower", "Borrower"),
        { name: "borrower_ssn", label: "SSN", format: "code" },
        { name: "vin", label: "VIN", format: "code" },
        { name: "originated", label: "Originated", format: "year" },
        { name: "term_months", label: "Term", align: "right" },
        { name: "principal", label: "Principal", format: "money", align: "right" },
        { name: "balance", label: "Balance", format: "money", align: "right" },
        { name: "rate", label: "Rate" },
      ],
      order: "originated DESC",
    }),
    personSearch({
      id: "mortgages", label: "Mortgages", table: "bank_mortgages",
      description: "Mortgages by parcel, lender or borrower.",
      prefix: "borrower", ssn: true,
      own: [
        { name: "parcel", label: "Parcel", size: 16, normalize: "upper" },
        { name: "lender", label: "Lender contains", size: 20 },
      ],
      ownMatches: [
        { field: "parcel", columns: ["parcel"], op: "eq" },
        { field: "lender", columns: ["lender"], op: "contains" },
      ],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("borrower", "Borrower"),
        { name: "borrower_ssn", label: "SSN", format: "code" },
        { name: "lender", label: "Lender" },
        { name: "parcel", label: "Parcel", format: "code" },
        { name: "originated", label: "Originated", format: "date" },
        { name: "principal", label: "Principal", format: "money", align: "right" },
        { name: "balance", label: "Balance", format: "money", align: "right" },
        { name: "monthly_payment", label: "Monthly", format: "money", align: "right" },
        { name: "term_months", label: "Term months", align: "right" },
        { name: "escrow_includes_insurance", label: "Insurance in escrow", format: "bool" },
        { name: "rate", label: "Rate" },
        { name: "mortgage_book", label: "Book", align: "right" },
        { name: "mortgage_page", label: "Page", align: "right" },
      ],
      order: "balance DESC",
    }),
    personSearch({
      id: "student_loans", label: "Student loans", table: "bank_student_loans",
      description: "Student lending by servicer or by borrower.",
      prefix: "borrower", ssn: true,
      own: [{ name: "servicer", label: "Servicer contains", size: 20 }],
      ownMatches: [{ field: "servicer", columns: ["servicer"], op: "contains" }],
      select: [
        ...personColumns("borrower", "Borrower"),
        { name: "borrower_ssn", label: "SSN", format: "code" },
        { name: "servicer", label: "Servicer" },
        { name: "federal", label: "Federal", format: "bool" },
        { name: "originated", label: "Originated", format: "year" },
        { name: "principal", label: "Principal", format: "money", align: "right" },
        { name: "balance", label: "Balance", format: "money", align: "right" },
        { name: "status", label: "Status" },
      ],
      order: "balance DESC",
    }),
    personSearch({
      id: "income", label: "Observed income", table: "bank_income_streams",
      description: "Recurring deposits by account, employer or customer.",
      prefix: "customer", ssn: true,
      own: [
        { name: "account", label: "Account number", size: 14, normalize: "digits" },
        { name: "employer", label: "Employer contains", size: 20 },
      ],
      ownMatches: [
        { field: "account", columns: ["account"], op: "eq" },
        { field: "employer", columns: ["employer"], op: "contains" },
      ],
      subjects: [{ field: "account", via: "account" }, { field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("customer", "Customer"),
        { name: "customer_ssn", label: "SSN", format: "code" },
        { name: "source", label: "Source" },
        { name: "employer", label: "Employer" },
        { name: "frequency", label: "Frequency" },
        { name: "payday", label: "Payday" },
        { name: "interval_days", label: "Interval days", align: "right" },
        { name: "method", label: "Method" },
        { name: "account", label: "Account", format: "code" },
        { name: "gross_annual", label: "Gross annual", format: "money", align: "right" },
        { name: "gross_per_period", label: "Gross per period", format: "money", align: "right" },
        { name: "net_per_period", label: "Net per period", format: "money", align: "right" },
      ],
      order: "gross_annual DESC",
    }),
    {
      id: "transactions", label: "Transactions", kind: "history", store: "clickhouse",
      table: "bank_transactions",
      spatial: "coordinates",
      description: "Posted card and account activity for a day, by account, card, SSN or merchant.",
      fields: [
        OBSERVED,
        { name: "account", label: "Account number", size: 14, normalize: "digits" },
        { name: "last_four", label: "Card last four", size: 5, normalize: "digits" },
        SSN,
        { name: "merchant", label: "Merchant contains", size: 20 },
      ],
      match: [
        { field: "date", columns: ["occurred_at"], op: "day" },
        { field: "account", columns: ["account_number"], op: "eq" },
        { field: "last_four", columns: ["card_last_four"], op: "eq" },
        { field: "ssn", columns: ["account_number"], op: "in", via: "ssn_to_account_numbers" },
        { field: "merchant", columns: ["merchant"], op: "contains" },
      ],
      requires: [["account", "last_four", "ssn", "merchant"]],
      subjects: [{ field: "account", via: "account" }, { field: "ssn", via: "ssn" }],
      select: [
        localTime("occurred_at", "Posted"),
        { name: "transaction_type", label: "Type" },
        { name: "instrument", label: "Instrument" },
        { name: "amount", label: "Amount", format: "money", align: "right" },
        { name: "approved", label: "Approved", format: "bool" },
        { name: "decline_code", label: "Decline" },
        { name: "merchant", label: "Merchant" },
        { name: "mcc", label: "MCC", format: "code" },
        { name: "account_number", label: "Account", format: "code" },
        { name: "card_last_four", label: "Card", format: "code" },
        { name: "card_network", label: "Network" },
        { name: "balance_after", label: "Balance after", format: "money", align: "right" },
        { name: "merchant_latitude", label: "Lat", align: "right" },
        { name: "merchant_longitude", label: "Lon", align: "right" },
        { name: "transaction_id", label: "Transaction", format: "code" },
      ],
      order: "occurred_at",
    },
  ],
};

const CARRIERS: DatabaseDef = {
  id: "carriers", code: "CARR", name: "Mobile carriers",
  custodian: "private", holder: "Commercial — network operators and their MVNOs",
  description:
    "Subscriber lines and the identity behind them, handset and SIM hardware, cell-site "
    + "and structure inventories, and the network's record of what a line did on a requested day.",
  queries: [
    personSearch({
      id: "lines", label: "Subscriber lines", table: "carrier_accounts",
      description: "Lines by number, IMSI, SIM serial, handset IMEI, or subscriber.",
      prefix: "subscriber", ssn: false,
      own: [
        { name: "msisdn", label: "Number", size: 16, placeholder: "(610) 555-0000", normalize: "phone" },
        { name: "imsi", label: "IMSI", size: 17, normalize: "digits" },
        { name: "iccid", label: "ICCID", size: 22, normalize: "digits" },
        { name: "imei", label: "Handset IMEI", size: 17, normalize: "digits" },
        SSN,
      ],
      ownMatches: [
        { field: "msisdn", columns: ["msisdn"], op: "eq" },
        { field: "imsi", columns: ["imsi"], op: "eq" },
        { field: "iccid", columns: ["iccid"], op: "eq" },
        { field: "imei", columns: ["handset"], op: "eq" },
        { field: "ssn", columns: ["account_holder_ssn"], op: "eq" },
      ],
      subjects: [
        { field: "msisdn", via: "msisdn" }, { field: "imsi", via: "imsi" },
        { field: "imei", via: "imei" }, { field: "ssn", via: "ssn" },
      ],
      select: [
        { name: "msisdn", label: "Number", format: "code" },
        { name: "primary", label: "Primary line", format: "bool" },
        ...personColumns("subscriber", "Subscriber"),
        { name: "carrier", label: "Carrier" },
        { name: "host_network", label: "Host network" },
        { name: "mvno", label: "MVNO", format: "bool" },
        { name: "plan_type", label: "Plan" },
        { name: "imsi", label: "IMSI", format: "code" },
        { name: "iccid", label: "ICCID", format: "code" },
        { name: "handset", label: "Handset IMEI", format: "code" },
        ...personColumns("account_holder", "Account holder"),
        { name: "account_holder_ssn", label: "Account holder SSN", format: "code" },
        { name: "account_holder_relation", label: "Relation" },
        { name: "ported_in", label: "Ported in", format: "bool" },
      ],
      order: "subscriber_last_name, msisdn",
    }),
    {
      id: "handsets", label: "Handsets", kind: "record", store: "postgres",
      table: "carrier_devices",
      description: "Hardware by IMEI, eSIM identifier, type allocation code, make or model.",
      fields: [
        { name: "imei", label: "IMEI", size: 17, normalize: "digits" },
        { name: "eid", label: "EID", size: 34, normalize: "digits" },
        { name: "tac", label: "TAC", size: 9, normalize: "digits" },
        { name: "make", label: "Make", size: 12 },
        { name: "model", label: "Model contains", size: 18 },
      ],
      match: [
        { field: "imei", columns: ["imei"], op: "eq" },
        { field: "eid", columns: ["eid"], op: "eq" },
        { field: "tac", columns: ["tac"], op: "eq" },
        { field: "make", columns: ["make"], op: "name" },
        { field: "model", columns: ["model"], op: "contains" },
      ],
      requires: [["imei", "eid", "tac", "make", "model"]],
      select: [
        { name: "imei", label: "IMEI", format: "code" },
        { name: "primary", label: "Primary handset", format: "bool" },
        { name: "tac", label: "TAC", format: "code" },
        { name: "make", label: "Make" },
        { name: "model", label: "Model" },
        { name: "platform", label: "Platform" },
        { name: "os_version", label: "OS" },
        { name: "tier", label: "Tier" },
        { name: "model_released", label: "Released", format: "year" },
        { name: "acquired", label: "Acquired" },
        { name: "condition", label: "Condition" },
        { name: "sim_type", label: "SIM" },
        { name: "eid", label: "EID", format: "code" },
      ],
      order: "make, model",
      note: "Handsets are held without subscriber identity; the IMEI also searches subscriber lines.",
    },
    {
      id: "calls", label: "Calls", kind: "history", store: "clickhouse",
      table: "call_records",
      description: "Calls placed or received by a line on the requested day.",
      fields: [
        OBSERVED,
        { name: "msisdn", label: "Number", size: 16, normalize: "phone" },
        { name: "imsi", label: "IMSI", size: 17, normalize: "digits" },
        { name: "imei", label: "IMEI", size: 17, normalize: "digits" },
        SSN,
        { name: "cell", label: "Cell CGI", size: 22 },
      ],
      match: [
        { field: "date", columns: ["setup_at"], op: "day" },
        { field: "msisdn", columns: ["originating_imsi", "destination_imsi"], op: "in", via: "msisdn_to_imsi" },
        { field: "imsi", columns: ["originating_imsi", "destination_imsi"], op: "eq" },
        { field: "imei", columns: ["originating_imei", "destination_imei"], op: "eq" },
        { field: "ssn", columns: ["originating_imsi", "destination_imsi"], op: "in", via: "ssn_to_imsi" },
        {
          field: "cell",
          columns: ["origin_cell_cgi", "end_cell_cgi", "destination_origin_cell_cgi", "destination_end_cell_cgi"],
          op: "eq",
        },
      ],
      requires: [["msisdn", "imsi", "imei", "ssn", "cell"]],
      subjects: [
        { field: "msisdn", via: "msisdn" }, { field: "imsi", via: "imsi" },
        { field: "imei", via: "imei" }, { field: "ssn", via: "ssn" },
      ],
      select: [
        localTime("setup_at", "Setup"),
        { name: "originating_imsi", label: "Originating IMSI", format: "code" },
        { name: "destination_imsi", label: "Destination IMSI", format: "code" },
        { name: "originating_imei", label: "Originating IMEI", format: "code" },
        { name: "destination_imei", label: "Destination IMEI", format: "code" },
        { name: "outcome", label: "Outcome" },
        { name: "ring_seconds", label: "Ring", format: "seconds", align: "right" },
        { name: "duration_seconds", label: "Duration", format: "seconds", align: "right" },
        { name: "origin_cell_cgi", label: "Origin cell", format: "code" },
        { name: "end_cell_cgi", label: "End cell", format: "code" },
        { name: "destination_origin_cell_cgi", label: "Destination origin cell", format: "code" },
        { name: "destination_end_cell_cgi", label: "Destination end cell", format: "code" },
        { name: "call_record_id", label: "Record", format: "code" },
      ],
      order: "setup_at",
      note: "Content is not held. Handovers during a call are a separate search.",
      cutoffRule: CALL_CUTOFF,
    },
    {
      id: "handovers", label: "Call handovers", kind: "history", store: "clickhouse",
      table: "call_handovers",
      description: "The cells a call moved between, keyed by the call record identifier.",
      fields: [
        { name: "call", label: "Call record", size: 38 },
        { name: "cell", label: "Cell CGI", size: 22 },
      ],
      match: [
        { field: "call", columns: ["call_record_id"], op: "eq" },
        { field: "cell", columns: ["cell_cgi"], op: "eq" },
      ],
      requires: [["call", "cell"]],
      select: [
        { name: "call_record_id", label: "Record", format: "code" },
        { name: "sequence", label: "Seq", align: "right" },
        localTime("occurred_at", "Occurred"),
        { name: "cell_cgi", label: "Cell", format: "code" },
      ],
      order: "call_record_id, sequence",
      cutoffRule: HANDOVER_CUTOFF,
    },
    {
      id: "messages", label: "Messages", kind: "history", store: "clickhouse",
      table: "sms_records",
      description: "Messages sent or received by a line on the requested day.",
      fields: [
        OBSERVED,
        { name: "msisdn", label: "Number", size: 16, normalize: "phone" },
        { name: "imsi", label: "IMSI", size: 17, normalize: "digits" },
        { name: "imei", label: "IMEI", size: 17, normalize: "digits" },
        SSN,
        { name: "cell", label: "Cell CGI", size: 22 },
      ],
      match: [
        { field: "date", columns: ["submitted_at"], op: "day" },
        { field: "msisdn", columns: ["originating_imsi", "destination_imsi"], op: "in", via: "msisdn_to_imsi" },
        { field: "imsi", columns: ["originating_imsi", "destination_imsi"], op: "eq" },
        { field: "imei", columns: ["originating_imei", "destination_imei"], op: "eq" },
        { field: "ssn", columns: ["originating_imsi", "destination_imsi"], op: "in", via: "ssn_to_imsi" },
        { field: "cell", columns: ["originating_cell_cgi", "destination_cell_cgi"], op: "eq" },
      ],
      requires: [["msisdn", "imsi", "imei", "ssn", "cell"]],
      subjects: [
        { field: "msisdn", via: "msisdn" }, { field: "imsi", via: "imsi" },
        { field: "imei", via: "imei" }, { field: "ssn", via: "ssn" },
      ],
      select: [
        localTime("submitted_at", "Submitted"),
        { name: "originating_imsi", label: "Originating IMSI", format: "code" },
        { name: "destination_imsi", label: "Destination IMSI", format: "code" },
        { name: "originating_imei", label: "Originating IMEI", format: "code" },
        { name: "destination_imei", label: "Destination IMEI", format: "code" },
        { name: "multimedia", label: "MMS", format: "bool" },
        { name: "segment_number", label: "Seg", align: "right" },
        { name: "segment_count", label: "Of", align: "right" },
        { name: "originating_cell_cgi", label: "Originating cell", format: "code" },
        { name: "destination_cell_cgi", label: "Destination cell", format: "code" },
        { name: "sms_record_id", label: "Record", format: "code" },
        localTime("delivered_at", "Delivered"),
      ],
      order: "submitted_at",
      note: "Message content is not held by the carrier and is not returned.",
      cutoffRule: MESSAGE_CUTOFF,
    },
    {
      id: "network_events", label: "Network events", kind: "history", store: "clickhouse",
      table: "network_events",
      spatial: "cell",
      description: "Attach, connect, release, tracking-area update and handover events for a line or a cell, with the timing advance the cell measured (78 m per unit of distance from the antenna) and the secondary carrier added while connected.",
      fields: [
        OBSERVED,
        { name: "msisdn", label: "Number", size: 16, normalize: "phone" },
        { name: "imsi", label: "IMSI", size: 17, normalize: "digits" },
        { name: "imei", label: "IMEI", size: 17, normalize: "digits" },
        SSN,
        {
          name: "event", label: "Event", kind: "select", options: [
            { value: "", label: "Any" },
            { value: "attach", label: "Attach" },
            { value: "detach", label: "Detach" },
            { value: "connect", label: "Connect" },
            { value: "release", label: "Release" },
            { value: "tau", label: "Tracking area update" },
            { value: "handover", label: "Handover" },
          ],
        },
        { name: "cell", label: "Cell CGI", size: 22 },
      ],
      match: [
        { field: "date", columns: ["occurred_at"], op: "day" },
        { field: "msisdn", columns: ["imsi"], op: "in", via: "msisdn_to_imsi" },
        { field: "imsi", columns: ["imsi"], op: "eq" },
        { field: "imei", columns: ["imei"], op: "eq" },
        { field: "ssn", columns: ["imsi"], op: "in", via: "ssn_to_imsi" },
        { field: "event", columns: ["event_type"], op: "eq" },
        { field: "cell", columns: ["cell_cgi"], op: "eq" },
      ],
      requires: [["msisdn", "imsi", "imei", "ssn", "cell"]],
      subjects: [
        { field: "msisdn", via: "msisdn" }, { field: "imsi", via: "imsi" },
        { field: "imei", via: "imei" }, { field: "ssn", via: "ssn" },
      ],
      select: [
        localTime("occurred_at", "Occurred"),
        { name: "imsi", label: "IMSI", format: "code" },
        { name: "imei", label: "IMEI", format: "code" },
        { name: "event_type", label: "Event" },
        { name: "cell_cgi", label: "Cell", format: "code" },
        { name: "previous_cell_cgi", label: "Previous cell", format: "code" },
        { name: "tracking_area", label: "TAC", format: "code" },
        { name: "timing_advance", label: "Timing advance", align: "right" },
        { name: "secondary_cell_cgi", label: "Secondary cell", format: "code" },
        { name: "event_id", label: "Event ID", format: "code" },
      ],
      order: "occurred_at",
      note: "A cell on its own returns every line that cell served that day. Timing advance is the cell's distance measurement: multiply by 78 m for the range from the antenna along the signal path, which reads long where the path was not direct.",
    },
    {
      id: "cell_sites", label: "Cell sites", kind: "record", store: "postgres",
      table: "carrier_cell_sites",
      spatial: "coordinates",
      description: "Radio sectors by CGI, structure, operator, tracking area, radio generation or band.",
      fields: [
        { name: "cgi", label: "CGI", size: 24 },
        { name: "structure", label: "Structure ID", size: 18, normalize: "upper" },
        { name: "operator", label: "Operator contains", size: 20 },
        { name: "tracking_area", label: "Tracking area", size: 12, normalize: "digits" },
        { name: "radio", label: "Radio", size: 8, normalize: "upper" },
        { name: "band", label: "Band", size: 12 },
      ],
      match: [
        { field: "cgi", columns: ["cgi"], op: "eq" },
        { field: "structure", columns: ["structure_id"], op: "name" },
        { field: "operator", columns: ["operator"], op: "contains" },
        { field: "tracking_area", columns: ["tracking_area"], op: "eq" },
        { field: "radio", columns: ["radio"], op: "name" },
        { field: "band", columns: ["band"], op: "name" },
      ],
      requires: [["cgi", "structure", "operator", "tracking_area", "radio", "band"]],
      select: [
        { name: "cgi", label: "CGI", format: "code" },
        { name: "cell_key", label: "Cell key", format: "code" },
        { name: "structure_id", label: "Structure ID", format: "code" },
        { name: "operator", label: "Operator" },
        { name: "operator_key", label: "Operator key", format: "code" },
        { name: "mcc", label: "MCC", format: "code" },
        { name: "mnc", label: "MNC", format: "code" },
        { name: "radio", label: "Radio" },
        { name: "band", label: "Band" },
        { name: "role", label: "Role" },
        { name: "frequency_mhz", label: "MHz", align: "right" },
        { name: "station_id", label: "Station", format: "code" },
        { name: "cell_id", label: "Cell ID", format: "code" },
        { name: "identity", label: "Identity", format: "code" },
        { name: "tracking_area", label: "Tracking area", format: "code" },
        { name: "sector", label: "Sector", align: "right" },
        { name: "azimuth", label: "Azimuth", align: "right" },
        { name: "beamwidth", label: "Beamwidth", align: "right" },
        { name: "downtilt", label: "Downtilt", align: "right" },
        { name: "height_m", label: "Height m", align: "right" },
        { name: "eirp_dbm", label: "EIRP dBm", align: "right" },
        { name: "range_m", label: "Range m", align: "right" },
        { name: "morphology", label: "Morphology" },
        { name: "latitude", label: "Latitude", align: "right" },
        { name: "longitude", label: "Longitude", align: "right" },
        { name: "pci", label: "PCI", format: "code" },
      ],
      order: "operator, structure_id, sector",
    },
    {
      id: "structures", label: "Tower structures", kind: "record", store: "postgres",
      table: "carrier_structures",
      spatial: "coordinates",
      description: "Masts and supporting structures by ID, ASR number, owner or structure type.",
      fields: [
        { name: "structure", label: "Structure ID", size: 18, normalize: "upper" },
        { name: "asr", label: "ASR", size: 14, normalize: "upper" },
        { name: "owner", label: "Owner contains", size: 22 },
        { name: "type", label: "Structure type contains", size: 20 },
      ],
      match: [
        { field: "structure", columns: ["structure_id"], op: "name" },
        { field: "asr", columns: ["asr"], op: "name" },
        { field: "owner", columns: ["owner"], op: "contains" },
        { field: "type", columns: ["structure_type", "structure"], op: "contains" },
      ],
      requires: [["structure", "asr", "owner", "type"]],
      select: [
        { name: "structure_id", label: "Structure ID", format: "code" },
        { name: "asr", label: "ASR", format: "code" },
        { name: "structure", label: "Structure" },
        { name: "structure_type", label: "Type" },
        { name: "owner", label: "Owner" },
        { name: "height_m", label: "Height m", align: "right" },
        { name: "building_levels", label: "Building levels", align: "right" },
        { name: "latitude", label: "Latitude", align: "right" },
        { name: "longitude", label: "Longitude", align: "right" },
        { name: "in_city", label: "In city", format: "bool" },
      ],
      order: "structure_id",
    },
  ],
};

const PLATE_READERS: DatabaseDef = {
  id: "alpr", code: "ALPR", name: "Plate reader network",
  custodian: "private", holder: "Commercial — fixed and mobile plate reader operators",
  description:
    "The fixed-camera inventory and automated plate reads: where each camera is "
    + "mounted, the approach it watches, the plate as read and the confidence returned.",
  queries: [
    {
      id: "cameras", label: "Cameras", kind: "record", store: "postgres",
      table: "alpr_cameras",
      spatial: "coordinates",
      description: "Fixed readers by camera ID, address, road, site, role or owner.",
      fields: [
        { name: "camera", label: "Camera", size: 12, normalize: "upper", placeholder: "ALPR-001" },
        { name: "address", label: "Address contains", size: 28 },
        { name: "street", label: "Road contains", size: 22 },
        { name: "site", label: "Site contains", size: 22 },
        {
          name: "role", label: "Role", kind: "select", options: [
            { value: "", label: "Any" },
            { value: "cordon", label: "Cordon" },
            { value: "arterial", label: "Arterial" },
            { value: "commercial", label: "Commercial" },
          ],
        },
        { name: "owner", label: "Owner contains", size: 24 },
      ],
      match: [
        { field: "camera", columns: ["camera_id"], op: "eq" },
        { field: "address", columns: ["address"], op: "contains" },
        { field: "street", columns: ["street"], op: "contains" },
        { field: "site", columns: ["site"], op: "contains" },
        { field: "role", columns: ["role"], op: "eq" },
        { field: "owner", columns: ["owner"], op: "contains" },
      ],
      requires: [["camera", "address", "street", "site", "role", "owner"]],
      select: [
        { name: "camera_id", label: "Camera", format: "code" },
        { name: "address", label: "Address" },
        { name: "latitude", label: "Latitude" },
        { name: "longitude", label: "Longitude" },
        { name: "street", label: "Road" },
        { name: "site", label: "Site" },
        { name: "role", label: "Role" },
        { name: "owner", label: "Owner" },
        { name: "owner_kind", label: "Owner kind" },
        { name: "mount_id", label: "Mount", format: "code" },
        { name: "mount_kind", label: "Mount kind" },
        { name: "mount_height_m", label: "Height m", align: "right" },
        { name: "reads", label: "Plate side" },
        { name: "azimuth", label: "Azimuth", align: "right" },
        { name: "road_class", label: "Road class" },
        { name: "network", label: "Network" },
      ],
      order: "camera_id",
      note: "Coordinates are the physical mount location; address is the site address when available, otherwise the watched road name.",
    },
    {
      id: "reads", label: "Reads", kind: "history", store: "clickhouse",
      table: "alpr_reads",
      spatial: "camera",
      description: "Reads for a day, by plate, owner or camera.",
      fields: [
        OBSERVED,
        { name: "plate", label: "Plate", size: 10, placeholder: "AAA-0000", normalize: "plate_compact" },
        { name: "camera", label: "Camera", size: 12, normalize: "upper", placeholder: "ALPR-001" },
      ],
      match: [
        { field: "date", columns: ["observed_at"], op: "day" },
        { field: "plate", columns: ["normalized_plate"], op: "eq" },
        { field: "camera", columns: ["camera_id"], op: "eq" },
      ],
      requires: [["plate", "camera"]],
      subjects: [{ field: "plate", via: "plate" }],
      select: [
        localTime("observed_at", "Observed"),
        { name: "camera_id", label: "Camera", format: "code" },
        { name: "plate_text", label: "Plate as read", format: "code" },
        { name: "normalized_plate", label: "Normalised", format: "code" },
        { name: "confidence", label: "Confidence", align: "right" },
        { name: "lighting", label: "Lighting" },
        { name: "read_id", label: "Read", format: "code" },
      ],
      order: "observed_at",
    },
  ],
};

const RECORDER: DatabaseDef = {
  id: "recorder", code: "REC", name: "County recorder",
  custodian: "county", holder: "County — deeds, parcels and assessment",
  description:
    "Recorded deeds and the parcels they convey, assessed value, year built and "
    + "what the property last sold for.",
  queries: [
    {
      id: "property", label: "Property", kind: "record", store: "postgres",
      table: "county_recorder_properties",
      description: "Parcels by number, address, deed book and page, or recorded owner.",
      fields: [
        { name: "parcel", label: "Parcel", size: 16, normalize: "upper" },
        { name: "address", label: "Address contains", size: 24 },
        { name: "book", label: "Deed book", size: 7, normalize: "digits" },
        { name: "page", label: "Deed page", size: 7, normalize: "digits" },
        SURNAME,
        GIVEN,
      ],
      match: [
        { field: "parcel", columns: ["parcel"], op: "eq" },
        { field: "address", columns: ["address"], op: "contains" },
        { field: "book", columns: ["deed_book"], op: "eq" },
        { field: "page", columns: ["deed_page"], op: "eq" },
        { field: "surname", columns: ["owner_last_name"], op: "name" },
        { field: "given", columns: ["owner_first_name"], op: "name" },
      ],
      requires: [["parcel", "address", "book", "page", "surname", "given"]],
      select: [
        { name: "owner_last_name", label: "Owner surname" },
        { name: "owner_first_name", label: "Owner given" },
        { name: "owner_middle_name", label: "Owner middle" },
        { name: "parcel", label: "Parcel", format: "code" },
        { name: "address", label: "Address" },
        { name: "deed_book", label: "Deed book", align: "right" },
        { name: "deed_page", label: "Deed page", align: "right" },
        { name: "recorded", label: "Recorded", format: "date" },
        { name: "issuer", label: "Recorded by" },
        { name: "assessed_value", label: "Assessed", format: "money", align: "right" },
        { name: "purchase_price", label: "Purchase price", format: "money", align: "right" },
        { name: "year_built", label: "Built", format: "year" },
        { name: "year_built_or_earlier", label: "Built year is upper bound", format: "bool" },
      ],
      order: "owner_last_name, owner_first_name",
      note: "The recorder keeps no date of birth; names here are not tied to an SSN.",
    },
  ],
};

const PLATFORMS: DatabaseDef = {
  id: "platforms", code: "PLAT", name: "Online platforms",
  custodian: "private", holder: "Commercial — messaging and social platform operators",
  description:
    "Account records held by messaging and social platforms: handle, display "
    + "name, the line it was registered against and when it was created.",
  queries: [
    personSearch({
      id: "accounts", label: "Accounts", table: "platform_accounts",
      description: "Accounts by handle, display name, registered line, channel or owner.",
      prefix: "owner", ssn: false,
      own: [
        { name: "handle", label: "Handle", size: 20 },
        { name: "display", label: "Display name contains", size: 20 },
        { name: "line", label: "Registered line", size: 16, normalize: "phone" },
        {
          name: "channel", label: "Channel", kind: "select", options: [
            { value: "", label: "Any" },
            { value: "sms", label: "SMS" },
            { value: "imessage", label: "iMessage" },
            { value: "messenger", label: "Messenger" },
            { value: "whatsapp", label: "WhatsApp" },
            { value: "signal", label: "Signal" },
            { value: "telegram", label: "Telegram" },
            { value: "snapchat", label: "Snapchat" },
          ],
        },
      ],
      ownMatches: [
        { field: "handle", columns: ["handle"], op: "eq" },
        { field: "display", columns: ["display_name"], op: "contains" },
        { field: "line", columns: ["line"], op: "eq" },
        { field: "channel", columns: ["channel"], op: "eq" },
      ],
      subjects: [{ field: "line", via: "msisdn" }],
      select: [
        ...personColumns("owner", "Owner"),
        { name: "channel", label: "Channel" },
        { name: "handle", label: "Handle", format: "code" },
        { name: "display_name", label: "Display name" },
        { name: "line", label: "Registered line", format: "code" },
        { name: "created", label: "Created", format: "date" },
      ],
      order: "owner_last_name, channel",
    }),
  ],
};

const PDMP: DatabaseDef = {
  id: "pdmp", code: "PDMP", name: "Prescription monitoring",
  custodian: "state", holder: "State — dispensing pharmacies and the PDMP",
  description:
    "Dispensed prescriptions, the prescriber and pharmacy behind them, days "
    + "supplied and whether the fill was reportable.",
  queries: [
    personSearch({
      id: "prescriptions", label: "Prescriptions", table: "pharmacy_prescriptions",
      description: "Fills by patient, drug, schedule, pharmacy or prescriber.",
      prefix: "patient", ssn: false,
      own: [
        { name: "drug", label: "Drug", size: 18 },
        { name: "schedule", label: "Schedule", size: 5, normalize: "upper" },
        { name: "pharmacy", label: "Pharmacy contains", size: 20 },
        { name: "prescriber", label: "Prescriber contains", size: 20 },
      ],
      ownMatches: [
        { field: "drug", columns: ["drug"], op: "contains" },
        { field: "schedule", columns: ["schedule"], op: "eq" },
        { field: "pharmacy", columns: ["pharmacy"], op: "contains" },
        { field: "prescriber", columns: ["prescriber"], op: "contains" },
      ],
      select: [
        ...personColumns("patient", "Patient"),
        { name: "drug", label: "Drug" },
        { name: "drug_class", label: "Class" },
        { name: "schedule", label: "Schedule" },
        { name: "written", label: "Written", format: "date" },
        { name: "days_supply", label: "Days", align: "right" },
        { name: "refills", label: "Refills", align: "right" },
        { name: "pharmacy", label: "Pharmacy" },
        { name: "prescriber", label: "Prescriber" },
        { name: "pdmp_reported", label: "Reported", format: "bool" },
      ],
      order: "written DESC",
    }),
  ],
};

const EDUCATION: DatabaseDef = {
  id: "education", code: "EDU", name: "Education providers",
  custodian: "private", holder: "Institutions and the national clearing house",
  description: "Degrees and credentials awarded, the awarding institution, field and year.",
  queries: [
    personSearch({
      id: "credentials", label: "Credentials", table: "education_credentials",
      description: "Awards by student, institution, field or year.",
      prefix: "student", ssn: false,
      own: [
        { name: "institution", label: "Institution contains", size: 24 },
        { name: "field", label: "Field contains", size: 20 },
        { name: "awarded", label: "Awarded year", size: 6, normalize: "digits" },
      ],
      ownMatches: [
        { field: "institution", columns: ["institution"], op: "contains" },
        { field: "field", columns: ["field", "second_field"], op: "contains" },
        { field: "awarded", columns: ["awarded"], op: "eq" },
      ],
      select: [
        ...personColumns("student", "Student"),
        { name: "credential", label: "Credential" },
        { name: "institution", label: "Institution" },
        { name: "field", label: "Field" },
        { name: "second_field", label: "Second field" },
        { name: "awarded", label: "Awarded", format: "year" },
        { name: "title", label: "Title" },
      ],
      order: "awarded DESC",
    }),
  ],
};

const MILITARY: DatabaseDef = {
  id: "military", code: "DOD", name: "Military service records",
  custodian: "federal", holder: "Federal — service departments and the VA",
  description: "Branch and component, service dates, conflict served and discharge character.",
  queries: [
    personSearch({
      id: "service", label: "Service records", table: "military_service_records",
      description: "Service records by member, branch or conflict.",
      prefix: "service_member", ssn: true,
      own: [
        { name: "branch", label: "Branch", size: 14 },
        { name: "conflict", label: "Conflict contains", size: 18 },
      ],
      ownMatches: [
        { field: "branch", columns: ["branch"], op: "name" },
        { field: "conflict", columns: ["conflict"], op: "contains" },
      ],
      subjects: [{ field: "ssn", via: "ssn" }],
      select: [
        ...personColumns("service_member", "Member"),
        { name: "service_member_ssn", label: "SSN", format: "code" },
        { name: "branch", label: "Branch" },
        { name: "component", label: "Component" },
        { name: "entered", label: "Entered", format: "year" },
        { name: "separated", label: "Separated", format: "year" },
        { name: "conflict", label: "Conflict" },
        { name: "discharge", label: "Discharge" },
        { name: "document", label: "Document", format: "code" },
      ],
      order: "entered DESC",
    }),
  ],
};

export const DATABASES: readonly DatabaseDef[] = [
  SOCIAL_SECURITY,
  HOMELAND_SECURITY,
  TRANSPORTATION,
  CRIMINAL_COURTS,
  CIVIL_COURTS,
  CORRECTIONS,
  STATE_POLICE,
  BANKS,
  CARRIERS,
  PLATE_READERS,
  RECORDER,
  PLATFORMS,
  PDMP,
  EDUCATION,
  MILITARY,
];

export function findDatabase(id: string): DatabaseDef | undefined {
  return DATABASES.find((database) => database.id === id);
}

export function findQuery(databaseId: string, queryId: string): { database: DatabaseDef; query: QueryDef } | undefined {
  const database = findDatabase(databaseId);
  const query = database?.queries.find((entry) => entry.id === queryId);
  if (!database || !query) return undefined;
  return { database, query };
}

/** What the page needs to draw a form: no table names, no SQL. */
export function publicCatalog(policy?: KdiPolicy) {
  return DATABASES.map((database) => ({
    id: database.id,
    code: database.code,
    name: database.name,
    custodian: database.custodian,
    holder: database.holder,
    description: database.description,
    queries: database.queries.map((original) => {
      const query = applyQueryPolicy(policy, database.id, original);
      return ({
        id: query.id,
        label: query.label,
        kind: query.kind,
        description: query.description,
        note: query.note,
        fields: query.fields,
        filters: filtersForQuery(query),
        requires: query.requires,
        spatial: query.spatial ? { supported: true, maxRadiusMetres: 10_000 } : { supported: false },
        columns: query.select.map(({ name, label, format, align }) => ({ name, label, format, align })),
        selectable: query.select.map(({ name }) => name),
      });
    }),
  }));
}

export type PublicCatalog = ReturnType<typeof publicCatalog>;
export type PublicDatabase = PublicCatalog[number];
export type PublicQuery = PublicDatabase["queries"][number];

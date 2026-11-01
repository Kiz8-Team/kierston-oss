export type IdentityDetail = "name" | "dob" | "ssn";

export interface IdentityRole {
  /** A KREC id field, "row" for row-indexed people, or "vehicle_owner". */
  source: string;
  /** Column prefix, including the trailing underscore. Empty means the primary subject. */
  prefix: string;
  detail: IdentityDetail;
}

export interface ProviderTable {
  dataset: string;
  recordType: string;
  table: string;
  provider: string;
  description: string;
  identities: IdentityRole[];
  parentColumn?: string;
  indexes?: string[][];
  derivedSsn?: boolean;
  /** Source fields that this provider cannot plausibly hold and must never persist. */
  omittedColumns?: string[];
}

export const PROVIDER_TABLES: readonly ProviderTable[] = [
  {
    dataset: "identity", recordType: "identity", table: "identity_registry_people",
    provider: "Identity registry",
    description: "Legal identity, nullable SSN, parents, residence, employment and veteran facts.",
    identities: [], derivedSsn: true,
    indexes: [["ssn"], ["surname", "birth_date"], ["mailing_address"]],
    omittedColumns: [
      "occupation_code", "soc_code", "industry_code", "worker_class", "weekly_hours", "job_role",
      "education_attainment", "currently_enrolled", "school_id", "school_name", "school_grade", "school_sector",
      "marital_married_last_year", "marital_divorced_last_year", "marital_widowed_last_year",
    ],
  },
  {
    dataset: "identity", recordType: "document", table: "identity_registry_documents",
    provider: "Identity registry",
    description: "Passports, immigration documents and other government identity documents with a copied holder identity.",
    identities: [{ source: "person", prefix: "holder_", detail: "dob" }],
    indexes: [["number"]],
  },
  {
    dataset: "identity", recordType: "device", table: "carrier_devices",
    provider: "Carrier",
    description: "Handset and SIM hardware identifiers and device attributes, without subscriber identity.",
    identities: [],
    indexes: [["imei"], ["eid"]],
  },
  {
    dataset: "identity", recordType: "subscription", table: "carrier_accounts",
    provider: "Carrier",
    description: "Subscriber lines, IMSI/ICCID, carrier and plan data with separate subscriber and account-holder identity copies.",
    identities: [
      { source: "user", prefix: "subscriber_", detail: "dob" },
      { source: "account_holder", prefix: "account_holder_", detail: "ssn" },
    ],
    indexes: [["msisdn"], ["imsi"], ["iccid"]],
  },
  {
    dataset: "identity", recordType: "account", table: "platform_accounts",
    provider: "Online platform",
    description: "Messaging and social-platform handles with a copied account-owner identity.",
    identities: [{ source: "person", prefix: "owner_", detail: "dob" }],
    indexes: [["channel", "handle"], ["line"]],
  },
  {
    dataset: "criminal", recordType: "case", table: "criminal_court_cases",
    provider: "Criminal courts",
    description: "Criminal dockets, filing and disposition, bail, conviction and sentencing with a copied defendant identity.",
    identities: [{ source: "person", prefix: "defendant_", detail: "dob" }],
    indexes: [["docket"], ["magisterial_docket"]],
  },
  {
    dataset: "criminal", recordType: "charge", table: "criminal_court_charges",
    provider: "Criminal courts",
    description: "Individual criminal charges with a copied defendant identity and owning court-case reference.",
    identities: [{ source: "person", prefix: "defendant_", detail: "dob" }],
    parentColumn: "case_record_index", indexes: [["cite", "section"]],
  },
  {
    dataset: "criminal", recordType: "status", table: "corrections_statuses",
    provider: "Corrections",
    description: "Current incarceration, supervision, release and firearms-prohibition status with copied subject identity.",
    identities: [{ source: "row", prefix: "subject_", detail: "dob" }],
    indexes: [["facility"], ["supervision"]],
  },
  {
    dataset: "civil", recordType: "case", table: "civil_court_cases",
    provider: "Civil courts",
    description: "Divorce, custody, eviction, judgment and bankruptcy dockets with a copied party identity.",
    identities: [{ source: "person", prefix: "party_", detail: "dob" }],
    indexes: [["docket"], ["kind", "court"]],
  },
  {
    dataset: "firearms", recordType: "firearm", table: "state_police_firearms",
    provider: "State police firearms unit",
    description: "Firearm sales and transfer records with serial, approval and copied purchaser identity including SSN.",
    identities: [{ source: "person", prefix: "purchaser_", detail: "ssn" }],
    indexes: [["serial"], ["record_of_sale"], ["pics_approval"]],
  },
  {
    dataset: "firearms", recordType: "licence_to_carry", table: "state_police_carry_licenses",
    provider: "State police firearms unit",
    description: "Licences to carry with status, issuer and copied licensee identity including SSN.",
    identities: [{ source: "person", prefix: "licensee_", detail: "ssn" }],
    indexes: [["number"]],
  },
  {
    dataset: "firearms", recordType: "pics_check", table: "state_police_background_checks",
    provider: "State police firearms unit",
    description: "Firearm purchase background checks and outcomes with copied applicant identity including SSN.",
    identities: [{ source: "person", prefix: "applicant_", detail: "ssn" }],
    indexes: [["approval"], ["date"]],
  },
  {
    dataset: "vehicles", recordType: "vehicle", table: "dot_vehicle_registrations",
    provider: "Department of Transportation",
    description: "Titles, registrations, plates, vehicle attributes and insurance with a copied registered-owner identity when personally owned.",
    identities: [{ source: "vehicle_owner", prefix: "registered_owner_", detail: "ssn" }],
    indexes: [["vin"], ["plate"]],
  },
  {
    dataset: "vehicles", recordType: "auto_loan", table: "bank_auto_loans",
    provider: "Banks",
    description: "Vehicle-secured loans with balance, terms, VIN and copied borrower KYC identity.",
    identities: [{ source: "person", prefix: "borrower_", detail: "ssn" }],
    indexes: [["vin"]],
  },
  {
    dataset: "holdings", recordType: "licence", table: "dot_driver_licenses",
    provider: "Department of Transportation",
    description: "Driver licences and photo IDs with class, status, restrictions and copied licensee identity including SSN.",
    identities: [{ source: "person", prefix: "licensee_", detail: "ssn" }],
    indexes: [["number"]],
  },
  {
    dataset: "holdings", recordType: "suspension", table: "dot_license_suspensions",
    provider: "Department of Transportation",
    description: "Driver-licence suspensions with reason and docket plus copied licensee identity.",
    identities: [{ source: "person", prefix: "licensee_", detail: "ssn" }],
    parentColumn: "license_record_index", indexes: [["docket"]],
  },
  {
    dataset: "holdings", recordType: "bank_account", table: "bank_accounts",
    provider: "Banks",
    description: "Deposit and cash accounts, balances, routing and account controls with a copied customer KYC identity.",
    identities: [{ source: "person", prefix: "customer_", detail: "ssn" }],
    indexes: [["routing", "number"]],
  },
  {
    dataset: "holdings", recordType: "income_stream", table: "bank_income_streams",
    provider: "Banks",
    description: "Observed recurring deposits and payroll routing with copied account-customer identity.",
    identities: [{ source: "person", prefix: "customer_", detail: "ssn" }],
    indexes: [["account"]],
  },
  {
    dataset: "holdings", recordType: "credit_card", table: "bank_credit_cards",
    provider: "Banks",
    description: "Credit-card accounts, limits and balances with copied cardholder KYC identity.",
    identities: [{ source: "person", prefix: "cardholder_", detail: "ssn" }],
    indexes: [["issuer", "last_four"]],
  },
  {
    dataset: "holdings", recordType: "debit_card", table: "bank_debit_cards",
    provider: "Banks",
    description: "Debit cards and linked accounts with copied cardholder KYC identity.",
    identities: [{ source: "person", prefix: "cardholder_", detail: "ssn" }],
    indexes: [["account"], ["issuer", "last_four"]],
  },
  {
    dataset: "holdings", recordType: "mortgage", table: "bank_mortgages",
    provider: "Banks",
    description: "Mortgage principal, balance, rate, payment and recording references with copied borrower KYC identity.",
    identities: [{ source: "person", prefix: "borrower_", detail: "ssn" }],
    indexes: [["parcel"], ["mortgage_book", "mortgage_page"]],
  },
  {
    dataset: "holdings", recordType: "real_property", table: "county_recorder_properties",
    provider: "County recorder",
    description: "Deeds, parcels, addresses, assessments and purchase values with a copied owner name.",
    identities: [{ source: "person", prefix: "owner_", detail: "name" }],
    indexes: [["parcel"], ["deed_book", "deed_page"]],
  },
  {
    dataset: "holdings", recordType: "student_loan", table: "bank_student_loans",
    provider: "Banks",
    description: "Student-loan servicing, principal, balance and status with copied borrower KYC identity.",
    identities: [{ source: "person", prefix: "borrower_", detail: "ssn" }],
  },
  {
    dataset: "holdings", recordType: "credential", table: "education_credentials",
    provider: "Education providers",
    description: "Degrees and credentials, institutions, fields and award years with a copied student identity.",
    identities: [{ source: "person", prefix: "student_", detail: "dob" }],
    indexes: [["institution"], ["credential"]],
  },
  {
    dataset: "holdings", recordType: "prescription", table: "pharmacy_prescriptions",
    provider: "Pharmacies and PDMP",
    description: "Prescription, prescriber, pharmacy, supply and controlled-substance reporting with copied patient identity.",
    identities: [{ source: "person", prefix: "patient_", detail: "dob" }],
    indexes: [["drug"], ["written"]],
  },
  {
    dataset: "holdings", recordType: "military_service", table: "military_service_records",
    provider: "Military records",
    description: "Branch, component, service dates, conflict and discharge with copied service-member identity including SSN.",
    identities: [{ source: "person", prefix: "service_member_", detail: "ssn" }],
  },
] as const;

const BY_SOURCE = new Map(
  PROVIDER_TABLES.map((table) => [`${table.dataset}\0${table.recordType}`, table]),
);

export function providerTable(dataset: string, recordType: string): ProviderTable {
  const found = BY_SOURCE.get(`${dataset}\0${recordType}`);
  if (!found) throw new Error(`no provider table owns ${dataset}.${recordType}`);
  return found;
}

export function omittedProviderRecord(dataset: string, recordType: string): boolean {
  return dataset === "holdings" && recordType === "payment_profile";
}

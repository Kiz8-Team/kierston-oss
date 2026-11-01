import type { ResolverId } from "./catalog-types";
import { postgres, STATIC_SCHEMA } from "./stores";

// Registers are indexed by the identifier their own custodian uses. An operator
// holding a telephone number cannot query the network's event store with it --
// that store knows only IMSIs -- so KDI translates first, and says in the
// response header which register did the translating.

function table(name: string): string {
  return `"${STATIC_SCHEMA}"."${name}"`;
}

async function column(sql: string, value: string): Promise<string[]> {
  const result = await postgres().query(sql, [value]);
  return result.rows
    .map((row) => Object.values(row)[0])
    .filter((entry): entry is string | number => entry !== null && entry !== undefined)
    .map(String);
}

const RESOLVERS: Record<ResolverId, (value: string) => Promise<string[]>> = {
  msisdn_to_imsi: (value) =>
    column(`SELECT imsi FROM ${table("carrier_accounts")} WHERE msisdn = $1 AND imsi IS NOT NULL`, value),
  ssn_to_imsi: (value) =>
    column(
      `SELECT imsi FROM ${table("carrier_accounts")} WHERE account_holder_ssn = $1 AND imsi IS NOT NULL`,
      value,
    ),
  ssn_to_account_numbers: (value) =>
    column(
      `SELECT number FROM ${table("bank_accounts")} WHERE customer_ssn = $1 AND number IS NOT NULL`,
      value,
    ),
  docket_to_case_index: (value) =>
    column(
      `SELECT _record_index FROM ${table("criminal_court_cases")}
       WHERE upper(docket) = $1 OR upper(magisterial_docket) = $1`,
      value,
    ),
  licence_to_record_index: (value) =>
    column(`SELECT _record_index FROM ${table("dot_driver_licenses")} WHERE number = $1`, value),
};

export function resolve(id: ResolverId, value: string): Promise<string[]> {
  return RESOLVERS[id](value);
}

/** Which source a translation came out of, named the way a person would say it. */
export const RESOLVER_SOURCE: Record<ResolverId, string> = {
  msisdn_to_imsi: "the carrier subscriber records",
  ssn_to_imsi: "the carrier subscriber records",
  ssn_to_account_numbers: "the bank account records",
  docket_to_case_index: "the criminal docket index",
  licence_to_record_index: "the driver licence file",
};

export interface Subject {
  name: string;
  dob: string | null;
  ssn: string | null;
  address: string | null;
  mobile: string | null;
  /** How the subject was arrived at, e.g. "Registered owner of plate KYX-9308". */
  derivation: string;
}

function personName(row: Record<string, unknown>, prefix: string): string {
  const parts = [row[`${prefix}first_name`], row[`${prefix}middle_name`], row[`${prefix}last_name`]];
  return parts.filter(Boolean).join(" ") || "unknown";
}

async function personBySsn(ssn: string): Promise<Omit<Subject, "derivation"> | null> {
  const result = await postgres().query(
    `SELECT ssn, first_name, middle_name, surname, birth_date, mailing_address, mobile
     FROM ${table("identity_registry_people")} WHERE ssn = $1 LIMIT 1`,
    [ssn],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    name: [row.first_name, row.middle_name, row.surname].filter(Boolean).join(" "),
    dob: row.birth_date ?? null,
    ssn: row.ssn ?? null,
    address: row.mailing_address ?? null,
    mobile: row.mobile ?? null,
  };
}

async function personByName(
  first: string | null,
  last: string | null,
  dob: string | null,
): Promise<Omit<Subject, "derivation"> | null> {
  if (!first || !last || !dob) return null;
  const result = await postgres().query(
    `SELECT ssn, first_name, middle_name, surname, birth_date, mailing_address, mobile
     FROM ${table("identity_registry_people")}
     WHERE upper(first_name) = upper($1) AND upper(surname) = upper($2) AND birth_date = $3
     LIMIT 2`,
    [first, last, dob],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  return {
    name: [row.first_name, row.middle_name, row.surname].filter(Boolean).join(" "),
    dob: row.birth_date ?? null,
    ssn: row.ssn ?? null,
    address: row.mailing_address ?? null,
    mobile: row.mobile ?? null,
  };
}

/**
 * Put a person at the top of a response. A CDR keyed by IMSI means nothing on
 * its own; the header says whose line it is and how KDI decided that.
 */
export async function subjectFor(
  via: "ssn" | "msisdn" | "imsi" | "imei" | "plate" | "vin" | "account" | "name",
  value: string,
): Promise<Subject | null> {
  const pool = postgres();
  if (via === "ssn") {
    const person = await personBySsn(value);
    return person && { ...person, derivation: `Number holder for SSN ${value}` };
  }
  if (via === "msisdn" || via === "imsi" || via === "imei") {
    const key = via === "msisdn" ? "msisdn" : via === "imsi" ? "imsi" : "handset";
    const result = await pool.query(
      `SELECT subscriber_first_name, subscriber_middle_name, subscriber_last_name,
              subscriber_date_of_birth, account_holder_ssn
       FROM ${table("carrier_accounts")} WHERE ${key} = $1 LIMIT 1`,
      [value],
    );
    const row = result.rows[0];
    if (!row) return null;
    const person = await personByName(
      row.subscriber_first_name,
      row.subscriber_last_name,
      row.subscriber_date_of_birth,
    );
    return {
      name: person?.name ?? personName(row, "subscriber_"),
      dob: person?.dob ?? row.subscriber_date_of_birth ?? null,
      ssn: person?.ssn ?? null,
      address: person?.address ?? null,
      mobile: person?.mobile ?? null,
      derivation: `Subscriber on ${via === "msisdn" ? value : `${via.toUpperCase()} ${value}`}, per the carrier records`,
    };
  }
  if (via === "plate" || via === "vin") {
    const key = via === "plate" ? "plate" : "vin";
    const result = await pool.query(
      `SELECT registered_owner_ssn, registered_owner_first_name, registered_owner_middle_name,
              registered_owner_last_name, registered_owner_date_of_birth, owner_type
       FROM ${table("dot_vehicle_registrations")} WHERE upper(${key}) = upper($1) LIMIT 1`,
      [value],
    );
    const row = result.rows[0];
    if (!row) return null;
    const person = row.registered_owner_ssn ? await personBySsn(row.registered_owner_ssn) : null;
    return {
      name: person?.name ?? personName(row, "registered_owner_") ,
      dob: person?.dob ?? row.registered_owner_date_of_birth ?? null,
      ssn: person?.ssn ?? row.registered_owner_ssn ?? null,
      address: person?.address ?? null,
      mobile: person?.mobile ?? null,
      derivation: `Registered owner of ${via === "plate" ? `plate ${value}` : `VIN ${value}`}`
        + `${row.owner_type && row.owner_type !== "person" ? ` (${row.owner_type})` : ""}`,
    };
  }
  if (via === "account") {
    const result = await pool.query(
      `SELECT customer_ssn, institution FROM ${table("bank_accounts")} WHERE number = $1 LIMIT 1`,
      [value],
    );
    const row = result.rows[0];
    if (!row?.customer_ssn) return null;
    const person = await personBySsn(row.customer_ssn);
    return person && {
      ...person,
      derivation: `Customer of record on account ${value}${row.institution ? ` at ${row.institution}` : ""}`,
    };
  }
  return null;
}

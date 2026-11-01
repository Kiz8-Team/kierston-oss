"use client";

import type { RecordDataset } from "./datasets";
import type { Identity } from "./identity";
import type { RecordSet, RecordTable } from "./records";

/**
 * Everything the simulation holds about one person, gathered in one place.
 *
 * The record browsers cut the data by record type — every firearm, every
 * mortgage — which is how you interrogate a generator. This is the other cut,
 * and the one that shows what the generators have actually built between them:
 * a named person with a birth certificate, a licence, a car, a loan against
 * that car, a docket that suspended the licence, and the statute that now bars
 * them from the gun they bought in 2017.
 *
 * Assembling it is cheap. Each packed table keeps an index from resident id to
 * its rows, built on first use, so a dossier is a handful of map lookups
 * rather than a scan — which is why this works against the binaries and does
 * not need a database behind it. The cost is paid once, in loading the six
 * files, and every person after the first is instant.
 */

export type DossierSource = RecordDataset | "identity";

export interface SectionDef {
  source: DossierSource;
  table: string;
  label: string;
  /** The group heading this section sits under. */
  group: string;
  /**
   * The field holding the resident id. Omitted where the row index *is* the
   * resident id — the identity and standing tables are packed that way, and
   * always have exactly one row per person.
   */
  person?: string;
  /**
   * Where the rows are a child table rather than a top-level one. Documents
   * hang off an identity and have no resident id of their own, so they are
   * reached through the parent's offset array.
   */
  childOf?: { table: string; field: string };
  /** Fields making the one-line summary when the section is collapsed. */
  summary?: string[];
  /**
   * How to print a field whose kind does not say enough on its own.
   *
   * The packer has one float kind for a rate, and two fields can mean
   * different things by it: a mortgage's 7.248 is already 7.248%, while a
   * payment profile's 0.19 is 19%. `share` is the second reading.
   */
  formats?: Record<string, "money" | "exact" | "share">;
  /**
   * Fields that have to say something for the row to be a record at all.
   *
   * Only the tables packed one row per person need this. Criminal standing is
   * derived for everyone, so a resident who has never been charged still has a
   * row there — `incarcerated: false`, no supervision, and the latent
   * offending class the generator drew to decide they would not offend. Counted
   * as a record, that gave all 121,060 residents a justice record and made the
   * section's counter read 1 for people with nothing in it.
   */
  carries?: string[];
}

/**
 * Whether a row says anything under the named fields.
 *
 * A false boolean says nothing — "not incarcerated" is the absence of a fact,
 * not a fact — and neither does an empty list or a null.
 */
function carriesAnything(table: RecordTable, row: number, fields: string[]): boolean {
  return fields.some((field) => {
    if (!table.has(field)) return false;
    const value = table.value(field, row);
    if (value === null || value === false) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });
}

/**
 * The order a record is read in: who someone is, then what the state has
 * done to them, then what they own. Sections with no rows are dropped, so a
 * person with no criminal history simply has no justice section.
 */
export const DOSSIER_SECTIONS: SectionDef[] = [
  {
    source: "identity", table: "identity", label: "Identity", group: "Identity",
    summary: ["birth_date", "citizenship", "legal_status", "status_basis"],
  },
  {
    source: "identity", table: "document", label: "Immigration documents",
    group: "Identity", childOf: { table: "identity", field: "documents" },
    summary: ["document", "number", "issued"],
  },
  // Handsets and lines reach the same way documents do — child tables of the
  // identity, with no resident id of their own to join on. They sit here rather
  // than beside the vehicles because a phone is how somebody is reached, not
  // something they own: the section answers the same question the name and the
  // address do.
  {
    source: "identity", table: "device", label: "Handsets", group: "Identity",
    childOf: { table: "identity", field: "devices" },
    summary: ["make", "model", "imei"],
  },
  {
    source: "identity", table: "subscription", label: "Lines", group: "Identity",
    childOf: { table: "identity", field: "subscriptions" },
    summary: ["msisdn", "carrier", "plan_type"],
  },
  // Who somebody is on each platform, which is the same question as the number
  // and the handset and belongs beside them: a handle is how a person is
  // reached by anyone who does not have their number.
  {
    source: "identity", table: "account", label: "Messaging accounts",
    group: "Identity", childOf: { table: "identity", field: "accounts" },
    summary: ["channel", "handle", "display_name"],
  },
  {
    source: "criminal", table: "status", label: "Standing", group: "Justice",
    summary: ["supervision", "facility", "release_year"],
    carries: [
      "incarcerated", "supervision", "facility", "release_year",
      "firearms_prohibited",
    ],
  },
  {
    source: "criminal", table: "case", label: "Criminal cases", group: "Justice",
    person: "person", summary: ["docket", "lead_charge", "disposition"],
  },
  {
    source: "civil", table: "case", label: "Civil and family cases", group: "Justice",
    person: "person", summary: ["docket", "kind", "outcome"],
  },
  {
    source: "firearms", table: "firearm", label: "Firearms", group: "Firearms",
    person: "person", summary: ["description", "acquired", "transfer"],
  },
  {
    source: "firearms", table: "licence_to_carry", label: "Licence to carry",
    group: "Firearms", person: "person", summary: ["number", "issued", "status"],
  },
  {
    source: "firearms", table: "pics_check", label: "PICS checks", group: "Firearms",
    person: "person", summary: ["date", "result", "reason"],
  },
  {
    source: "vehicles", table: "vehicle", label: "Vehicles", group: "Vehicles",
    // The registry is keyed by VIN, so the join back to a person runs through
    // `owner` rather than the `person` column every other table carries.
    person: "owner", summary: ["model_year", "make", "model"],
  },
  {
    source: "vehicles", table: "auto_loan", label: "Auto loans",
    group: "Vehicles", person: "person", summary: ["vin", "originated", "balance"],
  },
  {
    source: "holdings", table: "licence", label: "Driver licences and IDs",
    group: "Vehicles", person: "person", summary: ["holding", "number", "status"],
  },
  {
    source: "holdings", table: "real_property", label: "Property", group: "Property and money",
    person: "person", summary: ["parcel", "recorded", "assessed_value"],
  },
  {
    source: "holdings", table: "mortgage", label: "Mortgages", group: "Property and money",
    person: "person", summary: ["lender", "originated", "balance"],
  },
  {
    source: "holdings", table: "income_stream", label: "Income",
    group: "Property and money", person: "person",
    summary: ["source", "frequency", "payday"],
  },
  {
    source: "holdings", table: "bank_account", label: "Bank accounts",
    group: "Property and money", person: "person",
    summary: ["institution", "purpose", "balance"],
  },
  {
    source: "holdings", table: "credit_card", label: "Credit cards",
    group: "Property and money", person: "person",
    summary: ["issuer", "network", "balance"],
  },
  {
    source: "holdings", table: "debit_card", label: "Debit cards",
    group: "Property and money", person: "person",
    summary: ["issuer", "network", "last_four"],
  },
  {
    source: "holdings", table: "payment_profile", label: "Payment habits",
    group: "Property and money", person: "person",
    summary: ["cash_preference", "credit_preference", "contactless"],
    formats: { cash_preference: "share", credit_preference: "share" },
  },
  {
    source: "holdings", table: "student_loan", label: "Student loans",
    group: "Property and money", person: "person",
    summary: ["servicer", "status", "balance"],
  },
  {
    source: "holdings", table: "credential", label: "Credentials",
    group: "Education, health and service", person: "person",
    summary: ["credential", "institution", "awarded"],
  },
  {
    source: "holdings", table: "prescription", label: "Prescriptions",
    group: "Education, health and service", person: "person",
    summary: ["drug", "written", "days_supply"],
  },
  {
    source: "holdings", table: "military_service", label: "Military service",
    group: "Education, health and service", person: "person",
    summary: ["branch", "entered", "discharge"],
  },
];

export interface DossierSection {
  def: SectionDef;
  table: RecordTable;
  /** Row indices in `table` belonging to this person. */
  rows: number[];
  /** The field to leave out when rendering, since the dossier states it. */
  skip: string[];
}

export interface DossierGroup {
  label: string;
  sections: DossierSection[];
  records: number;
}

export class Dossier {
  readonly person: number;
  readonly groups: DossierGroup[];
  readonly records: number;
  /** Tables this person has rows in — what the page draws a block for. */
  readonly sections: number;

  constructor(person: number, groups: DossierGroup[]) {
    this.person = person;
    this.groups = groups;
    this.records = groups.reduce((sum, group) => sum + group.records, 0);
    this.sections = groups.reduce((sum, group) => sum + group.sections.length, 0);
  }

  /** A section by table name, for the places that want one specifically. */
  section(table: string): DossierSection | null {
    for (const group of this.groups) {
      const found = group.sections.find((section) => section.def.table === table);
      if (found) return found;
    }
    return null;
  }
}

/**
 * Gather one person's records out of the loaded files.
 *
 * Sections with no rows are dropped rather than shown empty — a dossier that
 * listed "Firearms: none" nineteen times would bury the four things that are
 * actually there.
 */
export function buildDossier(
  person: number,
  identity: Identity,
  sets: Partial<Record<DossierSource, RecordSet>>,
): Dossier {
  const byGroup = new Map<string, DossierSection[]>();

  for (const def of DOSSIER_SECTIONS) {
    const set = def.source === "identity" ? identity.set : sets[def.source];
    if (!set) continue;

    let table: RecordTable;
    try {
      table = set.table(def.table);
    } catch {
      continue;
    }

    let rows: number[];
    if (def.childOf) {
      const parent = set.table(def.childOf.table);
      const slice = parent.children(def.childOf.field, person);
      rows = [];
      if (slice) {
        for (let row = slice.from; row < slice.to; row += 1) rows.push(row);
      }
    } else if (def.person) {
      rows = table.forPerson(person);
    } else {
      // Row index is the resident id — one row, and only if they exist.
      rows = identity.knows(person) && person < table.rows ? [person] : [];
    }

    if (def.carries) {
      const fields = def.carries;
      rows = rows.filter((row) => carriesAnything(table, row, fields));
    }

    if (!rows.length) continue;
    const list = byGroup.get(def.group) ?? [];
    // The dossier has already said whose record this is, so the resident id
    // comes off every row — including the child tables, which now carry one.
    list.push({ def, table, rows, skip: table.has("person") ? ["person"] : [] });
    byGroup.set(def.group, list);
  }

  const groups: DossierGroup[] = [];
  for (const [label, sections] of byGroup) {
    groups.push({
      label,
      sections,
      records: sections.reduce((sum, section) => sum + section.rows.length, 0),
    });
  }
  return new Dossier(person, groups);
}

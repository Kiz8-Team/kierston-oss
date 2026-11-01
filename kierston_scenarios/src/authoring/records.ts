/**
 * Person selection over the personal records: firearms, criminal history and
 * prescriptions.
 *
 * The records are what `kierston/init/personal_records` and
 * `kierston/init/criminal_history` wrote and `pack_records.py` packed. The
 * decoder is the viewer's, for the reason `economy/banking/accounts.ts` gives.
 * Nothing is read until a filter names a record group, and each file is decoded
 * once per process.
 *
 * Selection reads ground truth. Sealed and expunged cases, juvenile
 * adjudications and private firearm transfers all count, because the sim never
 * redacts; what a records search would show is the bench's question, not this
 * one's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeRecords, type RecordSet, type RecordTable } from "kierston-records";
import { world } from "../../../kierston/sim/src/index.ts";
import { inRange, type Range } from "./range.ts";

type OneOrMany<T> = T | readonly T[];
/** Keeps literal autocompletion while still accepting any string. */
type Open<T extends string> = T | (string & {});

export type FirearmType = "handgun" | "long_gun";
export type ChargeCategory = "person" | "property" | "drug" | "weapons" | "public_order" | "mv_other" | "other";
export type Supervision = "probation" | "state_parole" | "county_parole";
export type OffendingClass = "none" | "adolescence_limited" | "chronic_moderate" | "chronic_high";
export type Schedule = "II" | "III" | "IV" | "V";

export interface FirearmFilter {
  /** Holds at least one firearm, or none. */
  owns?: boolean;
  /** Holds at least one firearm of any listed type. */
  type?: OneOrMany<FirearmType>;
  /** How many firearms are held. */
  count?: Range;
  /** Holds a valid licence to carry. */
  carryLicence?: boolean;
  /** Under any § 6105 or federal prohibition. */
  prohibited?: boolean;
  /** Has a denied PICS check on record. */
  deniedCheck?: boolean;
}

export interface CriminalFilter {
  /** Criminal cases of any disposition. */
  cases?: Range;
  /** Cases ending in a conviction. */
  convictions?: Range;
  felonyConvicted?: boolean;
  /** Any charge in one of these categories or sections ("3802", "6105(a)(1)"). */
  charged?: OneOrMany<Open<ChargeCategory>>;
  /** A conviction in one of these categories or sections. */
  convictedOf?: OneOrMany<Open<ChargeCategory>>;
  incarcerated?: boolean;
  /** `true` for any supervision, `false` for none, or specific kinds. */
  supervision?: boolean | OneOrMany<Supervision>;
  offendingClass?: OneOrMany<OffendingClass>;
}

export interface PrescriptionFilter {
  /** Holds at least one current prescription, or none. */
  holds?: boolean;
  /** How many current prescriptions are held. */
  count?: Range;
  /** The criteria below must all hold for the same prescription. */
  drug?: OneOrMany<string>;
  drugClass?: OneOrMany<string>;
  schedule?: OneOrMany<Schedule>;
  /** Scheduled (II–V) or not. */
  controlled?: boolean;
}

export interface RecordFilters {
  firearms?: FirearmFilter;
  criminal?: CriminalFilter;
  prescriptions?: PrescriptionFilter;
}

interface Offences { categories: Set<string>; sections: Set<string> }
interface CriminalHistory { cases: number; convictions: number; felonyConvicted: boolean; charged: Offences; convictedOf: Offences }
interface Guns { count: number; types: Set<string>; carryLicence: boolean; deniedCheck: boolean }
interface Script { drug: string; drugClass: string; schedule: string | null }

const NO_HISTORY: CriminalHistory = { cases: 0, convictions: 0, felonyConvicted: false,
  charged: { categories: new Set(), sections: new Set() }, convictedOf: { categories: new Set(), sections: new Set() } };
const NO_GUNS: Guns = { count: 0, types: new Set(), carryLicence: false, deniedCheck: false };

function open(file: string): RecordSet {
  const bytes = readFileSync(join(world.SIM_DATA_DIR, file));
  // Sliced for the reason loadHoldings gives: a Buffer views a pooled ArrayBuffer.
  return decodeRecords(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}
function list<T>(value: OneOrMany<T> | undefined): readonly T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value as T];
}
function vocabulary(table: RecordTable, field: string): Set<string> {
  return new Set(table.labels(field).filter(Boolean));
}
function known(role: string, field: string, values: readonly string[] | undefined, allowed: ReadonlySet<string>): void {
  if (values === undefined) return;
  if (!values.length) throw new Error(`${role}: ${field} must not be empty`);
  const unknown = values.filter((value) => !allowed.has(value));
  if (unknown.length) {
    throw new Error(`${role}: unknown ${field} ${unknown.map((value) => JSON.stringify(value)).join(", ")}; `
      + `expected one of ${[...allowed].sort().join(", ")}`);
  }
}
function sectionMatches(section: string, wanted: string): boolean {
  return section === wanted || section.startsWith(`${wanted}(`);
}

class CriminalRecords {
  readonly history = new Map<number, CriminalHistory>();
  /** Indexed by resident id; every resident has a row. */
  readonly status: RecordTable;
  readonly categories: Set<string>;
  readonly sections: string[];
  readonly supervisions: Set<string>;
  readonly offendingClasses: Set<string>;
  constructor(set: RecordSet) {
    const cases = set.table("case"), charges = set.table("charge");
    this.status = set.table("status");
    this.categories = vocabulary(charges, "category");
    this.sections = [...vocabulary(charges, "section")];
    this.supervisions = vocabulary(this.status, "supervision");
    this.offendingClasses = vocabulary(this.status, "offending_class");
    for (let row = 0; row < cases.rows; row += 1) {
      const person = cases.code("person", row);
      let entry = this.history.get(person);
      if (!entry) {
        entry = { cases: 0, convictions: 0, felonyConvicted: false,
          charged: { categories: new Set(), sections: new Set() }, convictedOf: { categories: new Set(), sections: new Set() } };
        this.history.set(person, entry);
      }
      const convicted = cases.value("convicted", row) === true;
      entry.cases += 1;
      if (convicted) entry.convictions += 1;
      if (cases.value("felony_convicted", row) === true) entry.felonyConvicted = true;
      // A conviction names the statute it landed on; one that names none is
      // held against the lead charge rather than every count on the docket.
      const statute = convicted ? cases.value("convicted_of", row) ?? cases.value("lead_charge", row) : null;
      const span = cases.children("charges", row)!;
      for (let charge = span.from; charge < span.to; charge += 1) {
        const category = charges.value("category", charge) as string;
        const section = charges.value("section", charge) as string;
        entry.charged.categories.add(category); entry.charged.sections.add(section);
        if (statute !== null && charges.value("cite", charge) === statute) {
          entry.convictedOf.categories.add(category); entry.convictedOf.sections.add(section);
        }
      }
    }
  }
}

class FirearmRecords {
  readonly byPerson = new Map<number, Guns>();
  readonly types: Set<string>;
  constructor(set: RecordSet) {
    const guns = set.table("firearm"), carry = set.table("licence_to_carry"), checks = set.table("pics_check");
    this.types = vocabulary(guns, "type");
    const entry = (person: number) => {
      let found = this.byPerson.get(person);
      if (!found) { found = { count: 0, types: new Set(), carryLicence: false, deniedCheck: false }; this.byPerson.set(person, found); }
      return found;
    };
    for (let row = 0; row < guns.rows; row += 1) {
      const found = entry(guns.code("person", row));
      found.count += 1; found.types.add(guns.value("type", row) as string);
    }
    for (let row = 0; row < carry.rows; row += 1) {
      if (carry.value("status", row) === "valid") entry(carry.code("person", row)).carryLicence = true;
    }
    for (let row = 0; row < checks.rows; row += 1) {
      if (checks.value("result", row) === "denied") entry(checks.code("person", row)).deniedCheck = true;
    }
  }
}

class PrescriptionRecords {
  readonly byPerson = new Map<number, Script[]>();
  readonly drugs: Set<string>;
  readonly drugClasses: Set<string>;
  readonly schedules: Set<string>;
  constructor(set: RecordSet) {
    const table = set.table("prescription");
    this.drugs = vocabulary(table, "drug");
    this.drugClasses = vocabulary(table, "drug_class");
    this.schedules = vocabulary(table, "schedule");
    for (const [person, rows] of table.groupedBy("person")) {
      this.byPerson.set(person, rows.map((row) => ({
        drug: table.value("drug", row) as string,
        drugClass: table.value("drug_class", row) as string,
        schedule: table.value("schedule", row) as string | null,
      })));
    }
  }
}

/** The records a person filter can reach, loaded group by group on first use. */
export class PersonRecords {
  private static loaded?: PersonRecords;
  private criminalRecords?: CriminalRecords;
  private firearmRecords?: FirearmRecords;
  private prescriptionRecords?: PrescriptionRecords;

  static shared(): PersonRecords { return PersonRecords.loaded ??= new PersonRecords(); }

  private get criminal(): CriminalRecords { return this.criminalRecords ??= new CriminalRecords(open("criminal.bin")); }
  private get firearms(): FirearmRecords { return this.firearmRecords ??= new FirearmRecords(open("firearms.bin")); }
  private get prescriptions(): PrescriptionRecords { return this.prescriptionRecords ??= new PrescriptionRecords(open("holdings.bin")); }

  /**
   * One predicate for the record groups a filter names, or null when it names
   * none. Vocabulary and contradictions are checked here, once, so a misspelt
   * drug is an error rather than an empty candidate set.
   */
  matcher(role: string, filter: RecordFilters): ((person: number) => boolean) | null {
    const tests: ((person: number) => boolean)[] = [];
    if (filter.firearms) tests.push(this.firearmTest(role, filter.firearms));
    if (filter.criminal) tests.push(this.criminalTest(role, filter.criminal));
    if (filter.prescriptions) tests.push(this.prescriptionTest(role, filter.prescriptions));
    return tests.length ? (person) => tests.every((test) => test(person)) : null;
  }

  private firearmTest(role: string, filter: FirearmFilter): (person: number) => boolean {
    const records = this.firearms;
    const types = list(filter.type);
    known(role, "firearms.type", types, records.types);
    if (filter.owns === false && types) throw new Error(`${role}: firearms.owns false contradicts firearms.type`);
    const status = filter.prohibited === undefined ? null : this.criminal.status;
    return (person) => {
      const held = records.byPerson.get(person) ?? NO_GUNS;
      if (filter.owns !== undefined && (held.count > 0) !== filter.owns) return false;
      if (types && !types.some((type) => held.types.has(type))) return false;
      if (!inRange(held.count, filter.count)) return false;
      if (filter.carryLicence !== undefined && held.carryLicence !== filter.carryLicence) return false;
      if (filter.deniedCheck !== undefined && held.deniedCheck !== filter.deniedCheck) return false;
      return !status || ((status.value("firearms_prohibited", person) as string[]).length > 0) === filter.prohibited;
    };
  }

  private criminalTest(role: string, filter: CriminalFilter): (person: number) => boolean {
    const records = this.criminal;
    const offences = (field: string, values: OneOrMany<string> | undefined) => {
      const wanted = list(values);
      if (wanted === undefined) return undefined;
      if (!wanted.length) throw new Error(`${role}: criminal.${field} must not be empty`);
      for (const value of wanted) {
        if (!records.categories.has(value) && !records.sections.some((section) => sectionMatches(section, value))) {
          throw new Error(`${role}: unknown criminal.${field} ${JSON.stringify(value)}; expected a charge category `
            + `(${[...records.categories].sort().join(", ")}) or a charged section such as "3802"`);
        }
      }
      return wanted;
    };
    const hit = (held: Offences, wanted: readonly string[]) => wanted.some((value) => held.categories.has(value)
      || [...held.sections].some((section) => sectionMatches(section, value)));
    const charged = offences("charged", filter.charged), convictedOf = offences("convictedOf", filter.convictedOf);
    const supervision = typeof filter.supervision === "boolean" ? undefined : list(filter.supervision);
    const classes = list(filter.offendingClass);
    known(role, "criminal.supervision", supervision, records.supervisions);
    known(role, "criminal.offendingClass", classes, records.offendingClasses);
    const status = records.status;
    return (person) => {
      const history = records.history.get(person) ?? NO_HISTORY;
      if (!inRange(history.cases, filter.cases) || !inRange(history.convictions, filter.convictions)) return false;
      if (filter.felonyConvicted !== undefined && history.felonyConvicted !== filter.felonyConvicted) return false;
      if (charged && !hit(history.charged, charged)) return false;
      if (convictedOf && !hit(history.convictedOf, convictedOf)) return false;
      if (filter.incarcerated !== undefined && status.value("incarcerated", person) !== filter.incarcerated) return false;
      const supervised = status.value("supervision", person) as string | null;
      if (typeof filter.supervision === "boolean" && (supervised !== null) !== filter.supervision) return false;
      if (supervision && !supervision.includes(supervised as Supervision)) return false;
      return !classes || classes.includes(status.value("offending_class", person) as OffendingClass);
    };
  }

  private prescriptionTest(role: string, filter: PrescriptionFilter): (person: number) => boolean {
    const records = this.prescriptions;
    const drugs = list(filter.drug), classes = list(filter.drugClass), schedules = list(filter.schedule);
    known(role, "prescriptions.drug", drugs, records.drugs);
    known(role, "prescriptions.drugClass", classes, records.drugClasses);
    known(role, "prescriptions.schedule", schedules, records.schedules);
    const specific = drugs || classes || schedules || filter.controlled !== undefined;
    if (filter.holds === false && specific) throw new Error(`${role}: prescriptions.holds false contradicts a prescription criterion`);
    return (person) => {
      const held = records.byPerson.get(person) ?? [];
      if (filter.holds !== undefined && (held.length > 0) !== filter.holds) return false;
      if (!inRange(held.length, filter.count)) return false;
      return !specific || held.some((script) => (!drugs || drugs.includes(script.drug))
        && (!classes || classes.includes(script.drugClass))
        && (!schedules || schedules.includes(script.schedule as Schedule))
        && (filter.controlled === undefined || (script.schedule !== null) === filter.controlled));
    };
  }
}

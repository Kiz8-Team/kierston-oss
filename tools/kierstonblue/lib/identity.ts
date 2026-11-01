"use client";

import { RecordSet, RecordTable, dateYear } from "./records";

/**
 * Who everyone is, joined to nothing and needed by everything.
 *
 * identity.bin is the one records file every page loads. A docket row says
 * that resident 41,207 was charged under 75 Pa.C.S. § 3802(b); it is only
 * worth reading if it can also say that resident 41,207 is Denise Whitfield,
 * born 1984. So this wraps the identity table with the two things the other
 * browsers ask of it — a name and a date of birth — and leaves the other
 * twenty-three fields to the identities page itself.
 *
 * The table is indexed by resident id in the population's own numbering,
 * households first and group quarters after, which is the same numbering
 * employment.json and enrollment.json use. No join is needed: row *i* is
 * resident *i*.
 */
export class Identity {
  readonly set: RecordSet;
  readonly table: RecordTable;
  readonly documents: RecordTable;
  readonly persons: number;
  private _search: string[] | null = null;

  constructor(set: RecordSet) {
    this.set = set;
    this.table = set.table("identity");
    this.documents = set.table("document");
    this.persons = this.table.rows;
  }

  /** Whether a resident id is one this file knows about. */
  knows(person: number): boolean {
    return person >= 0 && person < this.persons;
  }

  /**
   * Someone's full name, middle name included.
   *
   * Reads three enum codes and concatenates. No object is built, because the
   * tables call this once per visible row per render and there are 156,892
   * credit cards behind some of them.
   */
  name(person: number): string {
    if (!this.knows(person)) return `Resident ${person}`;
    const table = this.table;
    const first = table.labels("first_name")[table.code("first_name", person)];
    const middle = table.labels("middle_name")[table.code("middle_name", person)];
    const surname = table.labels("surname")[table.code("surname", person)];
    return [first, middle, surname].filter(Boolean).join(" ");
  }

  /** First and last only — what a table cell has room for. */
  shortName(person: number): string {
    if (!this.knows(person)) return `Resident ${person}`;
    const table = this.table;
    const first = table.labels("first_name")[table.code("first_name", person)];
    const surname = table.labels("surname")[table.code("surname", person)];
    return [first, surname].filter(Boolean).join(" ") || `Resident ${person}`;
  }

  birthDate(person: number): string | null {
    return this.knows(person) ? (this.table.value("birth_date", person) as string) : null;
  }

  birthYear(person: number): number | null {
    return this.knows(person) ? dateYear(this.table.code("birth_date", person)) : null;
  }

  /** The documents one person holds, as row indices into the document table. */
  documentsOf(person: number): { from: number; to: number } {
    const children = this.table.children("documents", person);
    return children ? { from: children.from, to: children.to } : { from: 0, to: 0 };
  }

  /**
   * Lowercased "first middle surname" per resident, built on first use.
   *
   * The identities table searches by name over 121,060 people on every
   * keystroke. Rebuilding each name from three string-table lookups inside
   * that loop is the difference between a filter that keeps up with typing and
   * one that does not, so the strings are flattened once and kept.
   */
  get searchNames(): string[] {
    if (!this._search) {
      const out = new Array<string>(this.persons);
      for (let i = 0; i < this.persons; i += 1) out[i] = this.name(i).toLowerCase();
      this._search = out;
    }
    return this._search;
  }
}

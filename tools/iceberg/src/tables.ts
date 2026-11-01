/**
 * The record files, as tables iceberg can walk without knowing what they hold.
 *
 * pack_records.py writes the field list into the header — each field's name,
 * its kind, and the column behind it — so a table of mortgages and a table of
 * criminal charges read through the same code. That is what lets the analysis
 * in `profile/init.ts` be about forty lines: it iterates tables, iterates
 * fields, and asks each field for a distribution or a tally depending only on
 * its declared kind. A field added to a generator appears in the next profile
 * with nobody editing iceberg, which is the only way a tool like this survives
 * contact with a simulation still being written.
 */

import { columns, strings, type Envelope, type TypedArray } from "./format.ts";

/** The nulls each kind reserves, mirroring pack_records.py. */
export const NULL_INT = -2147483648;
export const NULL_U8 = 255;
export const NULL_U16 = 65535;
export const NULL_ID = 4294967295;

export type FieldKind =
  | "id" | "int" | "u8" | "u16" | "year" | "date" | "bool" | "rate" | "money"
  | "enum" | "str" | "list";

export interface Field {
  name: string;
  kind: FieldKind;
  column: TypedArray;
  /** Interned values for enum, str and list fields; index 0 is empty. */
  labels: string[] | null;
  /** Where each row's values start, for list fields. */
  offsets: Uint32Array | null;
}

export class Table {
  readonly name: string;
  readonly rows: number;
  readonly fields: Field[];
  readonly children: { name: string; table: string; offsets: string }[];
  private readonly byName: Map<string, Field>;

  constructor(spec: any, arrays: Record<string, TypedArray>) {
    this.name = spec.name;
    this.rows = spec.rows;
    this.children = spec.children ?? [];
    this.fields = spec.fields.map((field: any): Field => ({
      name: field.name,
      kind: field.kind,
      column: arrays[field.column],
      labels: field.kind === "enum" || field.kind === "str" || field.kind === "list"
        ? strings(arrays, field.column)
        : null,
      offsets: field.offsets ? (arrays[field.offsets] as Uint32Array) : null,
    }));
    this.byName = new Map(this.fields.map((field) => [field.name, field]));
  }

  field(name: string): Field | null { return this.byName.get(name) ?? null; }
  has(name: string): boolean { return this.byName.has(name); }

  /** A field's value, or null where the kind's sentinel says it was not set. */
  value(field: Field, row: number): string | number | boolean | string[] | null {
    const raw = field.column[row];
    switch (field.kind) {
      case "list": {
        const out: string[] = [];
        for (let i = field.offsets![row]; i < field.offsets![row + 1]; i += 1) {
          out.push(field.labels![field.column[i]]);
        }
        return out;
      }
      case "enum": case "str": return field.labels![raw] || null;
      case "date": return raw || null;
      case "year": return raw || null;
      case "bool": return raw === 2 ? null : raw === 1;
      case "u8": return raw === NULL_U8 ? null : raw;
      case "u16": return raw === NULL_U16 ? null : raw;
      // Both are float columns whose null is NaN. `money` is f64 dollars with
      // cents, and it has to be listed: a kind that falls through to `default`
      // comes back as the raw NaN, which reads as a value and poisons every
      // mean it lands in.
      case "rate": case "money": return Number.isNaN(raw) ? null : raw;
      case "int": return raw === NULL_INT ? null : raw;
      case "id": return raw === NULL_ID ? null : raw;
      default: return raw;
    }
  }

  /** A field as a number, with nulls as null — what a distribution wants. */
  number(field: Field, row: number): number | null {
    const value = this.value(field, row);
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return null;
  }

  /** A field as a label, with nulls as null — what a tally wants. */
  label(field: Field, row: number): string | null {
    const value = this.value(field, row);
    if (value === null) return null;
    if (Array.isArray(value)) return value.length ? value.join(" + ") : null;
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
  }
}

export class RecordSet {
  readonly dataset: string;
  readonly meta: any;
  readonly tables: Table[];
  private readonly arrays: Record<string, TypedArray>;
  private readonly byName: Map<string, Table>;

  constructor(env: Envelope) {
    this.meta = env.meta;
    this.dataset = env.meta.dataset;
    this.arrays = columns(env);
    this.tables = env.meta.tables.map((spec: any) => new Table(spec, this.arrays));
    this.byName = new Map(this.tables.map((table) => [table.name, table]));
  }

  table(name: string): Table | null { return this.byName.get(name) ?? null; }
  array(name: string): TypedArray { return this.arrays[name]; }
}

/** yyyymmdd, as the generators write dates. */
export const dateYear = (ordinal: number) => (ordinal ? Math.floor(ordinal / 10000) : null);
export const dateMonth = (ordinal: number) => (ordinal ? Math.floor(ordinal / 100) % 100 : null);
export const dateDay = (ordinal: number) => (ordinal ? ordinal % 100 : null);

/** A date ordinal as days since epoch, for arithmetic between two of them. */
export function ordinalToDays(ordinal: number): number | null {
  const year = dateYear(ordinal);
  if (year === null) return null;
  return Math.floor(Date.UTC(year, dateMonth(ordinal)! - 1, dateDay(ordinal)!) / 86_400_000);
}

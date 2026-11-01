/**
 * Reader for the packed personal records — identity, dockets and holdings.
 *
 * The container is the one population.bin uses, under its own tag: magic, a
 * JSON header, then the columns as raw typed arrays. What is different is that
 * this reader has no schema. pack_records.py writes the field list into the
 * header — each field's name, its kind, and the column behind it — so a table
 * of mortgages and a table of criminal charges decode through the same code
 * and nothing here knows what either one is.
 *
 * That matters because there are forty-odd record types across six files. A
 * reader that named them would be a thousand lines of near-identical accessors
 * and would need editing every time a generator grew a field. This way, adding
 * `escrow_includes_insurance` to a mortgage is one line in the packer's schema
 * and it appears in the viewer.
 *
 * Nothing decodes per record. The typed arrays are views onto the downloaded
 * buffer, and `row()` materialises an object only when a detail panel asks for
 * one — so a table can sort 156,892 credit cards by balance without ever
 * building a credit card.
 */

const MAGIC = "KREC";

const CONSTRUCTOR = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i32: Int32Array, f32: Float32Array, f64: Float64Array,
} as const;

type Kind = keyof typeof CONSTRUCTOR;
type Column = InstanceType<(typeof CONSTRUCTOR)[Kind]>;

const align8 = (value: number) => (value + 7) & ~7;

/** The null each kind reserves, mirroring pack_records.py. */
export const NULL_INT = -2147483648;
const NULL_U8 = 255;
const NULL_U16 = 65535;
const NULL_ID = 4294967295;

export type FieldKind =
  | "id" | "int" | "u8" | "u16" | "year" | "date" | "bool" | "rate" | "money"
  | "enum" | "str" | "list";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  /** The array holding this field's values. */
  column: string;
  /** For a list, the array holding where each record's values start. */
  offsets?: string;
}

export interface ChildSpec {
  /** The field name on the parent — "charges", "documents", "suspensions". */
  name: string;
  /** The table those rows live in. */
  table: string;
  /** The parent's offset array into it. */
  offsets: string;
}

export interface TableSpec {
  name: string;
  rows: number;
  fields: FieldSpec[];
  children: ChildSpec[];
}

export interface RecordMeta {
  dataset: string;
  source: string;
  builtAt: string;
  seed: number;
  referenceYear: number;
  today?: string;
  persons?: number;
  /** What the generator took from PUMS rather than invented. */
  surveyed: string[];
  modelled: string[];
  counts: Record<string, number>;
  tables: TableSpec[];
  arrays: { name: string; kind: Kind; length: number; byteOffset: number }[];
}

/** A field's value, once it has been read back out of its column. */
export type Value = string | number | boolean | string[] | null;

function readStrings(arrays: Record<string, Column>, name: string): string[] {
  const offsets = arrays[`${name}_offset`] as Uint32Array | undefined;
  const bytes = arrays[`${name}_bytes`] as Uint8Array | undefined;
  if (!offsets || !bytes) return [""];
  const decoder = new TextDecoder();
  // Index 0 is the empty string, which every interned column uses for null.
  const out = [""];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

/** yyyymmdd as the generator wrote it — see to_ordinal in pack_records.py. */
export function formatDate(ordinal: number): string | null {
  if (!ordinal) return null;
  const year = Math.floor(ordinal / 10000);
  const month = Math.floor(ordinal / 100) % 100;
  const day = ordinal % 100;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The year out of a date ordinal, which is the axis most charts want. */
export function dateYear(ordinal: number): number | null {
  return ordinal ? Math.floor(ordinal / 10000) : null;
}

interface Field {
  spec: FieldSpec;
  column: Column;
  /** The interned values, for enum, str and list fields. */
  strings: string[] | null;
  /** The CSR offsets, for list fields. */
  offsets: Uint32Array | null;
}

export class RecordTable {
  readonly name: string;
  readonly rows: number;
  readonly spec: TableSpec;
  private readonly fields: Map<string, Field>;
  private readonly set: RecordSet;
  private readonly groups = new Map<string, Map<number, number[]>>();

  constructor(set: RecordSet, spec: TableSpec, arrays: Record<string, Column>) {
    this.set = set;
    this.spec = spec;
    this.name = spec.name;
    this.rows = spec.rows;
    this.fields = new Map();
    for (const field of spec.fields) {
      const column = arrays[field.column];
      if (!column) throw new Error(`${spec.name}.${field.name}: no column ${field.column}`);
      this.fields.set(field.name, {
        spec: field,
        column,
        strings: field.kind === "enum" || field.kind === "str" || field.kind === "list"
          ? readStrings(arrays, field.column)
          : null,
        offsets: field.offsets ? (arrays[field.offsets] as Uint32Array) : null,
      });
    }
  }

  has(name: string): boolean { return this.fields.has(name); }

  get fieldNames(): string[] { return this.spec.fields.map((field) => field.name); }

  kindOf(name: string): FieldKind | null {
    return this.fields.get(name)?.spec.kind ?? null;
  }

  private field(name: string): Field {
    const field = this.fields.get(name);
    if (!field) throw new Error(`${this.name} has no field ${name}`);
    return field;
  }

  /**
   * The raw column value, without turning it into anything.
   *
   * This is what filtering and sorting run on: comparing two enum codes is an
   * integer compare, and a date ordinal sorts in calendar order as it stands.
   * Nulls come back as their sentinel, so a caller that cares has to say so.
   */
  code(name: string, index: number): number {
    return this.field(name).column[index];
  }

  /** The whole column, for a caller building its own index over it. */
  column(name: string): Column { return this.field(name).column; }

  /** The interned values behind an enum, str or list field, index 0 empty. */
  labels(name: string): string[] { return this.field(name).strings ?? [""]; }

  /**
   * The distinct values of an enum field, in the order they were interned,
   * with how many rows carry each. What the facet dropdowns are built from.
   */
  distinct(name: string): { value: string; code: number; count: number }[] {
    const field = this.field(name);
    const strings = field.strings ?? [""];
    const counts = new Uint32Array(strings.length);
    for (let i = 0; i < this.rows; i += 1) counts[field.column[i]] += 1;
    const out: { value: string; code: number; count: number }[] = [];
    for (let code = 1; code < strings.length; code += 1) {
      if (counts[code]) out.push({ value: strings[code], code, count: counts[code] });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /** One field of one row, as the value the generator wrote. */
  value(name: string, index: number): Value {
    const field = this.field(name);
    const raw = field.column[index];
    switch (field.spec.kind) {
      case "list": {
        const offsets = field.offsets!;
        const strings = field.strings!;
        const out: string[] = [];
        for (let i = offsets[index]; i < offsets[index + 1]; i += 1) {
          out.push(strings[field.column[i]]);
        }
        return out;
      }
      case "enum":
      case "str":
        return field.strings![raw] || null;
      case "date":
        return formatDate(raw);
      case "bool":
        return raw === 2 ? null : raw === 1;
      case "year":
        return raw === 0 ? null : raw;
      case "u8":
        return raw === NULL_U8 ? null : raw;
      case "u16":
        return raw === NULL_U16 ? null : raw;
      case "rate":
      case "money":
        // Both are f-columns whose null is NaN. `money` is f64 dollars with
        // cents; see the kind table in pack_records.py.
        return Number.isNaN(raw) ? null : raw;
      case "int":
        return raw === NULL_INT ? null : raw;
      case "id":
        // A vehicle owned by an operator has no household, and its owner is an
        // id outside the population. The null is the absent household; the
        // unresolvable owner is a real id that simply is not a resident.
        return raw === NULL_ID ? null : raw;
      default:
        return raw;
    }
  }

  /** A field as text, for searching and for cells that just print it. */
  text(name: string, index: number): string | null {
    const value = this.value(name, index);
    if (value === null) return null;
    if (Array.isArray(value)) return value.length ? value.join(", ") : null;
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
  }

  /** A field as a number, or null where it was not asked or not answered. */
  number(name: string, index: number): number | null {
    const value = this.value(name, index);
    return typeof value === "number" ? value : null;
  }

  /** Every field of one row — what a detail panel renders. */
  row(index: number): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const field of this.spec.fields) out[field.name] = this.value(field.name, index);
    return out;
  }

  /** The child rows hanging off one parent — a case's charges, say. */
  children(name: string, index: number): { table: RecordTable; from: number; to: number } | null {
    const spec = this.spec.children.find((child) => child.name === name);
    if (!spec) return null;
    const offsets = this.set.array(spec.offsets) as Uint32Array;
    return {
      table: this.set.table(spec.table),
      from: offsets[index],
      to: offsets[index + 1],
    };
  }

  get childNames(): string[] { return this.spec.children.map((child) => child.name); }

  /**
   * Row indices grouped by the value of an id field, built on first use.
   *
   * Every holding table carries the resident it belongs to, and the detail
   * panels want the rest of that person's records — their other guns, the
   * loan against the car they are looking at. Scanning 156,892 rows per click
   * would be visible, so the index is paid for once.
   */
  groupedBy(name: string): Map<number, number[]> {
    const cached = this.groups.get(name);
    if (cached) return cached;
    const column = this.field(name).column;
    const map = new Map<number, number[]>();
    for (let i = 0; i < this.rows; i += 1) {
      const key = column[i];
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    }
    this.groups.set(name, map);
    return map;
  }

  /** The rows belonging to one resident, or none. */
  forPerson(person: number): number[] {
    return this.has("person") ? this.groupedBy("person").get(person) ?? [] : [];
  }
}

export class RecordSet {
  readonly meta: RecordMeta;
  readonly dataset: string;
  private readonly arrays: Record<string, Column>;
  private readonly tables: Map<string, RecordTable>;

  constructor(meta: RecordMeta, arrays: Record<string, Column>) {
    this.meta = meta;
    this.dataset = meta.dataset;
    this.arrays = arrays;
    this.tables = new Map();
    for (const spec of meta.tables) {
      this.tables.set(spec.name, new RecordTable(this, spec, arrays));
    }
  }

  array(name: string): Column { return this.arrays[name]; }

  table(name: string): RecordTable {
    const table = this.tables.get(name);
    if (!table) throw new Error(`${this.dataset} has no table ${name}`);
    return table;
  }

  get tableNames(): string[] { return [...this.tables.keys()]; }
}

export function decodeRecords(buffer: ArrayBuffer): RecordSet {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error(
      "not a records binary; run kierston/init/personal_records/pack_records.py");
  }
  const headerLength = new DataView(buffer).getUint32(4, true);
  const meta: RecordMeta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const dataStart = align8(8 + headerLength);

  const arrays: Record<string, Column> = {};
  for (const spec of meta.arrays) {
    arrays[spec.name] = new CONSTRUCTOR[spec.kind](
      buffer, dataStart + spec.byteOffset, spec.length);
  }
  return new RecordSet(meta, arrays);
}

export async function loadRecords(url: string): Promise<RecordSet> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return decodeRecords(await response.arrayBuffer());
}

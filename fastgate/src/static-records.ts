import { open, stat, type FileHandle } from "node:fs/promises";

const align8 = (value: number): number => (value + 7) & ~7;
const NULL_INT = -2147483648;
const NULL_U8 = 255;
const NULL_U16 = 65535;
const NULL_ID = 4294967295;

type ArrayKind = "u8" | "u16" | "u32" | "i32" | "f32" | "f64";
type NumericArray = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
export type FieldKind = "id" | "int" | "u8" | "u16" | "year" | "date" | "bool"
  | "rate" | "money" | "enum" | "str" | "list";
const ARRAY_KINDS = new Set<ArrayKind>(["u8", "u16", "u32", "i32", "f32", "f64"]);
const FIELD_KINDS = new Set<FieldKind>([
  "id", "int", "u8", "u16", "year", "date", "bool", "rate", "money", "enum", "str", "list",
]);

interface ArraySpec {
  name: string;
  kind: ArrayKind;
  length: number;
  byteOffset: number;
}

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  column: string;
  offsets?: string;
}

export interface ChildSpec {
  name: string;
  table: string;
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
  counts: Record<string, number>;
  tables: TableSpec[];
  arrays: ArraySpec[];
  [key: string]: unknown;
}

export interface StaticSectionSpec {
  name: string;
  magic: string;
  source: string;
  byteOffset: number;
  byteLength: number;
  rows: Record<string, number> | null;
}

export interface StaticContainerMeta {
  magic: "KSIM";
  version: number;
  digest: string;
  byteLength: number;
  sections: StaticSectionSpec[];
  [key: string]: unknown;
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) throw new Error("unexpected end of static container");
    read += result.bytesRead;
  }
  return buffer;
}

export class StaticContainerReader {
  readonly path: string;
  readonly meta: StaticContainerMeta;
  private readonly dataStart: number;
  private readonly handle: FileHandle;
  private constructor(path: string, meta: StaticContainerMeta, dataStart: number, handle: FileHandle) {
    this.path = path;
    this.meta = meta;
    this.dataStart = dataStart;
    this.handle = handle;
  }

  static async open(path: string): Promise<StaticContainerReader> {
    const handle = await open(path, "r");
    try {
      const size = (await stat(path)).size;
      const prefix = await readExactly(handle, 8, 0);
      if (prefix.toString("utf8", 0, 4) !== "KSIM") throw new Error(`${path} is not a KSIM file`);
      const headerLength = prefix.readUInt32LE(4);
      if (headerLength === 0 || headerLength > size - 8) throw new Error("invalid KSIM header length");
      const meta = JSON.parse(
        (await readExactly(handle, headerLength, 8)).toString("utf8"),
      ) as StaticContainerMeta;
      if (meta.magic !== "KSIM" || !Number.isInteger(meta.version) || !Array.isArray(meta.sections)) {
        throw new Error("invalid KSIM header");
      }
      const dataStart = align8(8 + headerLength);
      for (const section of meta.sections) {
        if (!section.name || !Number.isSafeInteger(section.byteOffset)
          || !Number.isSafeInteger(section.byteLength) || section.byteOffset < 0
          || section.byteLength < 8 || dataStart + section.byteOffset + section.byteLength > size) {
          throw new Error(`invalid KSIM section ${section.name || "<unnamed>"}`);
        }
      }
      return new StaticContainerReader(path, meta, dataStart, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  recordSections(): StaticSectionSpec[] {
    return this.meta.sections.filter((section) => section.magic === "KREC");
  }

  async section(section: StaticSectionSpec): Promise<Buffer> {
    const buffer = await readExactly(
      this.handle, section.byteLength, this.dataStart + section.byteOffset,
    );
    if (buffer.toString("utf8", 0, 4) !== section.magic) {
      throw new Error(`${section.name} section claims ${section.magic} but contains ${buffer.toString("utf8", 0, 4)}`);
    }
    return buffer;
  }

  async recordMeta(section: StaticSectionSpec): Promise<RecordMeta> {
    if (section.magic !== "KREC") throw new Error(`${section.name} is not a KREC section`);
    const position = this.dataStart + section.byteOffset;
    const prefix = await readExactly(this.handle, 8, position);
    const headerLength = prefix.readUInt32LE(4);
    if (prefix.toString("utf8", 0, 4) !== "KREC" || headerLength === 0
      || headerLength > section.byteLength - 8) {
      throw new Error(`${section.name} has an invalid KREC header`);
    }
    return JSON.parse(
      (await readExactly(this.handle, headerLength, position + 8)).toString("utf8"),
    ) as RecordMeta;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

function width(kind: ArrayKind): number {
  return kind === "u8" ? 1 : kind === "u16" ? 2 : kind === "f64" ? 8 : 4;
}

function numericArray(kind: ArrayKind, buffer: Buffer, offset: number, length: number): NumericArray {
  const byteOffset = buffer.byteOffset + offset;
  if (kind === "u8") return new Uint8Array(buffer.buffer, byteOffset, length);
  if (kind === "u16") return new Uint16Array(buffer.buffer, byteOffset, length);
  if (kind === "u32") return new Uint32Array(buffer.buffer, byteOffset, length);
  if (kind === "i32") return new Int32Array(buffer.buffer, byteOffset, length);
  if (kind === "f32") return new Float32Array(buffer.buffer, byteOffset, length);
  return new Float64Array(buffer.buffer, byteOffset, length);
}

function strings(arrays: Map<string, NumericArray>, name: string): string[] {
  const offsets = arrays.get(`${name}_offset`);
  const bytes = arrays.get(`${name}_bytes`);
  if (!(offsets instanceof Uint32Array) || !(bytes instanceof Uint8Array)) return [""];
  const decoder = new TextDecoder();
  const out = [""];
  for (let index = 0; index + 1 < offsets.length; index += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[index]!, offsets[index + 1]!)));
  }
  return out;
}

function date(raw: number): string | null {
  if (raw === 0) return null;
  const year = Math.floor(raw / 10000);
  const month = Math.floor(raw / 100) % 100;
  const day = raw % 100;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface ParentReference {
  recordType: string;
  recordIndex: number;
  field: string;
}

export interface DecodedStaticRecord {
  dataset: string;
  recordType: string;
  recordIndex: number;
  personId: number | null;
  parent: ParentReference | null;
  record: Record<string, unknown>;
}

export class StaticRecordSet {
  readonly meta: RecordMeta;
  private readonly arrays: Map<string, NumericArray>;
  private readonly labels = new Map<string, string[]>();
  private readonly parents = new Map<string, (ParentReference | null)[]>();

  private constructor(meta: RecordMeta, arrays: Map<string, NumericArray>) {
    this.meta = meta;
    this.arrays = arrays;
    const tableNames = new Set<string>();
    for (const table of meta.tables) {
      if (!table.name || tableNames.has(table.name) || !Number.isSafeInteger(table.rows) || table.rows < 0
        || !Array.isArray(table.fields) || !Array.isArray(table.children)) {
        throw new Error(`invalid ${meta.dataset} table ${table.name || "<unnamed>"}`);
      }
      tableNames.add(table.name);
      for (const field of table.fields) {
        const column = arrays.get(field.column);
        if (!field.name || !FIELD_KINDS.has(field.kind) || !column) {
          throw new Error(`invalid ${meta.dataset}.${table.name} field ${field.name || "<unnamed>"}`);
        }
        if (field.kind === "list") {
          const offsets = field.offsets ? arrays.get(field.offsets) : null;
          if (!(offsets instanceof Uint32Array) || offsets.length !== table.rows + 1
            || offsets[offsets.length - 1]! > column.length) {
            throw new Error(`${meta.dataset}.${table.name}.${field.name} has invalid list offsets`);
          }
        } else if (column.length !== table.rows) {
          throw new Error(`${meta.dataset}.${table.name}.${field.name} has ${column.length} rows; expected ${table.rows}`);
        }
      }
      for (const child of table.children ?? []) {
        const offsets = arrays.get(child.offsets);
        if (!(offsets instanceof Uint32Array) || offsets.length !== table.rows + 1) {
          throw new Error(`${meta.dataset}.${table.name}.${child.name} has invalid child offsets`);
        }
        const childTable = meta.tables.find((candidate) => candidate.name === child.table);
        if (!childTable) throw new Error(`${meta.dataset}.${table.name} names unknown child ${child.table}`);
        const references = this.parents.get(child.table)
          ?? Array<ParentReference | null>(childTable.rows).fill(null);
        for (let parent = 0; parent < table.rows; parent += 1) {
          for (let row = offsets[parent]!; row < offsets[parent + 1]!; row += 1) {
            if (row >= references.length) throw new Error(`${meta.dataset}.${child.table} child offset is outside table`);
            references[row] = { recordType: table.name, recordIndex: parent, field: child.name };
          }
        }
        this.parents.set(child.table, references);
      }
    }
  }

  static decode(buffer: Buffer): StaticRecordSet {
    if (buffer.toString("utf8", 0, 4) !== "KREC") throw new Error("section is not a KREC file");
    const headerLength = buffer.readUInt32LE(4);
    if (headerLength === 0 || 8 + headerLength > buffer.length) throw new Error("invalid KREC header length");
    const meta = JSON.parse(buffer.toString("utf8", 8, 8 + headerLength)) as RecordMeta;
    if (!meta.dataset || !Array.isArray(meta.tables) || !Array.isArray(meta.arrays)) {
      throw new Error("invalid KREC header");
    }
    const dataStart = align8(8 + headerLength);
    const arrays = new Map<string, NumericArray>();
    for (const spec of meta.arrays) {
      if (arrays.has(spec.name) || !ARRAY_KINDS.has(spec.kind)
        || !Number.isSafeInteger(spec.length) || !Number.isSafeInteger(spec.byteOffset)
        || spec.length < 0 || spec.byteOffset < 0
        || dataStart + spec.byteOffset + spec.length * width(spec.kind) > buffer.length) {
        throw new Error(`invalid KREC array ${spec.name}`);
      }
      arrays.set(spec.name, numericArray(spec.kind, buffer, dataStart + spec.byteOffset, spec.length));
    }
    return new StaticRecordSet(meta, arrays);
  }

  get recordCount(): number {
    return this.meta.tables.reduce((total, table) => total + table.rows, 0);
  }

  private value(field: FieldSpec, row: number): unknown {
    const column = this.arrays.get(field.column);
    if (!column) throw new Error(`${this.meta.dataset}.${field.name} has no column ${field.column}`);
    if (field.kind === "list") {
      const offsets = field.offsets ? this.arrays.get(field.offsets) : null;
      if (!(offsets instanceof Uint32Array)) throw new Error(`${field.name} has no list offsets`);
      let labels = this.labels.get(field.column);
      if (!labels) {
        labels = strings(this.arrays, field.column);
        this.labels.set(field.column, labels);
      }
      const out: string[] = [];
      for (let index = offsets[row]!; index < offsets[row + 1]!; index += 1) {
        const label = labels[column[index]!] ?? "";
        if (label) out.push(label);
      }
      return out;
    }
    const raw = column[row]!;
    if (field.kind === "enum" || field.kind === "str") {
      let labels = this.labels.get(field.column);
      if (!labels) {
        labels = strings(this.arrays, field.column);
        this.labels.set(field.column, labels);
      }
      return labels[raw] || null;
    }
    if (field.kind === "date") return date(raw);
    if (field.kind === "bool") return raw === 2 ? null : raw === 1;
    if (field.kind === "year") return raw === 0 ? null : raw;
    if (field.kind === "u8") return raw === NULL_U8 ? null : raw;
    if (field.kind === "u16") return raw === NULL_U16 ? null : raw;
    if (field.kind === "int") return raw === NULL_INT ? null : raw;
    if (field.kind === "id") return raw === NULL_ID ? null : raw;
    return Number.isNaN(raw) ? null : raw;
  }

  *records(): Generator<DecodedStaticRecord> {
    for (const table of this.meta.tables) {
      const personField = table.fields.find((field) => field.name === "person");
      const indexedByPerson = (this.meta.dataset === "identity" && table.name === "identity")
        || (this.meta.dataset === "criminal" && table.name === "status");
      const parents = this.parents.get(table.name);
      for (let row = 0; row < table.rows; row += 1) {
        const record: Record<string, unknown> = {};
        for (const field of table.fields) record[field.name] = this.value(field, row);
        const vehicleOwner = this.meta.dataset === "vehicles" && table.name === "vehicle"
          && record.owner_type === "person" ? record.owner : null;
        const person = personField ? record.person : indexedByPerson ? row : vehicleOwner;
        yield {
          dataset: this.meta.dataset,
          recordType: table.name,
          recordIndex: row,
          personId: typeof person === "number" ? person : null,
          parent: parents?.[row] ?? null,
          record,
        };
      }
    }
  }
}

import { open, stat, type FileHandle } from "node:fs/promises";

export type TypeName = "u8" | "u32" | "i32" | "f32";

export interface ColumnSpec {
  name: string;
  type: TypeName;
  count: number;
  byteOffset: number;
  byteLength: number;
}

export interface KdayMeta {
  magic: "KDAY";
  version: number;
  date: string;
  counts: Record<string, number | undefined>;
  enums: Record<string, string[] | undefined>;
  strings: string[];
  columns: ColumnSpec[];
}

export type NumericColumn = Uint8Array | Uint32Array | Int32Array | Float32Array;

const WIDTH: Record<TypeName, number> = { u8: 1, u32: 4, i32: 4, f32: 4 };
const align8 = (value: number): number => (value + 7) & ~7;

export class KdayReader {
  readonly path: string;
  readonly meta: KdayMeta;
  private readonly dataStart: number;
  private readonly handle: FileHandle;
  private readonly byName: Map<string, ColumnSpec>;
  private constructor(
    path: string, meta: KdayMeta, dataStart: number,
    handle: FileHandle, byName: Map<string, ColumnSpec>,
  ) {
    this.path = path;
    this.meta = meta;
    this.dataStart = dataStart;
    this.handle = handle;
    this.byName = byName;
  }

  static async open(path: string): Promise<KdayReader> {
    const handle = await open(path, "r");
    try {
      const file = await stat(path);
      const prefix = Buffer.alloc(8);
      await handle.read(prefix, 0, prefix.length, 0);
      if (prefix.toString("utf8", 0, 4) !== "KDAY") throw new Error(`${path} is not a KDAY file`);
      const headerLength = prefix.readUInt32LE(4);
      if (headerLength === 0 || headerLength > file.size - 8) throw new Error("invalid KDAY header length");
      const header = Buffer.alloc(headerLength);
      await handle.read(header, 0, header.length, 8);
      const meta = JSON.parse(header.toString("utf8")) as KdayMeta;
      if (meta.magic !== "KDAY" || !Number.isInteger(meta.version)) throw new Error("invalid KDAY header");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error("invalid KDAY date");
      if (!Array.isArray(meta.columns) || !Array.isArray(meta.strings)) throw new Error("invalid KDAY catalog");

      const dataStart = align8(8 + headerLength);
      const byName = new Map<string, ColumnSpec>();
      for (const column of meta.columns) {
        if (!(column.type in WIDTH) || column.count < 0 || column.byteOffset < 0) {
          throw new Error(`invalid KDAY column ${column.name}`);
        }
        const expected = column.count * WIDTH[column.type];
        if (column.byteLength !== expected || dataStart + column.byteOffset + expected > file.size) {
          throw new Error(`KDAY column ${column.name} is outside the file`);
        }
        if (byName.has(column.name)) throw new Error(`duplicate KDAY column ${column.name}`);
        byName.set(column.name, column);
      }
      return new KdayReader(path, meta, dataStart, handle, byName);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  spec(name: string): ColumnSpec {
    const column = this.byName.get(name);
    if (!column) throw new Error(`KDAY is missing ${name}`);
    return column;
  }

  async column(name: string): Promise<NumericColumn> {
    const spec = this.spec(name);
    const buffer = Buffer.allocUnsafe(spec.byteLength);
    if (buffer.length > 0) {
      const result = await this.handle.read(buffer, 0, buffer.length, this.dataStart + spec.byteOffset);
      if (result.bytesRead !== buffer.length) throw new Error(`short read of KDAY column ${name}`);
    }
    if (spec.type === "u8") return new Uint8Array(buffer.buffer, buffer.byteOffset, spec.count);
    if (spec.type === "u32") return new Uint32Array(buffer.buffer, buffer.byteOffset, spec.count);
    if (spec.type === "i32") return new Int32Array(buffer.buffer, buffer.byteOffset, spec.count);
    return new Float32Array(buffer.buffer, buffer.byteOffset, spec.count);
  }

  string(id: number): string | null {
    return id === 0xffffffff ? null : (this.meta.strings[id] ?? null);
  }

  enum(group: string, id: number): string | null {
    if (id === 0xff) return null;
    return this.meta.enums[group]?.[id] ?? null;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

/**
 * Read one KDAY file, the sim's self-describing day binary.
 *
 * Adapted from `packages/provider-rows/src/kday.ts` rather than imported from it: that
 * is a separate package with its own release cadence, and the ten lines of
 * envelope parsing are not worth a cross-package dependency. The envelope is
 * four magic bytes, a little-endian u32 JSON-header length, then 8-aligned
 * typed-array columns at the offsets the header names.
 *
 * This reader adds a column cache. A generator asks for the columns it needs
 * by name and several generators run against the same open day, so each
 * column is read from disk once and shared.
 */

import { open, stat, type FileHandle } from "node:fs/promises";
import { applyPatch, fileDigest, readKdif, reducedHeader, type BytePatch } from "./kdif.ts";

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
  /** Present on a scenario day (a base read with its `.kdiff`); see `scenario.ts`. */
  scenario?: ScenarioHeader;
}

/** What a scenario day says about itself: the staged event, the cast, the crowds. */
export interface ScenarioHeader {
  format: "KIERSTON_SCENARIO";
  version: number;
  name: string;
  seed: number;
  /** Role -> resident id for every single-person role. */
  actors: Record<string, number>;
  /** Role -> place id (null for a kerb point) for every place role. */
  places: Record<string, string | null>;
  /** Role -> surviving member ids for every group, drops already removed. */
  groups: Record<string, number[]>;
  /** Role -> VIN for every vehicle role bound by `selectVehicle`. */
  vehicles?: Record<string, string>;
  /** Role -> the branch a seeded `pick` took. */
  choices?: Record<string, string>;
  events: ScenarioEvent[];
  dropped?: { person: number; reason: string }[];
  deaths?: { person: number; minute: number }[];
  /** Handsets that stayed put while their owner moved on. */
  handsetsLeft?: { person: number; from: number; at: { lat: number; lon: number }; outdoors: boolean }[];
}

export interface ScenarioEvent {
  id: string;
  kind: string;
  lat: number;
  lon: number;
  place: string | null;
  radiusMetres: number;
  /** Minutes after midnight. */
  start: number;
  end: number;
  note?: string;
}

export type NumericColumn = Uint8Array | Uint32Array | Int32Array | Float32Array;

/** No value, in a u32 string-reference column. */
export const NONE = 0xffffffff;
/** The same absence in a byte column. */
export const NONE_U8 = 0xff;

const WIDTH: Record<TypeName, number> = { u8: 1, u32: 4, i32: 4, f32: 4 };
const align8 = (value: number): number => (value + 7) & ~7;

export class KdayReader {
  private readonly cache = new Map<string, Promise<NumericColumn>>();

  private constructor(
    readonly path: string,
    readonly meta: KdayMeta,
    private readonly dataStart: number,
    private readonly handle: FileHandle,
    private readonly byName: Map<string, ColumnSpec>,
    private readonly patches = new Map<string, { base: ColumnSpec; patch: BytePatch }>(),
    /** The `.kdiff` applied over `path`, when this is a scenario day. */
    readonly delta?: string,
  ) {}

  /**
   * Open a day. With `delta`, the day is the base with that `.kdiff` applied in
   * memory: the header and every patched column are rebuilt from the base and
   * the patch, and nothing is written to disk.
   */
  static async open(path: string, options: { delta?: string } = {}): Promise<KdayReader> {
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
      const rawHeader = header.toString("utf8");
      const base = JSON.parse(rawHeader) as KdayMeta;
      if (base.magic !== "KDAY" || !Number.isInteger(base.version)) throw new Error("invalid KDAY header");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(base.date)) throw new Error("invalid KDAY date");
      if (!Array.isArray(base.columns) || !Array.isArray(base.strings)) throw new Error("invalid KDAY catalog");

      const dataStart = align8(8 + headerLength);
      const byName = new Map<string, ColumnSpec>();
      for (const column of base.columns) {
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
      if (!options.delta) return new KdayReader(path, base, dataStart, handle, byName);

      const manifest = await readKdif(options.delta);
      if (manifest.date !== base.date || (manifest.baseVersion ?? 11) !== base.version) {
        throw new Error(`${options.delta} was written against a ${manifest.date} v${manifest.baseVersion ?? 11} day, not ${path}`);
      }
      if ((await fileDigest(path)) !== manifest.baseHash) throw new Error(`${options.delta} does not apply to ${path}: base hash mismatch`);
      let meta = base;
      if (manifest.metadata) {
        const patched = JSON.parse(applyPatch(reducedHeader(rawHeader), manifest.metadata).toString("utf8")) as KdayMeta;
        if (patched.magic !== "KDAY" || patched.version !== base.version || patched.date !== base.date
          || !Array.isArray(patched.strings) || base.strings.some((value, i) => patched.strings[i] !== value)) {
          throw new Error(`${options.delta}: invalid patched KDAY header`);
        }
        meta = { ...patched, columns: base.columns };
      }
      // A patched column keeps its base spec for reading the original bytes;
      // the spec callers see carries the patched length.
      const patches = new Map<string, { base: ColumnSpec; patch: BytePatch }>();
      for (const { name, patch } of manifest.columns) {
        const spec = byName.get(name);
        if (!spec) throw new Error(`${options.delta}: unknown column ${name}`);
        if (!Number.isSafeInteger(patch.length) || patch.length % WIDTH[spec.type]) throw new Error(`${options.delta}: unaligned column ${name}`);
        patches.set(name, { base: spec, patch });
        byName.set(name, { ...spec, count: patch.length / WIDTH[spec.type], byteLength: patch.length });
      }
      return new KdayReader(path, meta, dataStart, handle, byName, patches, options.delta);
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

  column(name: string): Promise<NumericColumn> {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const loading = this.read(name);
    this.cache.set(name, loading);
    return loading;
  }

  /** Several columns at once, keyed by the last path segment. */
  async columns(...names: string[]): Promise<Record<string, NumericColumn>> {
    const loaded = await Promise.all(names.map((name) => this.column(name)));
    const out: Record<string, NumericColumn> = {};
    names.forEach((name, index) => {
      out[name.slice(name.indexOf(".") + 1)] = loaded[index]!;
    });
    return out;
  }

  private async read(name: string): Promise<NumericColumn> {
    const spec = this.spec(name);
    const patched = this.patches.get(name);
    const buffer = patched
      ? applyPatch(await this.readBytes(name, patched.base), patched.patch) // Buffer.alloc: own buffer at offset 0
      : await this.readBytes(name, spec);
    if (spec.type === "u8") return new Uint8Array(buffer.buffer, buffer.byteOffset, spec.count);
    if (spec.type === "u32") return new Uint32Array(buffer.buffer, buffer.byteOffset, spec.count);
    if (spec.type === "i32") return new Int32Array(buffer.buffer, buffer.byteOffset, spec.count);
    return new Float32Array(buffer.buffer, buffer.byteOffset, spec.count);
  }

  private async readBytes(name: string, spec: ColumnSpec): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(spec.byteLength);
    if (buffer.length > 0) {
      const result = await this.handle.read(buffer, 0, buffer.length, this.dataStart + spec.byteOffset);
      if (result.bytesRead !== buffer.length) throw new Error(`short read of KDAY column ${name}`);
    }
    return buffer;
  }

  string(id: number): string | null {
    return id === NONE ? null : (this.meta.strings[id] ?? null);
  }

  enum(group: string, id: number): string | null {
    if (id === NONE_U8) return null;
    return this.meta.enums[group]?.[id] ?? null;
  }

  /** The whole enum, for a task that carries a label vocabulary. */
  enumValues(group: string): readonly string[] {
    const values = this.meta.enums[group];
    if (!values) throw new Error(`KDAY has no enum ${group}`);
    return values;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

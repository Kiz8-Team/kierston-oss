/**
 * Which plates on the road were paid for rather than issued.
 *
 * A camera read carries the plate text and nothing about the plate. Whether
 * `GRAMS 1` is a personalized registration or an ordinary sequence is a fact
 * of the vehicle register, not of the sensor, and the day file has no column
 * for it — so the join is done here, against the same `vehicles.bin` the
 * records pages read.
 *
 * Only the personalized plates are decoded. The register is sixty-odd thousand
 * vehicles and the personalized share is a few per cent of them, so a set of
 * those strings is small enough to hold and answers the only question anybody
 * asks of it: is this plate one of them.
 *
 * `records.ts` already decodes this container, but it is a `"use client"`
 * module and importing it here would make it a client reference. This reads
 * the two columns it needs and nothing else, which is a page of code rather
 * than a restructuring of that reader.
 */

import { readFile, stat } from "node:fs/promises";
import { datasetPath } from "./repo";

const MAGIC = "KREC";
const align8 = (value: number) => (value + 7) & ~7;

/** The plate type that means somebody chose the characters. */
const PERSONALIZED = "personalized";

interface ArraySpec {
  name: string;
  kind: string;
  length: number;
  byteOffset: number;
}

interface FieldSpec {
  name: string;
  kind: string;
  column: string;
}

interface RecordHeader {
  tables: { name: string; rows: number; fields: FieldSpec[] }[];
  arrays: ArraySpec[];
}

export interface PlateRegistry {
  /** Every personalized plate on the register, as written. */
  personalized: Set<string>;
  /** Vehicles on the register, so a caller can say what the share was. */
  vehicles: number;
}

const cache = new Map<string, { mtimeMs: number; registry: PlateRegistry }>();

/**
 * The personalized plates, cached against the register's own mtime.
 *
 * A missing or unreadable register is an empty set rather than an error: the
 * pages that use this are about camera reads, and a viewer running before the
 * records generator has ever been run should still show its reads. What it
 * cannot then say is which of them were vanity plates, which is what an empty
 * set means downstream.
 */
export async function readPlateRegistry(): Promise<PlateRegistry> {
  return readPlatesOfType(PERSONALIZED);
}

/**
 * The plates of one type, by name rather than by the constant above.
 *
 * Parameterised because the type list belongs to the register and not to this
 * file: `passenger`, `school_bus` and `personalized` today, and whatever the
 * generator adds tomorrow. It also makes the decoding checkable against a type
 * whose plates are known.
 */
export async function readPlatesOfType(type: string): Promise<PlateRegistry> {
  const path = await datasetPath("vehicles");
  const empty: PlateRegistry = { personalized: new Set(), vehicles: 0 };
  const info = await stat(path).catch(() => null);
  if (!info) return empty;
  const key = `${path}:${type}`;
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.registry;

  const registry = await decode(path, type).catch(() => empty);
  cache.set(key, { mtimeMs: info.mtimeMs, registry });
  return registry;
}

async function decode(path: string, type: string): Promise<PlateRegistry> {
  const file = await readFile(path);
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const decoder = new TextDecoder();
  if (decoder.decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error(`${path} is not a records binary`);
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const headerLength = view.getUint32(4, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(8, 8 + headerLength))) as RecordHeader;
  const dataStart = align8(8 + headerLength);

  const arrays = new Map(meta.arrays.map((spec) => [spec.name, spec]));
  /**
   * One array, copied out rather than viewed in place.
   *
   * A typed-array view needs its byte offset aligned to the element width, and
   * where the file lands inside Node's buffer is not something this reader
   * controls. The columns wanted here are a few hundred kilobytes, so a copy
   * costs nothing and cannot be caught out by an odd offset.
   */
  const column = (name: string): Uint8Array | Uint16Array | Uint32Array => {
    const spec = arrays.get(name);
    if (!spec) throw new Error(`${path} has no array ${name}`);
    const start = dataStart + spec.byteOffset;
    const copy = bytes.slice(start, start + spec.length * width(spec.kind));
    if (spec.kind === "u8") return copy;
    if (spec.kind === "u16") return new Uint16Array(copy.buffer, 0, spec.length);
    return new Uint32Array(copy.buffer, 0, spec.length);
  };

  const table = meta.tables.find((entry) => entry.name === "vehicle");
  const plate = table?.fields.find((field) => field.name === "plate");
  const kind = table?.fields.find((field) => field.name === "plate_type");
  if (!table || !plate || !kind) return { personalized: new Set(), vehicles: 0 };

  // Both columns are interned: a code per row into a run of bytes cut by an
  // offset array. Index 0 is the empty string, which is how a null is written.
  const codes = column(kind.column);
  const typeNames = intern(
    decoder,
    column(`${kind.column}_offset`) as Uint32Array,
    column(`${kind.column}_bytes`) as Uint8Array,
  );
  const wanted = typeNames.indexOf(type);
  if (wanted < 0) return { personalized: new Set(), vehicles: table.rows };

  const plateCodes = column(plate.column) as Uint32Array;
  const plateOffsets = column(`${plate.column}_offset`) as Uint32Array;
  const plateBytes = column(`${plate.column}_bytes`) as Uint8Array;

  const personalized = new Set<string>();
  for (let row = 0; row < table.rows; row += 1) {
    if (codes[row] !== wanted) continue;
    const code = plateCodes[row]!;
    // Code 0 is the empty string and has no run behind it.
    if (code === 0) continue;
    const text = decoder.decode(
      plateBytes.subarray(plateOffsets[code - 1]!, plateOffsets[code]!),
    );
    if (text) personalized.add(text);
  }
  return { personalized, vehicles: table.rows };
}

/** The interned values of a column, index 0 being the empty string. */
function intern(decoder: TextDecoder, offsets: Uint32Array, bytes: Uint8Array): string[] {
  const out = [""];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

function width(kind: string): number {
  if (kind === "u8") return 1;
  if (kind === "u16") return 2;
  if (kind === "f64") return 8;
  return 4;
}

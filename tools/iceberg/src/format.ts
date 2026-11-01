/**
 * Readers for the sim_data binaries, in the one shape they all share.
 *
 * Every file the simulation writes — population.bin, the six record files,
 * ties.bin, sim_init.bin, day_*.bin — opens the same way: four bytes of magic,
 * a little-endian u32 JSON-header length, the header, then columns as raw
 * typed arrays on an 8-byte grid. Only the way the header names its columns
 * differs, and that is the only thing this module special-cases:
 *
 *     KPOP, KREC   meta.arrays   [{ name, kind, length, byteOffset }]
 *     KDAY         meta.columns  [{ name, type, count, byteOffset }]
 *     KTIE         meta.columns  [{ name, dtype }] — packed back to back
 *     KSIM         meta.sections — a directory of the files above, copied in
 *
 * Iceberg reads its own copies rather than importing kierstonblue's, because a
 * baseline recorded months ago has to stay readable when those move. The cost
 * is this file; the benefit is that nothing else in iceberg knows a byte
 * offset exists.
 */

import { readFileSync } from "node:fs";

export type TypedArray =
  | Uint8Array | Uint16Array | Uint32Array
  | Int8Array | Int32Array | Float32Array | Float64Array;

type Ctor = { new (buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray; BYTES_PER_ELEMENT: number };

/** The kind names KPOP and KREC use in their headers. */
const KIND: Record<string, Ctor> = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i32: Int32Array, f32: Float32Array, f64: Float64Array,
};

/** The numpy dtype strings ties.py writes. */
const DTYPE: Record<string, Ctor> = {
  "|u1": Uint8Array, "|i1": Int8Array, "<u2": Uint16Array, "<i2": Int32Array,
  "<u4": Uint32Array, "<i4": Int32Array, "<f4": Float32Array, "<f8": Float64Array,
};

const align8 = (value: number) => (value + 7) & ~7;

export interface Envelope {
  magic: string;
  meta: any;
  /** The whole file (or one section of a container), magic byte first. */
  bytes: Uint8Array;
  /** Where the columns begin, relative to `bytes`. */
  dataStart: number;
}

export function openEnvelope(bytes: Uint8Array): Envelope {
  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.subarray(0, 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true);
  if (8 + length > bytes.byteLength) {
    throw new Error(`${magic}: header claims ${length} bytes, file holds ${bytes.byteLength}`);
  }
  const meta = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length)));
  return { magic, meta, bytes, dataStart: align8(8 + length) };
}

export function openFile(path: string): Envelope {
  return openEnvelope(new Uint8Array(readFileSync(path)));
}

/**
 * One column, as a view where the bytes happen to land on the right boundary
 * and as a copy where they do not. A section lifted out of a container starts
 * wherever the packer put it, so an Int32Array over it is not always legal.
 */
function view(kind: Ctor, bytes: Uint8Array, offset: number, length: number): TypedArray {
  const at = bytes.byteOffset + offset;
  if (at % kind.BYTES_PER_ELEMENT === 0) return new kind(bytes.buffer, at, length);
  const copy = bytes.slice(offset, offset + length * kind.BYTES_PER_ELEMENT);
  return new kind(copy.buffer, copy.byteOffset, length);
}

/** Every column in an envelope, by name, whichever way its header named them. */
export function columns(env: Envelope): Record<string, TypedArray> {
  const out: Record<string, TypedArray> = {};

  if (Array.isArray(env.meta.arrays)) {
    for (const spec of env.meta.arrays) {
      const kind = KIND[spec.kind];
      if (!kind) throw new Error(`${env.magic}: unknown column kind ${spec.kind}`);
      out[spec.name] = view(kind, env.bytes, env.dataStart + spec.byteOffset, spec.length);
    }
    return out;
  }

  if (Array.isArray(env.meta.columns) && env.meta.columns[0]?.dtype) {
    // Ties: no offsets in the header, so the count carries the layout. Every
    // column is `edges` long and they follow each other with no padding.
    let at = env.dataStart;
    for (const spec of env.meta.columns) {
      const kind = DTYPE[spec.dtype];
      if (!kind) throw new Error(`${env.magic}: unknown dtype ${spec.dtype}`);
      out[spec.name] = view(kind, env.bytes, at, env.meta.edges);
      at += env.meta.edges * kind.BYTES_PER_ELEMENT;
    }
    return out;
  }

  if (Array.isArray(env.meta.columns)) {
    for (const spec of env.meta.columns) {
      const kind = KIND[spec.type];
      if (!kind) throw new Error(`${env.magic}: unknown column type ${spec.type}`);
      out[spec.name] = view(kind, env.bytes, env.dataStart + spec.byteOffset, spec.count);
    }
    return out;
  }

  throw new Error(`${env.magic}: header describes no columns`);
}

/**
 * An interned string table, as `<name>_offset` and `<name>_bytes`.
 *
 * Index 0 is the empty string in every packer that writes these, so a column
 * can spend 0 on "not applicable" without reserving a value.
 */
export function strings(arrays: Record<string, TypedArray>, name: string): string[] {
  const offsets = arrays[`${name}_offset`] as Uint32Array | undefined;
  const bytes = arrays[`${name}_bytes`] as Uint8Array | undefined;
  if (!offsets || !bytes) return [""];
  const decoder = new TextDecoder();
  const out = [""];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(decoder.decode(bytes.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

export interface Section {
  name: string;
  magic: string;
  source: string;
  rows: Record<string, number> | null;
  env: Envelope;
}

/** The nested files inside a KSIM container, each opened as its own envelope. */
export function sections(env: Envelope): Section[] {
  return (env.meta.sections ?? []).map((spec: any) => ({
    name: spec.name,
    magic: spec.magic,
    source: spec.source,
    rows: spec.rows ?? null,
    env: openEnvelope(env.bytes.subarray(
      env.dataStart + spec.byteOffset,
      env.dataStart + spec.byteOffset + spec.byteLength,
    )),
  }));
}

/**
 * Read a KDIF scenario delta and apply it over its base day in memory.
 *
 * A `.kdiff` is never merged into a standalone day for the benchmark: the
 * event store ingests base + delta, and the generators read the same pair
 * through `KdayReader.open(base, { delta })`. Only the sections the delta
 * patches are rebuilt, each on first use.
 *
 * Adapted from `kierston_scenarios/src/storage` rather than imported, for the
 * reason `kday.ts` gives: the envelope is small and the scenarios package
 * pulls in the engine. The format is four magic bytes, a little-endian u32
 * version, then one gzip-compressed JSON manifest holding a byte patch per
 * changed section. Everything here refuses rather than guesses — a delta
 * pointed at the wrong base throws.
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

/** A copy span into the base section, or base64 literal bytes. */
export type PatchOperation = [offset: number, length: number] | string;

export interface BytePatch {
  length: number;
  digest: string;
  operations: PatchOperation[];
}

export interface KdifManifest {
  format: "KIERSTON_DELTA";
  version: 1;
  baseHash: string;
  /** KDAY schema the patches apply to; absent on legacy v11 deltas. */
  baseVersion?: number;
  date: string;
  metadata?: BytePatch;
  columns: { name: string; patch: BytePatch }[];
}

const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;

export async function readKdif(path: string): Promise<KdifManifest> {
  const data = Buffer.from(await Bun.file(path).arrayBuffer());
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "KDIF") throw new Error(`${path} is not a KDIF scenario delta`);
  if (data.readUInt32LE(4) !== 1) throw new Error(`${path}: unsupported KDIF version ${data.readUInt32LE(4)}`);
  let manifest: KdifManifest;
  try {
    manifest = JSON.parse(gunzipSync(data.subarray(8), { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8"));
  } catch {
    throw new Error(`${path}: invalid or corrupt KDIF payload`);
  }
  if (!manifest || manifest.format !== "KIERSTON_DELTA" || manifest.version !== 1
    || typeof manifest.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.baseHash)
    || typeof manifest.date !== "string" || !Array.isArray(manifest.columns)
    || (manifest.baseVersion !== undefined && (!Number.isSafeInteger(manifest.baseVersion) || manifest.baseVersion < 1))) {
    throw new Error(`${path}: invalid KDIF manifest`);
  }
  const names = new Set<string>();
  for (const column of manifest.columns) {
    if (!column || typeof column.name !== "string" || names.has(column.name) || !column.patch) {
      throw new Error(`${path}: invalid KDIF column manifest`);
    }
    names.add(column.name);
  }
  return manifest;
}

/** Rebuild one patched section from its base bytes, verified against the patch's digest. */
export function applyPatch(base: Uint8Array, patch: BytePatch): Buffer {
  if (!patch || !Number.isSafeInteger(patch.length) || patch.length < 0 || patch.length > 0xffffffff
    || typeof patch.digest !== "string" || !/^[a-f0-9]{64}$/.test(patch.digest) || !Array.isArray(patch.operations)) {
    throw new Error("invalid KDIF byte patch");
  }
  let length = 0;
  for (const operation of patch.operations) {
    if (typeof operation === "string") {
      if (operation.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(operation)) throw new Error("invalid KDIF literal");
      length += Buffer.byteLength(operation, "base64");
    } else {
      if (!Array.isArray(operation) || operation.length !== 2 || !operation.every(Number.isSafeInteger)
        || operation[0] < 0 || operation[1] < 1 || operation[0] + operation[1] > base.length) {
        throw new Error("KDIF copy is outside the base section");
      }
      length += operation[1];
    }
    if (length > patch.length) throw new Error("KDIF patch length mismatch");
  }
  if (length !== patch.length) throw new Error("KDIF patch length mismatch");
  const output = Buffer.alloc(length);
  let at = 0;
  for (const operation of patch.operations) {
    const bytes = typeof operation === "string"
      ? Buffer.from(operation, "base64")
      : base.subarray(operation[0], operation[0] + operation[1]);
    output.set(bytes, at);
    at += bytes.length;
  }
  if (createHash("sha256").update(output).digest("hex") !== patch.digest) throw new Error("KDIF section digest mismatch");
  return output;
}

/**
 * The header bytes a delta's metadata patch was diffed against: the base
 * header without its columns and checkpoint descriptors, the string table
 * keeping its position. The patch digest proves the reduction is exact.
 */
export function reducedHeader(rawHeader: string): Buffer {
  const parsed = JSON.parse(rawHeader) as Record<string, unknown>;
  const strings = parsed.strings;
  delete parsed.columns;
  delete parsed.openingState;
  delete parsed.closingState;
  parsed.strings = strings;
  return Buffer.from(JSON.stringify(parsed));
}

/**
 * Whole-file SHA-256, which is what a delta binds to. Streamed, and cached
 * against size and mtime: a series stages many scenarios on the same base.
 */
const digests = new Map<string, { size: number; mtimeMs: number; digest: string }>();

export async function fileDigest(path: string): Promise<string> {
  const info = await stat(path);
  const cached = digests.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.digest;
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (let at = 0; at < info.size;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
      if (!bytesRead) throw new Error(`short read hashing ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  digests.set(path, { size: info.size, mtimeMs: info.mtimeMs, digest });
  return digest;
}

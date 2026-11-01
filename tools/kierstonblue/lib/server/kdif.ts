/**
 * The KDIF envelope: a scenario stored as a patch against one base day.
 *
 * A `.kdiff` is not a day. It is the bytes that differ from an immutable base
 * KDAY, bound to that base by a whole-file SHA-256, and it is meaningless on
 * its own — pointed at the wrong base it does not produce a wrong day, it
 * refuses. Everything here is written to fail loudly rather than to guess.
 *
 * Read directly rather than imported from `kierston_scenarios`, for the same
 * reason `kday.ts` reimplements the KDAY envelope: this app is a viewer. It
 * follows the formats the generators write and owns none of them, so a
 * scenario package that is not installed, or is mid-rewrite, cannot stop the
 * console from opening a file that is sitting on disk.
 *
 * Four magic bytes, a little-endian u32 version, then one gzip-compressed JSON
 * manifest. The manifest holds a byte patch per changed section: the header
 * metadata, each changed column, and the two checkpoints. Unchanged columns
 * are absent, which is the first useful thing the viewer can say about a
 * scenario before reading a single row.
 */

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { roots } from "./repo";
import type { DayMeta, ScenarioTruth } from "./kday";

export const KDIF_MAGIC = "KDIF";

/** The versions this reader understands. */
const KDIF_VERSIONS = [1];

/**
 * The decoder's ceiling on an expanded manifest, matching the writer's. A
 * corrupt length field is a hostile allocation otherwise.
 */
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;

/**
 * A copy span into the *base* section, or base64 literal bytes.
 *
 * The offset addresses the base, never the output being built. A patch that
 * reordered its own output would need a third operation; this one cannot
 * express that, and does not need to.
 */
export type PatchOperation = [offset: number, length: number] | string;

export interface BytePatch {
  length: number;
  digest: string;
  operations: PatchOperation[];
}

export interface KdifColumn {
  name: string;
  patch: BytePatch;
}

export interface KdifManifest {
  format: "KIERSTON_DELTA";
  version: number;
  baseHash: string;
  date: string;
  metadata?: BytePatch;
  columns: KdifColumn[];
  opening?: BytePatch;
  closing?: BytePatch;
}

/**
 * What one patch costs and how it is shaped.
 *
 * `literalBytes` is the only figure that is genuinely new data; `copyBytes` is
 * base the patch reuses. The ratio between them is the whole argument for the
 * format, and the op count is what says whether a section changed in one place
 * or was stirred: three operations is an insertion, four thousand is a
 * renumbering.
 */
export interface PatchStats {
  /** Bytes the patched section occupies once rebuilt. */
  length: number;
  operations: number;
  copies: number;
  literals: number;
  literalBytes: number;
  copyBytes: number;
}

export function patchStats(patch: BytePatch): PatchStats {
  let copies = 0;
  let literals = 0;
  let literalBytes = 0;
  let copyBytes = 0;
  for (const operation of patch.operations) {
    if (typeof operation === "string") {
      literals += 1;
      literalBytes += Buffer.byteLength(operation, "base64");
    } else {
      copies += 1;
      copyBytes += operation[1];
    }
  }
  return {
    length: patch.length,
    operations: patch.operations.length,
    copies,
    literals,
    literalBytes,
    copyBytes,
  };
}

function validPatch(patch: unknown): patch is BytePatch {
  if (!patch || typeof patch !== "object") return false;
  const value = patch as BytePatch;
  return Number.isSafeInteger(value.length) && value.length >= 0
    && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)
    && Array.isArray(value.operations);
}

export async function readKdif(path: string): Promise<KdifManifest> {
  const handle = await open(path, "r");
  let raw: Buffer;
  try {
    const info = await handle.stat();
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, 8, 0);
    if (prefix.toString("utf8", 0, 4) !== KDIF_MAGIC) {
      throw new Error(`${path} is not a KDIF scenario delta`);
    }
    const version = prefix.readUInt32LE(4);
    if (!KDIF_VERSIONS.includes(version)) {
      throw new Error(`unsupported KDIF version ${version}`);
    }
    raw = Buffer.alloc(Math.max(0, info.size - 8));
    if (raw.length) await handle.read(raw, 0, raw.length, 8);
  } finally {
    await handle.close();
  }

  let manifest: KdifManifest;
  try {
    const json = gunzipSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8");
    manifest = JSON.parse(json) as KdifManifest;
  } catch {
    throw new Error("invalid or corrupt KDIF payload");
  }

  if (!manifest || manifest.format !== "KIERSTON_DELTA" || manifest.version !== 1
      || typeof manifest.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.baseHash)
      || typeof manifest.date !== "string" || !Array.isArray(manifest.columns)) {
    throw new Error("invalid KDIF manifest");
  }
  const seen = new Set<string>();
  for (const column of manifest.columns) {
    if (!column || typeof column.name !== "string" || seen.has(column.name)
        || !validPatch(column.patch)) {
      throw new Error("invalid KDIF column manifest");
    }
    seen.add(column.name);
  }
  return manifest;
}

/**
 * Rebuild a patched section from the base bytes.
 *
 * Lengths and ranges are checked before anything is allocated, and the result
 * is verified against the patch's own digest. A patch that does not reproduce
 * its recorded digest is not applied halfway and reported — it throws, because
 * a section that rebuilt wrongly is indistinguishable from data.
 */
export function applyPatch(base: Buffer, patch: BytePatch): Buffer {
  if (!validPatch(patch)) throw new Error("invalid KDIF byte patch");
  let length = 0;
  for (const operation of patch.operations) {
    if (typeof operation === "string") {
      if (operation.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(operation)) {
        throw new Error("invalid KDIF literal");
      }
      length += Buffer.byteLength(operation, "base64");
    } else {
      if (!Array.isArray(operation) || operation.length !== 2
          || !operation.every(Number.isSafeInteger)
          || operation[0] < 0 || operation[1] < 1
          || operation[0] + operation[1] > base.length) {
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
  const digest = createHash("sha256").update(output).digest("hex");
  if (digest !== patch.digest) throw new Error("KDIF section digest mismatch");
  return output;
}

/**
 * The header a delta was diffed against, byte for byte.
 *
 * Not the base header: the writer diffs a *reduced* header — everything except
 * the columns and the two checkpoint descriptors, all three of which the KDAY
 * writer regenerates on materialization, with the string table pinned back in
 * the position it already held. Reproducing that reduction exactly is what
 * makes the metadata patch appliable here, and the patch's digest is what
 * proves the reduction was right. Get it wrong and this throws rather than
 * returning a plausible header.
 */
function reducedHeader(rawHeader: string): Buffer {
  const parsed = JSON.parse(rawHeader) as Record<string, unknown> & DayMeta;
  const strings = parsed.strings;
  delete (parsed as Record<string, unknown>).columns;
  delete (parsed as Record<string, unknown>).openingState;
  delete (parsed as Record<string, unknown>).closingState;
  // Assigning a key that is already present keeps its original position, which
  // is the order the writer's own object spread produces.
  parsed.strings = strings;
  return Buffer.from(JSON.stringify(parsed));
}

/** The raw header JSON of a KDAY, as text, plus where its columns begin. */
export async function readRawHeader(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, 8, 0);
    if (prefix.toString("utf8", 0, 4) !== "KDAY") throw new Error(`${path} is not a KDAY file`);
    const length = prefix.readUInt32LE(4);
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 8);
    return header.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The scenario's own account of itself, without materializing anything.
 *
 * The truth block lives in the header, and the header is one of the sections
 * the delta patches, so it can be recovered from the base plus the delta
 * alone — a few megabytes of work rather than the 886 MB and twenty seconds a
 * merge costs. Returns null when the delta carries no metadata patch, which
 * would mean a scenario that changed rows and told no story about it.
 */
export async function scenarioTruthFromDelta(
  basePath: string,
  manifest: KdifManifest,
): Promise<ScenarioTruth | null> {
  if (!manifest.metadata) return null;
  const base = reducedHeader(await readRawHeader(basePath));
  const patched = applyPatch(base, manifest.metadata);
  const header = JSON.parse(patched.toString("utf8")) as DayMeta;
  return header.scenario ?? null;
}

/**
 * Whole-file digest, which is what a delta binds to.
 *
 * Streamed rather than read: the base is most of a gigabyte, and a viewer that
 * buffered it to check a hash would be worse than the merge it is avoiding.
 * Cached against mtime — re-exporting a day changes it, and nothing else does.
 */
const digestCache = new Map<string, { mtimeMs: number; digest: string }>();

export async function fileDigest(path: string): Promise<string> {
  const info = await stat(path);
  const cached = digestCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.digest;

  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    let at = 0;
    while (at < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  digestCache.set(path, { mtimeMs: info.mtimeMs, digest });
  return digest;
}

/** Every `.kdiff` sitting in the outputs directory, newest first. */
export async function listDeltaFiles(): Promise<string[]> {
  const { outputs } = await roots();
  const names = await readdir(outputs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .filter((name) => name.endsWith(".kdiff"))
    .map((name) => join(outputs, name));
}

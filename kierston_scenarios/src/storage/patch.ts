import { createHash } from "node:crypto";

/** A copy references bytes in this section of the base, not the growing output. */
export type Operation = [offset: number, length: number] | string;
export interface BytePatch { length: number; digest: string; operations: Operation[] }
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const WINDOW = 32, STRIDE = 128, MULTIPLIER = 31;
let power = 1;
for (let i = 1; i < WINDOW; i++) power = Math.imul(power, MULTIPLIER);
function hashAt(bytes: Buffer, at: number): number {
  let hash = 0;
  for (let i = at; i < at + WINDOW; i++) hash = (Math.imul(hash, MULTIPLIER) + bytes[i]!) | 0;
  return hash;
}

/** Linear rolling-hash matching survives inserted/deleted rows and byte shifts.
 * Hashes only find candidates; every copied byte is compared. Literal bytes are
 * base64 in the manifest, then the entire delta is gzip-compressed.
 */
export function diffBytes(base: Buffer, next: Buffer): BytePatch | undefined {
  if (base.equals(next)) return undefined;
  if (next.length > 0xffffffff) throw new Error("KDIF v1 patched sections cannot exceed 4 GiB");
  const operations: Operation[] = [];
  const copy = (at: number, length: number) => {
    if (!length) return;
    const previous = operations.at(-1);
    if (Array.isArray(previous) && previous[0] + previous[1] === at) previous[1] += length;
    else operations.push([at, length]);
  };
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(base.length, next.length) && base[prefix] === next[prefix]) prefix++;
  while (suffix < Math.min(base.length, next.length) - prefix
    && base[base.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  copy(0, prefix);
  const end = next.length - suffix;
  // Bound collision buckets so repeated data cannot cause quadratic searches.
  const index = new Map<number, number[]>();
  for (let at = prefix; at + WINDOW <= base.length - suffix; at += STRIDE) {
    const hash = hashAt(base, at), bucket = index.get(hash) ?? [];
    if (bucket.length < 4) bucket.push(at);
    index.set(hash, bucket);
  }
  let literal = prefix, at = prefix;
  let hash = at + WINDOW <= end ? hashAt(next, at) : 0;
  while (at + WINDOW <= end) {
    let match = -1;
    for (const candidate of index.get(hash) ?? []) {
      if (base.subarray(candidate, candidate + WINDOW).equals(next.subarray(at, at + WINDOW))) { match = candidate; break; }
    }
    if (match >= 0) {
      if (at > literal) operations.push(next.subarray(literal, at).toString("base64"));
      let length = WINDOW;
      while (at + length < end && match + length < base.length - suffix && next[at + length] === base[match + length]) length++;
      copy(match, length);
      at += length; literal = at;
      if (at + WINDOW <= end) hash = hashAt(next, at);
    } else {
      hash = (Math.imul((hash - Math.imul(next[at]!, power)) | 0, MULTIPLIER) + (next[at + WINDOW] ?? 0)) | 0;
      at++;
    }
  }
  if (literal < end) operations.push(next.subarray(literal, end).toString("base64"));
  copy(base.length - suffix, suffix);
  return { length: next.length, digest: digest(next), operations };
}

export function applyBytes(base: Buffer, patch: BytePatch): Buffer {
  if (!patch || !Number.isSafeInteger(patch.length) || patch.length < 0 || patch.length > 0xffffffff
    || typeof patch.digest !== "string" || !/^[a-f0-9]{64}$/.test(patch.digest) || !Array.isArray(patch.operations)) {
    throw new Error("invalid delta byte patch");
  }
  // Validate lengths and ranges before allocating the requested output.
  let length = 0;
  for (const operation of patch.operations) {
    if (typeof operation === "string") {
      if (operation.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(operation)) throw new Error("invalid delta literal");
      length += Buffer.byteLength(operation, "base64");
    } else {
      if (!Array.isArray(operation) || operation.length !== 2 || !operation.every(Number.isSafeInteger)
        || operation[0] < 0 || operation[1] < 1 || operation[0] + operation[1] > base.length) throw new Error("delta copy is outside base section");
      length += operation[1];
    }
    if (length > patch.length) throw new Error("delta patch length mismatch");
  }
  if (length !== patch.length) throw new Error("delta patch length mismatch");
  const output = Buffer.allocUnsafe(length);
  let at = 0;
  for (const operation of patch.operations) {
    const bytes = typeof operation === "string" ? Buffer.from(operation, "base64") : base.subarray(operation[0], operation[0] + operation[1]);
    output.set(bytes, at); at += bytes.length;
  }
  if (digest(output) !== patch.digest) throw new Error("delta section digest mismatch");
  return output;
}

import { createHash } from "node:crypto";

/** An opaque deterministic UUID for a source row. */
export function recordId(digest: string, table: string, row: number): string {
  // Hash the complete source locator. The previous representation copied the
  // row number into the UUID's final eight bytes, which made source ordering
  // visible to KDI callers even though the identifier was described as opaque.
  const bytes = createHash("sha256")
    .update(digest)
    .update("\0")
    .update(table)
    .update("\0")
    .update(String(row))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

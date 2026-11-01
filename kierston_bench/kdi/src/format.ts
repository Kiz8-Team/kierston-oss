import type { Column } from "./catalog-types";
import { label } from "./labels";

/** How one value prints on a return. Nulls print as a rule, never as "null". */
export function formatCell(value: unknown, format: Column["format"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map((entry) => label(String(entry))).join("; ") : "—";
  if (format === "bool" || typeof value === "boolean") return value ? "Yes" : "No";
  if (format === "money") {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return String(value);
    return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === "seconds") {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return String(value);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (format === "year") {
    const year = Number(value);
    // Sentinel years the sources use for "not applicable" print as a rule.
    if (!Number.isFinite(year) || year <= 0) return "—";
    return String(year);
  }
  // A code column is turned into English; a merchant name or an address does
  // not match the code shape and is left exactly as stored. Identifiers are
  // exempt: a VIN or a docket is not a word.
  const text = String(value);
  return format === "code" ? text : label(text);
}

export function isNull(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

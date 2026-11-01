// Operators type identifiers the way they are written on paper: a plate with or
// without its hyphen, an SSN with or without dashes, a phone number in any of
// the shapes a dispatcher might read out. The stores hold one canonical form
// each, so every value is rewritten into the form its column actually uses
// before it reaches a query.

export type Normalizer =
  | "ssn"
  | "phone"
  | "plate"
  | "plate_compact"
  | "digits"
  | "upper"
  | "date"
  | "trim";

const digitsOnly = (value: string) => value.replace(/\D+/g, "");

/** 183442907, 183-44-2907 and "183 44 2907" all become 183-44-2907. */
function ssn(value: string): string {
  const digits = digitsOnly(value);
  if (digits.length !== 9) return value.trim();
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** 6102208435, +1 610 220 8435 and (610) 220-8435 all become (610) 220-8435. */
function phone(value: string): string {
  let digits = digitsOnly(value);
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return value.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** KYX9308 and kyx-9308 both become KYX-9308, the registration form. */
function plate(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  if (/^[A-Z]{3}[0-9]{4}$/.test(compact)) return `${compact.slice(0, 3)}-${compact.slice(3)}`;
  return value.trim().toUpperCase();
}

/** The ALPR store keeps a hyphen-free plate alongside the read text. */
function plateCompact(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
}

/** 08/23/2026, 20260823 and 2026-08-23 all become 2026-08-23. */
function date(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const slashed = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (slashed) {
    const [, month, day, year] = slashed;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const packed = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (packed) return `${packed[1]}-${packed[2]}-${packed[3]}`;
  return trimmed;
}

const NORMALIZERS: Record<Normalizer, (value: string) => string> = {
  ssn,
  phone,
  plate,
  plate_compact: plateCompact,
  digits: digitsOnly,
  upper: (value) => value.trim().toUpperCase(),
  date,
  trim: (value) => value.trim(),
};

export function normalize(value: string, as: Normalizer | undefined): string {
  return NORMALIZERS[as ?? "trim"](value);
}

/** A date the query layer will accept, or null if the operator typed nonsense. */
export function calendarDate(value: string): string | null {
  const normalized = date(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return normalized;
}

export type Range = number | { min: number; max: number };

export function inRange(value: number | null | undefined, range: Range | undefined): boolean {
  if (range === undefined) return true;
  if (value === undefined || value === null) return false;
  if (typeof range === "number") return value === range;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max) throw new Error("invalid selection range");
  return value >= range.min && value <= range.max;
}

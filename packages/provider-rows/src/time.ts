const formatter = (timeZone: string): Intl.DateTimeFormat => new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MIDNIGHTS = new Map<string, number>();

/** UTC instant at local midnight for an ISO date in an IANA time zone. */
export function zonedMidnight(date: string, timeZone: string): number {
  const key = `${timeZone}\0${date}`;
  const cached = MIDNIGHTS.get(key);
  if (cached !== undefined) return cached;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`invalid date ${date}`);
  const guess = Date.UTC(year, month - 1, day);
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(new Date(guess))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const represented = Date.UTC(
    parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!,
  );
  const midnight = guess - (represented - guess);
  MIDNIGHTS.set(key, midnight);
  return midnight;
}

export function atSecond(date: string, second: number, timeZone: string): Date {
  return new Date(zonedMidnight(date, timeZone) + second * 1_000);
}

export function signedU32(value: number): number {
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

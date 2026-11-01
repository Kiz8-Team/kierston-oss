import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { currentDay } from "./city";
import { roots } from "./repo";
import {
  NONE, NONE_CELL, NONE_I32, NONE_U8, dayPath, openDay, personRow, readCells,
  readMeta, readSubscribers, value,
  type DayCell, type DayMeta, type DaySubscriber, type Reader,
} from "./kday";

/** The envelope's own vocabulary, re-exported so a reader of a person's day
 * imports every type it names from one place. */
export type { DayCell, DayMeta, DaySubscriber } from "./kday";

/** The transaction columns, named once — the row reader and the citywide pass
 * both walk exactly these. */
const TX_COLUMNS = [
  "tx.minute", "tx.amount", "tx.kind", "tx.reason", "tx.approved", "tx.decline",
  "tx.instrument", "tx.mcc", "tx.merchant", "tx.account", "tx.card",
  "tx.network", "tx.venue", "tx.balanceAfter", "tx.latE6", "tx.lonE6",
] as const;

/** The cellular tables, version 3. Named once for the same reason as TX_COLUMNS. */
const SPAN_COLUMNS = [
  "span.subscriber", "span.cell", "span.start", "span.end", "span.rsrp",
  "span.exposure", "span.connected",
] as const;

const EVENT_COLUMNS = [
  "event.subscriber", "event.minute", "event.kind", "event.cell",
  "event.previous", "event.cause",
] as const;

/**
 * The transaction kinds that are money leaving to buy something.
 *
 * The other three are movements, not purchases: a withdrawal changes which of
 * a person's own pockets the money is in, wages are money arriving, and a card
 * payment settles charges this file already counted at the till. Summing any
 * of them into a spending total double-counts, and in the case of wages it
 * double-counts the largest number in the file.
 */
const SPENDING = new Set(["payment"]);

export interface DaySummary {
  date: string;
  bytes: number;
  modifiedAt: string;
  initDigest: string | null;
  counts: DayMeta["counts"];
  /** Whether this file was written by an export that had a bank attached. */
  banked: boolean;
}

export interface DayScheduleEntry {
  start: number;
  end: number;
  kind: string;
  label: string | null;
  where: string | null;
}

export interface DayMovementLeg {
  depart: number;
  arrive: number;
  mode: string;
  purpose: string;
  /**
   * The registered vehicle this movement was made in, where one carried it.
   *
   * Null on a walk, on transit, and in every file older than version 12, which
   * had no VIN on a leg at all — the same absence either way, so a viewer
   * reading a car leg with no vehicle should say nothing rather than guess.
   */
  vehicle: string | null;
  from: { lat: number; lon: number; label: string | null };
  to: { lat: number; lon: number; label: string | null };
  kilometres: number;
  estimated: boolean;
  wait: number;
  path: [number, number][];
}

/**
 * One row of the day's ledger, as the bank wrote it.
 *
 * `reason` is not `mcc` restated. The merchant category is what the card
 * network sees — 5411 is every grocer in the city — while the reason is what
 * `spend.ts` priced the visit as, which is the only thing that can tell a
 * week's shop from a milk run at the same shop. Both are kept because they
 * answer different questions and neither derives the other.
 *
 * A declined row has no `balanceAfter`: nothing moved, so there is no balance
 * to state. It is still a fact about the day and is shown as one.
 */
export interface DayTransaction {
  minute: number;
  amount: number;
  kind: string;
  reason: string;
  approved: boolean;
  decline: string | null;
  instrument: string | null;
  mcc: number | null;
  merchant: string | null;
  account: string | null;
  card: string | null;
  network: string | null;
  venue: string | null;
  balanceAfter: number | null;
  lat: number | null;
  lon: number | null;
}

/**
 * One unbroken stretch on one cell — ground truth, not evidence.
 *
 * The span table says which cell served the handset minute by minute whether
 * or not anything reported it. An idle phone reselecting between cells inside
 * one tracking area appears here and appears in no operator's records, which
 * is exactly why the two tables are kept apart.
 */
export interface DayCellSpan {
  subscriber: number;
  /** Null where nothing served the handset: powered off, flat, out of reach. */
  cell: number | null;
  start: number;
  /** Exclusive, so `end - start` is the minutes held. */
  end: number;
  /** Mean RSRP over the span in dBm, or null when unattached. */
  rsrp: number | null;
  exposure: string;
  /** Minutes of the span the radio was carrying a bearer rather than camped. */
  connected: number;
}

/** One line an operator's own signalling log would hold. */
export interface DayNetEvent {
  subscriber: number;
  minute: number;
  kind: string;
  cell: number | null;
  /** The cell left behind, for a handover or a reselection. */
  previous: number | null;
  cause: string;
}

export interface DayRadio {
  /** False for a file exported without a network — see `PersonDay.banked`. */
  networked: boolean;
  subscribers: DaySubscriber[];
  /** Only the cells this person's day touched, each carrying its own index. */
  cells: DayCell[];
  spans: DayCellSpan[];
  events: DayNetEvent[];
}

export interface PersonDay {
  date: string;
  person: number;
  initDigest: string | null;
  schedule: DayScheduleEntry[];
  legs: DayMovementLeg[];
  transactions: DayTransaction[];
  /** False for a day file exported without a bank — see `DaySummary`. */
  banked: boolean;
  radio: DayRadio;
}

/** One category of charge, the way `spend.ts` prices it rather than the way a
 * card network files it. */
export interface SpendCategory {
  reason: string;
  count: number;
  total: number;
  median: number;
  /** Share of the day's approved spending, not of its transactions. */
  share: number;
}

export interface SpendBand {
  label: string;
  value: number;
}

export interface SpendHour {
  hour: number;
  count: number;
  total: number;
}

export interface SpendMerchant {
  merchant: string;
  count: number;
  total: number;
}

export interface SpendMcc {
  mcc: number;
  /** The ISO 18245 short name, where the codebook carries one. */
  label: string | null;
  count: number;
  total: number;
}

export interface SpendPerson {
  person: number;
  count: number;
  total: number;
}

/**
 * The city's money for one date, in one pass over the transaction columns.
 *
 * Whole-file rather than per-person on purpose: a single row says resident
 * 41,208 paid $8.40 at a deli, which the day page already shows. What it
 * cannot say is whether $8.40 is a normal deli ticket here, what share of the
 * city's payments were made in cash, or which hour the tills were busy — and
 * those are the figures that say whether `spend.ts` and `bank/routing.ts` are
 * calibrated. Every one of them has a published counterpart: the CE Diary's
 * per-occasion medians, the Fed's payment-diary cash share and payments per
 * person per day.
 */
export interface DaySpending {
  date: string;
  /** False where the export ran without a bank: no ledger was ever written. */
  banked: boolean;
  persons: number;
  transactions: number;
  /** People who moved money at all today. */
  payers: number;
  payments: number;
  withdrawals: number;
  declined: number;
  /** Approved payments, summed. Withdrawals are not spending — see below. */
  spent: number;
  withdrawn: number;
  medianTicket: number;
  /** Share of approved payments made in currency. */
  cashShare: number;
  categories: SpendCategory[];
  instruments: SpendBand[];
  declines: SpendBand[];
  tickets: SpendBand[];
  hours: SpendHour[];
  merchants: SpendMerchant[];
  mccs: SpendMcc[];
  spenders: SpendPerson[];
}

/** Ticket sizes, on the boundaries the Fed's payment diary reports cash use at. */
const TICKET_BANDS: readonly (readonly [number, number, string])[] = [
  [0, 5, "under $5"],
  [5, 10, "$5–10"],
  [10, 25, "$10–25"],
  [25, 50, "$25–50"],
  [50, 100, "$50–100"],
  [100, 250, "$100–250"],
  [250, Infinity, "$250+"],
];

/** How many rows each leaderboard keeps. Enough to read, short enough to scan. */
const TOP = 15;

/**
 * ISO 18245 short names for the codes the day's transactions carry.
 *
 * `assign_mcc.py` already writes a code → name table beside its tag mapping, so
 * this reads that rather than keeping a second copy of a hundred-odd codes in
 * TypeScript. The four below are the exception and have to be here: they are
 * codes `spend.ts` raises itself for a fare, a farebox, a meter and a cash
 * machine, none of which is a POI tag, so the POI table has never seen them.
 */
const SIM_MCC: Record<number, string> = {
  4111: "Local and suburban commuter transport",
  4121: "Taxicabs and limousines",
  6011: "Financial institutions, cash disbursement",
  7523: "Parking lots and garages",
};

/** Per city build: the codebook lives in its sim_data. */
const mccLabels = new Map<string, Map<number, string>>();

async function loadMccLabels(): Promise<Map<number, string>> {
  const path = join((await roots()).sim, "mcc_by_tag.json");
  const known = mccLabels.get(path);
  if (known) return known;
  const labels = new Map<number, string>(
    Object.entries(SIM_MCC).map(([code, name]) => [Number(code), name]),
  );
  try {
    const raw = await readFile(path, "utf8");
    const table = JSON.parse(raw) as { labels?: Record<string, string> };
    for (const [code, name] of Object.entries(table.labels ?? {})) {
      if (!labels.has(Number(code))) labels.set(Number(code), name);
    }
  } catch {
    // A checkout without the codebook still shows the codes, unnamed. Losing
    // the names is a caption, not the figure.
  }
  mccLabels.set(path, labels);
  return labels;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The day a server page opens on: the URL's if the build has it, else the one
 * picked in the header, else the newest.
 */
export async function pickDay(wanted: string | undefined): Promise<string> {
  const [days, header] = await Promise.all([listDays().catch(() => []), currentDay()]);
  const has = (date: string | null | undefined) => Boolean(date) && days.some((day) => day.date === date);
  if (has(wanted)) return wanted!;
  if (has(header)) return header!;
  return days[0]?.date ?? wanted ?? "";
}

export async function listDays(): Promise<DaySummary[]> {
  const { outputs } = await roots();
  const names = await readdir(outputs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = names
    .filter((name) => /^day_\d{4}-\d{2}-\d{2}\.bin$/.test(name))
    .map((name) => join(outputs, name));

  const days = await Promise.all(files.map(async (path) => {
    const [{ meta }, info] = await Promise.all([readMeta(path), stat(path)]);
    return {
      date: meta.date,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      initDigest: meta.initDigest,
      counts: meta.counts,
      banked: meta.counts.banked === 1,
    } satisfies DaySummary;
  }));
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * One person's day as movement alone: what they were committed to, and how
 * they got between those places.
 *
 * Split out of `readPersonDay` because a gathering needs this for everybody at
 * the table and needs none of the rest. Reading eight people's full days to
 * draw one dinner would pull eight ledgers, eight span tables and eight event
 * tables — the last of which is the largest table in the file — for a page
 * that shows a map and a clock.
 *
 * Takes an open reader and a *row*, not a resident id, so a caller resolving a
 * party of six pays for one open file and six `personRow` lookups.
 */
export async function readMovement(
  reader: Reader, row: number,
): Promise<{ schedule: DayScheduleEntry[]; legs: DayMovementLeg[] }> {
  const { meta, spec, slice: readSlice, scalar } = reader;
  const [scheduleOffset, scheduleCount, legOffset, legCount] = await Promise.all([
    scalar("person.scheduleOffset", row), scalar("person.scheduleCount", row),
    scalar("person.legOffset", row), scalar("person.legCount", row),
  ]);

  const scheduleColumns = ["schedule.start", "schedule.end", "schedule.kind", "schedule.label", "schedule.where"];
  const legColumns = [
    "leg.depart", "leg.arrive", "leg.mode", "leg.purpose", "leg.fromLatE6", "leg.fromLonE6",
    "leg.toLatE6", "leg.toLonE6", "leg.kilometres", "leg.estimated", "leg.wait",
    "leg.fromLabel", "leg.toLabel", "leg.pathOffset", "leg.pathCount",
    // Version 12. Asked for only where the file has it, so a v11 day still
    // reads rather than failing on a column that did not exist when it was
    // written.
    ...(reader.has("leg.vehicle") ? ["leg.vehicle"] : []),
  ];
  const [scheduleData, legData] = await Promise.all([
    Promise.all(scheduleColumns.map((name) => readSlice(name, scheduleOffset, scheduleCount))),
    Promise.all(legColumns.map((name) => readSlice(name, legOffset, legCount))),
  ]);
  const scheduleBuffers = new Map(scheduleColumns.map((name, i) => [name, scheduleData[i]]));
  const legBuffers = new Map(legColumns.map((name, i) => [name, legData[i]]));
  const from = (buffers: Map<string, Buffer>, name: string, index: number) =>
    value(buffers.get(name)!, spec(name).type, index);
  const string = reader.string;

  const schedule = Array.from({ length: scheduleCount }, (_, i) => ({
    start: from(scheduleBuffers, "schedule.start", i),
    end: from(scheduleBuffers, "schedule.end", i),
    kind: meta.enums.scheduleKind[from(scheduleBuffers, "schedule.kind", i)] ?? "unknown",
    label: string(from(scheduleBuffers, "schedule.label", i)),
    where: string(from(scheduleBuffers, "schedule.where", i)),
  }));

  const pathRanges = Array.from({ length: legCount }, (_, i) => ({
    offset: from(legBuffers, "leg.pathOffset", i),
    count: from(legBuffers, "leg.pathCount", i),
  }));
  const paths = await Promise.all(pathRanges.map(async ({ offset, count }) => {
    const [lat, lon] = await Promise.all([
      readSlice("path.latE6", offset, count), readSlice("path.lonE6", offset, count),
    ]);
    return Array.from({ length: count }, (_, i) => [
      value(lat, "i32", i) / 1e6, value(lon, "i32", i) / 1e6,
    ] as [number, number]);
  }));

  const legs = Array.from({ length: legCount }, (_, i) => ({
    depart: from(legBuffers, "leg.depart", i),
    arrive: from(legBuffers, "leg.arrive", i),
    mode: meta.enums.mode[from(legBuffers, "leg.mode", i)] ?? "other",
    purpose: meta.enums.purpose[from(legBuffers, "leg.purpose", i)] ?? "other",
    from: {
      lat: from(legBuffers, "leg.fromLatE6", i) / 1e6,
      lon: from(legBuffers, "leg.fromLonE6", i) / 1e6,
      label: string(from(legBuffers, "leg.fromLabel", i)),
    },
    to: {
      lat: from(legBuffers, "leg.toLatE6", i) / 1e6,
      lon: from(legBuffers, "leg.toLonE6", i) / 1e6,
      label: string(from(legBuffers, "leg.toLabel", i)),
    },
    vehicle: legBuffers.has("leg.vehicle")
      ? string(from(legBuffers, "leg.vehicle", i))
      : null,
    kilometres: from(legBuffers, "leg.kilometres", i),
    estimated: from(legBuffers, "leg.estimated", i) === 1,
    wait: from(legBuffers, "leg.wait", i),
    path: paths[i],
  }));

  return { schedule, legs };
}

export async function readPersonDay(date: string, person: number): Promise<PersonDay | null> {
  const path = await dayPath(date);
  if (!path) return null;
  return readPersonDayAt(path, person);
}

/**
 * The same day, addressed by file rather than by date.
 *
 * A scenario day is not `day_<date>.bin` — it is a materialized delta sitting
 * beside its base under whatever name the scenario was written to, and both
 * files claim the same date in their headers. Comparing the two means opening
 * them by path, so that is the primitive and `readPersonDay` is the lookup in
 * front of it.
 */
export async function readPersonDayAt(path: string, person: number): Promise<PersonDay | null> {
  if (!Number.isSafeInteger(person) || person < 0) return null;
  const reader = await openDay(path);
  const { meta, spec, has: hasColumn, slice: readSlice, scalar } = reader;

  try {
    const row = await personRow(reader, person);
    if (row < 0) return null;

    const money = hasColumn("tx.minute");
    const [{ schedule, legs }, txOffset, txCount] = await Promise.all([
      readMovement(reader, row),
      money ? scalar("person.txOffset", row) : Promise.resolve(0),
      money ? scalar("person.txCount", row) : Promise.resolve(0),
    ]);

    const from = (buffers: Map<string, Buffer>, name: string, index: number) =>
      value(buffers.get(name)!, spec(name).type, index);
    const string = reader.string;

    const txData = await Promise.all(
      TX_COLUMNS.map((name) => money
        ? readSlice(name, txOffset, txCount)
        : Promise.resolve(Buffer.alloc(0))),
    );
    const txBuffers = new Map(TX_COLUMNS.map((name, i) => [name as string, txData[i]]));
    const label = (list: string[] | undefined, code: number): string | null =>
      code === NONE_U8 ? null : (list?.[code] ?? null);

    const transactions = Array.from({ length: money ? txCount : 0 }, (_, i) => {
      const lat = from(txBuffers, "tx.latE6", i);
      const lon = from(txBuffers, "tx.lonE6", i);
      const balance = from(txBuffers, "tx.balanceAfter", i);
      const mcc = from(txBuffers, "tx.mcc", i);
      return {
        minute: from(txBuffers, "tx.minute", i),
        amount: from(txBuffers, "tx.amount", i),
        kind: label(meta.enums.txKind, from(txBuffers, "tx.kind", i)) ?? "payment",
        reason: label(meta.enums.reason, from(txBuffers, "tx.reason", i)) ?? "unknown",
        approved: from(txBuffers, "tx.approved", i) === 1,
        decline: label(meta.enums.decline, from(txBuffers, "tx.decline", i)),
        instrument: label(meta.enums.instrument, from(txBuffers, "tx.instrument", i)),
        mcc: mcc === 0 ? null : mcc,
        merchant: string(from(txBuffers, "tx.merchant", i)),
        account: string(from(txBuffers, "tx.account", i)),
        card: string(from(txBuffers, "tx.card", i)),
        network: string(from(txBuffers, "tx.network", i)),
        venue: string(from(txBuffers, "tx.venue", i)),
        // NaN is a declined row: nothing moved, so no balance was reached.
        balanceAfter: Number.isNaN(balance) ? null : balance,
        lat: lat === NONE_I32 ? null : lat / 1e6,
        lon: lon === NONE_I32 ? null : lon / 1e6,
      } satisfies DayTransaction;
    });

    // ---- The cellular day ---------------------------------------------------
    // Read on the same terms as the ledger: the columns are absent from a v1
    // or v2 file, and present but empty in a v3 file exported without a
    // network. `counts.networked` is what tells those two apart from a person
    // who genuinely has no phone.
    const wired = hasColumn("span.subscriber");
    const [spanOffset, spanCount, eventOffset, eventCount] = await Promise.all([
      wired ? scalar("person.spanOffset", row) : Promise.resolve(0),
      wired ? scalar("person.spanCount", row) : Promise.resolve(0),
      wired ? scalar("person.eventOffset", row) : Promise.resolve(0),
      wired ? scalar("person.eventCount", row) : Promise.resolve(0),
    ]);

    const [spanData, eventData] = await Promise.all([
      Promise.all(SPAN_COLUMNS.map((name) => wired
        ? readSlice(name, spanOffset, spanCount)
        : Promise.resolve(Buffer.alloc(0)))),
      Promise.all(EVENT_COLUMNS.map((name) => wired
        ? readSlice(name, eventOffset, eventCount)
        : Promise.resolve(Buffer.alloc(0)))),
    ]);
    const spanBuffers = new Map(SPAN_COLUMNS.map((name, i) => [name as string, spanData[i]]));
    const eventBuffers = new Map(EVENT_COLUMNS.map((name, i) => [name as string, eventData[i]]));

    const enumAt = (list: string[] | undefined, code: number, fallback: string): string =>
      list?.[code] ?? fallback;
    const cellRef = (id: number): number | null => id === NONE_CELL ? null : id;

    const spans: DayCellSpan[] = Array.from({ length: wired ? spanCount : 0 }, (_, i) => {
      const rsrp = from(spanBuffers, "span.rsrp", i);
      return {
        subscriber: from(spanBuffers, "span.subscriber", i),
        cell: cellRef(from(spanBuffers, "span.cell", i)),
        start: from(spanBuffers, "span.start", i),
        end: from(spanBuffers, "span.end", i),
        // NaN is an unattached stretch: nothing served the handset, so there
        // was no signal to average.
        rsrp: Number.isNaN(rsrp) ? null : rsrp,
        exposure: enumAt(meta.enums.exposure, from(spanBuffers, "span.exposure", i), "outdoor"),
        connected: from(spanBuffers, "span.connected", i),
      } satisfies DayCellSpan;
    });

    const events: DayNetEvent[] = Array.from({ length: wired ? eventCount : 0 }, (_, i) => ({
      subscriber: from(eventBuffers, "event.subscriber", i),
      minute: from(eventBuffers, "event.minute", i),
      kind: enumAt(meta.enums.eventKind, from(eventBuffers, "event.kind", i), "unknown"),
      cell: cellRef(from(eventBuffers, "event.cell", i)),
      previous: cellRef(from(eventBuffers, "event.previous", i)),
      cause: enumAt(meta.enums.eventCause, from(eventBuffers, "event.cause", i), "unknown"),
    } satisfies DayNetEvent));

    // Both lookups are resolved out of the file's own static tables — see
    // `readSubscribers` and `readCells` — so a browser never has to fetch
    // devices.json or towers.json to name a number or a mast.
    const subscribers = await readSubscribers(reader, [
      ...spans.map((span) => span.subscriber),
      ...events.map((event) => event.subscriber),
    ]);
    const cells = await readCells(reader, [
      ...spans.map((span) => span.cell),
      ...events.flatMap((event) => [event.cell, event.previous]),
    ].filter((index): index is number => index !== null));

    return {
      date: meta.date,
      person,
      initDigest: meta.initDigest,
      schedule,
      legs,
      transactions,
      banked: meta.counts.banked === 1,
      radio: {
        networked: meta.counts.networked === 1,
        subscribers,
        cells,
        spans,
        events,
      },
    };
  } finally {
    await reader.close();
  }
}

/**
 * The aggregate, cached against the file's own modification time.
 *
 * A full-city day carries a few hundred thousand transaction rows and the pass
 * over them is a second at most, but the spending page is one a reader flips
 * back to between people. Keyed on mtime rather than on the date, so
 * re-exporting a day invalidates it without anything having to say so.
 */
const spendingCache = new Map<string, { mtimeMs: number; summary: DaySpending }>();

export async function readDaySpending(date: string): Promise<DaySpending | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const info = await stat(path);
  const cached = spendingCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.summary;

  const { meta, dataStart } = await readMeta(path);
  const columns = new Map(meta.columns.map((column) => [column.name, column]));
  const empty: DaySpending = {
    date: meta.date, banked: false, persons: meta.counts.persons, transactions: 0,
    payers: 0, payments: 0, withdrawals: 0, declined: 0, spent: 0, withdrawn: 0,
    medianTicket: 0, cashShare: 0, categories: [], instruments: [], declines: [],
    tickets: [], hours: [], merchants: [], mccs: [], spenders: [],
  };
  if (!columns.has("tx.minute")) return empty;

  const names = await loadMccLabels();
  const handle = await open(path, "r");
  try {
    const whole = async (name: string): Promise<Buffer> => {
      const column = columns.get(name)!;
      const buffer = Buffer.alloc(column.byteLength);
      await handle.read(buffer, 0, buffer.length, dataStart + column.byteOffset);
      return buffer;
    };
    const read = async (name: string) => {
      const column = columns.get(name)!;
      const buffer = await whole(name);
      return (index: number) => value(buffer, column.type, index);
    };

    const rows = columns.get("tx.minute")!.count;
    const [
      minute, amount, kind, reason, approved, decline, instrument, mcc, merchant,
      personId, txOffset, txCount,
    ] = await Promise.all([
      read("tx.minute"), read("tx.amount"), read("tx.kind"), read("tx.reason"),
      read("tx.approved"), read("tx.decline"), read("tx.instrument"),
      read("tx.mcc"), read("tx.merchant"),
      read("person.id"), read("person.txOffset"), read("person.txCount"),
    ]);
    const name = (id: number): string | null => id === NONE ? null : (meta.strings[id] ?? null);

    const kinds = meta.enums.txKind ?? [];
    const reasons = meta.enums.reason ?? [];
    const instruments = meta.enums.instrument ?? [];
    const declineNames = meta.enums.decline ?? [];

    const byReason = new Map<string, number[]>();
    const byInstrument = new Map<string, number>();
    const byDecline = new Map<string, number>();
    const byMerchant = new Map<string, { count: number; total: number }>();
    const byMcc = new Map<number, { count: number; total: number }>();
    const hours: SpendHour[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, total: 0 }));
    const tickets: SpendBand[] = TICKET_BANDS.map(([, , label]) => ({ label, value: 0 }));
    const approvedTickets: number[] = [];
    let payments = 0;
    let withdrawals = 0;
    let declined = 0;
    let spent = 0;
    let withdrawn = 0;
    let cash = 0;

    for (let row = 0; row < rows; row += 1) {
      const paid = amount(row);
      const what = kinds[kind(row)] ?? "payment";
      const ok = approved(row) === 1;

      if (!ok) {
        declined += 1;
        const why = declineNames[decline(row)] ?? "unknown";
        byDecline.set(why, (byDecline.get(why) ?? 0) + 1);
        continue;
      }

      // A withdrawal is not spending. The money changes which of the person's
      // own two pockets it sits in, and counting it as a purchase would book
      // every cash payment twice — once at the machine and once at the till.
      if (what === "withdrawal") {
        withdrawals += 1;
        withdrawn += paid;
        continue;
      }

      // Nor is a payday, nor a payment onto a card. Wages are money arriving,
      // and a card payment settles purchases this file already counted at the
      // till weeks ago — booking either as spending would put the city's
      // outgoings above its income by the size of its income.
      if (what === "transfer_in" || what === "card_payment") continue;

      payments += 1;
      spent += paid;
      approvedTickets.push(paid);

      const how = instruments[instrument(row)] ?? "unknown";
      byInstrument.set(how, (byInstrument.get(how) ?? 0) + 1);
      if (how === "cash") cash += 1;

      const category = reasons[reason(row)] ?? "unknown";
      const amounts = byReason.get(category);
      if (amounts) amounts.push(paid);
      else byReason.set(category, [paid]);

      // A stop the planner pushed past midnight settles at minute 1,455, and a
      // sleep-adjacent one can settle before zero. Both are this day's money
      // and belong to the hour they read as on a clock.
      const hour = ((Math.floor(minute(row) / 60) % 24) + 24) % 24;
      hours[hour].count += 1;
      hours[hour].total += paid;

      const band = TICKET_BANDS.findIndex(([low, high]) => paid >= low && paid < high);
      if (band !== -1) tickets[band].value += 1;

      const shop = name(merchant(row)) ?? "unnamed";
      const seen = byMerchant.get(shop);
      if (seen) { seen.count += 1; seen.total += paid; }
      else byMerchant.set(shop, { count: 1, total: paid });

      const code = mcc(row);
      if (code !== 0) {
        const known = byMcc.get(code);
        if (known) { known.count += 1; known.total += paid; }
        else byMcc.set(code, { count: 1, total: paid });
      }
    }

    // Who spent it, from the person table's own offsets rather than from a
    // person column on the rows: the offsets are already there, and a column
    // repeating the id on every transaction would be the largest one in the
    // file for a fact the table's shape already carries.
    const spenders: SpendPerson[] = [];

    let payers = 0;
    for (let row = 0; row < meta.counts.persons; row += 1) {
      const count = txCount(row);
      if (count === 0) continue;
      payers += 1;
      const start = txOffset(row);
      let total = 0;
      let paid = 0;
      for (let index = start; index < start + count; index += 1) {
        if (approved(index) !== 1) continue;
        if (!SPENDING.has(kinds[kind(index)] ?? "payment")) continue;
        total += amount(index);
        paid += 1;
      }
      if (paid > 0) spenders.push({ person: personId(row), count: paid, total });
    }
    spenders.sort((a, b) => b.total - a.total);

    const categories: SpendCategory[] = [...byReason]
      .map(([category, amounts]) => ({
        reason: category,
        count: amounts.length,
        total: amounts.reduce((sum, value) => sum + value, 0),
        median: median([...amounts]),
        share: 0,
      }))
      .sort((a, b) => b.total - a.total);
    for (const category of categories) category.share = spent > 0 ? category.total / spent : 0;

    const summary: DaySpending = {
      date: meta.date,
      banked: meta.counts.banked === 1,
      persons: meta.counts.persons,
      transactions: rows,
      payers,
      payments,
      withdrawals,
      declined,
      spent,
      withdrawn,
      medianTicket: median(approvedTickets),
      cashShare: payments > 0 ? cash / payments : 0,
      categories,
      instruments: [...byInstrument]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
      declines: [...byDecline]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
      tickets,
      hours,
      merchants: [...byMerchant]
        .map(([shop, row]) => ({ merchant: shop, ...row }))
        .sort((a, b) => b.total - a.total)
        .slice(0, TOP),
      mccs: [...byMcc]
        .map(([code, row]) => ({ mcc: code, label: names.get(code) ?? null, ...row }))
        .sort((a, b) => b.total - a.total)
        .slice(0, TOP),
      spenders: spenders.slice(0, TOP),
    };
    spendingCache.set(path, { mtimeMs: info.mtimeMs, summary });
    return summary;
  } finally {
    await handle.close();
  }
}

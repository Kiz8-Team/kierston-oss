import { recordId } from "./id.ts";
import type { KdayMeta, NumericColumn } from "./kday.ts";
import { atSecond, signedU32 } from "./time.ts";

const NONE = 0xffffffff;
const NONE_CELL = -1;
const NONE_I32 = 0x7fffffff;

export interface DaySource {
  meta: KdayMeta;
  has(name: string): boolean;
  column(name: string): Promise<NumericColumn>;
  string(id: number): string | null;
  enum(group: string, id: number): string | null;
}

function required(value: string | null, field: string, row: number): string {
  if (value === null) throw new Error(`${field} is absent at row ${row}`);
  return value;
}

function sameLength(columns: Record<string, NumericColumn>): number {
  const entries = Object.entries(columns);
  const length = entries[0]?.[1].length ?? 0;
  for (const [name, values] of entries) {
    if (values.length !== length) throw new Error(`${name} has ${values.length} rows; expected ${length}`);
  }
  return length;
}

async function columns(source: DaySource, names: readonly string[]): Promise<Record<string, NumericColumn>> {
  const pairs = await Promise.all(names.map(async (name) => [name, await source.column(name)] as const));
  return Object.fromEntries(pairs);
}

const value = (bag: Record<string, NumericColumn>, name: string, row: number): number => bag[name]![row]!;

/** Row indices an extractor visits: every row of a table, or a caller's
 * ascending subset (a scenario delta names only the rows it touched). */
export type RowSelection = ArrayLike<number> | undefined;
const rowAt = (rows: RowSelection, k: number): number => rows ? rows[k]! : k;
const rowCount = (rows: RowSelection, total: number): number => rows ? rows.length : total;
const cell = (cgis: readonly string[], index: number): string | null =>
  index === NONE_CELL || index === NONE ? null : (cgis[index] ?? null);
const subscriber = (imsis: readonly string[], index: number): string | null =>
  index === NONE_CELL || index === NONE ? null : (imsis[index] ?? null);
const coordinate = (raw: number): number | null => raw === NONE_I32 ? null : raw / 1e6;
const money = (raw: number): number | null => Number.isNaN(raw) ? null : Math.round(raw * 100) / 100;

export async function cameraIds(source: DaySource): Promise<string[]> {
  if (!source.has("camera.id")) return [];
  const ids = await source.column("camera.id");
  const out: string[] = [];
  for (let row = 0; row < ids.length; row += 1) {
    out.push(required(source.string(ids[row]!), "camera.id", row));
  }
  return out;
}

export interface AlprReadRow {
  read_id: string;
  camera_id: string;
  observed_at: Date;
  plate_text: string;
  normalized_plate: string;
  confidence: number;
  lighting: string | null;
}

export async function alprReads(
  source: DaySource, digest: string, timeZone: string, cameraIds: readonly string[], rows?: RowSelection,
): Promise<AlprReadRow[]> {
  if (!source.has("alprObservation.detectedText")) return [];
  const bag = await columns(source, [
    "alprObservation.camera", "alprObservation.second", "alprObservation.detectedText",
    "alprObservation.canonicalText", "alprObservation.confidence", "alprObservation.lighting",
  ]);
  const out: AlprReadRow[] = [];
  const total = sameLength(bag);
  for (let k = 0; k < rowCount(rows, total); k += 1) {
    const row = rowAt(rows, k);
    const detected = source.string(value(bag, "alprObservation.detectedText", row));
    if (detected === null) continue;
    const cameraId = cameraIds[value(bag, "alprObservation.camera", row)];
    if (!cameraId) throw new Error(`ALPR observation ${row} references an unknown camera`);
    out.push({
      read_id: recordId(digest, "alpr_reads", row),
      camera_id: cameraId,
      observed_at: atSecond(source.meta.date, signedU32(value(bag, "alprObservation.second", row)), timeZone),
      plate_text: detected,
      normalized_plate: source.string(value(bag, "alprObservation.canonicalText", row))
        ?? detected.toUpperCase().replaceAll(/[^A-Z0-9]/g, ""),
      confidence: value(bag, "alprObservation.confidence", row),
      lighting: source.enum("lighting", value(bag, "alprObservation.lighting", row)),
    });
  }
  return out;
}

export interface CellReference {
  cgi: string;
  tracking_area: number;
}

export async function cellReferences(source: DaySource): Promise<CellReference[]> {
  if (!source.has("cell.cgi")) return [];
  const bag = await columns(source, ["cell.cgi", "cell.trackingArea"]);
  const out: CellReference[] = [];
  for (let row = 0; row < sameLength(bag); row += 1) {
    out.push({
      cgi: required(source.string(value(bag, "cell.cgi", row)), "cell.cgi", row),
      tracking_area: value(bag, "cell.trackingArea", row),
    });
  }
  return out;
}

export async function subscriberImsis(source: DaySource): Promise<string[]> {
  if (!source.has("subscriber.imsi")) return [];
  const ids = await source.column("subscriber.imsi");
  const out: string[] = [];
  for (let row = 0; row < ids.length; row += 1) {
    out.push(required(source.string(ids[row]!), "subscriber.imsi", row));
  }
  return out;
}

export async function subscriberImeis(source: DaySource): Promise<string[]> {
  if (!source.has("subscriber.imei")) return [];
  const ids = await source.column("subscriber.imei");
  const out: string[] = [];
  for (let row = 0; row < ids.length; row += 1) {
    out.push(required(source.string(ids[row]!), "subscriber.imei", row));
  }
  return out;
}

export interface NetworkEventRow {
  event_id: string;
  imsi: string;
  imei: string | null;
  occurred_at: Date;
  event_type: string;
  cell_cgi: string | null;
  previous_cell_cgi: string | null;
  tracking_area: number | null;
  /** Timing advance the cell commanded, in 78 m steps; null on a file without it or with no cell. */
  timing_advance: number | null;
  /** The carrier added under a connected handset, or null while idle. */
  secondary_cell_cgi: string | null;
}

export async function networkEvents(
  source: DaySource, digest: string, timeZone: string,
  imsis: readonly string[], imeis: readonly string[], sites: readonly CellReference[], rows?: RowSelection,
): Promise<NetworkEventRow[]> {
  if (!source.has("event.subscriber")) return [];
  // KDAY v16 measures these; an older file has neither and its rows say so.
  const measured = source.has("event.ta") && source.has("event.secondary");
  const bag = await columns(source, [
    "event.subscriber", "event.minute", "event.kind", "event.cell", "event.previous", "event.cause",
    ...(measured ? ["event.ta", "event.secondary"] : []),
  ]);
  const cgis = sites.map((site) => site.cgi);
  const out: NetworkEventRow[] = [];
  const total = sameLength(bag);
  for (let k = 0; k < rowCount(rows, total); k += 1) {
    const row = rowAt(rows, k);
    const kind = source.enum("eventKind", value(bag, "event.kind", row));
    const cause = source.enum("eventCause", value(bag, "event.cause", row));
    // Idle cell reselection and the midnight boundary are simulation state,
    // not carrier records.
    if (kind === "reselect" || cause === "day-start") continue;
    if (kind === null) throw new Error(`event.kind is absent at row ${row}`);
    const imsi = subscriber(imsis, value(bag, "event.subscriber", row));
    if (!imsi) throw new Error(`network event ${row} references an unknown subscriber`);
    const cellIndex = value(bag, "event.cell", row);
    const current = cell(cgis, cellIndex);
    const tau = kind === "tau";
    const ta = measured ? signedU32(value(bag, "event.ta", row)) : -1;
    out.push({
      event_id: recordId(digest, "network_events", row),
      imsi,
      imei: subscriber(imeis, value(bag, "event.subscriber", row)),
      occurred_at: atSecond(source.meta.date, value(bag, "event.minute", row) * 60, timeZone),
      event_type: kind,
      cell_cgi: tau ? null : current,
      previous_cell_cgi: tau ? null : cell(cgis, value(bag, "event.previous", row)),
      tracking_area: tau && cellIndex >= 0 ? (sites[cellIndex]?.tracking_area ?? null) : null,
      // A tracking-area update is signalling like any other: the cell that
      // took it measured the handset, so the distance is kept even though the
      // cell itself is withheld above.
      timing_advance: ta >= 0 && cellIndex >= 0 ? ta : null,
      secondary_cell_cgi: measured ? cell(cgis, signedU32(value(bag, "event.secondary", row))) : null,
    });
  }
  return out;
}

export interface SmsRow {
  sms_record_id: string;
  originating_imsi: string;
  originating_imei: string | null;
  destination_imsi: string | null;
  destination_imei: string | null;
  submitted_at: Date;
  originating_cell_cgi: string | null;
  destination_cell_cgi: string | null;
  multimedia: boolean;
  segment_number: number;
  segment_count: number;
  delivered_at: Date | null;
}

export async function smsRecords(
  source: DaySource, digest: string, timeZone: string,
  imsis: readonly string[], imeis: readonly string[], cgis: readonly string[], rows?: RowSelection,
): Promise<SmsRow[]> {
  if (!source.has("sms.message")) return [];
  const bag = await columns(source, [
    "sms.message", "sms.from", "sms.to", "sms.cell", "sms.toCell", "sms.part", "sms.parts",
    "sms.delivered", "message.at", "message.channel",
  ]);
  const count = source.meta.columns.find((column) => column.name === "sms.message")!.count;
  const out: SmsRow[] = [];
  for (let k = 0; k < rowCount(rows, count); k += 1) {
    const row = rowAt(rows, k);
    const message = value(bag, "sms.message", row);
    const from = subscriber(imsis, value(bag, "sms.from", row));
    if (!from) throw new Error(`SMS record ${row} references an unknown originating subscriber`);
    // The send's own channel. A pair spills to their secondary, so the thread
    // this belongs to is often not a carrier one and cannot answer this.
    const channel = source.enum("channel", value(bag, "message.channel", message));
    if (channel !== "sms" && channel !== "mms") {
      throw new Error(`SMS record ${row} references a non-carrier-message channel`);
    }
    const delivered = value(bag, "sms.delivered", row);
    out.push({
      sms_record_id: recordId(digest, "sms_records", row),
      originating_imsi: from,
      originating_imei: subscriber(imeis, value(bag, "sms.from", row)),
      destination_imsi: subscriber(imsis, value(bag, "sms.to", row)),
      destination_imei: subscriber(imeis, value(bag, "sms.to", row)),
      submitted_at: atSecond(source.meta.date, value(bag, "message.at", message), timeZone),
      originating_cell_cgi: cell(cgis, value(bag, "sms.cell", row)),
      destination_cell_cgi: cell(cgis, value(bag, "sms.toCell", row)),
      multimedia: channel === "mms",
      segment_number: value(bag, "sms.part", row) + 1,
      segment_count: value(bag, "sms.parts", row),
      delivered_at: delivered < 0 ? null : atSecond(source.meta.date, delivered, timeZone),
    });
  }
  return out;
}

export interface CallRow {
  call_record_id: string;
  originating_imsi: string;
  originating_imei: string | null;
  destination_imsi: string | null;
  destination_imei: string | null;
  setup_at: Date;
  outcome: string;
  ring_seconds: number;
  duration_seconds: number;
  origin_cell_cgi: string | null;
  end_cell_cgi: string | null;
  destination_origin_cell_cgi: string | null;
  destination_end_cell_cgi: string | null;
}

export interface HandoverRow {
  call_record_id: string;
  sequence: number;
  occurred_at: Date;
  cell_cgi: string | null;
}

export async function callRecords(
  source: DaySource, digest: string, timeZone: string,
  imsis: readonly string[], imeis: readonly string[], cgis: readonly string[], rows?: RowSelection,
): Promise<{ calls: CallRow[]; handovers: HandoverRow[] }> {
  if (!source.has("cdr.call")) return { calls: [], handovers: [] };
  const bag = await columns(source, [
    "cdr.call", "cdr.from", "cdr.to", "cdr.originCell", "cdr.endCell",
    "cdr.toOriginCell", "cdr.toEndCell",
    "cdr.handoverAt", "cdr.handoverCount", "handover.second", "handover.cell",
    "call.at", "call.outcome", "call.ring", "call.duration",
  ]);
  const count = source.meta.columns.find((column) => column.name === "cdr.call")!.count;
  const calls: CallRow[] = [];
  const handovers: HandoverRow[] = [];
  for (let k = 0; k < rowCount(rows, count); k += 1) {
    const row = rowAt(rows, k);
    const call = value(bag, "cdr.call", row);
    const from = subscriber(imsis, value(bag, "cdr.from", row));
    if (!from) throw new Error(`call record ${row} references an unknown originating subscriber`);
    const id = recordId(digest, "call_records", row);
    calls.push({
      call_record_id: id,
      originating_imsi: from,
      originating_imei: subscriber(imeis, value(bag, "cdr.from", row)),
      destination_imsi: subscriber(imsis, value(bag, "cdr.to", row)),
      destination_imei: subscriber(imeis, value(bag, "cdr.to", row)),
      setup_at: atSecond(source.meta.date, value(bag, "call.at", call), timeZone),
      outcome: required(source.enum("callOutcome", value(bag, "call.outcome", call)), "call.outcome", call),
      ring_seconds: value(bag, "call.ring", call),
      duration_seconds: value(bag, "call.duration", call),
      origin_cell_cgi: cell(cgis, value(bag, "cdr.originCell", row)),
      end_cell_cgi: cell(cgis, value(bag, "cdr.endCell", row)),
      destination_origin_cell_cgi: cell(cgis, value(bag, "cdr.toOriginCell", row)),
      destination_end_cell_cgi: cell(cgis, value(bag, "cdr.toEndCell", row)),
    });
    const start = value(bag, "cdr.handoverAt", row);
    const handoverCount = value(bag, "cdr.handoverCount", row);
    for (let sequence = 0; sequence < handoverCount; sequence += 1) {
      const index = start + sequence;
      handovers.push({
        call_record_id: id,
        sequence,
        occurred_at: atSecond(source.meta.date, value(bag, "handover.second", index), timeZone),
        cell_cgi: cell(cgis, value(bag, "handover.cell", index)),
      });
    }
  }
  return { calls, handovers };
}

export interface BankTransactionRow {
  /** Import-only KDAY normalization. Never written to a provider table. */
  _person_id: number | null;
  transaction_id: string;
  occurred_at: Date;
  amount: number;
  transaction_type: string;
  approved: boolean;
  decline_code: string | null;
  instrument: string | null;
  mcc: number | null;
  merchant: string | null;
  account_number: string | null;
  card_last_four: string | null;
  card_network: string | null;
  balance_after: number | null;
  merchant_latitude: number | null;
  merchant_longitude: number | null;
}

export async function bankTransactions(
  source: DaySource, digest: string, timeZone: string, rows?: RowSelection,
): Promise<BankTransactionRow[]> {
  if (!source.has("tx.minute")) return [];
  const bag = await columns(source, [
    "tx.minute", "tx.amount", "tx.kind", "tx.approved", "tx.decline", "tx.instrument",
    "tx.mcc", "tx.merchant", "tx.account", "tx.card", "tx.network", "tx.balanceAfter",
    "tx.latE6", "tx.lonE6",
    ...(source.has("tx.person") ? ["tx.person"] : []),
  ]);
  const out: BankTransactionRow[] = [];
  const total = sameLength(bag);
  for (let k = 0; k < rowCount(rows, total); k += 1) {
    const row = rowAt(rows, k);
    const kind = source.enum("txKind", value(bag, "tx.kind", row));
    const instrument = source.enum("instrument", value(bag, "tx.instrument", row));
    const account = source.string(value(bag, "tx.account", row));
    const card = source.string(value(bag, "tx.card", row));
    // A cash purchase and an attempted payment with no account or card are
    // personal-day truth, not a bank or processor record. ATM withdrawals do
    // remain bank records even though cash is the resulting instrument.
    if ((instrument === "cash" && kind !== "withdrawal") || (!account && !card && kind !== "withdrawal")) continue;
    if (!kind) throw new Error(`tx.kind is absent at row ${row}`);
    const amount = money(value(bag, "tx.amount", row));
    if (amount === null) throw new Error(`tx.amount is absent at row ${row}`);
    out.push({
      _person_id: source.has("tx.person") ? value(bag, "tx.person", row) : null,
      transaction_id: recordId(digest, "bank_transactions", row),
      occurred_at: atSecond(source.meta.date, value(bag, "tx.minute", row) * 60, timeZone),
      amount,
      transaction_type: kind,
      approved: value(bag, "tx.approved", row) === 1,
      decline_code: source.enum("decline", value(bag, "tx.decline", row)),
      instrument,
      mcc: value(bag, "tx.mcc", row) === 0 ? null : value(bag, "tx.mcc", row),
      merchant: source.string(value(bag, "tx.merchant", row)),
      account_number: account,
      card_last_four: card,
      card_network: source.string(value(bag, "tx.network", row)),
      balance_after: money(value(bag, "tx.balanceAfter", row)),
      merchant_latitude: coordinate(value(bag, "tx.latE6", row)),
      merchant_longitude: coordinate(value(bag, "tx.lonE6", row)),
    });
  }
  return out;
}

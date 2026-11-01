/**
 * The records an agent would read about one resident's handsets, rebuilt
 * from the day file, and the location estimate made from them.
 *
 * The rows are shaped the way fastgate imports them (`packages/provider-rows/src/extract.ts`)
 * so the estimate works from what the bench actually serves: idle reselections
 * and the midnight boundary are dropped, a tracking-area update keeps its TA
 * and tracking area but loses its cell, SMS rows carry the sender's cell at
 * submission and the recipient's at delivery, and call rows carry origin and
 * end cells for both parties with the originator's handovers between them.
 * Duplicate SMS segments collapse to one reading.
 *
 * Ground truth is the resident's own position from their legs. A phone the
 * sim left behind would be somewhere else; base days do not do that.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildTimeline, positionAt } from "@/lib/day-timeline";
import {
  Estimator, estimateHandset, statsFromRows, statsTable, STAT_KEYS,
  type CellularEstimate, type ErrorRow, type HandsetEstimate, type LatLon, type Observation,
  type PosteriorCells, type SampleResult, type SiteCell,
} from "@/lib/cellular";
import { readPersonDayAt, type PersonDay } from "./day";
import { dayPath, openDay, personRow, typed, value, type Reader } from "./kday";
import { roots } from "./repo";

/** Grid for one resident, and the coarser one a citywide sample can afford. */
const STEP_M = 100;
const SAMPLE_STEP_M = 200;
const GRID_EVERY = 15;

// ---- The public cell-site table ---------------------------------------------

interface TowerCellRecord {
  cgi: string;
  structure: string;
  operator_key: string;
  radio: string;
  band: string;
  role: string;
  sector: number;
  tracking_area: number;
  lat: number;
  lon: number;
  azimuth: number;
  beamwidth: number;
  height_m: number;
  range_m: number;
  morphology: string;
}

let towers: { path: string; mtimeMs: number; cells: SiteCell[]; estimators: Map<number, Estimator> } | null = null;

async function estimatorFor(step: number): Promise<Estimator> {
  const path = join((await roots()).sim, "towers.json");
  const info = await stat(path);
  if (!towers || towers.path !== path || towers.mtimeMs !== info.mtimeMs) {
    const file = JSON.parse(await readFile(path, "utf8")) as { cell_records: TowerCellRecord[] };
    const cells = file.cell_records.map((record): SiteCell => ({
      cgi: record.cgi, structure: record.structure, operator: record.operator_key,
      radio: record.radio, band: record.band, role: record.role, sector: record.sector,
      trackingArea: record.tracking_area, lat: record.lat, lon: record.lon,
      azimuth: record.azimuth, beamwidth: record.beamwidth, heightM: record.height_m,
      rangeM: record.range_m, morphology: record.morphology,
    }));
    towers = { path, mtimeMs: info.mtimeMs, cells, estimators: new Map() };
  }
  let estimator = towers.estimators.get(step);
  if (!estimator) {
    estimator = new Estimator(towers.cells, step);
    towers.estimators.set(step, estimator);
  }
  return estimator;
}

// ---- Per-file lookups -------------------------------------------------------

interface FileTables {
  mtimeMs: number;
  cgis: (string | null)[];
  smsFrom: Int32Array | null;
  smsTo: Int32Array | null;
  cdrFrom: Int32Array | null;
  cdrTo: Int32Array | null;
}

const tableCache = new Map<string, FileTables>();

/**
 * The cell-id strings and the two party columns of the SMS and CDR tables.
 * Whole columns, once per file: a resident's messages are found by scanning
 * two million integers, which is quicker than any index worth keeping.
 */
async function tablesFor(reader: Reader, path: string): Promise<FileTables> {
  const { mtimeMs } = await stat(path);
  const cached = tableCache.get(path);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const column = async (name: string) =>
    (reader.has(name) ? (await typed(reader, name)) as Int32Array : null);
  const cellIds = reader.has("cell.cgi") ? await typed(reader, "cell.cgi") : new Uint32Array(0);
  const tables: FileTables = {
    mtimeMs,
    cgis: Array.from(cellIds, (id) => reader.string(id)),
    smsFrom: await column("sms.from"),
    smsTo: await column("sms.to"),
    cdrFrom: await column("cdr.from"),
    cdrTo: await column("cdr.to"),
  };
  tableCache.set(path, tables);
  return tables;
}

// ---- One resident's records -------------------------------------------------

interface ResidentRecords {
  day: PersonDay;
  records: Map<number, Observation[]>;
}

async function recordsOf(path: string, person: number, estimator: Estimator): Promise<ResidentRecords | null> {
  const day = await readPersonDayAt(path, person);
  if (!day) return null;
  const reader = await openDay(path);
  try {
    const tables = await tablesFor(reader, path);
    const cgi = (index: number | null) => (index === null || index < 0 ? null : tables.cgis[index] ?? null);
    const one = async (name: string, row: number) =>
      value(await reader.slice(name, row, 1), reader.spec(name).type, 0);

    const records = new Map<number, Observation[]>();
    const seen = new Set<string>();
    let id = 0;
    const add = (subscriber: number, record: Omit<Observation, "id">) => {
      if (record.cell === null && record.ta === null && record.secondary === null) return;
      const key = `${subscriber}|${record.table}|${record.kind}|${record.second}|${record.cell}`;
      if (seen.has(key)) return;
      seen.add(key);
      const list = records.get(subscriber) ?? [];
      list.push({ ...record, id: id++ });
      records.set(subscriber, list);
    };

    // Network events, with the two v16 columns the day reader does not carry.
    const row = await personRow(reader, person);
    const measured = reader.has("event.ta") && reader.has("event.secondary") && row >= 0;
    const [offset, count] = measured
      ? await Promise.all([reader.scalar("person.eventOffset", row), reader.scalar("person.eventCount", row)])
      : [0, 0];
    const [taColumn, secondaryColumn] = measured
      ? await Promise.all([reader.slice("event.ta", offset, count), reader.slice("event.secondary", offset, count)])
      : [null, null];
    day.radio.events.forEach((event, i) => {
      if (event.kind === "reselect" || event.cause === "day-start") return;
      const ta = taColumn ? value(taColumn, "i32", i) : -1;
      const secondary = secondaryColumn ? value(secondaryColumn, "i32", i) : -1;
      const tau = event.kind === "tau";
      const serving = cgi(event.cell);
      add(event.subscriber, {
        second: event.minute * 60,
        table: "network_events",
        kind: event.kind,
        cell: tau ? null : serving,
        previous: tau ? null : cgi(event.previous),
        secondary: cgi(secondary),
        ta: ta >= 0 && event.cell !== null ? ta : null,
        trackingArea: tau ? (estimator.cell(serving)?.trackingArea ?? null) : null,
      });
    });

    const mine = new Set(day.radio.subscribers.map((subscriber) => subscriber.index));
    const bare = { previous: null, secondary: null, ta: null, trackingArea: null };

    if (tables.smsFrom && tables.smsTo && mine.size) {
      for (let r = 0; r < tables.smsFrom.length; r += 1) {
        const from = tables.smsFrom[r]!;
        const to = tables.smsTo[r]!;
        if (!mine.has(from) && !mine.has(to)) continue;
        const [cell, toCell, message, delivered] = await Promise.all([
          one("sms.cell", r), one("sms.toCell", r), one("sms.message", r), one("sms.delivered", r),
        ]);
        if (mine.has(from)) {
          add(from, { ...bare, second: await one("message.at", message), table: "sms_records", kind: "sms", cell: cgi(cell) });
        }
        if (mine.has(to) && delivered >= 0) {
          add(to, { ...bare, second: delivered, table: "sms_records", kind: "sms", cell: cgi(toCell) });
        }
      }
    }

    if (tables.cdrFrom && tables.cdrTo && mine.size) {
      for (let r = 0; r < tables.cdrFrom.length; r += 1) {
        const from = tables.cdrFrom[r]!;
        const to = tables.cdrTo[r]!;
        if (!mine.has(from) && !mine.has(to)) continue;
        const [call, originCell, endCell, toOriginCell, toEndCell, handoverAt, handoverCount] = await Promise.all([
          one("cdr.call", r), one("cdr.originCell", r), one("cdr.endCell", r),
          one("cdr.toOriginCell", r), one("cdr.toEndCell", r), one("cdr.handoverAt", r), one("cdr.handoverCount", r),
        ]);
        const [at, ring, duration] = await Promise.all([one("call.at", call), one("call.ring", call), one("call.duration", call)]);
        const end = at + ring + duration;
        if (mine.has(from)) {
          add(from, { ...bare, second: at, table: "call_records", kind: "call", cell: cgi(originCell) });
          if (end > at) add(from, { ...bare, second: end, table: "call_records", kind: "call", cell: cgi(endCell) });
          for (let k = 0; k < handoverCount; k += 1) {
            const [second, cell] = await Promise.all([one("handover.second", handoverAt + k), one("handover.cell", handoverAt + k)]);
            add(from, { ...bare, second, table: "call_handovers", kind: "call handover", cell: cgi(cell) });
          }
        }
        if (mine.has(to)) {
          add(to, { ...bare, second: at, table: "call_records", kind: "call", cell: cgi(toOriginCell) });
          if (end > at) add(to, { ...bare, second: end, table: "call_records", kind: "call", cell: cgi(toEndCell) });
        }
      }
    }
    return { day, records };
  } finally {
    await reader.close();
  }
}

function truthOf(day: PersonDay): (second: number) => LatLon | null {
  if (!day.legs.length) return () => null;
  const segments = buildTimeline(day);
  return (second) => {
    const position = positionAt(segments, day.legs, Math.min(1439.99, second / 60));
    return position ? { lat: position.lat, lon: position.lon } : null;
  };
}

// ---- The estimate, cached ---------------------------------------------------

interface Cached {
  key: string;
  estimate: CellularEstimate;
  runs: { operator: string; observations: Observation[]; minutes: number[]; posteriors: Float32Array[] }[];
}

/** Two residents' posteriors are ~60 MB; more than that is a leak on a dev box. */
const cache: Cached[] = [];

async function cachedEstimate(date: string, person: number): Promise<Cached | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const { mtimeMs } = await stat(path);
  const key = `${path}|${mtimeMs}|${person}`;
  const hit = cache.find((entry) => entry.key === key);
  if (hit) return hit;

  const estimator = await estimatorFor(STEP_M);
  const resident = await recordsOf(path, person, estimator);
  if (!resident) return null;
  const truthAt = truthOf(resident.day);

  const referenced = new Map<string, SiteCell>();
  const handsets: HandsetEstimate[] = [];
  const runs: Cached["runs"] = [];
  for (const subscriber of resident.day.radio.subscribers) {
    const observations = resident.records.get(subscriber.index) ?? [];
    for (const record of observations) {
      for (const cgi of [record.cell, record.previous, record.secondary]) {
        const cell = estimator.cell(cgi);
        if (cell) referenced.set(cell.cgi, cell);
      }
    }
    const run = estimateHandset(estimator, observations, subscriber.operator, truthAt, { gridEvery: GRID_EVERY, keep: true });
    handsets.push({
      subscriber: subscriber.index, imsi: subscriber.imsi, msisdn: subscriber.msisdn,
      carrier: subscriber.carrier, operator: subscriber.operator,
      observations: run.observations, track: run.track, stats: statsTable(run.rows),
    });
    runs.push({
      operator: subscriber.operator, observations,
      minutes: run.track.map((point) => point.minute), posteriors: run.posteriors ?? [],
    });
  }

  const entry: Cached = {
    key,
    runs,
    estimate: {
      date: resident.day.date,
      person,
      grid: estimator.grid,
      cells: Object.fromEntries(referenced),
      legs: resident.day.legs.map((leg) => ({
        depart: leg.depart, arrive: leg.arrive, path: leg.path,
        from: { lat: leg.from.lat, lon: leg.from.lon }, to: { lat: leg.to.lat, lon: leg.to.lon },
      })),
      handsets,
    },
  };
  cache.unshift(entry);
  cache.length = Math.min(cache.length, 2);
  return entry;
}

export async function readCellularEstimate(date: string, person: number): Promise<CellularEstimate | null> {
  return (await cachedEstimate(date, person))?.estimate ?? null;
}

/** The 95% region behind one fused step or one record. */
export async function readPosterior(
  date: string, person: number, handset: number,
  target: { mode: "track"; minute: number } | { mode: "record"; id: number },
): Promise<PosteriorCells | null> {
  const entry = await cachedEstimate(date, person);
  const run = entry?.runs[handset];
  if (!run) return null;
  const estimator = await estimatorFor(STEP_M);

  if (target.mode === "track") {
    if (!run.minutes.length) return null;
    let best = 0;
    for (let t = 0; t < run.minutes.length; t += 1) {
      if (Math.abs(run.minutes[t]! - target.minute) < Math.abs(run.minutes[best]! - target.minute)) best = t;
    }
    const posterior = run.posteriors[best];
    return posterior ? { minute: run.minutes[best]!, ...estimator.region(posterior) } : null;
  }

  const record = run.observations.find((one) => one.id === target.id);
  const likelihood = record ? estimator.likelihood(record, run.operator) : null;
  if (!record || !likelihood) return null;
  return { minute: record.second / 60, ...estimator.region(estimator.normalise(likelihood)) };
}

/** A resident with a handset and somewhere to be, for the random button. */
export async function randomPhonePerson(date: string): Promise<number | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const reader = await openDay(path);
  try {
    if (!reader.has("person.eventCount")) return null;
    const total = reader.meta.counts.persons;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = Math.floor(Math.random() * total);
      const [events, legs] = await Promise.all([
        reader.scalar("person.eventCount", row), reader.scalar("person.legCount", row),
      ]);
      if (events > 0 && legs > 0) return reader.scalar("person.id", row);
    }
    return null;
  } finally {
    await reader.close();
  }
}

/**
 * The same accuracy table over a random sample of residents with a phone and
 * a day that moves, on a coarser grid. This is the number that says how fine
 * the evidence is for the bench as a whole rather than for one person.
 */
export async function sampleCellular(date: string, people: number): Promise<SampleResult | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const estimator = await estimatorFor(SAMPLE_STEP_M);
  const rows: Record<string, ErrorRow[]> = {};
  let done = 0, handsets = 0, records = 0;
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < people * 4 && done < people && Date.now() < deadline; attempt += 1) {
    const person = await randomPhonePerson(date);
    if (person === null) break;
    const resident = await recordsOf(path, person, estimator);
    if (!resident || !resident.day.legs.length) continue;
    const truthAt = truthOf(resident.day);
    let counted = false;
    for (const subscriber of resident.day.radio.subscribers) {
      const observations = resident.records.get(subscriber.index) ?? [];
      if (!observations.length) continue;
      const run = estimateHandset(estimator, observations, subscriber.operator, truthAt, { gridEvery: GRID_EVERY, keep: false });
      for (const [key, list] of Object.entries(run.rows)) (rows[key] ??= []).push(...list);
      handsets += 1;
      records += observations.length;
      counted = true;
    }
    if (counted) done += 1;
  }
  return {
    date,
    people: done,
    handsets,
    records,
    stats: STAT_KEYS.filter((key) => rows[key]?.length).map((key) => statsFromRows(key, rows[key]!)),
  };
}

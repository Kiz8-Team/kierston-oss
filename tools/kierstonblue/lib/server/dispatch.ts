/**
 * Calls for service, read out of the KDAY incident and response tables.
 *
 * One incident is one 911 call: who rang, where their day had them, what the
 * call-taker made of it and how many units of each service it asked for. A
 * response is one vehicle sent to it, with the minutes it was dispatched,
 * arrived, cleared and — for an ambulance — reached and left a hospital.
 *
 * Minutes are in the dispatch frame, not the calendar one: the sim owns a
 * dispatch day from 07:00 to 07:00 the next morning so every watch belongs to
 * one date, which means a column here runs 420..1859 and anything at or past
 * 1440 happened after midnight. The vehicle span table stops at 24:00, so a
 * unit's drive to a call after midnight is not in this file at all.
 *
 * `incident.call` is a row in the day's call table, or -1 where the caller had
 * no voice line, was already unreachable, or rang after midnight — the comms
 * layer only resolves calls inside the calendar day.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NONE, dayPath, openDay, value, type Reader } from "./kday";
import { roots } from "./repo";
import { readVehicleDay, type VehicleMovement, type VehicleSpan } from "./vehicles";

export interface IncidentCall {
  /** Second of the day the call was placed. */
  at: number;
  ring: number;
  duration: number;
  outcome: string;
}

export interface IncidentPlace {
  id: string;
  label: string;
  lat: number;
  lon: number;
}

export interface IncidentUnit {
  /** Row in the file's response table. */
  row: number;
  service: string;
  vin: string;
  person: number;
  partner: number | null;
  dispatched: number;
  arrived: number;
  cleared: number;
  hospital: IncidentPlace | null;
  hospitalArrived: number | null;
  hospitalLeft: number | null;
  /** Back at the station or fire house; police units rejoin their beat instead. */
  returned: number | null;
}

export interface IncidentRow {
  index: number;
  kind: string;
  priority: number;
  placeClass: string;
  place: string | null;
  /** A name for the place, where the id is one the POI table knows. */
  placeLabel: string | null;
  lat: number;
  lon: number;
  received: number;
  caller: number;
  requested: { police: number; ems: number };
  dispatched: number | null;
  firstOnScene: number | null;
  cleared: number | null;
  /** How long the caller stays at the scene, served or not. */
  callerUntil: number;
  disposition: string;
  call: IncidentCall | null;
  units: IncidentUnit[];
}

export interface DispatchIndex {
  date: string;
  /** False for a file exported before the dispatch tables existed. */
  dispatched: boolean;
  incidents: IncidentRow[];
}

/** One responding vehicle's day, cut to the minutes around its run. */
export interface UnitTrack {
  vin: string;
  serviceClass: string;
  spans: VehicleSpan[];
  movements: VehicleMovement[];
}

export interface IncidentDetail {
  date: string;
  /** Incidents in the file, so the page can step to the neighbours. */
  total: number;
  incident: IncidentRow;
  tracks: UnitTrack[];
}

const INCIDENT_COLUMNS = [
  "incident.kind", "incident.priority", "incident.latE6", "incident.lonE6",
  "incident.place", "incident.placeClass", "incident.receivedMinute", "incident.caller",
  "incident.policeUnits", "incident.emsUnits", "incident.dispatchedMinute",
  "incident.firstOnSceneMinute", "incident.clearedMinute", "incident.callerUntilMinute",
  "incident.disposition", "incident.call",
] as const;

const RESPONSE_COLUMNS = [
  "response.incident", "response.service", "response.vehicle", "response.person",
  "response.partner", "response.dispatchedMinute", "response.arrivedMinute",
  "response.clearedMinute", "response.hospital", "response.hospitalArrivedMinute",
  "response.hospitalLeftMinute", "response.returnedMinute",
] as const;

const orNull = (minute: number) => (minute < 0 ? null : minute);

/**
 * `poi/<n>` is a row of pois.json, which is how the sim names hospitals and
 * the venues it builds from the POI layer. Read once per file change; the
 * whole table is half a megabyte.
 */
let poiCache: { path: string; mtimeMs: number; points: [number, number, number, number, string][] } | null = null;

async function poiTable() {
  const path = join((await roots()).sim, "pois.json");
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  if (poiCache?.path === path && poiCache.mtimeMs === info.mtimeMs) return poiCache.points;
  const data = JSON.parse(await readFile(path, "utf8")) as { points: [number, number, number, number, string][] };
  poiCache = { path, mtimeMs: info.mtimeMs, points: data.points };
  return data.points;
}

function poiOf(points: Awaited<ReturnType<typeof poiTable>>, id: string | null): IncidentPlace | null {
  const match = id ? /^poi\/(\d+)$/.exec(id) : null;
  const point = match && points ? points[Number(match[1])] : undefined;
  return point ? { id: id!, label: point[4], lat: point[0], lon: point[1] } : null;
}

const indexCache = new Map<string, { mtimeMs: number; index: DispatchIndex }>();

export async function readDispatchIndex(date: string): Promise<DispatchIndex | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const info = await stat(path);
  const cached = indexCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.index;

  const reader = await openDay(path);
  try {
    const index = await buildIndex(reader);
    indexCache.set(path, { mtimeMs: info.mtimeMs, index });
    return index;
  } finally {
    await reader.close();
  }
}

async function buildIndex(reader: Reader): Promise<DispatchIndex> {
  const { meta } = reader;
  if (!reader.has("incident.kind")) return { date: meta.date, dispatched: false, incidents: [] };

  const columns = [...INCIDENT_COLUMNS, ...RESPONSE_COLUMNS];
  const data = await Promise.all(columns.map((name) => reader.whole(name)));
  const buffers = new Map(columns.map((name, i) => [name as string, data[i]!]));
  const at = (name: string, row: number) => value(buffers.get(name)!, reader.spec(name).type, row);
  const points = await poiTable().catch(() => null);
  const enums = meta.enums as Record<string, string[] | undefined>;
  const enumAt = (list: string, code: number) => enums[list]?.[code] ?? "unknown";

  const units = new Map<number, IncidentUnit[]>();
  const responses = reader.spec("response.incident").count;
  for (let row = 0; row < responses; row += 1) {
    const hospital = at("response.hospital", row);
    const partner = at("response.partner", row);
    const unit: IncidentUnit = {
      row,
      service: enumAt("service", at("response.service", row)),
      vin: reader.string(at("response.vehicle", row)) ?? "",
      person: at("response.person", row),
      partner: partner < 0 ? null : partner,
      dispatched: at("response.dispatchedMinute", row),
      arrived: at("response.arrivedMinute", row),
      cleared: at("response.clearedMinute", row),
      hospital: hospital === NONE ? null : poiOf(points, reader.string(hospital)),
      hospitalArrived: orNull(at("response.hospitalArrivedMinute", row)),
      hospitalLeft: orNull(at("response.hospitalLeftMinute", row)),
      returned: orNull(at("response.returnedMinute", row)),
    };
    const incident = at("response.incident", row);
    const mine = units.get(incident) ?? [];
    mine.push(unit);
    units.set(incident, mine);
  }

  const incidents: IncidentRow[] = [];
  const count = reader.spec("incident.kind").count;
  const callRows: number[] = [];
  for (let row = 0; row < count; row += 1) callRows.push(at("incident.call", row));
  const calls = await readCalls(reader, callRows);

  for (let row = 0; row < count; row += 1) {
    const placeId = reader.string(at("incident.place", row));
    incidents.push({
      index: row,
      kind: enumAt("incidentKind", at("incident.kind", row)),
      priority: at("incident.priority", row),
      placeClass: enumAt("incidentPlaceClass", at("incident.placeClass", row)),
      place: placeId,
      placeLabel: poiOf(points, placeId)?.label ?? null,
      lat: at("incident.latE6", row) / 1e6,
      lon: at("incident.lonE6", row) / 1e6,
      received: at("incident.receivedMinute", row),
      caller: at("incident.caller", row),
      requested: { police: at("incident.policeUnits", row), ems: at("incident.emsUnits", row) },
      dispatched: orNull(at("incident.dispatchedMinute", row)),
      firstOnScene: orNull(at("incident.firstOnSceneMinute", row)),
      cleared: orNull(at("incident.clearedMinute", row)),
      callerUntil: at("incident.callerUntilMinute", row),
      disposition: enumAt("disposition", at("incident.disposition", row)),
      call: calls.get(callRows[row]!) ?? null,
      units: (units.get(row) ?? []).sort((a, b) => a.dispatched - b.dispatched || a.row - b.row),
    });
  }
  return { date: meta.date, dispatched: true, incidents };
}

/** The handful of call rows the incidents point at, one seek each. */
async function readCalls(reader: Reader, rows: number[]): Promise<Map<number, IncidentCall>> {
  const out = new Map<number, IncidentCall>();
  if (!reader.has("call.at")) return out;
  const read = async (name: string, row: number) =>
    value(await reader.slice(name, row, 1), reader.spec(name).type, 0);
  await Promise.all(rows.filter((row) => row >= 0).map(async (row) => {
    const [at, ring, duration, outcome] = await Promise.all([
      read("call.at", row), read("call.ring", row), read("call.duration", row), read("call.outcome", row),
    ]);
    out.set(row, { at, ring, duration, outcome: reader.meta.enums.callOutcome?.[outcome] ?? "unknown" });
  }));
  return out;
}

/** Minutes either side of a run that its vehicle track keeps. */
const TRACK_MARGIN = 30;

/**
 * One incident, with every responding vehicle's own day cut to the run.
 *
 * The tracks are read from the vehicle span table rather than rebuilt from
 * the response minutes, so the map shows the drive the planner actually
 * produced: if a patrol car's route to the scene disagrees with its dispatch
 * time, that is a sim bug worth seeing.
 */
export async function readIncident(date: string, index: number): Promise<IncidentDetail | null> {
  const catalogue = await readDispatchIndex(date);
  const incident = catalogue?.incidents[index];
  if (!catalogue || !incident) return null;

  const tracks = await Promise.all(incident.units.map(async (unit): Promise<UnitTrack | null> => {
    const day = await readVehicleDay(date, unit.vin).catch(() => null);
    if (!day) return null;
    const from = (unit.dispatched - TRACK_MARGIN) * 60;
    const until = (Math.max(unit.cleared, unit.returned ?? 0, unit.hospitalLeft ?? 0) + TRACK_MARGIN) * 60;
    return {
      vin: unit.vin,
      serviceClass: day.serviceClass,
      spans: day.spans.filter((span) => span.end > from && span.start < until),
      movements: day.movements.filter((movement) => movement.end > from && movement.start < until),
    };
  }));
  return {
    date: catalogue.date,
    total: catalogue.incidents.length,
    incident,
    tracks: tracks.filter((track): track is UnitTrack => track !== null),
  };
}

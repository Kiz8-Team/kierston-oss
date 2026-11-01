/**
 * The day's plate reads, out of the KDAY surveillance tables.
 *
 * Two tables and not one, and the whole value of this page is in the gap
 * between them. `alprTruth` is every physical passage over a camera's directed
 * edge — what actually drove past. `alprObservation` is what the sensor made
 * of that passage, including the rows where it made nothing: a vehicle it
 * failed to capture, a plate it could not resolve, a plate it resolved
 * wrongly. A real camera's log holds only the second table, and holds it
 * without knowing which of its rows are wrong. Here both are on one line, so a
 * reader can see the error rather than infer it.
 *
 * The exporter writes the two tables from one loop, so row `n` of the truth
 * table and row `n` of the observation table are the same passage and share a
 * correlation id. That id is instrumentation and nothing the camera perceived;
 * it is carried through to the viewer for the same reason it exists at all,
 * which is that somebody has to be able to check the join.
 *
 * Passes are sorted by camera and then by time, so one camera's day is a
 * contiguous run of rows. The index below records where each run starts, which
 * is what lets a camera's page be a couple of slices rather than a pass over
 * every read in the city. Contiguity is verified rather than assumed — if a
 * future exporter sorts differently, the detail reader falls back to a scan
 * instead of quietly showing somebody else's traffic.
 */

import { stat } from "node:fs/promises";
import { readPlateRegistry } from "./plates";
import {
  NONE, dayPath, legOwners, openDay, personOfLeg, typed, value,
  type AlprModel, type Reader,
} from "./kday";

/** A camera as the day file holds it, with what it saw that day attached. */
export interface CameraDayRow {
  /** Row in the file's camera table — what a truth row points at. */
  index: number;
  /** The siting id, `ALPR-023`. The same id `cameras.json` uses. */
  id: string;
  /** Graph edge it watches, directed. */
  edge: number;
  /** Which plate the lens faces: rear or front. */
  side: string;
  lat: number;
  lon: number;
  role: string;
  owner: string;
  /** Physical passages over its edge. */
  passes: number;
  /** Passages it produced any text for, right or wrong. */
  reads: number;
  /** Passages by what the sensor made of them, keyed by outcome name. */
  outcomes: Record<string, number>;
  /** How the traffic split between residents and vehicles from outside. */
  resident: number;
  external: number;
  /** Where this camera's run of rows starts, and whether it is one run. */
  offset: number;
  contiguous: boolean;
}

export interface CameraDayIndex {
  date: string;
  version: number;
  /** 1 where a fleet was sited at all — an empty list otherwise means empty. */
  surveilled: boolean;
  cameras: CameraDayRow[];
  model: AlprModel | null;
}

/** One passage, as the road saw it and as the camera did. */
export interface CameraRead {
  /** Row in the day's paired truth and observation tables. */
  row: number;
  /** The audit key both tables share. Not something the camera perceived. */
  correlation: string;
  /** Second of the day the vehicle was in the capture zone. */
  second: number;
  /** The plate the lens faced on this vehicle. */
  side: string;

  /** What was physically there, or null where that side carried no plate. */
  plate: string | null;
  jurisdiction: string | null;
  /** Whether `movement` indexes a resident leg or an external trip. */
  source: string;
  movement: number;

  /** What the sensor produced, or null where it produced nothing. */
  detected: string | null;
  /** The same text normalised, which is what a matcher would key on. */
  canonical: string | null;
  confidence: number;
  outcome: string;
  lighting: string;
  /** Seconds to the nearest vehicle at this camera; null where alone. */
  headway: number | null;
  /** Seconds the vehicle spent inside the capture zone. */
  dwell: number;

  /**
   * Whether the plate that passed was one somebody chose rather than one the
   * state issued in sequence. Only a resident plate can be: the register is
   * what says so, and nothing from outside the city is on it.
   */
  personalized: boolean;
  /** The resident who was driving, where this was a resident leg. */
  person: number | null;
  /**
   * The registered vehicle that made the pass, from version 12 onward.
   *
   * Null for traffic from outside, which is on no register here, and null in
   * a file written before the legs named a VIN.
   */
  vin: string | null;
  /** The vehicle from outside, where it was not. No local record exists. */
  vehicle: ExternalVehicleRow | null;
  trip: { kind: string; depart: number; arrive: number } | null;
}

/** A vehicle that is not on the city's register, from the day's own table. */
export interface ExternalVehicleRow {
  index: number;
  /** The sim's key for it, stable across the dates it returns on. */
  id: string;
  /** worker, delivery, repeat_visitor, or a one-off — see traffic/external. */
  kind: string;
  state: string;
  plate: string;
  make: string | null;
  model: string | null;
  body: string | null;
  colour: string | null;
  modelYear: number;
}

export interface CameraDay {
  date: string;
  camera: CameraDayRow;
  reads: CameraRead[];
  model: AlprModel | null;
}

/**
 * A pass's second, which is not always inside the day.
 *
 * `alprTruth.second` is a u32 column that the exporter writes signed values
 * into: a leg can depart before midnight — the file carries `leg.depart` down
 * to −150 minutes — and a vehicle crossing a camera on such a leg gets a
 * negative second, which wraps. 321 of this city's 377,395 passes are in that
 * state. Reinterpreting the top of the range as negative is exact rather than
 * a guess: no real pass is 68 years into the day, and the wrap is the only way
 * a value that large can arise. Passes after midnight need no repair — they
 * are honest seconds past 86,400 — but they are the same fact and the viewer
 * renders both as the day they belong to.
 */
const signedSecond = (value: number) => (value >= 0x80000000 ? value - 0x100000000 : value);

const CAMERA_COLUMNS = [
  "camera.id", "camera.edge", "camera.side", "camera.latE6", "camera.lonE6",
  "camera.role", "camera.owner",
] as const;

const TRUTH_COLUMNS = [
  "alprTruth.correlationId", "alprTruth.second", "alprTruth.leg",
  "alprTruth.source", "alprTruth.movement", "alprTruth.side",
  "alprTruth.plate", "alprTruth.jurisdiction",
] as const;

const OBSERVATION_COLUMNS = [
  "alprObservation.detectedText", "alprObservation.canonicalText",
  "alprObservation.confidence", "alprObservation.outcome",
  "alprObservation.lighting", "alprObservation.headwaySeconds",
  "alprObservation.dwellSeconds",
] as const;

const VEHICLE_COLUMNS = [
  "externalVehicle.id", "externalVehicle.kind", "externalVehicle.state",
  "externalVehicle.plate", "externalVehicle.make", "externalVehicle.model",
  "externalVehicle.body", "externalVehicle.colour", "externalVehicle.modelYear",
] as const;

/**
 * The index, cached against the file's own modification time.
 *
 * One pass over four columns of the truth and observation tables, which is a
 * few million rows against a file of hundreds of millions. It is done once per
 * file rather than once per camera because every camera's page wants the same
 * tallies, and because the offsets it records are what make a camera's own
 * rows reachable without a second pass.
 */
const indexCache = new Map<string, { mtimeMs: number; index: CameraDayIndex }>();

export async function readCameraIndex(date: string): Promise<CameraDayIndex | null> {
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

async function buildIndex(reader: Reader): Promise<CameraDayIndex> {
  const { meta } = reader;
  const outcomes = meta.enums.alprOutcome ?? [];
  const sources = meta.enums.alprMovementSource ?? ["resident", "external"];
  const empty: CameraDayIndex = {
    date: meta.date,
    version: meta.version,
    surveilled: meta.counts.surveilled === 1,
    cameras: [],
    model: meta.alprModel ?? null,
  };
  // No column at all means a file written before version 8, which had no
  // cameras in it. Present and empty means a city with no sited fleet, which
  // `surveilled` is what distinguishes.
  if (!reader.has("camera.id")) return empty;
  const total = reader.spec("camera.id").count;
  if (!total) return empty;

  const data = await Promise.all(CAMERA_COLUMNS.map((name) => reader.whole(name)));
  const buffers = new Map(CAMERA_COLUMNS.map((name, i) => [name as string, data[i]!]));
  const at = (name: string, row: number) => value(buffers.get(name)!, reader.spec(name).type, row);

  const cameras: CameraDayRow[] = Array.from({ length: total }, (_, index) => ({
    index,
    id: reader.string(at("camera.id", index)) ?? `camera ${index}`,
    edge: at("camera.edge", index),
    side: meta.enums.plateSide?.[at("camera.side", index)] ?? "rear",
    lat: at("camera.latE6", index) / 1e6,
    lon: at("camera.lonE6", index) / 1e6,
    role: reader.string(at("camera.role", index)) ?? "unknown",
    owner: reader.string(at("camera.owner", index)) ?? "unknown",
    passes: 0,
    reads: 0,
    outcomes: Object.fromEntries(outcomes.map((name) => [name, 0])),
    resident: 0,
    external: 0,
    offset: 0,
    contiguous: true,
  }));

  if (!reader.has("alprTruth.camera") || !reader.spec("alprTruth.camera").count) {
    return { ...empty, cameras };
  }

  const [truthCamera, truthSource, outcome, detected] = await Promise.all([
    typed(reader, "alprTruth.camera"),
    typed(reader, "alprTruth.source"),
    typed(reader, "alprObservation.outcome"),
    typed(reader, "alprObservation.detectedText"),
  ]);

  const last = new Int32Array(total).fill(-1);
  for (let row = 0; row < truthCamera.length; row += 1) {
    const camera = cameras[truthCamera[row]!];
    if (!camera) continue;
    // The first row of a camera's run is where its page starts reading; a
    // later row that does not follow the previous one means the file is not
    // sorted the way this reader expects, and the detail falls back to a scan.
    if (camera.passes === 0) camera.offset = row;
    else if (last[camera.index] !== row - 1) camera.contiguous = false;
    last[camera.index] = row;

    camera.passes += 1;
    if (detected[row] !== NONE) camera.reads += 1;
    const name = outcomes[outcome[row]!];
    if (name !== undefined) camera.outcomes[name] = (camera.outcomes[name] ?? 0) + 1;
    if (sources[truthSource[row]!] === "external") camera.external += 1;
    else camera.resident += 1;
  }

  return { ...empty, cameras };
}

/** The rows of the truth table belonging to one camera. */
async function rowsFor(reader: Reader, camera: CameraDayRow): Promise<number[]> {
  if (camera.contiguous) {
    return Array.from({ length: camera.passes }, (_, i) => camera.offset + i);
  }
  const truthCamera = await typed(reader, "alprTruth.camera");
  const out: number[] = [];
  for (let row = 0; row < truthCamera.length; row += 1) {
    if (truthCamera[row] === camera.index) out.push(row);
  }
  return out;
}

/**
 * One camera's day: every passage over its edge, with what it made of each.
 *
 * The two joins that make a read usable are done here rather than left to the
 * browser. A resident passage is resolved to the person driving, because the
 * leg id it carries is meaningless anywhere else in the app. An external
 * passage is resolved to the vehicle from the day's own external table,
 * because there is no other record of it anywhere — that is what external
 * means, and a page that only said "external" would be hiding the fact that
 * the file knows exactly which lorry it was.
 */
export async function readCameraDay(date: string, id: string): Promise<CameraDay | null> {
  const path = await dayPath(date);
  const index = await readCameraIndex(date);
  if (!path || !index) return null;
  const camera = index.cameras.find((row) => row.id === id);
  if (!camera) return null;

  const info = await stat(path);
  const reader = await openDay(path);
  try {
    const rows = await rowsFor(reader, camera);
    if (!rows.length) return { date: index.date, camera, reads: [], model: index.model };

    const start = rows[0]!;
    const span = rows[rows.length - 1]! - start + 1;
    const columns = [...TRUTH_COLUMNS, ...OBSERVATION_COLUMNS];
    const data = await Promise.all(columns.map((name) => reader.slice(name, start, span)));
    const buffers = new Map(columns.map((name, i) => [name as string, data[i]!]));
    const at = (name: string, row: number) =>
      value(buffers.get(name)!, reader.spec(name).type, row - start);

    const sources = reader.meta.enums.alprMovementSource ?? ["resident", "external"];
    const outcomes = reader.meta.enums.alprOutcome ?? [];
    const lightings = reader.meta.enums.lighting ?? [];
    const sides = reader.meta.enums.plateSide ?? ["rear", "front"];

    const owners = rows.some((row) => sources[at("alprTruth.source", row)!] !== "external")
      ? await legOwners(reader, path, info.mtimeMs)
      : null;
    // Whether a plate was paid for is a fact of the vehicle register rather
    // than of the day file, so it is joined in here — see `plates.ts`.
    const { personalized } = await readPlateRegistry();
    // Version 12 names the car on the leg itself, which is a far better answer
    // than the plate: it is the key the vehicle's own day is filed under.
    const legVehicle = reader.has("leg.vehicle") ? await typed(reader, "leg.vehicle") : null;
    const trips = await externalTrips(reader, rows.filter(
      (row) => sources[at("alprTruth.source", row)!] === "external",
    ).map((row) => at("alprTruth.movement", row)));

    const reads = rows.map((row) => {
      const source = sources[at("alprTruth.source", row)] ?? "resident";
      const movement = at("alprTruth.movement", row);
      const leg = at("alprTruth.leg", row);
      const headway = at("alprObservation.headwaySeconds", row);
      const trip = source === "external" ? trips.get(movement) ?? null : null;
      const plate = reader.string(at("alprTruth.plate", row));
      return {
        row,
        correlation: reader.string(at("alprTruth.correlationId", row)) ?? `row ${row}`,
        second: signedSecond(at("alprTruth.second", row)),
        side: sides[at("alprTruth.side", row)] ?? camera.side,
        plate,
        jurisdiction: reader.string(at("alprTruth.jurisdiction", row)),
        source,
        movement,
        detected: reader.string(at("alprObservation.detectedText", row)),
        canonical: reader.string(at("alprObservation.canonicalText", row)),
        confidence: at("alprObservation.confidence", row),
        outcome: outcomes[at("alprObservation.outcome", row)] ?? "unknown",
        lighting: lightings[at("alprObservation.lighting", row)] ?? "day",
        // A vehicle with nothing near it has an infinite headway, which JSON
        // cannot carry and a reader should not see as a number anyway.
        headway: Number.isFinite(headway) ? headway : null,
        dwell: at("alprObservation.dwellSeconds", row),
        personalized: source !== "external" && plate !== null && personalized.has(plate),
        person: owners && leg !== NONE ? personOfLeg(owners, leg) : null,
        vin: legVehicle && leg !== NONE && legVehicle[leg] !== undefined
          ? reader.string(legVehicle[leg]!)
          : null,
        vehicle: trip?.vehicle ?? null,
        trip: trip ? { kind: trip.kind, depart: trip.depart, arrive: trip.arrive } : null,
      } satisfies CameraRead;
    });

    return { date: index.date, camera, reads, model: index.model };
  } finally {
    await reader.close();
  }
}

interface TripDetail {
  kind: string;
  depart: number;
  arrive: number;
  vehicle: ExternalVehicleRow | null;
}

/**
 * The external trips behind a set of trip indices, with their vehicles.
 *
 * The trip table is read whole because it is tens of thousands of rows and a
 * camera can touch hundreds of them; the vehicle rows are seeked one at a time
 * because a day's traffic past one camera is a few hundred distinct vehicles
 * out of forty thousand.
 */
async function externalTrips(
  reader: Reader, wanted: number[],
): Promise<Map<number, TripDetail>> {
  const out = new Map<number, TripDetail>();
  if (!wanted.length || !reader.has("externalTrip.vehicle")) return out;

  const [vehicleOf, kind, depart, arrive] = await Promise.all([
    typed(reader, "externalTrip.vehicle"),
    typed(reader, "externalTrip.kind"),
    typed(reader, "externalTrip.departSecond"),
    typed(reader, "externalTrip.arriveSecond"),
  ]);
  const kinds = reader.meta.enums.externalTripKind ?? [];
  const vehicleKinds = reader.meta.enums.externalVehicleKind ?? [];

  const trips = [...new Set(wanted)].filter((trip) => trip < vehicleOf.length);
  const vehicles = new Map<number, ExternalVehicleRow | null>();
  // Read whole rather than seeked per vehicle. A busy arterial sees eight
  // thousand vehicles from outside in a day, and nine seeks each is sixty
  // thousand reads against nine columns that are a megabyte in total.
  const present = reader.has("externalVehicle.plate")
    ? reader.spec("externalVehicle.plate").count : 0;
  if (present) {
    const fields = await Promise.all(VEHICLE_COLUMNS.map((name) => reader.whole(name)));
    const held = new Map(VEHICLE_COLUMNS.map((name, i) => [name as string, fields[i]!]));
    const cell = (name: string, row: number) =>
      value(held.get(name)!, reader.spec(name).type, row);
    for (const index of new Set(trips.map((trip) => vehicleOf[trip]!))) {
      if (index >= present) { vehicles.set(index, null); continue; }
      vehicles.set(index, {
        index,
        id: reader.string(cell("externalVehicle.id", index)) ?? `external ${index}`,
        kind: vehicleKinds[cell("externalVehicle.kind", index)] ?? "unknown",
        state: reader.string(cell("externalVehicle.state", index)) ?? "unknown",
        plate: reader.string(cell("externalVehicle.plate", index)) ?? "",
        make: reader.string(cell("externalVehicle.make", index)),
        model: reader.string(cell("externalVehicle.model", index)),
        body: reader.string(cell("externalVehicle.body", index)),
        colour: reader.string(cell("externalVehicle.colour", index)),
        modelYear: cell("externalVehicle.modelYear", index),
      });
    }
  }

  for (const trip of trips) {
    out.set(trip, {
      kind: kinds[kind[trip]!] ?? "unknown",
      depart: depart[trip]!,
      arrive: arrive[trip]!,
      vehicle: vehicles.get(vehicleOf[trip]!) ?? null,
    });
  }
  return out;
}

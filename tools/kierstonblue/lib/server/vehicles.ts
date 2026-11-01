/**
 * Every registered vehicle's own day, out of the version 12 KDAY.
 *
 * The person tables answer "where was this resident"; these two answer "where
 * was this car", which is not the same question and cannot be derived from the
 * first. A household's second car sits at a kerb all day while its keeper
 * takes the bus, a cab keeps moving while three drivers pass through it, and
 * neither shows up in anybody's leg list as a vehicle at all.
 *
 * The file states it directly: one row per VIN, and under it a gapless run of
 * spans from 00:00:00 to 24:00:00, each either parked at a point or moving
 * along a leg. Nothing here reconstructs that — the span table is the record,
 * and this module reads it, joins each moving span back to the leg and the
 * resident behind it, and adds up what the joins imply.
 *
 * Version 11 and earlier have none of it. Every entry point says so with
 * `tracked: false` rather than by failing, because a day without vehicle
 * timelines is still a readable day.
 */

import { stat } from "node:fs/promises";
import {
  NONE, dayMtime, dayPath, legOwners, openDay, personOfLeg, typed, value,
  type LegOwners, type Reader,
} from "./kday";

/** Seconds in the date a vehicle day covers. The span table always fills it. */
export const VEHICLE_DAY_SECONDS = 86_400;

/**
 * The register for one date, as columns rather than as rows.
 *
 * Sixty thousand vehicles written as objects is fifteen megabytes of repeated
 * key names for four megabytes of facts, and the browser filters over the
 * whole register on every keystroke. Columns are what the file holds and what
 * the table reads, so nothing is rebuilt on either side of the wire: `lib/
 * vehicles.ts` reads a row out of them by index when a detail pane needs one.
 *
 * `metres` is integer, `-1` stands for absent throughout, and the enum codes
 * index `serviceClasses` and `ownerTypes` beside them.
 */
export interface VehicleColumns {
  count: number;
  vin: string[];
  owner: number[];
  ownerType: number[];
  /** -1 for a vehicle registered to an organization rather than a home. */
  household: number[];
  serviceClass: number[];
  moves: number[];
  movingSeconds: number[];
  /**
   * Metres over the legs the vehicle carried, so a leg still under way at
   * midnight contributes its whole distance to the date it started in.
   */
  metres: number[];
  /** Second of the day it first and last moved, or -1 if it never did. */
  firstMove: number[];
  lastMove: number[];
  /** How many residents were at the wheel: one for a car, several for a cab. */
  drivers: number[];
  /** The first of them, which is the only one for almost every private car. */
  driver: number[];
}

export interface VehicleDayIndex {
  date: string;
  version: number;
  /** False for a file older than version 12, which carries no vehicle table. */
  tracked: boolean;
  serviceClasses: string[];
  ownerTypes: string[];
  totals: {
    vehicles: number;
    moved: number;
    movements: number;
    kilometres: number;
    /** Vehicle-hours spent in motion, over the whole register. */
    movingHours: number;
    /** Legs in the day that name a vehicle, against every leg in it. */
    vehicleLegs: number;
    legs: number;
  };
  vehicles: VehicleColumns;
}

/** One stretch of a vehicle's day: parked at a point, or moving along a leg. */
export interface VehicleSpan {
  start: number;
  end: number;
  moving: boolean;
  lat: number;
  lon: number;
  /** Row in the day's leg table for a moving span, else null. */
  leg: number | null;
}

/**
 * Somebody carried by a movement who was not driving it.
 *
 * A passenger's own leg says they were driven and where to; it does not name
 * the car. Two things can tie one to a vehicle, and which of them did it is
 * kept on the row rather than averaged away:
 *
 * `journey` — the rider's leg and the driver's leg carry the same journey,
 * which is the scheduler saying they are one movement. This is a record, not
 * an inference: a lift arranged for a gathering, a school escort, a cab fare
 * whose driver was dispatched against that very journey.
 *
 * `nearby` — no shared journey, but a leg that starts and ends within 150 m of
 * this one and overlaps it in time. That is a strong coincidence and usually
 * the right car, and it is still an inference. `alone` on the passenger says
 * no other vehicle could have carried them; without it, more than one could,
 * and the pairing is a suggestion.
 */
export interface VehiclePassenger {
  person: number;
  mode: string;
  purpose: string;
  /** The rider's own leg, in minutes — it can be wider than the drive. */
  depart: number;
  arrive: number;
  match: "journey" | "nearby";
  alone: boolean;
}

/** A moving span with the leg it was, resolved. */
export interface VehicleMovement {
  leg: number;
  start: number;
  end: number;
  /** The resident whose leg it is — the driver, or the cabbie on shift. */
  person: number | null;
  mode: string;
  purpose: string;
  from: { lat: number; lon: number; label: string | null };
  to: { lat: number; lon: number; label: string | null };
  kilometres: number;
  path: [number, number][];
  /** Everybody else aboard, by the join described on `VehiclePassenger`. */
  passengers: VehiclePassenger[];
}

export interface VehicleDay {
  date: string;
  vin: string;
  owner: number;
  ownerType: string;
  household: number | null;
  serviceClass: string;
  spans: VehicleSpan[];
  movements: VehicleMovement[];
  kilometres: number;
  movingSeconds: number;
  /** Everyone who drove it today, in the order they first took it out. */
  drivers: number[];
}

const VEHICLE_COLUMNS = [
  "vehicle.vin", "vehicle.owner", "vehicle.ownerType", "vehicle.household",
  "vehicle.serviceClass", "vehicle.spanOffset", "vehicle.spanCount",
] as const;

const indexCache = new Map<string, { mtimeMs: number; index: VehicleDayIndex }>();

/**
 * The whole register for one date, cached against the file's own mtime.
 *
 * One pass over the span table — a few hundred thousand rows against a file of
 * hundreds of millions — because every question the page asks is a tally over
 * the same spans, and the browser filters and sorts the result rather than
 * asking again per column.
 */
export async function readVehicleIndex(date: string): Promise<VehicleDayIndex | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const info = await stat(path);
  const cached = indexCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.index;

  const reader = await openDay(path);
  try {
    const index = await buildIndex(reader, path, info.mtimeMs);
    indexCache.set(path, { mtimeMs: info.mtimeMs, index });
    return index;
  } finally {
    await reader.close();
  }
}

async function buildIndex(
  reader: Reader, path: string, mtimeMs: number,
): Promise<VehicleDayIndex> {
  const { meta } = reader;
  const classes = meta.enums.vehicleServiceClass ?? ["none"];
  const ownerTypes = meta.enums.vehicleOwnerType ?? ["person", "organization"];
  const legs = reader.has("leg.depart") ? reader.spec("leg.depart").count : 0;
  const empty: VehicleDayIndex = {
    date: meta.date,
    version: meta.version,
    tracked: false,
    serviceClasses: classes,
    ownerTypes,
    totals: {
      vehicles: 0, moved: 0, movements: 0, kilometres: 0, movingHours: 0,
      vehicleLegs: 0, legs,
    },
    vehicles: emptyColumns(),
  };
  if (!reader.has("vehicle.vin") || !reader.spec("vehicle.vin").count) return empty;

  const [vin, owner, ownerType, household, serviceClass, spanOffset, spanCount] =
    await Promise.all(VEHICLE_COLUMNS.map((name) => typed(reader, name)));
  const [spanStart, spanEnd, spanKind, spanLeg] = await Promise.all([
    typed(reader, "vehicleSpan.startSecond"),
    typed(reader, "vehicleSpan.endSecond"),
    typed(reader, "vehicleSpan.kind"),
    typed(reader, "vehicleSpan.leg"),
  ]);
  const kilometres = await reader.whole("leg.kilometres");
  const owners = await legOwners(reader, path, mtimeMs);
  const legVehicle = reader.has("leg.vehicle") ? await typed(reader, "leg.vehicle") : null;

  const moving = (meta.enums.vehicleSpanKind ?? ["parked", "moving"]).indexOf("moving");
  const rows = emptyColumns();
  const totals = {
    vehicles: vin.length, moved: 0, movements: 0, kilometres: 0, movingHours: 0,
    vehicleLegs: 0, legs,
  };

  for (let index = 0; index < vin.length; index += 1) {
    const from = spanOffset[index]!;
    const to = from + spanCount[index]!;
    let moves = 0;
    let seconds = 0;
    let km = 0;
    let first: number | null = null;
    let last: number | null = null;
    let driver: number | null = null;
    const drivers = new Set<number>();

    for (let span = from; span < to; span += 1) {
      if (spanKind[span] !== moving) continue;
      const leg = spanLeg[span]!;
      moves += 1;
      seconds += spanEnd[span]! - spanStart[span]!;
      if (leg >= 0) km += value(kilometres, "f32", leg);
      if (first === null) first = spanStart[span]!;
      last = spanEnd[span]!;
      const person = leg >= 0 ? personOfLeg(owners, leg) : null;
      if (person !== null) {
        if (driver === null) driver = person;
        drivers.add(person);
      }
    }

    if (moves > 0) totals.moved += 1;
    totals.movements += moves;
    totals.kilometres += km;
    totals.movingHours += seconds / 3600;

    rows.count += 1;
    rows.vin.push(reader.string(vin[index]!) ?? `vehicle ${index}`);
    rows.owner.push(owner[index]!);
    rows.ownerType.push(ownerType[index]!);
    // The exporter already writes -1 for a vehicle that belongs to no
    // household, which is the same absence this column uses throughout.
    rows.household.push(household[index]!);
    rows.serviceClass.push(serviceClass[index]!);
    rows.moves.push(moves);
    rows.movingSeconds.push(seconds);
    rows.metres.push(Math.round(km * 1000));
    rows.firstMove.push(first ?? -1);
    rows.lastMove.push(last ?? -1);
    rows.drivers.push(drivers.size);
    rows.driver.push(driver ?? -1);
  }

  if (legVehicle) {
    for (let leg = 0; leg < legVehicle.length; leg += 1) {
      if (legVehicle[leg] !== NONE) totals.vehicleLegs += 1;
    }
  }

  return { ...empty, tracked: true, totals, vehicles: rows };
}

function emptyColumns(): VehicleColumns {
  return {
    count: 0, vin: [], owner: [], ownerType: [], household: [], serviceClass: [],
    moves: [], movingSeconds: [], metres: [], firstMove: [], lastMove: [],
    drivers: [], driver: [],
  };
}

/** One line of a search result: enough to recognise a vehicle, and no more. */
export interface VehicleHit {
  vin: string;
  serviceClass: string;
  household: number | null;
  moves: number;
  kilometres: number;
  driver: number | null;
  drivers: number;
}

/** How many hits a search returns before it asks for a narrower one. */
const HITS = 25;

/**
 * The vehicles a query names on one date, busiest first.
 *
 * Matched here rather than in the browser: the register is sixty thousand rows
 * and the answer is a handful, so shipping the register to filter it would be
 * four megabytes to find one car. A blank query is not "everything" — it is
 * the busiest few, which is the only ordering that puts something worth
 * opening at the top of an empty search.
 */
export async function searchVehicles(
  date: string, query: string,
): Promise<VehicleHit[] | null> {
  const index = await readVehicleIndex(date);
  if (!index) return null;
  if (!index.tracked) return [];

  const wanted = query.trim().toLowerCase();
  const asNumber = Number(wanted);
  const numeric = wanted !== "" && Number.isSafeInteger(asNumber) && asNumber >= 0;
  const columns = index.vehicles;
  const rows: number[] = [];
  for (let row = 0; row < columns.count; row += 1) {
    if (wanted && !(
      columns.vin[row]!.toLowerCase().includes(wanted)
      || (numeric && (
        columns.owner[row] === asNumber
        || columns.household[row] === asNumber
        || columns.driver[row] === asNumber
      ))
    )) continue;
    rows.push(row);
  }

  return rows
    .sort((a, b) => columns.moves[b]! - columns.moves[a]!
      || columns.metres[b]! - columns.metres[a]!
      || columns.vin[a]!.localeCompare(columns.vin[b]!))
    .slice(0, HITS)
    .map((row) => ({
      vin: columns.vin[row]!,
      serviceClass: index.serviceClasses[columns.serviceClass[row]!] ?? "none",
      household: columns.household[row]! < 0 ? null : columns.household[row]!,
      moves: columns.moves[row]!,
      kilometres: columns.metres[row]! / 1000,
      driver: columns.driver[row]! < 0 ? null : columns.driver[row]!,
      drivers: columns.drivers[row]!,
    }));
}

const MOVEMENT_COLUMNS = [
  "leg.mode", "leg.purpose", "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6",
  "leg.toLonE6", "leg.fromLabel", "leg.toLabel", "leg.kilometres",
  "leg.pathOffset", "leg.pathCount", "leg.depart", "leg.arrive", "leg.journey",
] as const;

/** Modes that mean somebody was carried rather than driving themselves. */
const CARRIED = new Set(["passenger", "taxi"]);

/** How far apart two ends of the same ride are allowed to be, in metres. */
const SAME_PLACE_METRES = 150;

/**
 * Every leg in the day made by somebody being carried, as columns.
 *
 * Twenty thousand rows out of half a million, held so that pairing one
 * vehicle's movements against them is a scan of the small table rather than of
 * the large one. Cached per file beside the leg owners, for the same reason.
 */
interface RiderLegs {
  leg: Int32Array;
  person: Int32Array;
  mode: Uint8Array;
  purpose: Uint8Array;
  depart: Int32Array;
  arrive: Int32Array;
  fromLat: Int32Array;
  fromLon: Int32Array;
  toLat: Int32Array;
  toLon: Int32Array;
  /** The journey with any segment suffix removed — see `journeyRoot`. */
  root: (string | null)[];
  /**
   * How many distinct vehicles in the day could have carried this rider on
   * geometry and time alone. One means the pairing is forced; more means the
   * day cannot say which car it was, and the page says so.
   */
  candidates: Int32Array;
}

const riderCache = new Map<string, { mtimeMs: number; riders: RiderLegs }>();

/**
 * The journey a leg belongs to, without the segment index.
 *
 * One transition can be several legs — the drive, then the walk from where the
 * car was parked — and those carry `<journey>/0`, `<journey>/1`. The rider's
 * single leg carries the unsuffixed id, so the two only meet once the suffix
 * is off. The file has no column for the root: version 12 keeps it on the
 * planner's event and packs only the leg's own id.
 */
function journeyRoot(id: string | null): string | null {
  return id === null ? null : id.replace(/\/\d+$/, "");
}

async function riderLegs(
  reader: Reader, path: string, mtimeMs: number, owners: LegOwners,
): Promise<RiderLegs> {
  const cached = riderCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.riders;

  const [mode, purpose, depart, arrive, fromLat, fromLon, toLat, toLon, journey] =
    await Promise.all([
      typed(reader, "leg.mode"), typed(reader, "leg.purpose"),
      typed(reader, "leg.depart"), typed(reader, "leg.arrive"),
      typed(reader, "leg.fromLatE6"), typed(reader, "leg.fromLonE6"),
      typed(reader, "leg.toLatE6"), typed(reader, "leg.toLonE6"),
      typed(reader, "leg.journey"),
    ]);
  const modes = reader.meta.enums.mode;
  const wanted: number[] = [];
  for (let leg = 0; leg < mode.length; leg += 1) {
    if (CARRIED.has(modes[mode[leg]!] ?? "other")) wanted.push(leg);
  }

  const pick = <T extends Int32Array | Uint8Array>(
    make: (length: number) => T, source: ArrayLike<number>,
  ): T => {
    const out = make(wanted.length);
    for (let i = 0; i < wanted.length; i += 1) out[i] = source[wanted[i]!]!;
    return out;
  };
  const int32 = (length: number) => new Int32Array(length);
  const uint8 = (length: number) => new Uint8Array(length);

  const riders: RiderLegs = {
    leg: Int32Array.from(wanted),
    person: Int32Array.from(wanted, (leg) => personOfLeg(owners, leg) ?? -1),
    mode: pick(uint8, mode),
    purpose: pick(uint8, purpose),
    depart: pick(int32, depart),
    arrive: pick(int32, arrive),
    fromLat: pick(int32, fromLat),
    fromLon: pick(int32, fromLon),
    toLat: pick(int32, toLat),
    toLon: pick(int32, toLon),
    root: wanted.map((leg) => journeyRoot(reader.string(journey[leg]!))),
    candidates: new Int32Array(wanted.length),
  };
  await countCandidates(reader, riders, { depart, arrive, fromLat, fromLon, toLat, toLon });
  riderCache.set(path, { mtimeMs, riders });
  return riders;
}

/** Grid cell of a point held as microdegrees, about 200 m on a side. */
const cellOf = (lat: number, lon: number) => `${Math.round(lat / 2000)},${Math.round(lon / 2000)}`;

/**
 * For each rider leg, how many vehicles could have been the one.
 *
 * A rider names no VIN, so the only geometric evidence is a car that left the
 * same place at the same time and arrived at the same one. Testing that
 * against every vehicle leg in the city is a hundred and sixty thousand rows
 * per rider; the legs are bucketed by where they start instead, and only the
 * cell the rider starts in and its neighbours are looked at.
 */
async function countCandidates(
  reader: Reader,
  riders: RiderLegs,
  legs: {
    depart: ArrayLike<number>; arrive: ArrayLike<number>;
    fromLat: ArrayLike<number>; fromLon: ArrayLike<number>;
    toLat: ArrayLike<number>; toLon: ArrayLike<number>;
  },
): Promise<void> {
  if (!reader.has("leg.vehicle")) return;
  const vehicle = await typed(reader, "leg.vehicle");
  const buckets = new Map<string, number[]>();
  for (let leg = 0; leg < vehicle.length; leg += 1) {
    if (vehicle[leg] === NONE) continue;
    const cell = cellOf(legs.fromLat[leg]!, legs.fromLon[leg]!);
    const mine = buckets.get(cell);
    if (mine) mine.push(leg);
    else buckets.set(cell, [leg]);
  }

  for (let i = 0; i < riders.leg.length; i += 1) {
    const vins = new Set<number>();
    const lat = Math.round(riders.fromLat[i]! / 2000);
    const lon = Math.round(riders.fromLon[i]! / 2000);
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        for (const leg of buckets.get(`${lat + dLat},${lon + dLon}`) ?? []) {
          if (legs.depart[leg]! >= riders.arrive[i]! || legs.arrive[leg]! <= riders.depart[i]!) continue;
          if (apart(legs.fromLat[leg]!, legs.fromLon[leg]!, riders.fromLat[i]!, riders.fromLon[i]!) > SAME_PLACE_METRES) continue;
          if (apart(legs.toLat[leg]!, legs.toLon[leg]!, riders.toLat[i]!, riders.toLon[i]!) > SAME_PLACE_METRES) continue;
          vins.add(vehicle[leg]!);
        }
      }
    }
    riders.candidates[i] = vins.size;
  }
}

/** Metres between two points held as microdegrees, at this city's latitude. */
function apart(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return Math.hypot((aLat - bLat) * 0.1113, (aLon - bLon) * 0.0845);
}

/**
 * One vehicle's day, spans and all.
 *
 * The index already knows which rows belong to this VIN, so the spans are one
 * slice and each movement is a handful of single-row reads against the leg
 * table plus its routed path. A cab on a full shift is under two hundred
 * spans, which is why this reads rows rather than columns.
 */
export async function readVehicleDay(date: string, vin: string): Promise<VehicleDay | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const index = await readVehicleIndex(date);
  if (!index || !index.tracked) return null;
  const row = index.vehicles.vin.indexOf(vin);
  if (row < 0) return null;

  const mtimeMs = await dayMtime(path);
  const reader = await openDay(path);
  try {
    const { meta } = reader;
    const moving = (meta.enums.vehicleSpanKind ?? ["parked", "moving"]).indexOf("moving");
    const offset = await reader.scalar("vehicle.spanOffset", row);
    const count = await reader.scalar("vehicle.spanCount", row);
    const [start, end, kind, leg, lat, lon] = await Promise.all([
      reader.slice("vehicleSpan.startSecond", offset, count),
      reader.slice("vehicleSpan.endSecond", offset, count),
      reader.slice("vehicleSpan.kind", offset, count),
      reader.slice("vehicleSpan.leg", offset, count),
      reader.slice("vehicleSpan.latE6", offset, count),
      reader.slice("vehicleSpan.lonE6", offset, count),
    ]);

    const spans: VehicleSpan[] = Array.from({ length: count }, (_, i) => ({
      start: value(start, "i32", i),
      end: value(end, "i32", i),
      moving: value(kind, "u8", i) === moving,
      lat: value(lat, "i32", i) / 1e6,
      lon: value(lon, "i32", i) / 1e6,
      leg: value(kind, "u8", i) === moving ? value(leg, "i32", i) : null,
    }));

    const owners = await legOwners(reader, path, mtimeMs);
    const riders = await riderLegs(reader, path, mtimeMs, owners);
    const movements = await Promise.all(
      spans.filter((span) => span.moving && span.leg !== null && span.leg >= 0)
        .map(async (span) => movementOf(reader, owners, riders, span)),
    );

    const drivers: number[] = [];
    for (const movement of movements) {
      if (movement.person !== null && !drivers.includes(movement.person)) {
        drivers.push(movement.person);
      }
    }

    const columns = index.vehicles;
    return {
      date: meta.date,
      vin: columns.vin[row]!,
      owner: columns.owner[row]!,
      ownerType: index.ownerTypes[columns.ownerType[row]!] ?? "person",
      household: columns.household[row]! < 0 ? null : columns.household[row]!,
      serviceClass: index.serviceClasses[columns.serviceClass[row]!] ?? "none",
      spans,
      movements,
      kilometres: columns.metres[row]! / 1000,
      movingSeconds: columns.movingSeconds[row]!,
      drivers,
    };
  } finally {
    await reader.close();
  }
}

async function movementOf(
  reader: Reader,
  owners: LegOwners,
  riders: RiderLegs,
  span: VehicleSpan,
): Promise<VehicleMovement> {
  const leg = span.leg!;
  const fields = await Promise.all(MOVEMENT_COLUMNS.map(async (name) =>
    value(await reader.slice(name, leg, 1), reader.spec(name).type, 0)));
  const [
    mode, purpose, fromLat, fromLon, toLat, toLon, fromLabel, toLabel,
    kilometres, pathOffset, pathCount, depart, arrive, journey,
  ] = fields as number[];
  const [pathLat, pathLon] = await Promise.all([
    reader.slice("path.latE6", pathOffset!, pathCount!),
    reader.slice("path.lonE6", pathOffset!, pathCount!),
  ]);
  return {
    leg,
    start: span.start,
    end: span.end,
    person: personOfLeg(owners, leg),
    mode: reader.meta.enums.mode[mode!] ?? "other",
    purpose: reader.meta.enums.purpose[purpose!] ?? "other",
    from: { lat: fromLat! / 1e6, lon: fromLon! / 1e6, label: reader.string(fromLabel!) },
    to: { lat: toLat! / 1e6, lon: toLon! / 1e6, label: reader.string(toLabel!) },
    kilometres: kilometres!,
    path: Array.from({ length: pathCount! }, (_, i) => [
      value(pathLat, "i32", i) / 1e6, value(pathLon, "i32", i) / 1e6,
    ] as [number, number]),
    passengers: passengersOf(reader, riders, {
      driver: personOfLeg(owners, leg),
      purpose: reader.meta.enums.purpose[purpose!] ?? "other",
      root: journeyRoot(reader.string(journey!)),
      depart: depart!, arrive: arrive!,
      fromLat: fromLat!, fromLon: fromLon!, toLat: toLat!, toLon: toLon!,
    }),
  };
}

/**
 * Who else was in the car for one movement.
 *
 * The scan is over the rider legs alone, and a rider is taken as aboard if
 * their leg overlaps this drive in time and either shares its journey or runs
 * between the same two places. `alone` is the second half of the geometric
 * case: a rider whose window and endpoints fit only this vehicle, which is the
 * difference between naming a car and guessing one.
 */
function passengersOf(
  reader: Reader,
  riders: RiderLegs,
  drive: {
    driver: number | null; root: string | null; purpose: string;
    depart: number; arrive: number;
    fromLat: number; fromLon: number; toLat: number; toLon: number;
  },
): VehiclePassenger[] {
  // A deadhead is empty running by definition: the cab is on its way to a
  // pickup, and the fare it shares a journey with is still on the pavement.
  if (drive.purpose === "deadhead") return [];
  const out: VehiclePassenger[] = [];
  for (let i = 0; i < riders.leg.length; i += 1) {
    if (riders.depart[i]! >= drive.arrive || riders.arrive[i]! <= drive.depart) continue;
    const person = riders.person[i]!;
    if (person < 0 || person === drive.driver) continue;
    const shared = drive.root !== null && riders.root[i] === drive.root;
    const together = shared || (
      apart(riders.fromLat[i]!, riders.fromLon[i]!, drive.fromLat, drive.fromLon) <= SAME_PLACE_METRES
      && apart(riders.toLat[i]!, riders.toLon[i]!, drive.toLat, drive.toLon) <= SAME_PLACE_METRES
    );
    if (!together) continue;
    out.push({
      person,
      mode: reader.meta.enums.mode[riders.mode[i]!] ?? "other",
      purpose: reader.meta.enums.purpose[riders.purpose[i]!] ?? "other",
      depart: riders.depart[i]!,
      arrive: riders.arrive[i]!,
      match: shared ? "journey" : "nearby",
      alone: riders.candidates[i]! <= 1,
    });
  }
  return out.sort((a, b) => a.depart - b.depart || a.person - b.person);
}

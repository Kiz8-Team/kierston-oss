/** Continuous VIN-indexed vehicle state derived from the day's physical legs. */

import type { DayContext } from "../engine/index.ts";
import type { VehicleBoundaryState } from "../engine/index.ts";
import { homeOf, type Point } from "../world/index.ts";
import { NONE } from "./pack.ts";

export const VEHICLE_SPAN_KINDS = ["parked", "moving"] as const;

export interface VehicleDayColumns {
  vin: string[];
  owner: number[];
  ownerType: number[];
  household: number[];
  serviceClass: number[];
  spanOffset: number[];
  spanCount: number[];
  spanVehicle: number[];
  spanStart: number[];
  spanEnd: number[];
  spanKind: number[];
  spanLeg: number[];
  spanLat: number[];
  spanLon: number[];
  /** Exact boundary coordinate; moving spans store their start coordinate. */
  closingLat: number[];
  closingLon: number[];
}

export const VEHICLE_OWNER_TYPES = ["person", "organization"] as const;
export const VEHICLE_SERVICE_CLASSES = ["none", "taxi", "school_bus", "police", "ems"] as const;

export function initialVehicleBoundaryStates(context: DayContext): VehicleBoundaryState[] {
  const fleetByVin = new Map(context.world.fleet.vehicles.map((row) => [row.vin, row]));
  return [...context.world.vehicles.values()]
    .sort((a, b) => a.vin.localeCompare(b.vin))
    .map((row) => {
      const point = initialPoint(context, row.vin, row.household, fleetByVin);
      if (!point) throw new Error(`registered vehicle ${row.vin} has no initial coordinates`);
      return {
        id: row.vin,
        location: { ...point, id: null, kind: "kerb", label: "parked vehicle" },
        occupants: [], parked: true, fuelLitres: null, chargeKwh: null,
      };
    });
}

interface Movement {
  leg: number;
  start: number;
  end: number;
  from: Point;
  to: Point;
}

export function buildVehicleDay(
  context: DayContext,
  strings: readonly string[],
  legs: {
    vehicle: ArrayLike<number>;
    depart: ArrayLike<number>;
    arrive: ArrayLike<number>;
    fromLat: ArrayLike<number>;
    fromLon: ArrayLike<number>;
    toLat: ArrayLike<number>;
    toLon: ArrayLike<number>;
  },
): VehicleDayColumns {
  const errors: string[] = [];
  const movements = new Map<string, Movement[]>();
  for (let leg = 0; leg < legs.vehicle.length; leg += 1) {
    const id = legs.vehicle[leg]!;
    if (id === NONE) continue;
    const vin = strings[id];
    if (!vin) {
      errors.push(`leg ${leg} references missing vehicle string ${id}`);
      continue;
    }
    const rawStart = legs.depart[leg]! * 60;
    const rawEnd = legs.arrive[leg]! * 60;
    // Person-days intentionally retain their continuation past midnight. A
    // KDAY vehicle table covers this date only: ignore movements wholly in the
    // next date and clip a movement that is still underway at the boundary.
    if (rawEnd <= 0 || rawStart >= 86_400) continue;
    const rawFrom = { lat: legs.fromLat[leg]! / 1e6, lon: legs.fromLon[leg]! / 1e6 };
    const rawTo = { lat: legs.toLat[leg]! / 1e6, lon: legs.toLon[leg]! / 1e6 };
    const start = Math.max(0, rawStart);
    const end = Math.min(86_400, rawEnd);
    const mine = movements.get(vin) ?? [];
    mine.push({
      leg,
      start,
      end,
      from: pointAt(rawFrom, rawTo, fractionAt(start, rawStart, rawEnd)),
      to: pointAt(rawFrom, rawTo, fractionAt(end, rawStart, rawEnd)),
    });
    movements.set(vin, mine);
  }

  const fleetByVin = new Map(context.world.fleet.vehicles.map((row) => [row.vin, row]));
  const openingByVin = new Map(
    (context.state?.vehiclesForDay() ?? []).flatMap((row) => row.id && row.location ? [[row.id, row.location]] : []),
  );

  const out: VehicleDayColumns = {
    vin: [], owner: [], ownerType: [], household: [], serviceClass: [],
    spanOffset: [], spanCount: [], spanVehicle: [], spanStart: [], spanEnd: [],
    spanKind: [], spanLeg: [], spanLat: [], spanLon: [], closingLat: [], closingLon: [],
  };
  const rows = [...context.world.vehicles.values()].sort((a, b) => a.vin.localeCompare(b.vin));
  const registered = new Set(rows.map((row) => row.vin));
  for (const vin of movements.keys()) {
    if (!registered.has(vin)) errors.push(`unregistered vehicle ${vin} appears on a physical leg`);
  }
  for (const [vehicleIndex, row] of rows.entries()) {
    const initial = openingByVin.get(row.vin)
      ?? initialPoint(context, row.vin, row.household, fleetByVin);
    const mine = (movements.get(row.vin) ?? []).sort((a, b) => a.start - b.start || a.leg - b.leg);

    out.vin.push(row.vin);
    out.owner.push(row.owner);
    out.ownerType.push(VEHICLE_OWNER_TYPES.indexOf(row.owner_type));
    out.household.push(row.household ?? -1);
    out.serviceClass.push(VEHICLE_SERVICE_CLASSES.indexOf(row.service_class ?? "none"));
    out.spanOffset.push(out.spanStart.length);

    if (!initial) {
      errors.push(`registered vehicle ${row.vin} has no initial coordinates`);
      out.spanCount.push(0);
      out.closingLat.push(0);
      out.closingLon.push(0);
      continue;
    }

    let cursor = 0;
    let at = initial;
    for (const movement of mine) {
      if (movement.end <= movement.start) {
        errors.push(`vehicle ${row.vin} leg ${movement.leg} has no positive duration (${movement.start}s..${movement.end}s)`);
      }
      if (movement.start < cursor) {
        errors.push(`vehicle ${row.vin} has overlapping leg ${movement.leg} at ${movement.start}s (occupied through ${cursor}s)`);
      }
      if (movement.start > cursor) pushSpan(out, vehicleIndex, cursor, movement.start, 0, -1, at);
      // The allocator is deliberately tolerant at kerbs, but exported truth
      // must still join closely enough to be one physical vehicle.
      const jump = distanceMetres(at, movement.from);
      if (jump > 100) errors.push(`vehicle ${row.vin} teleports ${Math.round(jump)}m before leg ${movement.leg}`);
      pushSpan(out, vehicleIndex, movement.start, movement.end, 1, movement.leg, movement.from);
      cursor = Math.max(cursor, movement.end);
      at = movement.to;
    }
    if (cursor < 86_400) pushSpan(out, vehicleIndex, cursor, 86_400, 0, -1, at);
    const offset = out.spanOffset[out.spanOffset.length - 1]!;
    const count = out.spanStart.length - offset;
    out.spanCount.push(count);
    let expected = 0;
    for (let span = offset; span < offset + count; span += 1) {
      if (out.spanStart[span] !== expected) {
        errors.push(`vehicle ${row.vin} span coverage breaks at ${expected}s (next starts ${out.spanStart[span]}s)`);
      }
      expected = out.spanEnd[span]!;
    }
    if (expected !== 86_400) errors.push(`vehicle ${row.vin} span coverage ends at ${expected}s instead of 86400s`);
    out.closingLat.push(Math.round(at.lat * 1e6));
    out.closingLon.push(Math.round(at.lon * 1e6));
  }
  // Reported, not thrown. A discontinuity is a defect in the day that produced
  // it and not a reason to withhold the product: the KDAY is still the truthful
  // record of what the simulation did, and a run that has to be repeated to see
  // the next problem costs more than the one bad chain costs to read around.
  if (errors.length > 0) reportVehicleErrors(errors);
  return out;
}

/** Print the day's vehicle-continuity defects, capped so a bad run stays readable. */
function reportVehicleErrors(errors: readonly string[]): void {
  const shown = errors.slice(0, 20);
  const rest = errors.length - shown.length;
  console.warn(
    `\nwarning  vehicle timeline validation found ${errors.length} `
    + `error${errors.length === 1 ? "" : "s"}; the day was written anyway.\n`
    + shown.map((message) => `         ${message}`).join("\n")
    + (rest > 0 ? `\n         … and ${rest} more` : "") + "\n",
  );
}

/** Convert the exhaustive span table into an exact checkpoint boundary. */
export function vehicleBoundaryStates(
  day: VehicleDayColumns,
  boundary: "opening" | "closing",
): VehicleBoundaryState[] {
  return day.vin.map((vin, vehicle) => {
    const offset = day.spanOffset[vehicle]!;
    const count = day.spanCount[vehicle]!;
    const span = boundary === "opening" ? offset : offset + count - 1;
    return {
      id: vin,
      location: {
        lat: boundary === "opening" ? day.spanLat[span]! / 1e6 : day.closingLat[vehicle]! / 1e6,
        lon: boundary === "opening" ? day.spanLon[span]! / 1e6 : day.closingLon[vehicle]! / 1e6,
        id: null,
        kind: "kerb",
        label: day.spanKind[span] === 0 ? "parked vehicle" : "vehicle in motion",
      },
      occupants: [],
      parked: day.spanKind[span] === 0,
      fuelLitres: null,
      chargeKwh: null,
    };
  });
}

function initialPoint(
  context: DayContext,
  vin: string,
  household: number | null,
  fleetByVin: ReadonlyMap<string, { operator: number | null; owner_driver: number | null; base?: string | null }>,
): Point | null {
  if (household !== null) {
    const dwelling = context.world.households.get(household)?.dwelling;
    return dwelling ? context.world.places.get(dwelling) ?? null : null;
  }
  const fleet = fleetByVin.get(vin);
  if (!fleet) return null;
  // Its own premises before its operator's. A patrol car sleeps in the yard of
  // the station it answers from, and starting it at headquarters would have the
  // substation's first unit of the day collect a car three kilometres away.
  if (fleet.base) {
    const base = context.world.places.get(fleet.base);
    if (base) return base;
  }
  if (fleet.operator !== null) return context.world.fleet.operators.get(fleet.operator)?.depot ?? null;
  const driver = fleet.owner_driver === null ? null : context.world.persons.get(fleet.owner_driver);
  return driver ? homeOf(context.world, driver) : null;
}

function pushSpan(
  out: VehicleDayColumns,
  vehicle: number,
  start: number,
  end: number,
  kind: number,
  leg: number,
  point: Point,
): void {
  if (end <= start) return;
  out.spanVehicle.push(vehicle);
  out.spanStart.push(start);
  out.spanEnd.push(end);
  out.spanKind.push(kind);
  out.spanLeg.push(leg);
  out.spanLat.push(Math.round(point.lat * 1e6));
  out.spanLon.push(Math.round(point.lon * 1e6));
}

function distanceMetres(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function fractionAt(second: number, start: number, end: number): number {
  return end <= start ? 0 : Math.max(0, Math.min(1, (second - start) / (end - start)));
}

function pointAt(from: Point, to: Point, fraction: number): Point {
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lon: from.lon + (to.lon - from.lon) * fraction,
  };
}

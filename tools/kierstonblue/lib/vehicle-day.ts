/**
 * One vehicle's day as a single unbroken 00:00–24:00 track.
 *
 * The person's version of this stitches two half-covering lists together. A
 * vehicle needs none of that: the day file states the whole span table, gapless
 * from midnight to midnight, and every span is already either parked at a point
 * or moving along a leg. So this converts seconds to minutes, names each span
 * from the movement beside it, and stops.
 *
 * Everything a person's timeline knows about colour is reused deliberately —
 * a car leg is the same blue on both pages, and a stationary stretch is the
 * same brown — because the two pages are the same day seen from two ends.
 */

import { ACTIVITY_COLOR, DAY_END, DAY_START, MODE_COLOR, type TimelineSegment } from "@/lib/day-timeline";
import type {
  VehicleColumns, VehicleDay, VehicleDayIndex, VehicleMovement, VehiclePassenger,
} from "@/lib/server/vehicles";

/**
 * The way to one vehicle's day, from anywhere a VIN is shown.
 *
 * The registration and the movement are the same object seen twice, so the
 * movement page is a child of the register's route rather than a page of its
 * own somewhere else. Without a date it opens on the most recent day file.
 */
export function vehicleHref(vin: string, date?: string): string {
  const path = `/vehicles/${encodeURIComponent(vin)}`;
  return date ? `${path}?date=${encodeURIComponent(date)}` : path;
}

/** A stretch with the engine off, in the same brown as unbooked time at a place. */
export const PARKED_COLOR = ACTIVITY_COLOR.place;

export const SERVICE_LABEL: Record<string, string> = {
  none: "Private", taxi: "Taxi", school_bus: "School bus", police: "Police",
};

/** One row of the register, read out of the columns the index ships. */
export interface VehicleRow {
  index: number;
  vin: string;
  owner: number;
  ownerType: string;
  household: number | null;
  serviceClass: string;
  moves: number;
  movingSeconds: number;
  kilometres: number;
  firstMove: number | null;
  lastMove: number | null;
  drivers: number;
  driver: number | null;
}

export function vehicleRow(index: VehicleDayIndex, row: number): VehicleRow {
  const columns: VehicleColumns = index.vehicles;
  return {
    index: row,
    vin: columns.vin[row]!,
    owner: columns.owner[row]!,
    ownerType: index.ownerTypes[columns.ownerType[row]!] ?? "person",
    household: columns.household[row]! < 0 ? null : columns.household[row]!,
    serviceClass: index.serviceClasses[columns.serviceClass[row]!] ?? "none",
    moves: columns.moves[row]!,
    movingSeconds: columns.movingSeconds[row]!,
    kilometres: columns.metres[row]! / 1000,
    firstMove: columns.firstMove[row]! < 0 ? null : columns.firstMove[row]!,
    lastMove: columns.lastMove[row]! < 0 ? null : columns.lastMove[row]!,
    drivers: columns.drivers[row]!,
    driver: columns.driver[row]! < 0 ? null : columns.driver[row]!,
  };
}

/** "07:54" from a second of the day, for a table that reads in clock time. */
export function clockOfSecond(second: number): string {
  const minutes = Math.round(second / 60);
  if (minutes >= 1440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The span table as a timeline, one segment per span.
 *
 * A parked span carries no label of its own — the file gives it a point and
 * nothing else — so it is named from where the vehicle arrived, which is the
 * destination of the movement that put it there.
 */
export function buildVehicleTimeline(day: VehicleDay): TimelineSegment[] {
  const movements = new Map(day.movements.map((movement, index) => [movement.leg, index]));
  let arrivedAt: string | null = null;

  return day.spans.map((span) => {
    const start = Math.max(DAY_START, span.start / 60);
    const end = Math.min(DAY_END, span.end / 60);
    const index = span.leg === null ? undefined : movements.get(span.leg);
    const movement = index === undefined ? null : day.movements[index]!;

    if (!movement) {
      const title = arrivedAt ? `Parked at ${arrivedAt}` : "Parked";
      return {
        start, end, travel: false, legIndex: null, kind: "parked",
        title,
        detail: null,
        color: PARKED_COLOR,
        lat: span.lat, lon: span.lon,
      };
    }

    arrivedAt = movement.to.label ?? "unnamed place";
    const aboard = movement.passengers.length;
    return {
      start, end, travel: true, legIndex: index ?? null, kind: movement.mode,
      title: `${movement.from.label ?? "Unnamed place"} → ${movement.to.label ?? "Unnamed place"}`,
      detail: `${movement.mode} · ${movement.kilometres.toFixed(1)} km · `
        + (movement.person === null ? "no driver" : `driver ${movement.person}`)
        + (aboard ? ` · ${aboard} aboard` : ""),
      color: MODE_COLOR[movement.mode] ?? MODE_COLOR.other,
      lat: null, lon: null,
    };
  });
}

/** The movement under way at a minute, or null where the vehicle is parked. */
export function movementAt(day: VehicleDay, minute: number): VehicleMovement | null {
  const second = minute * 60;
  return day.movements.find(
    (movement) => second >= movement.start && second < movement.end,
  ) ?? null;
}

/**
 * Where the vehicle is at a minute, and whether it is moving.
 *
 * A moving vehicle is placed along the routed path of its leg by how far into
 * the span the clock is, the same way a person is placed on theirs. A parked
 * one is at the point the span states, which is exact.
 */
export function vehiclePositionAt(
  day: VehicleDay, minute: number,
): { lat: number; lon: number; moving: boolean } | null {
  const second = minute * 60;
  const span = day.spans.find((row) => second >= row.start && second < row.end)
    ?? day.spans[day.spans.length - 1];
  if (!span) return null;
  if (!span.moving) return { lat: span.lat, lon: span.lon, moving: false };

  const movement = day.movements.find((row) => row.leg === span.leg);
  const path = movement?.path.length
    ? movement.path
    : movement
      ? [[movement.from.lat, movement.from.lon], [movement.to.lat, movement.to.lon]] as [number, number][]
      : [[span.lat, span.lon]] as [number, number][];
  const width = span.end - span.start;
  const share = width > 0 ? Math.min(1, Math.max(0, (second - span.start) / width)) : 0;
  const [lat, lon] = alongPath(path, share);
  return { lat, lon, moving: true };
}

/** Who is in the vehicle at a minute: nobody when it is parked. */
export interface Occupancy {
  movement: VehicleMovement | null;
  driver: number | null;
  passengers: VehiclePassenger[];
}

export function occupancyAt(day: VehicleDay, minute: number): Occupancy {
  const movement = movementAt(day, minute);
  return {
    movement,
    driver: movement?.person ?? null,
    passengers: movement?.passengers ?? [],
  };
}

/** How a rider was tied to this vehicle, said plainly. */
export const MATCH_NOTE: Record<VehiclePassenger["match"], string> = {
  journey: "journey match",
  nearby: "route match",
};

/** Rough metres between two coordinates — good enough to space points along a path. */
function metres(a: [number, number], b: [number, number]): number {
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const x = (b[1] - a[1]) * Math.cos(lat);
  const y = b[0] - a[0];
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** How far along a routed path a vehicle has got, `share` of the way through. */
function alongPath(path: [number, number][], share: number): [number, number] {
  if (path.length === 1) return path[0]!;
  const steps = path.slice(1).map((point, index) => metres(path[index]!, point));
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (total <= 0) return path[0]!;
  let target = share * total;
  for (let index = 0; index < steps.length; index += 1) {
    if (target <= steps[index]! || index === steps.length - 1) {
      const part = steps[index]! > 0 ? Math.min(1, Math.max(0, target / steps[index]!)) : 0;
      const [aLat, aLon] = path[index]!;
      const [bLat, bLon] = path[index + 1]!;
      return [aLat + (bLat - aLat) * part, aLon + (bLon - aLon) * part];
    }
    target -= steps[index]!;
  }
  return path[path.length - 1]!;
}

/**
 * One resident's day as a single unbroken 00:00–24:00 track.
 *
 * The day file stores two lists that only half overlap: schedule entries say
 * what someone is committed to, legs say how they moved between those places.
 * Neither on its own covers the whole day — a schedule leaves the travel
 * between entries blank, and the legs leave the hours at a place blank. The
 * timeline stitches them: legs pin the moments in motion and the place the
 * person is at between them, and the schedule then subdivides each of those
 * stays into what they were doing there. What is left over is time at that
 * place with nothing booked, which is a real state and gets its own segment.
 */

import type { DayMovementLeg, PersonDay } from "@/lib/server/day";

export const DAY_START = 0;
export const DAY_END = 1440;

/** Travel colours, keyed by the mode enum in the day file. */
export const MODE_COLOR: Record<string, string> = {
  car: "#256abf", carpool: "#5b7a9d", transit: "#c2410c", walk: "#177a4a",
  bike: "#2f9e6b", taxi: "#b42318", cab: "#b42318", bus: "#d9925e",
  passenger: "#7ba3df", other: "#737373",
};

/**
 * Stay colours, keyed by the schedule kind, plus `place` for unbooked time.
 * Deliberately a quieter family than the modes: the eye should find the trips
 * first, because those are the segments that move the map. Sleep is the one
 * neutral grey and is struck through in the bar — hours nobody is awake for
 * should read as crossed off rather than as another activity; unbooked time at
 * a place is sand, so the two longest stretches of most days never blur.
 */
export const ACTIVITY_COLOR: Record<string, string> = {
  sleep: "#d4d4d4", work: "#5b7a9d", school: "#b0893c",
  affiliation: "#8a6bb5", stop: "#a3567a", place: "#c7b59c", unknown: "#a3a3a3",
};

export interface TimelineSegment {
  start: number;
  end: number;
  /** True for a movement leg, false for time spent at one place. */
  travel: boolean;
  /** Index into `PersonDay.legs`, for travel segments only. */
  legIndex: number | null;
  /** Mode for travel, schedule kind (or `place`) for a stay. */
  kind: string;
  title: string;
  detail: string | null;
  color: string;
  /** Where the person is standing, for stays with a known location. */
  lat: number | null;
  lon: number | null;
}

export interface TimelinePosition {
  lat: number;
  lon: number;
  moving: boolean;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** "07:54". Minutes outside the day are already clipped before this is called. */
export function clock(minutes: number): string {
  const value = clamp(Math.round(minutes), 0, DAY_END);
  if (value === DAY_END) return "24:00";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function duration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  return `${hours}h${total % 60 ? ` ${total % 60}m` : ""}`;
}

function placeLabel(label: string | null): string {
  return label && label.trim() ? label : "Unnamed place";
}

/**
 * Widened from `PersonDay` to the two lists it actually reads, so a gathering
 * can build a track for somebody whose ledger and handset were never loaded.
 * See `readMovement` in lib/server/day.
 */
export type Movement = Pick<PersonDay, "schedule" | "legs">;

export function buildTimeline(day: Movement): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  const legs = day.legs;

  const stay = (start: number, end: number, point: { lat: number; lon: number; label: string | null } | null) => {
    const from = clamp(start, DAY_START, DAY_END);
    const to = clamp(end, DAY_START, DAY_END);
    if (to <= from) return;

    // Schedule entries can start the night before or run into tomorrow, and
    // two of them can overlap. Clip to this window, then walk it in order so
    // every minute is claimed exactly once.
    const booked = day.schedule
      .map((entry) => ({ ...entry, start: Math.max(entry.start, from), end: Math.min(entry.end, to) }))
      .filter((entry) => entry.end > entry.start)
      .sort((a, b) => a.start - b.start);

    let cursor = from;
    const idle = (a: number, b: number) => {
      if (b <= a) return;
      segments.push({
        start: a, end: b, travel: false, legIndex: null, kind: "place",
        title: point ? placeLabel(point.label) : "Unknown location",
        detail: null,
        color: ACTIVITY_COLOR.place,
        lat: point?.lat ?? null, lon: point?.lon ?? null,
      });
    };

    for (const entry of booked) {
      if (entry.end <= cursor) continue;
      idle(cursor, entry.start);
      const start = Math.max(entry.start, cursor);
      const title = entry.label ?? entry.kind;
      // The place is worth naming next to "food-sit" but not next to "work",
      // where the entry and the building it happens in carry the same word.
      const where = point ? placeLabel(point.label) : entry.where;
      segments.push({
        start, end: entry.end, travel: false, legIndex: null, kind: entry.kind,
        title,
        detail: where && where !== title ? where : null,
        color: ACTIVITY_COLOR[entry.kind] ?? ACTIVITY_COLOR.unknown,
        lat: point?.lat ?? null, lon: point?.lon ?? null,
      });
      cursor = entry.end;
    }
    idle(cursor, to);
  };

  if (!legs.length) {
    stay(DAY_START, DAY_END, null);
    return segments;
  }

  legs.forEach((leg, index) => {
    const previous = legs[index - 1];
    stay(previous ? previous.arrive : DAY_START, leg.depart, previous ? previous.to : leg.from);

    const start = clamp(leg.depart, DAY_START, DAY_END);
    const end = clamp(leg.arrive, DAY_START, DAY_END);
    if (end > start) {
      segments.push({
        start, end, travel: true, legIndex: index, kind: leg.mode,
        title: `${placeLabel(leg.from.label)} → ${placeLabel(leg.to.label)}`,
        detail: `${leg.mode} · ${leg.kilometres.toFixed(1)} km${leg.wait ? ` · ${Math.round(leg.wait)} min wait` : ""}`,
        color: MODE_COLOR[leg.mode] ?? MODE_COLOR.other,
        lat: null, lon: null,
      });
    }
  });
  const last = legs[legs.length - 1];
  stay(last.arrive, DAY_END, last.to);

  return segments;
}

export function segmentAt(segments: TimelineSegment[], minute: number): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (minute >= segment.start && minute < segment.end) return index;
  }
  // The very end of the day belongs to the last segment rather than to nothing.
  return segments.length && minute >= DAY_END ? segments.length - 1 : -1;
}

/** Rough metres between two coordinates — good enough to space points along a path. */
function metres(a: [number, number], b: [number, number]): number {
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const x = (b[1] - a[1]) * Math.cos(lat);
  const y = b[0] - a[0];
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** Where along a routed path the person has got to, `fraction` of the way through. */
function alongPath(path: [number, number][], fraction: number): [number, number] {
  if (path.length === 1) return path[0];
  const steps = path.slice(1).map((point, index) => metres(path[index], point));
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (total <= 0) return path[0];
  let target = clamp(fraction, 0, 1) * total;
  for (let index = 0; index < steps.length; index += 1) {
    if (target <= steps[index] || index === steps.length - 1) {
      const share = steps[index] > 0 ? clamp(target / steps[index], 0, 1) : 0;
      const [aLat, aLon] = path[index];
      const [bLat, bLon] = path[index + 1];
      return [aLat + (bLat - aLat) * share, aLon + (bLon - aLon) * share];
    }
    target -= steps[index];
  }
  return path[path.length - 1];
}

/** The person's location at a given minute: a point on a route, or a place. */
export function positionAt(
  segments: TimelineSegment[],
  legs: DayMovementLeg[],
  minute: number,
): TimelinePosition | null {
  const index = segmentAt(segments, minute);
  if (index < 0) return null;
  const segment = segments[index];

  if (!segment.travel || segment.legIndex === null) {
    return segment.lat === null || segment.lon === null
      ? null
      : { lat: segment.lat, lon: segment.lon, moving: false };
  }

  const leg = legs[segment.legIndex];
  if (!leg) return null;
  const path: [number, number][] = leg.path.length
    ? leg.path
    : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
  const width = segment.end - segment.start;
  const fraction = width > 0 ? (minute - segment.start) / width : 0;
  const [lat, lon] = alongPath(path, fraction);
  return { lat, lon, moving: true };
}

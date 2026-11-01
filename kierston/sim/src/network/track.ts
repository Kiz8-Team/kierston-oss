/**
 * Where a person is at every minute of the day, and what is between them and
 * the sky.
 *
 * This adds no geometry. The scheduler already decided the day and the router
 * already drew every journey in it, so a minute-resolution position is
 * interpolation along work that exists: a leg carries a routed polyline and
 * the minutes it spans, and the time between two legs is time spent standing
 * at the place the last one ended.
 *
 * Interpolation is by distance along the path rather than by vertex, and the
 * difference is not cosmetic. A routed line has a vertex at every junction, so
 * a leg down a suburban grid has its points bunched at the corners and a
 * per-vertex walk would move a car in lurches — fast down the straight, stalled
 * at every turn — which puts handovers in the wrong places. Constant speed
 * along the whole leg is not true either, but it is wrong in a way that does
 * not correlate with the road layout the cells were planned around.
 *
 * `exposure` is the second output and carries more weight than it looks like
 * it should. Two thirds of a day is spent indoors, penetration loss is the
 * largest single term in the link budget, and a model that treated everyone as
 * permanently outdoors would put the whole city on the capacity layer and
 * produce a network with almost no low-band traffic — the opposite of a real
 * one. So a stay is indoors, a walk is outdoors, and time in a vehicle is its
 * own case because a car is a much weaker screen than a building.
 *
 * The exception is the stay that follows a journey to a vehicle. That leg ends
 * at a kerb space or a parking lot, and the minutes after it are spent walking
 * around outside a car, not sitting in an office.
 */

import type { Leg } from "../transport/index.ts";
import type { Point } from "../world/index.ts";
import { INDOOR, OUTDOOR, VEHICLE, type Cells, type Exposure } from "./cells.ts";

export const MINUTES = 1440;

export interface Track {
  /** Metres east of the city centre, one per minute. */
  x: Float64Array;
  /** Metres north. */
  y: Float64Array;
  /** OUTDOOR, INDOOR or VEHICLE, one per minute. */
  exposure: Uint8Array;
  /**
   * Whether the person is asleep, one per minute.
   *
   * Carried because a handset's own activity follows its owner's: a phone on a
   * bedside table talks to a server every so often and nothing else, while the
   * same phone at ten in the morning is being looked at. Taking this from the
   * scheduler's own sleep bouts rather than from the clock is what makes the
   * night watchman's day come out right — his phone is busy at three and idle
   * at eleven, which a fixed nocturnal window would have exactly backwards.
   */
  asleep: Uint8Array;
  /**
   * False when the day gave no position at all, which is a real state and not
   * an error: an off-map worker's day is surveyed rather than routed, and a
   * group-quarters resident may have no dwelling to stand at. A subscriber
   * with no track is recorded as unattached for the whole day rather than
   * being quietly given a plausible one.
   */
  known: boolean;
}

/** Which modes put a metal shell around the handset. */
function exposureOf(mode: Leg["mode"]): Exposure {
  return mode === "walk" || mode === "bike" ? OUTDOOR : VEHICLE;
}

const EMPTY: Track = {
  x: new Float64Array(0),
  y: new Float64Array(0),
  exposure: new Uint8Array(0),
  asleep: new Uint8Array(0),
  known: false,
};

/** A span of the day, as the scheduler reports its sleep bouts. */
export interface Bout {
  at: number;
  end: number;
}

function sleepMask(bouts: readonly Bout[] | null): Uint8Array {
  const mask = new Uint8Array(MINUTES);
  for (const bout of bouts ?? []) {
    const from = Math.max(0, Math.floor(bout.at));
    const to = Math.min(MINUTES, Math.ceil(bout.end));
    for (let minute = from; minute < to; minute += 1) mask[minute] = 1;
  }
  return mask;
}

/**
 * The minute-by-minute track for one planned day.
 *
 * `paths` is the routed polyline for each leg, positionally. The exporter
 * already computes these to pack the day's geometry and passes them straight
 * in; a caller that has not can pass null and get straight lines between
 * endpoints, which is what an unroutable leg would have produced anyway.
 */
export function positionTrack(
  cells: Cells,
  legs: readonly Leg[],
  paths: readonly Point[][] | null,
  home: Point | null,
  bouts: readonly Bout[] | null = null,
): Track {
  const asleep = sleepMask(bouts);

  if (legs.length === 0) {
    if (!home) return EMPTY;
    const at = cells.project(home.lat, home.lon);
    const x = new Float64Array(MINUTES).fill(at.x);
    const y = new Float64Array(MINUTES).fill(at.y);
    return { x, y, exposure: new Uint8Array(MINUTES).fill(INDOOR), asleep, known: true };
  }

  // Project every leg once. Cumulative length comes with it, because the
  // interpolation is by distance and recomputing it per minute would walk the
  // same polyline a hundred times for one crossing of the city.
  const shapes = legs.map((leg, index) => {
    const line = paths?.[index]?.length ? paths[index]! : [leg.from, leg.to];
    const px = new Float64Array(line.length);
    const py = new Float64Array(line.length);
    const along = new Float64Array(line.length);
    for (let i = 0; i < line.length; i += 1) {
      const at = cells.project(line[i]!.lat, line[i]!.lon);
      px[i] = at.x;
      py[i] = at.y;
      if (i > 0) {
        const dx = px[i]! - px[i - 1]!;
        const dy = py[i]! - py[i - 1]!;
        along[i] = along[i - 1]! + Math.sqrt(dx * dx + dy * dy);
      }
    }
    return { px, py, along, total: along[along.length - 1]! };
  });

  const x = new Float64Array(MINUTES);
  const y = new Float64Array(MINUTES);
  const exposure = new Uint8Array(MINUTES);

  // Before the first departure the person is wherever that journey starts,
  // which is not always home: a night-shift worker's day opens partway
  // through a commute the previous date paid for.
  let anchor = cells.project(legs[0]!.from.lat, legs[0]!.from.lon);
  let anchorExposure: Exposure = INDOOR;
  let index = 0;

  for (let minute = 0; minute < MINUTES; minute += 1) {
    while (index < legs.length && minute >= legs[index]!.arrive) {
      const leg = legs[index]!;
      anchor = cells.project(leg.to.lat, leg.to.lon);
      anchorExposure = leg.purpose === "vehicle" ? OUTDOOR : INDOOR;
      index += 1;
    }

    const leg = index < legs.length ? legs[index]! : null;
    if (leg && minute >= leg.depart) {
      const shape = shapes[index]!;
      const span = Math.max(leg.arrive - leg.depart, 1);
      const fraction = Math.min(Math.max((minute - leg.depart) / span, 0), 1);
      const target = shape.total * fraction;
      // Linear scan from the start of the leg would be quadratic over a long
      // path; binary search over the cumulative lengths is not, and the array
      // is sorted by construction.
      let lo = 0;
      let hi = shape.along.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (shape.along[mid]! <= target) lo = mid;
        else hi = mid - 1;
      }
      const next = Math.min(lo + 1, shape.along.length - 1);
      const segment = shape.along[next]! - shape.along[lo]!;
      const t = segment > 0 ? (target - shape.along[lo]!) / segment : 0;
      x[minute] = shape.px[lo]! + (shape.px[next]! - shape.px[lo]!) * t;
      y[minute] = shape.py[lo]! + (shape.py[next]! - shape.py[lo]!) * t;
      // A driven leg ends on foot. `parking.walkMinutes` is the walk from the
      // space to the door and the scheduler has already measured it — it is
      // inside `arrive` rather than beside it — so those minutes are spent
      // outdoors carrying a phone, not inside a car. Small per trip, and the
      // difference between the city having outdoor minutes and having almost
      // none.
      const walk = leg.parking?.walkMinutes ?? 0;
      exposure[minute] = walk > 0 && minute > leg.arrive - walk
        ? OUTDOOR
        : exposureOf(leg.mode);
      continue;
    }

    x[minute] = anchor.x;
    y[minute] = anchor.y;
    exposure[minute] = anchorExposure;
  }

  return { x, y, exposure, asleep, known: true };
}

/**
 * Internal API for the cellular network at runtime.
 *
 *   cells.ts        the radio: what is audible from a point, and how loudly
 *   subscribers.ts  who is on the network, and on whose spectrum
 *   track.ts        where a person is every minute, and what is in the way
 *   attach.ts       the state machine: serving cell, handovers, signalling
 *
 * `init/network/towers.py` builds what exists and stops. This is the half that
 * needs a position at a time, which is the half only a running day has.
 */

import type { Day } from "../scheduler/index.ts";
import type { Point } from "../world/index.ts";
import { Cells, INDOOR, OUTDOOR } from "./cells.ts";
import { Subscribers, type Subscriber } from "./subscribers.ts";
import { attachDay, leftBehindToday, unpoweredMinutes, type DayNetwork, type RadioState } from "./attach.ts";
import { MINUTES, positionTrack, type Bout, type Track } from "./track.ts";

export * from "./cells.ts";
export * from "./subscribers.ts";
export * from "./track.ts";
export * from "./attach.ts";

/**
 * The network, loaded once and read for every person on every date.
 *
 * On the day context beside the roads and the venues, and for the same reason:
 * nothing in it depends on which day is being simulated. The tile candidate
 * lists it accumulates as it goes are a cache and not state — they are a
 * function of the city's geometry, so a second date reuses the first date's
 * work rather than being contaminated by it.
 */
export class Network {
  private constructor(readonly cells: Cells, readonly subscribers: Subscribers) {}

  static async open(): Promise<Network> {
    const [cells, subscribers] = await Promise.all([Cells.open(), Subscribers.open()]);
    return new Network(cells, subscribers);
  }

  /**
   * Every handset belonging to one person, run over one planned day.
   *
   * `paths` is the routed geometry of each leg, positionally, where the caller
   * already has it. The day exporter does — it packs the same polylines — and
   * passing them in is the difference between routing the city once and
   * routing it twice.
   */
  day(
    planned: Day,
    home: Point | null,
    day: number,
    seed: number,
    paths: readonly Point[][] | null,
    out: DayNetwork,
    boundary?: {
      opening(subscriber: number): RadioState | null;
      closing(state: RadioState): void;
    },
    activity?: ReadonlyMap<number, Uint8Array>,
    hold?: HandsetHold,
    keep = false,
  ): RadioDay {
    const subscribers = this.subscribers.forPerson(planned.person);
    if (subscribers.length === 0) return { parted: null };
    let track = positionTrack(this.cells, planned.legs, paths, home, sleepBouts(planned));
    if (hold && track.known) track = heldTrack(this.cells, track, hold);
    const homeAt = home ? this.cells.project(home.lat, home.lon) : null;
    for (const subscriber of subscribers) {
      const closing = attachDay(
        this.cells, subscriber, track, homeAt, seed, day, out,
        boundary?.opening(subscriber.index) ?? null,
        activity?.get(subscriber.index),
        { pinned: hold !== undefined, alwaysOn: keep },
      );
      boundary?.closing(closing);
    }
    if (keep) return { parted: null };
    // A held handset is placed by the scenario, which also parts the owner
    // from it; the day's left-at-home draw is ignored for it (`pinned` in
    // attachDay). Powered-off and dead-battery minutes still apply.
    return { parted: this.partedIntervals(subscribers, track, homeAt, seed, day, hold !== undefined) };
  }

  /**
   * The minutes a person has no usable handset, as `[from, until)` intervals;
   * null when there are none. The same answer `day` gives for a day without a
   * scenario hold, for a caller that has not run the radio yet (the scenario
   * runner reads the comms layer first). See `partedIntervals`.
   */
  partedFromHandsets(
    planned: Day, home: Point | null, day: number, seed: number, paths: readonly Point[][] | null, pinned = false,
  ): Interval[] | null {
    const subscribers = this.subscribers.forPerson(planned.person);
    if (subscribers.length === 0) return null;
    const track = positionTrack(this.cells, planned.legs, paths, home, sleepBouts(planned));
    const homeAt = home ? this.cells.project(home.lat, home.lon) : null;
    return this.partedIntervals(subscribers, track, homeAt, seed, day, pinned);
  }

  /**
   * The minutes in which every handset the person owns is unusable to them:
   * powered off for the night, battery dead, or left at home while the owner
   * is more than `REUNION_METRES` from the house. One working handset on the
   * person is enough to be reachable, so the per-handset masks are combined
   * with AND. `pinned` (a scenario hold) drops the left-at-home draw, as
   * `attachDay` does. The left-at-home part needs a known track and a home;
   * the power part does not.
   */
  private partedIntervals(
    subscribers: readonly Subscriber[], track: Track, homeAt: { x: number; y: number } | null, seed: number, day: number,
    pinned = false,
  ): Interval[] | null {
    const away = !pinned && homeAt && track.known ? awayMask(track, homeAt) : null;
    const none = new Uint8Array(MINUTES).fill(1);
    for (const subscriber of subscribers) {
      const off = unpoweredMinutes(seed, subscriber, day);
      const behind = away !== null && leftBehindToday(seed, subscriber, day);
      for (let minute = 0; minute < MINUTES; minute += 1) {
        if (!off[minute] && !(behind && away![minute])) none[minute] = 0;
      }
    }
    const out = intervalsOf(none);
    return out.length > 0 ? out : null;
  }
}

/** One stretch of minutes, `until` exclusive. */
export interface Interval { from: number; until: number }

/** How far from where a phone lies its owner can be and still pick it up. */
export const REUNION_METRES = 75;

/** The owner's absences from `at`, as intervals of minutes. */
export function awayFrom(track: Track, at: { x: number; y: number }): Interval[] {
  return intervalsOf(awayMask(track, at));
}

/** Per minute, 1 where the owner is more than `REUNION_METRES` from `at`. */
function awayMask(track: Track, at: { x: number; y: number }): Uint8Array {
  const mask = new Uint8Array(MINUTES);
  for (let minute = 0; minute < MINUTES; minute += 1) {
    if (Math.hypot(track.x[minute]! - at.x, track.y[minute]! - at.y) > REUNION_METRES) mask[minute] = 1;
  }
  return mask;
}

/** Runs of 1 in a per-minute mask, as `[from, until)` intervals. */
function intervalsOf(mask: Uint8Array): Interval[] {
  const out: Interval[] = [];
  let from = -1;
  for (let minute = 0; minute < MINUTES; minute += 1) {
    if (mask[minute] && from < 0) from = minute;
    if (!mask[minute] && from >= 0) { out.push({ from, until: minute }); from = -1; }
  }
  if (from >= 0) out.push({ from, until: MINUTES });
  return out;
}

/**
 * What one person's radio day says about the person: the minutes they had no
 * usable handset (every handset off, dead, or left at home while they were
 * out), or null when there are none.
 */
export interface RadioDay { parted: Interval[] | null }

/**
 * A handset that parted company with its owner.
 *
 * From `from` the phone lies at `at` for the rest of the date — dropped in
 * the rush out of a hall, left on a table, still in the pocket of somebody
 * who is not going anywhere — while the person's own day carries on
 * elsewhere or does not. The radio follows the phone, which is the whole
 * point: a record keyed on a subscriber is a record of where the *handset*
 * was, and a scenario that separates the two produces the one kind of
 * evidence that a location-equals-person reading gets wrong.
 */
export interface HandsetHold {
  /** First minute the handset is at `at`. */
  from: number;
  at: Point;
  /** Inside a building or out on the street; indoors unless said otherwise. */
  outdoors?: boolean;
}

function heldTrack(cells: Cells, track: Track, hold: HandsetHold): Track {
  const from = Math.max(0, Math.min(MINUTES, Math.floor(hold.from)));
  const at = cells.project(hold.at.lat, hold.at.lon);
  const x = Float64Array.from(track.x), y = Float64Array.from(track.y);
  const exposure = Uint8Array.from(track.exposure);
  // Nobody is looking at a phone lying where it was left: it idles at the
  // sleeping rate, the way a phone left at home does.
  const asleep = Uint8Array.from(track.asleep);
  x.fill(at.x, from); y.fill(at.y, from);
  exposure.fill(hold.outdoors ? OUTDOOR : INDOOR, from);
  asleep.fill(1, from);
  return { ...track, x, y, exposure, asleep };
}

/** The day's sleep, as the planner actually allowed it rather than as proposed. */
function sleepBouts(planned: Day): Bout[] {
  const bouts: Bout[] = [];
  for (const event of planned.scheduled.timeline) {
    if (event.kind === "stay" && event.source === "sleep") {
      bouts.push({ at: event.start, end: event.end });
    }
  }
  return bouts;
}

export function emptyDayNetwork(): DayNetwork {
  return { spans: [], events: [] };
}

/**
 * Subscribers whose owner is not in the population, which should be none.
 *
 * A subscription names a person, and if that person does not exist then the
 * handset belongs to nobody, is never planned, and silently contributes no
 * records at all. That is what a stale `sim_data` looks like from here:
 * `devices.json` built against one population and `population.json` rebuilt
 * smaller afterwards leaves every subscription above the new maximum id
 * pointing at nothing.
 *
 * It has to be reported rather than tolerated. The failure is invisible in
 * every aggregate — the operator shares still come out right, because the
 * missing subscribers are missing uniformly — and it silently shrinks the
 * network's population by however far the two files have drifted apart.
 */
export function orphanSubscribers(network: Network, present: (person: number) => boolean): number {
  let orphans = 0;
  for (const subscriber of network.subscribers.all) {
    if (!present(subscriber.person)) orphans += 1;
  }
  return orphans;
}

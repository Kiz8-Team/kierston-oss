/**
 * The vocabulary the scheduler is written in.
 *
 * Two shapes carry the whole design. An `ActivityIntent` is what a domain layer
 * asks for, and nothing downstream modifies it; a `TimelineEvent` is what the
 * day turned out to be. Keeping them as separate types is what makes a plan
 * comparable with its outcome — and what makes it possible to say that an
 * activity was *rejected*, rather than silently producing a day it is simply
 * absent from.
 *
 * `TransitionPlanner` is the third: the seam between deciding when and pricing
 * how. The planner depends on the interface and not on the router, so placement
 * can be tested against a fake with arithmetic distances, and the routing cost
 * of a design change can be measured without touching the placement logic.
 */

import type { LegMode, LegPurpose, Parking, Place } from "../transport/index.ts";

/** Which layer asked for this, kept on the outcome so a check can group by it. */
export type ActivitySource =
  | "work"
  | "school"
  | "sleep"
  | "affiliation"
  | "stop"
  | "meet"
  | "shared-travel"
  | "incident";

/**
 * How hard this activity is to move.
 *
 *   required   a shift, a bell, a bus run, a fare. Displaces anything weaker it
 *              collides with, and a collision with another `required` is
 *              reported rather than resolved
 *   missable   real, but yields: a porous college block, an escort run, a
 *              night's sleep
 *   optional   the layer that gives way — shopping, coffee, the pub
 */
export type ActivityPolicy = "required" | "missable" | "optional";

/**
 * A journey somebody else has already decided, as far as this day is concerned.
 *
 * A school bus run, a dispatched cab, a lift from a parent: the mode and the
 * duration come from the layer that priced the whole vehicle's route, and
 * re-deriving either here would produce a second, wrong number for a journey
 * already accounted for. `journeyId` is the identity both halves of a shared
 * trip carry, which is how a driver's day and a passenger's day can be
 * recognised as describing one car.
 */
export interface TravelOverride {
  mode?: LegMode;
  minutes?: number;
  journeyId?: string;
  vehicleId?: string;
  /**
   * On a departure: leave as soon as the stay ends instead of as late as the
   * next arrival allows. A driver collecting somebody at a fixed minute leaves
   * with them at that minute; arriving early at the next stop is spent waiting
   * there.
   */
  prompt?: boolean;
}

/**
 * When the activity happens, in one of the only two ways it can be known.
 *
 * `fixed` is an appointment: the clock was set by somebody other than this
 * person and the day is solved around it. `window` is an intention: some time
 * between these two, for about this long, if the day allows it.
 */
export type ActivityTiming =
  | { kind: "fixed"; start: number; end: number }
  | {
      kind: "window";
      earliest: number;
      latest: number;
      /** Minimum useful duration; below it the activity is not worth doing. */
      duration: number;
      /** Desired duration when the gap has room; used by compressible sleep. */
      preferredDuration?: number;
    };

/**
 * An immutable request to spend time at one place.
 *
 * `id` has to be stable across runs and unique within a day: it is the
 * tie-break that makes scheduling deterministic, and the key the composition
 * layer looks the outcome up by once the timeline exists.
 */
export interface ActivityIntent<T = unknown> {
  id: string;
  source: ActivitySource;
  place: Place;
  timing: ActivityTiming;
  policy: ActivityPolicy;
  purpose: LegPurpose;
  /** How the journey *to* here is made, where something else already knows. */
  arrival?: TravelOverride;
  /** The same for the journey *away*, which is often a different mode. */
  departure?: TravelOverride;
  /** The originating layer's own object, carried through untouched. */
  payload?: T;
  /**
   * One person's share of something other people's days also contain, such as
   * a lift to a meeting: the wait at the door, the meeting and the drop-off.
   * Fixed intents with the same bundle are admitted together or not at all,
   * so a day never keeps half of a shared arrangement.
   */
  bundle?: string;
}

export interface StayEvent<T = unknown> {
  kind: "stay";
  /** The `ActivityIntent.id` this stay came from. */
  activityId: string;
  source: ActivitySource;
  place: Place;
  start: number;
  end: number;
  policy: ActivityPolicy;
  payload?: T;
}

export interface TravelEvent {
  kind: "travel";
  journeyId: string;
  /** Unsuffixed identity shared by every segment of this transition. */
  journeyRoot?: string;
  /** Physical registered vehicle for vehicle-bearing segments. */
  vehicleId?: string;
  purpose: LegPurpose;
  mode: LegMode;
  from: Place;
  to: Place;
  start: number;
  end: number;
  kilometres: number;
  /** True where the duration came from a survey or an override, not the roads. */
  estimated: boolean;
  parking?: Parking;
  /** Minutes of this leg spent waiting rather than moving, which is a taxi. */
  wait?: number;
}

export type TimelineEvent<T = unknown> = StayEvent<T> | TravelEvent;

export type RejectionReason =
  | "conflict"
  | "unreachable"
  | "closed"
  | "transport-unavailable"
  | "outside-window";

/**
 * An activity the day had no room for, and why.
 *
 * Part of the output rather than a log line because it is measurable: rejected
 * `required` activities are an invariant that should read zero, and a rise in
 * the others is how a layer that has started asking for impossible days
 * announces itself.
 */
export interface RejectedIntent<T = unknown> {
  intent: ActivityIntent<T>;
  reason: RejectionReason;
  detail?: string;
}

export interface DayMetrics {
  trips: number;
  drivenKm: number;
  walkedKm: number;
  rejected: number;
}

export interface ScheduledDay<T = unknown> {
  person: number;
  timeline: TimelineEvent<T>[];
  rejected: RejectedIntent<T>[];
  /** Minutes by which the roads made this person late to something fixed. */
  lateMinutes: number;
  metrics: DayMetrics;
  /** Where the resolved timeline finally leaves the person and their vehicle. */
  endState?: {
    at: number;
    place: Place;
    vehicleAt: Place | null | undefined;
  };
}

export interface TransitionRequest {
  person: number;
  day: number;
  from: Place;
  to: Place;
  depart: number;
  purpose: LegPurpose;
  override?: TravelOverride;
  /** Location of the traveller's own vehicle; undefined asks for a feasibility estimate. */
  vehicleAt?: Place | null;
  /** A short walked excursion is safe when the following activity returns to the origin. */
  returnsHere?: boolean;
}

export interface TransitionResult {
  events: TravelEvent[];
  arrive: number;
  /** Where the car ended up, which the caller carries to the next leg. */
  vehicleAt?: Place | null;
}

/**
 * The mobility layer as the planner sees it: two questions, no state.
 *
 * `transition` is the forward question — set off at this minute, when do you
 * arrive and by what route. `latestDeparture` is the backward one — to be there
 * by this minute, when is the last moment you can leave. Both are needed,
 * because a fixed arrival can only be solved backwards while the roads can only
 * be priced forwards, and the two have to agree closely enough that nobody is
 * sent off in time for a journey they are not about to make.
 *
 * Implementations may route (`RoutedMobility`) or fake it (the planner tests).
 */
export interface TransitionPlanner {
  transition(request: TransitionRequest): TransitionResult | null;
  latestDeparture(request: Omit<TransitionRequest, "depart"> & { arriveBy: number }): number | null;
}

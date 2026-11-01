/**
 * The planner: a set of intents in, one day's timeline out.
 *
 * It knows nothing about work, school, shopping or sleep. It is handed a list
 * of requests to be somewhere for a while, each with a policy saying how hard
 * it is to move, and it answers with the sequence of stays and journeys the day
 * actually consists of, plus a list of what it refused and why.
 *
 * Three properties are load-bearing, and most of the decisions below serve one
 * of them:
 *
 *   deterministic   the same intents give the same day, in any input order.
 *                   Every sort has a total tie-break on the stable intent id,
 *                   so nothing depends on how the caller built the list.
 *                   Without it a run is not reproducible and a diff between two
 *                   runs means nothing.
 *
 *   immutable       an intent is never edited. Placement produces separate
 *                   `Placed` records and the timeline is a third structure, so
 *                   what a layer asked for and what the day did are both
 *                   available to compare. A planner that re-times its own
 *                   inputs cannot tell you that it did.
 *
 *   monotone        an insertion that fails changes nothing. Windowed
 *                   activities are admitted one at a time against the day as it
 *                   stands, and a candidate that does not fit is rejected
 *                   outright rather than allowed to shove something already
 *                   admitted. That is what stops one unlucky café from moving
 *                   somebody's shift.
 *
 * Two phases, and the order matters
 * ---------------------------------
 * Fixed activities go down first, as anchors: their start and end came from a
 * shift, a bell or an org's calendar and nothing here may move them. Windowed
 * activities are then fitted into the gaps between the anchors, in policy then
 * time order, each admitted only when both journeys and the full dwell fit.
 *
 * The other way round — flexible first — would let a discretionary stop occupy
 * minutes a shift needs and then have to be evicted, which is exactly the
 * mutation this design exists to avoid.
 */

import { drivenKilometres, walkedKilometres } from "../transport/index.ts";
import type {
  ActivityIntent,
  ActivityPolicy,
  RejectedIntent,
  ScheduledDay,
  StayEvent,
  TimelineEvent,
  TransitionPlanner,
  TravelEvent,
} from "./types.ts";

/** Precedence as a number, so it can be compared and sorted on. */
const POLICY: Record<ActivityPolicy, number> = { required: 0, missable: 1, optional: 2 };

/**
 * A gap longer than this is worth going home for rather than waiting out.
 *
 * Two hours between a shift ending and a meeting starting is not two hours
 * spent standing outside the hall. Below the threshold the person waits — in
 * the building, in the car, at the venue — and above it they go home first,
 * which is two more legs and the reason the evening peak has a second, smaller
 * shoulder.
 *
 * Exported because it is a boundary and not just a number: anything that wants
 * to give someone else something to do with a gap has to know where the gap
 * stops being its business and becomes a trip home.
 */
export const HOME_GAP_MINUTES = 125;

/** An intent, with the minutes the planner decided to give it. */
interface Placed<T> {
  intent: ActivityIntent<T>;
  start: number;
  end: number;
}

export interface PlanRequest<T = unknown> {
  person: number;
  day: number;
  /** Where the day starts and ends, and where a long gap is spent. */
  home: ActivityIntent<T>["place"];
  intents: readonly ActivityIntent<T>[];
  /** Yesterday's authoritative tail, already expressed in today's minutes. */
  opening?: {
    timeline: readonly TimelineEvent<T>[];
    at: number;
    place: ActivityIntent<T>["place"];
    vehicleAt: ActivityIntent<T>["place"] | null | undefined;
  };
}

export function scheduleDay<T>(mobility: TransitionPlanner, request: PlanRequest<T>): ScheduledDay<T> {
  const rejected: RejectedIntent<T>[] = [];
  const fixed = request.intents
    .filter((intent) => intent.timing.kind === "fixed")
    .sort(compareIntents);
  const placed: Placed<T>[] = [];

  for (const intent of fixed) {
    const timing = intent.timing;
    if (timing.kind !== "fixed") continue;
    // An activity that ends before it starts is a fault upstream, not a day to
    // plan around. Reporting it is the point: it lands in `rejected` where a
    // check can find it, rather than producing a timeline that runs backwards.
    if (timing.end <= timing.start) {
      rejected.push({ intent, reason: "outside-window", detail: "fixed activity has no positive duration" });
      continue;
    }
    const openingConflict = request.opening?.timeline.find(
      (event) => overlaps(timing.start, timing.end, event.start, event.end),
    );
    if (openingConflict) {
      rejected.push({ intent, reason: "conflict", detail: "overlaps authoritative opening state" });
      continue;
    }
    const conflicts = placed.filter((other) => overlaps(timing.start, timing.end, other.start, other.end));
    if (conflicts.length === 0) {
      placed.push({ intent, start: timing.start, end: timing.end });
      placed.sort(comparePlaced);
      continue;
    }

    // A stronger fixed request displaces a weaker one — a shift beats a lodge
    // meeting, whichever order the two arrived in. Required/required conflicts
    // stay visible instead: the earlier stable id wins and the other is
    // rejected with a reason, because two unmissable things at once is a fact
    // about the population that should be found rather than smoothed away into
    // overlapping output.
    const blocker = conflicts.find((other) => POLICY[other.intent.policy] <= POLICY[intent.policy]);
    if (!blocker) {
      for (const conflict of conflicts) {
        placed.splice(placed.indexOf(conflict), 1);
        rejected.push({ intent: conflict.intent, reason: "conflict", detail: `displaced by ${intent.id}` });
      }
      placed.push({ intent, start: timing.start, end: timing.end });
      placed.sort(comparePlaced);
    } else {
      rejected.push({ intent, reason: "conflict", detail: `overlaps ${blocker.intent.id}` });
    }
  }

  // A bundle is one person's share of an arrangement other people's days also
  // hold: a rider's wait at the door, the meeting and the drop-off home, or a
  // driver's pickups, the meeting and the drop-offs. Keeping some of it and
  // not the rest leaves a rider waiting for a car that is not coming, or a
  // passenger leg with nobody at the wheel. So a bundle with any member
  // rejected in this phase loses all of them, and the freed minutes are
  // available to the windowed activities below. Rejections made later, while
  // the journeys are compiled, are not unwound: the compile commits vehicle
  // reservations and cannot be repeated.
  const broken = new Set(rejected.flatMap((entry) => entry.intent.bundle ? [entry.intent.bundle] : []));
  if (broken.size > 0) {
    for (let index = placed.length - 1; index >= 0; index -= 1) {
      const bundle = placed[index]!.intent.bundle;
      if (bundle === undefined || !broken.has(bundle)) continue;
      rejected.push({ intent: placed[index]!.intent, reason: "conflict", detail: `bundle ${bundle} incomplete` });
      placed.splice(index, 1);
    }
  }

  const flexible = request.intents
    .filter((intent) => intent.timing.kind === "window")
    .sort(compareIntents);
  for (const intent of flexible) {
    const inserted = insertWindow(
      mobility, request.person, request.day, request.home, placed, intent, request.opening,
    );
    if (inserted) placed.splice(inserted.at, 0, inserted.value);
    else rejected.push({ intent, reason: "outside-window", detail: "no reachable gap fits the activity" });
  }

  const compiled = compile(
    mobility, request.person, request.day, request.home, placed, rejected, request.opening,
  );
  const legs = compiled.timeline.filter((event): event is TravelEvent => event.kind === "travel").map(asLeg);
  return {
    person: request.person,
    timeline: compiled.timeline,
    rejected,
    lateMinutes: compiled.lateMinutes,
    metrics: {
      trips: legs.length,
      drivenKm: drivenKilometres(legs),
      walkedKm: walkedKilometres(legs),
      rejected: rejected.length,
    },
    endState: compiled.endState,
  };
}

/**
 * Find the first gap in the day that can hold this windowed activity.
 *
 * "First" means earliest in the sequence, and the earliest feasible arrival
 * inside it: somebody who could do the shopping at eleven or at four does it at
 * eleven. That is also what makes the answer independent of how many other
 * candidates happened to be tried before this one.
 *
 * The start is found by binary search rather than by stepping minute by minute.
 * The predicate is monotone — if the place can be reached by 11:20 it can be
 * reached by 11:21, because leaving later is always allowed — so bisection
 * finds the earliest reachable arrival in a handful of routing calls instead of
 * a few hundred. Over a hundred and fifteen thousand people a day, that is the
 * difference between minutes and hours.
 *
 * Feasibility is measured against the nominal travel estimate and never against
 * a realised taxi assignment. That is what keeps the two taxi passes closed:
 * the demand pass and the dispatched pass must admit the same activities in the
 * same order, or the cars were allocated to a day that no longer exists. A cab
 * that turns up late makes the person late; it does not make them retroactively
 * change their plans.
 */
function insertWindow<T>(
  mobility: TransitionPlanner,
  person: number,
  day: number,
  home: ActivityIntent<T>["place"],
  placed: readonly Placed<T>[],
  intent: ActivityIntent<T>,
  opening: PlanRequest<T>["opening"],
): { at: number; value: Placed<T> } | null {
  if (intent.timing.kind !== "window") return null;
  const timing = intent.timing;
  if (timing.duration < 0 || timing.latest < timing.earliest + timing.duration) return null;

  for (let at = 0; at <= placed.length; at += 1) {
    const before = placed[at - 1];
    const after = placed[at];
    const from = before?.intent.place ?? opening?.place ?? home;
    // Before the first activity the person is at home and has been all night,
    // so the gap opens wherever the window does rather than at minute zero —
    // which is what lets a bout of sleep that began before midnight be placed
    // at its own negative start.
    const available = before?.end ?? opening?.at ?? Math.min(0, timing.earliest);
    let low = timing.earliest;
    let high = timing.latest - timing.duration;
    let start: number | null = null;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      const leaveBy = mobility.latestDeparture({
        person, day, from, to: intent.place, arriveBy: candidate,
        purpose: intent.purpose, override: intent.arrival,
      });
      if (leaveBy !== null && available <= leaveBy) {
        start = candidate;
        high = candidate - 1;
      } else {
        low = candidate + 1;
      }
    }
    if (start === null) continue;

    // Having got there, how long can they stay? Until the window closes, or
    // until they must set off for whatever is next, whichever comes first.
    let latestEnd = timing.latest;
    if (after) {
      const leaveForNext = mobility.latestDeparture({
        person, day, from: intent.place, to: after.intent.place,
        arriveBy: after.start, purpose: after.intent.purpose,
        override: after.intent.arrival ?? intent.departure,
      });
      if (leaveForNext === null) continue;
      latestEnd = Math.min(latestEnd, leaveForNext);
    }
    // `preferredDuration` is what the activity wants; `duration` is what it will
    // settle for. Sleep compresses between the two. A stop, which sets only the
    // one, simply takes the length it was drawn at or does not happen.
    const duration = Math.min(timing.preferredDuration ?? timing.duration, latestEnd - start);
    if (duration < timing.duration) continue;
    const end = start + duration;
    if (end > timing.latest) continue;
    return { at, value: { intent, start, end } };
  }
  return null;
}

/**
 * Walk the placed activities in order and produce the journeys between them.
 *
 * This is where the day becomes travel. Everything above decided what happens
 * and roughly when; this decides how the person gets from each place to the
 * next, when they have to set off, and how late the roads made them.
 *
 * Departure is solved backwards from the arrival and then clamped forwards by
 * when the person is actually free: somebody at home until 06:30 who needed to
 * leave at 06:11 leaves at 06:30 and is late, rather than setting off nineteen
 * minutes before they got home. The lateness is counted rather than absorbed —
 * a large figure across the city means a layer is placing people in a sequence
 * the roads cannot deliver.
 */
function compile<T>(
  mobility: TransitionPlanner,
  person: number,
  day: number,
  home: ActivityIntent<T>["place"],
  placed: readonly Placed<T>[],
  rejected: RejectedIntent<T>[],
  opening: PlanRequest<T>["opening"],
): {
  timeline: TimelineEvent<T>[];
  lateMinutes: number;
  endState: { at: number; place: ActivityIntent<T>["place"]; vehicleAt: ActivityIntent<T>["place"] | null | undefined };
} {
  const timeline: TimelineEvent<T>[] = [...(opening?.timeline ?? [])];
  let at = opening?.at ?? Math.min(0, placed[0]?.start ?? 0);
  let place = opening?.place ?? home;
  let lateMinutes = 0;
  // Where the car is, which is not wherever its owner is. `undefined` would ask
  // the mobility layer for a feasibility guess; starting at home says the day
  // begins with the car on the drive, which is what makes walking somewhere and
  // then driving home from it impossible rather than free.
  // `null` is authoritative: it means there is no personal vehicle available.
  // Only a genuinely cold plan starts with the household vehicle at home.
  let vehicleAt: ActivityIntent<T>["place"] | null | undefined = opening
    ? opening.vehicleAt
    : home;
  let departureOverride: ActivityIntent<T>["departure"];
  let previousId = opening ? "opening" : "home";
  const openingLast = opening?.timeline.at(-1);
  let previousPurpose: ActivityIntent<T>["purpose"] | null =
    openingLast?.kind === "travel" ? openingLast.purpose : null;

  for (let itemIndex = 0; itemIndex < placed.length; itemIndex += 1) {
    const item = placed[itemIndex]!;
    const gap = item.start - at;
    // Waiting where you are is the right answer when the next thing is in the
    // same building — nobody drives home between two sittings of the same
    // meeting. It is the wrong answer after a school drop-off, where the next
    // thing at that building is the bell at the other end of the school day:
    // the same-place test would hold a parent at the gate for eight hours. So
    // the escort case, and only it, is allowed home from a place it is going
    // to return to. A parent with a job never reaches this branch, because the
    // next thing on their day is the office, which is somewhere else.
    const backHere = samePlace(place, item.intent.place);
    const waitingOutSchool = backHere && previousPurpose === "escort";
    if (!samePlace(place, home) && gap > HOME_GAP_MINUTES && (!backHere || waitingOutSchool)) {
      // Going home has to leave time to get back, which only bites when the
      // return journey is to the place just left: every other case has already
      // been sized by the gap. Test the round trip with estimates before making
      // the real transition: transition may reserve a household VIN and must
      // therefore never be called for a journey we later discard.
      const backInTime = !waitingOutSchool || fitsRoundTrip(
        mobility, person, day, place, home, item, at, vehicleAt, departureOverride, previousId,
      );
      const homeward = backInTime ? mobility.transition({
        person, day, from: place, to: home, depart: at, purpose: "home", vehicleAt,
        override: journeyOverride(departureOverride, `journey/${person}/${day}/${previousId}>home`),
      }) : null;
      if (homeward) {
        // The decision to go home is made from the nominal gap alone. A late
        // dispatched cab may shorten the time at home, but must not change the
        // journey sequence that the demand pass was dispatched against.
        timeline.push(...homeward.events);
        at = homeward.arrive;
        place = home;
        vehicleAt = homeward.vehicleAt;
        departureOverride = undefined;
        previousId = "home";
        previousPurpose = "home";
      }
    }
    // An override on the arriving side wins over one on the departing side: the
    // bus stop knows it is a bus better than the school knows what happens
    // after the bell. Where neither says anything, the journey still gets a
    // stable id derived from both ends, so the same movement is recognisable
    // between two runs.
    const override = journeyOverride(
      item.intent.arrival ?? departureOverride,
      `journey/${person}/${day}/${previousId}>${item.intent.id}`,
    );
    const latest = mobility.latestDeparture({
      person,
      day,
      from: place,
      to: item.intent.place,
      arriveBy: item.start,
      purpose: item.intent.purpose,
      override,
      vehicleAt,
    });
    // A prompt departure leaves when the previous stay ends; see
    // `TravelOverride.prompt`. The other side of the shared journey was timed
    // from that minute.
    const prompt = departureOverride?.prompt === true;
    const depart = latest === null || prompt ? at : Math.max(at, latest);
    const transition = mobility.transition({
      person, day, from: place, to: item.intent.place, depart,
      purpose: item.intent.purpose, override, vehicleAt,
      // Walking away from the car is only safe where the very next thing brings
      // the person back to it. Otherwise the vehicle is stranded, and the day
      // later has somebody driving away from a place their car is not.
      returnsHere: samePlace(placed[itemIndex + 1]?.intent.place ?? home, place),
    });
    // No way to get there at all. The activity does not happen, and says so
    // rather than appearing in the timeline as a teleport.
    if (!transition) {
      rejected.push({ intent: item.intent, reason: "transport-unavailable" });
      continue;
    }
    const arrived = transition.arrive;
    timeline.push(...transition.events);
    vehicleAt = transition.vehicleAt;
    // Arriving late shortens the stay; it does not push the end back. A shift
    // is worked until the shift ends, and a service reached at half past still
    // finishes when it finishes.
    // Early after a prompt departure, the wait is spent at the next stop
    // rather than as a hole in the timeline.
    const start = prompt && arrived < item.start ? arrived : Math.max(item.start, arrived);
    if (start > item.start) lateMinutes += start - item.start;
    if (start >= item.end) {
      // The journey still happened—the dispatched cab or delayed road trip is
      // real—but arriving as the doors close is not a zero-minute activity.
      // Keep the movement and reject the stay, from the place actually reached.
      rejected.push({ intent: item.intent, reason: "outside-window", detail: "arrived after activity ended" });
      at = arrived;
      place = item.intent.place;
      departureOverride = item.intent.departure;
      previousId = item.intent.id;
      previousPurpose = item.intent.purpose;
      continue;
    }
    const end = item.end;
    const stay: StayEvent<T> = {
      kind: "stay",
      activityId: item.intent.id,
      source: item.intent.source,
      place: item.intent.place,
      start,
      end,
      policy: item.intent.policy,
      ...(item.intent.payload === undefined ? {} : { payload: item.intent.payload }),
    };
    timeline.push(stay);
    at = end;
    place = item.intent.place;
    departureOverride = item.intent.departure;
    previousId = item.intent.id;
    previousPurpose = item.intent.purpose;
  }

  // The day closes at the dwelling. Bracketing it this way is what makes the
  // leg count come out at the trip count NHTS would record: somebody who goes
  // out once and comes back has made two trips, not one.
  if ((placed.length || opening?.timeline.length) && !samePlace(place, home)) {
    const homeward = mobility.transition({
      person, day, from: place, to: home, depart: at, purpose: "home", vehicleAt,
      override: journeyOverride(departureOverride, `journey/${person}/${day}/${previousId}>home`),
    });
    if (homeward) {
      timeline.push(...homeward.events);
      at = homeward.arrive;
      place = home;
      vehicleAt = homeward.vehicleAt;
    }
  }
  return { timeline, lateMinutes, endState: { at, place, vehicleAt } };
}

/** Can the estimated round trip fit before committing its homeward journey? */
function fitsRoundTrip<T>(
  mobility: TransitionPlanner,
  person: number,
  day: number,
  from: ActivityIntent<T>["place"],
  home: ActivityIntent<T>["place"],
  item: Placed<T>,
  available: number,
  vehicleAt: ActivityIntent<T>["place"] | null | undefined,
  departureOverride: ActivityIntent<T>["departure"],
  previousId: string,
): boolean {
  const leaveHomeBy = mobility.latestDeparture({
    person, day, from: home, to: item.intent.place, arriveBy: item.start,
    purpose: item.intent.purpose,
    override: journeyOverride(item.intent.arrival, `journey/${person}/${day}/home>${item.intent.id}`),
    vehicleAt,
  });
  if (leaveHomeBy === null) return false;
  const leaveForHomeBy = mobility.latestDeparture({
    person, day, from, to: home, arriveBy: leaveHomeBy, purpose: "home",
    override: journeyOverride(departureOverride, `journey/${person}/${day}/${previousId}>home`),
    vehicleAt,
  });
  return leaveForHomeBy !== null && leaveForHomeBy >= available;
}

/**
 * Keep a supplied journey id where there is one, and mint a stable one where
 * there is not. A shared journey's id is the whole mechanism by which two
 * people's days describe one car, so it must never be overwritten here.
 */
function journeyOverride(
  override: ActivityIntent["arrival"] | ActivityIntent["departure"],
  journeyId: string,
) {
  return { ...override, journeyId: override?.journeyId ?? journeyId };
}

/** Strongest first, then earliest, then by id so the order is total. */
function compareIntents<T>(a: ActivityIntent<T>, b: ActivityIntent<T>): number {
  const aStart = a.timing.kind === "fixed" ? a.timing.start : a.timing.earliest;
  const bStart = b.timing.kind === "fixed" ? b.timing.start : b.timing.earliest;
  return POLICY[a.policy] - POLICY[b.policy] || aStart - bStart || a.id.localeCompare(b.id);
}

/** The placed day, in clock order, with the same total tie-break. */
function comparePlaced<T>(a: Placed<T>, b: Placed<T>): number {
  return a.start - b.start || POLICY[a.intent.policy] - POLICY[b.intent.policy] || a.intent.id.localeCompare(b.intent.id);
}

function overlaps(a: number, b: number, c: number, d: number): boolean {
  return a < d && c < b;
}

/**
 * Two places are the same place when they share an id, or — for the dwellings
 * and kerbside points that have none — when they are the same kind at the same
 * coordinates.
 */
function samePlace(a: ActivityIntent["place"], b: ActivityIntent["place"]): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.kind === b.kind && a.lat === b.lat && a.lon === b.lon;
}

/** Just enough of a `Leg` for the distance meters, which is all they read. */
function asLeg(event: TravelEvent) {
  return {
    purpose: event.purpose,
    mode: event.mode,
    from: { lat: event.from.lat, lon: event.from.lon },
    to: { lat: event.to.lat, lon: event.to.lon },
    fromLabel: event.from.label,
    toLabel: event.to.label,
    depart: event.start,
    arrive: event.end,
    kilometres: event.kilometres,
    estimated: event.estimated,
    ...(event.parking === undefined ? {} : { parking: event.parking }),
    ...(event.wait === undefined ? {} : { wait: event.wait }),
  };
}

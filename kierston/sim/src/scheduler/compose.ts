/**
 * One person, one date: every layer that has an opinion, composed into a day.
 *
 * This module is the seam between the domain layers and the planner. It asks
 * each layer what it wants, turns every answer into an immutable
 * `ActivityIntent`, hands the whole set to `scheduleDay`, and reads the result
 * back out as blocks, legs, stops and attendance. It decides nothing about time
 * itself — no layer here moves an activity, drops one, or routes anything; that
 * is `planner.ts` and `mobility.ts` respectively.
 *
 * Why intents rather than mutable stays
 * -------------------------------------
 * The layers cannot see each other. The commute layer builds the journey to
 * work without knowing a supermarket stop will be inserted into it; the
 * affiliations layer puts someone in a hall at 19:00 without knowing whether
 * they are coming from the office or from their own front door; the sleep layer
 * places a bout before the day has any travel in it at all. Every one of them is
 * therefore proposing, not deciding.
 *
 * An intent says so in the type. It carries a place, a timing — a fixed span or
 * a window — and a policy saying how hard it is to move, and nothing in the
 * pipeline may edit it. The planner answers with a separate timeline, so a
 * layer's proposal and the day's outcome are two distinct objects and can be
 * compared. That is what makes a rejection visible instead of silent: an
 * activity the day had no room for appears in `scheduled.rejected` with a
 * reason, rather than being quietly re-timed into something nobody asked for.
 *
 * Precedence lives in `policy`, not in call order
 * -----------------------------------------------
 * Precedence used to be encoded in the order the layers ran, which made the
 * ranking invisible and changeable only by moving code. Here it is one of three
 * values on every intent:
 *
 *   required   a shift, a bell, a bus run, a fare. Not negotiable, and if two
 *              of them genuinely collide the collision is reported rather than
 *              resolved by whichever happened to be built first
 *   missable   a porous college block, an escort run, a sleep bout — real, but
 *              yielding to something required
 *   optional   shopping, coffee, the pub, the wait between two school runs.
 *              The layer that gives way
 *
 * Nothing below depends on the order the intents are built in: `scheduleDay`
 * sorts by policy and start, so the same set produces the same day whichever
 * way round it arrives.
 *
 * Travel is derived, never proposed
 * ---------------------------------
 * No layer generates its own legs. The planner puts the accepted activities in
 * order and every move between two of them at different places becomes a routed
 * journey. Before that existed only the commute had legs and every other
 * movement in the city was free — the excursion to the supermarket, the walk to
 * lunch, the drive to the Tuesday meeting and back, which together are most of
 * the trips a person makes.
 *
 * The exceptions are the journeys somebody else already priced: a school bus
 * run, a dispatched cab, an escort's car. Those arrive as `arrival`/`departure`
 * overrides carrying a mode, a duration and a stable journey id, so the two
 * halves of one shared trip — the child's and the driver's, the passenger's and
 * the cabbie's — come out of two separate days with the same id on them.
 */

import { homeOf, placeOf, type Person, type Point, type World } from "../world/index.ts";
import { commuteFor, patrolStays, rosterFor, type Block, type PatrolPost, type Tour } from "../activities/work/index.ts";
import { carryFor, sleepBlocks as proposedSleepBlocks } from "../activities/sleep/index.ts";
import { activitiesFor, type DayPlan, type Purpose, type Stop } from "../activities/discretionary/index.ts";
import type { Attendance } from "../activities/social/index.ts";
import { meetingsFor, rideSpans, type Meeting } from "../activities/social/index.ts";
import { driverStays, escortStays, riderStays, usualFor } from "../activities/school/index.ts";
import {
  cabbieStays,
  DRIVER_ROLE,
  Fleet,
  hirerFor,
  requestsIn,
  stands,
} from "../transport/index.ts";
import { LAYER, stream, type Timings } from "../shared/index.ts";
import {
  HOME_LABEL,
  drivenKilometres,
  modeOf,
  taxiKilometres,
  walkedKilometres,
  type Leg,
  type Place,
  type Sojourn,
} from "../transport/index.ts";
import type { Cohort, DayContext } from "../engine/index.ts";
import {
  INCIDENT_KINDS, ambulanceStays, respondingTour, type AmbulanceStop,
} from "../dispatch/index.ts";
import { RoutedMobility } from "./mobility.ts";
import { HOME_GAP_MINUTES, scheduleDay } from "./planner.ts";
import { PrivateVehicleFleet } from "./private_vehicles.ts";
import type { ActivityIntent, ScheduledDay, TimelineEvent, TravelEvent } from "./types.ts";

/**
 * What produced an intent, kept so the outcome can be handed back to it.
 *
 * The planner is generic over this: it never looks inside a payload, it only
 * carries it through to the stay the intent becomes. That is what lets this
 * module take a timeline which is nothing but places and minutes and
 * reconstitute a stop with its venue, a visit with its occurrence, and a sleep
 * bout with the hours it really got.
 */
type Payload =
  | { kind: "recorded"; recordKind: Exclude<Entry["kind"], "travel">; label: string; where: string | null }
  | { kind: "work"; block: Block; label: string; where: string | null }
  | { kind: "school"; block: Block; label: string; where: string | null }
  | { kind: "sleep"; label: string; where: null }
  | { kind: "affiliation"; visit: Attendance; label: string; where: string | null }
  // `stop` is absent on a stop nobody drew from the activity demand — the wait
  // between two school runs is a real stop at a real venue, but it has no
  // trip-generation record behind it and must not be counted as one.
  //
  // `purpose` is carried separately for exactly that case. It is what the
  // person went in to do, and `spend.ts` prices from it; a venue's own
  // `purposes` list cannot answer it, because a café that is also a bakery
  // sells a coffee to one visitor and a week's bread to the next.
  | { kind: "stop"; stop?: Stop; purpose?: Purpose; label: string; where: string | null }
  | { kind: "meet"; meeting: Meeting; label: string; where: string | null }
  | { kind: "shared-travel"; label: string; where: string | null };

export interface Day {
  person: number;
  /** The planner's own answer: the timeline, what it refused, and why. */
  scheduled: ScheduledDay<Payload>;
  /** Roster blocks, plus the sleep bouts as the day actually allowed them. */
  blocks: Block[];
  /**
   * The provisional commutes. Kept because they are what decided when the
   * person is at work and which corridor their journey runs down, and because
   * their notes say why someone has no journey at all. The legs the day
   * actually contains are `legs`, not these.
   */
  tours: Tour[];
  /** Every movement the person makes, in order, routed. */
  legs: Leg[];
  /** The visits that survived: the ones the planner found room to reach. */
  attendance: Attendance[];
  plan: DayPlan;
  drivenKm: number;
  walkedKm: number;
  /**
   * Cab kilometres, split by whether anyone was in the back. Zero for everyone
   * who is not driving one, which is everyone but a hundred and forty-six people.
   */
  cabKm: { loaded: number; empty: number };
  /** Trips, counted the way NHTS counts them: one per leg. */
  trips: number;
  /** Minutes by which the roads made this person late to something fixed. */
  late: number;
}

/**
 * Allocate the fleet for one date, by finding out what it is being asked for.
 *
 * The two passes `taxi.ts` describes, and the only place they are visible. The
 * first plans the day of everyone who might order a cab, with no fleet in the
 * context, purely to collect the requests; the second matches cars to them. The
 * days built by the first pass are thrown away — they exist to be measured, the
 * way `--measure-runs` builds bus routes it does not keep.
 *
 * Who might order one is `hire.ts`'s question and not this module's: the people
 * whose commute answer was a taxicab, plus the far larger group with no car
 * available to them at all. Nothing else in the simulation can produce a `taxi`
 * leg — a student's mode comes from `usualFor`, which never returns one, and no
 * layer sets it on a stay — so the two together are the whole of the demand.
 *
 * A driver is excluded because a driver is not a passenger, and a good many of
 * the hundred and forty-six of them keep no car of their own. They are the one
 * group whose day genuinely differs between the two passes — the second gives
 * them a shift's worth of fares the first could not know about — so demand
 * harvested from them is demand for trips they are not making. It was the whole
 * of the worst request drift the checks reported.
 *
 * A cohort narrows both halves of that at once. The demand pass runs over the
 * cohort's people rather than the city's, and the fleet is thinned by the same
 * step — see `Cohort`, which is where the argument for keeping the two in step
 * is written down. Absent, this is the whole city, which is what every run that
 * exports or measures a real day wants.
 */
export function dispatchFor(
  context: DayContext, date: Date, day: number, cohort?: Cohort, timings?: Timings,
): Fleet {
  const all = context.stands ?? stands(context.world);
  const demand: DayContext = {
    ...context, stands: all, fleet: null, householdPlanner: undefined,
  };
  const requests = [];
  // The demand pass and the matching are timed apart because they are not the
  // same kind of work: the first is one planned day per possible passenger and
  // is as parallel as the export loop it duplicates, and the second is the one
  // step in a day that has to see the whole city at once.
  const harvest = performance.now();
  for (const person of cohort?.people ?? context.world.persons.values()) {
    if (hirerFor(context.world, person, context.hire).usual !== "taxi") continue;
    if (context.world.assignments.get(person.id)?.role === DRIVER_ROLE) continue;
    requests.push(...requestsIn(person.id, planPersonDay(demand, person, date, day).legs));
  }
  const matched = timings?.since("dispatch: demand pass", harvest) ?? performance.now();
  const fleet = Fleet.build(
    context.world, context.roads, date, day, requests, all, cohort?.step ?? 1,
    context.state?.fleetForDay() ?? [],
  );
  timings?.since("dispatch: match fleet", matched);
  return fleet;
}

/** Ask every layer what this person wants today, then let the planner answer. */
export function planPersonDay(context: DayContext, person: Person, date: Date, day: number): Day {
  const { world } = context;
  const home = homeOf(world, person);
  const today = rosterFor(world, person, date, day);

  /**
   * What yesterday left running, and when this person would sleep.
   *
   * Recomputed from a three-day roster window rather than carried from a stored
   * previous day — see `sleep.ts`. The overhang is a commitment and not a
   * journey: the officer who comes off the night watch at 07:00 travels home in
   * *yesterday's* plan, at minute 1861, and that leg is already counted there.
   * Adding it again here would give the city a second morning peak made
   * entirely of trips it has already made.
   */
  const generatedCarry = carryFor(world, person, date, day);
  const opening = context.state?.openingFor(person.id) ?? null;
  // Once a chronological state exists, its continuation is the authority.
  // The bounded sleep reconstruction still proposes tonight's new bout, but
  // must not independently redraw the morning already carried from yesterday.
  const carry = opening
    ? {
        overhang: [],
        bouts: generatedCarry.bouts.filter((bout) => !opening.continuation.some(
          (event) => bout.start < event.end && event.start < bout.end,
        )),
      }
    : generatedCarry;
  const domainBlocks = [...today, ...proposedSleepBlocks(carry.bouts)];

  // Only a work block implies a commute, and not even all of those. A school
  // block's journey is decided by the school layer — which mode, which bus,
  // whose car — and handing it to `commuteFor` would price it as a commute the
  // person's JWTRNS never described and, for a child with no assignment at all,
  // dereference one that does not exist.
  //
  // A bus driver is the same exclusion for the opposite reason: their journey
  // to the depot and everything after it is the run, which `school.ts` builds
  // as stays. Letting the commute layer also build a trip to the depot gives
  // them two arrivals at one place and a day with the morning driven twice.
  //
  // A cab driver is excluded for both reasons at once. Their whole shift is the
  // dispatcher's, and the site `init_work.py` gave them is their own front door
  // — so a commute to it is a journey of nought kilometres to a workplace that
  // is not one, and a stay at it that would sit across every fare they take.
  const working = today.filter(
    (block) => block.kind === "work" && block.role !== "school_bus_driver" && block.role !== DRIVER_ROLE,
  );
  const tours = working.map((block) => commuteFor(context, person, block, day));
  const tour = tours.find((candidate) => candidate.legs.length > 0) ?? tours[0] ?? null;
  const emptyPlan: DayPlan = { person: person.id, stops: [], trips: 0, extraKm: 0 };

  // Nothing can be planned around a dwelling that was never placed. Those few
  // people keep their surveyed blocks and their commute legs and nothing else,
  // which is what `entries` falls back to printing.
  if (!home) return empty(person.id, today, tours, emptyPlan);
  const homePlace: Place = { ...home, id: null, kind: "home", label: HOME_LABEL };

  /**
   * The officers whose shift is spent driving the city rather than sitting in
   * the station they are posted to.
   *
   * Kept alongside `working` rather than replacing it, because a patrol officer
   * still makes the commute every other worker makes: they drive their own car
   * to the station, leave it there for eight hours, and drive it home. What the
   * patrol layer replaces is the *stay* — one immovable eight-hour block at a
   * building becomes a roll call, a watch, and the paperwork afterwards — so
   * the block's own intent is suppressed below and these stand in for it.
   */
  const runs = context.calls?.byPerson.get(person.id) ?? [];
  const patrol = working.map((block) => {
    const tour = patrolStays(context, person, block, date, day);
    return tour.length > 0 && runs.length > 0 ? respondingTour(tour, runs) : tour;
  });

  const duty = context.calls?.ambulances.get(person.id);
  const ambulance = duty && runs.length > 0 && working[0]
    ? ambulanceStays(duty, runs, person.id, day, working[0].end)
    : [];

  const hold = context.calls?.holds.get(person.id) ?? null;

  const intents: ActivityIntent<Payload>[] = [];

  /**
   * Work.
   *
   * The commute layer has already drifted this person's arrival and departure
   * to carry their punctuality, so a tour's first arrival and last departure
   * are better times than the block's own — where a tour exists. Where it does
   * not, the block is the answer: working from home, or a shift starting at the
   * dwelling.
   *
   * Off-map work is the case worth explaining. Somebody whose workplace is
   * outside the extract makes a real journey of a real duration that this city
   * cannot route, because half of it is off the edge of the road graph. Rather
   * than drop them or invent a destination, the block becomes an intent at a
   * synthetic place with the survey's own durations attached as arrival and
   * departure overrides — so the planner spends the right number of minutes
   * getting them there and back without pretending to know the road.
   */
  for (let index = 0; index < working.length; index += 1) {
    const block = working[index]!;
    // A watch the patrol layer has taken over. Emitting the block as well would
    // be two required intents over the same eight hours, which the planner is
    // right to report as a collision rather than resolve.
    if ((patrol[index]?.length ?? 0) > 0) continue;
    if (index === 0 && ambulance.length > 0) continue;
    const provisional = tours[index];
    const external = block.mode === "external" || provisional?.offMap;
    const externalLeg = provisional?.legs[0];
    const site = block.mode === "home"
      ? homePlace
      : external
        ? {
            ...(externalLeg?.to ?? homePlace),
            id: `off-map/${person.id}/${block.start}`,
            kind: "work" as const,
            label: "off the map",
          }
        : place(world, block.site, "work", block.role ?? "work");
    if (!site) continue;
    let start = provisional?.legs[0]?.arrive ?? block.start;
    const end = provisional?.legs.at(-1)?.depart ?? block.end;
    if (hold && hold.from <= start && hold.until > start && hold.until < end) start = hold.until;
    // A fixed shift overlapping a school block is somebody with both a job and
    // a timetable, most often a college student on a porous block. Leaving the
    // shift required would have the planner reject the bell, which is the wrong
    // way round: school keeps its anchor and the work becomes missable.
    const conflictsWithSchool = today.some(
      (other) => other.kind === "school" && start < other.end && other.start < end,
    );
    intents.push({
      id: `work/${person.id}/${index}/${block.site ?? "home"}/${block.start}`,
      source: "work",
      place: site,
      timing: { kind: "fixed", start, end },
      policy: block.fixed && !conflictsWithSchool ? "required" : "missable",
      purpose: "work",
      arrival: external && externalLeg
        ? { mode: externalLeg.mode, minutes: externalLeg.arrive - externalLeg.depart }
        : undefined,
      departure: external && provisional?.legs.at(-1)
        ? {
            mode: provisional.legs.at(-1)!.mode,
            minutes: provisional.legs.at(-1)!.arrive - provisional.legs.at(-1)!.depart,
          }
        : undefined,
      payload: { kind: "work", block, label: block.role ?? "work", where: block.site },
    });
  }

  /**
   * School, which is the same shape as work: a fixed stay the rest of the day
   * is solved around. College is the exception the roster already marked
   * porous, and it arrives here as a stay that can move.
   *
   * Both journeys are the school layer's and not the planner's. Where a child
   * was brought by bus, the leg in is the bus and its length is the run's, not
   * this hop's; the leg out is decided separately and is often a different mode,
   * because a child who walked in is frequently collected by car.
   */
  const rider = world.school.riders.get(person.id);
  const school = rider
    ? riderStays(world, context.roads, rider, date, day)
    : { stays: [], trips: [], arrival: {}, departure: {} };
  for (const block of today) {
    if (block.kind !== "school") continue;
    const site = place(world, block.site, "school", block.role ?? "school");
    if (!site) continue;
    intents.push({
      id: `school/${person.id}/${block.site}/${block.start}`,
      source: "school",
      place: site,
      timing: { kind: "fixed", start: block.start, end: block.end },
      policy: block.fixed ? "required" : "missable",
      purpose: "school",
      arrival: { ...school.arrival, journeyId: `school/${person.id}/${day}/am` },
      departure: { ...school.departure, journeyId: `school/${person.id}/${day}/pm` },
      payload: { kind: "school", block, label: block.role ?? "school", where: block.site },
    });
  }

  // Everywhere this person is because of somebody else's journey: the bus stop
  // a child waits at, the school gate a parent pulls into, every stop on a
  // driver's route, and every pickup, set-down and stand of a cabbie's shift.
  // All of them are priced off a run or an allocation this module could not
  // have derived, and each one's other half is already in another person's day.
  // That is what puts two people in one car without either of them planning the
  // other's Tuesday.
  const escorts = escortStays(world, person, date, day);
  for (const [index, stays] of patrol.entries()) addPatrol(intents, person, day, index, stays);
  addAmbulance(intents, person, day, ambulance);
  if (hold) {
    intents.push({
      id: `incident/${person.id}/${day}/${hold.incident}`,
      source: "incident",
      place: hold.place,
      timing: { kind: "fixed", start: hold.from, end: hold.until },
      policy: "required",
      purpose: "stop",
      payload: {
        kind: "recorded", recordKind: "incident",
        label: `911 · ${INCIDENT_KINDS[hold.kind]?.label ?? "call"}`, where: hold.place.id,
      },
    });
  }
  addShared(intents, person.id, day, "rider", school.stays);
  addShared(intents, person.id, day, "escort", escorts);
  addShared(intents, person.id, day, "bus", driverStays(world, context.roads, person, date, day));
  if (context.fleet) addShared(intents, person.id, day, "taxi", cabbieStays(context.fleet, person));

  /**
   * Shared activities: two people who arranged to be somewhere together.
   *
   * Derived here — before `taken`, and therefore before both the affiliation
   * draw and the discretionary draw — because that ordering *is* the
   * precedence. An arrangement to meet a friend is not stronger than a lodge
   * night in the planner's sense; both are fixed and missable, and a planner
   * that had to choose between them would resolve it on whichever started
   * earlier, which is not a reason anybody would recognise. Putting the
   * meeting in first means the two layers below simply work around it: the
   * affiliation is never drawn, and the tour layer never puts a stop across
   * it. Somebody skipping the shops because they are seeing a friend is then
   * a consequence of the sequence rather than a rule anywhere.
   *
   * The other direction — arranging around the lodge rather than over it —
   * is `meetings.ts`'s business and happens before this line. It has to be:
   * only that module can see both parties.
   */
  const meetings = meetingsFor(
    { world, graph: context.ties, venues: context.venues, affiliations: context.affiliations, date, day },
    person,
  );
  for (const meeting of meetings) addMeeting(intents, person, homePlace, meeting);

  // What the roster and the commute have already taken, as the draw sees it.
  //
  // The scheduler still owns conflict *rejection* — this predicate is not that.
  // `gymVisit` uses it to pick which of its four slots the visit happens in, so
  // answering "yes, always" does not defer the decision to the scheduler, it
  // deletes it: the gym lands on the habitual hour whatever is there, and the
  // scheduler can only throw it away. Only commitments that are known before
  // scheduling are offered here.
  const taken: [number, number][] = [];
  for (const block of today) if (block.fixed) taken.push([block.start, block.end]);
  for (const block of carry.overhang) if (block.fixed) taken.push([block.start, block.end]);
  for (const provisional of tours) {
    for (const leg of provisional.legs) taken.push([leg.depart, leg.arrive]);
  }
  for (const bout of carry.bouts) taken.push([bout.latest, bout.end]);
  // The meeting itself, plus the journeys either side of it. A membership
  // whose night this covers produces no visit, which is the displacement the
  // sequence above exists to produce.
  for (const meeting of meetings) taken.push(...meetingSpans(meeting, person.id));
  const free = (from: number, to: number) => taken.every(([a, b]) => to <= a || from >= b);

  /**
   * Affiliations: a service, a training night, a lodge meeting.
   *
   * Fixed by an org's calendar rather than by this person, so the timing cannot
   * bend around them — but missable, because somebody who could not get there
   * simply did not go, and that has to be recoverable. A visit the planner
   * rejects is dropped from `attendance` below, or the co-presence pools would
   * count somebody who never arrived.
   *
   * Seventeen union locals in the extract have no premises: a local exists as a
   * body of members and OSM has no building for it. There is nowhere to travel
   * to, so those produce no intent at all — the alternative is a leg to a null
   * coordinate, which the router silently prices as a drive across town.
   */
  const attendance = context.affiliations.dayFor(person, date, day, free);
  for (const visit of attendance) {
    const org = context.affiliations.orgs.get(visit.occurrence.org);
    if (!org || !Number.isFinite(org.lat) || !Number.isFinite(org.lon)) continue;
    intents.push({
      id: `affiliation/${person.id}/${visit.occurrence.org}/${visit.occurrence.start}`,
      source: "affiliation",
      place: { lat: org.lat, lon: org.lon, id: org.id, kind: "org", label: org.name || org.id },
      timing: { kind: "fixed", start: visit.arrive, end: visit.leave },
      policy: "missable",
      purpose: "affiliation",
      payload: {
        kind: "affiliation", visit,
        label: `${visit.occurrence.class} · ${org.name || visit.occurrence.org}`,
        where: visit.occurrence.org,
      },
    });
  }

  /**
   * Errands: the shop, the coffee, the pub. The only layer that yields
   * entirely, and the only one offered as a window rather than a span — the
   * draw decides what the visit is and roughly when, and the planner decides
   * whether the day can hold it and where exactly it lands.
   *
   * `committed` is what the tour layer must not draw across. The twelve-minute
   * cushion either side of a visit is not slack for travel; it is the
   * difference between attending a meeting and standing in the doorway of one.
   */
  const committed: [number, number][] = [
    ...meetings.flatMap((meeting) => meetingSpans(meeting, person.id)),
    ...attendance.map((visit) => [visit.arrive - 12, visit.leave + 12] as [number, number]),
    ...carry.bouts.map((bout) => [bout.latest, bout.end] as [number, number]),
    ...carry.overhang.map((block) => [block.start, block.end] as [number, number]),
  ];
  const plan = activitiesFor(context, person, date, day, domainBlocks, tour, committed);
  for (const [index, stop] of plan.stops.entries()) {
    const duration = Math.max(1, stop.leave - stop.arrive);
    intents.push({
      id: `stop/${person.id}/${day}/${stop.purpose}/${stop.venue.id}/${index}`,
      source: "stop",
      place: {
        lat: stop.venue.lat, lon: stop.venue.lon, id: stop.venue.id,
        kind: "venue", label: stop.venue.name || stop.venue.tag,
      },
      // A window, and now one wide enough to be worth searching. `latest` used
      // to be `stop.leave`, which made the span exactly the duration and left
      // the planner a single candidate minute — the one `tours.ts` named with
      // a travel estimate that did not include parking. See `Demand.slack`.
      //
      // Only the late side opens. Arriving *earlier* than drawn is already
      // handled, because the gap search is bounded below by when the person is
      // free rather than by this, and letting the draw slide backwards bought
      // nothing measurable when it was tried.
      timing: { kind: "window", earliest: stop.arrive, latest: stop.leave + stop.slack, duration },
      policy: "optional",
      purpose: "stop",
      payload: {
        kind: "stop", stop, purpose: stop.purpose,
        label: `${stop.purpose} · ${stop.venue.name || stop.venue.tag}`,
        where: stop.venue.id,
      },
    });
  }

  /**
   * Sleep, offered as a compressible window.
   *
   * The bout is drawn before the day has any travel in it, so its span is what
   * this person would have slept on an empty evening. `preferredDuration` asks
   * for all of it and `duration` says what would still count as a night, which
   * lets the planner trim the bout against a late arrival home rather than
   * reject the whole night because the preferred length no longer fits.
   *
   * Nothing is banked: the cost of a late night is paid that night, and the
   * next day starts fresh.
   */
  for (const [index, bout] of carry.bouts.entries()) {
    const earliest = bout.start;
    const latest = bout.end;
    // A fixed interruption — a school escort, a night shift, a shared run — can
    // split the principal bout into a short recovery sleep. Ninety minutes is
    // one complete sleep cycle; below that we reject it rather than manufacture
    // a few minutes of nominal "sleep".
    const minimum = Math.min(90, latest - earliest);
    if (latest - earliest < 30) continue;
    intents.push({
      id: `sleep/${person.id}/${day}/${index}`,
      source: "sleep",
      place: homePlace,
      timing: {
        kind: "window", earliest, latest, duration: Math.min(minimum, latest - earliest),
        preferredDuration: latest - earliest,
      },
      policy: "missable",
      purpose: "home",
      payload: { kind: "sleep", label: "asleep", where: null },
    });
  }

  const waiting = escortWait(context, person, day, escorts, intents);
  if (waiting) intents.push(waiting);

  /**
   * How this person gets about, and how everyone else does.
   *
   * The policy is a function rather than a single mode because the mobility
   * layer prices journeys made by other people too — a driver collecting a
   * child travels by the driver's mode, not the child's. A student's own answer
   * is the school run and it outranks the household car: they are somebody's
   * passenger either way, and a child in a carless household is not ordering a
   * cab.
   */
  const hirer = hirerFor(world, person, context.hire);
  const mobility = new RoutedMobility(
    {
      roads: context.roads,
      kerb: context.kerb,
      seed: world.seed,
      dispatch: context.fleet ?? null,
      hireShare: hirer.share,
    },
    world.persons,
    (candidate) => {
      const schoolRider = world.school.riders.get(candidate.id);
      const hired = hirerFor(world, candidate, context.hire);
      return { usual: (schoolRider ? usualFor(schoolRider) : null) ?? hired.usual ?? modeOf(candidate), hireShare: hired.share };
    },
  );

  const scheduled = scheduleDay(mobility, {
    person: person.id,
    day,
    home: homePlace,
    intents,
    ...(opening && opening.resumePlace ? {
      opening: {
        timeline: opening.continuation,
        at: opening.resumeAt,
        place: opening.resumePlace,
        vehicleAt: opening.vehicle?.location,
      },
    } : {}),
  });

  // Hand the resolved times back to the layers that produced them. A stop that
  // reads 18:10 while the leg reaching it arrives at 18:24 is not two views of
  // one day, and the timeline would print both. Anything with no stay in the
  // timeline was rejected, and is dropped here rather than reported as having
  // happened.
  const legs = scheduled.timeline.filter((event): event is TravelEvent => event.kind === "travel").map(toLeg);
  const resolvedAttendance = attendance.flatMap((visit) => {
    const id = `affiliation/${person.id}/${visit.occurrence.org}/${visit.occurrence.start}`;
    const stay = scheduled.timeline.find((event) => event.kind === "stay" && event.activityId === id);
    return stay && stay.kind === "stay" ? [{ ...visit, arrive: stay.start, leave: stay.end }] : [];
  });
  const resolvedStops = plan.stops.flatMap((stop, index) => {
    const id = `stop/${person.id}/${day}/${stop.purpose}/${stop.venue.id}/${index}`;
    const stay = scheduled.timeline.find((event) => event.kind === "stay" && event.activityId === id);
    return stay && stay.kind === "stay" ? [{ ...stop, arrive: stay.start, leave: stay.end }] : [];
  });
  // Sleep comes back as a block because that is what every consumer of a day
  // expects to find it as; the bout it was drawn from is gone by here.
  const slept: Block[] = scheduled.timeline.flatMap((event) => {
    if (event.kind !== "stay" || event.source !== "sleep") return [];
    return [{ kind: "sleep", start: event.start, end: event.end, site: null, mode: "home", fixed: true } as Block];
  });
  const keptPlan = {
    ...plan,
    stops: resolvedStops,
    extraKm: resolvedStops.reduce((total, stop) => total + stop.detourKm, 0),
  };
  return finish(person.id, [...today, ...slept], tours, resolvedAttendance, keptPlan, scheduled, legs);
}

/**
 * Plan one household against a shared, live fleet.
 *
 * Every accepted car transition reserves its VIN while that final transition
 * is being emitted. The fleet accepts out-of-order insertion, so composing one
 * member before another cannot create an overlap or a broken location chain.
 */
export class HouseholdDayPlanner {
  private readonly cached = new Map<number, Day>();
  private readonly members = new WeakMap<World, Map<number, Person[]>>();

  plan(context: DayContext, person: Person, date: Date, day: number): Day {
    const known = this.cached.get(person.id);
    if (known) return known;
    const household = this.households(context.world).get(person.household) ?? [person];
    const opening = (context.world.householdVehicles.get(person.household) ?? []).flatMap((vin) => {
      const row = context.state?.vehicleForDay(vin);
      return row ? [row] : [];
    });
    const vehicles = PrivateVehicleFleet.build(context.world, person.household, household, opening);
    const planningContext: DayContext = { ...context, householdPlanner: undefined };
    const days = household.map((member) => planPersonDay(planningContext, member, date, day));
    vehicles.execute(days);
    for (const memberDay of days) this.cached.set(memberDay.person, memberDay);
    return this.cached.get(person.id)!;
  }

  /** Release packed days so a full export retains at most one household. */
  release(person: number): void {
    this.cached.delete(person);
  }

  private households(world: World): Map<number, Person[]> {
    const known = this.members.get(world);
    if (known) return known;
    const out = new Map<number, Person[]>();
    for (const person of world.persons.values()) {
      // Match the exported population: an omitted driver's trips must not
      // move cars that the remaining household members subsequently use.
      if (person.incarcerated) continue;
      const mine = out.get(person.household) ?? [];
      mine.push(person);
      out.set(person.household, mine);
    }
    for (const mine of out.values()) mine.sort((a, b) => a.id - b.id);
    this.members.set(world, out);
    return out;
  }
}

/** Public entry: coordinated where a household planner is installed. */
export function planDay(context: DayContext, person: Person, date: Date, day: number): Day {
  // Direct queries and demand passes obey the same custody exclusion as the
  // city exporter; there is no ordinary city itinerary to plan in prison.
  if (person.incarcerated) return dayFromTimeline(person.id, []);
  return context.householdPlanner?.plan(context, person, date, day)
    ?? planPersonDay(context, person, date, day);
}

/** Below this there is nothing to do but wait: the journey would eat the gap. */
const WORTH_LEAVING_MINUTES = 40;

/**
 * How often a short wait is spent somewhere rather than at the gate.
 *
 * A stated assumption, not a fitted one. NHTS records the trips people make,
 * not the ones they considered, so there is no direct measurement of how many
 * parents with an hour to kill drive to a café — the number to calibrate this
 * against is the school-hours share of off-peak trips, once that check exists.
 */
const GOES_SOMEWHERE = 0.4;

/** Where they go. Weighted by what is plausibly open and near a school. */
const WAITING_PLACES: readonly [Purpose, number][] = [
  ["cafe", 0.3], ["grocery", 0.22], ["convenience", 0.14],
  ["retail", 0.14], ["park", 0.12], ["food-quick", 0.08],
];

/** The least useful stay worth making the journey for. */
const MIN_STAY_MINUTES = 20;

/**
 * Somewhere to be between two school runs.
 *
 * Both escort stays are at the same school, which is the whole difficulty: to
 * the planner the second one is a return to a place already occupied, so it
 * holds the parent there for the entire gap unless something else is put in
 * it. For a long gap that something is home. For a short one it is this — a
 * draw over whether the wait is spent on the spot or somewhere nearby that is
 * open, offered as a window the planner is free to reject when the journeys
 * and the stay do not fit between the bells.
 *
 * Only for a parent with nothing else on. Anyone with work, an appointment or
 * a sleep bout in the gap already has a place to be, and the intent that says
 * so is in `intents` before this runs.
 */
function escortWait(
  context: DayContext,
  person: Person,
  day: number,
  escorts: readonly Sojourn<unknown>[],
  intents: readonly ActivityIntent<Payload>[],
): ActivityIntent<Payload> | null {
  const runs = [...escorts].sort((a, b) => a.arrive - b.arrive);
  for (const [index, drop] of runs.entries()) {
    const pickup = runs[index + 1];
    if (!pickup || !samePlace(drop.place, pickup.place)) continue;
    const gap = pickup.arrive - drop.leave;
    if (gap <= WORTH_LEAVING_MINUTES || gap > HOME_GAP_MINUTES) continue;
    if (intents.some((intent) => busyBetween(intent, drop.leave, pickup.arrive))) continue;

    const rng = stream(context.world.seed, person.id, LAYER.escortWait, day, Math.round(drop.leave));
    if (!rng.bool(GOES_SOMEWHERE)) return null;
    const purpose = rng.weighted(
      WAITING_PLACES.map(([name]) => name),
      WAITING_PLACES.map(([, weight]) => weight),
    );
    // Open at roughly when they would arrive, not when they left the school:
    // the point of the draw is somewhere they can actually go in.
    const venue = context.venues.choose(drop.place, purpose, rng, drop.leave + 10);
    if (!venue) return null;

    return {
      id: `escort-wait/${person.id}/${day}/${Math.round(drop.leave)}/${venue.id}`,
      source: "stop",
      place: {
        lat: venue.lat, lon: venue.lon, id: venue.id,
        kind: "venue", label: venue.name || venue.tag,
      },
      // The stay is whatever is left of the gap once both journeys are paid
      // for; the planner works that out from `latest` and trims the preferred
      // duration to it. Waiting there until the bell is the behaviour — nobody
      // drives to a café for twenty minutes and then back to the gate to wait.
      timing: {
        kind: "window",
        earliest: drop.leave,
        latest: pickup.arrive,
        duration: Math.min(MIN_STAY_MINUTES, gap),
        preferredDuration: gap,
      },
      policy: "optional",
      purpose: "stop",
      payload: {
        kind: "stop",
        purpose,
        label: `waiting · ${venue.name || venue.tag}`,
        where: venue.id,
      },
    };
  }
  return null;
}

/** Does this intent already claim part of the gap? Windows count as claims. */
function busyBetween(intent: ActivityIntent<Payload>, from: number, to: number): boolean {
  if (intent.purpose === "escort") return false;
  const [start, end] = intent.timing.kind === "fixed"
    ? [intent.timing.start, intent.timing.end]
    : [intent.timing.earliest, intent.timing.latest];
  return start < to && from < end;
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.kind === b.kind && a.lat === b.lat && a.lon === b.lon;
}

/**
 * Turn somebody else's journey into intents on this person's day.
 *
 * The stays arrive already priced, so each becomes a fixed intent with the
 * arriving mode and duration attached as an override: the planner must not
 * re-route a bus run or a dispatched fare it did not decide. `required` for a
 * run or a fare, because that is the job; `missable` for an escort, because a
 * parent whose shift collides with the school gate has to be allowed to lose
 * the gate rather than the shift.
 *
 * Deduplicated by time and place because two layers can describe the same
 * moment — a driver's last set-down and their return to the stand, most often —
 * and two intents at one place in one minute is a conflict with itself.
 */
/**
 * How much of the clock either side of a meeting is spoken for.
 *
 * The same nominal allowance `meetings.ts` used to decide the meeting was
 * possible, repeated here for what it blocks out. Wider than the twelve
 * minutes an affiliation gets because a meeting is more often across town: an
 * org is somewhere you belong and is usually near where you live, and a
 * restaurant is chosen between two homes.
 */
const MEET_PAD = 25;

/**
 * What a meeting takes out of this person's day: the meeting with its travel
 * pad, and the minutes a lift adds before and after it.
 */
function meetingSpans(meeting: Meeting, person: number): [number, number][] {
  return [[meeting.start - MEET_PAD, meeting.end + MEET_PAD], ...rideSpans(meeting, person)];
}

/**
 * One meeting, as it appears in one attendee's day.
 *
 * Everybody gets the stay. The lift, where there is one, is read from the
 * route `meetings.ts` settled for every party at once (`Ride.pickups` and
 * `Ride.dropoffs`), so the driver and each rider are handed the same door and
 * the same minutes:
 *
 *   rider    waits at home for their pickup stop and leaves at its `leave`,
 *            riding as a passenger under the outbound journey id for the
 *            minutes the route gives; on the way back rides under the inbound
 *            id to a stay at home at their drop-off stop. Their own car stays
 *            at home, because they leave from it and come back to it.
 *   driver   a fixed stay at each door in visiting order, leaving each one
 *            promptly, under the same journey ids. A door shared with the
 *            driver is the driver's own home, which is where a household
 *            leaves from together.
 *
 * Every intent one person has for one meeting is one bundle: the planner keeps
 * all of it or none of it, so nobody keeps a pickup for a meeting they dropped
 * or a passenger leg without the wait at the door that goes with it.
 *
 * Arrival minutes at the venue can still differ by a few minutes between the
 * two sides: the rider's leg takes the route's estimate and the driver's is
 * routed. Both leave the door at the same minute.
 */
function addMeeting(
  intents: ActivityIntent<Payload>[],
  person: Person,
  homePlace: Place,
  meeting: Meeting,
): void {
  const venue = meeting.venue;
  const at: Place = {
    lat: venue.lat, lon: venue.lon, id: venue.id, kind: "venue",
    label: venue.name || venue.tag,
  };
  const outbound = `${meeting.id}/out`;
  const inbound = `${meeting.id}/back`;
  const ride = meeting.ride;
  const bundle = `${meeting.id}/person/${person.id}`;
  const label = `${meeting.kind === "household" ? "outing" : "meeting"} · ${venue.name || venue.tag}`;
  const driving = ride !== null && ride.driver === person.id;
  const pickup = ride && !driving ? ride.pickups.find((stop) => stop.riders.includes(person.id)) ?? null : null;
  const dropoff = ride && !driving ? ride.dropoffs.find((stop) => stop.riders.includes(person.id)) ?? null : null;

  intents.push({
    id: bundle,
    source: "meet",
    place: at,
    timing: { kind: "fixed", start: meeting.start, end: meeting.end },
    // Missable, never required. Nothing voluntary may displace a shift, and a
    // person the roads cannot get there is a person who did not come — which
    // lands in `rejected` and is counted, rather than being smoothed away.
    policy: "missable",
    purpose: "meet",
    arrival: pickup
      ? { mode: "passenger", journeyId: outbound, minutes: Math.max(1, meeting.start - pickup.leave) }
      : undefined,
    departure: dropoff
      ? { mode: "passenger", journeyId: inbound, prompt: true }
      : driving && ride !== null && ride.dropoffs.length > 0 ? { journeyId: inbound, prompt: true } : undefined,
    payload: { kind: "meet", meeting, label, where: venue.id },
    bundle,
  });

  if (pickup) {
    intents.push({
      id: `${outbound}/wait/${person.id}`,
      source: "meet",
      place: homePlace,
      timing: { kind: "fixed", start: pickup.arrive, end: pickup.leave },
      policy: "missable",
      purpose: "home",
      departure: { mode: "passenger", journeyId: outbound },
      payload: { kind: "meet", meeting, label: "waiting for lift", where: null },
      bundle,
    });
  }
  if (dropoff) {
    intents.push({
      id: `${inbound}/home/${person.id}`,
      source: "meet",
      place: homePlace,
      timing: { kind: "fixed", start: dropoff.arrive, end: dropoff.leave },
      policy: "missable",
      purpose: "home",
      arrival: { mode: "passenger", journeyId: inbound, minutes: Math.max(1, dropoff.arrive - meeting.end) },
      payload: { kind: "meet", meeting, label: "dropped home", where: null },
      bundle,
    });
  }
  if (!driving || !ride) return;

  // Labelled for what it is rather than as a dwelling. The label is what the
  // timeline prints and what a check groups legs by, and a driver's detour to
  // somebody else's door is not a trip home. The driver's own door is home.
  const kerbside = (door: Point, label: string): { place: Place; own: boolean } => {
    const own = door.lat === homePlace.lat && door.lon === homePlace.lon;
    return {
      place: own ? homePlace : { lat: door.lat, lon: door.lon, id: null, kind: "home", label },
      own,
    };
  };
  for (const [index, stop] of ride.pickups.entries()) {
    const { place, own } = kerbside(stop.door, "pickup");
    intents.push({
      id: `${outbound}/pickup/${stop.riders[0]}`,
      source: "meet",
      place,
      timing: { kind: "fixed", start: stop.arrive, end: stop.leave },
      policy: "missable",
      purpose: own ? "home" : "meet",
      arrival: index > 0 ? { journeyId: outbound } : undefined,
      departure: { journeyId: outbound, prompt: true },
      payload: { kind: "meet", meeting, label: "collecting", where: null },
      bundle,
    });
  }
  for (const [index, stop] of ride.dropoffs.entries()) {
    const { place, own } = kerbside(stop.door, "drop-off");
    intents.push({
      id: `${inbound}/dropoff/${stop.riders[0]}`,
      source: "meet",
      place,
      timing: { kind: "fixed", start: stop.arrive, end: stop.leave },
      policy: "missable",
      purpose: own ? "home" : "meet",
      arrival: { journeyId: inbound },
      departure: index < ride.dropoffs.length - 1 ? { journeyId: inbound, prompt: true } : undefined,
      payload: { kind: "meet", meeting, label: "dropping off", where: null },
      bundle,
    });
  }
}

/**
 * A patrol watch, as intents on the officer's own day.
 *
 * Not `addShared`, although the plumbing is nearly identical, and the
 * difference is the payload: nobody else is in this car, so these are not two
 * halves of one journey — they are one person's job, and the timeline has to
 * read as work rather than as somebody else's lift. The station brackets keep
 * the block they came from so a consumer can still see the shift behind them.
 *
 * Every stay is required. A watch is the most immovable thing in the city: an
 * officer does not skip the second half of it because the roads were slow.
 */
function addPatrol(
  intents: ActivityIntent<Payload>[],
  person: Person,
  day: number,
  index: number,
  stays: readonly Sojourn<PatrolPost>[],
): void {
  for (const [at, stay] of stays.entries()) {
    const post = stay.ref;
    const label = post.kind === "station"
      ? (at === 0 ? "roll call" : "end of watch")
      : post.kind === "meal" ? "patrol · meal break"
        : post.kind === "scene" ? `call · ${INCIDENT_KINDS[post.incidentKind ?? -1]?.label ?? "911"}`
          : `patrol · beat ${post.beat + 1}`;
    intents.push({
      id: `patrol/${person.id}/${day}/${index}/${at}`,
      source: "work",
      place: stay.place,
      timing: { kind: "fixed", start: stay.arrive, end: stay.leave },
      policy: "required",
      purpose: stay.purpose,
      arrival: stay.mode
        ? { mode: stay.mode, minutes: stay.minutes, vehicleId: stay.vehicleId }
        : undefined,
      // A beat point is a junction, not a place anything can be joined to, so
      // the station is the only `where` worth writing.
      payload: {
        kind: "recorded", recordKind: "work", label,
        where: post.kind === "station" ? stay.place.id : null,
      },
    });
  }
}

/** Both crew members share journey ids; only the driver's legs carry the VIN. */
function addAmbulance(
  intents: ActivityIntent<Payload>[],
  person: Person,
  day: number,
  stays: readonly Sojourn<AmbulanceStop>[],
): void {
  for (const [at, stay] of stays.entries()) {
    const ref = stay.ref;
    const label = ref.kind === "house" ? (at === 0 ? "roll call" : "back in quarters")
      : ref.kind === "hospital" ? "transport · hospital"
        : `call · ${INCIDENT_KINDS[ref.kindIndex ?? -1]?.label ?? "911"}`;
    intents.push({
      id: `ems/${person.id}/${day}/${at}`,
      source: "work",
      place: stay.place,
      timing: { kind: "fixed", start: stay.arrive, end: stay.leave },
      policy: "required",
      purpose: stay.purpose,
      arrival: stay.mode
        ? {
            mode: stay.mode, minutes: stay.minutes,
            ...(ref.journeyId ? { journeyId: ref.journeyId } : {}),
            ...(stay.vehicleId ? { vehicleId: stay.vehicleId } : {}),
          }
        : undefined,
      payload: {
        kind: "recorded", recordKind: "work", label,
        where: ref.kind === "scene" ? null : stay.place.id,
      },
    });
  }
}

function addShared(
  intents: ActivityIntent<Payload>[],
  person: number,
  day: number,
  role: string,
  stays: readonly Sojourn<unknown>[],
): void {
  const seen = new Set<string>();
  for (const [index, stay] of stays.entries()) {
    const key = `${stay.arrive}/${stay.leave}/${stay.place.lat.toFixed(6)}/${stay.place.lon.toFixed(6)}/${stay.purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sharedId = sharedJourneyId(role, day, stay.ref, index);
    intents.push({
      id: `${sharedId}/person/${person}`,
      source: "shared-travel",
      place: stay.place,
      timing: { kind: "fixed", start: stay.arrive, end: stay.leave },
      policy: role === "escort" ? "missable" : "required",
      purpose: stay.purpose,
      arrival: {
        mode: stay.mode, minutes: stay.minutes, journeyId: sharedId,
        // A base/depot anchor can identify the vehicle that leaves without
        // claiming the person's commute into that anchor used the same VIN.
        ...(stay.vehicleId && stay.mode ? { vehicleId: stay.vehicleId } : {}),
      },
      departure: stay.leaveMode
        ? { mode: stay.leaveMode, ...(stay.vehicleId ? { vehicleId: stay.vehicleId } : {}) }
        : undefined,
      payload: { kind: "shared-travel", label: stay.place.label, where: stay.place.id },
    });
  }
}

/**
 * The id both halves of a shared journey have to agree on.
 *
 * Derived from the thing being shared — the run and its leg, the child and the
 * direction, the minute a cab was called for — rather than from either person,
 * so a driver's day and a passenger's day compute the same string
 * independently without consulting each other. The passenger/driver journey
 * invariant in iceberg is a check on exactly this.
 */
function sharedJourneyId(role: string, day: number, ref: unknown, index: number): string {
  if (ref && typeof ref === "object") {
    const value = ref as {
      run?: { id?: string };
      leg?: number;
      child?: number;
      direction?: string;
      journeyId?: string;
      requestedAt?: number;
    };
    if (value.journeyId) return value.journeyId;
    if (value.run?.id) return `school-run/${day}/${value.run.id}/${value.leg ?? value.direction ?? index}`;
    if (value.child !== undefined) return `escort/${day}/${value.child}/${value.direction ?? index}`;
    if (value.requestedAt !== undefined) return `taxi-driver/${day}/${value.requestedAt}/${index}`;
  }
  return `shared/${role}/${day}/${index}`;
}

function place(
  world: DayContext["world"],
  id: string | null,
  kind: "work" | "school",
  label: string,
): Place | null {
  const point = placeOf(world, id);
  return point ? { ...point, id, kind, label } : null;
}

/** One planner travel event, as the leg the rest of the pipeline stores. */
function toLeg(event: TravelEvent): Leg {
  return {
    journeyId: event.journeyId,
    ...(event.vehicleId === undefined ? {} : { vehicleId: event.vehicleId }),
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

/** Materialize an already resolved timeline through the ordinary Day model. */
export function dayFromTimeline(
  person: number, timeline: TimelineEvent<Payload>[],
  vehicleAt?: Place | null,
): Day {
  const legs = timeline.filter((event): event is TravelEvent => event.kind === "travel").map(toLeg);
  const blocks: Block[] = timeline.flatMap((event) => event.kind === "stay" && event.source === "sleep"
    ? [{ kind: "sleep", start: event.start, end: event.end, site: null, mode: "home", fixed: true } as Block]
    : []);
  const last = timeline.at(-1);
  return finish(person, blocks, [], [], { person, stops: [], trips: legs.length, extraKm: 0 }, {
    person, timeline, rejected: [], lateMinutes: 0,
    metrics: { trips: legs.length, drivenKm: drivenKilometres(legs), walkedKm: walkedKilometres(legs), rejected: 0 },
    endState: last ? { at: last.end, place: last.kind === "travel" ? last.to : last.place, vehicleAt } : undefined,
  }, legs);
}

/** A day nothing could be scheduled into, holding only what the layers said. */
function empty(person: number, blocks: Block[], tours: Tour[], plan: DayPlan): Day {
  return finish(person, blocks, tours, [], plan, null, []);
}

function finish(
  person: number,
  blocks: Block[],
  tours: Tour[],
  attendance: Attendance[],
  plan: DayPlan,
  scheduled: ScheduledDay<Payload> | null,
  legs: Leg[],
): Day {
  return {
    person,
    scheduled: scheduled ?? {
      person, timeline: [], rejected: [], lateMinutes: 0,
      metrics: { trips: legs.length, drivenKm: drivenKilometres(legs), walkedKm: walkedKilometres(legs), rejected: 0 },
      endState: undefined,
    },
    blocks,
    tours,
    legs,
    attendance,
    plan,
    drivenKm: drivenKilometres(legs),
    walkedKm: walkedKilometres(legs),
    cabKm: taxiKilometres(legs),
    trips: legs.length,
    late: scheduled?.lateMinutes ?? 0,
  };
}

/**
 * The day as a flat, sorted list — what the timeline view prints and what KDAY
 * is packed from.
 *
 * Deliberately lossy: it drops the structure and keeps the times, because the
 * question this answers is "what does this person's Tuesday look like", and
 * that question is not helped by knowing which layer produced which line.
 */
export interface Entry {
  at: number;
  end: number;
  kind: "work" | "school" | "travel" | "affiliation" | "meet" | "stop" | "sleep" | "incident";
  label: string;
  where: string | null;
}

export function entries(day: Day): Entry[] {
  const entries: Entry[] = [];
  for (const event of day.scheduled.timeline) {
    if (event.kind === "travel") {
      entries.push({
        at: event.start, end: event.end, kind: "travel",
        label: `${event.from.label} → ${event.to.label} by ${event.mode}`,
        where: null,
      });
      continue;
    }
    const payload = event.payload;
    if (!payload) continue;
    const kind = payload.kind === "shared-travel" ? "travel"
      : payload.kind === "recorded" ? payload.recordKind : payload.kind;
    entries.push({ at: event.start, end: event.end, kind, label: payload.label, where: payload.where });
  }
  // Off-map workers and the small number of residents without a routable home
  // intentionally bypass the local scheduler. Their surveyed blocks and legs
  // remain explicit compatibility inputs, so expose those rather than writing
  // an apparently empty day to KDAY.
  if (entries.length === 0 && (day.blocks.length > 0 || day.legs.length > 0)) {
    for (const block of day.blocks) {
      entries.push(block.kind === "sleep"
        ? { at: block.start, end: block.end, kind: "sleep", label: "asleep", where: null }
        : {
            at: block.start,
            end: block.end,
            kind: block.kind === "school" ? "school" : "work",
            label: block.role ?? block.kind,
            where: block.site,
          });
    }
    for (const leg of day.legs) {
      entries.push({
        at: leg.depart,
        end: leg.arrive,
        kind: "travel",
        label: `${leg.fromLabel} → ${leg.toLabel} by ${leg.mode}`,
        where: null,
      });
    }
  }
  return entries.sort((a, b) => a.at - b.at || a.end - b.end);
}

export type { Payload as SchedulerPayload, TimelineEvent };

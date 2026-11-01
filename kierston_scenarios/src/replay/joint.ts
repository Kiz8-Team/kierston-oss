import {
  dayFromTimeline, RoutedMobility, shared, transport,
  type DayContext, type SchedulerPayload, type TimelineEvent, type TravelEvent,
} from "../../../kierston/sim/src/index.ts";
import type { Action, Goto, Handset, Perish, Presence, Trip, Window } from "../authoring/dsl.ts";
import { positionAt, type Baseline, type RecordedDay } from "./baseline.ts";
import { idle, resolveTime, spliceTimeline, type Realized, type TaxiResolver, type Timeline } from "./movement.ts";
import { VehicleCatalog, type VehicleMovement } from "./vehicles.ts";
import { validateSharedJourneys } from "./validation.ts";
import { DayBoundaryError } from "../authoring/schedule.ts";

interface WindowState {
  person: number;
  window: Window;
  recorded: RecordedDay;
  place: transport.Place;
  at: number;
  inserted: Timeline;
  lastMode: "walk" | "car" | "taxi" | "patrol";
  lastVehicle?: string;
  /** A presence that ends when the next action starts, if one is pending. */
  open?: { event: TimelineEvent<SchedulerPayload> & { kind: "stay" }; action: string };
}

type JointAction = Trip | Presence | Perish | Handset;

const samePlace = (a: transport.Place, b: transport.Place) => transport.haversineKm(a, b) < 0.08;

/** A member the crowd can do without. Thrown for a droppable action; caught per person. */
class Infeasible extends Error {}

class VehicleLedger {
  private readonly inserted = new Map<string, VehicleMovement[]>();
  constructor(
    private readonly catalog: VehicleCatalog, private readonly windows: ReadonlyMap<number, readonly Window[]>,
    /** Members whose day was given back whole: their recorded movements count again. */
    private readonly dropped: ReadonlyMap<number, string>,
  ) {}

  private retained(vin: string): VehicleMovement[] {
    return this.catalog.movements(vin).filter((movement) => {
      if (movement.person === null || this.dropped.has(movement.person)) return true;
      return !(this.windows.get(movement.person) ?? []).some((window) =>
        movement.start < window.end && window.start < movement.end);
    });
  }

  known(vin: string): boolean { return this.catalog.openingLocation(vin) !== null; }

  /** Whether nobody's retained day still needs this car from `at` on. */
  freeFrom(vin: string, at: number): boolean {
    return !this.retained(vin).some((movement) => movement.end > at)
      && !(this.inserted.get(vin) ?? []).some((movement) => movement.end > at);
  }

  location(vin: string, at: number): transport.Place {
    const opening = this.catalog.openingLocation(vin);
    if (!opening) throw new Error(`vehicle ${vin} has no opening position`);
    let point = opening;
    const movements = [...this.retained(vin), ...(this.inserted.get(vin) ?? [])]
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const movement of movements) {
      if (movement.start < at && at < movement.end) throw new Error(`vehicle ${vin} is moving at ${at}`);
      if (movement.end <= at) point = movement.to;
    }
    return { ...point, id: null, kind: "kerb", label: `parked vehicle ${vin}` };
  }

  reserve(vin: string, person: number, event: TravelEvent): void {
    const movements = [...this.retained(vin), ...(this.inserted.get(vin) ?? [])];
    if (movements.some((row) => row.start < event.end && event.start < row.end)) {
      throw new Error(`vehicle ${vin} is already in use during ${event.start}–${event.end}`);
    }
    const at = this.location(vin, event.start);
    if (!samePlace(at, event.from)) throw new Error(`vehicle ${vin} is not at the trip origin`);
    const mine = this.inserted.get(vin) ?? [];
    mine.push({ vin, person, start: event.start, end: event.end,
      from: { lat: event.from.lat, lon: event.from.lon }, to: { lat: event.to.lat, lon: event.to.lon } });
    this.inserted.set(vin, mine);
  }

  /** Forget everything a dropped member reserved. */
  release(person: number): void {
    for (const [vin, movements] of this.inserted) {
      this.inserted.set(vin, movements.filter((movement) => movement.person !== person));
    }
  }

  /**
   * Every car whose day no longer chains, with the people whose scenario
   * touched it: the ones who drove it, and the ones whose window removed a
   * recorded drive of it — a member taken to the hall on foot still leaves
   * the family car where their cancelled drive home would have collected it.
   */
  /** The first movement that does not chain from the one before it, in recorded order. */
  /**
   * Every break in the base day's sequence for one VIN: the movement that
   * overlaps or does not start where the car was, mapped to the movement
   * before it (null for the opening position). A break is inherited only
   * while the same pair is still adjacent after replay.
   */
  private baseBreaks(opening: { lat: number; lon: number }, movements: VehicleMovement[]): Map<VehicleMovement, VehicleMovement | null> {
    const breaks = new Map<VehicleMovement, VehicleMovement | null>();
    let at = opening, freeAt = -Infinity, previous: VehicleMovement | null = null;
    for (const movement of movements.sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (movement.start < freeAt || transport.haversineKm(at, movement.from) >= 0.1) breaks.set(movement, previous);
      at = movement.to; freeAt = movement.end; previous = movement;
    }
    return breaks;
  }
  conflicts(): { vin: string; reason: string; people: number[] }[] {
    const out: { vin: string; reason: string; people: number[] }[] = [];
    const vins = new Set(this.inserted.keys());
    for (const vin of this.catalog.vins()) {
      if (this.catalog.movements(vin).some((movement) => movement.person !== null && !this.dropped.has(movement.person)
          && (this.windows.get(movement.person) ?? []).some((window) => movement.start < window.end && window.start < movement.end))) vins.add(vin);
    }
    for (const vin of vins) {
      const mine = this.inserted.get(vin) ?? [];
      const opening = this.catalog.openingLocation(vin);
      if (!opening) continue;
      // The base day's own break, if it has one: a night-watch car already
      // on the road at midnight does not start where its opening span says.
      // Replay is not asked to repair that, only not to add a break of its own.
      const inherited = this.baseBreaks(opening, [...this.catalog.movements(vin)]);
      let at = opening, freeAt = -Infinity, previous: VehicleMovement | null = null;
      const movements = [...this.retained(vin), ...mine].sort((a, b) => a.start - b.start || a.end - b.end);
      for (const movement of movements) {
        const reason = movement.start < freeAt ? `vehicle ${vin} has overlapping movements after scenario replay`
          : transport.haversineKm(at, movement.from) >= 0.1 ? `vehicle ${vin} would not be at a retained trip's origin after scenario replay` : null;
        if (reason && inherited.has(movement) && inherited.get(movement) === previous) {
          at = movement.to; freeAt = movement.end; previous = movement; continue;
        }
        if (reason) {
          const people = new Set(mine.map((row) => row.person).filter((person): person is number => person !== null));
          for (const removed of this.catalog.movements(vin)) {
            if (removed.person === null || this.dropped.has(removed.person)) continue;
            if ((this.windows.get(removed.person) ?? []).some((window) => removed.start < window.end && window.start < removed.end)) people.add(removed.person);
          }
          out.push({ vin, reason, people: [...people] });
          break;
        }
        at = movement.to; freeAt = movement.end; previous = movement;
      }
    }
    return out;
  }
}

function copiedEvents(events: readonly TravelEvent[], mode: "walk" | "car" | "taxi" | "patrol"): TravelEvent[] {
  return events.map((event) => {
    const vehicleBearing = event.mode === "car" || event.mode === "cab" || event.mode === "bus";
    return { ...event,
      mode: mode === "car" && vehicleBearing ? "passenger" : event.mode,
      ...(mode === "car" && vehicleBearing ? { parking: undefined, vehicleId: undefined } : {}),
    } as TravelEvent;
  });
}

function actionMinute(action: JointAction, realized: ReadonlyMap<string, Realized>): number {
  if (action.kind === "trip") return resolveTime(action.arriveAt ?? action.departAt!, realized);
  if ("startAt" in action) return resolveTime(action.startAt, realized);
  return resolveTime(action.at, realized);
}

function participantsOf(action: JointAction): number[] {
  return "people" in action ? action.people : [action.person];
}

/**
 * The first minute at or after `at` that is not inside a recorded journey.
 *
 * A soft window may open or close in the middle of somebody's drive to work.
 * Rather than cut the leg — which the splice rightly refuses — the boundary
 * moves to the end of the whole journey, every segment of it, so the person
 * is at a kerb or a door when the scenario takes over or hands back.
 */
function snapForward(timeline: readonly TimelineEvent<SchedulerPayload>[], at: number): number {
  const trips = timeline.filter((event): event is TravelEvent => event.kind === "travel").sort((a, b) => a.start - b.start);
  let snapped = at;
  for (let i = 0; i < trips.length; i++) {
    const trip = trips[i]!;
    if (trip.start < snapped && snapped < trip.end) {
      snapped = trip.end;
      const root = trip.journeyRoot ?? trip.journeyId;
      // Carry on through the rest of the same journey: a walk to the car, the
      // drive, the walk from the space are one movement with three legs.
      for (let j = i + 1; j < trips.length; j++) {
        const next = trips[j]!;
        if ((next.journeyRoot ?? next.journeyId) !== root || next.start > snapped) break;
        snapped = Math.max(snapped, next.end);
      }
    }
  }
  return snapped;
}

/** Resolve all multi-person actions once and project them into each participant's day. */
export async function replayJointActions(
  context: DayContext, baseline: Baseline, actors: ReadonlyMap<number, readonly Window[]>,
  actions: readonly Action[], date: Date, realized: Map<string, Realized>, taxi?: TaxiResolver,
  dropped: Map<number, string> = new Map(),
  planning = false,
): Promise<Map<number, RecordedDay>> {
  const joint = actions.filter((action): action is JointAction =>
    action.kind === "trip" || action.kind === "stay" || action.kind === "wait" || action.kind === "perish" || action.kind === "handset");
  if (!joint.length) return new Map();
  const participants = new Set(joint.flatMap(participantsOf));
  const recorded = new Map<number, RecordedDay>();
  for (const person of participants) recorded.set(person, await baseline.person(person));
  const states = new Map<string, WindowState>();
  const owned = new Map<number, string[]>();
  const stateFor = (person: number, at: number, flexible = false): WindowState => {
    const windows = actors.get(person) ?? [];
    const window = windows.find((candidate) => candidate.start <= at && at < candidate.end)
      // A soft window may already have been snapped past this action's time by
      // an earlier lookup; the person's own window is still the one meant.
      ?? windows.find((candidate) => candidate.soft && candidate.start > at && candidate.end > at);
    if (!window) throw new Error(`person ${person}: action at ${at} requires a replacement window`);
    const key = `${person}/${window.start}`;
    const known = states.get(key);
    if (known) return known;
    const base = recorded.get(person)!;
    if (window.soft) {
      const snapped = snapForward(base.day.scheduled.timeline, window.start);
      if (snapped > at && !flexible) throw new Infeasible(`person ${person}: the day cannot be taken over before ${snapped}, after the action at ${at}`);
      window.start = snapped;
    }
    const state: WindowState = { person, window, recorded: base,
      place: positionAt(base.day.scheduled.timeline, window.start, base.home, base.paths),
      at: window.start, inserted: [], lastMode: "walk" };
    states.set(`${person}/${window.start}`, state);
    return state;
  };
  // The ledger answers for the scenario members' own windows, taken now. The
  // taxi resolver adds windows to the same map as it re-plans a cab driver's
  // shift around a scenario fare, and the cab's replacement legs never pass
  // through `reserve`; seen through the live map, every such cab looked like a
  // car whose recorded drives had been removed with nothing put back. The cab's
  // chain is the taxi layer's to keep, and product validation checks it.
  // Window objects are shared, so a soft window snapped below is still seen.
  const ledger = new VehicleLedger(baseline.vehicles, new Map([...actors].map(([person, windows]) => [person, [...windows]])), dropped);
  const mobility = new RoutedMobility({ roads: context.roads, kerb: context.kerb, seed: context.world.seed }, context.world.persons);
  const day = shared.dayNumber(date);

  const drop = (people: readonly number[], reason: string) => {
    for (const person of people) {
      dropped.set(person, reason);
      for (const key of [...states.keys()]) if (key.startsWith(`${person}/`)) states.delete(key);
      for (const id of owned.get(person) ?? []) realized.delete(id);
      owned.delete(person);
      ledger.release(person);
    }
  };
  /** Close a pending open-ended presence at the minute the next thing starts. */
  const closeOpen = (state: WindowState, at: number) => {
    if (!state.open) return;
    if (at < state.open.event.start) throw new Infeasible(`${state.open.action}: the next action starts before this presence`);
    if (at === state.open.event.start) state.inserted.splice(state.inserted.indexOf(state.open.event), 1);
    else state.open.event.end = at;
    const done = realized.get(state.open.action);
    if (done) done.departure = at;
    state.at = at;
    state.open = undefined;
  };
  /** Which way a person actually goes when the script left it to the roads. */
  /** A fleet drive is priced by the roads and stated to the router, the way the patrol layer does it. */
  const patrolOverride = (from: transport.Place, to: transport.Place, depart: number) =>
    ({ minutes: Math.max(1, Math.round(context.roads.trip(from, to, depart).minutes)) });
  const resolveMode = (action: Trip, leader: number, origin: transport.Place, at: number): { mode: "walk" | "car" | "taxi" | "patrol"; vehicle?: string } => {
    if (action.mode !== "auto") return { mode: action.mode, ...(action.vehicle ? { vehicle: action.vehicle } : {}) };
    // Already there: nothing to drive, and a car parked at the door must not be booked for it.
    if (samePlace(origin, action.place)) return { mode: "walk" };
    const person = context.world.persons.get(leader)!;
    const usual = transport.modeOf(person);
    if (person.age >= 16 && transport.DRIVING.has(usual) && usual !== "taxi" && usual !== "cab" && usual !== "carpool") {
      for (const vin of [...(context.world.householdVehicles.get(person.household) ?? [])].sort()) {
        if (!ledger.known(vin)) continue;
        // Only a car that is here now and that nobody else's day still
        // needs: taking the household car to a concert must not strand the
        // partner who drives it home from a late shift.
        if (!ledger.freeFrom(vin, at)) continue;
        let parked: transport.Place;
        try { parked = ledger.location(vin, at); } catch { continue; }
        if (samePlace(parked, origin)) return { mode: "car", vehicle: vin };
      }
    }
    return { mode: "walk" };
  };

  for (const action of joint) {
    const people = participantsOf(action);
    if (people.some((person) => dropped.has(person))) {
      const kept = people.filter((person) => !dropped.has(person));
      if (kept.length && !action.droppable) throw new Error(`${action.id}: a participant was dropped from the scenario`);
      drop(kept, `${action.id}: shares an action with a dropped member`);
      continue;
    }
    try {
      for (const person of people) { const mine = owned.get(person) ?? []; mine.push(action.id); owned.set(person, mine); }
      await replayOne(action);
      const result = realized.get(action.id);
      if (result && Math.max(result.start, result.arrival, result.departure) > 1440) {
        throw new DayBoundaryError(`${action.id}: action crosses midnight`);
      }
    } catch (error) {
      if (error instanceof DayBoundaryError) throw error;
      if (!(action.droppable) || !(error instanceof Error)) throw error;
      drop(people, `${action.id}: ${error.message}`);
    }
  }

  async function replayOne(action: JointAction): Promise<void> {
    const anchor = actionMinute(action, realized);
    if (action.kind === "perish") {
      if (!Number.isInteger(anchor)) throw new Error(`${action.id}: death is timed to a whole minute`);
      realized.set(action.id, { person: action.person, start: anchor, arrival: anchor, departure: anchor });
      return;
    }
    if (action.kind === "handset") {
      const at = Math.floor(anchor);
      const place = action.place ?? stateFor(action.person, at).place;
      realized.set(action.id, { person: action.person, start: at, arrival: at, departure: at,
        lat: place.lat, lon: place.lon, outdoors: action.outdoors ?? place.kind !== "venue" });
      return;
    }
    if (!Number.isInteger(anchor)) throw new Error(`${action.id}: physical action times use whole minutes`);
    const flexible = action.kind === "trip" && Boolean(action.flexibleDepart);
    const mine = action.people.map((person) => stateFor(person, anchor, flexible));
    if (action.kind === "stay" || action.kind === "wait") {
      const start = resolveTime(action.startAt, realized);
      const end = action.openEnded ? start : action.endAt === undefined ? start + action.duration! : resolveTime(action.endAt, realized);
      if (!Number.isInteger(start) || !Number.isInteger(end) || (end <= start && !action.openEnded)) throw new Error(`${action.id}: invalid presence interval`);
      for (const state of mine) closeOpen(state, start);
      for (const state of mine) {
        if (start < state.at) throw new Error(`${action.id}: overlaps an earlier action for person ${state.person}`);
        const place = action.atCurrent ? state.place : action.place;
        if (!action.atCurrent && !samePlace(state.place, action.place)) throw new Error(`${action.id}: person ${state.person} is not at the requested place`);
        const event: TimelineEvent<SchedulerPayload> & { kind: "stay" } = {
          kind: "stay", activityId: `scenario/${action.id}`, source: action.asleep ? "sleep" : "stop", place,
          start, end: action.openEnded ? Math.max(end, start + 1) : end, policy: "required",
          payload: action.asleep ? { kind: "sleep", label: "asleep", where: null } : { kind: "stop",
            purpose: action.kind === "stay" ? action.purpose : undefined,
            label: action.atCurrent ? place.label : action.place.label, where: place.id },
        };
        state.inserted.push(...idle(state.place, state.at, start, `scenario/wait/${action.id}`), event);
        state.at = action.openEnded ? start : end; state.place = place;
        if (action.openEnded) state.open = { event, action: action.id };
      }
      realized.set(action.id, { person: action.people[0]!, start, arrival: start, departure: end,
        people: action.people, destination: mine[0]!.place.id });
      return;
    }

    if (action.kind !== "trip") return;
    const leader = action.mode === "car" ? action.driver! : action.mode === "taxi" ? action.requestedBy! : action.people[0]!;
    const leaderState = mine.find((state) => state.person === leader)!;
    const origin = action.from ?? leaderState.place;
    const requestedDepart = action.departAt === undefined ? undefined
      : flexible ? Math.max(resolveTime(action.departAt, realized), ...mine.map((state) => state.at)) : resolveTime(action.departAt, realized);
    for (const state of mine) closeOpen(state, requestedDepart ?? state.at);
    for (const state of mine) {
      if (anchor < state.at && !flexible) throw new Error(`${action.id}: overlaps an earlier action for person ${state.person}`);
      if (!samePlace(state.place, origin)) throw new Error(`${action.id}: person ${state.person} is not at the trip origin`);
    }
    const ready = Math.max(...mine.map((state) => state.at));
    let chosen = resolveMode(action, leader, origin, requestedDepart ?? ready);
    if (chosen.mode === "walk" && action.maxWalkKm !== undefined
        && transport.haversineKm(origin, action.place) * 1.3 > action.maxWalkKm) {
      // Too far on foot and nothing to drive: they stay where they stopped.
      const at = requestedDepart ?? anchor;
      realized.set(action.id, { person: leader, start: at, arrival: at, departure: at, people: action.people,
        destination: null, mode: "none", vehicle: null, skipped: "too far to walk" });
      return;
    }
    /** Price the journey one way; null when the car turns out to have gone by the departure minute. */
    const plan = async (mode: typeof chosen): Promise<{ depart: number; events: TravelEvent[] } | null> => {
      const askedAt = requestedDepart ?? ready;
      if (mode.mode === "patrol" && !samePlace(ledger.location(mode.vehicle!, askedAt), origin)) {
        throw new Error(`${action.id}: patrol car ${mode.vehicle} is not with its officer`);
      }
      const vehicleAt = mode.mode === "car" ? ledger.location(mode.vehicle!, askedAt) : undefined;
      const request = { person: leader, day, from: origin, to: action.place, purpose: (mode.mode === "patrol" ? "patrol" : "stop") as "patrol" | "stop",
        override: { mode: mode.mode, journeyId: `scenario/${action.id}`,
          ...(mode.vehicle ? { vehicleId: mode.vehicle } : {}),
          ...(mode.mode === "patrol" ? patrolOverride(origin, action.place, askedAt) : {}) },
        vehicleAt };
      let depart = requestedDepart !== undefined
        ? requestedDepart
        : mobility.latestDeparture({ ...request, arriveBy: resolveTime(action.arriveAt!, realized) });
      if (depart === null) throw new Error(`${action.id}: route unavailable`);
      if (depart < ready) throw new Error(`${action.id}: cannot reach destination after the previous action`);
      // The car was here when the trip was asked for; is it still here when it leaves?
      if (mode.mode === "car" && depart !== askedAt) {
        let parked: transport.Place | null = null;
        try { parked = ledger.location(mode.vehicle!, depart); } catch { parked = null; }
        if (!parked || !samePlace(parked, origin)) return null;
      }
      let events: TravelEvent[];
      if (mode.mode === "taxi") {
        if (!taxi) throw new Error("taxi dispatcher is unavailable");
        const requestAction: Goto = { kind: "goto", id: action.id, person: leader, place: action.place,
          mode: "taxi", departAt: action.departAt!, stayFor: 0 };
        events = await taxi(requestAction, origin, depart);
      } else {
        let transition = mobility.transition({ ...request, depart });
        if (!transition) throw new Error(`${action.id}: route unavailable`);
        // A run is the same route walked faster: price it, then shorten it.
        if (mode.mode === "walk" && action.pace !== undefined && action.pace > 1 && transition.events.length) {
          const minutes = Math.max(1, Math.round((transition.arrive - depart) / action.pace));
          if (action.arriveAt !== undefined) depart = resolveTime(action.arriveAt, realized) - minutes;
          if (depart < ready) throw new Error(`${action.id}: cannot reach destination after the previous action`);
          transition = mobility.transition({ ...request, depart, override: { ...request.override, minutes } });
          if (!transition) throw new Error(`${action.id}: route unavailable`);
        }
        // The forward route is authoritative. Correct a backward estimate
        // conservatively; never shorten routed travel to hit an appointment.
        // The arrival that counts is the last leg's end: a drive's `arrive`
        // can stop at the parking space, a minute short of the walk from it.
        const arrivalOf = (t: { arrive: number; events: { end: number }[] }) => Math.max(t.arrive, t.events.at(-1)?.end ?? t.arrive);
        // Leaving earlier can land on the same minute when the kerb changes
        // with the departure, so correct more than once before giving up.
        for (let tries = 0; action.arriveAt !== undefined && arrivalOf(transition) > resolveTime(action.arriveAt, realized); tries += 1) {
          if (tries === 3) throw new Error(`${action.id}: cannot satisfy arrival constraint`);
          depart -= arrivalOf(transition) - resolveTime(action.arriveAt, realized);
          if (depart < ready) throw new Error(`${action.id}: travel exceeds arrival constraint`);
          transition = mobility.transition({ ...request, depart });
          if (!transition) throw new Error(`${action.id}: route unavailable`);
        }
        events = transition.events;
      }
      return { depart, events };
    };
    let planned = await plan(chosen);
    if (!planned) {
      if (action.mode !== "auto") throw new Error(`${action.id}: vehicle ${chosen.vehicle} has left the trip origin by departure`);
      chosen = { mode: "walk" };
      planned = await plan(chosen);
      if (!planned) throw new Error(`${action.id}: route unavailable`);
    }
    const { depart, events } = planned;
    const routedArrival = events.at(-1)?.end ?? depart;
    const requestedArrival = action.arriveAt === undefined ? routedArrival : resolveTime(action.arriveAt, realized);
    if (routedArrival > requestedArrival) throw new Error(`${action.id}: cannot satisfy arrival constraint`);
    const arrive = requestedArrival;
    if (chosen.mode === "car" || chosen.mode === "patrol") {
      const drive = events.find((event) => event.mode === chosen.mode);
      if (!drive) throw new Error(`${action.id}: selected vehicle could not make the trip`);
      try { ledger.reserve(chosen.vehicle!, leader, drive); }
      catch (error) { throw new Error(`${action.id}: ${(error as Error).message}`); }
    }
    for (const state of mine) {
      const projected = state.person === leader ? events : copiedEvents(events, chosen.mode);
      state.inserted.push(...idle(state.place, state.at, depart, `scenario/wait/${action.id}`), ...projected);
      state.inserted.push(...idle(action.place, routedArrival, arrive, `scenario/early/${action.id}`));
      state.at = arrive; state.place = action.place; state.lastMode = chosen.mode;
      if (chosen.vehicle) state.lastVehicle = chosen.vehicle;
    }
    realized.set(action.id, { person: leader, start: depart, arrival: arrive, departure: arrive,
      people: action.people, destination: action.place.id, mode: chosen.mode, vehicle: chosen.vehicle ?? null });
  }

  // During authoring only resolve the declared prefix. Finalizing a prefix
  // would invent a return journey before the author has declared the exit.
  if (planning) return new Map();
  const changed = new Map<number, RecordedDay>();
  const droppablePeople = new Set(joint.flatMap((action) => action.droppable ? participantsOf(action) : []));
  for (const person of participants) {
    if (dropped.has(person)) continue;
    const base = recorded.get(person)!;
    let timeline = base.day.scheduled.timeline;
    const mine = [...states.values()].filter((state) => state.person === person).sort((a, b) => a.window.start - b.window.start);
    const droppable = droppablePeople.has(person);
    try {
      for (const state of mine) {
        if (state.window.soft && state.window.end < 1440) {
          const snapped = snapForward(base.day.scheduled.timeline, state.window.end);
          if (snapped < state.at) throw new Infeasible(`person ${person}: the recorded day resumes before the last action ends`);
          state.window.end = snapped;
        }
        closeOpen(state, state.window.end);
        let at = state.at, place = state.place;
        if (state.window.end < 1440) {
          let target = positionAt(base.day.scheduled.timeline, state.window.end, base.home, base.paths);
          if (!samePlace(place, target)) {
            if (state.lastMode === "taxi") throw new Error(`person ${person}: taxi window must explicitly return to its baseline endpoint`);
            const vehicleAt = state.lastMode === "car" && state.lastVehicle
              ? ledger.location(state.lastVehicle, at) : undefined;
            const route = (to: transport.Place) => mobility.transition({ person, day, from: place, to, depart: at,
              purpose: state.lastMode === "patrol" ? "patrol" : "home",
              override: { mode: state.lastMode, journeyId: `scenario/rejoin/${person}/${state.window.start}`,
                ...(state.lastVehicle ? { vehicleId: state.lastVehicle } : {}),
                ...(state.lastMode === "patrol" ? patrolOverride(place, to, at) : {}) }, vehicleAt });
            let back = route(target);
            // A soft window closes when the member is back, not when they
            // leave: the return trip's length is only known now. Push the end
            // to the arrival and aim for wherever the day has them then.
            for (let tries = 0; state.window.soft && back && back.arrive > state.window.end && tries < 4; tries += 1) {
              state.window.end = Math.min(1440, snapForward(base.day.scheduled.timeline, back.arrive));
              if (state.window.end === 1440) { back = null; break; }
              target = positionAt(base.day.scheduled.timeline, state.window.end, base.home, base.paths);
              if (samePlace(place, target)) { back = null; break; }
              back = route(target);
            }
            if (state.window.end === 1440 || (back === null && samePlace(place, target))) {
              // Nothing left to rejoin: the day is over, or it has them here.
            } else {
            if (!back || back.arrive > state.window.end) throw new Infeasible(`person ${person}: cannot rejoin baseline by window end`);
            if ((state.lastMode === "car" || state.lastMode === "patrol") && state.lastVehicle) {
              const drive = back.events.find((event) => event.mode === state.lastMode);
              try { if (drive) ledger.reserve(state.lastVehicle, person, drive); }
              catch (error) { throw new Infeasible(`person ${person}: rejoin: ${(error as Error).message}`); }
            }
            state.inserted.push(...back.events); at = back.arrive; place = target;
            }
          }
        }
        state.inserted.push(...idle(place, at, state.window.end, `scenario/end/${person}/${state.window.start}`));
        timeline = spliceTimeline(timeline, state.window, state.inserted, state.window.end === 1440);
      }
    } catch (error) {
      if (!droppable || !(error instanceof Error)) throw error;
      drop([person], error.message);
      continue;
    }
    changed.set(person, { ...base, day: dayFromTimeline(person, timeline) });
  }
  // A drop can undo what an earlier decision relied on: a member dropped for
  // a shared bus gets their evening drive back, and the housemate who took
  // the car on the strength of its being free now strands them. So the checks
  // run until nothing more falls out, and a car that cannot be made to chain
  // takes its scenario drivers with it — or fails the run when one of them
  // was not the runner's to drop.
  for (;;) {
    const before = new Set(dropped.keys());
    await validateSharedJourneys(baseline, changed, droppablePeople, dropped);
    for (const person of dropped.keys()) if (!before.has(person)) drop([person], dropped.get(person)!);
    for (const conflict of ledger.conflicts()) {
      const culprits = conflict.people.filter((person) => droppablePeople.has(person) && !dropped.has(person));
      if (!culprits.length) throw new Error(conflict.reason + (process.env.SCENARIO_DEBUG
        ? ` [debug people=${JSON.stringify(conflict.people.map((person) => ({ person, droppable: droppablePeople.has(person), dropped: dropped.get(person) ?? null, windows: actors.get(person) })))}]` : ""));
      for (const person of culprits) { changed.delete(person); drop([person], conflict.reason); }
    }
    if (dropped.size === before.size) break;
  }
  return changed;
}

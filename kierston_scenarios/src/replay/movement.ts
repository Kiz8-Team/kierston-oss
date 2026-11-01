import { dayFromTimeline, RoutedMobility, transport, shared,
  type DayContext, type TimelineEvent, type SchedulerPayload, type TravelEvent } from "../../../kierston/sim/src/index.ts";
import { positionAt, type RecordedDay } from "./baseline.ts";
import { minute, type Action, type Goto, type Time, type Window } from "../authoring/dsl.ts";
import { isMemberTime } from "../authoring/time.ts";

export interface Realized { person: number; start: number; arrival: number; departure: number; [key: string]: unknown }
export type Timeline = TimelineEvent<SchedulerPayload>[];
export type TaxiResolver = (action: Goto, from: transport.Place, at: number) => Promise<TravelEvent[]>;

export function resolveTime(time: Time, realized: ReadonlyMap<string, Realized>): number {
  if (typeof time === "string" || typeof time === "number") return minute(time);
  if (isMemberTime(time)) throw new Error(`group time for ${time.groupAction} must be resolved per member before replay`);
  const event = realized.get(time.action);
  if (!event) throw new Error(`time references unresolved action ${time.action}; declare its movement first, and use a member time only for members of that action's group`);
  return event[time.boundary] + time.minutes;
}

export function idle(place: transport.Place, start: number, end: number, id: string): Timeline {
  return end > start ? [{ kind: "stay", activityId: id, source: "stop", place, start, end, policy: "required" }] : [];
}

/** Remove only a bounded interval. Travel boundaries must be at route endpoints. */
export function spliceTimeline(baseline: Timeline, window: Window, inserted: Timeline, finishDay = false): Timeline {
  const kept: Timeline = [];
  for (const event of baseline) {
    if (finishDay && event.start >= window.end) continue;
    if (event.end <= window.start || event.start >= window.end) { kept.push(event); continue; }
    if (event.kind === "travel" && (event.start < window.start || (event.end > window.end && !finishDay))) {
      throw new Error(`replacement ${window.start}–${window.end} cuts movement ${event.journeyId}; choose a window at its endpoints`);
    }
    if (event.kind === "stay") {
      if (event.start < window.start) kept.push({ ...event, end: window.start });
      if (event.end > window.end && !finishDay) kept.push({ ...event, start: window.end });
    }
  }
  return [...kept, ...inserted].sort((a, b) => a.start - b.start || a.end - b.end);
}

export async function moveActor(
  context: DayContext, recorded: RecordedDay, windows: readonly Window[], actions: readonly Action[],
  date: Date, realized: Map<string, Realized>, taxi?: TaxiResolver,
): Promise<RecordedDay> {
  const person = recorded.day.person;
  const moves = actions.filter((action): action is Goto => action.kind === "goto" && action.person === person);
  if (!moves.length) return recorded;
  if (!windows.length) throw new Error(`person ${person}: movements require replaceWindow`);
  const mobility = new RoutedMobility({ roads: context.roads, kerb: context.kerb, seed: context.world.seed }, context.world.persons);
  let timeline = recorded.day.scheduled.timeline;
  let finalVehicle: transport.Place | null | undefined = context.state?.openingFor(person)?.vehicle?.location;
  const consumed = new Set<string>();
  for (const window of windows) {
    if ((context.state?.openingFor(person)?.resumeAt ?? 0) > window.start) throw new Error("replacement overlaps authoritative opening continuation");
    let place = positionAt(recorded.day.scheduled.timeline, window.start, recorded.home, recorded.paths);
    let at = window.start;
    // Preserve the baseline vehicle's last parked position before this window.
    let vehicle: transport.Place | null | undefined = finalVehicle;
    for (const event of timeline) {
      if (event.kind === "travel" && event.end <= at && ["car", "carpool"].includes(event.mode)) vehicle = event.to;
    }
    const inserted: Timeline = [];
    let lastMode: Goto["mode"] = "walk";
    for (const action of moves) {
      if (consumed.has(action.id)) continue;
      const time = resolveTime(action.arriveAt ?? action.departAt!, realized);
      if (time < window.start || time >= window.end) continue;
      if (!Number.isInteger(time) || !Number.isInteger(action.stayFor)) throw new Error(`${action.id}: movement times use whole minutes`);
      const request = { person, day: shared.dayNumber(date), from: place, to: action.place, purpose: "stop" as const,
        override: { mode: action.mode, journeyId: `scenario/${action.id}` }, vehicleAt: vehicle };
      let depart = action.departAt !== undefined ? time : mobility.latestDeparture({ ...request, arriveBy: time });
      if (action.mode === "taxi" && action.arriveAt !== undefined) throw new Error(`${action.id}: taxi uses departAt (request time), not arriveAt`);
      if (depart === null || depart < at) throw new Error(`${action.id}: cannot reach destination from the previous activity in time`);
      let events: TravelEvent[];
      if (action.mode === "taxi") {
        if (!taxi) throw new Error("taxi dispatcher is unavailable");
        events = await taxi(action, place, depart);
      } else {
        const transition = mobility.transition({ ...request, depart });
        if (!transition) throw new Error(`${action.id}: route unavailable`);
        events = transition.events;
        vehicle = transition.vehicleAt;
        // The forward route is authoritative. Correct a backward estimate
        // conservatively; never shorten routed travel to hit an appointment.
        if (action.arriveAt !== undefined && transition.arrive > time) {
          depart -= transition.arrive - time;
          if (depart < at) throw new Error(`${action.id}: travel exceeds arrival constraint`);
          const earlier = mobility.transition({ ...request, depart })!;
          events = earlier.events; vehicle = earlier.vehicleAt;
          if (earlier.arrive > time) throw new Error(`${action.id}: cannot satisfy arrival constraint`);
        }
      }
      const arrival = action.arriveAt !== undefined ? time : events.at(-1)?.end ?? depart;
      const end = arrival + action.stayFor;
      if (end > window.end) throw new Error(`${action.id}: stay exceeds replacement window`);
      if (action.mode === "car" && transport.haversineKm(place, action.place) > 0.1
          && !events.some((event) => event.mode === "car" || event.mode === "carpool")) throw new Error(`${action.id}: no car is available at the origin`);
      inserted.push(...idle(place, at, depart, `scenario/wait/${action.id}`), ...events);
      inserted.push(...idle(action.place, events.at(-1)?.end ?? depart, arrival, `scenario/early/${action.id}`));
      if (end > arrival) inserted.push({ kind: "stay", activityId: `scenario/${action.id}`, source: "stop", place: action.place,
        start: arrival, end, policy: "required", payload: { kind: "stop", purpose: action.place.venue?.purposes[0],
          label: action.place.label, where: action.place.id } });
      realized.set(action.id, { person, start: depart, arrival, departure: end, destination: action.place.id, mode: action.mode });
      consumed.add(action.id); place = action.place; at = end; lastMode = action.mode;
    }
    if (window.end < 1440) {
      const target = positionAt(recorded.day.scheduled.timeline, window.end, recorded.home, recorded.paths);
      if (transport.haversineKm(place, target) > 0.01) {
        if (lastMode === "taxi") throw new Error("taxi window must explicitly return to its baseline endpoint");
        const back = mobility.transition({ person, day: shared.dayNumber(date), from: place, to: target, depart: at,
          purpose: "home", override: { mode: lastMode, journeyId: `scenario/rejoin/${person}/${window.start}` }, vehicleAt: vehicle });
        if (!back || back.arrive > window.end) throw new Error(`person ${person}: cannot rejoin the baseline by window end`);
        inserted.push(...back.events); at = back.arrive; vehicle = back.vehicleAt;
      }
      place = target;
    }
    inserted.push(...idle(place, at, window.end, `scenario/end/${person}/${window.start}`));
    timeline = spliceTimeline(timeline, window, inserted, window.end === 1440); finalVehicle = vehicle;
  }
  if (consumed.size !== moves.length) throw new Error(`person ${person}: some movements fall outside replacement windows`);
  const lastDrive = timeline.filter((event): event is TravelEvent => event.kind === "travel"
    && event.end <= 1440 && ["car", "carpool"].includes(event.mode)).at(-1);
  if (lastDrive) finalVehicle = lastDrive.to;
  return { ...recorded, day: dayFromTimeline(person, timeline, finalVehicle) };
}

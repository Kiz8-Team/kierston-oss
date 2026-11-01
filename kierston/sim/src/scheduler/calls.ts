/** The calls-for-service pass: plan the drawn callers' days to find where they are, then dispatch. Like the taxi pass, the demand-side day is identical up to the minute of the call. */

import type { Cohort, DayContext } from "../engine/index.ts";
import {
  dispatchCalls, sampleCalls, type CallsForService, type Hold, type PlacedCall,
} from "../dispatch/index.ts";
import type { Timings } from "../shared/index.ts";
import type { Place, Roads } from "../transport/index.ts";
import { planPersonDay, type Day } from "./compose.ts";
import type { TimelineEvent } from "./types.ts";

export function callsFor(
  context: DayContext, date: Date, day: number, cohort?: Cohort, timings?: Timings,
): CallsForService {
  const { world, roads } = context;
  const started = performance.now();
  const draws = sampleCalls(world, day, cohort?.people);
  const demand: DayContext = { ...context, householdPlanner: undefined, calls: null };
  const placed: PlacedCall[] = [];
  const days = new Map<number, Day>();
  for (const draw of draws) {
    const person = world.persons.get(draw.caller);
    if (!person) continue;
    const planned = planPersonDay(demand, person, date, day);
    const place = whereAt(roads, planned.scheduled.timeline, draw.minute);
    if (!place || place.id?.startsWith("off-map/")) continue;
    placed.push({ index: placed.length, caller: draw.caller, minute: draw.minute, place });
    days.set(draw.caller, planned);
  }
  const measured = timings?.since("calls: demand pass", started) ?? performance.now();

  const calls = dispatchCalls({ world, roads, hospitals: hospitalsOf(context) }, date, day, placed);
  // No hold intent where the baseline day already keeps the caller there.
  for (const [person, hold] of calls.holds) {
    if (stationary(roads, days.get(person)?.scheduled.timeline ?? [], hold)) calls.holds.delete(person);
  }
  timings?.since("calls: dispatch", measured);
  return calls;
}

function hospitalsOf(context: DayContext): Place[] {
  return (context.poiCatalog ?? [])
    .filter((poi) => poi.tag === "amenity=hospital" && !/rehab/i.test(poi.name))
    .map((poi) => ({ lat: poi.lat, lon: poi.lon, id: poi.id, kind: "venue" as const, label: poi.name || "hospital" }));
}

export function whereAt(roads: Roads, timeline: readonly TimelineEvent<unknown>[], minute: number): Place | null {
  if (timeline.length === 0) return null;
  let before: TimelineEvent<unknown> | null = null;
  for (const event of timeline) {
    if (minute < event.start) break;
    if (minute < event.end) {
      if (event.kind === "stay") return event.place;
      return roadside(roads, event, minute);
    }
    before = event;
  }
  if (!before) {
    const first = timeline[0]!;
    return first.kind === "stay" ? first.place : first.from;
  }
  return before.kind === "travel" ? before.to : before.place;
}

function roadside(roads: Roads, event: Extract<TimelineEvent<unknown>, { kind: "travel" }>, minute: number): Place {
  const fraction = Math.max(0, Math.min(1, (minute - event.start) / Math.max(1, event.end - event.start)));
  const guess = {
    lat: event.from.lat + (event.to.lat - event.from.lat) * fraction,
    lon: event.from.lon + (event.to.lon - event.from.lon) * fraction,
  };
  const node = roads.snap(guess);
  const point = node >= 0 ? { lat: roads.graph.lat[node]!, lon: roads.graph.lon[node]! } : guess;
  return { ...point, id: null, kind: "kerb", label: "roadside" };
}

function stationary(roads: Roads, timeline: readonly TimelineEvent<unknown>[], hold: Hold): boolean {
  if (timeline.some((event) => event.kind === "travel" && event.start < hold.until && event.end > hold.from)) return false;
  const at = whereAt(roads, timeline, hold.from);
  return at !== null && samePlace(at, hold.place);
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

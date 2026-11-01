/**
 * What the RTI families share: reading the staged event out of a
 * scenario day, and saying when "now" is.
 *
 * A scenario day carries a header beside its columns — the event's centre,
 * radius and window, every role, every crowd with its drops removed, and
 * the branch each seeded choice took — written by the scenario runner and
 * carried in its `.kdiff`. A generator reads its ground truth from
 * there and never from the script that staged it, so the same generator
 * serves any script that records the same kind of event.
 *
 * The real-time families set a cutoff: the agent works the incident as it
 * stands a few minutes after, and KDI returns nothing recorded later.
 */

import type { TaskContext } from "../../context.ts";
import type { ScenarioEvent, ScenarioHeader } from "../../kday.ts";
import type { Rng } from "../../rng.ts";
import { clock } from "../../format.ts";

export function scenarioHeader(ctx: TaskContext): ScenarioHeader {
  const header = ctx.day.meta.scenario;
  if (!header || header.format !== "KIERSTON_SCENARIO") throw new Error("this day carries no scenario; the family needs a scenario day (base + .kdiff)");
  return header;
}

/** The one event of a kind the day stages; a day with none does not support the family. */
export function eventOfKind(ctx: TaskContext, kind: string): ScenarioEvent {
  const events = scenarioHeader(ctx).events.filter((event) => event.kind === kind);
  if (events.length !== 1) throw new Error(`the day stages ${events.length} ${kind} events; the family needs exactly one`);
  return events[0]!;
}

export function actorOf(ctx: TaskContext, role: string): number {
  const header = scenarioHeader(ctx);
  const id = header.actors[role] ?? header.groups[role]?.[0];
  if (id === undefined) throw new Error(`scenario ${header.name} binds no ${role}`);
  return id;
}

export function groupOf(ctx: TaskContext, role: string): number[] {
  const members = scenarioHeader(ctx).groups[role];
  if (!members) throw new Error(`scenario ${scenarioHeader(ctx).name} has no group ${role}`);
  return members;
}

/**
 * A minute of the city's day as an ISO 8601 timestamp with the zone's
 * offset, which is the form a KDI cutoff takes. Minutes past 1440 roll
 * into the next calendar day, as sim days do.
 */
export function cityInstant(date: string, minute: number, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day) + minute * 60_000;
  const offset = offsetMinutes(new Date(wall - offsetMinutes(new Date(wall), timeZone) * 60_000), timeZone);
  const instant = new Date(wall - offset * 60_000);
  const local = new Date(instant.getTime() + offset * 60_000);
  const sign = offset < 0 ? "-" : "+";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Minutes east of UTC that a zone keeps at an instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** "Now" for a real-time task: a seeded number of minutes after a moment. */
export function nowAfter(rng: Rng, minute: number, range: { min: number; max: number }): number {
  if (minute >= 1440) throw new Error("event leaves no same-day investigation time before midnight");
  const available = Math.max(0, Math.floor(1439 - minute));
  const max = Math.min(range.max, available), min = Math.min(range.min, max);
  return minute + min + rng.int(max - min + 1);
}

/** The event's place as the prompt can name it, or its coordinates when it is a kerb. */
export async function describePlace(ctx: TaskContext, event: ScenarioEvent): Promise<{ venue: string | null; lat: number; lon: number }> {
  let venue: string | null = null;
  if (event.place && !event.place.startsWith("poi/")) {
    try { venue = await ctx.world.placeName(event.place); } catch { venue = null; }
  }
  return { venue, lat: event.lat, lon: event.lon };
}

export function windowText(event: ScenarioEvent): string {
  return event.end - event.start <= 1 ? `at ${clock(event.start)}` : `between ${clock(event.start)} and ${clock(event.end)}`;
}

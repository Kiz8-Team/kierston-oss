/** Content-level continuity checks for one exported KIERSTON_WEEK manifest. */

import { resolve } from "node:path";
import {
  checkpointDigest, checkpointFromKday,
} from "../src/engine/index.ts";
import { KdayFile, type KdayHeader } from "../src/export/index.ts";

type Integers = Uint8Array | Uint32Array | Int32Array;

interface AuditDay {
  reader: KdayFile;
  meta: KdayHeader;
  column: Map<string, Integers>;
}

interface ManifestDay {
  date: string;
  file: string;
  startState: string;
  endState: string;
  counts: { persons: number };
}

interface WeekManifest {
  format: "KIERSTON_WEEK";
  version: 2;
  start: string;
  end: string;
  days: ManifestDay[];
}

const COLUMNS = [
  "person.scheduleOffset", "person.scheduleCount", "person.legOffset", "person.legCount",
  "schedule.start", "schedule.end", "schedule.kind", "schedule.label", "schedule.where",
  "leg.depart", "leg.arrive", "leg.mode", "leg.purpose", "leg.journey",
  "leg.vehicle",
  "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
  "leg.fromLabel", "leg.toLabel", "leg.pathOffset", "leg.pathCount",
  "path.latE6", "path.lonE6",
  "span.subscriber", "span.cell", "span.start", "span.end",
  "event.minute", "event.kind", "event.cause",
  "account.person", "conversation.at", "conversation.count", "participant.account",
  "call.conversation", "call.at", "call.outcome", "call.ring", "call.duration",
  "cdr.call", "cdr.to", "cdr.originCell", "cdr.toOriginCell",
  "sms.to", "sms.toCell", "sms.delivered",
  "alprTruth.camera", "alprTruth.second", "alprTruth.plate",
] as const;

const at = (day: AuditDay, name: string, row: number): number => day.column.get(name)![row]!;
const stringAt = (day: AuditDay, name: string, row: number): string | null =>
  day.reader.string(at(day, name, row));

async function load(path: string): Promise<AuditDay> {
  const reader = await KdayFile.open(path);
  const entries = await Promise.all(COLUMNS.map(async (name) =>
    [name, await reader.column(name) as Integers] as const));
  return { reader, meta: reader.header, column: new Map(entries) };
}

function sameSchedule(previous: AuditDay, before: number, current: AuditDay, after: number): boolean {
  return at(previous, "schedule.start", before) - 1440 === at(current, "schedule.start", after)
    && at(previous, "schedule.end", before) - 1440 === at(current, "schedule.end", after)
    && at(previous, "schedule.kind", before) === at(current, "schedule.kind", after)
    && stringAt(previous, "schedule.label", before) === stringAt(current, "schedule.label", after)
    && stringAt(previous, "schedule.where", before) === stringAt(current, "schedule.where", after);
}

function samePath(previous: AuditDay, before: number, current: AuditDay, after: number): boolean {
  const beforeOffset = at(previous, "leg.pathOffset", before);
  const afterOffset = at(current, "leg.pathOffset", after);
  const count = at(previous, "leg.pathCount", before);
  if (count !== at(current, "leg.pathCount", after)) return false;
  for (let point = 0; point < count; point += 1) {
    if (at(previous, "path.latE6", beforeOffset + point) !== at(current, "path.latE6", afterOffset + point)
      || at(previous, "path.lonE6", beforeOffset + point) !== at(current, "path.lonE6", afterOffset + point)) return false;
  }
  return true;
}

function sameLeg(previous: AuditDay, before: number, current: AuditDay, after: number): boolean {
  const numeric = [
    "leg.mode", "leg.purpose", "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
  ];
  const strings = ["leg.journey", "leg.vehicle", "leg.fromLabel", "leg.toLabel"];
  return at(previous, "leg.depart", before) - 1440 === at(current, "leg.depart", after)
    && at(previous, "leg.arrive", before) - 1440 === at(current, "leg.arrive", after)
    && numeric.every((name) => at(previous, name, before) === at(current, name, after))
    && strings.every((name) => stringAt(previous, name, before) === stringAt(current, name, after))
    && samePath(previous, before, current, after);
}

function invalidIntervals(day: AuditDay): {
  schedules: number; legs: number; scheduleOverlaps: number; legOverlaps: number; mixedOverlaps: number;
} {
  let schedules = 0;
  let legs = 0;
  let scheduleOverlaps = 0;
  let legOverlaps = 0;
  let mixedOverlaps = 0;
  for (let person = 0; person < day.meta.counts.persons; person += 1) {
    const scheduleOffset = at(day, "person.scheduleOffset", person);
    const scheduleCount = at(day, "person.scheduleCount", person);
    const legOffset = at(day, "person.legOffset", person);
    const legCount = at(day, "person.legCount", person);
    const combined: Array<{ start: number; end: number; kind: "schedule" | "leg" }> = [];
    let priorEnd = -Infinity;
    for (let row = scheduleOffset; row < scheduleOffset + scheduleCount; row += 1) {
      const start = at(day, "schedule.start", row);
      const end = at(day, "schedule.end", row);
      if (end <= start) schedules += 1;
      if (start < priorEnd) scheduleOverlaps += 1;
      priorEnd = Math.max(priorEnd, end);
      combined.push({ start, end, kind: "schedule" });
    }
    priorEnd = -Infinity;
    for (let row = legOffset; row < legOffset + legCount; row += 1) {
      const start = at(day, "leg.depart", row);
      const end = at(day, "leg.arrive", row);
      if (end <= start) legs += 1;
      if (start < priorEnd) legOverlaps += 1;
      priorEnd = Math.max(priorEnd, end);
      combined.push({ start, end, kind: "leg" });
    }
    combined.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let row = 1; row < combined.length; row += 1) {
      const before = combined[row - 1]!;
      const after = combined[row]!;
      if (after.start < before.end && after.kind !== before.kind) mixedOverlaps += 1;
    }
  }
  return { schedules, legs, scheduleOverlaps, legOverlaps, mixedOverlaps };
}

function communicationConsistency(day: AuditDay): {
  answeredWithoutOrigin: number; answeredOnNetWithoutCallee: number;
  deliveredOnNetWithoutRecipient: number; overlappingAnsweredParticipations: number;
  callsPastMidnight: number;
} {
  const answered = day.meta.enums.callOutcome?.indexOf("answered") ?? -1;
  let answeredWithoutOrigin = 0;
  let answeredOnNetWithoutCallee = 0;
  const cdrCalls = day.column.get("cdr.call")!;
  for (let row = 0; row < cdrCalls.length; row += 1) {
    if (at(day, "call.outcome", cdrCalls[row]!) !== answered) continue;
    if (at(day, "cdr.originCell", row) < 0) answeredWithoutOrigin += 1;
    if (at(day, "cdr.to", row) >= 0 && at(day, "cdr.toOriginCell", row) < 0) {
      answeredOnNetWithoutCallee += 1;
    }
  }

  let deliveredOnNetWithoutRecipient = 0;
  const sms = day.column.get("sms.to")!;
  for (let row = 0; row < sms.length; row += 1) {
    if (at(day, "sms.delivered", row) >= 0 && at(day, "sms.to", row) >= 0
      && at(day, "sms.toCell", row) < 0) deliveredOnNetWithoutRecipient += 1;
  }

  const occupied = new Map<number, Array<{ start: number; end: number }>>();
  let callsPastMidnight = 0;
  const outcomes = day.column.get("call.outcome")!;
  const carrierCalls = new Set(Array.from(cdrCalls));
  for (let call = 0; call < outcomes.length; call += 1) {
    if (outcomes[call] !== answered || !carrierCalls.has(call)) continue;
    const setup = at(day, "call.at", call);
    const start = setup + at(day, "call.ring", call);
    const end = start + at(day, "call.duration", call);
    if (end > 86_400) callsPastMidnight += 1;
    const conversation = at(day, "call.conversation", call);
    const offset = at(day, "conversation.at", conversation);
    const count = at(day, "conversation.count", conversation);
    for (let index = offset; index < offset + count; index += 1) {
      const account = at(day, "participant.account", index);
      const person = at(day, "account.person", account);
      const mine = occupied.get(person) ?? [];
      mine.push({ start, end });
      occupied.set(person, mine);
    }
  }
  let overlappingAnsweredParticipations = 0;
  for (const intervals of occupied.values()) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    let priorEnd = -Infinity;
    for (const interval of intervals) {
      if (interval.start < priorEnd) overlappingAnsweredParticipations += 1;
      priorEnd = Math.max(priorEnd, interval.end);
    }
  }
  return {
    answeredWithoutOrigin, answeredOnNetWithoutCallee, deliveredOnNetWithoutRecipient,
    overlappingAnsweredParticipations, callsPastMidnight,
  };
}

/** Every physical pass a day file wrote, keyed by plate, camera and second. */
function passKeys(day: AuditDay, shiftSeconds: number): Set<string> {
  const keys = new Set<string>();
  const seconds = day.column.get("alprTruth.second")!;
  for (let row = 0; row < seconds.length; row += 1) {
    const second = (seconds[row]! | 0) + shiftSeconds;
    keys.add(`${stringAt(day, "alprTruth.plate", row)}/${at(day, "alprTruth.camera", row)}/${second}`);
  }
  return keys;
}

/**
 * A day file owns [0, 86400) of its own date, so no pass may sit outside it
 * and no pass may recur, shifted by a day, in the file that follows.
 */
function alprOwnership(day: AuditDay): { alprPasses: number; alprPassesOutsideDay: number } {
  const seconds = day.column.get("alprTruth.second")!;
  let outside = 0;
  for (let row = 0; row < seconds.length; row += 1) {
    const second = seconds[row]! | 0;
    if (second < 0 || second >= 86_400) outside += 1;
  }
  return { alprPasses: seconds.length, alprPassesOutsideDay: outside };
}

function alprBoundary(previous: AuditDay, current: AuditDay): { alprPassesInBothDays: number } {
  const earlier = passKeys(previous, -86_400);
  let shared = 0;
  for (const key of passKeys(current, 0)) if (earlier.has(key)) shared += 1;
  return { alprPassesInBothDays: shared };
}

function radioBoundary(previous: AuditDay, current: AuditDay): {
  comparable: number; changedCell: number; midnightAttaches: number; fictionalDayStartAttaches: number;
} {
  const last = new Map<number, number>();
  const first = new Map<number, number>();
  const previousSubscribers = previous.column.get("span.subscriber")!;
  const currentSubscribers = current.column.get("span.subscriber")!;
  for (let row = 0; row < previousSubscribers.length; row += 1) {
    if (at(previous, "span.end", row) === 1440) {
      last.set(previousSubscribers[row]!, at(previous, "span.cell", row));
    }
  }
  for (let row = 0; row < currentSubscribers.length; row += 1) {
    const subscriber = currentSubscribers[row]!;
    if (at(current, "span.start", row) === 0 && !first.has(subscriber)) {
      first.set(subscriber, at(current, "span.cell", row));
    }
  }
  let comparable = 0;
  let changedCell = 0;
  for (const [subscriber, before] of last) {
    const after = first.get(subscriber);
    if (!after) continue;
    comparable += 1;
    if (before !== after) changedCell += 1;
  }
  const attach = current.meta.enums.eventKind?.indexOf("attach") ?? -1;
  const dayStart = current.meta.enums.eventCause?.indexOf("day-start") ?? -1;
  let midnightAttaches = 0;
  let fictionalDayStartAttaches = 0;
  const events = current.column.get("event.minute")!;
  for (let row = 0; row < events.length; row += 1) {
    if (events[row] !== 0 || at(current, "event.kind", row) !== attach) continue;
    midnightAttaches += 1;
    if (at(current, "event.cause", row) === dayStart) fictionalDayStartAttaches += 1;
  }
  return { comparable, changedCell, midnightAttaches, fictionalDayStartAttaches };
}

function continuity(previous: AuditDay, current: AuditDay): {
  carriedSchedules: number; missingSchedules: number; scheduleConflicts: number;
  carriedLegs: number; missingLegs: number; legConflicts: number;
} {
  let carriedSchedules = 0;
  let missingSchedules = 0;
  let scheduleConflicts = 0;
  let carriedLegs = 0;
  let missingLegs = 0;
  let legConflicts = 0;
  for (let person = 0; person < previous.meta.counts.persons; person += 1) {
    const previousScheduleOffset = at(previous, "person.scheduleOffset", person);
    const previousScheduleCount = at(previous, "person.scheduleCount", person);
    const currentScheduleOffset = at(current, "person.scheduleOffset", person);
    const currentScheduleCount = at(current, "person.scheduleCount", person);
    const tails: number[] = [];
    for (let row = previousScheduleOffset; row < previousScheduleOffset + previousScheduleCount; row += 1) {
      if (at(previous, "schedule.end", row) > 1440) tails.push(row);
    }
    carriedSchedules += tails.length;
    for (let index = 0; index < tails.length; index += 1) {
      const currentRow = currentScheduleOffset + index;
      if (index >= currentScheduleCount || !sameSchedule(previous, tails[index]!, current, currentRow)) {
        missingSchedules += 1;
      }
    }
    const carriedScheduleEnd = tails.reduce((end, row) => Math.max(end, at(previous, "schedule.end", row) - 1440), -Infinity);
    for (let index = tails.length; index < currentScheduleCount; index += 1) {
      if (at(current, "schedule.start", currentScheduleOffset + index) < carriedScheduleEnd) scheduleConflicts += 1;
    }

    const previousLegOffset = at(previous, "person.legOffset", person);
    const previousLegCount = at(previous, "person.legCount", person);
    const currentLegOffset = at(current, "person.legOffset", person);
    const currentLegCount = at(current, "person.legCount", person);
    const legTails: number[] = [];
    for (let row = previousLegOffset; row < previousLegOffset + previousLegCount; row += 1) {
      if (at(previous, "leg.arrive", row) > 1440) legTails.push(row);
    }
    carriedLegs += legTails.length;
    for (let index = 0; index < legTails.length; index += 1) {
      const currentRow = currentLegOffset + index;
      if (index >= currentLegCount || !sameLeg(previous, legTails[index]!, current, currentRow)) missingLegs += 1;
    }
    const carriedLegEnd = legTails.reduce((end, row) => Math.max(end, at(previous, "leg.arrive", row) - 1440), -Infinity);
    for (let index = legTails.length; index < currentLegCount; index += 1) {
      if (at(current, "leg.depart", currentLegOffset + index) < carriedLegEnd) legConflicts += 1;
    }
  }
  return { carriedSchedules, missingSchedules, scheduleConflicts, carriedLegs, missingLegs, legConflicts };
}

async function main(): Promise<void> {
  const manifestPath = resolve(process.argv[2] ?? "../sim_data/week_2026-08-17_2026-08-23.json");
  const manifest = await Bun.file(manifestPath).json() as WeekManifest;
  if (manifest.format !== "KIERSTON_WEEK" || manifest.version !== 2 || manifest.days.length < 1) {
    throw new Error("not an embedded-state week manifest");
  }

  const checkpointRows = [];
  for (const [index, day] of manifest.days.entries()) {
    const checkpoint = await checkpointFromKday(day.file);
    checkpointRows.push({
      date: day.date,
      digest: checkpointDigest(checkpoint) === day.endState,
      join: index === 0 || manifest.days[index - 1]!.endState === day.startState,
      initialized: checkpoint.initialized,
      persons: checkpoint.persons.length,
      radio: checkpoint.radio.length,
      fleet: checkpoint.fleet.length,
      pendingCommunications: checkpoint.communications.pending.length,
      nextDate: checkpoint.nextDate,
    });
  }

  const days = [];
  const boundaries = [];
  let previous = await load(manifest.days[0]!.file);
  days.push({
    date: manifest.days[0]!.date,
    ...invalidIntervals(previous), ...communicationConsistency(previous), ...alprOwnership(previous),
  });
  for (let index = 1; index < manifest.days.length; index += 1) {
    const current = await load(manifest.days[index]!.file);
    days.push({
      date: manifest.days[index]!.date,
      ...invalidIntervals(current), ...communicationConsistency(current), ...alprOwnership(current),
    });
    boundaries.push({
      from: manifest.days[index - 1]!.date,
      to: manifest.days[index]!.date,
      ...continuity(previous, current),
      ...radioBoundary(previous, current),
      ...alprBoundary(previous, current),
    });
    await previous.reader.close();
    previous = current;
  }
  await previous.reader.close();
  const report = { manifest: { start: manifest.start, end: manifest.end }, checkpointRows, days, boundaries };
  console.log(JSON.stringify(report, null, 2));
  const failed = checkpointRows.some((row) =>
    !row.digest || !row.join || !row.initialized || row.persons !== manifest.days.find((day) => day.date === row.date)!.counts.persons)
    || days.some((day) =>
      day.schedules !== 0 || day.legs !== 0 || day.scheduleOverlaps !== 0
      || day.legOverlaps !== 0 || day.mixedOverlaps !== 0
      || day.answeredWithoutOrigin !== 0 || day.answeredOnNetWithoutCallee !== 0
      || day.deliveredOnNetWithoutRecipient !== 0 || day.overlappingAnsweredParticipations !== 0)
    || boundaries.some((boundary) =>
      boundary.missingSchedules !== 0 || boundary.scheduleConflicts !== 0
      || boundary.missingLegs !== 0 || boundary.legConflicts !== 0
      || boundary.fictionalDayStartAttaches !== 0);
  if (failed) process.exitCode = 1;
}

await main();

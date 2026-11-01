import { createHash } from "node:crypto";
import { DayBoundaryError } from "./schedule.ts";

/** A clock time, a duration in minutes, or a boundary of an earlier action. */
export type Time = string | number | RelativeTime | MemberTime;
export type BoundaryKind = "start" | "arrival" | "departure";
export interface RelativeTime { action: string; boundary: BoundaryKind; minutes: number }
/**
 * A boundary of a *group* action, which is a different time for every member.
 *
 * A group action expands into one action per member, `${id}/${person}`, and a
 * member time names the group action rather than any one of those. When a
 * later group action takes it as `at`, each member gets their own copy of the
 * earlier action's boundary — the minute *they* set off, not the minute the
 * first member did. That is what lets "call family two minutes after you
 * started running" stay true for three hundred people who started running at
 * three hundred different minutes.
 */
export interface MemberTime { groupAction: string; boundary: BoundaryKind; minutes: number }
export interface Window { start: number; end: number; /** Derived for a group member; may be snapped to route endpoints at replay. */ soft?: boolean }

export function minute(value: string | number): number {
  if (typeof value === "number") {
    if (value > 1440) throw new DayBoundaryError(`time crosses midnight: ${value}`);
    // Fractional minutes are seconds, which texts and calls keep; physical
    // actions check for whole minutes themselves.
    if (!Number.isFinite(value) || value < 0 || value > 1440) throw new Error(`invalid minute ${value}`);
    return value;
  }
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) throw new Error(`invalid time ${value}`);
  const result = Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60;
  if (result < 0 || result > 1440) throw new Error(`time outside day: ${value}`);
  return result;
}
export function duration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid duration");
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid duration ${value}`);
  return Number(match[1]) * (match[2] === "h" ? 60 : match[2] === "s" ? 1 / 60 : 1);
}
export function distanceMetres(value: string | number): number {
  if (typeof value === "number") {
    if (!(value >= 0) || !Number.isFinite(value)) throw new Error("invalid distance");
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(m|km)$/.exec(value);
  if (!match) throw new Error(`invalid distance ${value}`);
  return Number(match[1]) * (match[2] === "km" ? 1000 : 1);
}
export function seedFor(seed: number, key: string): number {
  return createHash("sha256").update(`${seed}:${key}`).digest().readUInt32LE(0);
}

export class Boundary implements RelativeTime {
  constructor(readonly action: string, readonly boundary: BoundaryKind, readonly minutes = 0) {}
  plus(value: string | number): Boundary { return new Boundary(this.action, this.boundary, this.minutes + duration(value)); }
}
export class GroupBoundary implements MemberTime {
  constructor(readonly groupAction: string, readonly boundary: BoundaryKind, readonly minutes = 0) {}
  plus(value: string | number): GroupBoundary { return new GroupBoundary(this.groupAction, this.boundary, this.minutes + duration(value)); }
}
export const isMemberTime = (time: Time): time is MemberTime => typeof time === "object" && "groupAction" in time;

/** Shift a time by whole or fractional minutes without resolving it. */
export function shifted(time: Time, minutes: number): Time {
  if (minutes === 0) return time;
  if (typeof time === "string" || typeof time === "number") return minute(time) + minutes;
  if (isMemberTime(time)) return new GroupBoundary(time.groupAction, time.boundary, time.minutes + minutes);
  return new Boundary(time.action, time.boundary, time.minutes + minutes);
}

/** A member time, made concrete for one member. Any other time is returned as is. */
export function forMember(time: Time, person: number): string | number | RelativeTime {
  if (!isMemberTime(time)) return time;
  return new Boundary(`${time.groupAction}/${person}`, time.boundary, time.minutes);
}

/**
 * Calls for service, arranged for drawing: colours, labels, the phases of a
 * unit's run and where a responding vehicle is at a given minute.
 *
 * Every minute here is in the dispatch frame — 07:00 on the file's date to
 * 07:00 the next morning — so a clock has to be able to say "01:15 +1". The
 * shared `clock` in day-timeline clamps at 24:00, which is right for a
 * resident's day and wrong for a night watch.
 */

import type { IncidentRow, IncidentUnit, UnitTrack } from "@/lib/server/dispatch";
import { humanise } from "@/lib/format";
import { metresBetween } from "@/lib/meetings";

/** Where an incident lives. The date rides along so the page can read a file. */
export const incidentHref = (date: string, index: number): string =>
  `/dispatch/${index}?date=${encodeURIComponent(date)}`;

/** The sim's `INCIDENT_KINDS` labels, keyed by the id the file carries. */
const KIND_LABEL: Record<string, string> = {
  medical: "Sick person",
  fall: "Fall / injury",
  "chest-pain": "Chest pain / breathing",
  "cardiac-arrest": "Cardiac arrest",
  overdose: "Overdose",
  domestic: "Domestic disturbance",
  welfare: "Welfare check",
  burglary: "Burglary / theft report",
  noise: "Noise complaint",
  alarm: "Alarm activation",
  assault: "Fight / assault",
  theft: "Theft / shoplifting",
  disorderly: "Disorderly / intoxicated",
  suspicious: "Suspicious person / vehicle",
  crash: "Vehicle crash",
  "crash-injury": "Crash with injuries",
  pedestrian: "Pedestrian struck",
  hazard: "Road hazard",
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? humanise(kind);

export const PRIORITY_COLOR: Record<number, string> = {
  1: "#e0483c",
  2: "#eda100",
  3: "#8b9298",
};

export const SERVICE_COLOR: Record<string, string> = {
  police: "#3b82f6",
  ems: "#1baf7a",
};

export const DISPOSITION_COLOR: Record<string, string> = {
  cleared: "#1baf7a",
  partial: "#eda100",
  unserved: "#e0483c",
};

export const CALLER_COLOR = "#c2417a";

export const serviceLabel = (service: string): string =>
  service === "ems" ? "EMS" : humanise(service);

/** "07:54", or "01:15 +1" for a minute past midnight of the next date. */
export function dispatchClock(minute: number, withSeconds = false): string {
  const total = Math.round(minute * (withSeconds ? 60 : 1));
  const perDay = withSeconds ? 86_400 : 1440;
  const day = Math.floor(total / perDay);
  const within = ((total % perDay) + perDay) % perDay;
  const hours = Math.floor(within / (withSeconds ? 3600 : 60));
  const minutes = withSeconds ? Math.floor((within % 3600) / 60) : within % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = withSeconds
    ? `${pad(hours)}:${pad(minutes)}:${pad(within % 60)}`
    : `${pad(hours)}:${pad(minutes)}`;
  return day > 0 ? `${text} +${day}` : text;
}

export function seconds(value: number): string {
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, "0")}s`;
}

/** The last minute anything about an incident is still happening. */
export function incidentLast(incident: IncidentRow): number {
  let last = Math.max(incident.callerUntil, incident.cleared ?? 0);
  for (const unit of incident.units) {
    last = Math.max(last, unit.cleared, unit.hospitalLeft ?? 0, unit.returned ?? 0);
  }
  return last;
}

export const responseMinutes = (incident: IncidentRow): number | null =>
  incident.firstOnScene === null ? null : incident.firstOnScene - incident.received;

/** The value at a quantile of a list, or null for an empty one. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export type PhaseStyle = "solid" | "hatch" | "faint" | "outline";

export interface Phase {
  start: number;
  end: number;
  label: string;
  style: PhaseStyle;
}

/** A unit's run as consecutive stretches: driving to it, at it, and after. */
export function unitPhases(unit: IncidentUnit): Phase[] {
  const out: Phase[] = [
    { start: unit.dispatched, end: unit.arrived, label: "en route", style: "hatch" },
    { start: unit.arrived, end: unit.cleared, label: "on scene", style: "solid" },
  ];
  if (unit.hospital && unit.hospitalArrived !== null && unit.hospitalLeft !== null) {
    out.push(
      { start: unit.cleared, end: unit.hospitalArrived, label: `transport to ${unit.hospital.label}`, style: "hatch" },
      { start: unit.hospitalArrived, end: unit.hospitalLeft, label: `at ${unit.hospital.label}`, style: "faint" },
    );
  }
  if (unit.returned !== null) {
    const from = unit.hospitalLeft ?? unit.cleared;
    out.push({ start: from, end: unit.returned, label: "returning", style: "outline" });
  }
  return out.filter((phase) => phase.end > phase.start);
}

export interface Moment {
  minute: number;
  label: string;
  detail: string;
  color: string;
}

export function incidentMoments(incident: IncidentRow): Moment[] {
  const out: Moment[] = [{
    minute: incident.received, label: "Call received",
    detail: `P${incident.priority} · ${kindLabel(incident.kind)}`, color: CALLER_COLOR,
  }];
  if (incident.call) {
    out.push({
      minute: incident.call.at / 60,
      label: `Call ${incident.call.outcome}`,
      detail: `${dispatchClock(incident.call.at / 60, true)} · ring ${seconds(incident.call.ring)} · ${seconds(incident.call.duration)}`,
      color: CALLER_COLOR,
    });
  }
  for (const unit of incident.units) {
    const name = `${serviceLabel(unit.service)} ${unit.vin.slice(-6)}`;
    const color = SERVICE_COLOR[unit.service] ?? "#616e7a";
    out.push(
      { minute: unit.dispatched, label: `${name} dispatched`, detail: "", color },
      { minute: unit.arrived, label: `${name} on scene`, detail: `response ${unit.arrived - incident.received} min`, color },
      { minute: unit.cleared, label: `${name} cleared`, detail: `${unit.cleared - unit.arrived} min on scene`, color },
    );
    if (unit.hospital && unit.hospitalArrived !== null) {
      out.push({ minute: unit.hospitalArrived, label: `${name} at hospital`, detail: unit.hospital.label, color });
    }
    if (unit.hospital && unit.hospitalLeft !== null) {
      out.push({ minute: unit.hospitalLeft, label: `${name} left hospital`, detail: unit.hospital.label, color });
    }
    if (unit.returned !== null) {
      out.push({ minute: unit.returned, label: `${name} returned`, detail: "", color });
    }
  }
  out.push({
    minute: incident.callerUntil, label: "Caller departed",
    detail: incident.disposition, color: CALLER_COLOR,
  });
  return out.sort((a, b) => a.minute - b.minute);
}

/** Where along a routed path a vehicle has got to, `fraction` of the way through. */
function alongPath(path: [number, number][], fraction: number): [number, number] {
  if (path.length === 1) return path[0]!;
  const steps = path.slice(1).map((point, i) =>
    metresBetween({ lat: path[i]![0], lon: path[i]![1] }, { lat: point[0], lon: point[1] }));
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (total <= 0) return path[0]!;
  let target = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < steps.length; i += 1) {
    if (target <= steps[i]! || i === steps.length - 1) {
      const share = steps[i]! > 0 ? Math.min(1, target / steps[i]!) : 0;
      const [aLat, aLon] = path[i]!;
      const [bLat, bLon] = path[i + 1]!;
      return [aLat + (bLat - aLat) * share, aLon + (bLon - aLon) * share];
    }
    target -= steps[i]!;
  }
  return path[path.length - 1]!;
}

/** The vehicle at a dispatch minute, or null past the span table's midnight. */
export function trackPosition(
  track: UnitTrack, minute: number,
): { lat: number; lon: number; moving: boolean } | null {
  const second = minute * 60;
  const span = track.spans.find((one) => second >= one.start && second < one.end);
  if (!span) return null;
  if (!span.moving) return { lat: span.lat, lon: span.lon, moving: false };
  const movement = track.movements.find((one) => one.leg === span.leg && one.start === span.start)
    ?? track.movements.find((one) => one.leg === span.leg);
  if (!movement || movement.path.length === 0) return { lat: span.lat, lon: span.lon, moving: true };
  const width = movement.end - movement.start;
  const [lat, lon] = alongPath(movement.path, width > 0 ? (second - movement.start) / width : 0);
  return { lat, lon, moving: true };
}

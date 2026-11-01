/** What people ring 911 about, who answers, and every rate the subsystem uses. Numbers are stated assumptions shaped on published CFS and EMS run data for cities this size. */

import type { Place } from "../transport/index.ts";

export const PLACE_CLASSES = ["home", "venue", "work", "road"] as const;
export type PlaceClass = (typeof PLACE_CLASSES)[number];

export function placeClassOf(place: Place): PlaceClass {
  switch (place.kind) {
    case "home": return "home";
    case "work": case "depot": return "work";
    case "kerb": case "stand": return "road";
    default: return "venue";
  }
}

export const SERVICES = ["police", "ems"] as const;
export type Service = (typeof SERVICES)[number];

export interface ServiceResponse {
  /** Probability this service is sent at all. */
  chance: number;
  /** Weights for one, two and three units. */
  units: readonly [number, number, number];
  /** Median minutes the first unit spends on scene; log-normal around it. */
  onScene: number;
  /** EMS only: probability the patient is taken to hospital. */
  transport?: number;
}

export interface IncidentKind {
  id: string;
  label: string;
  /** 1 is life-threatening, 3 is a report that can wait for a free unit. */
  priority: 1 | 2 | 3;
  /** Relative weight from each class of place. Zero means it cannot happen there. */
  at: Readonly<Record<PlaceClass, number>>;
  police: ServiceResponse | null;
  ems: ServiceResponse | null;
}

const P = (chance: number, units: readonly [number, number, number], onScene: number): ServiceResponse =>
  ({ chance, units, onScene });
const E = (chance: number, units: readonly [number, number, number], onScene: number, transport: number): ServiceResponse =>
  ({ chance, units, onScene, transport });

// Appended to, never reordered: `incident.kind` in a KDAY is an index here.
export const INCIDENT_KINDS: readonly IncidentKind[] = [
  { id: "medical", label: "sick person", priority: 2,
    at: { home: 9, venue: 4, work: 3.5, road: 1 },
    police: P(0.15, [1, 0, 0], 25), ems: E(1, [0.85, 0.15, 0], 22, 0.7) },
  { id: "fall", label: "fall / injury", priority: 3,
    at: { home: 4, venue: 2, work: 2.5, road: 0.7 },
    police: P(0.1, [1, 0, 0], 20), ems: E(1, [0.9, 0.1, 0], 20, 0.6) },
  { id: "chest-pain", label: "chest pain / breathing difficulty", priority: 1,
    at: { home: 3.5, venue: 1.5, work: 1.2, road: 0.6 },
    police: P(0.25, [1, 0, 0], 20), ems: E(1, [0.6, 0.4, 0], 20, 0.9) },
  { id: "cardiac-arrest", label: "cardiac arrest", priority: 1,
    at: { home: 1.2, venue: 0.4, work: 0.25, road: 0.15 },
    police: P(0.7, [1, 0, 0], 40), ems: E(1, [0.3, 0.7, 0], 35, 0.75) },
  { id: "overdose", label: "overdose", priority: 1,
    at: { home: 2.5, venue: 1, work: 0.2, road: 0.7 },
    police: P(0.6, [0.7, 0.3, 0], 35), ems: E(1, [0.7, 0.3, 0], 25, 0.8) },
  { id: "domestic", label: "domestic disturbance", priority: 1,
    at: { home: 14, venue: 0, work: 0, road: 0 },
    police: P(1, [0.15, 0.75, 0.1], 40), ems: E(0.15, [1, 0, 0], 20, 0.5) },
  { id: "welfare", label: "welfare check", priority: 3,
    at: { home: 7, venue: 1, work: 1, road: 0 },
    police: P(1, [0.7, 0.3, 0], 25), ems: E(0.3, [1, 0, 0], 20, 0.4) },
  { id: "burglary", label: "burglary / theft report", priority: 3,
    at: { home: 6, venue: 0, work: 3, road: 0 },
    police: P(1, [0.8, 0.2, 0], 35), ems: null },
  { id: "noise", label: "noise complaint", priority: 3,
    at: { home: 8, venue: 2, work: 0, road: 0 },
    police: P(1, [0.8, 0.2, 0], 15), ems: null },
  { id: "alarm", label: "alarm activation", priority: 3,
    at: { home: 3, venue: 4, work: 6, road: 0 },
    police: P(1, [0.6, 0.4, 0], 15), ems: null },
  { id: "assault", label: "fight / assault", priority: 1,
    at: { home: 2, venue: 8, work: 0.5, road: 0.5 },
    police: P(1, [0.1, 0.6, 0.3], 45), ems: E(0.5, [1, 0, 0], 20, 0.55) },
  { id: "theft", label: "theft / shoplifting", priority: 3,
    at: { home: 0, venue: 8, work: 3, road: 0 },
    police: P(1, [0.9, 0.1, 0], 30), ems: null },
  { id: "disorderly", label: "disorderly / intoxicated person", priority: 2,
    at: { home: 1, venue: 7, work: 1, road: 1 },
    police: P(1, [0.6, 0.4, 0], 25), ems: E(0.2, [1, 0, 0], 15, 0.5) },
  { id: "suspicious", label: "suspicious person / vehicle", priority: 3,
    at: { home: 4, venue: 4, work: 3, road: 3 },
    police: P(1, [0.7, 0.3, 0], 15), ems: null },
  { id: "crash", label: "vehicle crash", priority: 2,
    at: { home: 0, venue: 0, work: 0, road: 14 },
    police: P(1, [0.55, 0.45, 0], 35), ems: E(0.35, [1, 0, 0], 20, 0.5) },
  { id: "crash-injury", label: "crash with injuries", priority: 1,
    at: { home: 0, venue: 0, work: 0, road: 6 },
    police: P(1, [0.2, 0.6, 0.2], 50), ems: E(1, [0.7, 0.3, 0], 25, 0.85) },
  { id: "pedestrian", label: "pedestrian struck", priority: 1,
    at: { home: 0, venue: 0, work: 0, road: 1.5 },
    police: P(1, [0.2, 0.6, 0.2], 50), ems: E(1, [0.6, 0.4, 0], 25, 0.9) },
  { id: "hazard", label: "road hazard / disabled vehicle", priority: 3,
    at: { home: 0, venue: 0, work: 0, road: 8 },
    police: P(1, [1, 0, 0], 20), ems: null },
];

/** Calls per thousand residents per day: ~190 on 115k people, ~150 police and ~60 EMS with a quarter shared. */
export const CALLS_PER_THOUSAND_PER_DAY = 1.65;

/** Share of a day's calls by hour of the clock. */
export const HOURLY_SHARE: readonly number[] = [
  2.6, 2.0, 1.6, 1.3, 1.2, 1.4, 2.2, 3.2, 4.0, 4.4, 4.6, 4.8,
  5.0, 5.0, 5.2, 5.6, 5.9, 6.0, 5.8, 5.6, 5.2, 4.8, 4.2, 3.4,
];

/** Spread of the log-normal draws around every median above. */
export const DURATION_SD = 0.4;

/** A second and third unit clear once the primary no longer needs them. */
export const BACKUP_SHARE = 0.6;

/** Minutes at the hospital handing the patient over and making the box ready. */
export const HANDOVER_MEDIAN = 22;

/** From the phone being picked up to the first unit being told to go. */
export const DISPATCH_DELAY = 2;

/** Longest wait before a call is closed unserved, by priority. */
export const MAX_WAIT: Readonly<Record<1 | 2 | 3, number>> = { 1: 30, 2: 45, 3: 75 };

/** How long the caller stays once a unit is with them: at least 20 min, median near an hour. No arrests or deaths outside scenarios. */
export const HOLD_MEDIAN = 50;
export const HOLD_MIN = 20;
export const HOLD_MAX = 150;
/** With nobody coming, how long a caller waits before giving up. */
export const HOLD_UNSERVED = 30;

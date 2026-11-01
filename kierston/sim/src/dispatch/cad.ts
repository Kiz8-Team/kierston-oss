/** Which unit goes to which call. Runs before planning, against each unit's baseline day; every assumption about a unit's position is written onto the Response so stays.ts replays it exactly. */

import { placeOf, type Person, type World } from "../world/index.ts";
import { haversineKm, type Place, type Roads, type Sojourn } from "../transport/index.ts";
import { patrolStays, rosterFor, type Block, type PatrolPost } from "../activities/work/index.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import {
  BACKUP_SHARE, DISPATCH_DELAY, DURATION_SD, HANDOVER_MEDIAN, HOLD_MAX, HOLD_MEDIAN, HOLD_MIN,
  HOLD_UNSERVED, INCIDENT_KINDS, MAX_WAIT, placeClassOf, type PlaceClass, type Service,
  type ServiceResponse,
} from "./kinds.ts";
import { drawKind } from "./calls.ts";

const EMS_ROLES: ReadonlySet<string> = new Set(["paramedic", "emt"]);
const DRIVER_ROLE = "emt";

const EMS_ROLL_OUT = 10;
const EMS_WRAP = 30;

const CANDIDATES = 5;
const SHORTLIST_KPH = 30;

export const DISPOSITIONS = ["cleared", "partial", "unserved"] as const;

export interface PlacedCall {
  index: number;
  caller: number;
  minute: number;
  place: Place;
}

export type LeaveFrom =
  | { kind: "stay"; index: number }
  | { kind: "scene" }
  | { kind: "base" };

export interface Response {
  incident: number;
  kind: number;
  service: Service;
  vin: string;
  crew: number[];
  scene: Place;
  origin: Place;
  leaveFrom: LeaveFrom;
  dispatchedAt: number;
  arrivedAt: number;
  clearedAt: number;
  transport: { hospital: Place; arrivedAt: number; leftAt: number } | null;
  /** Police: baseline stop rejoined after the call, the drive to it, and when the unit leaves the scene. */
  resumeIndex: number;
  resumeMinutes: number;
  sceneUntil: number;
  returnedAt: number | null;
}

export interface Incident {
  index: number;
  kind: number;
  priority: 1 | 2 | 3;
  place: Place;
  placeClass: PlaceClass;
  receivedAt: number;
  caller: number;
  requested: Record<Service, number>;
  responses: Response[];
  disposition: (typeof DISPOSITIONS)[number];
  holdUntil: number;
}

export interface Hold {
  incident: number;
  kind: number;
  place: Place;
  from: number;
  until: number;
}

export interface AmbulanceDuty {
  vin: string;
  base: Place;
  crew: number[];
  driver: number;
  block: Block;
}

export interface CallsForService {
  day: number;
  incidents: Incident[];
  responses: Response[];
  byPerson: Map<number, Response[]>;
  ambulances: Map<number, AmbulanceDuty>;
  holds: Map<number, Hold>;
}

export interface DispatchWorld {
  world: World;
  roads: Roads;
  hospitals: readonly Place[];
}

// ---------------------------------------------------------------------------
// Units

interface PatrolUnit {
  service: "police";
  vin: string;
  crew: number[];
  tour: Sojourn<PatrolPost>[];
  station: Place;
  back: number;
  resumeIndex: number;
  lingerAt: Place | null;
  resumeDepart: number;
  freeAt: number;
  runs: Response[];
}

interface EmsUnit {
  service: "ems";
  vin: string;
  crew: number[];
  base: Place;
  onFrom: number;
  offBy: number;
  at: Place;
  freeAt: number;
  returnedAt: number;
  runs: Response[];
}

type Unit = PatrolUnit | EmsUnit;

interface Position {
  place: Place;
  ready: number;
  from: LeaveFrom;
}

function patrolUnits(context: DispatchWorld, date: Date, day: number): PatrolUnit[] {
  const { world, roads } = context;
  const units: PatrolUnit[] = [];
  for (const assignment of world.assignments.values()) {
    if (assignment.role !== "police_officer" || assignment.duty !== "patrol") continue;
    const person = world.persons.get(assignment.person);
    if (!person) continue;
    for (const block of rosterFor(world, person, date, day)) {
      if (block.kind !== "work") continue;
      const tour = patrolStays({ world, roads }, person, block, date, day);
      if (tour.length < 3) continue;
      const vin = tour[1]!.ref.vin;
      if (!vin) continue;
      units.push({
        service: "police", vin, crew: [person.id], tour, station: tour[0]!.place,
        back: tour[tour.length - 1]!.arrive,
        resumeIndex: 1, lingerAt: null, resumeDepart: -1, freeAt: -1, runs: [],
      });
    }
  }
  units.sort((a, b) => a.crew[0]! - b.crew[0]!);
  return units;
}

export function ambulanceDuties(world: World, date: Date, day: number): Map<number, AmbulanceDuty> {
  const crews = new Map<string, { site: string; crew: string; members: { person: Person; block: Block }[] }>();
  for (const assignment of world.assignments.values()) {
    if (!EMS_ROLES.has(assignment.role ?? "") || !assignment.crew || !assignment.site) continue;
    const person = world.persons.get(assignment.person);
    if (!person) continue;
    const block = rosterFor(world, person, date, day).find((row) => row.kind === "work");
    if (!block) continue;
    const key = `${assignment.site}/${assignment.crew}`;
    const mine = crews.get(key) ?? { site: assignment.site, crew: assignment.crew, members: [] };
    mine.members.push({ person, block });
    crews.set(key, mine);
  }

  const out = new Map<number, AmbulanceDuty>();
  const byHouse = new Map<string, { site: string; crew: string; members: { person: Person; block: Block }[] }[]>();
  for (const crew of crews.values()) {
    if (crew.members.length < 2) continue;
    const mine = byHouse.get(crew.site) ?? [];
    mine.push(crew);
    byHouse.set(crew.site, mine);
  }
  for (const [site, mine] of byHouse) {
    const point = placeOf(world, site);
    const boxes = world.fleet.ambulances.get(site) ?? [];
    if (!point || boxes.length === 0) continue;
    const base: Place = { ...point, id: site, kind: "work", label: "fire house" };
    mine.sort((a, b) => a.crew.localeCompare(b.crew));
    for (const [index, crew] of mine.entries()) {
      const box = boxes[index];
      if (!box) break;
      const members = crew.members.slice().sort((a, b) => a.person.id - b.person.id);
      const driver = members.find((m) => world.assignments.get(m.person.id)?.role === DRIVER_ROLE) ?? members[0]!;
      const ordered = [driver, ...members.filter((m) => m !== driver)];
      const duty: AmbulanceDuty = {
        vin: box.vin, base, crew: ordered.map((m) => m.person.id), driver: driver.person.id,
        // The crew's common window is the shift's; overtime is personal and
        // is spent in the house afterwards.
        block: { ...driver.block, end: Math.min(...ordered.map((m) => m.block.end)) },
      };
      for (const member of ordered) out.set(member.person.id, duty);
    }
  }
  return out;
}

function emsUnits(world: World, duties: Map<number, AmbulanceDuty>): EmsUnit[] {
  const seen = new Set<string>();
  const units: EmsUnit[] = [];
  for (const duty of duties.values()) {
    if (seen.has(duty.vin)) continue;
    seen.add(duty.vin);
    const shift = world.assignments.get(duty.driver)?.shift;
    const offBy = (shift?.end ?? duty.block.end) - EMS_WRAP;
    units.push({
      service: "ems", vin: duty.vin, crew: duty.crew, base: duty.base,
      onFrom: duty.block.start + EMS_ROLL_OUT, offBy,
      at: duty.base, freeAt: -1, returnedAt: -1, runs: [],
    });
  }
  units.sort((a, b) => a.vin.localeCompare(b.vin));
  return units;
}

// ---------------------------------------------------------------------------
// Where a unit is

function patrolPosition(unit: PatrolUnit, t: number): Position | null {
  if (unit.lingerAt && t < unit.resumeDepart) {
    return { place: unit.lingerAt, ready: Math.max(t, unit.freeAt), from: { kind: "scene" } };
  }
  for (let k = unit.resumeIndex; k < unit.tour.length - 1; k += 1) {
    const stay = unit.tour[k]!;
    if (t < stay.arrive) return { place: stay.place, ready: stay.arrive + 1, from: { kind: "stay", index: k } };
    if (t < stay.leave) {
      return { place: stay.place, ready: stay.ref.kind === "meal" ? stay.leave : t, from: { kind: "stay", index: k } };
    }
  }
  return null;
}

function emsPosition(unit: EmsUnit, t: number): Position | null {
  if (t < unit.onFrom || t >= unit.offBy) return null;
  if (t < unit.freeAt) return { place: unit.at, ready: unit.freeAt, from: { kind: "scene" } };
  if (t < unit.returnedAt) return { place: unit.at, ready: t, from: { kind: "scene" } };
  return { place: unit.base, ready: t, from: { kind: "base" } };
}

function positionOf(unit: Unit, t: number): Position | null {
  return unit.service === "police" ? patrolPosition(unit, t) : emsPosition(unit, t);
}

// ---------------------------------------------------------------------------
// Sending one

interface Offer {
  unit: Unit;
  position: Position;
  dispatchedAt: number;
  arrivedAt: number;
}

function offers(context: DispatchWorld, units: readonly Unit[], scene: Place, t: number): Offer[] {
  const shortlist: { unit: Unit; position: Position; guess: number }[] = [];
  for (const unit of units) {
    const position = positionOf(unit, t);
    if (!position) continue;
    const guess = Math.max(t, position.ready) + (haversineKm(position.place, scene) / SHORTLIST_KPH) * 60;
    shortlist.push({ unit, position, guess });
  }
  shortlist.sort((a, b) => a.guess - b.guess || a.unit.vin.localeCompare(b.unit.vin));
  const out: Offer[] = [];
  for (const candidate of shortlist.slice(0, CANDIDATES)) {
    const dispatchedAt = Math.max(t + DISPATCH_DELAY, candidate.position.ready);
    const drive = Math.max(1, Math.round(context.roads.trip(candidate.position.place, scene, dispatchedAt).minutes));
    out.push({ unit: candidate.unit, position: candidate.position, dispatchedAt, arrivedAt: dispatchedAt + drive });
  }
  out.sort((a, b) => a.arrivedAt - b.arrivedAt || a.unit.vin.localeCompare(b.unit.vin));
  return out;
}

function lognormal(rng: Rng, median: number, sd = DURATION_SD): number {
  return Math.exp(rng.gauss(Math.log(median), sd));
}

function nearestHospital(hospitals: readonly Place[], scene: Place): Place | null {
  let best: Place | null = null;
  let distance = Infinity;
  for (const hospital of hospitals) {
    const km = haversineKm(hospital, scene);
    if (km < distance) { distance = km; best = hospital; }
  }
  return best;
}

function sendPatrol(
  context: DispatchWorld, unit: PatrolUnit, offer: Offer, incident: Incident, onScene: number,
): Response | null {
  const { roads } = context;
  const scene = incident.place;
  const clearedAt = offer.arrivedAt + onScene;
  const home = Math.round(roads.trip(scene, unit.station, clearedAt).minutes);
  if (clearedAt + home > unit.back) return null;

  const from = offer.position.from;
  const start = from.kind === "stay" ? from.index + 1 : unit.resumeIndex;
  let resumeIndex = unit.tour.length - 1;
  let resumeMinutes = Math.max(1, home);
  for (let j = start; j < unit.tour.length - 1; j += 1) {
    const stay = unit.tour[j]!;
    const drive = Math.max(1, Math.round(roads.trip(scene, stay.place, clearedAt).minutes));
    if (stay.arrive >= clearedAt + drive) {
      resumeIndex = j;
      resumeMinutes = drive;
      break;
    }
  }
  const resumeDepart = unit.tour[resumeIndex]!.arrive - resumeMinutes;

  if (from.kind === "scene") unit.runs[unit.runs.length - 1]!.sceneUntil = offer.dispatchedAt;

  const response: Response = {
    incident: incident.index, kind: incident.kind, service: "police", vin: unit.vin, crew: [...unit.crew],
    scene, origin: offer.position.place, leaveFrom: from,
    dispatchedAt: offer.dispatchedAt, arrivedAt: offer.arrivedAt, clearedAt,
    transport: null, resumeIndex, resumeMinutes, sceneUntil: resumeDepart, returnedAt: null,
  };
  unit.runs.push(response);
  unit.lingerAt = scene;
  unit.resumeIndex = resumeIndex;
  unit.resumeDepart = resumeDepart;
  unit.freeAt = clearedAt;
  return response;
}

function sendAmbulance(
  context: DispatchWorld, unit: EmsUnit, offer: Offer, incident: Incident, onScene: number,
  transport: boolean, rng: Rng,
): Response | null {
  const { roads } = context;
  const scene = incident.place;
  const clearedAt = offer.arrivedAt + onScene;
  let end: Place = scene;
  let endAt = clearedAt;
  let run: Response["transport"] = null;
  const hospital = transport ? nearestHospital(context.hospitals, scene) : null;
  if (hospital) {
    const arrivedAt = clearedAt + Math.max(1, Math.round(roads.trip(scene, hospital, clearedAt).minutes));
    const leftAt = arrivedAt + Math.max(8, Math.round(lognormal(rng, HANDOVER_MEDIAN, 0.3)));
    run = { hospital, arrivedAt, leftAt };
    end = hospital;
    endAt = leftAt;
  }
  const home = Math.max(1, Math.round(roads.trip(end, unit.base, endAt).minutes));
  if (endAt + home > unit.offBy + EMS_WRAP) return null;

  const from = offer.position.from;
  if (from.kind === "scene") {
    const previous = unit.runs[unit.runs.length - 1]!;
    previous.sceneUntil = offer.dispatchedAt;
    previous.returnedAt = null;
  }
  const response: Response = {
    incident: incident.index, kind: incident.kind, service: "ems", vin: unit.vin, crew: [...unit.crew],
    scene, origin: offer.position.place, leaveFrom: from,
    dispatchedAt: offer.dispatchedAt, arrivedAt: offer.arrivedAt, clearedAt,
    transport: run, resumeIndex: -1, resumeMinutes: home, sceneUntil: endAt, returnedAt: endAt + home,
  };
  unit.runs.push(response);
  unit.at = end;
  unit.freeAt = endAt;
  unit.returnedAt = endAt + home;
  return response;
}

function unitsWanted(rng: Rng, profile: ServiceResponse): number {
  if (!rng.bool(profile.chance)) return 0;
  return rng.weighted([1, 2, 3], profile.units);
}

// ---------------------------------------------------------------------------
// The day

export function dispatchCalls(
  context: DispatchWorld, date: Date, day: number, calls: readonly PlacedCall[],
): CallsForService {
  const { world } = context;
  const police: Unit[] = patrolUnits(context, date, day);
  const ambulances = ambulanceDuties(world, date, day);
  const ems: Unit[] = emsUnits(world, ambulances);
  const fleets: Record<Service, Unit[]> = { police, ems };

  const incidents: Incident[] = [];
  const responses: Response[] = [];
  const ordered = [...calls].sort((a, b) => a.minute - b.minute || a.index - b.index);

  for (const call of ordered) {
    const rng = new Rng(mix(world.seed, LAYER.calls, day, call.index, 1));
    const placeClass = placeClassOf(call.place);
    const kindIndex = drawKind(rng, placeClass);
    const kind = INCIDENT_KINDS[kindIndex]!;
    const incident: Incident = {
      index: call.index, kind: kindIndex, priority: kind.priority, placeClass,
      place: { ...call.place, label: `call · ${kind.label}` },
      receivedAt: call.minute, caller: call.caller,
      requested: {
        police: kind.police ? unitsWanted(rng, kind.police) : 0,
        ems: kind.ems ? unitsWanted(rng, kind.ems) : 0,
      },
      responses: [], disposition: "cleared", holdUntil: 0,
    };
    if (incident.requested.police === 0 && incident.requested.ems === 0) {
      if (kind.police && (!kind.ems || kind.police.chance >= kind.ems.chance)) incident.requested.police = 1;
      else incident.requested.ems = 1;
    }

    for (const service of ["police", "ems"] as const) {
      const wanted = incident.requested[service];
      if (wanted === 0) continue;
      const profile = service === "police" ? kind.police! : kind.ems!;
      const sent = new Set<string>();
      for (let n = 0; n < wanted; n += 1) {
        const onScene = Math.max(5, Math.round(lognormal(rng, profile.onScene) * (n === 0 ? 1 : BACKUP_SHARE)));
        const transport = service === "ems" && n === 0 && rng.bool(profile.transport ?? 0);
        const limit = MAX_WAIT[kind.priority] + (n === 0 ? 0 : 15);
        for (const offer of offers(context, fleets[service].filter((unit) => !sent.has(unit.vin)), incident.place, call.minute)) {
          if (offer.arrivedAt - call.minute > limit) break;
          const response = offer.unit.service === "police"
            ? sendPatrol(context, offer.unit, offer, incident, onScene)
            : sendAmbulance(context, offer.unit, offer, incident, onScene, transport, rng);
          if (!response) continue;
          sent.add(offer.unit.vin);
          incident.responses.push(response);
          responses.push(response);
          break;
        }
      }
    }

    const wanted = incident.requested.police + incident.requested.ems;
    incident.disposition = incident.responses.length === 0 ? "unserved"
      : incident.responses.length < wanted ? "partial" : "cleared";
    const first = incident.responses.reduce((soonest, r) => Math.min(soonest, r.arrivedAt), Infinity);
    incident.holdUntil = Number.isFinite(first)
      ? first + Math.round(Math.min(HOLD_MAX, Math.max(HOLD_MIN, lognormal(rng, HOLD_MEDIAN, 0.45))))
      : call.minute + HOLD_UNSERVED;
    incidents.push(incident);
  }

  const byPerson = new Map<number, Response[]>();
  for (const response of responses) {
    for (const person of response.crew) {
      const mine = byPerson.get(person) ?? [];
      mine.push(response);
      byPerson.set(person, mine);
    }
  }
  for (const mine of byPerson.values()) mine.sort((a, b) => a.dispatchedAt - b.dispatchedAt);

  const holds = new Map<number, Hold>();
  for (const incident of incidents) {
    holds.set(incident.caller, {
      incident: incident.index, kind: incident.kind, place: incident.place,
      from: incident.receivedAt, until: incident.holdUntil,
    });
  }

  incidents.sort((a, b) => a.index - b.index);
  return { day, incidents, responses, byPerson, ambulances, holds };
}

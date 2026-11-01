/** External vehicles sharing Kierston's roads without becoming residents.
 *
 * Repeat vehicles are initialized once and keep their plate, model, colour and
 * destination across dates. Through traffic and one-time visitors are drawn
 * here from the date, because retaining people who never return would turn a
 * day-local flow into a mostly-dead population table.
 */

import { join } from "node:path";
import type { DayContext } from "../engine/index.ts";
import { LAYER, mix, Rng, weekday } from "../shared/index.ts";
import { SIM_DATA_DIR, type Point } from "../world/index.ts";

const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";
const DIGITS = "0123456789";
const MAIN_CLASSES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link",
  "primary", "primary_link", "secondary", "secondary_link",
]);
const CLASS_WEIGHT: Readonly<Record<string, number>> = {
  motorway: 12, motorway_link: 9, trunk: 6, trunk_link: 4.5,
  primary: 3, primary_link: 2.2, secondary: 1.4, secondary_link: 1,
};
const THROUGH_HOURS = [
  1.8, 1.5, 1.3, 1.4, 1.8, 2.8, 4.5, 5.8, 6.2, 5.8, 5.4, 5.5,
  5.8, 5.7, 5.8, 6.2, 7.0, 7.4, 6.5, 5.5, 4.6, 3.7, 2.8, 2.2,
];
const VISIT_HOURS = [
  0.2, 0.1, 0.1, 0.1, 0.2, 0.5, 1.0, 1.8, 2.8, 3.8, 5.2, 6.3,
  6.8, 6.5, 6.2, 6.0, 6.4, 7.0, 7.2, 6.5, 5.0, 3.3, 1.5, 0.6,
];

export const EXTERNAL_TRIP_KINDS = [
  "through", "visit_arrival", "visit_departure", "work_arrival", "work_departure",
  "service_arrival", "service_departure",
] as const;
export type ExternalTripKind = typeof EXTERNAL_TRIP_KINDS[number];
export const EXTERNAL_VEHICLE_KINDS = [
  "worker", "delivery", "repeat_visitor", "through", "single_visit",
] as const;

export interface PlateRule {
  code: string;
  name: string;
  front: boolean;
  patterns: string[];
  tier: number;
  bearing: number | null;
}

export interface ExternalVehicle {
  id: string;
  kind: "worker" | "delivery" | "repeat_visitor" | "through" | "single_visit";
  state: string;
  plate: string;
  plate_sides: ("front" | "rear")[];
  make: string;
  model: string;
  body: string;
  colour: string;
  model_year: number;
  home_bearing?: number;
  destination?: number;
  arrival_minute?: number;
  dwell_minutes?: number;
  weekdays?: number[];
  frequency?: number;
}

interface Destination extends Point {
  id: string;
  label: string;
  kind: string;
  weight: number;
}

interface MarketVehicle {
  make: string;
  model: string;
  body: string;
  colour: string;
  model_year: number;
}

interface ExternalAsset {
  version: number;
  seed: number;
  city: string;
  centre: [number, number];
  radius_m: number;
  rates: {
    weekday: { through: number; single_visit: number };
    weekend: { through: number; single_visit: number };
    overnight_share: number;
  };
  plate_rules: PlateRule[];
  /** One-off visitor weights by state code, from the state's traffic.py. */
  visitor_weights: Record<"through" | "single_visit", Readonly<Record<string, number>>>;
  market: MarketVehicle[];
  destinations: Destination[];
  vehicles: ExternalVehicle[];
}

export interface Gateway {
  key: string;
  name: string;
  roadClass: string;
  bearing: number;
  weight: number;
  entryFrom: number;
  entryTo: number;
  exitFrom: number;
  exitTo: number;
}

export interface ExternalTrafficDay {
  vehicles: ExternalVehicle[];
  tripVehicle: number[];
  tripKind: number[];
  tripRoute: number[];
  tripDepartSecond: number[];
  tripArriveSecond: number[];
  routePathOffset: number[];
  routePathCount: number[];
  pathLat: number[];
  pathLon: number[];
  gateways: number;
  recurringVehicles: number;
  oneOffVehicles: number;
  throughTrips: number;
  stoppingTours: number;
}

export function emptyExternalTrafficDay(): ExternalTrafficDay {
  return {
    vehicles: [], tripVehicle: [], tripKind: [], tripRoute: [],
    tripDepartSecond: [], tripArriveSecond: [],
    routePathOffset: [], routePathCount: [], pathLat: [], pathLon: [],
    gateways: 0, recurringVehicles: 0, oneOffVehicles: 0,
    throughTrips: 0, stoppingTours: 0,
  };
}

const radians = (degrees: number): number => degrees * Math.PI / 180;
const degrees = (radiansValue: number): number => radiansValue * 180 / Math.PI;
const angleDistance = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
const microdegrees = (value: number): number => Math.round(value * 1e6);

function radiusMetres(centre: readonly [number, number], lat: number, lon: number): number {
  const dy = (lat - centre[0]) * 111_320;
  const dx = (lon - centre[1]) * 111_320 * Math.cos(radians(centre[0]));
  return Math.hypot(dx, dy);
}

function bearingFrom(centre: readonly [number, number], lat: number, lon: number): number {
  const dy = (lat - centre[0]) * 111_320;
  const dx = (lon - centre[1]) * 111_320 * Math.cos(radians(centre[0]));
  return (degrees(Math.atan2(dx, dy)) + 360) % 360;
}

function baseClass(value: string): string {
  return value.endsWith("_link") ? value.slice(0, -5) : value;
}

function nodePoint(context: DayContext, node: number): Point {
  return { lat: context.roads.graph.lat[node]!, lon: context.roads.graph.lon[node]! };
}

export function gatewaysOf(context: DayContext, asset: ExternalAsset): Gateway[] {
  const graph = context.roads.graph;
  const inside = new Uint8Array(graph.nodeCount);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    inside[node] = radiusMetres(asset.centre, graph.lat[node]!, graph.lon[node]!) < asset.radius_m ? 1 : 0;
  }

  type Crossing = { source: number; target: number; slot: number; name: string; roadClass: string; bearing: number };
  const inbound: Crossing[] = [];
  const outbound: Crossing[] = [];
  for (let source = 0; source < graph.nodeCount; source += 1) {
    if (graph.component[source] !== graph.largestComponent) continue;
    for (let slot = graph.offset[source]!; slot < graph.offset[source + 1]!; slot += 1) {
      const target = graph.target[slot]!;
      if (graph.component[target] !== graph.largestComponent || inside[source] === inside[target]) continue;
      const roadClass = graph.classes[graph.classId[slot]!] ?? "";
      if (!MAIN_CLASSES.has(roadClass)) continue;
      const crossing = {
        source, target, slot, roadClass,
        name: graph.names[graph.nameId[slot]!] ?? "",
        bearing: bearingFrom(asset.centre, graph.lat[inside[source] ? source : target]!, graph.lon[inside[source] ? source : target]!),
      };
      (inside[source] ? outbound : inbound).push(crossing);
    }
  }

  // Collapse ramps and divided carriageways at the same boundary approach.
  const group = (crossings: Crossing[]): Map<string, Crossing> => {
    const result = new Map<string, Crossing>();
    for (const row of crossings) {
      const sector = Math.round(row.bearing / 15) % 24;
      const corridor = row.name.trim().toLowerCase() || `<${baseClass(row.roadClass)}>`;
      const key = `${sector}:${corridor}:${baseClass(row.roadClass)}`;
      const held = result.get(key);
      if (!held || (CLASS_WEIGHT[row.roadClass] ?? 0) > (CLASS_WEIGHT[held.roadClass] ?? 0)) result.set(key, row);
    }
    return result;
  };

  const entries = group(inbound);
  const exits = [...group(outbound).entries()];
  const result: Gateway[] = [];
  for (const [key, entry] of entries) {
    let candidates = exits.filter(([exitKey]) => exitKey === key);
    if (candidates.length === 0) {
      candidates = exits.filter(([, row]) => baseClass(row.roadClass) === baseClass(entry.roadClass)
        && (row.name === entry.name || !row.name || !entry.name));
    }
    if (candidates.length === 0) candidates = exits;
    candidates.sort((a, b) => {
      const pa = nodePoint(context, a[1].source);
      const pb = nodePoint(context, b[1].source);
      const origin = nodePoint(context, entry.target);
      return Math.hypot(pa.lat - origin.lat, pa.lon - origin.lon)
        - Math.hypot(pb.lat - origin.lat, pb.lon - origin.lon);
    });
    const exit = candidates[0]?.[1];
    if (!exit) continue;
    result.push({
      key, name: entry.name, roadClass: entry.roadClass, bearing: entry.bearing,
      weight: CLASS_WEIGHT[entry.roadClass] ?? 1,
      entryFrom: entry.source, entryTo: entry.target,
      exitFrom: exit.source, exitTo: exit.target,
    });
  }
  return result.sort((a, b) => a.bearing - b.bearing || a.key.localeCompare(b.key));
}

function sampleSecond(rng: Rng, hours: readonly number[]): number {
  const hour = rng.weighted(hours.map((_, index) => index), hours);
  return Math.floor((hour * 60 + rng.between(0, 60)) * 60);
}

export function formatPlate(pattern: string, rng: Rng): string {
  let result = "";
  for (const char of pattern) {
    result += char === "L" ? rng.pick([...LETTERS]) : char === "D" ? rng.pick([...DIGITS]) : char;
  }
  return result;
}

function stateFor(asset: ExternalAsset, kind: "through" | "single_visit", bearing: number, rng: Rng): PlateRule {
  const rules = asset.plate_rules;
  const tierWeight = kind === "through" ? [38, 2.2, 0.9, 0.32] : [58, 1.1, 0.24, 0.045];
  const regional = asset.visitor_weights[kind];
  const weights = rules.map((rule) => {
    const direction = rule.bearing === null ? 1 : 0.35 + 1.65 * Math.exp(-(angleDistance(rule.bearing, bearing) ** 2) / (2 * 55 ** 2));
    return (regional[rule.code] ?? tierWeight[rule.tier]!) * direction;
  });
  return rng.weighted(rules, weights);
}

function marketVehicle(asset: ExternalAsset, kind: "through" | "single_visit", rng: Rng): MarketVehicle {
  const trucks = asset.vehicles.filter((row) => row.body === "truck" || row.body === "tractor");
  const truckShare = kind === "through" ? 0.12 : 0.025;
  if (trucks.length > 0 && rng.bool(truckShare)) {
    const row = rng.pick(trucks);
    return { make: row.make, model: row.model, body: row.body, colour: row.colour, model_year: row.model_year };
  }
  return rng.pick(asset.market);
}

function oneOffVehicle(
  asset: ExternalAsset, arrivalDay: number, index: number,
  kind: "through" | "single_visit", gateway: Gateway,
): ExternalVehicle {
  const rng = new Rng(mix(asset.seed, arrivalDay, index, kind === "through" ? 1 : 2, LAYER.externalTraffic));
  const rule = stateFor(asset, kind, gateway.bearing, rng);
  const specimen = marketVehicle(asset, kind, rng);
  return {
    id: `EXT-O-${arrivalDay}-${kind === "through" ? "T" : "V"}-${index}`,
    kind, state: rule.code, plate: formatPlate(rng.pick(rule.patterns), rng),
    plate_sides: rule.front ? ["front", "rear"] : ["rear"],
    ...specimen,
  };
}

function chooseGateway(gateways: readonly Gateway[], bearing: number, rng: Rng): Gateway {
  return rng.weighted(gateways, gateways.map((row) => row.weight / (1 + angleDistance(row.bearing, bearing) / 18)));
}

function chooseExit(gateways: readonly Gateway[], entry: Gateway, rng: Rng): Gateway {
  const candidates = gateways.filter((row) => row !== entry && angleDistance(row.bearing, entry.bearing) > 80);
  const pool = candidates.length > 0 ? candidates : gateways.filter((row) => row !== entry);
  return rng.weighted(pool, pool.map((row) => row.weight * (0.5 + angleDistance(row.bearing, entry.bearing) / 180)));
}

/** Generate the external road users present on one exported date. */
export async function externalTrafficFor(
  context: DayContext,
  date: Date,
  day: number,
  path = join(SIM_DATA_DIR, "external_traffic.json"),
): Promise<ExternalTrafficDay> {
  const file = Bun.file(path);
  if (!await file.exists()) return emptyExternalTrafficDay();
  const asset = await file.json() as ExternalAsset;
  if (!asset.visitor_weights) {
    throw new Error(`${path} has no visitor_weights; rebuild it with init_sim.py --only external_traffic`);
  }
  const gateways = gatewaysOf(context, asset);
  const out = emptyExternalTrafficDay();
  out.gateways = gateways.length;
  if (gateways.length < 2) return out;

  const routeIndex = new Map<string, number>();
  const addTrip = (
    vehicle: number, kind: ExternalTripKind, from: Point, to: Point, departSecond: number,
    forcedStart?: readonly [number, number], forcedEnd?: readonly [number, number],
  ): number | null => {
    const routedFrom = forcedStart ? nodePoint(context, forcedStart[1]) : from;
    const routedTo = forcedEnd ? nodePoint(context, forcedEnd[0]) : to;
    const priced = context.roads.trip(routedFrom, routedTo, departSecond / 60);
    if (priced.estimated || priced.fromNode < 0 || priced.toNode < 0 || priced.fromNode === priced.toNode) return null;
    const key = `${forcedStart?.join(":") ?? ""}>${priced.fromNode}:${priced.toNode}>${forcedEnd?.join(":") ?? ""}`;
    let route = routeIndex.get(key);
    if (route === undefined) {
      route = out.routePathOffset.length;
      routeIndex.set(key, route);
      const points = context.roads.path(routedFrom, routedTo);
      const same = (a: Point, b: Point): boolean =>
        microdegrees(a.lat) === microdegrees(b.lat) && microdegrees(a.lon) === microdegrees(b.lon);
      if (forcedStart) {
        const inside = nodePoint(context, forcedStart[1]);
        while (points.length > 0 && same(points[0]!, inside)) points.shift();
        points.unshift(nodePoint(context, forcedStart[0]), inside);
      }
      if (forcedEnd) {
        const inside = nodePoint(context, forcedEnd[0]);
        while (points.length > 0 && same(points[points.length - 1]!, inside)) points.pop();
        points.push(inside, nodePoint(context, forcedEnd[1]));
      }
      out.routePathOffset.push(out.pathLat.length);
      out.routePathCount.push(points.length);
      for (const point of points) {
        out.pathLat.push(microdegrees(point.lat));
        out.pathLon.push(microdegrees(point.lon));
      }
    }
    out.tripVehicle.push(vehicle);
    out.tripKind.push(EXTERNAL_TRIP_KINDS.indexOf(kind));
    out.tripRoute.push(route);
    out.tripDepartSecond.push(Math.max(0, Math.round(departSecond)));
    out.tripArriveSecond.push(Math.max(0, Math.round(departSecond + priced.minutes * 60)));
    return out.tripVehicle.length - 1;
  };

  const addVehicle = (vehicle: ExternalVehicle): number => {
    out.vehicles.push(vehicle);
    return out.vehicles.length - 1;
  };
  // Recurring registrations reserve their numbers even when that vehicle is
  // not on the road today. One-offs retain the state's letter/digit layout;
  // only colliding characters are deterministically re-drawn.
  const usedPlates = new Set(asset.vehicles.map((row) => `${row.state}:${row.plate}`));
  const uniqueOneOff = (vehicle: ExternalVehicle): ExternalVehicle => {
    const original = vehicle.plate;
    let candidate = original;
    let attempt = 0;
    const identity = [...vehicle.id].reduce((hash, char) => mix(hash, char.charCodeAt(0)), asset.seed);
    while (usedPlates.has(`${vehicle.state}:${candidate}`)) {
      let value = mix(identity, attempt += 1, LAYER.externalTraffic);
      const chars = [...original];
      for (let index = chars.length - 1; index >= 0; index -= 1) {
        const char = chars[index]!;
        if (/\d/.test(char)) {
          chars[index] = DIGITS[value % DIGITS.length]!;
          value = Math.floor(value / DIGITS.length);
        } else if (/[A-Z]/.test(char)) {
          chars[index] = LETTERS[value % LETTERS.length]!;
          value = Math.floor(value / LETTERS.length);
        }
        if (value === 0) break;
      }
      candidate = chars.join("");
    }
    usedPlates.add(`${vehicle.state}:${candidate}`);
    return candidate === original ? vehicle : { ...vehicle, plate: candidate };
  };
  const destinationPoint = (index: number): Point => asset.destinations[index]!;
  const currentWeekday = weekday(date);

  // Initialized repeat traffic: stable identity and route habit, daily attendance.
  for (let index = 0; index < asset.vehicles.length; index += 1) {
    const vehicle = asset.vehicles[index]!;
    if (!vehicle.weekdays?.includes(currentWeekday)) continue;
    const rng = new Rng(mix(asset.seed, index, day, LAYER.externalTraffic));
    if (!rng.bool(vehicle.frequency ?? 1)) continue;
    const gateway = chooseGateway(gateways, vehicle.home_bearing ?? rng.between(0, 360), rng);
    const destination = destinationPoint(vehicle.destination!);
    const arrival = Math.max(0, ((vehicle.arrival_minute ?? 720) + rng.gauss(0, 12)) * 60 + rng.between(0, 60));
    const row = addVehicle(vehicle);
    const arrivalKind = vehicle.kind === "worker" ? "work_arrival"
      : vehicle.kind === "delivery" ? "service_arrival" : "visit_arrival";
    const departureKind = vehicle.kind === "worker" ? "work_departure"
      : vehicle.kind === "delivery" ? "service_departure" : "visit_departure";
    const inbound = addTrip(
      row, arrivalKind, nodePoint(context, gateway.entryFrom), destination, arrival,
      [gateway.entryFrom, gateway.entryTo],
    );
    if (inbound === null) { out.vehicles.pop(); continue; }
    const reached = out.tripArriveSecond[inbound]!;
    addTrip(row, departureKind, destination, nodePoint(context, gateway.exitTo),
      reached + (vehicle.dwell_minutes ?? 90) * 60 * rng.between(0.88, 1.15),
      undefined, [gateway.exitFrom, gateway.exitTo]);
    out.recurringVehicles += 1;
    out.stoppingTours += 1;
  }

  const rates = currentWeekday < 5 ? asset.rates.weekday : asset.rates.weekend;
  const volumeRng = new Rng(mix(asset.seed, day, LAYER.externalTraffic, 0x564f4c));
  const throughCount = Math.round(rates.through * volumeRng.between(0.97, 1.03));
  for (let index = 0; index < throughCount; index += 1) {
    const rng = new Rng(mix(asset.seed, day, index, LAYER.externalTraffic, 0x544852));
    const entry = rng.weighted(gateways, gateways.map((row) => row.weight));
    const exit = chooseExit(gateways, entry, rng);
    const vehicle = uniqueOneOff(oneOffVehicle(asset, day, index, "through", entry));
    const row = addVehicle(vehicle);
    if (addTrip(row, "through", nodePoint(context, entry.entryFrom), nodePoint(context, exit.exitTo),
      sampleSecond(rng, THROUGH_HOURS), [entry.entryFrom, entry.entryTo],
      [exit.exitFrom, exit.exitTo]) === null) {
      out.vehicles.pop();
      continue;
    }
    out.oneOffVehicles += 1;
    out.throughTrips += 1;
  }

  const visitCount = Math.round(rates.single_visit * volumeRng.between(0.97, 1.03));
  const buildVisits = (arrivalDay: number, arrivalsToday: boolean): void => {
    for (let index = 0; index < visitCount; index += 1) {
      const rng = new Rng(mix(asset.seed, arrivalDay, index, LAYER.externalTraffic, 0x564953));
      const entry = rng.weighted(gateways, gateways.map((row) => row.weight));
      const overnight = rng.bool(asset.rates.overnight_share);
      if (overnight === arrivalsToday && arrivalDay !== day) continue;
      if (!overnight && !arrivalsToday) continue;
      const destination = rng.weighted(asset.destinations, asset.destinations.map((row) =>
        row.kind === "work" ? 0.15 : row.weight));
      let arrival = sampleSecond(rng, VISIT_HOURS);
      let dwell = Math.max(20 * 60, rng.gauss(115 * 60, 65 * 60));
      if (overnight) {
        arrival = Math.max(arrival, 14 * 3600);
        dwell = (24 * 3600 - arrival) + rng.between(6.5 * 3600, 10.5 * 3600);
      }
      const vehicle = uniqueOneOff(oneOffVehicle(asset, arrivalDay, index, "single_visit", entry));
      const row = addVehicle(vehicle);
      if (arrivalsToday) {
        const inbound = addTrip(
          row, "visit_arrival", nodePoint(context, entry.entryFrom), destination, arrival,
          [entry.entryFrom, entry.entryTo],
        );
        if (inbound === null) { out.vehicles.pop(); continue; }
        if (!overnight) {
          addTrip(row, "visit_departure", destination, nodePoint(context, entry.exitTo),
            out.tripArriveSecond[inbound]! + dwell, undefined, [entry.exitFrom, entry.exitTo]);
        }
      } else {
        // Reconstruct yesterday's vehicle and tour; only its next-day departure belongs here.
        addTrip(row, "visit_departure", destination, nodePoint(context, entry.exitTo),
          Math.max(0, arrival + dwell - 24 * 3600), undefined, [entry.exitFrom, entry.exitTo]);
      }
      out.oneOffVehicles += 1;
      out.stoppingTours += 1;
    }
  };
  buildVisits(day, true);
  buildVisits(day - 1, false);

  return out;
}

/**
 * Cuts the data behind the website's "how the engine works" maps from one exported day.
 *
 *   bun run site-engine --day <day.bin> --out <dir> [--sim-data kierston/sim_data] [--sources kierston/sources/kierston]
 *
 * Runs after `site-city`, because every coordinate is measured from the origin city.json settled
 * on, so these layers land on the same base map. Three files are written:
 *
 *   places.json   the venue catalogue and how many people arrived at each venue through the day
 *   fleet.json    every taxi and school bus that moved, with each of its legs routed
 *   traffic.json  outside vehicles: a sample of trips with their routes, the gateways, and the
 *                 whole day's counts by kind
 *
 * A weekday is the intended input: school buses do not run at the weekend and outside workers do
 * not commute.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { KdayReader, NONE } from "../../kierston_bench/task_generators/src/kday.ts";
import { option, required } from "./args.ts";

const USAGE = "bun run site-engine --day <day.bin> --out <dir> [--sim-data kierston/sim_data] [--sources kierston/sources/kierston]";
const dayFile = required("--day", USAGE);
const simData = option("--sim-data", "kierston/sim_data");
const sources = option("--sources", "kierston/sources/kierston");
const out = required("--out", USAGE);

/** mulberry32: the sample must not change between exports of the same day. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const city = (await Bun.file(join(out, "city.json")).json()) as { origin: { lat: number; lon: number }; size: { x: number; y: number } };
const originLat = Math.round(city.origin.lat * 1e6);
const originLon = Math.round(city.origin.lon * 1e6);
const x = (lonE6: number) => Math.round((lonE6 - originLon) / 10);
const y = (latE6: number) => Math.round((latE6 - originLat) / 10);

const day = await KdayReader.open(dayFile);
const load = async (...names: string[]) => Promise.all(names.map((name) => day.column(name)));
const text = (id: number) => (id === NONE ? null : day.string(id));
const BINS = 144;
const bins = () => new Array<number>(BINS).fill(0);
const binOfMinute = (minute: number) => Math.min(BINS - 1, Math.max(0, Math.floor(minute / 10)));
const size = (body: string) => `${(body.length / 1e6).toFixed(2)} MB, ${(Bun.gzipSync(Buffer.from(body)).length / 1e6).toFixed(2)} MB gzipped`;

/**
 * Douglas–Peucker: drops points that sit within `tolerance` site units of the line between the
 * points kept either side, so straight runs collapse and bends keep their shape.
 */
function simplify(lat: ArrayLike<number>, lon: ArrayLike<number>, offset: number, count: number, tolerance: number): number[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = offset; i < offset + count; i++) {
    const px = x(lon[i]!);
    const py = y(lat[i]!);
    if (xs.length && px === xs[xs.length - 1] && py === ys[ys.length - 1]) continue;
    xs.push(px);
    ys.push(py);
  }
  // The map interpolates between points, so a leg that never moves still needs both ends.
  if (xs.length === 1) return [xs[0]!, ys[0]!, xs[0]!, ys[0]!];
  const keep = new Uint8Array(xs.length);
  keep[0] = keep[xs.length - 1] = 1;
  const stack: [number, number][] = [[0, xs.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const dx = xs[to]! - xs[from]!;
    const dy = ys[to]! - ys[from]!;
    const length = Math.hypot(dx, dy);
    let worst = 0;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const ex = xs[i]! - xs[from]!;
      const ey = ys[i]! - ys[from]!;
      const distance = length === 0 ? Math.hypot(ex, ey) : Math.abs(dx * ey - dy * ex) / length;
      if (distance > worst) {
        worst = distance;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  const flat: number[] = [];
  for (let i = 0; i < xs.length; i++) if (keep[i]) flat.push(xs[i]!, ys[i]!);
  return flat;
}

// ---- Places: the venue catalogue, and arrivals at each venue through the day ----

interface PoiGroup { id: string; label: string; color: string; default: boolean; count: number; types: { i: number; label: string }[] }
const pois = (await Bun.file(join(simData, "pois.json")).json()) as { groups: PoiGroup[]; points: [number, number, number, number, string | null, string | null, number][] };
const osm = (await Bun.file(join(sources, "pois_export.json")).json()) as { elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number } }[] };
if (osm.elements.length !== pois.points.length) throw new Error("pois.json and pois_export.json disagree on the point count");
const typeLabel = new Map<number, string>();
for (const group of pois.groups) for (const type of group.types) typeLabel.set(type.i, type.label);
const visitable = pois.groups.filter((group) => group.default);
const groupIndex = new Map(visitable.map((group, position) => [pois.groups.indexOf(group), position]));

const placeRows: { x: number; y: number; group: number; type: string; name: string | null; total: number; minutes: number[] }[] = [];
const placeByVenue = new Map<string, number>();
pois.points.forEach((point, index) => {
  const group = groupIndex.get(point[2]);
  if (group === undefined) return;
  const element = osm.elements[index]!;
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined || Math.abs(lat - point[0]) > 1e-4 || Math.abs(lon - point[1]) > 1e-4) {
    throw new Error(`pois_export.json element ${index} does not match pois.json point ${index}`);
  }
  placeByVenue.set(`v:${element.type}/${element.id}`, placeRows.length);
  placeRows.push({ x: x(Math.round(point[1] * 1e6)), y: y(Math.round(point[0] * 1e6)), group, type: typeLabel.get(point[3]) ?? "", name: point[4], total: 0, minutes: [] });
});

const [scheduleStart, scheduleKind, scheduleWhere] = await load("schedule.start", "schedule.kind", "schedule.where");
const scheduleKinds = day.enumValues("scheduleKind");
const VISIT_KINDS = ["stop", "meet", "affiliation"];
const placeActivity = visitable.map(() => bins());
const arrivalsByKind: Record<string, number> = {};
let unmatched = 0;
for (let i = 0; i < scheduleStart!.length; i++) {
  const kind = scheduleKinds[scheduleKind![i]!]!;
  if (!VISIT_KINDS.includes(kind)) continue;
  const where = text(scheduleWhere![i]!);
  if (!where?.startsWith("v:")) continue;
  const place = placeByVenue.get(where);
  if (place === undefined) {
    unmatched += 1;
    continue;
  }
  const start = scheduleStart![i]!;
  if (start < 0 || start >= 1440) continue;
  const row = placeRows[place]!;
  row.total += 1;
  row.minutes.push(start);
  placeActivity[row.group]![binOfMinute(start)]! += 1;
  arrivalsByKind[kind] = (arrivalsByKind[kind] ?? 0) + 1;
}
const visited = placeRows.filter((row) => row.total > 0).length;
const places = {
  date: day.meta.date,
  groups: visitable.map((group, position) => ({ id: group.id, label: group.label, color: group.color, places: placeRows.filter((row) => row.group === position).length })),
  catalogue: pois.points.length,
  arrivals: arrivalsByKind,
  activity: placeActivity,
  places: placeRows.map((row) => [row.x, row.y, row.group, row.type, row.name, row.total, row.minutes.sort((a, b) => a - b)]),
};
const placesBody = JSON.stringify(places);
console.log(`places.json: ${placeRows.length} venues in ${visitable.length} groups (${visited} visited, ${unmatched} stays at venues outside the catalog): ${size(placesBody)}`);

// ---- Fleet: every taxi and school bus that moved, leg by leg ----

const [legDepart, legArrive, legMode, legPurpose, legTo, legPathOffset, legPathCount, legKm] = await load(
  "leg.depart", "leg.arrive", "leg.mode", "leg.purpose", "leg.toLabel", "leg.pathOffset", "leg.pathCount", "leg.kilometres",
);
const [pathLat, pathLon] = await load("path.latE6", "path.lonE6");
const [vehicleClass, vehicleSpanOffset, vehicleSpanCount] = await load("vehicle.serviceClass", "vehicle.spanOffset", "vehicle.spanCount");
const [spanKind, spanLeg] = await load("vehicleSpan.kind", "vehicleSpan.leg");
const classes = day.enumValues("vehicleServiceClass");
const spanKinds = day.enumValues("vehicleSpanKind");
const modes = day.enumValues("mode");
const purposes = day.enumValues("purpose");
const moving = spanKinds.indexOf("moving");

const fleetRows: { cls: "taxi" | "bus"; legs: (number | string | null | number[])[][] }[] = [];
const fleetTotals = { taxis: 0, taxisMoving: 0, buses: 0, busesMoving: 0, fares: 0, fareKm: 0, emptyKm: 0, runs: 0 };
const fleetActivity = { fare: bins(), empty: bins(), runs: bins() };
for (let vehicle = 0; vehicle < vehicleClass!.length; vehicle++) {
  const cls = classes[vehicleClass![vehicle]!];
  if (cls !== "taxi" && cls !== "school_bus") continue;
  if (cls === "taxi") fleetTotals.taxis += 1;
  else fleetTotals.buses += 1;
  const legs: (number | string | null | number[])[][] = [];
  const seen = new Set<number>();
  for (let span = vehicleSpanOffset![vehicle]!; span < vehicleSpanOffset![vehicle]! + vehicleSpanCount![vehicle]!; span++) {
    if (spanKind![span] !== moving) continue;
    const leg = spanLeg![span]!;
    const mode = modes[legMode![leg]!]!;
    // The driver's leg carries the vehicle; a passenger's leg in the same cab is the same movement.
    if (cls === "taxi" ? mode !== "cab" : mode !== "bus") continue;
    const depart = legDepart![leg]!;
    if (seen.has(depart)) continue;
    seen.add(depart);
    const purpose = purposes[legPurpose![leg]!]!;
    const arrive = legArrive![leg]!;
    legs.push([depart, arrive, legMode![leg]!, legPurpose![leg]!, text(legTo![leg]!), simplify(pathLat!, pathLon!, legPathOffset![leg]!, legPathCount![leg]!, 3)]);
    const km = legKm![leg]!;
    if (cls === "taxi") {
      if (purpose === "fare") {
        fleetTotals.fares += 1;
        fleetTotals.fareKm += km;
      } else fleetTotals.emptyKm += km;
    } else if (purpose === "run") fleetTotals.runs += 1;
    const series = cls === "taxi" ? (purpose === "fare" ? fleetActivity.fare : fleetActivity.empty) : fleetActivity.runs;
    for (let bin = binOfMinute(depart); bin <= binOfMinute(Math.min(1439, arrive)); bin++) series[bin]! += 1;
  }
  if (legs.length === 0) continue;
  legs.sort((a, b) => (a[0] as number) - (b[0] as number));
  if (cls === "taxi") fleetTotals.taxisMoving += 1;
  else fleetTotals.busesMoving += 1;
  fleetRows.push({ cls: cls === "taxi" ? "taxi" : "bus", legs });
}
const fleet = {
  date: day.meta.date,
  enums: { mode: modes, purpose: purposes },
  totals: { ...fleetTotals, fareKm: Math.round(fleetTotals.fareKm), emptyKm: Math.round(fleetTotals.emptyKm) },
  activity: fleetActivity,
  vehicles: fleetRows,
};
const fleetBody = JSON.stringify(fleet);
console.log(`fleet.json: ${fleetTotals.taxisMoving}/${fleetTotals.taxis} taxis and ${fleetTotals.busesMoving}/${fleetTotals.buses} school buses moved; ${fleetTotals.fares} fares, ${fleetTotals.runs} bus runs, empty share ${(fleetTotals.emptyKm / (fleetTotals.emptyKm + fleetTotals.fareKm) * 100).toFixed(0)}%: ${size(fleetBody)}`);

// ---- Outside traffic: the day's counts by kind, the gateways, and a sample of routed trips ----

const [tripVehicle, tripKind, tripRoute, tripDepart, tripArrive] = await load(
  "externalTrip.vehicle", "externalTrip.kind", "externalTrip.route", "externalTrip.departSecond", "externalTrip.arriveSecond",
);
const [extKind, extState] = await load("externalVehicle.kind", "externalVehicle.state");
const [routeOffset, routeCount] = await load("trafficRoute.pathOffset", "trafficRoute.pathCount");
const [trafficLat, trafficLon] = await load("trafficPath.latE6", "trafficPath.lonE6");
const tripKinds = day.enumValues("externalTripKind");
const vehicleKinds = day.enumValues("externalVehicleKind");

const trafficActivity = Object.fromEntries(tripKinds.map((kind) => [kind, bins()])) as Record<string, number[]>;
const tripsByKind: Record<string, number> = {};
const vehiclesByKind: Record<string, number> = {};
const vehiclesByState: Record<string, number> = {};
const onRoad = new Set<number>();
for (let i = 0; i < tripKind!.length; i++) {
  const kind = tripKinds[tripKind![i]!]!;
  tripsByKind[kind] = (tripsByKind[kind] ?? 0) + 1;
  trafficActivity[kind]![binOfMinute(tripDepart![i]! / 60)]! += 1;
  onRoad.add(tripVehicle![i]!);
}
for (const vehicle of onRoad) {
  const kind = vehicleKinds[extKind![vehicle]!]!;
  vehiclesByKind[kind] = (vehiclesByKind[kind] ?? 0) + 1;
  const state = text(extState![vehicle]!) ?? "?";
  vehiclesByState[state] = (vehiclesByState[state] ?? 0) + 1;
}

// A gateway is where a route of a trip that entered starts, or one that left ends; nearby
// endpoints are one gateway because ramps and divided carriageways cross the boundary together.
const GATE = 250;
const gates = new Map<string, { x: number; y: number; entries: number; exits: number; n: number }>();
const gate = (point: number, entering: boolean) => {
  const px = x(trafficLon![point]!);
  const py = y(trafficLat![point]!);
  const key = `${Math.round(px / GATE)}:${Math.round(py / GATE)}`;
  const held = gates.get(key) ?? { x: 0, y: 0, entries: 0, exits: 0, n: 0 };
  held.x += px;
  held.y += py;
  held.n += 1;
  if (entering) held.entries += 1;
  else held.exits += 1;
  gates.set(key, held);
};
for (let i = 0; i < tripKind!.length; i++) {
  const kind = tripKinds[tripKind![i]!]!;
  const route = tripRoute![i]!;
  const offset = routeOffset![route]!;
  const count = routeCount![route]!;
  if (count < 2) continue;
  if (kind === "through" || kind.endsWith("_arrival")) gate(offset, true);
  if (kind === "through" || kind.endsWith("_departure")) gate(offset + count - 1, false);
}
const gateways = [...gates.values()]
  .filter((held) => held.n >= 100)
  .map((held) => [Math.round(held.x / held.n), Math.round(held.y / held.n), held.entries, held.exits])
  .sort((a, b) => b[2]! + b[3]! - a[2]! - a[3]!);

const QUOTA: Record<string, number> = { through: 1500, visit_arrival: 350, visit_departure: 350, work_arrival: 300, work_departure: 300, service_arrival: 150, service_departure: 150 };
const random = rng(91);
const byKind = new Map<string, number[]>();
for (let i = 0; i < tripKind!.length; i++) {
  const kind = tripKinds[tripKind![i]!]!;
  const list = byKind.get(kind) ?? [];
  list.push(i);
  byKind.set(kind, list);
}
const picked: number[] = [];
for (const [kind, list] of byKind) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  picked.push(...list.slice(0, QUOTA[kind] ?? 0));
}
picked.sort((a, b) => tripDepart![a]! - tripDepart![b]!);
const routeRows: number[][] = [];
const routeIndex = new Map<number, number>();
const trips = picked.map((i) => {
  const route = tripRoute![i]!;
  let index = routeIndex.get(route);
  if (index === undefined) {
    index = routeRows.length;
    routeIndex.set(route, index);
    routeRows.push(simplify(trafficLat!, trafficLon!, routeOffset![route]!, routeCount![route]!, 3));
  }
  const vehicle = tripVehicle![i]!;
  return [Math.round(tripDepart![i]! / 6) / 10, Math.round(tripArrive![i]! / 6) / 10, tripKind![i]!, extKind![vehicle]!, text(extState![vehicle]!), index];
});
const traffic = {
  date: day.meta.date,
  enums: { tripKind: tripKinds, vehicleKind: vehicleKinds },
  totals: { trips: tripsByKind, vehicles: vehiclesByKind, states: vehiclesByState },
  activity: trafficActivity,
  gateways,
  routes: routeRows,
  trips,
};
const trafficBody = JSON.stringify(traffic);
console.log(`traffic.json: ${trips.length} of ${tripKind!.length} trips on ${routeRows.length} routes, ${gateways.length} gateways, ${onRoad.size} vehicles: ${size(trafficBody)}`);

await day.close();
await mkdir(out, { recursive: true });
await Bun.write(join(out, "places.json"), placesBody);
await Bun.write(join(out, "fleet.json"), fleetBody);
await Bun.write(join(out, "traffic.json"), trafficBody);

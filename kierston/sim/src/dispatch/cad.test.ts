import { describe, expect, test } from "bun:test";
import type { Assignment, Person, World } from "../world/index.ts";
import type { Place, Roads } from "../transport/index.ts";
import { patrolStays } from "../activities/work/index.ts";
import { ambulanceStays, dispatchCalls, respondingTour, type PlacedCall } from "./index.ts";
import { sampleCalls } from "./calls.ts";

// Not `way/1`: patrol.ts caches a station's line-up by key and day, and the patrol tests use that one.
const STATION = "way/901";
const HOUSE = "way/902";
const STATION_POINT = { lat: 40.6, lon: -75.47 };
const HOUSE_POINT = { lat: 40.61, lon: -75.46 };
const HOSPITAL: Place = { lat: 40.605, lon: -75.49, id: "poi/hospital", kind: "venue", label: "hospital" };
const DATE = new Date(Date.UTC(2026, 6, 28));
const DAY = 4000;

function fakeRoads(): Roads {
  const nodeCount = 100;
  const lat = new Float64Array(nodeCount);
  const lon = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    lat[node] = 40.59 + Math.floor(node / 10) * 0.002;
    lon[node] = -75.48 + (node % 10) * 0.002;
  }
  const offset = new Uint32Array(nodeCount + 1);
  for (let node = 0; node <= nodeCount; node += 1) offset[node] = node;
  return {
    graph: {
      lat, lon, offset,
      classId: new Uint8Array(nodeCount).fill(0),
      classes: ["residential"],
      component: new Uint32Array(nodeCount).fill(3),
      largestComponent: 3,
      nodeCount,
    },
    trip: () => ({ minutes: 3, kilometres: 1.5, fromNode: 0, toNode: 1, estimated: false }),
  } as unknown as Roads;
}

function person(id: number, occupation: string): Person {
  return { id, household: id, age: 30, sex: 1, employment: 1, occupation,
    hours: 40, depart: 405, arrive: 420, travel: 15, transport: "1",
    enrolled: null, grade: null } as Person;
}

function officer(id: number): Assignment {
  return {
    person: id, class: "primary", role: "police_officer", duty: "patrol",
    occupation: "3870", site: STATION, mode: "sited", platoon: "day",
    shift: { watch: "day", start: 420, end: 900, report: 15,
             rota: { kind: "person", on: 5, off: 2, rest: [5, 6] } },
  };
}

function medic(id: number, role: "emt" | "paramedic"): Assignment {
  return {
    person: id, class: "primary", role, duty: "response", crew: "medic1",
    occupation: "3402", site: HOUSE, mode: "sited", platoon: "a",
    shift: { watch: "a", start: 420, end: 1860, report: 15,
             rota: { kind: "platoon", on: 1, off: 2, offset: DAY % 3 } },
  };
}

function city(): World {
  const officers = Array.from({ length: 12 }, (_, i) => 100 + i);
  const persons = new Map<number, Person>();
  const assignments = new Map<number, Assignment>();
  for (const id of officers) { persons.set(id, person(id, "3870")); assignments.set(id, officer(id)); }
  persons.set(200, person(200, "3402")); assignments.set(200, medic(200, "emt"));
  persons.set(201, person(201, "3402")); assignments.set(201, medic(201, "paramedic"));
  for (let id = 300; id < 340; id += 1) persons.set(id, person(id, "1000"));
  const households = new Map([...persons.keys()].map((id) => [id, { id, size: 1, income: 60_000, dwelling: `dwelling/${id}` }]));
  const places = new Map<string, { lat: number; lon: number }>([[STATION, STATION_POINT], [HOUSE, HOUSE_POINT]]);
  for (const id of persons.keys()) places.set(`dwelling/${id}`, { lat: 40.6 + (id % 40) * 3e-4, lon: -75.47 + (id % 7) * 2e-4 });
  return {
    persons, households, assignments, places,
    school: { riders: new Map(), driving: new Map(), runs: new Map(), ridesOn: new Map(),
              escorting: new Map(), depots: new Map(), startTimes: {}, dayLength: {} } as World["school"],
    fleet: {
      operators: new Map(), drivers: new Map(), vehicles: [],
      patrolCars: new Map([[STATION, ["CAR1", "CAR2", "CAR3", "CAR4"].map((vin) => ({
        vin, service_class: "police" as const, operator: 1, owner_driver: null, base: STATION,
      }))]]),
      ambulances: new Map([[HOUSE, [{ vin: "AMB1", service_class: "ems" as const, operator: 2, owner_driver: null, base: HOUSE }]]]),
    },
    vehicles: new Map(),
    householdVehicles: new Map(),
    carless: new Set(),
    seed: 20260731,
  } as unknown as World;
}

function calls(world: World, count: number): PlacedCall[] {
  const out: PlacedCall[] = [];
  for (let i = 0; i < count; i += 1) {
    const caller = 300 + (i % 40);
    const home = world.places.get(`dwelling/${caller}`)!;
    const road = i % 4 === 3;
    out.push({
      index: i, caller, minute: 480 + i * 17,
      place: road
        ? { lat: home.lat + 1e-3, lon: home.lon, id: null, kind: "kerb", label: "roadside" }
        : { ...home, id: null, kind: "home", label: "home" },
    });
  }
  return out;
}

function contiguous(stays: readonly { arrive: number; leave: number; minutes?: number }[]): void {
  for (let i = 0; i < stays.length; i += 1) {
    const stay = stays[i]!;
    expect(stay.leave).toBeGreaterThan(stay.arrive);
    if (i === 0) continue;
    const previous = stays[i - 1]!;
    expect(stay.minutes ?? 0).toBeGreaterThan(0);
    expect(stay.arrive - (stay.minutes ?? 0)).toBeGreaterThanOrEqual(previous.leave);
  }
}

describe("the dispatcher", () => {
  const world = city();
  const roads = fakeRoads();
  const context = { world, roads, hospitals: [HOSPITAL] };

  test("sends police and ambulances, and the same ones every time", () => {
    const first = dispatchCalls(context, DATE, DAY, calls(world, 30));
    const second = dispatchCalls(context, DATE, DAY, calls(world, 30));
    expect(JSON.stringify(first.responses)).toBe(JSON.stringify(second.responses));
    expect(first.incidents).toHaveLength(30);
    expect(first.responses.some((r) => r.service === "police")).toBe(true);
    expect(first.responses.some((r) => r.service === "ems")).toBe(true);
    for (const response of first.responses) {
      expect(response.arrivedAt).toBeGreaterThan(response.dispatchedAt);
      expect(response.clearedAt).toBeGreaterThan(response.arrivedAt);
      const incident = first.incidents[response.incident]!;
      expect(response.dispatchedAt).toBeGreaterThanOrEqual(incident.receivedAt);
    }
    // A unit is in one place at a time.
    const byVin = new Map<string, typeof first.responses>();
    for (const r of first.responses) byVin.set(r.vin, [...(byVin.get(r.vin) ?? []), r]);
    for (const runs of byVin.values()) {
      runs.sort((a, b) => a.dispatchedAt - b.dispatchedAt);
      for (let i = 1; i < runs.length; i += 1) {
        const end = runs[i - 1]!.transport?.leftAt ?? runs[i - 1]!.clearedAt;
        expect(runs[i]!.dispatchedAt).toBeGreaterThanOrEqual(end);
      }
    }
  });

  test("the caller waits for the first unit and then at least twenty minutes", () => {
    const table = dispatchCalls(context, DATE, DAY, calls(world, 30));
    for (const incident of table.incidents) {
      const first = Math.min(...incident.responses.map((r) => r.arrivedAt));
      if (Number.isFinite(first)) expect(incident.holdUntil).toBeGreaterThanOrEqual(first + 20);
      else expect(incident.holdUntil).toBeGreaterThan(incident.receivedAt);
      expect(table.holds.get(incident.caller)?.until).toBe(incident.holdUntil);
    }
  });

  test("a patrol tour with its runs spliced in is still one contiguous watch", () => {
    const table = dispatchCalls(context, DATE, DAY, calls(world, 30));
    const officers = [...table.byPerson.entries()].filter(([, runs]) => runs[0]!.service === "police");
    expect(officers.length).toBeGreaterThan(0);
    for (const [id, runs] of officers) {
      const block = { kind: "work" as const, start: 405, end: 900, site: STATION, mode: "sited" as const,
        role: "police_officer", duty: "patrol", watch: "day", crew: null, fixed: true };
      const baseline = patrolStays({ world, roads }, world.persons.get(id)!, block, DATE, DAY);
      const tour = respondingTour(baseline, runs);
      contiguous(tour);
      expect(tour[0]!.ref.kind).toBe("station");
      expect(tour[tour.length - 1]!.ref.kind).toBe("station");
      expect(tour[tour.length - 1]!.arrive).toBe(baseline[baseline.length - 1]!.arrive);
      const scenes = tour.filter((stay) => stay.ref.kind === "scene");
      expect(scenes).toHaveLength(runs.length);
      for (const [n, scene] of scenes.entries()) {
        expect(scene.arrive).toBe(runs[n]!.arrivedAt);
        expect(scene.purpose).toBe("response");
        expect(scene.vehicleId).toBe(runs[n]!.vin);
      }
    }
  });

  test("both crew members ride the same ambulance and only the driver carries it", () => {
    const table = dispatchCalls(context, DATE, DAY, calls(world, 30));
    const runs = table.byPerson.get(200) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    expect(table.byPerson.get(201)).toEqual(runs);
    const duty = table.ambulances.get(200)!;
    expect(duty.driver).toBe(200);
    const driver = ambulanceStays(duty, runs, 200, DAY, 1860);
    const partner = ambulanceStays(duty, runs, 201, DAY, 1875);
    contiguous(driver);
    contiguous(partner);
    expect(driver.map((s) => [s.arrive, s.ref.journeyId])).toEqual(partner.map((s) => [s.arrive, s.ref.journeyId]));
    expect(driver[0]!.place.id).toBe(HOUSE);
    expect(driver[driver.length - 1]!.place.id).toBe(HOUSE);
    expect(partner[partner.length - 1]!.leave).toBe(1875);
    for (const [i, stay] of driver.entries()) {
      if (i === 0) continue;
      expect(stay.mode).toBe("ambulance");
      expect(stay.vehicleId).toBe("AMB1");
      expect(partner[i]!.mode).toBe("passenger");
      expect(partner[i]!.vehicleId).toBeUndefined();
    }
    if (runs.some((r) => r.transport)) expect(driver.some((s) => s.ref.kind === "hospital")).toBe(true);
  });

  test("the call draw is per resident, adults only, and never a responder", () => {
    const draws = sampleCalls(world, DAY);
    expect(draws.length).toBeGreaterThan(0);
    for (const draw of draws) {
      expect(draw.minute).toBeGreaterThanOrEqual(420);
      expect(draw.minute).toBeLessThan(1860);
      expect(draw.caller).toBeGreaterThanOrEqual(300);
    }
    expect(new Set(draws.map((d) => d.caller)).size).toBe(draws.length);
    expect(sampleCalls(world, DAY)).toEqual(draws);
  });
});

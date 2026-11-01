import { describe, expect, test } from "bun:test";
import type { Assignment, Person, World } from "../../world/index.ts";
import type { Roads } from "../../transport/index.ts";
import { patrolStays, unitFor } from "./patrol.ts";

const STATION = "way/1";
const STATION_POINT = { lat: 40.6, lon: -75.47 };

/**
 * A road graph small enough to reason about: a hundred nodes in a grid around
 * the station, every one of them on a residential street and in the largest
 * component, and a trip cost of a kilometre and two minutes between any pair.
 */
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
    trip: () => ({ minutes: 2, kilometres: 1, fromNode: 0, toNode: 1, estimated: false }),
  } as unknown as Roads;
}

function officer(id: number): Person {
  return { id, household: id, age: 30, sex: 1, employment: 1, occupation: "3870",
    hours: 40, depart: 405, arrive: 420, travel: 15, transport: "1",
    enrolled: null, grade: null } as Person;
}

function assignment(person: number): Assignment {
  return {
    person, class: "primary", role: "police_officer", duty: "patrol",
    occupation: "3870", site: STATION, mode: "sited", platoon: "day",
    shift: { watch: "day", start: 420, end: 900, report: 15,
             rota: { kind: "person", on: 5, off: 2, rest: [5, 6] } },
  };
}

function world(officers: number[], cars: string[]): World {
  const persons = new Map(officers.map((id) => [id, officer(id)]));
  const households = new Map(officers.map((id) => [id, {
    id, size: 1, income: 70_000, dwelling: `dwelling/${id}`,
  }]));
  const places = new Map<string, { lat: number; lon: number }>([[STATION, STATION_POINT]]);
  for (const id of officers) places.set(`dwelling/${id}`, { lat: 40.6 + id * 1e-4, lon: -75.46 });
  return {
    persons,
    households,
    assignments: new Map(officers.map((id) => [id, assignment(id)])),
    places,
    school: { riders: new Map(), driving: new Map(), runs: new Map(), ridesOn: new Map(),
              escorting: new Map(), depots: new Map(), startTimes: {}, dayLength: {} } as World["school"],
    fleet: {
      operators: new Map(), drivers: new Map(), vehicles: [], ambulances: new Map(),
      patrolCars: new Map([[STATION, cars.map((vin) => ({
        vin, service_class: "police" as const, operator: 1, owner_driver: null, base: STATION,
      }))]]),
    },
    vehicles: new Map(),
    householdVehicles: new Map(),
    carless: new Set(),
    seed: 20260731,
  };
}

const DATE = new Date(Date.UTC(2026, 6, 28));
const DAY = 4000;

describe("patrol units", () => {
  test("a station puts out no more units than it has cars", () => {
    const officers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const city = world(officers, ["CAR1", "CAR2"]);
    const roads = fakeRoads();

    const assigned = officers.flatMap((id) => {
      const unit = unitFor(city, roads, city.persons.get(id)!, block(), DATE, DAY);
      return unit ? [unit] : [];
    });

    expect(assigned.length).toBeLessThanOrEqual(2);
    expect(new Set(assigned.map((unit) => unit.vin)).size).toBe(assigned.length);
  });

  test("a station with no cars puts out nothing", () => {
    const city = world([1, 2, 3], []);
    const roads = fakeRoads();
    for (const id of [1, 2, 3]) {
      expect(unitFor(city, roads, city.persons.get(id)!, block(), DATE, DAY)).toBeNull();
    }
  });
});

describe("a watch", () => {
  test("starts and ends at the station, with the car on every leg between", () => {
    const officers = [1, 2, 3, 4, 5, 6, 7, 8];
    const city = world(officers, ["CAR1", "CAR2", "CAR3"]);
    const roads = fakeRoads();

    const driving = officers
      .map((id) => patrolStays({ world: city, roads }, city.persons.get(id)!, block(), DATE, DAY))
      .filter((stays) => stays.length > 0);
    expect(driving.length).toBeGreaterThan(0);

    for (const stays of driving) {
      const first = stays[0]!;
      const last = stays[stays.length - 1]!;
      expect(first.place.id).toBe(STATION);
      expect(last.place.id).toBe(STATION);
      // The journey into the first stay is the officer's own commute, so it
      // carries no mode; everything after it is the patrol car.
      expect(first.mode).toBeUndefined();
      expect(first.arrive).toBe(405);
      // Back before the watch ends, whatever the block's overtime says.
      expect(last.arrive).toBeLessThan(900);

      for (const stay of stays.slice(1)) {
        expect(stay.mode).toBe("patrol");
        expect(stay.vehicleId).toBe(stays[stays.length - 1]!.ref.vin!);
        expect(stay.minutes).toBeGreaterThan(0);
      }
      // Every stay is reachable from the one before it in the time allowed.
      for (let i = 1; i < stays.length; i += 1) {
        expect(stays[i]!.arrive - stays[i - 1]!.leave).toBeGreaterThanOrEqual(stays[i]!.minutes!);
      }
      expect(stays.some((stay) => stay.ref.kind === "meal")).toBe(true);
    }
  });

  test("nobody who is not a patrol officer has one", () => {
    const city = world([1, 2, 3], ["CAR1"]);
    const roads = fakeRoads();
    city.assignments.get(2)!.duty = "investigations";
    city.assignments.get(3)!.role = "paramedic";
    for (const id of [2, 3]) {
      expect(patrolStays({ world: city, roads }, city.persons.get(id)!, block(), DATE, DAY)).toHaveLength(0);
    }
  });
});

/** The roster block a day watch produces: report at 06:45, off at 15:00. */
function block() {
  return {
    kind: "work" as const, start: 405, end: 900, site: STATION,
    mode: "sited" as const, role: "police_officer", duty: "patrol",
    watch: "day", crew: null, fixed: true,
  };
}

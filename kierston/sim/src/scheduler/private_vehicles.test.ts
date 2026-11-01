import { describe, expect, test } from "bun:test";
import type { Day } from "./compose.ts";
import { PrivateVehicleFleet } from "./private_vehicles.ts";
import type { Person, World } from "../world/index.ts";
import type { Place } from "../transport/index.ts";
import type { TravelEvent } from "./types.ts";

const home: Place = { lat: 40.6, lon: -75.49, id: null, kind: "home", label: "home" };
const work: Place = { lat: 40.61, lon: -75.47, id: "work/1", kind: "work", label: "work" };

function world(vins: string[]): World {
  const people: Person[] = [
    { id: 1, household: 10, age: 40, sex: 1, employment: null, occupation: null, hours: null,
      depart: null, arrive: null, travel: null, transport: null, enrolled: null, grade: null },
    { id: 2, household: 10, age: 38, sex: 2, employment: null, occupation: null, hours: null,
      depart: null, arrive: null, travel: null, transport: null, enrolled: null, grade: null },
  ];
  return {
    persons: new Map(people.map((person) => [person.id, person])),
    households: new Map([[10, { id: 10, size: 2, income: 80_000, dwelling: "dwelling/10" }]]),
    assignments: new Map(),
    places: new Map([["dwelling/10", home]]),
    school: {} as World["school"], fleet: { operators: new Map(), vehicles: [], drivers: new Map(), patrolCars: new Map(), ambulances: new Map() },
    vehicles: new Map(vins.map((vin, index) => [vin, {
      vin, owner: index + 1, owner_type: "person" as const, household: 10,
      service_class: null, seats: null,
    }])),
    householdVehicles: new Map([[10, vins]]), carless: new Set(), seed: 1,
  };
}

function day(person: number, journeyId: string, start: number, end: number, from = home, to = work): Day {
  const event: TravelEvent = {
    kind: "travel", journeyId, journeyRoot: journeyId, purpose: "work", mode: "car",
    from, to, start, end, kilometres: 2, estimated: false,
    parking: { kind: "lot", at: work, searchMinutes: 0, walkMinutes: 0, metres: 0 },
  };
  return {
    person,
    scheduled: { person, timeline: [event], rejected: [], lateMinutes: 0,
      metrics: { trips: 1, drivenKm: 2, walkedKm: 0, rejected: 0 } },
    legs: [{ journeyId, purpose: "work", mode: "car", from, to, fromLabel: from.label,
      toLabel: to.label, depart: start, arrive: end, kilometres: 2, estimated: false }],
    drivenKm: 2, walkedKm: 0,
  } as unknown as Day;
}

describe("household vehicle allocation", () => {
  test("one car cannot serve two overlapping household journeys", () => {
    const data = world(["VIN1"]);
    const fleet = PrivateVehicleFleet.build(data, 10, [...data.persons.values()]);
    const days = [day(1, "a", 480, 510), day(2, "b", 490, 520)];
    fleet.execute(days);
    expect(days[0]!.legs[0]!.vehicleId).toBe("VIN1");
    expect(days[1]!.legs[0]!.vehicleId).toBeUndefined();
    expect(days[1]!.legs[0]!.mode).toBe("transit");
    expect(fleet.tally.unavailable).toBe(1);
  });

  test("two cars can leave the same household concurrently", () => {
    const data = world(["VIN1", "VIN2"]);
    const fleet = PrivateVehicleFleet.build(data, 10, [...data.persons.values()]);
    const days = [day(1, "a", 480, 510), day(2, "b", 490, 520)];
    fleet.execute(days);
    expect(days[0]!.legs[0]!.vehicleId).toBe("VIN1");
    expect(days[1]!.legs[0]!.vehicleId).toBe("VIN2");
    expect(fleet.tally.unavailable).toBe(0);
  });

  test("one VIN can pass to another member after it returns home", () => {
    const data = world(["VIN1"]);
    const fleet = PrivateVehicleFleet.build(data, 10, [...data.persons.values()]);
    const days = [day(1, "outbound", 480, 510), day(1, "return", 600, 630, work, home),
      day(2, "next", 700, 730)];
    fleet.execute(days);
    expect(days.map((row) => row.legs[0]!.vehicleId)).toEqual(["VIN1", "VIN1", "VIN1"]);
  });

  test("an already-started carried journey keeps its VIN and reserves it through arrival", () => {
    const data = world(["VIN1"]);
    const midnight: Place = { lat: 40.605, lon: -75.48, id: null, kind: "kerb", label: "in motion" };
    const fleet = PrivateVehicleFleet.build(data, 10, [...data.persons.values()], [
      { id: "VIN1", location: midnight },
    ]);
    const carried = day(1, "carried", -11, 11);
    (carried.scheduled.timeline[0]! as TravelEvent).vehicleId = "VIN1";
    carried.legs[0]!.vehicleId = "VIN1";
    const competing = day(2, "competing", 5, 20, midnight, work);

    fleet.execute([carried, competing]);

    expect(carried.legs[0]!.mode).toBe("car");
    expect(carried.legs[0]!.vehicleId).toBe("VIN1");
    expect(competing.legs[0]!.mode).toBe("transit");
    expect(competing.legs[0]!.vehicleId).toBeUndefined();
  });

  test("repeated shared-journey ids do not copy the last segment's VIN onto earlier legs", () => {
    const data = world(["VIN1"]);
    const fleet = PrivateVehicleFleet.build(data, 10, [...data.persons.values()]);
    const mine = day(1, "shared/out", 480, 510);
    const elsewhere: Place = {
      lat: 40.68, lon: -75.39, id: "venue/elsewhere", kind: "venue", label: "elsewhere",
    };
    const second: TravelEvent = {
      kind: "travel", journeyId: "shared/out", journeyRoot: "shared/out", purpose: "meet", mode: "car",
      from: elsewhere, to: home, start: 520, end: 550, kilometres: 2, estimated: false,
    };
    mine.scheduled.timeline.push(second);
    mine.legs.push({
      journeyId: "shared/out", purpose: "meet", mode: "car", from: elsewhere, to: home,
      fromLabel: elsewhere.label, toLabel: home.label, depart: 520, arrive: 550,
      kilometres: 2, estimated: false,
    });

    fleet.execute([mine]);

    expect(mine.legs[0]!.vehicleId).toBe("VIN1");
    expect(mine.legs[0]!.mode).toBe("car");
    expect(mine.legs[1]!.vehicleId).toBeUndefined();
    expect(mine.legs[1]!.mode).toBe("transit");
  });
});

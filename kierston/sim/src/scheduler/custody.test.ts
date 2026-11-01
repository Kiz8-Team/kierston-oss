import { describe, expect, test } from "bun:test";
import { loadDayContext } from "../engine/index.ts";
import { haversineKm } from "../transport/index.ts";
import { homeOf, simDataPresent } from "../world/index.ts";
import { dayNumber, parseDate } from "../shared/index.ts";
import { HouseholdDayPlanner, planDay } from "./index.ts";

const CITY = simDataPresent("population.json", "vehicles.json", "car_graph.bin");

describe.skipIf(!CITY)("household vehicles in custody", () => {
  test("exported residents retain continuous VIN chains without omitted prison drivers", async () => {
    const context = await loadDayContext();
    context.householdPlanner = new HouseholdDayPlanner();
    const date = parseDate("2026-09-05");
    const prisoner = [...context.world.persons.values()].find((person) => person.incarcerated)!;
    expect(planDay(context, prisoner, date, dayNumber(date)).scheduled.timeline).toHaveLength(0);
    expect(planDay({ ...context, householdPlanner: undefined }, prisoner, date, dayNumber(date)).legs).toHaveLength(0);
    const households = new Set([...context.world.persons.values()]
      .filter((person) => person.incarcerated).map((person) => person.household));
    const residents = [...context.world.persons.values()]
      .filter((person) => !person.incarcerated && households.has(person.household));
    const movements = residents.flatMap((person) => planDay(context, person, date, dayNumber(date)).legs)
      .filter((leg) => leg.vehicleId !== undefined).sort((a, b) => a.depart - b.depart);
    expect(movements.length).toBeGreaterThan(0);
    const positions = new Map<string, { lat: number; lon: number }>();
    for (const leg of movements) {
      const vehicle = context.world.vehicles.get(leg.vehicleId!)!;
      const resident = residents.find((person) => person.household === vehicle.household)!;
      const previous = positions.get(vehicle.vin) ?? homeOf(context.world, resident)!;
      expect(haversineKm(previous, leg.from), `${vehicle.vin} before ${leg.journeyId}`).toBeLessThanOrEqual(0.1);
      positions.set(vehicle.vin, leg.to);
    }
  });
});

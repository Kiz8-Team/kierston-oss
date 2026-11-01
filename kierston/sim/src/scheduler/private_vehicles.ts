/** Deterministic execution of actual household car journeys against real VINs. */

import { homeOf, type Person, type World } from "../world/index.ts";
import { drivenKilometres, haversineKm, walkedKilometres, type Place } from "../transport/index.ts";
import type { Day } from "./compose.ts";
import type { TravelEvent } from "./types.ts";

interface Request {
  event: TravelEvent;
  person: number;
}

interface RuntimeVehicle {
  vin: string;
  owner: number;
  at: Place;
  freeAt: number;
}

export interface PrivateVehicleTally {
  requests: number;
  assigned: number;
  unavailable: number;
  vehicles: number;
}

/**
 * Execute the household's final car legs in clock order.
 *
 * The days handed here are the only days the exporter will use. Allocation
 * writes the VIN onto those exact events and legs; it never asks the scheduler
 * to compose them again, so journey identity and mode choice cannot diverge
 * between a demand plan and a later pass.
 */
export class PrivateVehicleFleet {
  readonly tally: PrivateVehicleTally;

  private constructor(private readonly vehicles: RuntimeVehicle[]) {
    this.tally = { requests: 0, assigned: 0, unavailable: 0, vehicles: vehicles.length };
  }

  execute(days: readonly Day[]): void {
    const requests: Request[] = days.flatMap((day) => day.scheduled.timeline.flatMap((event) =>
      event.kind === "travel" && event.mode === "car" ? [{ event, person: day.person }] : []));
    requests.sort((a, b) => a.event.start - b.event.start || a.event.end - b.event.end
      || a.event.journeyId.localeCompare(b.event.journeyId) || a.person - b.person);

    // A VIN already present on an event came from yesterday's authoritative
    // continuation. Reserve it before allocating any fresh demand. In
    // particular, a journey crossing midnight starts at a negative minute in
    // today's frame while the opening vehicle position is its coordinate at
    // minute zero; asking that position to match yesterday's origin would
    // incorrectly reject the journey and turn it into transit.
    for (const { event } of requests) {
      if (event.vehicleId === undefined) continue;
      const vehicle = this.vehicles.find((candidate) => candidate.vin === event.vehicleId);
      if (!vehicle) throw new Error(`carried journey ${event.journeyId} references unavailable VIN ${event.vehicleId}`);
      if (vehicle.freeAt > event.start) {
        throw new Error(`carried VIN ${vehicle.vin} overlaps journey ${event.journeyId}`);
      }
      // The carried event is the authority even when a separately derived
      // midnight coordinate is coarser than its origin. Rewriting yesterday's
      // committed leg would make the two KDAY files disagree; following it
      // also restores the exact location from which fresh allocation resumes.
      vehicle.at = event.to;
      vehicle.freeAt = event.end;
      this.tally.requests += 1;
      this.tally.assigned += 1;
    }

    for (const request of requests) {
      const { event, person } = request;
      if (event.vehicleId !== undefined) continue;
      this.tally.requests += 1;
      const candidates = this.vehicles
        .filter((vehicle) => vehicle.freeAt <= event.start && samePoint(vehicle.at, event.from))
        .sort((a, b) => Number(b.owner === person) - Number(a.owner === person)
          || a.vin.localeCompare(b.vin));
      const vehicle = candidates[0];
      if (!vehicle) {
        // The person still makes the already-timed journey, but not in a car
        // that does not exist. Keeping its geometry and duration fixed avoids
        // changing the activity sequence after vehicle execution has begun.
        event.mode = "transit";
        delete event.parking;
        this.tally.unavailable += 1;
        continue;
      }
      event.vehicleId = vehicle.vin;
      vehicle.at = event.to;
      vehicle.freeAt = event.end;
      this.tally.assigned += 1;
    }

    // Legs are the packed view of the same timeline, in the same order. Pair
    // them one-to-one: a shared ride deliberately gives several consecutive
    // physical segments the same journey id, so a Map keyed by journey id
    // collapses those segments and copies the last one's VIN onto all of them.
    for (const day of days) {
      const events = day.scheduled.timeline.filter((event): event is TravelEvent => event.kind === "travel");
      if (events.length !== day.legs.length) {
        throw new Error(
          `person ${day.person} has ${events.length} travel events but ${day.legs.length} legs during VIN execution`,
        );
      }
      for (let index = 0; index < day.legs.length; index += 1) {
        const leg = day.legs[index]!;
        const event = events[index]!;
        if (leg.journeyId !== event.journeyId) {
          throw new Error(
            `person ${day.person} leg ${index} is ${leg.journeyId ?? "unidentified"} but its event is ${event.journeyId}`,
          );
        }
        leg.mode = event.mode;
        if (event.vehicleId === undefined) delete leg.vehicleId;
        else leg.vehicleId = event.vehicleId;
        if (event.parking === undefined) delete leg.parking;
        else leg.parking = event.parking;
      }
      day.drivenKm = drivenKilometres(day.legs);
      day.walkedKm = walkedKilometres(day.legs);
      day.scheduled.metrics.drivenKm = day.drivenKm;
      day.scheduled.metrics.walkedKm = day.walkedKm;
    }
  }

  static build(
    world: World,
    household: number,
    members: readonly Person[],
    opening: readonly { id: string | null; location: Place | null }[] = [],
  ): PrivateVehicleFleet {
    const point = members.length > 0 ? homeOf(world, members[0]!) : null;
    if (!point) return new PrivateVehicleFleet([]);
    const home: Place = { ...point, id: null, kind: "home", label: "home" };
    const openingByVin = new Map(opening.flatMap((row) => row.id && row.location ? [[row.id, row.location]] : []));
    const vehicles = (world.householdVehicles.get(household) ?? []).flatMap((vin) => {
      const row = world.vehicles.get(vin);
      // Taxi VINs are owned by the cab dispatcher, even when the registered
      // owner belongs to this household.
      return row && row.service_class === null
        ? [{ vin, owner: row.owner, at: openingByVin.get(vin) ?? home, freeAt: -Infinity }]
        : [];
    });
    return new PrivateVehicleFleet(vehicles);
  }
}

function samePoint(a: Place, b: Place): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return haversineKm(a, b) < 0.08;
}

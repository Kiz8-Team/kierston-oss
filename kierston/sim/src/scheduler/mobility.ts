import type { Person } from "../world/index.ts";
import { haversineKm } from "../transport/index.ts";
import {
  DRIVING,
  estimateTransition,
  modeOf,
  priceTransition,
  type LegMode,
  type Place,
  type TravelContext,
} from "../transport/index.ts";
import type { TransitionPlanner, TransitionRequest, TravelEvent } from "./types.ts";

/**
 * How a given person travels, asked per traveller rather than per trip.
 *
 * A function and not a value because one person's day contains other people's
 * journeys — a parent driving a child, a cabbie carrying a fare — and each of
 * those has to be priced by the mode of whoever is at the wheel.
 */
export type MobilityPolicy = (person: Person) => { usual: LegMode; hireShare?: number };

/**
 * The scheduler's view of the road network, mode choice and parking.
 *
 * Everything here is a wrapper over the calibrated primitives in `travel.ts`;
 * nothing in this class decides where anyone goes or when. It answers exactly
 * one journey at a time and holds no state between calls, which is what keeps
 * the division clean: the planner owns placement and sequence, this owns
 * distance, duration and mode.
 *
 * The two methods have to agree. `latestDeparture` prices the same parking from
 * the same deterministic supply as `transition` will charge for, so the residual
 * difference between the backward estimate and the forward answer is only the
 * congestion that moving the departure minute introduced.
 */
export class RoutedMobility implements TransitionPlanner {
  constructor(
    private readonly context: TravelContext,
    private readonly people: ReadonlyMap<number, Person>,
    private readonly policy: MobilityPolicy = (person) => ({ usual: modeOf(person) }),
  ) {}

  transition(request: TransitionRequest) {
    const person = this.people.get(request.person);
    if (!person) return null;
    // Staying put is not a journey. Returning no events rather than a
    // zero-length leg is what keeps the trip count honest — two activities in
    // one building are one arrival.
    if (samePlace(request.from, request.to)) {
      return { events: [], arrive: request.depart, vehicleAt: request.vehicleAt };
    }
    const policy = this.policy(person);
    const context = policy.hireShare === undefined
      ? this.context
      : { ...this.context, hireShare: policy.hireShare };
    const usual = request.override?.mode ?? policy.usual;
    const root = request.override?.journeyId ?? journeyKey(request);
    // An unstated vehicle location means the caller is asking whether the trip
    // is possible at all, not tracking a real car around the city: assume the
    // car is here if this person drives one of their own. A hired vehicle never
    // counts — a taxi is not parked outside waiting for its passenger.
    const carAt = request.vehicleAt === undefined
      ? (DRIVING.has(usual) && usual !== "taxi" && usual !== "cab" ? request.from : null)
      : request.vehicleAt;
    const priced = priceTransition(
      context,
      person,
      request.day,
      usual,
      carAt,
      request.from,
      request.to,
      request.depart,
      request.purpose,
      request.returnsHere ?? false,
      request.override?.minutes,
      request.override?.journeyId,
    );
    const events: TravelEvent[] = [];
    let at = request.depart;
    // One journey can be several segments — the walk back to the car, the drive,
    // the walk from the parking space. They share a root id with an index
    // suffix so a multi-segment journey is still recognisable as one movement.
    for (let index = 0; index < priced.segments.length; index += 1) {
      const segment = priced.segments[index]!;
      const kilometres = pathKilometres(
        context.roads.path(segment.from, segment.to, segment.mode === "walk"),
      );
      // KDAY stores whole minutes. Rounding both endpoints independently used
      // to turn real sub-minute movements into zero-duration legs. Advance the
      // canonical clock by a rounded duration instead, with one minute as the
      // minimum for any non-zero journey.
      const start = Math.round(at);
      const duration = roundedDuration(segment.mode, kilometres, segment.minutes);
      const end = start + duration;
      // A dispatched VIN belongs to the vehicle-bearing segment, not to the
      // access/egress walks that may surround it. Live reservations identify
      // private cars; overrides identify fleet vehicles such as cabs and buses.
      const vehicleId = segment.vehicleId ?? (
        vehicleBearingMode(segment.mode) ? request.override?.vehicleId : undefined
      );
      events.push({
        kind: "travel",
        journeyId: priced.segments.length === 1 ? root : `${root}/${index}`,
        journeyRoot: root,
        ...(vehicleId === undefined ? {} : { vehicleId }),
        purpose: segment.purpose,
        mode: segment.mode,
        from: segment.from,
        to: segment.to,
        start,
        end,
        kilometres: Math.round(kilometres * 100) / 100,
        estimated: segment.estimated,
        ...(segment.parking === undefined ? {} : { parking: segment.parking }),
        ...(segment.wait === undefined ? {} : { wait: segment.wait }),
      });
      at = end;
    }
    return { events, arrive: Math.round(at), vehicleAt: priced.carAt };
  }

  /**
   * The last minute a person can leave and still arrive on time.
   *
   * A stated duration wins outright: where a bus run or a dispatched fare has
   * already been priced, the answer is arithmetic and re-routing it would give
   * a second opinion about a journey somebody else owns.
   */
  latestDeparture(request: Omit<TransitionRequest, "depart"> & { arriveBy: number }) {
    const person = this.people.get(request.person);
    if (!person) return null;
    if (samePlace(request.from, request.to)) return request.arriveBy;
    if (request.override?.minutes !== undefined) return request.arriveBy - request.override.minutes;
    const policy = this.policy(person);
    const context = policy.hireShare === undefined
      ? this.context
      : { ...this.context, hireShare: policy.hireShare };
    const usual = request.override?.mode ?? policy.usual;
    const minutes = estimateTransition(context, person, request.day, usual, request.from, request.to, request.arriveBy);
    return Math.round(request.arriveBy - minutes);
  }
}

function vehicleBearingMode(mode: TravelEvent["mode"]): boolean {
  return mode === "car" || mode === "cab" || mode === "bus" || mode === "patrol" || mode === "ambulance";
}

function roundedDuration(mode: TravelEvent["mode"], kilometres: number, minutes: number): number {
  return Math.max(kilometres > 0 ? 1 : 0, plausibleMinimumMinutes(mode, kilometres), Math.round(minutes));
}

function pathKilometres(path: readonly { lat: number; lon: number }[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += haversineKm(path[index - 1]!, path[index]!);
  return total;
}

/**
 * A floor on how long a journey of a given length can possibly have taken.
 *
 * Supplied durations — a bus run's share, a survey answer — are about a journey
 * this module did not route, and occasionally they disagree with the geometry
 * badly enough to imply a walk at forty kilometres an hour. The speeds below
 * are generous ceilings rather than modelling assumptions: they exist only to
 * keep the packed event structurally plausible, not to price anything.
 */
function plausibleMinimumMinutes(mode: TravelEvent["mode"], kilometres: number): number {
  const kilometresPerHour: Partial<Record<TravelEvent["mode"], number>> = {
    walk: 9,
    bike: 45,
    car: 140,
    carpool: 140,
    taxi: 140,
    cab: 140,
    passenger: 140,
    patrol: 140,
    ambulance: 140,
    transit: 120,
    bus: 120,
    other: 200,
  };
  return Math.ceil((kilometres / (kilometresPerHour[mode] ?? 200)) * 60);
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.kind === b.kind && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

function journeyKey(request: TransitionRequest): string {
  return `${request.person}/${request.day}/${placeKey(request.from)}>${placeKey(request.to)}/${request.purpose}/${Math.round(request.depart)}`;
}

function placeKey(place: Place): string {
  return place.id ?? `${place.kind}@${place.lat.toFixed(5)},${place.lon.toFixed(5)}`;
}

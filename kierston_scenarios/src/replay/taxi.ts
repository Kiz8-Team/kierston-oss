import { dayFromTimeline, RoutedMobility, products, transport, shared, type DayContext, type TravelEvent } from "../../../kierston/sim/src/index.ts";
import { Baseline, positionAt, type RecordedDay } from "./baseline.ts";
import { idle, spliceTimeline, type Timeline } from "./movement.ts";
import type { Goto, Window } from "../authoring/dsl.ts";

/** Split a recorded route at a boundary, retaining its driven prefix/suffix. */
function cutAt(recorded: RecordedDay, at: number): RecordedDay {
  const timeline: Timeline = [];
  const paths = new Map(recorded.paths);
  for (const event of recorded.day.scheduled.timeline) {
    if (event.kind !== "travel" || event.start >= at || event.end <= at) { timeline.push(event); continue; }
    const point = positionAt([event], at, recorded.home, paths);
    const line = paths.get(products.pathKey({ journeyId: event.journeyId, depart: event.start, arrive: event.end }))
      ?? paths.get(event.journeyId) ?? [event.from, event.to];
    const total = line.reduce((sum, p, i) => sum + (i ? transport.haversineKm(line[i - 1]!, p) : 0), 0);
    let remaining = total * Math.max(0, Math.min(1, (at - event.start - (event.wait ?? 0))
      / Math.max(1, event.end - event.start - (event.wait ?? 0))));
    let segment = 1;
    for (; segment < line.length; segment++) {
      const length = transport.haversineKm(line[segment - 1]!, line[segment]!);
      if (remaining <= length) break;
      remaining -= length;
    }
    const before = `${event.journeyId}/before/${at}`, after = `${event.journeyId}/after/${at}`;
    paths.set(before, [...line.slice(0, segment), point]);
    paths.set(after, [point, ...line.slice(segment)]);
    timeline.push({ ...event, journeyId: before, end: at, to: point,
      kilometres: total * (at - event.start) / (event.end - event.start) });
    timeline.push({ ...event, journeyId: after, start: at, from: point, wait: 0,
      kilometres: total * (event.end - at) / (event.end - event.start) });
  }
  return { ...recorded, paths, day: dayFromTimeline(recorded.day.person, timeline) };
}

/** A rider's leg id without its trailing leg index: the id the cab's fare leg carries. */
const rideOf = (journey: string) => journey.replace(/\/\d+$/, "");

export class PriorityTaxis {
  constructor(
    private readonly context: DayContext, private readonly baseline: Baseline, private readonly date: Date,
    private readonly changed: Map<number, RecordedDay>, private readonly windows: Map<number, Window[]>,
    private readonly involve: (person: number, reason: string) => void,
    readonly cancellations: { driver: number; passenger: number; journey: string }[] = [],
  ) {}

  private async current(person: number): Promise<RecordedDay> { return this.changed.get(person) ?? this.baseline.person(person); }

  /** Close the dependency set: a displaced passenger may miss a later booking,
   * whose cancellation changes another driver's next pickup. Only those linked
   * fares are reconsidered; unrelated dispatch decisions remain fixed.
   */
  async reconcile(): Promise<void> {
    if (!this.changed.size) return;
    const [p, legs] = await Promise.all([this.baseline.file.table("person"), this.baseline.file.table("leg")]);
    const drivers = new Map<string, number>();
    const riders: { journey: string; passenger: number; depart: number; arrive: number }[] = [];
    for (let row = 0; row < p.id!.length; row++) {
      for (let i = p.legOffset![row]!; i < p.legOffset![row]! + p.legCount![row]!; i++) {
        const journey = this.baseline.file.string(legs.journey![i]!);
        if (!journey) continue;
        const mode = this.baseline.file.header.enums.mode![legs.mode![i]!];
        const purpose = this.baseline.file.header.enums.purpose![legs.purpose![i]!];
        if (mode === "cab" && purpose === "fare") drivers.set(journey, p.id![row]!);
        if (mode === "taxi") riders.push({ journey, passenger: p.id![row]!, depart: legs.depart![i]!, arrive: legs.arrive![i]! });
      }
    }
    riders.sort((a, b) => a.depart - b.depart || a.passenger - b.passenger);
    const day = shared.dayNumber(this.date);
    const mobility = new RoutedMobility({ roads: this.context.roads, kerb: this.context.kerb, seed: this.context.world.seed }, this.context.world.persons);
    let progress = true;
    while (progress) {
      progress = false;
      for (const booking of riders) {
        // The cab's fare leg carries the journey root; the rider's leg adds its index.
        const cabJourney = drivers.has(booking.journey) ? booking.journey : rideOf(booking.journey);
        const driver = drivers.get(cabJourney);
        const passengerDay = this.changed.get(booking.passenger);
        const passengerRemoved = passengerDay !== undefined && !passengerDay.day.legs.some((leg) => leg.journeyId === booking.journey
          && leg.mode === "taxi" && leg.depart === booking.depart && leg.arrive === booking.arrive);
        // A ride with no cab leg in the base day (the export has a few) has
        // no driver to free: removing the passenger cancels nothing.
        if (driver === undefined) continue;
        const driverDay = this.changed.get(driver);
        const driverRemoved = driverDay !== undefined && !driverDay.day.legs.some((leg) => leg.journeyId === cabJourney && leg.mode === "cab" && leg.purpose === "fare");
        if (passengerRemoved === driverRemoved) continue;
        if (passengerRemoved) {
          const recorded = await this.current(driver);
          const fare = recorded.day.legs.find((leg) => leg.journeyId === cabJourney && leg.mode === "cab" && leg.purpose === "fare")!;
          const point: transport.Place = { ...fare.from, id: null, kind: "kerb", label: "cancelled pickup" };
          // The cancellation frees the driver. Wait at the pickup, then route
          // to the first original commitment still reachable from there.
          await this.install(driver, fare.depart, idle(point, fare.depart, fare.depart + 1, `scenario/cancel/${booking.journey}`),
            "cab", `cancelled booking for person ${booking.passenger}`, fare.vehicleId);
          this.context.fleet ??= transport.Fleet.build(this.context.world, this.context.roads, this.date, day, [],
            this.context.stands ?? [], 1, this.context.state?.fleetForDay() ?? []);
        } else {
          const recorded = await this.current(booking.passenger);
          const original = recorded.day.legs.find((leg) => leg.journeyId === booking.journey && leg.mode === "taxi")!;
          const driverWindow = (this.windows.get(driver) ?? []).find((w) => w.start < original.arrive && original.depart < w.end);
          const start = Math.max(original.depart, driverWindow?.start ?? original.depart);
          const point = positionAt(recorded.day.scheduled.timeline, start, recorded.home, recorded.paths);
          const destination: transport.Place = { ...original.to, id: null, kind: "kerb", label: original.toLabel };
          const alternate = mobility.transition({ person: booking.passenger, day, from: point, to: destination, depart: start,
            purpose: "stop", override: { mode: "transit", journeyId: `scenario/cancelled/${booking.passenger}/${start}` } });
          if (!alternate?.events.length) throw new Error(`cannot reroute displaced passenger ${booking.passenger}`);
          await this.install(booking.passenger, start, alternate.events, "transit", `cancelled ride with driver ${driver}`);
        }
        if (!this.cancellations.some((row) => row.journey === booking.journey && row.passenger === booking.passenger)) {
          this.cancellations.push({ driver, passenger: booking.passenger, journey: booking.journey });
        }
        progress = true;
      }
    }
  }

  /**
   * Splice `inserted` into the person's day from `start`, followed by a route
   * back to the first original commitment still reachable. A driver's cab
   * legs carry `vin`, so the vehicle product keeps the cab moving with them;
   * without it the cab stays where its last recorded leg left it.
   */
  private async install(person: number, start: number, inserted: Timeline, mode: "cab" | "transit", reason: string, vin?: string): Promise<Window> {
    this.involve(person, reason);
    let recorded = await this.current(person);
    const last = inserted.at(-1)!;
    const place = last.kind === "travel" ? last.to : last.place;
    const at = last.end;
    const candidates = [...new Set([1440, ...recorded.day.scheduled.timeline.flatMap((e) => [e.start, e.end])])]
      .filter((time) => time >= at && time <= 1440).sort((a, b) => a - b);
    const mobility = new RoutedMobility({ roads: this.context.roads, kerb: this.context.kerb, seed: this.context.world.seed }, this.context.world.persons);
    for (const end of candidates) {
      const target = positionAt(recorded.day.scheduled.timeline, end, recorded.home, recorded.paths);
      const back = mobility.transition({ person, day: shared.dayNumber(this.date), from: place, to: target, depart: at,
        purpose: mode === "cab" ? "deadhead" : "home", override: { mode, journeyId: `scenario/rejoin/${person}/${start}` } });
      if (!back || back.arrive > end) continue;
      const window = { start, end };
      if ((this.windows.get(person) ?? []).some((w) => w.start < end && start < w.end)) throw new Error(`taxi consequence overlaps another replacement for person ${person}`);
      recorded = cutAt(cutAt(recorded, start), end);
      const driven = [...inserted, ...back.events].map((event) =>
        vin && event.kind === "travel" && event.mode === "cab" ? { ...event, vehicleId: vin } : event);
      const timeline = spliceTimeline(recorded.day.scheduled.timeline, window,
        [...driven, ...idle(target, back.arrive, end, `scenario/taxi-wait/${person}/${start}`)]);
      this.changed.set(person, { ...recorded, day: dayFromTimeline(person, timeline) });
      this.windows.set(person, [...(this.windows.get(person) ?? []), window]);
      return window;
    }
    throw new Error(`taxi consequence for person ${person} cannot rejoin the original day before midnight`);
  }

  async request(action: Goto, from: transport.Place, at: number): Promise<TravelEvent[]> {
    const day = shared.dayNumber(this.date);
    // Same reservations as `Fleet.build`: cabs carried over midnight hold their VINs.
    const duty = transport.onDuty(this.context.world, this.date, day, this.context.stands ?? [], 1, this.context.state?.fleetForDay() ?? []);
    const snapshots: transport.Cab[] = [];
    for (const cab of duty.cabs) {
      if (!this.baseline.people.has(cab.person) || cab.person === action.person || at < cab.shiftStart || at > cab.shiftEnd) continue;
      if ((this.windows.get(cab.person) ?? []).some((window) => window.start <= at && at < window.end)) continue;
      const current = await this.current(cab.person);
      // A cab carrying a passenger at `at` is free only once it sets them
      // down: the dispatcher offers it from the drop point at that minute, as
      // the engine's own fleet does after every job (`at`, `freeFrom`). The
      // offer never cuts a ride in progress. Earlier jobs are not needed:
      // dispatch reads only where and when the cab is next free.
      const fare = current.day.legs.find((leg) => leg.mode === "cab" && leg.purpose === "fare" && leg.depart <= at && at < leg.arrive);
      if (fare) {
        snapshots.push({ ...cab, at: fare.to, freeFrom: Math.ceil(fare.arrive), jobs: [], resting: null });
        continue;
      }
      const point = positionAt(current.day.scheduled.timeline, at, current.home, current.paths);
      snapshots.push({ ...cab, at: point, freeFrom: at, jobs: [], resting: null });
    }
    const { fleet, outcome } = transport.Fleet.priority(this.context.roads, snapshots,
      { id: `scenario/${action.id}`, person: action.person, from, to: action.place, at }, day);
    if (outcome.kind !== "ride" || outcome.via.length) throw new Error(`${action.id}: no taxi can serve the requested pickup within the engine's wait limit`);
    const cab = fleet.cabs.find((candidate) => candidate.person === outcome.driver)!;
    const job = cab.jobs.at(-1)!;
    const driverBefore = await this.current(cab.person);
    // The driver's replacement starts when the cab sets off: `at` for an idle
    // cab, the drop minute of the fare in progress for a busy one.
    const setOff = Math.max(at, Math.ceil(job.setOff));
    const pickup = Math.max(setOff + 1, Math.round(job.pickup));
    const drop = Math.max(pickup + 1, Math.round(job.drop));
    const origin: transport.Place = { ...job.origin, id: null, kind: "kerb", label: "cab location" };
    const approach: TravelEvent = { kind: "travel", journeyId: `scenario/${action.id}/approach`,
      from: origin, to: from, start: setOff, end: pickup, mode: "cab", purpose: "deadhead", kilometres: job.approachKm, estimated: false };
    const ride: TravelEvent = { kind: "travel", journeyId: `scenario/${action.id}`, from, to: action.place,
      start: pickup, end: drop, mode: "cab", purpose: "fare", kilometres: job.rideKm, estimated: false };
    const window = await this.install(cab.person, setOff, [approach, ride], "cab", `taxi driver for ${action.id}`, cab.vin);
    // ALPR resolves the registered cab from this same selected driver/VIN.
    const state = this.context.fleet?.state() ?? fleet.state();
    const existing = state.cabs.findIndex((candidate) => candidate.person === cab.person);
    if (existing >= 0) state.cabs[existing] = cab; else state.cabs.push(cab);
    this.context.fleet = transport.Fleet.adopt(state);

    const [people, legs] = await Promise.all([this.baseline.file.table("person"), this.baseline.file.table("leg")]);
    const removed = driverBefore.day.legs.filter((leg) => leg.mode === "cab" && leg.purpose === "fare"
      && leg.depart < window.end && leg.arrive > window.start);
    for (const fare of removed) {
      for (let row = 0; row < people.id!.length; row++) {
        const passenger = people.id![row]!;
        if (passenger === action.person) continue;
        for (let i = people.legOffset![row]!; i < people.legOffset![row]! + people.legCount![row]!; i++) {
          if (this.baseline.file.header.enums.mode![legs.mode![i]!] !== "taxi") continue;
          const id = this.baseline.file.string(legs.journey![i]!);
          const sameJourney = id === fare.journeyId || (id != null && rideOf(id) === fare.journeyId);
          const sameRoute = Math.abs(legs.toLatE6![i]! / 1e6 - fare.to.lat) < 0.0001
            && Math.abs(legs.toLonE6![i]! / 1e6 - fare.to.lon) < 0.0001
            && Math.abs(legs.arrive![i]! - fare.arrive) < 3;
          if (!sameJourney && !sameRoute) continue;
          if (this.cancellations.some((c) => c.passenger === passenger && c.journey === id)) continue;
          const recorded = await this.current(passenger);
          const start = Math.max(window.start, legs.depart![i]!);
          const origin = positionAt(recorded.day.scheduled.timeline, start, recorded.home, recorded.paths);
          const destination: transport.Place = { lat: legs.toLatE6![i]! / 1e6, lon: legs.toLonE6![i]! / 1e6,
            id: null, kind: "kerb", label: this.baseline.file.string(legs.toLabel![i]!) ?? "destination" };
          const mobility = new RoutedMobility({ roads: this.context.roads, kerb: this.context.kerb, seed: this.context.world.seed }, this.context.world.persons);
          const alternative = mobility.transition({ person: passenger, day, from: origin, to: destination, depart: start,
            purpose: "stop", override: { mode: "transit", journeyId: `scenario/displaced/${action.id}/${passenger}` } });
          if (!alternative?.events.length) throw new Error(`cannot reroute displaced taxi passenger ${passenger}`);
          await this.install(passenger, start, alternative.events, "transit", `displaced fare for ${action.id}`);
          this.cancellations.push({ driver: cab.person, passenger, journey: id ?? "unknown" });
        }
      }
    }
    return [{ ...ride, mode: "taxi", purpose: "stop", start: at, wait: pickup - at }];
  }
}

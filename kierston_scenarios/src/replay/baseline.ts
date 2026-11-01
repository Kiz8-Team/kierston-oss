import { dayFromTimeline, products, world, transport, type Day, type DayContext,
  type SchedulerPayload, type TimelineEvent, type TravelEvent } from "../../../kierston/sim/src/index.ts";
import { VehicleCatalog } from "./vehicles.ts";

/** Legs that belong to somebody else's plan as well, so replay cannot replace them alone. */
export const SHARED_MODES: readonly string[] = ["carpool", "passenger", "bus", "patrol"];
export const SHARED_PURPOSES: readonly string[] = ["escort", "run"];

export interface RecordedDay {
  day: Day;
  paths: Map<string, world.Point[]>;
  home: transport.Place;
}

export interface Position { person: number; lat: number; lon: number }
export interface PatrolUnit {
  person: number; vin: string; lat: number; lon: number;
  rollOut: number; backAt: number; lastDepart: number; station: transport.Place;
  /** When the officer's recorded day next leaves the station after the watch, or midnight. */
  leavesAt: number;
}

export class Baseline {
  readonly people: Map<number, number>;
  private readonly days = new Map<number, RecordedDay>();
  private tables?: { person: Record<string, products.NumberArray>; leg: Record<string, products.NumberArray>; path: Record<string, products.NumberArray> };
  private readonly positions = new Map<number, Position[]>();
  private constructor(
    readonly file: products.KdayFile, readonly context: DayContext, ids: ArrayLike<number>,
    readonly vehicles: VehicleCatalog,
  ) {
    this.people = new Map(Array.from(ids, (id, index) => [id, index]));
  }
  /**
   * Whether the recorded day has a leg another plan shares — a carpool, a
   * lift, a school run, a patrol tour — which a replacement window over it
   * cannot give back. Taxi legs other than fares are the driver's own.
   */
  sharesJourneys(id: number): boolean {
    if (!this.tables) throw new Error("call Baseline.preload() first");
    const row = this.people.get(id);
    if (row === undefined) return false;
    const { person: p, leg } = this.tables;
    const modes = this.file.header.enums.mode!, purposes = this.file.header.enums.purpose!;
    for (let i = p.legOffset![row]!; i < p.legOffset![row]! + p.legCount![row]!; i++) {
      if (SHARED_MODES.includes(modes[leg.mode![i]!]!) || SHARED_PURPOSES.includes(purposes[leg.purpose![i]!]!)) return true;
    }
    return false;
  }
  static async open(file: products.KdayFile, context: DayContext): Promise<Baseline> {
    const [ids, vehicles] = await Promise.all([file.column("person.id"), VehicleCatalog.open(file)]);
    return new Baseline(file, context, ids, vehicles);
  }
  /** Read the movement tables once so `positionsAt` can answer synchronously. */
  async preload(): Promise<void> {
    if (this.tables) return;
    const [person, leg, path] = await Promise.all([this.file.table("person"), this.file.table("leg"), this.file.table("path")]);
    this.tables = { person, leg, path };
  }
  /**
   * Where everybody in the recorded day was at one minute.
   *
   * The same interpolation `positionAt` does for one person, run over the
   * whole table: somebody on a leg is placed along its routed path by
   * distance, somebody between legs is where the last one ended, and
   * somebody who never moved is at home. Cached per minute, because a
   * `during` interval asks for each of its minutes in turn.
   */
  positionsAt(minute: number): readonly Position[] {
    const cached = this.positions.get(minute);
    if (cached) return cached;
    if (!this.tables) throw new Error("call Baseline.preload() before positionsAt()");
    const { person: p, leg, path } = this.tables;
    const out: Position[] = [];
    for (let row = 0; row < p.id!.length; row++) {
      const id = p.id![row]!;
      const first = p.legOffset![row]!, count = p.legCount![row]!;
      if (!count) {
        const resident = this.context.world.persons.get(id);
        const home = resident ? world.homeOf(this.context.world, resident) : null;
        if (home) out.push({ person: id, lat: home.lat, lon: home.lon });
        continue;
      }
      let lat = leg.fromLatE6![first]! / 1e6, lon = leg.fromLonE6![first]! / 1e6;
      for (let i = first; i < first + count; i++) {
        const depart = leg.depart![i]!, arrive = leg.arrive![i]!;
        if (arrive <= minute) { lat = leg.toLatE6![i]! / 1e6; lon = leg.toLonE6![i]! / 1e6; continue; }
        if (depart > minute) break;
        const wait = leg.wait![i]!;
        const fraction = Math.max(0, Math.min(1, (minute - depart - wait) / Math.max(1, arrive - depart - wait)));
        const from = leg.pathOffset![i]!, n = leg.pathCount![i]!;
        if (n < 2) {
          lat = lat + (leg.toLatE6![i]! / 1e6 - lat) * fraction; lon = lon + (leg.toLonE6![i]! / 1e6 - lon) * fraction;
          break;
        }
        let total = 0;
        for (let j = from + 1; j < from + n; j++) {
          total += transport.haversineKm({ lat: path.latE6![j - 1]! / 1e6, lon: path.lonE6![j - 1]! / 1e6 },
            { lat: path.latE6![j]! / 1e6, lon: path.lonE6![j]! / 1e6 });
        }
        let remaining = total * fraction;
        lat = path.latE6![from + n - 1]! / 1e6; lon = path.lonE6![from + n - 1]! / 1e6;
        for (let j = from + 1; j < from + n; j++) {
          const a = { lat: path.latE6![j - 1]! / 1e6, lon: path.lonE6![j - 1]! / 1e6 };
          const b = { lat: path.latE6![j]! / 1e6, lon: path.lonE6![j]! / 1e6 };
          const length = transport.haversineKm(a, b);
          if (remaining <= length) {
            const t = length > 0 ? remaining / length : 0;
            lat = a.lat + (b.lat - a.lat) * t; lon = a.lon + (b.lon - a.lon) * t;
            break;
          }
          remaining -= length;
        }
        break;
      }
      out.push({ person: id, lat, lon });
    }
    this.positions.set(minute, out);
    return out;
  }
  /** Peak recorded stationary attendance, found from journey boundaries rather
   * than a hard-coded school/work hour. Travel through the radius is excluded.
   */
  busiestMinute(near: transport.Place, withinKm: number, minAge = 0, maxAge = 120): number {
    if (!this.tables) throw new Error("call Baseline.preload() first");
    const { person: p, leg } = this.tables;
    const changes = new Map<number, number>();
    const add = (from: number, until: number, lat: number, lon: number) => {
      from = Math.max(0, Math.ceil(from)); until = Math.min(1440, Math.floor(until));
      if (until <= from || transport.haversineKm(near, { lat, lon }) > withinKm) return;
      changes.set(from, (changes.get(from) ?? 0) + 1);
      changes.set(until, (changes.get(until) ?? 0) - 1);
    };
    for (let row = 0; row < p.id!.length; row++) {
      const resident = this.context.world.persons.get(p.id![row]!);
      if (!resident || resident.age < minAge || resident.age > maxAge) continue;
      const first = p.legOffset![row]!, count = p.legCount![row]!;
      if (!count) {
        const home = world.homeOf(this.context.world, resident);
        if (home) add(0, 1440, home.lat, home.lon);
        continue;
      }
      add(0, leg.depart![first]!, leg.fromLatE6![first]! / 1e6, leg.fromLonE6![first]! / 1e6);
      for (let i = first; i < first + count; i++) add(leg.arrive![i]!, i + 1 < first + count ? leg.depart![i + 1]! : 1440,
        leg.toLatE6![i]! / 1e6, leg.toLonE6![i]! / 1e6);
    }
    const entries = [...changes].sort((a, b) => a[0] - b[0]);
    let count = 0, best = 0, minute = 0;
    for (let i = 0; i + 1 < entries.length; i++) {
      count += entries[i]![1];
      if (count > best) { best = count; minute = Math.floor((entries[i]![0] + entries[i + 1]![0]) / 2); }
    }
    if (!best) throw new Error("no recorded attendance at the selected site during this day");
    return minute;
  }
  /**
   * The patrol cars out on the road at one minute: who is at the wheel, which
   * VIN, where they are, and when the watch has them back in the yard.
   *
   * Only officers between roll-out and their last return leg count; a unit
   * still in the station or already back is not somewhere a call can send.
   */
  nextPatrolStart(after: number): number | null {
    if (!this.tables) throw new Error("call Baseline.preload() first");
    const { person: p, leg } = this.tables;
    const patrol = this.file.header.enums.mode!.indexOf("patrol");
    let next = 1440;
    for (let row = 0; row < p.id!.length; row++) {
      let previousEnd = -Infinity;
      const first = p.legOffset![row]!, count = p.legCount![row]!;
      for (let i = first; i < first + count; i++) {
        if (leg.mode![i] !== patrol) continue;
        const start = leg.depart![i]!;
        if (start - previousEnd >= 60 && start > after) next = Math.min(next, start);
        previousEnd = leg.arrive![i]!;
      }
    }
    return next < 1440 ? next : null;
  }
  patrolUnits(minute: number): PatrolUnit[] {
    if (!this.tables) throw new Error("call Baseline.preload() before patrolUnits()");
    const { person: p, leg } = this.tables;
    const modes = this.file.header.enums.mode!;
    const patrol = modes.indexOf("patrol");
    if (patrol < 0) return [];
    const positions = new Map(this.positionsAt(minute).map((row) => [row.person, row]));
    const out: PatrolUnit[] = [];
    for (let row = 0; row < p.id!.length; row++) {
      const first = p.legOffset![row]!, count = p.legCount![row]!;
      // An officer can work two watches in one day-frame, and the beat stops
      // between patrol legs are minutes long, so a gap of an hour or more
      // separates watches. Only the watch containing the minute counts.
      let watch: number[] = [];
      for (let i = first; i < first + count; i++) {
        if (leg.mode![i] !== patrol) continue;
        if (watch.length && leg.depart![i]! - leg.arrive![watch.at(-1)!]! >= 60) {
          if (minute < leg.depart![watch.at(-1)!]!) break;
          watch = [];
        }
        watch.push(i);
      }
      if (!watch.length) continue;
      const rollOut = leg.depart![watch[0]!]!, last = watch.at(-1)!;
      const back = leg.arrive![last]!, vin = this.file.string(leg.vehicle![last]!);
      const station: transport.Place = { lat: leg.toLatE6![last]! / 1e6, lon: leg.toLonE6![last]! / 1e6, id: null, kind: "kerb",
        label: this.file.string(leg.toLabel![last]!) ?? "station" };
      if (!vin) continue;
      // The last patrol leg is the run back to the yard; its departure is the
      // last minute the unit is still on the beat.
      const lastDepart = leg.depart![last]!;
      let leavesAt = 1440;
      for (let i = first; i < first + count; i++) if (leg.mode![i] !== patrol && leg.depart![i]! >= back) { leavesAt = leg.depart![i]!; break; }
      if (minute < rollOut || minute >= lastDepart) continue;
      const at = positions.get(p.id![row]!);
      if (!at) continue;
      out.push({ person: p.id![row]!, vin, lat: at.lat, lon: at.lon, rollOut, backAt: back, lastDepart, station, leavesAt });
    }
    return out;
  }
  async person(id: number): Promise<RecordedDay> {
    const cached = this.days.get(id);
    if (cached) return cached;
    const row = this.people.get(id);
    const person = this.context.world.persons.get(id);
    if (row === undefined || !person) throw new Error(`person ${id} is not in the input day/city`);
    const homePoint = world.homeOf(this.context.world, person);
    if (!homePoint) throw new Error(`person ${id} has no local home`);
    const home: transport.Place = { ...homePoint, id: null, kind: "home", label: transport.HOME_LABEL };
    const [p, schedule, legs, path] = await Promise.all([
      this.file.table("person"), this.file.table("schedule"), this.file.table("leg"), this.file.table("path"),
    ]);
    const timeline: TimelineEvent<SchedulerPayload>[] = [];
    const paths = new Map<string, world.Point[]>();
    const text = (value: number) => this.file.string(value);
    const endpoint = (prefix: "from" | "to", i: number): transport.Place => ({
      lat: legs[`${prefix}LatE6`]![i]! / 1e6, lon: legs[`${prefix}LonE6`]![i]! / 1e6,
      id: null, kind: "kerb", label: text(legs[`${prefix}Label`]![i]!) ?? "recorded location",
    });
    for (let i = p.legOffset![row]!; i < p.legOffset![row]! + p.legCount![row]!; i++) {
      const key = text(legs.journey![i]!) ?? `baseline/leg/${i}`;
      const points: world.Point[] = [];
      for (let j = legs.pathOffset![i]!; j < legs.pathOffset![i]! + legs.pathCount![i]!; j++) {
        points.push({ lat: path.latE6![j]! / 1e6, lon: path.lonE6![j]! / 1e6 });
      }
      paths.set(products.pathKey({ journeyId: key, depart: legs.depart![i]!, arrive: legs.arrive![i]! }), points);
      const vehicleId = legs.vehicle ? text(legs.vehicle[i]!) ?? undefined : undefined;
      timeline.push({ kind: "travel", journeyId: key, journeyRoot: key.replace(/\/\d+$/, ""),
        ...(vehicleId ? { vehicleId } : {}), from: endpoint("from", i), to: endpoint("to", i),
        start: legs.depart![i]!, end: legs.arrive![i]!, kilometres: legs.kilometres![i]!,
        mode: this.file.header.enums.mode![legs.mode![i]!] as TravelEvent["mode"],
        purpose: this.file.header.enums.purpose![legs.purpose![i]!] as TravelEvent["purpose"],
        estimated: Boolean(legs.estimated![i]), wait: legs.wait![i]!,
      });
    }
    timeline.sort((a, b) => a.start - b.start);
    for (let i = p.scheduleOffset![row]!; i < p.scheduleOffset![row]! + p.scheduleCount![row]!; i++) {
      const kind = this.file.header.enums.scheduleKind![schedule.kind![i]!] as (typeof products.KINDS)[number];
      const where = text(schedule.where![i]!);
      const label = text(schedule.label![i]!) ?? kind;
      const point = where ? this.context.world.places.get(where) : null;
      const place = point ? { ...point, id: where, kind: "venue" as const, label }
        : positionAt(timeline, schedule.start![i]!, home, paths);
      timeline.push({ kind: "stay", activityId: `baseline/schedule/${i}`, source: kind,
        start: schedule.start![i]!, end: schedule.end![i]!, place, policy: "required",
        payload: { kind: "recorded", recordKind: kind, label, where },
      });
    }
    timeline.sort((a, b) => a.start - b.start || a.end - b.end);
    const recorded = { day: dayFromTimeline(id, timeline), paths, home };
    this.days.set(id, recorded); return recorded;
  }
}

/** Distance interpolation over the recorded route, never an endpoint shortcut. */
export function positionAt(
  timeline: readonly TimelineEvent<SchedulerPayload>[], at: number, home: transport.Place,
  paths: ReadonlyMap<string, world.Point[]>,
): transport.Place {
  const trips = timeline.filter((event): event is TravelEvent => event.kind === "travel");
  let place = trips[0]?.from ?? home;
  for (const event of trips) {
    if (event.end <= at) place = event.to;
    else if (event.start <= at && event.end > at) {
      const line = paths.get(products.pathKey({ journeyId: event.journeyId, depart: event.start, arrive: event.end }))
        ?? paths.get(event.journeyId) ?? [event.from, event.to];
      const lengths = line.map((point, i) => i ? transport.haversineKm(line[i - 1]!, point) : 0);
      let remaining = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1,
        (at - event.start - (event.wait ?? 0)) / Math.max(1, event.end - event.start - (event.wait ?? 0))));
      for (let i = 1; i < line.length; i++) {
        if (remaining <= lengths[i]!) {
          const fraction = lengths[i]! > 0 ? remaining / lengths[i]! : 0;
          return { id: null, kind: "kerb", label: "en route",
            lat: line[i - 1]!.lat + (line[i]!.lat - line[i - 1]!.lat) * fraction,
            lon: line[i - 1]!.lon + (line[i]!.lon - line[i - 1]!.lon) * fraction };
        }
        remaining -= lengths[i]!;
      }
      return event.to;
    } else if (event.start > at) break;
  }
  return place;
}

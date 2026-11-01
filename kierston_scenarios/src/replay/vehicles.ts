import { products, transport, type DayContext, type StateCheckpoint } from "../../../kierston/sim/src/index.ts";

export interface VehicleRecord {
  vin: string;
  owner: number;
  ownerType: string;
  household: number | null;
  serviceClass: string;
}

export interface ParkedVehicle extends VehicleRecord {
  location: { lat: number; lon: number };
  distanceMetres: number;
  parkedSince: number;
}

interface Span {
  start: number;
  end: number;
  parked: boolean;
  lat: number;
  lon: number;
  leg: number;
}

export interface VehicleMovement {
  vin: string;
  person: number | null;
  start: number;
  end: number;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
}

/** Read-only VIN state from the immutable input KDAY. */
export class VehicleCatalog {
  private readonly byVin: ReadonlyMap<string, VehicleRecord>;
  private constructor(
    readonly records: readonly VehicleRecord[],
    private readonly spans: ReadonlyMap<string, readonly Span[]>,
    private readonly movementRows: ReadonlyMap<string, readonly VehicleMovement[]>,
  ) { this.byVin = new Map(records.map((row) => [row.vin, row])); }

  static async open(file: products.KdayFile): Promise<VehicleCatalog> {
    if (!file.has("vehicle.vin") || !file.has("vehicleSpan.kind")) {
      throw new Error("vehicle selection requires a vehicle-tracked KDAY v12");
    }
    const [vehicles, spans, people, legs] = await Promise.all([
      file.table("vehicle"), file.table("vehicleSpan"), file.table("person"), file.table("leg"),
    ]);
    const ownerTypes = file.header.enums.vehicleOwnerType ?? ["person", "organization"];
    const serviceClasses = file.header.enums.vehicleServiceClass ?? ["none"];
    const kinds = file.header.enums.vehicleSpanKind ?? ["parked", "moving"];
    const parked = kinds.indexOf("parked");
    const records: VehicleRecord[] = [];
    const byVin = new Map<string, Span[]>();
    const movements = new Map<string, VehicleMovement[]>();
    const legOwner = new Int32Array(legs.depart!.length).fill(-1);
    for (let person = 0; person < people.id!.length; person += 1) {
      const offset = people.legOffset![person]!;
      const count = people.legCount![person]!;
      legOwner.fill(people.id![person]!, offset, offset + count);
    }
    for (let row = 0; row < vehicles.vin!.length; row += 1) {
      const vin = file.string(vehicles.vin![row]!)!;
      records.push({
        vin,
        owner: vehicles.owner![row]!,
        ownerType: ownerTypes[vehicles.ownerType![row]!] ?? "person",
        household: vehicles.household![row]! < 0 ? null : vehicles.household![row]!,
        serviceClass: serviceClasses[vehicles.serviceClass![row]!] ?? "none",
      });
      const mine: Span[] = [];
      const offset = vehicles.spanOffset![row]!;
      const count = vehicles.spanCount![row]!;
      for (let span = offset; span < offset + count; span += 1) {
        const leg = spans.leg![span]!;
        mine.push({
          start: spans.startSecond![span]!, end: spans.endSecond![span]!,
          parked: spans.kind![span] === parked,
          lat: spans.latE6![span]! / 1e6, lon: spans.lonE6![span]! / 1e6,
          leg,
        });
        if (spans.kind![span] !== parked && leg >= 0) {
          const rows = movements.get(vin) ?? [];
          rows.push({ vin, person: legOwner[leg]! < 0 ? null : legOwner[leg]!,
            start: spans.startSecond![span]! / 60, end: spans.endSecond![span]! / 60,
            from: { lat: legs.fromLatE6![leg]! / 1e6, lon: legs.fromLonE6![leg]! / 1e6 },
            to: { lat: legs.toLatE6![leg]! / 1e6, lon: legs.toLonE6![leg]! / 1e6 } });
          movements.set(vin, rows);
        }
      }
      byVin.set(vin, mine);
    }
    records.sort((a, b) => a.vin.localeCompare(b.vin));
    return new VehicleCatalog(records, byVin, movements);
  }

  record(vin: string): VehicleRecord | null {
    return this.byVin.get(vin) ?? null;
  }

  parkedAt(vin: string, minute: number): ParkedVehicle | null {
    const record = this.record(vin);
    const second = Math.max(0, Math.min(86_399, Math.floor(minute * 60)));
    const span = this.spans.get(vin)?.find((row) => row.start <= second && second < row.end);
    if (!record || !span?.parked) return null;
    return { ...record, location: { lat: span.lat, lon: span.lon }, distanceMetres: 0, parkedSince: span.start / 60 };
  }

  openingLocation(vin: string): { lat: number; lon: number } | null {
    const span = this.spans.get(vin)?.[0];
    return span ? { lat: span.lat, lon: span.lon } : null;
  }

  /** Every VIN with recorded movements today. */
  vins(): string[] { return [...this.movementRows.keys()]; }
  movements(vin: string): readonly VehicleMovement[] {
    return this.movementRows.get(vin) ?? [];
  }

  parkedNear(
    point: { lat: number; lon: number }, minute: number, withinMetres: number,
    filter: (record: VehicleRecord) => boolean = () => true,
  ): ParkedVehicle[] {
    if (!(withinMetres > 0) || !Number.isFinite(withinMetres)) throw new Error("vehicle radius must be positive");
    const out: ParkedVehicle[] = [];
    for (const record of this.records) {
      if (!filter(record)) continue;
      const state = this.parkedAt(record.vin, minute);
      if (!state) continue;
      const distanceMetres = transport.haversineKm(point, state.location) * 1000;
      if (distanceMetres <= withinMetres) out.push({ ...state, distanceMetres });
    }
    return out.sort((a, b) => a.distanceMetres - b.distanceMetres || a.vin.localeCompare(b.vin));
  }
}

/** Re-derive the exhaustive vehicle table after scenario person legs change. */
export async function rebuildVehicleProduct(
  context: DayContext, file: products.KdayFile,
): Promise<StateCheckpoint["vehicles"]> {
  const legs = await file.table("leg");
  const day = products.buildVehicleDay(context, file.strings.values, {
    vehicle: legs.vehicle!, depart: legs.depart!, arrive: legs.arrive!,
    fromLat: legs.fromLatE6!, fromLon: legs.fromLonE6!,
    toLat: legs.toLatE6!, toLon: legs.toLonE6!,
  });
  const set = (name: string, values: ArrayLike<number>) => file.set(name, values);
  set("vehicle.vin", day.vin.map((vin) => file.strings.id(vin)));
  set("vehicle.owner", day.owner);
  set("vehicle.ownerType", day.ownerType);
  set("vehicle.household", day.household);
  set("vehicle.serviceClass", day.serviceClass);
  set("vehicle.spanOffset", day.spanOffset);
  set("vehicle.spanCount", day.spanCount);
  set("vehicleSpan.vehicle", day.spanVehicle);
  set("vehicleSpan.startSecond", day.spanStart);
  set("vehicleSpan.endSecond", day.spanEnd);
  set("vehicleSpan.kind", day.spanKind);
  set("vehicleSpan.leg", day.spanLeg);
  set("vehicleSpan.latE6", day.spanLat);
  set("vehicleSpan.lonE6", day.spanLon);
  file.header.counts.vehicles = day.vin.length;
  file.header.counts.vehicleSpans = day.spanStart.length;
  return products.vehicleBoundaryStates(day, "closing");
}

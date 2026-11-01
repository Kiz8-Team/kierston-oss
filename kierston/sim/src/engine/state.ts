/**
 * The complete mutable state at a calendar-day boundary.
 *
 * A date is a transition from one of these snapshots to the next. Static city
 * facts remain in `World`; anything whose value depends on what actually
 * happened before midnight belongs here. The opening snapshot is immutable
 * while a date is planned and the closing snapshot is staged separately, so
 * population order cannot leak into anybody's day.
 */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Bank, type PositionState } from "../economy/index.ts";
import type { RadioState } from "../network/index.ts";
import type {
  Day, SchedulerPayload, StayEvent, TimelineEvent, TravelEvent,
} from "../scheduler/index.ts";
import type { Cab, Place } from "../transport/index.ts";
import {
  emptyCommunicationsBoundary, type CommunicationsBoundaryState,
} from "../comms/index.ts";
import { isoDate, parseDate } from "../shared/index.ts";

export const STATE_MAGIC = "KSTATE";
export const STATE_VERSION = 4;
export const STATE_ENCODING = "gzip-json";

/** Location and identity of a checkpoint embedded in a KDAY payload. */
export interface EmbeddedStateDescriptor {
  magic: typeof STATE_MAGIC;
  version: typeof STATE_VERSION;
  encoding: typeof STATE_ENCODING;
  boundary: "opening" | "closing";
  nextDate: string;
  digest: string;
  byteOffset: number;
  byteLength: number;
  rawByteLength: number;
}

export interface EncodedCheckpoint {
  bytes: Uint8Array;
  digest: string;
  rawByteLength: number;
}

export interface VehicleBoundaryState {
  /** A VIN where the engine has one, otherwise the journey is the best identity available. */
  id: string | null;
  location: Place | null;
  occupants: number[];
  parked: boolean;
  /** Explicitly unknown until the corresponding stock/consumption model exists. */
  fuelLitres: number | null;
  chargeKwh: number | null;
}

export interface PersonBoundaryState {
  person: number;
  /** The person's physical position at exactly 00:00. */
  location: Place | null;
  /** What spans 00:00, when that is a stay. */
  activity: StayEvent<SchedulerPayload> | null;
  /** What spans 00:00, when that is movement. */
  journey: TravelEvent | null;
  /** Yesterday's still-authoritative events, in the new date's minute frame. */
  continuation: TimelineEvent<SchedulerPayload>[];
  /** Where and when new planning may resume after the continuation. */
  resumeAt: number;
  resumePlace: Place | null;
  vehicle: VehicleBoundaryState | null;
  /** Reserved now; zero until a calibrated debt model starts updating it. */
  sleepDebtMinutes: number;
}

export interface StateCheckpoint {
  magic: typeof STATE_MAGIC;
  version: typeof STATE_VERSION;
  coldStart: string;
  nextDate: string;
  completedDays: number;
  initialized: boolean;
  bank: PositionState[];
  persons: PersonBoundaryState[];
  /** One authoritative row per registered VIN, independent of any person. */
  vehicles: VehicleBoundaryState[];
  fleet: Cab[];
  radio: RadioState[];
  communications: CommunicationsBoundaryState;
  /** 911 calls after midnight of this date, in the next date's minute frame; the incident row stays in this KDAY. */
  emergencyCalls: EmergencyCallBoundary[];
}

export interface EmergencyCallBoundary {
  date: string;
  incident: number;
  person: number;
  minute: number;
}

/** Hash every future-observable value, in the stable array order of the checkpoint. */
export function checkpointDigest(checkpoint: StateCheckpoint): string {
  return createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
}

/** Compact the exact checkpoint JSON while retaining its independently versioned schema. */
export function encodeCheckpoint(checkpoint: StateCheckpoint): EncodedCheckpoint {
  const raw = new TextEncoder().encode(JSON.stringify(checkpoint));
  const compressed = gzipSync(raw, { level: 9 });
  return {
    bytes: new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength),
    // The digest is defined over these exact UTF-8 JSON bytes. Reusing them
    // avoids stringifying a city-sized checkpoint twice at every boundary.
    digest: createHash("sha256").update(raw).digest("hex"),
    rawByteLength: raw.byteLength,
  };
}

/** Decode and authenticate one KDAY closing-state section. */
export function decodeCheckpoint(
  bytes: Uint8Array,
  descriptor: EmbeddedStateDescriptor,
): StateCheckpoint {
  if (descriptor.magic !== STATE_MAGIC || descriptor.version !== STATE_VERSION
      || descriptor.encoding !== STATE_ENCODING
      || !["opening", "closing"].includes(descriptor.boundary)) {
    throw new Error(
      `unsupported embedded simulation state ${descriptor.magic} v${descriptor.version} (${descriptor.encoding})`,
    );
  }
  const raw = gunzipSync(bytes);
  if (raw.byteLength !== descriptor.rawByteLength) {
    throw new Error(`embedded simulation state expands to ${raw.byteLength} bytes, expected ${descriptor.rawByteLength}`);
  }
  const checkpoint = JSON.parse(raw.toString("utf8")) as StateCheckpoint;
  const digest = checkpointDigest(checkpoint);
  if (digest !== descriptor.digest) throw new Error(`embedded simulation state digest ${digest} does not match KDAY header`);
  if (checkpoint.nextDate !== descriptor.nextDate) {
    throw new Error(`embedded simulation state expects ${checkpoint.nextDate}, KDAY header says ${descriptor.nextDate}`);
  }
  return checkpoint;
}

/** Read only the closing checkpoint from a KDAY without materializing its day columns. */
export async function checkpointFromKday(
  path: string, boundary: "opening" | "closing" = "closing",
): Promise<StateCheckpoint> {
  const file = Bun.file(path);
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, 4)) !== "KDAY") throw new Error(`${path} is not a KDAY file`);
  const headerLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(4, true);
  const header = JSON.parse(await file.slice(8, 8 + headerLength).text()) as {
    date?: string;
    openingState?: EmbeddedStateDescriptor;
    closingState?: EmbeddedStateDescriptor;
  };
  const descriptor = boundary === "opening" ? header.openingState : header.closingState;
  if (!descriptor) throw new Error(`${path} has no embedded ${boundary} state`);
  if (descriptor.boundary !== boundary) throw new Error(`${path} has an invalid ${boundary} boundary`);
  if (boundary === "opening" && header.date && descriptor.nextDate !== header.date) {
    throw new Error(`${path} opening state does not match its date`);
  }
  const dataStart = (8 + headerLength + 7) & ~7;
  const { byteOffset, byteLength } = descriptor;
  if (!Number.isInteger(byteOffset) || !Number.isInteger(byteLength) || byteOffset < 0 || byteLength < 1
      || dataStart + byteOffset + byteLength > file.size) {
    throw new Error(`${path} has an invalid embedded closing-state range`);
  }
  const bytes = new Uint8Array(
    await file.slice(dataStart + byteOffset, dataStart + byteOffset + byteLength).arrayBuffer(),
  );
  return decodeCheckpoint(bytes, descriptor);
}

function followingDate(date: Date): Date {
  const out = new Date(date);
  out.setDate(date.getDate() + 1);
  return out;
}

function shifted<T>(event: TimelineEvent<T>, minutes: number): TimelineEvent<T> {
  return event.kind === "travel"
    ? { ...event, from: { ...event.from }, to: { ...event.to }, start: event.start + minutes, end: event.end + minutes }
    : { ...event, place: { ...event.place }, start: event.start + minutes, end: event.end + minutes };
}

function pointOn(event: TravelEvent, minute: number): Place {
  const span = Math.max(1, event.end - event.start);
  const fraction = Math.max(0, Math.min(1, (minute - event.start) / span));
  return {
    lat: event.from.lat + (event.to.lat - event.from.lat) * fraction,
    lon: event.from.lon + (event.to.lon - event.from.lon) * fraction,
    id: null,
    kind: "kerb",
    label: `${event.from.label} → ${event.to.label}`,
  };
}

function endPlace(event: TimelineEvent<unknown>): Place {
  return event.kind === "travel" ? { ...event.to } : { ...event.place };
}

/**
 * One run's accumulated state.
 *
 * `current*` is the immutable opening of the date being planned. `next*` is
 * filled while that date is packed and atomically becomes current in
 * `advance`. That split is what lets every person read the same midnight.
 */
export class SimulationState {
  readonly version = STATE_VERSION;

  private currentPersons = new Map<number, PersonBoundaryState>();
  private currentRadio = new Map<number, RadioState>();
  private currentFleet: Cab[] = [];
  private currentVehicles = new Map<string, VehicleBoundaryState>();
  private currentCommunications = emptyCommunicationsBoundary();
  private currentEmergencyCalls: EmergencyCallBoundary[] = [];
  private nextEmergencyCalls: EmergencyCallBoundary[] = [];
  private nextPersons = new Map<number, PersonBoundaryState>();
  private nextRadio = new Map<number, RadioState>();
  private nextFleet: Cab[] = [];
  private nextVehicles = new Map<string, VehicleBoundaryState>();
  private nextCommunications = emptyCommunicationsBoundary();
  private boundaryInitialized = false;

  private constructor(
    readonly coldStart: string,
    private expected: string,
    private completed: number,
    readonly bank: Bank,
  ) {}

  /** Begin a new branch. `initColdStartDay` can supply its physical opening. */
  static cold(date: Date, bank = Bank.load()): SimulationState {
    const at = isoDate(date);
    return new SimulationState(at, at, 0, bank);
  }

  /** Restore an exact continuation from a checkpoint. */
  static restore(checkpoint: StateCheckpoint, bank = Bank.load()): SimulationState {
    if (checkpoint.magic !== STATE_MAGIC || checkpoint.version !== STATE_VERSION) {
      throw new Error(`unsupported simulation state ${checkpoint.magic} v${checkpoint.version}`);
    }
    parseDate(checkpoint.coldStart);
    parseDate(checkpoint.nextDate);
    bank.restore(checkpoint.bank);
    const state = new SimulationState(
      checkpoint.coldStart, checkpoint.nextDate, checkpoint.completedDays, bank,
    );
    state.currentPersons = new Map(checkpoint.persons.map((row) => [row.person, row]));
    state.currentRadio = new Map(checkpoint.radio.map((row) => [row.subscriber, row]));
    state.currentFleet = checkpoint.fleet;
    state.currentVehicles = new Map(checkpoint.vehicles.map((row) => [row.id!, row]));
    state.currentCommunications = checkpoint.communications ?? emptyCommunicationsBoundary();
    state.currentEmergencyCalls = checkpoint.emergencyCalls ?? [];
    state.boundaryInitialized = checkpoint.initialized;
    return state;
  }

  static async open(path: string, bank = Bank.load()): Promise<SimulationState> {
    const magic = new TextDecoder().decode(new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer()));
    const checkpoint = magic === "KDAY"
      ? await checkpointFromKday(path)
      : await Bun.file(path).json() as StateCheckpoint;
    return SimulationState.restore(checkpoint, bank);
  }

  get nextDate(): string { return this.expected; }
  get completedDays(): number { return this.completed; }
  get initialized(): boolean { return this.boundaryInitialized; }

  /** Assert that this state is the opening state for `date`. */
  enter(date: Date): void {
    const actual = isoDate(date);
    if (actual !== this.expected) throw new Error(`simulation state expects ${this.expected}, not ${actual}`);
  }

  /** Start staging one transition without changing the opening snapshot. */
  beginTransition(): void {
    this.nextPersons = new Map();
    this.nextRadio = new Map();
    this.nextFleet = [];
    this.nextVehicles = new Map();
    this.nextCommunications = emptyCommunicationsBoundary();
    this.nextEmergencyCalls = [];
  }

  openingFor(person: number): PersonBoundaryState | null {
    return this.currentPersons.get(person) ?? null;
  }

  radioFor(subscriber: number): RadioState | null {
    return this.currentRadio.get(subscriber) ?? null;
  }

  fleetForDay(): readonly Cab[] {
    return this.currentFleet;
  }

  vehiclesForDay(): readonly VehicleBoundaryState[] {
    return [...this.currentVehicles.values()];
  }

  vehicleForDay(vin: string): VehicleBoundaryState | null {
    return this.currentVehicles.get(vin) ?? null;
  }

  communicationsForDay(): CommunicationsBoundaryState {
    return this.currentCommunications;
  }

  stageCommunications(state: CommunicationsBoundaryState): void {
    this.nextCommunications = state;
  }

  emergencyCallsForDay(): readonly EmergencyCallBoundary[] {
    return this.currentEmergencyCalls;
  }

  stageEmergencyCalls(rows: readonly EmergencyCallBoundary[]): void {
    this.nextEmergencyCalls = [...rows].sort((a, b) => a.minute - b.minute || a.incident - b.incident);
  }

  /** Install cold-start VIN positions before the opening checkpoint is encoded. */
  seedVehicles(rows: readonly VehicleBoundaryState[]): void {
    if (this.currentVehicles.size > 0) return;
    this.currentVehicles = new Map(rows.flatMap((row) => row.id ? [[row.id, row]] : []));
  }

  /** Stage the closing position of every VIN as one atomic city-level update. */
  stageVehicles(rows: readonly VehicleBoundaryState[]): void {
    this.nextVehicles = new Map(rows.flatMap((row) => row.id ? [[row.id, row]] : []));
  }

  /** Capture the part of one resolved timeline that survives the next midnight. */
  stagePerson(planned: Day, home: Place | null): void {
    const boundary = 1440;
    const timeline = planned.scheduled.timeline;
    const crossing = timeline.find((event) => event.start < boundary && event.end > boundary) ?? null;
    const continuation = timeline
      .filter((event) => event.end > boundary)
      .map((event) => shifted(event, -boundary) as TimelineEvent<SchedulerPayload>);
    const active = crossing ? shifted(crossing, -boundary) : null;
    const location = crossing
      ? crossing.kind === "travel" ? pointOn(crossing, boundary) : { ...crossing.place }
      : (() => {
          const before = timeline.filter((event) => event.end <= boundary).at(-1);
          return before ? endPlace(before) : home ? { ...home } : null;
        })();
    const last = continuation.at(-1) ?? null;
    const resumeAt = continuation.reduce((latest, event) => Math.max(latest, event.end), 0);
    const resumePlace = last ? endPlace(last) : location;
    const activeJourney = active?.kind === "travel" ? active : null;
    const vehicleMoves = activeJourney && ["car", "carpool", "cab"].includes(activeJourney.mode);
    const vehicleAtEnd = planned.scheduled.endState?.vehicleAt;
    const vehicle: VehicleBoundaryState | null = vehicleMoves || vehicleAtEnd !== undefined
      ? {
          id: activeJourney?.journeyId ?? null,
          location: vehicleMoves ? location : vehicleAtEnd ? { ...vehicleAtEnd } : null,
          occupants: vehicleMoves ? [planned.person] : [],
          parked: !vehicleMoves,
          fuelLitres: null,
          chargeKwh: null,
        }
      : null;

    this.nextPersons.set(planned.person, {
      person: planned.person,
      location,
      activity: active?.kind === "stay" ? active : null,
      journey: activeJourney,
      continuation,
      resumeAt,
      resumePlace,
      vehicle,
      sleepDebtMinutes: this.currentPersons.get(planned.person)?.sleepDebtMinutes ?? 0,
    });
  }

  stageRadio(state: RadioState): void {
    this.nextRadio.set(state.subscriber, state);
  }

  stageFleet(cabs: readonly Cab[]): void {
    this.nextFleet = cabs
      .filter((cab) => Math.max(cab.freeFrom, cab.resting?.leave ?? -Infinity, cab.shiftEnd) > 1440)
      .map((cab) => ({
        ...cab,
        base: { ...cab.base }, stand: { ...cab.stand }, at: { ...cab.at },
        shiftStart: cab.shiftStart - 1440,
        shiftEnd: cab.shiftEnd - 1440,
        freeFrom: cab.freeFrom - 1440,
        // Only fares still running at midnight or later belong to the carry.
        // Fares set down before midnight are finished and already recorded
        // in yesterday's day; carrying them puts them in today's frame at
        // negative minutes. The carried cab is not dispatched today (see
        // `Fleet.build`), so these jobs are a record of the shift's tail only.
        jobs: cab.jobs.filter((job) => job.drop > 1440).map((job) => ({
          ...job, from: { ...job.from }, to: { ...job.to }, origin: { ...job.origin },
          requestedAt: job.requestedAt - 1440, setOff: job.setOff - 1440,
          pickup: job.pickup - 1440, drop: job.drop - 1440,
          before: job.before ? {
            ...job.before, from: { ...job.before.from }, setOff: job.before.setOff - 1440,
            arrive: job.before.arrive - 1440, leave: job.before.leave - 1440,
          } : null,
        })),
        resting: cab.resting ? {
          ...cab.resting, from: { ...cab.resting.from },
          setOff: cab.resting.setOff - 1440, arrive: cab.resting.arrive - 1440,
          leave: cab.resting.leave - 1440,
        } : null,
      }));
  }

  /** Make a staged previous-day reconstruction the opening of a cold date. */
  initializeBoundary(): void {
    this.commitStaged();
    this.boundaryInitialized = true;
  }

  /** Mark one successful date complete, atomically installing its closing state. */
  advance(date: Date): void {
    this.enter(date);
    this.commitStaged();
    this.boundaryInitialized = true;
    this.expected = isoDate(followingDate(date));
    this.completed += 1;
  }

  private commitStaged(): void {
    // Shared passengers carry the same journey id. Make their occupant list a
    // property of the vehicle rather than of whichever person was packed first.
    const occupants = new Map<string, number[]>();
    for (const row of this.nextPersons.values()) {
      const id = row.vehicle?.id;
      if (!id || !row.journey) continue;
      const mine = occupants.get(id) ?? [];
      mine.push(row.person);
      occupants.set(id, mine);
    }
    for (const row of this.nextPersons.values()) {
      const id = row.vehicle?.id;
      if (id) row.vehicle!.occupants = [...(occupants.get(id) ?? row.vehicle!.occupants)].sort((a, b) => a - b);
    }
    this.currentPersons = this.nextPersons;
    this.currentRadio = this.nextRadio;
    this.currentFleet = this.nextFleet;
    if (this.nextVehicles.size > 0) this.currentVehicles = this.nextVehicles;
    this.currentCommunications = this.nextCommunications;
    this.currentEmergencyCalls = this.nextEmergencyCalls;
    this.beginTransition();
  }

  checkpoint(persons: Iterable<number>): StateCheckpoint {
    const ids = [...persons].sort((a, b) => a - b);
    return {
      magic: STATE_MAGIC,
      version: STATE_VERSION,
      coldStart: this.coldStart,
      nextDate: this.expected,
      completedDays: this.completed,
      initialized: this.boundaryInitialized,
      bank: this.bank.state(ids),
      persons: ids.flatMap((id) => {
        const row = this.currentPersons.get(id);
        return row ? [row] : [];
      }),
      vehicles: [...this.currentVehicles.values()].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
      fleet: this.currentFleet,
      radio: [...this.currentRadio.values()].sort((a, b) => a.subscriber - b.subscriber),
      communications: this.currentCommunications,
      emergencyCalls: this.currentEmergencyCalls,
    };
  }

  digest(persons: Iterable<number>): string {
    return checkpointDigest(this.checkpoint(persons));
  }
}

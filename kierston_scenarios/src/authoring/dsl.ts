import { shared, transport, world, discretionary, comms, products, type DayContext } from "../../../kierston/sim/src/index.ts";
import type { ScenarioRunOptions } from "./run.ts";
import { VehicleCatalog, type VehicleRecord } from "../replay/vehicles.ts";
import type { Baseline } from "../replay/baseline.ts";
import { inRange, type Range } from "./range.ts";
import { PersonRecords, type RecordFilters } from "./records.ts";
import { Boundary, minute, duration, distanceMetres, seedFor, type Time, type Window } from "./time.ts";
import { Group, type GroupRequirement, type GroupSelection, type PresentFilter, type PresenceRule } from "./group.ts";
import { SiteCatalog, sitePlace, type Site, type SiteFilter } from "./sites.ts";
import { replayJointActions } from "../replay/joint.ts";
import { resolveTime, type Realized } from "../replay/movement.ts";
import { DayBoundaryError } from "./schedule.ts";

export type { Range } from "./range.ts";
export type { Time, RelativeTime, MemberTime, Window, BoundaryKind } from "./time.ts";
export { minute, duration, distanceMetres, seedFor, Boundary, GroupBoundary } from "./time.ts";
export { Group } from "./group.ts";
export { SiteCatalog, sitePlace } from "./sites.ts";
export type { Site, SiteFilter } from "./sites.ts";
export type {
  GroupSelection, PresentFilter, Spread, ContactTarget, GatherOptions, DisperseOptions, GroupCommsOptions,
  GroupPresenceOptions, PerishOptions, GoHomeOptions, PresenceRule,
} from "./group.ts";
export type Mode = "walk" | "bike" | "car" | "transit" | "taxi";
export interface PersonFilter extends RecordFilters {
  id?: number;
  age?: Range;
  sex?: "male" | "female" | number;
  raceEthnicity?: string | string[];
  personalIncome?: Range;
  householdIncome?: Range;
  exclude?: readonly (Actor | Group)[];
  /**
   * `car` is driving eligibility; `vehicle` is a private vehicle registered
   * to the household, so a later `selectVehicle({ householdOf })` cannot
   * come up empty; `platforms` are communication accounts the person holds.
   * `vehicle: "couple"` asks for more: a household car parked at home at
   * midnight that nobody but the person and their household partner drives
   * on the recorded day, and no car the two of them drive that anybody else
   * drives after them, so a script can take over both their days without
   * stranding a flatmate where a cancelled drive would have left the car.
   * `selectVehicle({ usedOnlyBy })` then finds the car.
   */
  requires?: { car?: boolean; vehicle?: boolean | "couple"; platforms?: readonly comms.Channel[] };
  /** Home within `withinKm` of a place; `withinKm` defaults to 5. */
  homeNear?: Place;
  withinKm?: number;
  /** With `homeNear`: home at least this far from the place, so a caller is not the next-door neighbour. */
  minKm?: number;
  /** Shares a household with an already bound actor. */
  householdOf?: Actor;
  /** How many residents live in the person's household, the person included. */
  householdSize?: Range;
  /**
   * Has a tie of one of the listed kinds (any kind when omitted) to an
   * already bound actor: a partner, a colleague, a clubmate. Read from the
   * tie graph; ties to people outside the population never match.
   */
  tiedTo?: { actor: Actor; kind?: string | readonly string[] };
  /**
   * Has at least one tie of the listed kinds to somebody who is present in
   * the base day, so a later `tiedTo` selection from this person cannot
   * come up empty. `household` requires the other party to share the home;
   * `sex` and `platforms` are the other party's.
   */
  hasTie?: { kind: string | readonly string[]; household?: boolean; sex?: "male" | "female"; platforms?: readonly comms.Channel[]; wholeDay?: boolean };
  /**
   * The recorded day can be replaced from midnight to midnight: no carpool,
   * lift, bus, patrol tour, escort or school run in it that somebody else's
   * day depends on. On `hasTie` it asks the same of the other party.
   */
  wholeDay?: boolean;
  /** Work assignment occupation, such as `"police_officer"`; any listed value matches. */
  occupation?: string | readonly string[];
  /** Occupations to leave out, so a shooter is not drawn from a patrol watch. */
  excludeOccupations?: string | readonly string[];
  /** Work assignment at a site: a bound site place, or a site id. */
  worksAt?: Place | string;
  /** Not employed at a site, so a visitor is never one of its staff. */
  notWorksAt?: Place | string;
  /**
   * Was already there on the base day: within `within` (default 150 m) of a
   * place at one minute, or at any minute of `during`. A student drawn from
   * whoever the school run put in the building, a bystander from whoever
   * the recorded day had on that corner. The same rules as `s.present`:
   * people at their own home, on a leg or asleep at the sampled minute do
   * not count unless `atHome`, `moving` or `asleep` says they do.
   */
  presentNear?: { near: Place; at?: string | number; during?: readonly [string | number, string | number]; within?: string | number } & PresenceRule;
  /**
   * Awake in the recorded day at every minute from the first time through
   * the second, read from the base day's attention curve. For a person who
   * only texts or calls: the exchange layer refuses a call from somebody
   * asleep. People with no recorded curve count as awake.
   */
  awake?: readonly [string | number, string | number];
}
export interface PlaceFilter {
  id?: string;
  type?: discretionary.Purpose | "mall" | "parking" | "parking_lot";
  tag?: string;
  near?: Place;
  withinKm?: number;
  /** Open for the whole interval, as clock strings or minutes. */
  openDuring?: readonly [string | number, string | number];
}
export interface Place extends transport.Place {
  venue?: discretionary.Venue;
}
export interface VehicleFilter {
  vin?: string;
  owner?: Actor;
  householdOf?: Actor;
  serviceClass?: "none" | "taxi" | "school_bus" | "police" | "ems";
  parkedNear?: Place;
  at?: string | number;
  within?: string | number;
  /** Parked at the owner's home at midnight, and driven on the recorded day by nobody outside these people. */
  usedOnlyBy?: readonly Actor[];
}
export class Vehicle {
  constructor(readonly role: string, readonly record: VehicleRecord) {}
  get vin(): string { return this.record.vin; }
}
export interface Goto {
  kind: "goto"; id: string; person: number; place: Place; mode: Mode;
  arriveAt?: Time; departAt?: Time; stayFor: number;
}
export interface Communication {
  kind: "text" | "call"; id: string; person: number; to: number;
  at: Time; platform: comms.Channel; replies?: boolean;
  bytes?: number; duration?: number; outcome?: typeof comms.CALL_OUTCOMES[number];
  /** Further attempts, each a couple of minutes on, while the call goes unanswered. */
  retries?: number;
  /** Expanded from a group action; dropped with its member rather than failing the run. */
  droppable?: boolean;
}
export interface Purchase {
  kind: "purchase"; id: string; person: number; at: Time;
  channel: "online" | "in_person"; amount: number; venue?: Place;
  merchant?: { name: string; mcc: number }; instrument?: "cash" | "debit" | "credit";
}
export interface Trip {
  kind: "trip"; id: string; mode: "walk" | "car" | "taxi" | "auto" | "patrol";
  people: number[]; driver?: number; requestedBy?: number; vehicle?: string;
  place: Place; from?: Place; arriveAt?: Time; departAt?: Time;
  /** Walking speed multiplier: 1 is a walk, 1.8 is a run. Walking segments only. */
  pace?: number;
  /** Auto mode only: on foot beyond this the trip is skipped and the person stays put. */
  maxWalkKm?: number;
  /** Leave at `departAt` or as soon after as the person is free: a unit mid-drive finishes the drive first. */
  flexibleDepart?: boolean;
  droppable?: boolean;
}
export interface Presence {
  kind: "stay" | "wait"; id: string; people: number[]; place: Place;
  startAt: Time; endAt?: Time; duration?: number; purpose?: discretionary.Purpose;
  /** Wherever the person is when it starts; `place` is then only a label. */
  atCurrent?: boolean;
  /** Ends when the person's next action starts, or at their window end. */
  openEnded?: boolean;
  /** The stay is sleep: nothing sent, calls ring out, the handset idle. */
  asleep?: boolean;
  droppable?: boolean;
}
/** The person stops, for good: no movement, no calls answered, nothing sent. */
export interface Perish { kind: "perish"; id: string; person: number; at: Time; droppable?: boolean }
/** The person's handsets stay where they are from `at` on; the person may not. */
export interface Handset { kind: "handset"; id: string; person: number; at: Time; place?: Place; outdoors?: boolean; droppable?: boolean }
/** The recorded day's texts and calls between two people, inside a window, never happened. */
export interface Mute { kind: "mute"; id: string; people: [number, number]; from: number; until: number }
/**
 * The person's handsets are exempt from the day's random handset draws:
 * replay pins them (no left-at-home draw, no power-off, no dead battery) so
 * they stay with the person all day. A scripted `handset` hold still applies.
 */
export interface HandsetKeep { kind: "handset-keep"; id: string; person: number }
export type Action = Goto | Communication | Purchase | Trip | Presence | Perish | Handset | Mute | HandsetKeep;

/** `park_lot` is a parking lot beside a park, a garden or a reserve: somewhere a parked car draws no attention after dark. */
export type NearKind = "street" | "cafe" | "parking_lot" | "park_lot" | "venue";
export interface PresenceOptions {
  people: readonly Actor[];
  at?: Place;
  near?: Place;
  minDistance?: string | number;
  within?: string | number;
  kinds?: readonly NearKind[];
  startAt: Time;
  until?: Time | "next";
  for?: string | number;
  purpose?: discretionary.Purpose;
  /** Wherever each person already is; used by group actions. */
  atCurrent?: boolean;
  /** Set by `sleep`. */
  asleep?: boolean;
  droppable?: boolean;
}
export interface NearFilter {
  near: Place;
  minDistance?: string | number;
  within?: string | number;
  kinds?: readonly NearKind[];
  /** Try the kinds in the order given and take the first that has anything, rather than pooling them. */
  inOrder?: boolean;
  /** Only the far side of the anchor from this place: within 60° of the bearing that leads directly away from it. */
  awayFrom?: Place;
}

/** The base day's leg times and attention runs, by KDAY person row. */
interface DayState {
  legOffset: products.NumberArray; legCount: products.NumberArray;
  depart: products.NumberArray; arrive: products.NumberArray;
  /** Null for a KDAY without attention curves; then nobody counts as asleep. */
  attention: { offset: products.NumberArray; count: products.NumberArray; start: products.NumberArray; asleep: products.NumberArray } | null;
}
async function loadDayState(file: products.KdayFile): Promise<DayState> {
  const [legOffset, legCount, depart, arrive] = await Promise.all(
    ["person.legOffset", "person.legCount", "leg.depart", "leg.arrive"].map((name) => file.column(name)));
  const attention = file.has("attention.start")
    ? await Promise.all(["person.attentionOffset", "person.attentionCount", "attention.start", "attention.asleep"].map((name) => file.column(name)))
    : null;
  return { legOffset: legOffset!, legCount: legCount!, depart: depart!, arrive: arrive!,
    attention: attention ? { offset: attention[0]!, count: attention[1]!, start: attention[2]!, asleep: attention[3]! } : null };
}

/** POI tags that make a parking lot a `park_lot`. */
const GREEN = new Set(["leisure=park", "leisure=nature_reserve", "leisure=garden", "leisure=dog_park"]);

export class Actor {
  readonly windows: Window[] = [];
  readonly home: Place;
  constructor(readonly role: string, readonly person: world.Person, private readonly scene: ScenarioBuilder) {
    const home = world.homeOf(scene.context.world, person);
    if (!home) throw new Error(`${role}: person has no local home`);
    this.home = { ...home, id: null, kind: "home", label: transport.HOME_LABEL };
  }
  get id(): number { return this.person.id; }
  /** Eligible to drive a private car; whether one is parked where they are is another matter. */
  get canDrive(): boolean { return transport.DRIVING.has(transport.modeOf(this.person)); }
  replaceWindow(start: string | number, end: string | number): void {
    const window = { start: minute(start), end: minute(end) };
    if (window.start >= window.end || !Number.isInteger(window.start) || !Number.isInteger(window.end)) throw new Error("invalid replacement window");
    if (this.windows.some((w) => w.start < window.end && window.start < w.end)) throw new Error("overlapping replacement windows");
    this.windows.push(window);
    this.windows.sort((a, b) => a.start - b.start);
  }
  /**
   * A window a group action derived rather than the author declared.
   *
   * Soft windows merge with each other, so a gather followed by a flight is
   * one replacement rather than two that fight, and they are snapped to route
   * endpoints at replay rather than failing on a cut trip. They never merge
   * with a declared window: an author who wrote one meant it.
   */
  ensureWindow(start: number, end: number): Window {
    if (start >= 1440 || end > 1440) throw new DayBoundaryError(`${this.role}: replacement window crosses midnight`);
    if (!(start < end) || !Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`${this.role}: invalid derived window ${start}–${end}`);
    const touching = this.windows.filter((w) => w.soft && w.start <= end && start <= w.end);
    if (this.windows.some((w) => !w.soft && w.start < end && start < w.end)) throw new Error(`${this.role}: a group action overlaps a declared replacement window`);
    const merged: Window = { soft: true,
      start: Math.min(start, ...touching.map((w) => w.start)), end: Math.max(end, ...touching.map((w) => w.end)) };
    for (const window of touching) this.windows.splice(this.windows.indexOf(window), 1);
    this.windows.push(merged);
    this.windows.sort((a, b) => a.start - b.start);
    return merged;
  }
  /** Close the open-ended soft window at a minute, so the baseline resumes there. */
  closeWindow(at: number): void {
    const open = this.windows.find((w) => w.soft && w.end === 1440);
    if (!open) throw new Error(`${this.role}: no open group window to close`);
    if (!(at > open.start) || !Number.isInteger(at)) throw new Error(`${this.role}: cannot close a window at ${at}`);
    open.end = at;
  }
  goto(id: string, place: Place, options: {
    arriveAt?: Time; departAt?: Time; stayFor?: string | number; mode: Mode;
  }): { arrival: Boundary; departure: Boundary } {
    if (!["walk", "bike", "car", "transit", "taxi"].includes(options.mode)) throw new Error(`${id}: unsupported transport mode`);
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon) || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) throw new Error(`${id}: invalid destination coordinates`);
    if ((options.arriveAt === undefined) === (options.departAt === undefined)) throw new Error(`${id}: specify arriveAt or departAt`);
    const key = this.scene.add({ kind: "goto", id, person: this.id, place, ...options, stayFor: duration(options.stayFor ?? 0) });
    return { arrival: new Boundary(key, "arrival"), departure: new Boundary(key, "departure") };
  }
  text(id: string, to: Actor, options: { at: Time; platform: comms.Channel; bytes?: number; replies?: boolean }): void {
    if (options.platform === "voice") throw new Error("voice is not a text platform");
    this.scene.add({ kind: "text", id, person: this.id, to: to.id, ...options });
  }
  /**
   * A call to another actor, or to `"911"`: the emergency line, over carrier
   * voice, always answered and never called back.
   */
  call(id: string, to: Actor | "911", options: {
    at: Time; platform?: comms.Channel; duration?: string | number;
    outcome?: typeof comms.CALL_OUTCOMES[number]; replies?: boolean;
  }): void {
    const { duration: length, ...rest } = options;
    if (rest.platform === "sms" || rest.platform === "mms" || rest.platform === "snapchat") throw new Error("platform does not support scenario voice calls");
    if (to === "911") {
      if (rest.platform !== undefined && rest.platform !== "voice") throw new Error(`${id}: 911 is reached over carrier voice`);
      if (rest.outcome !== undefined || rest.replies !== undefined) throw new Error(`${id}: 911 calls take no outcome or replies`);
    }
    this.scene.add({ kind: "call", id, person: this.id, to: to === "911" ? comms.EMERGENCY_PERSON : to.id, platform: "voice", ...rest,
      ...(length === undefined ? {} : { duration: Math.round(duration(length) * 60) }) });
  }
  /**
   * The person dies where they stand, at a clock minute inside a
   * replacement window that runs to midnight: a wait until midnight, and on
   * the network a silence — nothing sent, no call answered, the handset
   * still registered where the body is. The runner removes whatever the
   * recorded day had them doing later. Group members use `Group.perish`.
   *
   * With `moved` the body does not stay put: the script carries it on as a
   * passenger and says where it ends up, and the handset rides with it
   * until `leaveHandset` says otherwise.
   */
  perish(id: string, options: { at: string | number; moved?: boolean }): void {
    const at = minute(options.at);
    if (!Number.isInteger(at)) throw new Error(`${id}: death is timed to a whole minute`);
    const window = this.windows.find((w) => w.start <= at && at < w.end);
    if (!window || window.end !== 1440) throw new Error(`${id}: ${this.role} needs a replacement window from before ${options.at} to 24:00`);
    if (!options.moved) this.scene.wait(`${id}/body`, { people: [this], atCurrent: true, startAt: at, until: 1440 });
    this.scene.add({ kind: "perish", id, person: this.id, at });
  }
  /**
   * The person's handsets stay where they are from `at` on — dropped at the
   * kerb, thrown in a bin, left in a car — while the person's own day goes
   * on without them: a phone that keeps registering on a cell that never
   * changes. The owner sends nothing and answers nothing until their own legs
   * bring them back to within 75 m of the phone; texts to it are still
   * delivered. `place` fixes where; without it the phone stays wherever the
   * person is at that minute. `outdoors` defaults to anywhere but a venue.
   */
  leaveHandset(id: string, options: { at: Time; place?: Place; outdoors?: boolean }): void {
    this.scene.add({ kind: "handset", id, person: this.id, at: options.at,
      ...(options.place === undefined ? {} : { place: options.place }),
      ...(options.outdoors === undefined ? {} : { outdoors: options.outdoors }) });
  }
  /**
   * Keep the person's handsets on them all day: the day's own left-at-home,
   * power-off and dead-battery draws are skipped for this person, so the
   * phone record a task depends on cannot be erased by chance. Scripted
   * `leaveHandset` holds still apply. Once per person.
   */
  keepHandset(id = `${this.role}/handset-keep`): void {
    if (this.scene.actions.some((action) => action.kind === "handset-keep" && action.person === this.id)) {
      throw new Error(`${id}: ${this.role} already keeps their handset`);
    }
    this.scene.add({ kind: "handset-keep", id, person: this.id });
  }
  purchase(id: string, options: {
    at: Time; channel: "online" | "in_person"; amount: Range; venue?: Place;
    merchant?: { name: string; mcc: number }; instrument?: "cash" | "debit" | "credit";
  }): void {
    if (typeof options.amount !== "number" && (!Number.isFinite(options.amount.min) || !Number.isFinite(options.amount.max)
        || options.amount.min > options.amount.max)) throw new Error(`${id}: invalid amount range`);
    const rng = new shared.Rng(seedFor(this.scene.seed, `${this.scene.name}/amount/${id}`));
    const amount = typeof options.amount === "number" ? options.amount : rng.between(options.amount.min, options.amount.max);
    if (!(amount > 0) || !Number.isFinite(amount)) throw new Error(`${id}: invalid purchase amount`);
    if (options.channel === "in_person" && !options.venue?.venue?.mcc) throw new Error(`${id}: in-person purchase needs a merchant venue`);
    if (options.channel === "online" && (!options.merchant || options.instrument === "cash")) throw new Error(`${id}: online purchase needs a merchant and cannot use cash`);
    this.scene.add({ kind: "purchase", id, person: this.id, ...options, amount: Math.round(amount * 100) / 100 });
  }
}

export interface ScenarioOptions extends ScenarioRunOptions { name: string; version?: number }
export interface ScenarioDefinition extends ScenarioRunOptions { name: string; version: number; build(scene: ScenarioBuilder): void | Promise<void> }
export function scenario(options: ScenarioOptions, build: ScenarioDefinition["build"]): ScenarioDefinition;
export function scenario(name: string, build: ScenarioDefinition["build"], version?: number): ScenarioDefinition;
export function scenario(options: string | ScenarioOptions, build: ScenarioDefinition["build"], version = 1): ScenarioDefinition {
  return typeof options === "string" ? { name: options, version, build }
    : { ...options, version: options.version ?? 1, build };
}

export interface ScenarioEvent {
  id: string; kind: string; lat: number; lon: number; place: string | null;
  radiusMetres: number; start: number; end: number; note?: string;
}

export class ScenarioBuilder {
  readonly actors = new Map<string, Actor>();
  readonly actorsById = new Map<number, Actor>();
  readonly groups = new Map<string, Group>();
  readonly places = new Map<string, Place>();
  readonly vehicleBindings = new Map<string, Vehicle>();
  readonly actions: Action[] = [];
  readonly events: ScenarioEvent[] = [];
  readonly requirements: GroupRequirement[] = [];
  /** Seeded branch choices, by role, so the header says which branch a seed took. */
  readonly choices = new Map<string, string>();
  private readonly keys = new Set<string>();
  /** The base day's legs and sleep, for presence and wakefulness rules; loaded once. */
  private day?: DayState;
  private dayError?: unknown;
  private readonly dayLoading: Promise<void> | null;
  constructor(
    readonly name: string, readonly seed: number, readonly context: DayContext,
    readonly presentPeople: ReadonlySet<number>, readonly vehicleCatalog?: VehicleCatalog,
    readonly baseline?: Baseline,
    readonly earlyStart = false,
  ) {
    if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
    // Started here so a script that awaits anything has it; the error is kept
    // for `ready()` rather than left as an unhandled rejection.
    this.dayLoading = baseline ? loadDayState(baseline.file).then((day) => { this.day = day; }, (error) => { this.dayError = error; }) : null;
  }
  /**
   * Wait for the base day's legs and sleep to load. `present`, `presentNear`,
   * `awake` and `wasAt` need them; `after` waits for them itself, so only a
   * script that reads presence before its first `after` calls this.
   */
  async ready(): Promise<void> {
    await this.dayLoading;
    if (this.dayError !== undefined) throw this.dayError;
  }
  /**
   * A seeded starting preference, never an arrival deadline: a whole minute
   * in `[from, until)`, the whole day by default. A script whose people only
   * call or text, or whose venues keep hours, passes the hours it is
   * plausible in.
   *
   * When the runner rebuilds after a `DayBoundaryError` (`earlyStart`), the
   * start is a second seeded minute in the earlier half between `from` and
   * the first draw, so late seeds move earlier without all landing on the
   * same minute.
   */
  start(window?: readonly [string | number, string | number]): number {
    const from = window ? minute(window[0]) : 0, until = window ? minute(window[1]) : 1440;
    if (!Number.isInteger(from) || !Number.isInteger(until) || !(from < until)) throw new Error("start window must be whole minutes, earlier first");
    const drawn = Math.floor(new shared.Rng(seedFor(this.seed, `${this.name}/schedule`)).between(from, until));
    if (!this.earlyStart) return drawn;
    const earlier = Math.max(1, (drawn - from) / 2);
    return Math.floor(new shared.Rng(seedFor(this.seed, `${this.name}/schedule/early`)).between(from, from + earlier));
  }
  /**
   * Whether the recorded day had a person within `within` of a place at a
   * minute, and not on a leg. Read from base positions, so it answers for
   * people already bound, which `matching` leaves out.
   */
  wasAt(actor: Actor, place: Place, at: string | number, within: string | number = 150): boolean {
    if (!this.baseline) throw new Error(`${actor.role}: wasAt needs the base day; it is unavailable in this builder`);
    const day = this.dayState(actor.role);
    const m = Math.floor(minute(at));
    const row = this.baseline.positionsAt(m).find((position) => position.person === actor.id);
    if (!row || transport.haversineKm(place, row) * 1000 > distanceMetres(within)) return false;
    return !this.movingAt(day, actor.id, m);
  }
  /** Resolve actual routed boundaries before choosing event/witness times.
   * Group boundaries are barriers: wait for the last feasible member.
   */
  async after(...times: Time[]): Promise<number> {
    if (!times.length) throw new Error("after() needs at least one action boundary");
    if (!this.baseline) throw new Error("after() requires a recorded base day");
    await this.ready();
    const windows = new Map([...this.actorsById.values()].map((actor) => [actor.id, actor.windows.map((window) => ({ ...window }))]));
    const realized = new Map<string, Realized>();
    await replayJointActions(this.context, this.baseline, windows, this.actions,
      shared.parseDate(this.baseline.file.header.date), realized, undefined, new Map(), true);
    const values = times.flatMap((time) => {
      if (typeof time !== "object" || !("groupAction" in time)) return [resolveTime(time, realized)];
      const members = [...realized].filter(([id]) => id.startsWith(`${time.groupAction}/`) && !id.slice(time.groupAction.length + 1).includes("/"));
      if (!members.length) throw new Error(`${time.groupAction}: no feasible members arrived`);
      return members.map(([, result]) => result[time.boundary] + time.minutes);
    });
    const at = Math.ceil(Math.max(...values));
    if (at >= 1440) throw new DayBoundaryError("scenario has no time left before midnight");
    return at;
  }
  add(action: Action): string {
    if (!action.id || this.keys.has(action.id)) throw new Error(`duplicate or empty action id: ${action.id}`);
    this.keys.add(action.id); this.actions.push(action); return action.id;
  }
  /** The one Actor for a resident, whichever role or group reached them first. */
  bind(person: world.Person, role: string): Actor {
    const known = this.actorsById.get(person.id);
    if (known) return known;
    const actor = new Actor(role, person, this);
    this.actorsById.set(person.id, actor);
    return actor;
  }
  /**
   * A deliberate event the task layer can key on: where, when, how wide.
   *
   * Recorded in the delta's header beside the groups, so a generator reads
   * the incident's centre and window from the file rather than from the
   * script that made it.
   */
  event(id: string, options: { kind: string; at: Place; start: Time; end: Time; radius?: string | number; note?: string }): void {
    if (this.events.some((event) => event.id === id)) throw new Error(`duplicate event ${id}`);
    const start = options.start, end = options.end;
    if (typeof start !== "string" && typeof start !== "number") throw new Error(`${id}: event times are clock times`);
    if (typeof end !== "string" && typeof end !== "number") throw new Error(`${id}: event times are clock times`);
    if (typeof start === "number" && start >= 1440 || typeof end === "number" && end > 1440) throw new DayBoundaryError(`${id}: event crosses midnight`);
    this.events.push({ id, kind: options.kind, lat: options.at.lat, lon: options.at.lon, place: options.at.id,
      radiusMetres: distanceMetres(options.radius ?? 150), start: minute(start), end: minute(end),
      ...(options.note ? { note: options.note } : {}) });
  }
  /**
   * Two people did not text or call each other inside a window (the whole
   * day by default). The runner removes the recorded day's exchanges in
   * their one-to-one threads — every message and call between them in the
   * window, and whatever answered one — so a couple who spent the day side
   * by side has no record of ringing each other. Group threads they both
   * sit in are left alone. Scenario texts and calls are unaffected.
   */
  mute(id: string, options: { between: readonly [Actor, Actor]; from?: string | number; until?: string | number }): void {
    const [a, b] = options.between;
    if (a.id === b.id) throw new Error(`${id}: mute needs two different people`);
    const from = minute(options.from ?? 0), until = minute(options.until ?? "24:00");
    if (!Number.isInteger(from) || !Number.isInteger(until) || from >= until) throw new Error(`${id}: invalid mute window`);
    this.add({ kind: "mute", id, people: [a.id, b.id], from, until });
  }
  private candidates(role: string, filter: PersonFilter): world.Person[] {
    const exclude = new Set<number>();
    for (const item of filter.exclude ?? []) {
      if (item instanceof Group) for (const member of item.members) exclude.add(member.id);
      else exclude.add(item.id);
    }
    for (const actor of this.actorsById.values()) exclude.add(actor.id);
    const sex = filter.sex === "male" ? 1 : filter.sex === "female" ? 2 : filter.sex;
    const races = typeof filter.raceEthnicity === "string" ? [filter.raceEthnicity] : filter.raceEthnicity;
    const records = PersonRecords.shared().matcher(role, filter);
    if (filter.withinKm !== undefined && (!filter.homeNear || !(filter.withinKm > 0))) throw new Error(`${role}: withinKm requires homeNear and a positive radius`);
    const radius = filter.homeNear ? filter.withinKm ?? 5 : undefined;
    const occupations = filter.occupation === undefined ? null : new Set(typeof filter.occupation === "string" ? [filter.occupation] : filter.occupation);
    const excluded = new Set(typeof filter.excludeOccupations === "string" ? [filter.excludeOccupations] : filter.excludeOccupations ?? []);
    const siteOf = (value: Place | string | undefined, name: string): string | null => {
      if (value === undefined) return null;
      const id = typeof value === "string" ? value : value.id;
      if (!id) throw new Error(`${role}: ${name} needs a place with an id`);
      return id;
    };
    const worksAt = siteOf(filter.worksAt, "worksAt"), notWorksAt = siteOf(filter.notWorksAt, "notWorksAt");
    const present = filter.presentNear ? this.presentIds(role, filter.presentNear) : null;
    const awake = filter.awake ? this.awakeTest(role, filter.awake) : null;
    if (filter.minKm !== undefined && (!filter.homeNear || !(filter.minKm >= 0))) throw new Error(`${role}: minKm requires homeNear and a non-negative distance`);
    if (radius !== undefined && filter.minKm !== undefined && filter.minKm > radius) throw new Error(`${role}: minKm exceeds withinKm`);
    const tieKinds = this.context.ties.header.kinds;
    const kindSet = (kind: string | readonly string[] | undefined, name: string): Set<number> | null => {
      if (kind === undefined) return null;
      const names = typeof kind === "string" ? [kind] : kind;
      if (!names.length) throw new Error(`${role}: ${name} needs at least one tie kind`);
      const unknown = names.find((value) => !tieKinds.includes(value));
      if (unknown) throw new Error(`${role}: unknown tie kind ${unknown}; known: ${tieKinds.join(", ")}`);
      return new Set(names.map((value) => tieKinds.indexOf(value)));
    };
    // Whoever the anchor actor is tied to, restricted to the kinds asked for.
    const tied = filter.tiedTo ? new Set(this.context.ties.forPerson(filter.tiedTo.actor.id)
      .filter((contact) => !this.context.ties.external(contact.other) && contact.other !== filter.tiedTo!.actor.id)
      .filter((contact) => { const kinds = kindSet(filter.tiedTo!.kind, "tiedTo.kind"); return !kinds || kinds.has(contact.kind); })
      .map((contact) => contact.other)) : null;
    const partnerKind = tieKinds.indexOf("partner");
    const wantedTie = filter.hasTie ? kindSet(filter.hasTie.kind, "hasTie.kind")! : null;
    const otherSex = filter.hasTie?.sex === "male" ? 1 : filter.hasTie?.sex === "female" ? 2 : undefined;
    const hasTie = (person: world.Person): boolean => this.context.ties.forPerson(person.id).some((contact) => {
      if (!wantedTie!.has(contact.kind) || this.context.ties.external(contact.other) || contact.other === person.id) return false;
      const other = this.context.world.persons.get(contact.other);
      if (!other || !this.presentPeople.has(other.id) || exclude.has(other.id) || !world.homeOf(this.context.world, other)) return false;
      if (filter.hasTie!.household && other.household !== person.household) return false;
      if (otherSex !== undefined && other.sex !== otherSex) return false;
      if (filter.hasTie!.wholeDay && this.recorded().sharesJourneys(other.id)) return false;
      return (filter.hasTie!.platforms ?? []).every((platform) => this.context.comms?.accounts.on(other.id, comms.CHANNELS.indexOf(platform)));
    });
    return [...this.context.world.persons.values()].filter((person) => {
      // Both the assignment's role (`police_officer`, `taxi_driver`) and its
      // occupation title count, because the roster names people by role.
      const assignment = this.context.world.assignments.get(person.id);
      const names = [assignment?.role, assignment?.occupation, person.occupation].filter((name): name is string => Boolean(name));
      if (occupations && !names.some((name) => occupations.has(name))) return false;
      if (names.some((name) => excluded.has(name))) return false;
      if (worksAt !== null && assignment?.site !== worksAt) return false;
      if (notWorksAt !== null && assignment?.site === notWorksAt) return false;
      if (present && !present.has(person.id)) return false;
      if (!this.presentPeople.has(person.id) || exclude.has(person.id)) return false;
      const home = world.homeOf(this.context.world, person);
      if (!home) return false;
      if (filter.id !== undefined && filter.id !== person.id) return false;
      if (!inRange(person.age, filter.age) || (sex !== undefined && person.sex !== sex)) return false;
      if (races && !races.includes(person.race_ethnicity ?? "")) return false;
      if (!inRange(person.income, filter.personalIncome)
          || !inRange(this.context.world.households.get(person.household)?.income, filter.householdIncome)) return false;
      if (filter.requires?.car && !transport.DRIVING.has(transport.modeOf(person))) return false;
      if (filter.requires?.vehicle && !(this.context.world.householdVehicles.get(person.household)?.length)) return false;
      if (filter.requires?.vehicle === "couple") {
        const partners = this.context.ties.forPerson(person.id)
          .filter((contact) => contact.kind === partnerKind && this.context.world.persons.get(contact.other)?.household === person.household)
          .map((contact) => contact.other);
        const couple = [person.id, ...partners];
        if (!this.unsharedVehicles(person.household, home, couple).length || this.sharedDrives(couple)) return false;
      }
      if (radius !== undefined && transport.haversineKm(filter.homeNear!, home) > radius) return false;
      if (filter.minKm !== undefined && transport.haversineKm(filter.homeNear!, home) < filter.minKm) return false;
      if (filter.householdOf !== undefined && person.household !== filter.householdOf.person.household) return false;
      if (filter.householdSize !== undefined && !inRange(this.householdSizes().get(person.household) ?? 0, filter.householdSize)) return false;
      if (tied && !tied.has(person.id)) return false;
      if (wantedTie && !hasTie(person)) return false;
      if (records && !records(person.id)) return false;
      if (filter.wholeDay && this.recorded().sharesJourneys(person.id)) return false;
      if (awake && !awake(person.id)) return false;
      return (filter.requires?.platforms ?? []).every((platform) =>
        this.context.comms?.accounts.on(person.id, comms.CHANNELS.indexOf(platform)));
    }).sort((a, b) => a.id - b.id);
  }
  /**
   * A crowd: `count` residents matching a filter, as one Group.
   *
   * The same candidate rule as `selectPerson`, then a seeded draw without
   * replacement. A range for `count` draws the size first, so the same seed
   * gives the same crowd and a different seed a different one of a different
   * size.
   */
  selectPeople(role: string, filter: PersonFilter, selection: GroupSelection): Group {
    if (this.groups.has(role)) throw new Error(`duplicate group role ${role}`);
    const candidates = this.candidates(role, filter);
    const rng = new shared.Rng(seedFor(this.seed, `${this.name}/people/${role}`));
    const count = typeof selection.count === "number" ? selection.count
      : Math.round(rng.between(selection.count.min, selection.count.max));
    if (!Number.isInteger(count) || count < 1) throw new Error(`${role}: count must be a positive integer`);
    if (candidates.length < count) throw new Error(`${role}: only ${candidates.length} residents satisfy selection constraints; ${count} requested`);
    const chosen = rng.shuffle(candidates).slice(0, count).sort((a, b) => a.id - b.id);
    const group = new Group(role, chosen.map((person) => this.bind(person, `${role}/${person.id}`)), this);
    this.groups.set(role, group);
    return group;
  }
  /**
   * Whoever the base day already had at a place: bystanders, regulars, staff.
   *
   * Read from the recorded positions rather than from any selection, so it
   * finds the people the simulation put there for its own reasons. `at`
   * samples one minute; `during` samples every minute of an interval and
   * takes the union.
   *
   * A crowd is the people actually there: by default somebody counts at a
   * minute only when they are not at their own home (a neighbour in bed
   * 100 m from the bar is not at the bar), not on a leg (a driver passing
   * on the road is not on the corner) and not asleep. `atHome`, `moving`
   * and `asleep` let each of those back in. `awake` further keeps only
   * people awake at every minute of an interval, for members who will call.
   */
  present(role: string, filter: PresentFilter): Group {
    if (this.groups.has(role)) throw new Error(`duplicate group role ${role}`);
    if (!this.baseline) throw new Error("present() needs the base day; it is unavailable in this builder");
    if ((filter.at === undefined) === (filter.during === undefined)) throw new Error(`${role}: specify at or during`);
    const found = this.presentIds(role, filter);
    const awake = filter.awake ? this.awakeTest(role, filter.awake) : null;
    const exclude = new Set<number>();
    for (const item of filter.exclude ?? []) {
      if (item instanceof Group) for (const member of item.members) exclude.add(member.id);
      else exclude.add(item.id);
    }
    const members = [...found].filter((id) => !exclude.has(id)).sort((a, b) => a - b)
      .map((id) => this.context.world.persons.get(id)!)
      .filter((person) => person && world.homeOf(this.context.world, person))
      .filter((person) => !awake || awake(person.id))
      .filter((person) => (filter.requires?.platforms ?? []).every((platform) =>
        this.context.comms?.accounts.on(person.id, comms.CHANNELS.indexOf(platform))))
      .map((person) => this.bind(person, `${role}/${person.id}`));
    const group = new Group(role, members, this, filter.near);
    this.groups.set(role, group);
    return group;
  }
  /** Who the recorded day had near a place, by resident id, under the presence rules `present` documents. */
  private presentIds(role: string, filter: Pick<PresentFilter, "near" | "at" | "during" | "within" | keyof PresenceRule>): Set<number> {
    if (!this.baseline) throw new Error(`${role}: presence needs the base day; it is unavailable in this builder`);
    if ((filter.at === undefined) === (filter.during === undefined)) throw new Error(`${role}: specify at or during`);
    const day = this.dayState(role);
    const within = distanceMetres(filter.within ?? 150) / 1000;
    const minutes = filter.at !== undefined ? [minute(filter.at)]
      : Array.from({ length: Math.max(0, minute(filter.during![1]) - minute(filter.during![0])) }, (_, i) => minute(filter.during![0]) + i);
    if (!minutes.length || minutes.some((m) => !Number.isInteger(m))) throw new Error(`${role}: presence is sampled at whole minutes`);
    const found = new Set<number>();
    for (const m of minutes) {
      for (const row of this.baseline.positionsAt(m)) {
        if (found.has(row.person) || transport.haversineKm(filter.near, row) > within) continue;
        if (!filter.moving && this.movingAt(day, row.person, m)) continue;
        if (!filter.asleep && this.asleepAt(day, row.person, m)) continue;
        if (!filter.atHome && this.atOwnHome(row.person, row)) continue;
        found.add(row.person);
      }
    }
    return found;
  }
  /** The loaded base-day state, or a clear error when a script reads it too early. */
  private dayState(role: string): DayState {
    if (this.dayError !== undefined) throw this.dayError;
    if (!this.day) throw new Error(`${role}: the base day's legs and sleep are still loading; await s.ready() before reading presence`);
    return this.day;
  }
  private row(person: number): number | undefined { return this.baseline?.people.get(person); }
  /** On a recorded leg at a minute, waiting for the bus included. */
  private movingAt(day: DayState, person: number, at: number): boolean {
    const row = this.row(person);
    if (row === undefined) return false;
    const first = day.legOffset[row]!, count = day.legCount[row]!;
    for (let i = first; i < first + count; i++) {
      if (day.depart[i]! > at) break;
      if (at < day.arrive[i]!) return true;
    }
    return false;
  }
  /** Asleep at a minute by the recorded attention curve; false where the day has no curve. */
  private asleepAt(day: DayState, person: number, at: number): boolean {
    const row = this.row(person);
    if (row === undefined || !day.attention) return false;
    const { offset, count, start, asleep } = day.attention;
    const first = offset[row]!, n = count[row]!;
    let found = -1;
    for (let i = first; i < first + n; i++) {
      if (start[i]! > at) break;
      found = i;
    }
    return found >= 0 && asleep[found] === 1;
  }
  /** Within 75 m of the person's own home, the distance a phone reunion uses. */
  private atOwnHome(person: number, at: { lat: number; lon: number }): boolean {
    const resident = this.context.world.persons.get(person);
    const home = resident ? world.homeOf(this.context.world, resident) : null;
    return Boolean(home) && transport.haversineKm(home!, at) <= 0.075;
  }
  /** A predicate: awake at every whole minute from the first time through the second. */
  private awakeTest(role: string, range: readonly [string | number, string | number]): (person: number) => boolean {
    const day = this.dayState(role);
    const from = Math.floor(minute(range[0])), through = Math.min(1439, Math.floor(minute(range[1])));
    if (through < from) throw new Error(`${role}: awake needs an interval, earlier first`);
    return (person) => {
      for (let m = from; m <= through; m++) if (this.asleepAt(day, person, m)) return false;
      return true;
    };
  }
  /**
   * A seeded branch: one of the named options, the same for the same seed.
   *
   * A scenario that always ends the same way is a fixture; `pick` is how a
   * script says "the shooter flees, blends in or dies" and lets the seed
   * decide, with the choice written into the header beside the roles.
   */
  pick<T extends string>(role: string, options: readonly T[]): T {
    if (this.choices.has(role)) throw new Error(`duplicate choice role ${role}`);
    if (!options.length || new Set(options).size !== options.length) throw new Error(`${role}: pick needs distinct options`);
    const chosen = new shared.Rng(seedFor(this.seed, `${this.name}/pick/${role}`)).pick(options);
    this.choices.set(role, chosen);
    return chosen;
  }
  /**
   * One site — a hospital, a warehouse, a school — from the workplace and
   * school catalogues, by class. Bound like a venue, so trips route to it
   * and `present` reads who the day already had inside.
   */
  selectSite(role: string, filter: SiteFilter): Place {
    if (this.places.has(role)) throw new Error(`duplicate place role ${role}`);
    const candidates = SiteCatalog.shared().matching(role, filter);
    if (!candidates.length) throw new Error(`${role}: no sites satisfy selection constraints`);
    const site = new shared.Rng(seedFor(this.seed, `${this.name}/site/${role}`)).pick(candidates);
    const place = sitePlace(site);
    this.places.set(role, place); return place;
  }
  /**
   * How many residents a person filter would offer, without binding anyone.
   *
   * Selection never widens a constraint, so a script that wants an optional
   * role — a decoy if the corner has one — asks first and selects only when
   * there is somebody to select.
   */
  matching(filter: PersonFilter): number { return this.candidates("matching", filter).length; }
  /** Every site a filter matches, for inspection or branching in trusted scenario code. */
  sites(filter: SiteFilter): Site[] { return SiteCatalog.shared().matching("sites", filter); }
  /**
   * Send the nearest patrol units to a place.
   *
   * The units are the base day's own: officers out on their beat at that
   * minute, in the cars the roster gave them, nearest first. Each drives to
   * the scene, holds there, and drives back to its station in time for the
   * watch's own return, so the car is in the yard when the next watch takes
   * it. A unit that cannot make the round trip inside its watch is dropped
   * rather than failing the scenario; `minUnits` is the floor.
   */
  respond(id: string, options: { to: Place; at: Time; units?: number; holdFor?: string | number; minUnits?: number; flexible?: boolean }): Group {
    if (!this.baseline) throw new Error("respond() needs the base day; it is unavailable in this builder");
    if (typeof options.at !== "string" && typeof options.at !== "number") throw new Error(`${id}: respond is timed to a clock minute`);
    const at = minute(options.at);
    if (!Number.isInteger(at)) throw new Error(`${id}: respond is timed to a whole minute`);
    const units = options.units ?? 2;
    const hold = Math.round(duration(options.holdFor ?? "90m"));
    if (!Number.isInteger(units) || units < 1) throw new Error(`${id}: units must be a positive integer`);
    const candidates = this.baseline.patrolUnits(at)
      .filter((unit) => !this.actorsById.has(unit.person) && this.presentPeople.has(unit.person))
      .map((unit) => ({ unit, km: transport.haversineKm(unit, options.to) }))
      .sort((a, b) => a.km - b.km || a.unit.person - b.unit.person);
    const later = (): Group => {
      const next = options.flexible ? this.baseline!.nextPatrolStart(at) : null;
      if (next !== null) return this.respond(id, { ...options, at: next });
      if (options.flexible) throw new DayBoundaryError(`${id}: no patrol unit is available to respond before midnight`);
      throw new Error(`${id}: no patrol unit is available to respond before midnight`);
    };
    if (!candidates.length) return later();
    const members: Actor[] = [];
    for (const { unit, km } of candidates) {
      if (members.length === units) break;
      const person = this.context.world.persons.get(unit.person);
      if (!person) continue;
      // A unit sent to a call is held over past end of watch if it must; what
      // it cannot do is keep the car from the next driver, or keep the
      // officer from wherever their own day goes after the station. The hold
      // is cut to fit the earlier of those, less the drive there, the drive
      // back to the yard and a margin at an unhurried city speed. A unit with
      // less than ten minutes to give is not sent.
      const drive = Math.ceil((km + transport.haversineKm(options.to, unit.station)) * 1.5 / 25 * 60);
      const nextDriver = this.vehicleCatalog?.movements(unit.vin)
        .filter((movement) => movement.person !== unit.person && movement.start >= unit.backAt)
        .reduce((soonest, movement) => Math.min(soonest, movement.start), 1440) ?? 1440;
      const deadline = Math.max(unit.backAt, Math.min(unit.leavesAt, nextDriver - 1));
      // A watch that runs past midnight cannot hand its car back inside the day.
      if (deadline > 1440) continue;
      const holdHere = Math.min(hold, deadline - at - drive - 10);
      if (holdHere < 10) continue;
      const officer = this.bind(person, `${id}/${unit.person}`);
      members.push(officer);
      // The window closes with the car back in the yard, which the rejoin
      // drives to in the same car.
      officer.ensureWindow(at, deadline);
      const scene: Place = { ...options.to, kind: options.to.kind === "venue" ? "venue" : "kerb" };
      const run = this.trip(`${id}/${unit.person}`, { mode: "patrol", people: [officer], to: scene, departAt: at, vehicle: unit.vin,
        droppable: true, flexibleDepart: true });
      this.wait(`${id}/${unit.person}/scene`, { people: [officer], at: scene, startAt: run.arrival, for: holdHere, droppable: true });
    }
    if (!members.length) return later();
    const group = new Group(id, members, this, options.to);
    this.groups.set(id, group);
    if (options.minUnits !== undefined) this.requirements.push({ action: id, group: id, people: group.ids, minCount: options.minUnits });
    return group;
  }
  /** Register a group derived from another (partition, sample, union). */
  registerGroup(group: Group): void {
    if (this.groups.has(group.role)) throw new Error(`duplicate group role ${group.role}`);
    this.groups.set(group.role, group);
  }
  private driversByVin?: Map<number, Set<string>>;
  /** Whether any car these people drive on the recorded day is also driven by somebody else. */
  private sharedDrives(people: readonly number[]): boolean {
    const catalog = this.vehicleCatalog;
    if (!catalog) throw new Error("vehicle selection requires a vehicle-tracked KDAY");
    if (!this.driversByVin) {
      this.driversByVin = new Map();
      for (const vin of catalog.vins()) for (const movement of catalog.movements(vin)) {
        if (movement.person === null) continue;
        const vins = this.driversByVin.get(movement.person) ?? new Set<string>();
        vins.add(vin); this.driversByVin.set(movement.person, vins);
      }
    }
    const allowed = new Set(people);
    return people.some((person) => [...this.driversByVin!.get(person) ?? []].some((vin) =>
      catalog.movements(vin).some((movement) => movement.person !== null && !allowed.has(movement.person))));
  }
  private sizes?: Map<number, number>;
  /** Residents per household, counted from the population rather than the census size. */
  private householdSizes(): Map<number, number> {
    if (!this.sizes) {
      this.sizes = new Map();
      for (const person of this.context.world.persons.values()) this.sizes.set(person.household, (this.sizes.get(person.household) ?? 0) + 1);
    }
    return this.sizes;
  }
  private recorded(): Baseline {
    if (!this.baseline) throw new Error("wholeDay needs the base day; it is unavailable in this builder");
    return this.baseline;
  }
  /** Household cars at home at midnight that only `people` drive on the recorded day. */
  private unsharedVehicles(household: number, home: { lat: number; lon: number }, people: readonly number[]): string[] {
    if (!this.vehicleCatalog) throw new Error("vehicle selection requires a vehicle-tracked KDAY");
    const allowed = new Set(people);
    return (this.context.world.householdVehicles.get(household) ?? []).filter((vin) => {
      if (this.vehicleCatalog!.record(vin)?.serviceClass !== "none") return false;
      const opening = this.vehicleCatalog!.openingLocation(vin);
      if (!opening || transport.haversineKm(opening, home) > 0.15) return false;
      return this.vehicleCatalog!.movements(vin).every((movement) => movement.person === null || allowed.has(movement.person));
    });
  }
  selectVehicle(role: string, filter: VehicleFilter): Vehicle {
    if (this.vehicleBindings.has(role)) throw new Error(`duplicate vehicle role ${role}`);
    if (!this.vehicleCatalog) throw new Error("vehicle selection requires a vehicle-tracked KDAY");
    let candidates = this.vehicleCatalog.records.filter((row) => {
      if (filter.vin !== undefined && row.vin !== filter.vin) return false;
      if (filter.owner !== undefined && (row.ownerType !== "person" || row.owner !== filter.owner.id)) return false;
      if (filter.householdOf !== undefined && row.household !== filter.householdOf.person.household) return false;
      if (filter.serviceClass !== undefined && row.serviceClass !== filter.serviceClass) return false;
      if (filter.householdOf !== undefined && filter.serviceClass === undefined && filter.vin === undefined
          && row.serviceClass !== "none") return false;
      return true;
    });
    if (filter.usedOnlyBy !== undefined) {
      const [first] = filter.usedOnlyBy;
      if (!first) throw new Error(`${role}: usedOnlyBy needs at least one person`);
      const allowed = new Set(this.unsharedVehicles(first.person.household, first.home, filter.usedOnlyBy.map((actor) => actor.id)));
      candidates = candidates.filter((row) => allowed.has(row.vin));
    }
    if (filter.parkedNear !== undefined) {
      if (filter.at === undefined || filter.within === undefined) throw new Error("parkedNear requires at and within");
      const allowed = new Set(candidates.map((row) => row.vin));
      candidates = this.vehicleCatalog.parkedNear(
        filter.parkedNear, minute(filter.at), distanceMetres(filter.within), (row) => allowed.has(row.vin),
      );
    }
    candidates = candidates.slice().sort((a, b) => a.vin.localeCompare(b.vin));
    if (!candidates.length) throw new Error(`${role}: no vehicles satisfy selection constraints`);
    const selected = new shared.Rng(seedFor(this.seed, `${this.name}/vehicle/${role}`)).pick(candidates);
    const vehicle = new Vehicle(role, selected);
    this.vehicleBindings.set(role, vehicle);
    return vehicle;
  }
  vehicles(filter: VehicleFilter): Vehicle[] {
    if (!this.vehicleCatalog) throw new Error("vehicle lookup requires a vehicle-tracked KDAY");
    if (!filter.parkedNear || filter.at === undefined || filter.within === undefined) {
      throw new Error("vehicles requires parkedNear, at and within");
    }
    return this.vehicleCatalog.parkedNear(
      filter.parkedNear, minute(filter.at), distanceMetres(filter.within), (row) =>
        (filter.vin === undefined || row.vin === filter.vin)
        && (filter.owner === undefined || (row.ownerType === "person" && row.owner === filter.owner.id))
        && (filter.householdOf === undefined || row.household === filter.householdOf.person.household)
        && (filter.serviceClass === undefined || row.serviceClass === filter.serviceClass),
    ).map((record) => new Vehicle(`vehicle/${record.vin}`, record));
  }
  trip(id: string, options:
    | { mode: "walk"; people: readonly Actor[]; from?: Place; to: Place; arriveAt?: Time; departAt?: Time; pace?: number; droppable?: boolean; flexibleDepart?: boolean }
    | { mode: "auto"; people: readonly Actor[]; from?: Place; to: Place; arriveAt?: Time; departAt?: Time; pace?: number; maxWalkKm?: number; droppable?: boolean; flexibleDepart?: boolean }
    | { mode: "car"; vehicle: Vehicle; driver: Actor; passengers?: readonly Actor[]; from?: Place; to: Place; arriveAt?: Time; departAt?: Time; droppable?: boolean }
    | { mode: "taxi"; riders: readonly Actor[]; requestedBy: Actor; from?: Place; to: Place; departAt: Time; droppable?: boolean }
    | { mode: "patrol"; people: readonly Actor[]; vehicle: string; from?: Place; to: Place; departAt: Time; droppable?: boolean; flexibleDepart?: boolean }
  ): { arrival: Boundary; departure: Boundary } {
    const arriveAt = "arriveAt" in options ? options.arriveAt : undefined;
    if ((arriveAt === undefined) === (options.departAt === undefined)) throw new Error(`${id}: specify arriveAt or departAt`);
    const pace = "pace" in options ? options.pace : undefined;
    if (pace !== undefined && !(pace >= 1 && pace <= 2)) throw new Error(`${id}: pace must be between 1 (walk) and 2 (sprint)`);
    const maxWalkKm = "maxWalkKm" in options ? options.maxWalkKm : undefined;
    if (maxWalkKm !== undefined && !(maxWalkKm > 0)) throw new Error(`${id}: maxWalkKm must be positive`);
    let people: Actor[], driver: number | undefined, requestedBy: number | undefined, vehicle: string | undefined;
    if (options.mode === "walk" || options.mode === "auto") {
      people = [...options.people];
      if (options.mode === "auto" && people.length !== 1) throw new Error(`${id}: auto mode moves one person at a time`);
    } else if (options.mode === "patrol") {
      people = [...options.people]; vehicle = options.vehicle;
      if (people.length !== 1) throw new Error(`${id}: patrol trip takes exactly one officer`);
    } else if (options.mode === "car") {
      if (!transport.DRIVING.has(transport.modeOf(options.driver.person))) throw new Error(`${id}: driver is not eligible to drive`);
      if (options.vehicle.record.serviceClass !== "none") throw new Error(`${id}: private-car trip requires a non-service vehicle`);
      people = [options.driver, ...(options.passengers ?? [])]; driver = options.driver.id; vehicle = options.vehicle.vin;
      const seats = this.context.world.vehicles.get(vehicle)?.seats ?? 5;
      if (people.length > seats) throw new Error(`${id}: vehicle ${vehicle} has ${seats} seats for ${people.length} people`);
    } else {
      people = [...options.riders]; requestedBy = options.requestedBy.id;
      if (!people.some((actor) => actor.id === requestedBy)) throw new Error(`${id}: taxi requester must be a rider`);
    }
    if (!people.length || new Set(people.map((actor) => actor.id)).size !== people.length) throw new Error(`${id}: trip people must be non-empty and distinct`);
    const key = this.add({ kind: "trip", id, mode: options.mode, people: people.map((actor) => actor.id),
      ...(driver === undefined ? {} : { driver }), ...(requestedBy === undefined ? {} : { requestedBy }),
      ...(vehicle === undefined ? {} : { vehicle }), ...(options.from ? { from: options.from } : {}),
      place: options.to, ...(arriveAt === undefined ? {} : { arriveAt }),
      ...(options.departAt === undefined ? {} : { departAt: options.departAt }),
      ...(pace === undefined ? {} : { pace }), ...(maxWalkKm === undefined ? {} : { maxWalkKm }),
      ...("flexibleDepart" in options && options.flexibleDepart ? { flexibleDepart: true } : {}),
      ...(options.droppable ? { droppable: true } : {}) });
    return { arrival: new Boundary(key, "arrival"), departure: new Boundary(key, "departure") };
  }
  stay(id: string, options: PresenceOptions & { purpose: discretionary.Purpose }): { start: Boundary; end: Boundary } {
    return this.presence("stay", id, options);
  }
  wait(id: string, options: PresenceOptions): { start: Boundary; end: Boundary } {
    return this.presence("wait", id, options);
  }
  /**
   * Asleep at home, as the planner's own nights are: a whole-day script that
   * leaves the night as a plain wait has its people awake and texting at four.
   */
  sleep(id: string, options: { person: Actor; startAt: Time; until: Time }): { start: Boundary; end: Boundary } {
    return this.presence("wait", id, { people: [options.person], at: options.person.home, startAt: options.startAt, until: options.until, asleep: true });
  }
  near(role: string, filter: NearFilter): Place {
    if (this.places.has(role)) throw new Error(`duplicate place role ${role}`);
    const place = this.nearbyPlace(role, filter);
    this.places.set(role, place);
    return place;
  }
  private presence(kind: "stay" | "wait", id: string, options: PresenceOptions): { start: Boundary; end: Boundary } {
    if (!options.people.length || new Set(options.people.map((actor) => actor.id)).size !== options.people.length) {
      throw new Error(`${id}: presence people must be non-empty and distinct`);
    }
    if ((options.until === undefined) === (options.for === undefined)) throw new Error(`${id}: specify until or for`);
    const startAt = options.startAt;
    const place = this.presencePlace(id, options);
    const key = this.add({ kind, id, people: options.people.map((actor) => actor.id), place, startAt,
      ...(options.until === undefined ? { duration: duration(options.for!) }
        : options.until === "next" ? { openEnded: true } : { endAt: options.until }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.atCurrent ? { atCurrent: true } : {}), ...(options.asleep ? { asleep: true } : {}),
      ...(options.droppable ? { droppable: true } : {}) });
    return { start: new Boundary(key, "arrival"), end: new Boundary(key, "departure") };
  }
  private presencePlace(id: string, options: PresenceOptions): Place {
    if (options.atCurrent) return options.at ?? { id: null, kind: "kerb", label: "where they were", lat: 0, lon: 0 };
    if ((options.at === undefined) === (options.near === undefined)) throw new Error(`${id}: specify at or near`);
    if (options.at) return options.at;
    return this.nearbyPlace(id, { ...options, near: options.near! });
  }
  /** A seeded kerb point in an annulus, optionally in a given direction (radians). */
  streetPoint(key: string, anchor: Place, minimum: number, maximum: number, bearing?: number): Place {
    const rng = new shared.Rng(seedFor(this.seed, `${this.name}/near/${key}`));
    const metres = Math.max(1, rng.between(minimum, maximum));
    const angle = bearing ?? rng.next() * 2 * Math.PI;
    return { id: null, kind: "kerb", label: `street near ${anchor.label}`,
      lat: anchor.lat + Math.cos(angle) * metres / 111_320,
      lon: anchor.lon + Math.sin(angle) * metres / (111_320 * Math.cos(anchor.lat * Math.PI / 180)) };
  }
  private nearbyPlace(id: string, options: NearFilter): Place {
    const anchor = options.near;
    const minimum = distanceMetres(options.minDistance ?? 0);
    const maximum = distanceMetres(options.within ?? 250);
    if (minimum > maximum || maximum <= 0) throw new Error(`${id}: invalid near distance`);
    const kinds = options.kinds ?? ["street", "cafe", "parking_lot", "venue"];
    // The same convention as `streetPoint`: zero is north, a quarter turn is east.
    const bearing = (from: Place, to: Place) =>
      Math.atan2((to.lon - from.lon) * Math.cos(from.lat * Math.PI / 180), to.lat - from.lat);
    const away = options.awayFrom ? bearing(options.awayFrom, anchor) : undefined;
    const inReach = (point: { lat: number; lon: number }): boolean => {
      const metres = transport.haversineKm(anchor, point) * 1000;
      if (metres < minimum || metres > maximum) return false;
      if (away === undefined) return true;
      const turn = Math.abs(bearing(anchor, point as Place) - away) % (2 * Math.PI);
      return Math.min(turn, 2 * Math.PI - turn) <= Math.PI / 3;
    };
    const lots = () => (this.context.poiCatalog ?? []).filter((poi) => poi.tag === "amenity=parking" && inReach(poi));
    const ofKind = (kind: NearKind): Place[] => {
      if (kind === "cafe" || kind === "venue") {
        return [...this.context.venues.points()].map(([venueId]) => this.context.venues.get(venueId)!)
          .filter((venue) => inReach(venue) && (kind === "venue" || venue.purposes.includes("cafe")))
          .map((venue) => ({ lat: venue.lat, lon: venue.lon, id: venue.id, kind: "venue" as const, label: venue.name || venue.tag, venue }));
      }
      if (kind === "street") return [];
      const parks = kind === "park_lot" ? (this.context.poiCatalog ?? []).filter((poi) => GREEN.has(poi.tag)) : null;
      return lots().filter((lot) => !parks || parks.some((park) => transport.haversineKm(lot, park) <= 0.25))
        .map((lot) => ({ lat: lot.lat, lon: lot.lon, id: lot.id, kind: "kerb" as const, label: lot.name || "parking lot" }));
    };
    const pooled = (wanted: readonly NearKind[]): Place[] =>
      [...new Map(wanted.flatMap(ofKind).map((place) => [place.id, place])).values()].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    const candidates = options.inOrder ? kinds.map((kind) => pooled([kind])).find((found) => found.length) ?? [] : pooled(kinds);
    if (candidates.length) return new shared.Rng(seedFor(this.seed, `${this.name}/near/${id}`)).pick(candidates);
    if (!kinds.includes("street")) throw new Error(`${id}: no nearby place satisfies constraints`);
    return this.streetPoint(id, anchor, minimum, maximum, away);
  }
  selectPerson(role: string, filter: PersonFilter = {}): Actor {
    if (this.actors.has(role)) throw new Error(`duplicate role ${role}`);
    const candidates = this.candidates(role, filter);
    if (!candidates.length) throw new Error(`${role}: no residents satisfy selection constraints`);
    const person = new shared.Rng(seedFor(this.seed, `${this.name}/person/${role}`)).pick(candidates);
    const actor = this.bind(person, role);
    this.actors.set(role, actor); return actor;
  }
  selectPlace(role: string, filter: PlaceFilter): Place {
    if (this.places.has(role)) throw new Error(`duplicate place role ${role}`);
    if (filter.withinKm !== undefined && (!filter.near || !(filter.withinKm > 0))) throw new Error("withinKm requires near and a positive radius");
    if (filter.type === "parking" || filter.type === "parking_lot") {
      const candidates = (this.context.poiCatalog ?? []).filter((poi) => poi.tag === "amenity=parking"
        && (!filter.id || poi.id === filter.id) && (!filter.tag || poi.tag === filter.tag)
        && (!filter.near || filter.withinKm === undefined || transport.haversineKm(filter.near, poi) <= filter.withinKm))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!candidates.length) throw new Error(`${role}: no parking lots satisfy selection constraints`);
      const poi = new shared.Rng(seedFor(this.seed, `${this.name}/place/${role}`)).pick(candidates);
      const place: Place = { lat: poi.lat, lon: poi.lon, id: poi.id, kind: "kerb", label: poi.name || "parking lot" };
      this.places.set(role, place); return place;
    }
    const all = [...this.context.venues.points()].map(([id]) => this.context.venues.get(id)!);
    const candidates = all.filter((venue) => {
      if (filter.id && venue.id !== filter.id) return false;
      if (filter.tag && venue.tag !== filter.tag) return false;
      if (filter.type === "mall" && venue.tag !== "shop=mall") return false;
      if ((filter.type === "parking" || filter.type === "parking_lot") && !venue.tag.startsWith("amenity=parking")) return false;
      if (filter.type && !["mall", "parking", "parking_lot"].includes(filter.type)
          && !venue.purposes.includes(filter.type as discretionary.Purpose)) return false;
      if (filter.near && filter.withinKm !== undefined && transport.haversineKm(filter.near, venue) > filter.withinKm) return false;
      if (filter.openDuring && (!discretionary.isOpen(venue, minute(filter.openDuring[0]))
          || !discretionary.isOpen(venue, minute(filter.openDuring[1]) - 1))) return false;
      return true;
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) throw new Error(`${role}: no places satisfy selection constraints`);
    const venue = new shared.Rng(seedFor(this.seed, `${this.name}/place/${role}`)).pick(candidates);
    const place: Place = { lat: venue.lat, lon: venue.lon, id: venue.id, kind: "venue", label: venue.name || venue.tag, venue };
    this.places.set(role, place); return place;
  }
  place(id: string): Place {
    const venue = this.context.venues.get(id);
    const point = venue ?? this.context.world.places.get(id);
    if (!point) throw new Error(`unknown place ${id}`);
    return { lat: point.lat, lon: point.lon, id, kind: "venue", label: venue?.name || id, ...(venue ? { venue } : {}) };
  }
}

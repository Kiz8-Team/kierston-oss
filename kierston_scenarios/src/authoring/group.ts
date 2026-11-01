/**
 * Crowds: a set of residents acted on together, spread over minutes.
 *
 * A group is a set of Actors and nothing more; every group action expands
 * into the same per-person primitives a single actor uses, one per member,
 * with ids of the form `${id}/${person}`. Three things make that expansion
 * worth a class of its own rather than a loop in a script:
 *
 *   spread     three hundred people do not start running in the same second.
 *              Every group action takes a `spread` and gives each member a
 *              seeded offset inside it, so the same seed always produces the
 *              same stagger and a later action can be timed off each member's
 *              own copy of an earlier one (see `MemberTime`).
 *   subsets    the dead, the hiding and the fleeing are a partition; the ones
 *              who call home are a sample that overlaps all three. Keeping the
 *              two derivations distinct is what stops a script from making
 *              somebody both dead and running.
 *   tolerance  a crowd is a distribution, not a cast list. A member the roads
 *              cannot deliver — no car where they are, too far to walk, a
 *              window that would cut a shared bus — is dropped rather than
 *              failing the scenario, and the script states the floor it will
 *              accept with `minCount`.
 */

import { comms, shared, discretionary, type DayContext } from "../../../kierston/sim/src/index.ts";
import type { Actor, Place, ScenarioBuilder } from "./dsl.ts";
import { GroupBoundary, forMember, shifted, minute, duration, distanceMetres, seedFor, type Time } from "./time.ts";
import { DayBoundaryError } from "./schedule.ts";

export interface GroupSelection { count: number | { min: number; max: number } }
/**
 * Who counts as present at a sampled minute. By default only people who are
 * at the place in person: not at their own home, not on a leg, not asleep.
 */
export interface PresenceRule {
  /** Count people at their own home too: a resident next door, not a customer. */
  atHome?: boolean;
  /** Count people on a leg too: a car or bus passing through. */
  moving?: boolean;
  /** Count people asleep too. */
  asleep?: boolean;
}
export interface PresentFilter extends PresenceRule {
  near: Place;
  /** One sampled minute. */
  at?: string | number;
  /** Every minute of an interval; anybody there at any of them. */
  during?: readonly [string | number, string | number];
  within?: string | number;
  exclude?: readonly (Actor | Group)[];
  /** Communication accounts every member must hold, as for a selection. */
  requires?: { platforms?: readonly comms.Channel[] };
  /** Awake at every minute from the first time through the second, as for a selection. */
  awake?: readonly [string | number, string | number];
}
/** How a group action is staggered across its members. */
export interface Spread {
  for: string | number;
  /** `uniform` across the interval, or a `burst` that is front-loaded with a tail. */
  shape?: "uniform" | "burst";
}
export type ContactTarget = "911" | "family" | "household" | "friends" | Actor;
export interface GroupCommsOptions {
  at: Time;
  spread?: Spread;
  /** Force a platform; otherwise the pair's own usual one. */
  platform?: comms.Channel;
  /** Contacts per member for `family`, `household` and `friends`. */
  count?: number;
  /** Extra attempts, a few minutes apart, while a call goes unanswered. */
  retries?: number;
  replies?: boolean;
  bytes?: number;
  duration?: string | number;
  outcome?: typeof comms.CALL_OUTCOMES[number];
  /**
   * `drop` (the default) lets replay skip a member's exchange it cannot
   * place; `fail` fails the run instead, for a call the task's truth names,
   * such as the one 911 call a witness makes.
   */
  onInfeasible?: "drop" | "fail";
}
export interface GatherOptions {
  at: Place;
  arriveAt?: Time;
  departAt?: Time;
  spread?: Spread;
  /** When members leave; absent means they stay until a later action moves them. */
  leaveAt?: Time;
  leaveSpread?: Spread;
  /** After leaving: rejoin the recorded day, go home for the night, or nothing yet. */
  then?: "resume" | "home" | "stay";
  mode?: "auto" | "walk";
  pace?: number;
  /**
   * Auto mode only: a member who would have to walk farther than this does
   * not make the journey and is dropped, so one slow walker from across the
   * radius does not hold back a gathering timed off the last arrival.
   */
  maxWalkKm?: number;
  /** How long before an `arriveAt` the member's day is opened for the journey. */
  lead?: string | number;
  purpose?: discretionary.Purpose;
  onInfeasible?: "drop" | "fail";
  minCount?: number;
}
export interface DisperseOptions {
  at: Time;
  spread?: Spread;
  /** What they are running from; the group's gathering place by default. */
  from?: Place;
  minDistance?: string | number;
  within?: string | number;
  /** 1 walks, 1.8 runs. */
  pace?: number;
  /** Stay put at the far end for a while before moving on. */
  hideFor?: string | number;
  then?: "home" | "stay";
  /** Farther than this on foot and a member stays where they stopped rather than walking home. */
  maxWalkKm?: number;
  /** Share of members whose handsets stay behind at `from`. */
  phoneLeft?: number;
  onInfeasible?: "drop" | "fail";
  minCount?: number;
}
export interface GroupPresenceOptions {
  at: Time;
  spread?: Spread;
  for?: string | number;
  until?: Time;
  purpose?: discretionary.Purpose;
  then?: "resume" | "stay";
  onInfeasible?: "drop" | "fail";
}
export interface GoHomeOptions {
  at: Time;
  spread?: Spread;
  mode?: "auto" | "walk";
  maxWalkKm?: number;
  onInfeasible?: "drop" | "fail";
}
export interface PerishOptions { at: Time; spread?: Spread; onInfeasible?: "drop" | "fail"; minCount?: number }

const FAMILY = new Set(["partner", "household", "parent", "child", "sibling", "coparent", "grandparent", "kin_ext"]);
const HOUSEHOLD = new Set(["partner", "household"]);
const NOT_FRIENDS = new Set([...FAMILY, "ex_partner", "abroad"]);

export class Group implements Iterable<Actor> {
  /** The members this group still has; a dropped member is removed at replay. */
  readonly members: readonly Actor[];
  /** Where the group last gathered, which is what a flight is from. */
  place?: Place;
  constructor(readonly role: string, members: readonly Actor[], private readonly scene: ScenarioBuilder, place?: Place) {
    const ids = new Set<number>();
    for (const member of members) {
      if (ids.has(member.id)) throw new Error(`${role}: duplicate member ${member.id}`);
      ids.add(member.id);
    }
    this.members = [...members].sort((a, b) => a.id - b.id);
    this.place = place;
  }
  get size(): number { return this.members.length; }
  get ids(): number[] { return this.members.map((member) => member.id); }
  has(actor: Actor | number): boolean {
    const id = typeof actor === "number" ? actor : actor.id;
    return this.members.some((member) => member.id === id);
  }
  [Symbol.iterator](): Iterator<Actor> { return this.members[Symbol.iterator](); }

  private derive(role: string, members: readonly Actor[], place = this.place): Group {
    const group = new Group(role, members, this.scene, place);
    this.scene.registerGroup(group);
    return group;
  }
  private rng(key: string): shared.Rng {
    return new shared.Rng(seedFor(this.scene.seed, `${this.scene.name}/group/${this.role}/${key}`));
  }

  /**
   * Split into disjoint subgroups by weight. Every member lands in exactly one.
   *
   * Weights need not sum to one; they are shares. Sizes are the rounded
   * shares of the count, with the last named group taking the remainder, so
   * `{ dead: 0.03, hiding: 0.25, fleeing: 0.72 }` of 300 is 9, 75 and 216.
   */
  partition<K extends string>(role: string, weights: Record<K, number>): Record<K, Group> {
    const names = Object.keys(weights) as K[];
    if (!names.length) throw new Error(`${role}: partition needs at least one part`);
    const total = names.reduce((sum, name) => sum + weights[name], 0);
    if (!(total > 0) || names.some((name) => !(weights[name] >= 0))) throw new Error(`${role}: partition weights must be non-negative and not all zero`);
    const shuffled = this.rng(`partition/${role}`).shuffle([...this.members]);
    const out = {} as Record<K, Group>;
    let at = 0;
    names.forEach((name, index) => {
      const size = index === names.length - 1 ? shuffled.length - at : Math.round(shuffled.length * weights[name] / total);
      out[name] = this.derive(`${role}/${name}`, shuffled.slice(at, at + size));
      at += size;
    });
    return out;
  }
  /** A subset drawn without removing anyone; may overlap any other sample. */
  sample(role: string, size: number | { count: number }): Group {
    const count = typeof size === "number"
      ? (size <= 1 ? Math.round(this.members.length * size) : Math.round(size))
      : size.count;
    if (!Number.isInteger(count) || count < 0 || count > this.members.length) throw new Error(`${role}: cannot sample ${count} of ${this.members.length}`);
    return this.derive(role, this.rng(`sample/${role}`).shuffle([...this.members]).slice(0, count));
  }
  union(role: string, other: Group): Group {
    const seen = new Map(this.members.map((member) => [member.id, member]));
    for (const member of other.members) seen.set(member.id, member);
    return this.derive(role, [...seen.values()], this.place ?? other.place);
  }
  minus(role: string, other: Group | readonly Actor[]): Group {
    const gone = new Set((other instanceof Group ? other.members : other).map((member) => member.id));
    return this.derive(role, this.members.filter((member) => !gone.has(member.id)));
  }

  /** Each member's offset into a spread, in minutes; zero without one. */
  private offsets(id: string, spread: Spread | undefined, whole: boolean): Map<number, number> {
    const out = new Map<number, number>();
    const span = spread ? duration(spread.for) : 0;
    if (span < 0) throw new Error(`${id}: invalid spread`);
    for (const member of this.members) {
      if (!span) { out.set(member.id, 0); continue; }
      const u = new shared.Rng(seedFor(this.scene.seed, `${this.scene.name}/spread/${id}/${member.id}`)).next();
      const raw = spread!.shape === "burst" ? Math.min(span, -Math.log(1 - u) * span / 3) : u * span;
      out.set(member.id, whole ? Math.round(raw) : raw);
    }
    return out;
  }
  private memberTime(id: string, at: Time, member: Actor, offset: number, whole: boolean): Time {
    const time = shifted(forMember(at, member.id), offset);
    if (whole && typeof time === "number" && !Number.isInteger(time)) throw new Error(`${id}: physical group actions use whole minutes`);
    return time;
  }
  /**
   * Open a member's day for an action at `at`, which ends the day unless told
   * otherwise. A clock time opens a window there; a member time can only
   * continue a window an earlier group action already opened, because the
   * minute it stands for is not known until replay.
   */
  private open(id: string, member: Actor, at: Time, end = 1440): void {
    if (typeof at === "string" || typeof at === "number") { member.ensureWindow(minute(at), end); return; }
    const existing = member.windows.find((window) => window.soft);
    if (!existing) throw new Error(`${id}: ${member.role} has no earlier group action to time this from; use a clock time`);
    member.ensureWindow(existing.start, Math.max(existing.end, end));
  }
  private clock(id: string, time: Time): number {
    if (typeof time !== "string" && typeof time !== "number") throw new Error(`${id}: this option needs a clock time, not an action boundary`);
    return minute(time);
  }
  private requirement(id: string, options: { onInfeasible?: "drop" | "fail"; minCount?: number }): boolean {
    const droppable = options.onInfeasible !== "fail";
    if (options.minCount !== undefined) {
      if (!Number.isInteger(options.minCount) || options.minCount < 0) throw new Error(`${id}: minCount must be a non-negative integer`);
      this.scene.requirements.push({ action: id, group: this.role, people: this.ids, minCount: options.minCount });
    }
    return droppable;
  }

  /**
   * Bring everyone to a place, hold them there, and let them leave.
   *
   * Arrival or departure is the anchor; the spread staggers it per member.
   * The member's day is opened `lead` before an arrival (or at a departure)
   * and closed at their leave time when they `resume`, at midnight otherwise.
   */
  gather(id: string, options: GatherOptions): { start: GroupBoundary; end: GroupBoundary } {
    if ((options.arriveAt === undefined) === (options.departAt === undefined)) throw new Error(`${id}: specify arriveAt or departAt`);
    const then = options.then ?? (options.leaveAt !== undefined ? "resume" : "stay");
    if (then !== "stay" && options.leaveAt === undefined) throw new Error(`${id}: then requires leaveAt`);
    if (then === "stay" && options.leaveAt !== undefined) throw new Error(`${id}: leaveAt cannot be used with then: "stay"; use resume or home`);
    const lead = Math.round(duration(options.lead ?? "90m"));
    if (options.maxWalkKm !== undefined && options.mode === "walk") throw new Error(`${id}: maxWalkKm applies to auto mode only`);
    const droppable = this.requirement(id, options);
    const arrive = this.offsets(id, options.spread, true);
    const leave = this.offsets(`${id}/leave`, options.leaveSpread ?? options.spread, true);
    for (const member of this.members) {
      const anchor = options.arriveAt !== undefined
        ? this.memberTime(id, options.arriveAt, member, arrive.get(member.id)!, true)
        : this.memberTime(id, options.departAt!, member, arrive.get(member.id)!, true);
      const opens = options.arriveAt !== undefined ? this.clock(id, anchor) - lead : this.clock(id, anchor);
      const leaveAt = options.leaveAt === undefined ? undefined
        : this.memberTime(id, options.leaveAt, member, leave.get(member.id)!, true);
      const closes = leaveAt !== undefined && then === "resume" ? this.clock(id, leaveAt) : 1440;
      member.ensureWindow(Math.max(0, opens), closes);
      const trip = this.scene.trip(`${id}/${member.id}/trip`, { mode: options.mode ?? "auto", people: [member], to: options.at,
        ...(options.arriveAt !== undefined ? { arriveAt: anchor } : { departAt: anchor }),
        ...(options.departAt !== undefined ? { flexibleDepart: true } : {}),
        ...(options.pace === undefined ? {} : { pace: options.pace }),
        ...(options.maxWalkKm === undefined ? {} : { maxWalkKm: options.maxWalkKm }), droppable });
      const presence = { people: [member], at: options.at, startAt: trip.arrival, droppable,
        ...(leaveAt === undefined ? { until: "next" as const } : { until: leaveAt }) };
      const held = options.purpose
        ? this.scene.stay(`${id}/${member.id}`, { ...presence, purpose: options.purpose })
        : this.scene.wait(`${id}/${member.id}`, presence);
      if (then === "home") {
        this.scene.trip(`${id}/${member.id}/home`, { mode: "auto", people: [member], to: member.home, departAt: held.end, droppable });
      }
    }
    this.place = options.at;
    return { start: new GroupBoundary(id, "arrival"), end: new GroupBoundary(id, "departure") };
  }

  /**
   * Everybody runs. Each member gets their own way out — a kerb point in an
   * annulus around the place, in their own direction — and then hides, goes
   * home or stays where they stopped. The window runs to midnight: a day
   * that ends like this is not resumed.
   */
  disperse(id: string, options: DisperseOptions): { start: GroupBoundary; end: GroupBoundary } {
    const from = options.from ?? this.place;
    if (!from) throw new Error(`${id}: disperse needs from, or a gathering place`);
    const minimum = distanceMetres(options.minDistance ?? 150), maximum = distanceMetres(options.within ?? 600);
    if (!(minimum < maximum)) throw new Error(`${id}: invalid disperse distances`);
    const pace = options.pace ?? 1.8;
    const then = options.then ?? "home";
    const droppable = this.requirement(id, options);
    const offsets = this.offsets(id, options.spread, true);
    const phones = options.phoneLeft === undefined ? new Set<number>()
      : new Set(this.sampleIds(`${id}/phones`, options.phoneLeft));
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, true);
      this.open(id, member, at);
      const direction = new shared.Rng(seedFor(this.scene.seed, `${this.scene.name}/flee/${id}/${member.id}`)).next() * 2 * Math.PI;
      const escape = this.scene.streetPoint(`${id}/${member.id}`, from, minimum, maximum, direction);
      const run = this.scene.trip(`${id}/${member.id}`, { mode: "walk", people: [member], to: escape, departAt: at, pace, droppable });
      let free = run.arrival;
      if (options.hideFor !== undefined) {
        free = this.scene.wait(`${id}/${member.id}/hide`, { people: [member], at: escape, startAt: run.arrival, for: options.hideFor, droppable }).end;
      }
      if (then === "home") {
        this.scene.trip(`${id}/${member.id}/home`, { mode: "auto", people: [member], to: member.home, departAt: free, droppable,
          ...(options.maxWalkKm === undefined ? { maxWalkKm: 4 } : { maxWalkKm: options.maxWalkKm }) });
      }
      if (phones.has(member.id)) {
        this.scene.add({ kind: "handset", id: `${id}/${member.id}/phone`, person: member.id, at, place: from, droppable });
      }
    }
    return { start: new GroupBoundary(id, "start"), end: new GroupBoundary(id, "arrival") };
  }

  /** Stay where they are for a while: sheltering in place, waiting it out. */
  wait(id: string, options: GroupPresenceOptions): { start: GroupBoundary; end: GroupBoundary } {
    if ((options.for === undefined) === (options.until === undefined)) throw new Error(`${id}: specify for or until`);
    const then = options.then ?? "stay";
    const droppable = this.requirement(id, options);
    const offsets = this.offsets(id, options.spread, true);
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, true);
      const end = then === "resume" && options.until !== undefined ? this.clock(id, forMember(options.until, member.id)) : 1440;
      this.open(id, member, at, end);
      const presence = { people: [member], atCurrent: true, startAt: at, droppable,
        ...(options.for !== undefined ? { for: options.for } : { until: forMember(options.until!, member.id) }) };
      if (options.purpose) this.scene.stay(`${id}/${member.id}`, { ...presence, purpose: options.purpose });
      else this.scene.wait(`${id}/${member.id}`, presence);
    }
    return { start: new GroupBoundary(id, "arrival"), end: new GroupBoundary(id, "departure") };
  }

  /** Everybody heads home from wherever they are, and stays there. */
  goHome(id: string, options: GoHomeOptions): { start: GroupBoundary; end: GroupBoundary } {
    const droppable = this.requirement(id, options);
    const offsets = this.offsets(id, options.spread, true);
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, true);
      this.open(id, member, at);
      this.scene.trip(`${id}/${member.id}`, { mode: options.mode ?? "auto", people: [member], to: member.home, departAt: at, droppable,
        ...(options.maxWalkKm === undefined ? {} : { maxWalkKm: options.maxWalkKm }) });
    }
    return { start: new GroupBoundary(id, "start"), end: new GroupBoundary(id, "arrival") };
  }

  /** Let everyone get on with their recorded day from a minute on. */
  async resumeAfter(id: string, arrival: Time, options: { for: string | number; spread?: Spread }): Promise<{ start: number; end: number }> {
    const hold = Math.ceil(duration(options.for));
    const offsets = this.offsets(id, options.spread, true);
    let start = await this.scene.after(arrival);
    // Closing a window restores later household car bookings. That can change
    // which mode the inbound trip can use, so resolve with those bookings in
    // place before publishing the gathering's event time. Only move later.
    for (;;) {
      let end = start + hold;
      for (const member of this.members) {
        const window = member.windows.find((candidate) => candidate.soft);
        if (!window) throw new Error(`${id}: ${member.role} has no gathering window`);
        const until = start + hold + offsets.get(member.id)!;
        if (until > 1440) throw new DayBoundaryError(`${id}: gathering crosses midnight`);
        window.end = until;
        end = Math.max(end, until);
      }
      const resolved = await this.scene.after(arrival);
      if (resolved <= start) return { start, end };
      start = resolved;
    }
  }

  /** Let everyone get on with their recorded day from a minute on. */
  dissolve(id: string, options: { at: Time; spread?: Spread }): void {
    const offsets = this.offsets(id, options.spread, true);
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, true);
      member.closeWindow(this.clock(id, at));
    }
  }

  /**
   * The member dies where they stand.
   *
   * Physically a wait until midnight; on the network a silence — no call
   * answered, nothing sent, the handset still registered where the body is.
   * The runner also removes whatever the recorded day had them doing later.
   */
  perish(id: string, options: PerishOptions): { start: GroupBoundary; end: GroupBoundary } {
    // Fatal by default: dropping is per person, and a lone shooter who dies
    // must not quietly vanish from the run. A crowd's dead opt in with
    // `onInfeasible: "drop"`, since a body whose recorded evening was a
    // shared ride home cannot be replanned and one fewer is no loss.
    const droppable = this.requirement(id, { ...options, onInfeasible: options.onInfeasible ?? "fail" });
    const offsets = this.offsets(id, options.spread, true);
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, true);
      this.open(id, member, at);
      this.scene.wait(`${id}/${member.id}`, { people: [member], atCurrent: true, startAt: at, until: 1440, droppable });
      this.scene.add({ kind: "perish", id: `${id}/${member.id}/death`, person: member.id, at });
    }
    return { start: new GroupBoundary(id, "arrival"), end: new GroupBoundary(id, "departure") };
  }

  text(id: string, target: ContactTarget, options: GroupCommsOptions): void {
    if (target === "911") throw new Error(`${id}: 911 takes calls, not texts`);
    this.communicate("text", id, target, options);
  }
  call(id: string, target: ContactTarget, options: GroupCommsOptions): void {
    this.communicate("call", id, target, options);
  }
  private communicate(kind: "text" | "call", id: string, target: ContactTarget, options: GroupCommsOptions): void {
    const offsets = this.offsets(id, options.spread, false);
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new Error(`${id}: count must be a positive integer`);
    if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0)) throw new Error(`${id}: retries must be a non-negative integer`);
    const length = options.duration === undefined ? undefined : Math.round(duration(options.duration) * 60);
    const droppable = options.onInfeasible !== "fail";
    for (const member of this.members) {
      const at = this.memberTime(id, options.at, member, offsets.get(member.id)!, false);
      const targets = this.targetsFor(member, target, kind, count, options.platform);
      targets.forEach((contact, index) => {
        const platform = comms.CHANNELS[contact.channel]!;
        if (kind === "text" && platform === "voice") return;
        this.scene.add({ kind, id: index ? `${id}/${member.id}/${index}` : `${id}/${member.id}`, person: member.id, to: contact.person,
          at, platform, ...(droppable ? { droppable: true } : {}),
          ...(options.replies === undefined ? {} : { replies: options.replies }),
          ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
          ...(length === undefined ? {} : { duration: length }),
          ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
          ...(options.retries ? { retries: options.retries } : {}) });
      });
    }
  }
  /** Who a member reaches for, and on what, for a named kind of contact. */
  private targetsFor(member: Actor, target: ContactTarget, kind: "text" | "call", count: number, forced?: comms.Channel): { person: number; channel: number }[] {
    const context: DayContext = this.scene.context;
    const accounts = context.comms?.accounts;
    if (!accounts) throw new Error("group communications need a comms-enabled context");
    if (target === "911") return [{ person: comms.EMERGENCY_PERSON, channel: comms.VOICE }];
    const pick = (other: number): { person: number; channel: number } | null => {
      if (forced) {
        const channel = comms.CHANNELS.indexOf(forced);
        return accounts.has(member.id, channel) && accounts.has(other, channel) ? { person: other, channel } : null;
      }
      const mine = accounts.channels(member.id), theirs = accounts.channels(other);
      if (!mine.length || !theirs.length) return null;
      const pair = comms.pairChannels(member.id, other, mine, theirs, context.world.seed);
      return { person: other, channel: kind === "call" ? pair.voice : pair.dominant };
    };
    if (typeof target !== "string") {
      const chosen = pick(target.id);
      return chosen ? [chosen] : [];
    }
    const kinds = context.ties.header.kinds;
    const wanted = (name: string) => target === "family" ? FAMILY.has(name) : target === "household" ? HOUSEHOLD.has(name) : !NOT_FRIENDS.has(name);
    const contacts = context.ties.forPerson(member.id)
      .filter((contact) => contact.valence > 0 && !context.ties.external(contact.other) && contact.other !== member.id
        && this.scene.presentPeople.has(contact.other) && wanted(kinds[contact.kind] ?? ""))
      .sort((a, b) => b.affinity - a.affinity || a.other - b.other);
    const out: { person: number; channel: number }[] = [];
    for (const contact of contacts) {
      const chosen = pick(contact.other);
      if (chosen) out.push(chosen);
      if (out.length === count) break;
    }
    return out;
  }
  private sampleIds(key: string, fraction: number): number[] {
    if (!(fraction >= 0 && fraction <= 1)) throw new Error(`${key}: fraction must be between 0 and 1`);
    const count = Math.round(this.members.length * fraction);
    return this.rng(key).shuffle(this.ids).slice(0, count);
  }
}

/** Everything a runner needs to check a group floor after dropping members. */
export interface GroupRequirement { action: string; group: string; people: number[]; minCount: number }

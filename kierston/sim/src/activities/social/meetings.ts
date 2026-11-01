/**
 * Two or more people, one place, on purpose.
 *
 * Everything else in the simulation that puts people in a room together does
 * it by accident of structure: a shift roster, a school bell, an org's
 * calendar, a bus manifest. Those are institutions, and the co-presence they
 * produce is a side effect of belonging to one. This module is the other kind
 * — a pair who decided to have coffee, a family who went to the park — where
 * the co-presence is the whole point and nothing institutional caused it.
 *
 * Everybody derives the same meeting, nobody reads anybody's day
 * -------------------------------------------------------------
 * `planDay` is per person and parallel, and the only mechanism the simulation
 * has for making two days agree is the one `affiliations.ts` and `school.ts`
 * both use: both parties derive the shared thing from an object that existed
 * before either day was planned. There is no negotiation here and there cannot
 * be one. A meeting is drawn from *one* person — the convener — so every other
 * party rediscovers the identical venue, minute and driver by re-running the
 * convener's draw rather than by being told about it.
 *
 * That constraint is what shapes the rest of the file. Every input to a
 * meeting must be something both parties can see without planning a day:
 * static homes, the tie graph, `rosterFor`, the school calendar, the org
 * calendar. None of them may be a *planned* day, which is why the busy test
 * below looks at fixed commitments only and not at where somebody's shopping
 * happened to land.
 *
 * Why one convener and not a pair
 * -------------------------------
 * The obvious design keys the draw on the two people, sorted by id, the way
 * `pairChannels` keys a conversation. It works and it cannot grow past two.
 * A gathering's identity is then the pair, so a third person has no key to
 * compute: to find out whether two of their friends arranged something they
 * would have to enumerate every pair among their own contacts and look up the
 * edge between each — quadratic in a contact list of forty and cubic once the
 * lookup is counted, some thirty thousand steps per person per day, three and
 * a half billion across the city.
 *
 * Keying on one person removes the problem rather than optimising it. A
 * convener draws whether they are arranging anything today and, if so, a guest
 * list from their own contacts weighted by how close each one is. Everybody
 * else asks the same short question of each of their own contacts — did you
 * convene today, and am I on the list — which costs a walk of that contact's
 * list, about sixteen hundred steps per person per day.
 *
 * Two people fall out of it as a guest list of one, so this replaces the pair
 * mechanism rather than sitting beside it, and the size of a gathering is now
 * just the length of a list. Households are unchanged and still keyed on the
 * address, which every resident can compute; see `householdOuting`.
 *
 * Nobody can be in two places, and everybody must agree which
 * ------------------------------------------------------------
 * The hard case is A drawn into one gathering at seven and another at eight. A
 * can only go to one, and every other party has to reach the same conclusion or
 * they spend the evening in a bar with somebody who is not there — which is
 * precisely the sort of inconsistency this data exists to be checked for. So a
 * gathering survives only if it wins in *every* party's own candidate set, and
 * a candidate set is something any party can build for any other: their
 * contacts and rates are in the graph, so their draws for the day can be
 * enumerated and the same greedy run over them.
 *
 * Losing a guest shrinks the party; losing the convener cancels it. Both rules
 * are pure functions of who turned up, so everybody applies them to the same
 * list and gets the same answer.
 *
 * The resolution is one level deep and deliberately not a fixpoint. Whether
 * A's meeting with C would itself have survived C's set is not consulted. That
 * costs meetings and never costs consistency: the test both parties apply is
 * the same conjunction, so they either both keep an evening or both lose it,
 * and the failure mode is an evening that quietly does not happen rather than
 * one person sitting in a bar on their own. A fixpoint over the whole city is
 * not something a per-person parallel pass can compute.
 */

import { homeOf, type Person, type Point, type World } from "../../world/index.ts";
import { rosterFor } from "../work/index.ts";
import { escortStays } from "../school/index.ts";
import { drives, haversineKm, householdOf, modeOf } from "../../transport/index.ts";
import { HOURS, isOpen, spanOf, weightAt, type Purpose, type Venue, type Venues } from "../discretionary/index.ts";
import { LAYER, mix, Rng, stream, weekday } from "../../shared/index.ts";
import type { Affiliations } from "./affiliations.ts";
import type { Graph } from "./graph.ts";

/**
 * A meeting, as both parties independently computed it.
 *
 * `parties` is sorted, and is what makes two people's copies of this object
 * comparable: the id is derived from it, so the same gathering carries the
 * same string on every day it appears in.
 */
export interface Meeting {
  id: string;
  /** What they are there to do, which decides the venue and the length. */
  purpose: Purpose;
  venue: Venue;
  start: number;
  end: number;
  /** Sorted person ids. Two or more; see `GUESTS` for how many. */
  parties: readonly number[];
  /** Whether this came out of the tie graph or out of one address. */
  kind: "hosted" | "household";
  /**
   * Whoever convened it, and whose seed every field above was drawn from.
   *
   * Null for a household outing, which is convened by the address rather than
   * by a person. Everywhere else it is a party, and it is the one party the
   * gathering cannot survive losing — see `meetingsFor`.
   */
  host: number | null;
  /** Who drove whom, where anybody did. */
  ride: Ride | null;
  /**
   * The one person who paid for everybody, where somebody did.
   *
   * Null is not "nobody paid" — it is everybody paying for themselves, which
   * is the ordinary case among friends. A named payer is the other one, and it
   * is worth representing because of what it makes recoverable: a single card
   * transaction at a restaurant covering four people who were all there is a
   * relationship visible in a bank record and nowhere else, and reconstructing
   * it is exactly the sort of thing this data exists to be tested on.
   *
   * A household outing always has one, because a family does not go dutch.
   */
  payer: number | null;
}

/**
 * One car, and who was in it.
 *
 * The two directions are separate because they genuinely are: arriving
 * together and going home separately is ordinary, and `riderStays` in
 * `school.ts` learned the same lesson the expensive way — deriving the
 * afternoon from the morning priced every asymmetric day wrong.
 */
export interface Ride {
  driver: number;
  riders: readonly number[];
  /** Riders were collected on the way there. */
  outbound: boolean;
  /** Riders were dropped off on the way back. */
  inbound: boolean;
  /**
   * The doors the car stops at on the way there, in visiting order, with the
   * minutes it is at each. Empty when `outbound` is false. A rider waits at
   * their own door for exactly this stop and leaves at its `leave`; the
   * driver's day has the same stop. Riders who share a door share a stop,
   * which is how a household rider leaves from the driver's own door.
   */
  pickups: readonly RideStop[];
  /** The same on the way back. Empty when `inbound` is false. */
  dropoffs: readonly RideStop[];
}

/** One door on a lift's route. */
export interface RideStop {
  door: Point;
  /** Sorted ids of the riders who get in or out here. */
  riders: readonly number[];
  arrive: number;
  leave: number;
}

/** Who rides with whom, before the route and its minutes are settled. */
type Draft = Pick<Ride, "driver" | "riders" | "outbound" | "inbound">;

export interface MeetingInput {
  world: World;
  graph: Graph;
  venues: Venues;
  affiliations: Affiliations;
  date: Date;
  day: number;
}

// ---------------------------------------------------------------------------
// What a meeting is for, and when that happens
// ---------------------------------------------------------------------------

/**
 * The occasions people arrange, as a purpose and a length.
 *
 * The draw picks the occasion and the occasion carries its own time of day,
 * which keeps the venue and the minute consistent: a bar at eleven in the
 * morning is not a mistake in the clock, it is a mistake in the occasion. The
 * time of day is a curve and not a window — see `hours.ts` for why a window,
 * walked from its first minute, put every dinner in the city at 17:30.
 *
 * `weekend` weights each occasion differently on a Saturday, which is most of
 * where the shape of the week comes from. `minAge` keeps children out of bars
 * and, for the rest, is what stops a nine-year-old arranging their own dinner.
 */
interface Slot {
  purpose: Purpose;
  /** Typical length. Not drawn per meeting; the venue's closing time trims it. */
  minutes: number;
  weekday: number;
  weekend: number;
  minAge: number;
}

const SLOTS: readonly Slot[] = [
  { purpose: "cafe", minutes: 65, weekday: 1.0, weekend: 1.2, minAge: 11 },
  { purpose: "food-quick", minutes: 45, weekday: 1.0, weekend: 0.7, minAge: 11 },
  { purpose: "food-sit", minutes: 95, weekday: 0.9, weekend: 1.6, minAge: 11 },
  { purpose: "bar", minutes: 125, weekday: 0.5, weekend: 1.4, minAge: 21 },
  { purpose: "park", minutes: 75, weekday: 0.5, weekend: 1.1, minAge: 11 },
  { purpose: "retail", minutes: 70, weekday: 0.4, weekend: 0.9, minAge: 13 },
];

/**
 * A start for this occasion among the minutes `ok` accepts, in proportion to
 * how much the occasion wants each one.
 *
 * Every free candidate is weighed rather than the first being taken. Walking
 * the day from the top and stopping at the first free minute is what made a
 * window's opening minute the city's arrival time: nearly everybody is free
 * then. Candidates sit on a grid from a drawn offset, so two meetings drawn for
 * the same hour do not both land on it exactly.
 */
function startFor(slot: Slot, weekend: boolean, rng: Rng, ok: (at: number) => boolean): number | null {
  const profile = HOURS[slot.purpose]!;
  const [from, to] = spanOf(profile, weekend);
  const offset = rng.int(0, GRID - 1);
  const candidates: number[] = [];
  const weights: number[] = [];
  for (let at = from + offset; at <= to; at += GRID) {
    const weight = weightAt(profile, at, weekend);
    if (weight <= 0 || !ok(at)) continue;
    candidates.push(at);
    weights.push(weight);
  }
  return candidates.length ? rng.weighted(candidates, weights) : null;
}

/**
 * How much of a Saturday each weekday is worth, for arranging to see somebody.
 *
 * The single most visible fact about discretionary co-presence and the one a
 * flat rate gets most obviously wrong: a city whose friendships are evenly
 * spread across the week has no Friday night in it. Monday first, because that
 * is what `weekday` returns. Normalised to average exactly one across the
 * seven, so the weekly rate the graph published survives the reshaping.
 */
const DAY_SHAPE = [0.75, 0.7, 0.75, 0.85, 1.35, 1.6, 1.0];

/**
 * How much of an adult's meeting rate somebody of each age gets.
 *
 * Applied to both parties and multiplied, so a child and an adult meeting is
 * the product of two small numbers and effectively does not happen — which is
 * right, because that arrangement exists in life and is made by the parent as
 * a household outing rather than by the child as a friendship.
 *
 * Under eleven is zero rather than small. A nine-year-old does not arrange to
 * meet anybody at a venue across town; they are taken, and being taken is a
 * household outing or a school run, both of which are elsewhere.
 */
function ageFactor(age: number): number {
  if (age < 11) return 0;
  if (age < 15) return 0.4;
  if (age < 18) return 0.85;
  if (age < 70) return 1;
  // Not a judgement about sociability — the venues here are the ones this
  // city has, and a great deal of what people over seventy do together
  // happens in each other's houses, which this layer does not model at all.
  return 0.7;
}

/**
 * How long before and after a meeting has to be clear for it to be worth
 * arranging.
 *
 * A nominal travel allowance, not a routed one, and it must stay nominal: the
 * whole point is that both parties compute it without routing anything. The
 * planner does the real journey afterwards and is entitled to disagree, in
 * which case the person arrives late or the meeting is rejected — both of
 * which are recorded rather than hidden.
 */
const TRAVEL_PAD = 25;

/** Candidate starts are tried on this grid, which is how people name times. */
const GRID = 15;

/**
 * Below this many minutes the occasion is not worth the journey.
 *
 * It bites where a venue shuts shortly after the drawn start: twenty minutes
 * in a restaurant that is closing is not a shortened dinner, it is a dinner
 * that did not happen.
 */
const MINIMUM_STAY = 25;

// ---------------------------------------------------------------------------
// Who is busy, without planning anybody's day
// ---------------------------------------------------------------------------

/** A half-open span of the day that is already spoken for. */
type Span = [number, number];

/**
 * The commitments somebody has today that a meeting must not be arranged over,
 * computed from static assignment and the date alone.
 *
 * Fixed roster blocks and school only. Not sleep, which is a window the
 * planner compresses rather than a commitment; not discretionary stops, which
 * are `optional` and yield of their own accord; and not — by default — the
 * org calendar, which is the interesting case and is handled by the caller.
 */
function commitments(world: World, person: Person, date: Date, day: number): Span[] {
  const spans: Span[] = [];
  for (const block of rosterFor(world, person, date, day)) {
    if (block.fixed) spans.push([block.start, block.end]);
  }
  return spans;
}

/**
 * The org occurrences somebody could be at today.
 *
 * Every occurrence their memberships generate, not the ones they will attend —
 * attendance is drawn in `affiliations.ts` against a `free` predicate that
 * this layer is about to become an input to, so asking for it here would be
 * circular. Treating a possible service as a commitment costs a few meetings
 * that would have been fine; the alternative costs a defined evaluation order,
 * which is worth more.
 *
 * `keepSoft` is how an evening is allowed to cost a membership night. False
 * drops the classes in DISPLACEABLE from the answer, so the arrangement can be
 * made straight over them; see DISPLACES_CALENDAR for why it is per class and
 * why the rate is what it is.
 */
function calendar(
  affiliations: Affiliations,
  person: Person,
  date: Date,
  day: number,
  keepSoft = true,
): Span[] {
  const spans: Span[] = [];
  for (const row of affiliations.of(person.id)) {
    if (row.class === "work" || row.class === "school") continue;
    // Per membership, not per person. Somebody who belongs to a congregation
    // and a gym can skip the gym for a friend without the congregation
    // protecting the gym, which is what a whole-person test would do.
    if (!keepSoft && DISPLACEABLE.has(row.class)) continue;
    for (const occurrence of affiliations.occurrencesOn(row.org, date, day)) {
      spans.push([occurrence.start - 20, occurrence.end + 20]);
    }
    for (const occurrence of affiliations.unitOccurrencesOn(row.org, row.unit, date, day)) {
      spans.push([occurrence.start - 20, occurrence.end + 20]);
    }
  }
  return spans;
}

/**
 * How often a meeting is arranged straight over a membership night anyway.
 *
 * Because people do. Skipping the lodge to see a friend is ordinary behaviour
 * and a model in which the calendar always wins produces a city where nobody
 * ever chooses.
 *
 * The rate is low, and low for a reason that is about this simulation rather
 * than about people: `affiliations.ts` carries a fitted LIFT that puts
 * realised co-attendance back on the exposure targets `ties.py` published, and
 * the check already reports worship, civic and union below target with
 * attendance pinned near one. Any new suppressor makes those worse and two of
 * them have no headroom left to absorb it. So the classes that are already
 * failing are never displaced, and the rest are displaced rarely; raising this
 * is a decision to refit LIFT, not a free parameter.
 */
const DISPLACES_CALENDAR = 0.12;

/** The classes with room to lose an attendance. See `DISPLACES_CALENDAR`. */
const DISPLACEABLE = new Set(["gym", "fraternal", "youth", "sports"]);

function busy(spans: readonly Span[], from: number, to: number): boolean {
  for (const [a, b] of spans) if (from < b && a < to) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/**
 * Every meeting this person was drawn into today, before collisions are
 * resolved.
 *
 * Computable for anybody by anybody, which is the property the whole design
 * rests on: the inputs are the tie graph, the population and the date, and
 * none of them is a planned day. `meetingsFor` calls this for the person whose
 * day is being planned and again for each of their counterparts.
 */
function candidates(input: MeetingInput, person: Person): Meeting[] {
  const out: Meeting[] = [];
  const outing = householdOuting(input, person);
  if (outing) out.push(outing);

  if (ageFactor(person.age) > 0) {
    const own = convened(input, person);
    if (own) out.push(own);

    // A contact reached by two ties is one contact, and asking them twice
    // would put the same gathering in the list twice.
    const asked = new Set<number>();
    const [start, end] = input.graph.range(person.id);
    for (let i = start; i < end; i += 1) {
      const contact = input.graph.contacts[i]!;
      if (contact.social <= 0) continue;
      if (input.graph.external(contact.other)) continue;
      const other = input.world.persons.get(contact.other);
      if (!other) continue;
      // Co-residents meet at home and go out as a household. Drawing them here
      // as well would give a couple both, and would count the same evening
      // twice in every co-presence figure this layer exists to produce.
      if (other.household === person.household) continue;
      // The whole question, asked once per contact: did you convene today, and
      // am I on the list. Answered off the cheap half of the draw, so the
      // venue and the clock are only computed for the invitations that name
      // this person — see `guestList`.
      if (asked.has(other.id)) continue;
      asked.add(other.id);
      const list = guestList(input, other);
      if (!list || !list.guests.some((guest) => guest.id === person.id)) continue;
      const meeting = assemble(input, list);
      if (meeting) out.push(meeting);
    }
  }

  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * How many people a convener invites, as the distribution over guest counts
 * one, two, three and four.
 *
 * A guest list of one is a pair having coffee and is most of what happens; the
 * tail is the table of four in a restaurant. Four is the ceiling because past
 * it the arrangement stops being made person to person — six friends in a pub
 * is organised in a group chat, and a group chat is a thing `comms/` has and
 * this layer does not read.
 *
 * The mean matters more than the shape, because the convening rate is divided
 * by it; see `HOST_SCALE`.
 */
const GUESTS = [0.62, 0.22, 0.1, 0.06];

/** Guests per gathering on average, which comes to 1.6. */
const GUEST_MEAN = GUESTS.reduce((total, share, index) => total + share * (index + 1), 0);

/**
 * What the one-convener mechanism does to a person's meeting rate, and the
 * correction that takes it back out.
 *
 * `social` on an edge is what that pair should be worth per week, and under the
 * old pair draw each pair was drawn once, so a person's expected meetings came
 * to the sum of their edges. Under this one they are counted twice over: once
 * for the gatherings they convene themselves and once for the invitations that
 * arrive from everybody else. A convener invites at rate (sum of their edges)
 * divided by the mean guest count, so the two streams come to that sum times
 * one plus one over the mean — about one and two thirds of what the graph
 * published.
 *
 * Scaling the convening rate by this puts it back exactly, without touching
 * `SOCIAL_PEAK` in `graph.ts`. That constant states what a tie is worth and is
 * fitted against a time-use survey; this one states what the mechanism does to
 * it, and the two should not be conflated into one number.
 */
const HOST_SCALE = GUEST_MEAN / (GUEST_MEAN + 1);

/** Whom a convener could invite, and how heavily each of them weighs. */
interface GuestList {
  host: Person;
  guests: Person[];
  /** Left mid-draw, so `assemble` continues the convener's stream in order. */
  rng: Rng;
}

/**
 * The cheap half of the draw: did this person convene anything today, and who
 * did they ask.
 *
 * Everything here is a walk of the convener's own contact list, which is what
 * makes the whole design affordable — every one of a person's forty contacts
 * is asked this question every day, and none of the answers may cost a routed
 * journey or a planned day.
 */
function guestList(input: MeetingInput, host: Person): GuestList | null {
  const { world, date, day } = input;
  const mine = ageFactor(host.age);
  if (mine <= 0) return null;

  const cached = lists.get(host.id);
  if (cached !== undefined) return cached;
  const drawn = drawList(input, host, mine, date, day, world);
  lists.set(host.id, drawn);
  return drawn;
}

function drawList(
  input: MeetingInput,
  host: Person,
  mine: number,
  date: Date,
  day: number,
  world: World,
): GuestList | null {
  // Candidates and their weights. A guest's own age factor is folded in here
  // rather than applied afterwards, so that the product of the two people's
  // factors comes out the same as the pair draw produced.
  const people: Person[] = [];
  const weights: number[] = [];
  const at = new Map<number, number>();
  let total = 0;
  const [from, to] = input.graph.range(host.id);
  for (let i = from; i < to; i += 1) {
    const contact = input.graph.contacts[i]!;
    if (contact.social <= 0) continue;
    if (input.graph.external(contact.other)) continue;
    const other = input.world.persons.get(contact.other);
    if (!other || other.household === host.household) continue;
    const weight = contact.social * ageFactor(other.age);
    if (weight <= 0) continue;
    // Two people can hold more than one tie — a sibling who is also a
    // colleague. One entry in the pool or the same person could be invited
    // twice and turn up twice in the party.
    const seen = at.get(other.id);
    if (seen !== undefined) {
      weights[seen] = Math.max(weights[seen]!, weight);
      continue;
    }
    at.set(other.id, people.length);
    people.push(other);
    weights.push(weight);
  }
  for (const weight of weights) total += weight;
  if (total <= 0) return null;

  const shape = DAY_SHAPE[weekday(date)] ?? 1;
  const daily = ((total * HOST_SCALE) / GUEST_MEAN / 7) * mine * shape;
  const rng = stream(world.seed, host.id, LAYER.meet, day);
  if (!rng.bool(daily)) return null;

  // Sampled without replacement and weighted by the tie, so a convener asks
  // the people they are closest to and does not ask the same person twice.
  const pool = people.map((person, index) => ({ person, weight: weights[index]! }));
  const wanted = Math.min(rng.weighted([1, 2, 3, 4], GUESTS), pool.length);
  const guests: Person[] = [];
  for (let n = 0; n < wanted; n += 1) {
    const chosen = rng.weighted(pool, pool.map((one) => one.weight));
    guests.push(chosen.person);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return { host, guests, rng };
}

/**
 * The expensive half: when, where, whose car and who pays.
 *
 * Split from the guest list because it is only ever needed for the handful of
 * invitations that name the person whose day is being planned, and because it
 * reads every party's roster and org calendar — forty times that per person
 * per day would be the whole cost of the layer.
 */
function assemble(input: MeetingInput, list: GuestList): Meeting | null {
  const cached = assembled.get(list.host.id);
  if (cached !== undefined) return cached;
  const meeting = build(input, list);
  assembled.set(list.host.id, meeting);
  return meeting;
}

function build(input: MeetingInput, list: GuestList): Meeting | null {
  const { world, date, day } = input;
  const { host, guests, rng } = list;
  const people = [host, ...guests];

  const homes = new Map<number, Point>();
  for (const person of people) {
    const home = homeOf(world, person);
    if (!home) return null;
    homes.set(person.id, home);
  }
  // Somewhere between all of them, which for a guest list of one is the point
  // half way between two doors and for a table of four is their centre of mass.
  const middle = {
    lat: people.reduce((sum, one) => sum + homes.get(one.id)!.lat, 0) / people.length,
    lon: people.reduce((sum, one) => sum + homes.get(one.id)!.lon, 0) / people.length,
  };

  const spans: Span[] = [];
  for (const person of people) spans.push(...commitments(world, person, date, day));
  // A school run is fixed and has a child on the other end of it. A meeting
  // placed over it would win or lose in the planner, and either way one of the
  // two shared arrangements would be half kept.
  for (const person of people) spans.push(...escorting(world, person, date, day));
  // Whether tonight's arrangement is allowed to cost a membership night. Drawn
  // per gathering rather than per person, because it is a fact about this
  // evening, and tested against everybody — one person willing to skip the
  // lodge does not excuse another's shift at the fire hall.
  const overrides = rng.bool(DISPLACES_CALENDAR);
  for (const person of people) {
    spans.push(...calendar(input.affiliations, person, date, day, !overrides));
  }

  const age = Math.min(...people.map((one) => one.age));
  const placed = place(input, rng, middle, spans, age, date);
  if (!placed) return null;

  const parties = people.map((one) => one.id).sort((a, b) => a - b);
  return {
    id: `meet/${host.id}/${day}`,
    purpose: placed.purpose,
    venue: placed.venue,
    start: placed.start,
    end: placed.end,
    parties,
    kind: "hosted",
    host: host.id,
    ride: route(world, ride(input, rng, parties, placed.venue, homes), placed.venue, placed.start, placed.end),
    payer: rng.bool(TREATS) ? parties[rng.int(0, parties.length - 1)]! : null,
  };
}

/**
 * Whom this person would ask out on a future date, without settling anything
 * else about it.
 *
 * For the communications layer, which needs to know today that somebody is
 * arranging something for Thursday. Only the cheap half of the draw: no venue,
 * no clock, no car, because none of those exist yet on a date whose days have
 * not been planned — and because an arrangement is made before they are
 * settled in life too.
 *
 * Deliberately uncached. The caches below are for one date and this reaches
 * past it; sharing them would evict the day's own draws on every call.
 *
 * The gathering it describes may never happen. It has not been through
 * collision resolution and the venue may turn out to be shut, so an
 * arrangement can exist for an evening that no timeline ever holds. That is
 * not a defect to be filtered out — people arrange things that fall through,
 * and an invitation with no meeting after it is one of the more useful shapes
 * this data can contain.
 */
export function invitationFor(
  world: World,
  graph: Graph,
  person: Person,
  date: Date,
  day: number,
): { host: number; guests: number[] } | null {
  const mine = ageFactor(person.age);
  if (mine <= 0) return null;
  const input = { world, graph } as MeetingInput;
  const list = drawList(input, person, mine, date, day, world);
  if (!list) return null;
  return { host: list.host.id, guests: list.guests.map((guest) => guest.id) };
}

/**
 * Both halves of the draw for one convener, which is what a person runs on
 * themselves.
 */
function convened(input: MeetingInput, host: Person): Meeting | null {
  const list = guestList(input, host);
  return list ? assemble(input, list) : null;
}

// ---------------------------------------------------------------------------
// Remembering today's draws
// ---------------------------------------------------------------------------

/**
 * Every convener is asked about far more than once.
 *
 * A person's own day asks each of their forty contacts whether they convened;
 * so does every party whose attendance has to be confirmed, and popular people
 * are contacts of a great many others. The draw is a pure function of the seed,
 * the person and the day, so the second answer is the first one — caching it
 * changes nothing about the result and takes a factor of several off the run.
 *
 * Cleared whenever the day changes, which is the only thing it varies on. Both
 * maps are bounded by the population.
 */
const lists = new Map<number, GuestList | null>();
const assembled = new Map<number, Meeting | null>();
let cachedDay: number | null = null;

function forDay(day: number): void {
  if (cachedDay === day) return;
  lists.clear();
  assembled.clear();
  settled.clear();
  cachedDay = day;
}

/**
 * The whole address, out together.
 *
 * Keyed on the household rather than on any pair, which makes it the one group
 * larger than two this layer can produce: every member derives it from the
 * same id and the same day, so a family of five arrives in one car with no
 * coordination at all.
 *
 * Who goes is decided by the hour and not the other way round. The first
 * version took the members with nothing on all day and looked for an hour that
 * suited them, which kept every household with a shift worker or a school-age
 * child in it at home for the whole year — a parent who finished at three does
 * go out for dinner at seven. So a candidate hour is tried, whoever is free at
 * that hour is the party, and the first hour with two of them and an adult
 * among them wins.
 *
 * Deliberately narrow. It draws meals, parks, cafés and shopping trips and not
 * the weekly grocery run, because `tours.ts` already generates that per person
 * against measured trip rates and a household copy of it would be the same
 * journey counted twice.
 */
function householdOuting(input: MeetingInput, person: Person): Meeting | null {
  const { world, date, day } = input;
  const members = householdOf(world, person.household);
  if (members.length < 2) return null;

  const rng = new Rng(mix(world.seed, person.household, LAYER.meet, day, 1));
  const shape = DAY_SHAPE[weekday(date)] ?? 1;
  if (!rng.bool((HOUSEHOLD_WEEKLY / 7) * shape)) return null;

  const home = homeOf(world, person);
  if (!home) return null;

  // What kind of outing this household could have, decided from who lives here
  // and not from who turns out to be free. Deciding it the other way round is
  // circular — the slot fixes the hour, the hour fixes who can come, and who
  // can come would then fix the slot — and the composition of an address is
  // static, so this side of it can be settled before the clock is.
  const youngest = Math.min(...members.map((member) => member.age));
  const weekend = weekday(date) >= 5;
  const options = SLOTS.filter((slot) => slot.minAge <= Math.max(youngest, 11));
  if (options.length === 0) return null;
  const slot = rng.weighted(options, options.map((one) => (weekend ? one.weekend : one.weekday)));

  // Everybody's commitments, kept per member rather than pooled, because the
  // question at each candidate hour is *who* is free and not whether all of
  // them are. Pooling them was the first version and it kept every household
  // with a shift worker in it at home for the whole year.
  const engagements = new Map<number, Span[]>();
  for (const member of members) {
    engagements.set(member.id, [
      ...commitments(world, member, date, day),
      ...calendar(input.affiliations, member, date, day),
      ...escorting(world, member, date, day),
    ]);
  }

  const freeAt = (at: number) => members.filter((member) =>
    !busy(engagements.get(member.id) ?? [], at - TRAVEL_PAD, at + slot.minutes + TRAVEL_PAD));
  // Two people or it is not an outing, and one of them an adult or it is not
  // a household outing — it is two children who have let themselves out.
  const start = startFor(slot, weekend, rng, (at) => {
    const free = freeAt(at);
    return free.length >= 2 && free.some((member) => member.age >= ADULT);
  });
  if (start === null) return null;
  const going = freeAt(start).map((member) => member.id).sort((a, b) => a - b);
  if (!going.includes(person.id)) return null;

  const venue = input.venues.choose(home, slot.purpose, rng, start);
  if (!venue) return null;
  const end = Math.min(start + slot.minutes, venue.closes);
  if (end - start < MINIMUM_STAY) return null;
  if (!isOpen(venue, start)) return null;

  return {
    id: `outing/${person.household}/${day}`,
    purpose: slot.purpose,
    venue,
    start,
    end,
    parties: going,
    kind: "household",
    // An address convenes this, not a person. See `Meeting.host`.
    host: null,
    ride: route(world, householdRide(input, going, venue, home), venue, start, end),
    // The oldest adult present. Not a claim about who earns the most — it is
    // the one rule that gives the same answer to every member of the household
    // without any of them planning a day, which is the only kind of rule this
    // module is allowed to have.
    payer: payerFor(world, going),
  };
}

/** Old enough to take a household out, rather than to be taken. */
const ADULT = 18;

/**
 * How often one of a pair picks up the whole bill.
 *
 * Well under half, because the ordinary arrangement between adults who are not
 * related is that everybody pays for what they had. High enough that the
 * pattern is present in the record often enough to be found.
 */
const TREATS = 0.3;

/** The oldest adult going, or the oldest person going if none of them is. */
function payerFor(world: World, going: readonly number[]): number | null {
  const people = going
    .map((id) => world.persons.get(id))
    .filter((person): person is Person => !!person)
    .sort((a, b) => b.age - a.age || a.id - b.id);
  const adult = people.find((person) => person.age >= 18);
  return (adult ?? people[0])?.id ?? null;
}

/**
 * Outings per household per week.
 *
 * Below the pair rate per person and it should be: an outing needs everybody
 * free at once, and the larger the household the rarer that is. The number is
 * a meal out or a Saturday afternoon somewhere roughly every ten days, which
 * is what the eating-out share of ATUS supports once the weekly shop — already
 * generated per person by `tours.ts` — is excluded from it.
 */
const HOUSEHOLD_WEEKLY = 0.7;

// ---------------------------------------------------------------------------
// Where and when
// ---------------------------------------------------------------------------

interface Placed {
  purpose: Purpose;
  venue: Venue;
  start: number;
  end: number;
}

/**
 * Pick the occasion, find a minute both parties are free, and choose a venue.
 *
 * The occasion is drawn first and the clock follows from it, rather than the
 * other way round — see `Slot`. Where the drawn occasion has no free minute
 * the whole meeting fails rather than sliding to a different one: somebody who
 * cannot make dinner does not go for a drink at eleven instead, they do not go.
 */
function place(
  input: MeetingInput,
  rng: Rng,
  from: Point,
  spans: readonly Span[],
  age: number,
  date: Date,
): Placed | null {
  const weekend = weekday(date) >= 5;
  const options = SLOTS.filter((slot) => age >= slot.minAge);
  if (options.length === 0) return null;
  const slot = rng.weighted(options, options.map((s) => (weekend ? s.weekend : s.weekday)));

  const start = startFor(slot, weekend, rng,
    (at) => !busy(spans, at - TRAVEL_PAD, at + slot.minutes + TRAVEL_PAD));
  if (start === null) return null;

  const venue = input.venues.choose(from, slot.purpose, rng, start);
  if (!venue) return null;
  // A venue that shuts before the occasion is over shortens it rather than
  // cancelling it: last orders is a real reason an evening ends.
  const end = Math.min(start + slot.minutes, venue.closes);
  if (end - start < MINIMUM_STAY) return null;
  if (!isOpen(venue, start)) return null;

  return { purpose: slot.purpose, venue, start, end };
}

// ---------------------------------------------------------------------------
// Whose car
// ---------------------------------------------------------------------------

/**
 * How much of a detour somebody will make to collect a friend, in kilometres,
 * as the scale of an exponential.
 *
 * Not a limit. A detour of this length halves the chance of the lift, and one
 * of three times it all but ends it, which is the shape the decision actually
 * has: nobody has a threshold in miles, they have a sense of whether it is on
 * the way.
 */
const DETOUR_SCALE = 3.0;

/** How often a pair who could share a car do, before the detour is counted. */
const SHARE_BASE = 0.55;

/**
 * The same, when the passenger has no car of their own.
 *
 * Much higher, and the most consequential number in this file for anybody
 * reading the output: the lift is how a carless person gets to a restaurant
 * across town, and the alternative in this simulation is a cab they mostly
 * cannot afford or a walk they mostly do not make. A model that made this the
 * same as the two-car case would leave the carless fifteen percent of
 * households out of the city's social life entirely.
 */
const SHARE_CARLESS = 0.85;

/**
 * How the way home differs from the way there.
 *
 * Above one because arriving together is most of the way to leaving together:
 * the car is outside and the evening is over at the same time for both. Not
 * one, because it is not certain — people leave separately, and a rider who
 * was driven in has to get home some other way, which is a trip this layer
 * hands to the planner and does not price itself.
 */
const RETURN_LIFT = 1.3;

/**
 * Below this distance from a rider's door, nobody is given a lift, in km.
 *
 * Not a statement about how far people will walk — `travel.ts` owns that — but
 * a guard against a contradiction this layer can otherwise write into the day.
 * A lift is expressed as a `passenger` leg on the rider and an ordinary leg on
 * the driver, and the driver's mode is chosen by the mobility layer, which
 * walks a short trip. The result is a passenger in a car nobody drove. Above
 * the threshold the driver is driving, both halves agree, and the pickup minute
 * estimated at car speed is estimated against a car.
 */
const LIFT_MIN_KM = 1.5;

/**
 * Could this person be the one driving tonight?
 *
 * Two conditions, and the second is easy to forget. `drives` answers whether
 * they *may* — a licence, a car at the address — and `modeOf` answers whether
 * they *do*: the mobility layer routes somebody whose surveyed mode is the bus
 * as a bus passenger, and somebody who walks to work as a walker, whatever is
 * parked outside.
 *
 * Without the second test the layer writes a contradiction into two days at
 * once. The lift is expressed as a `passenger` leg on the rider, which
 * `travel.ts` prices over the road graph as a car; the driver's own leg is
 * priced by their usual mode, as a fifty-minute walk. One journey, two
 * durations, and a passenger who reaches the restaurant three quarters of an
 * hour before the person who drove them.
 */
function atTheWheel(world: World, person: Person): boolean {
  if (!drives(world, person)) return false;
  const mode = modeOf(person);
  return mode === "car" || mode === "carpool";
}

/**
 * How often a lift that happened at all happened on the way there.
 *
 * Nearly always, and the remainder is the person who made their own way and
 * was driven home. Under the pair draw this fell out of two nested draws on
 * the same share; with a party of any size the share differs per passenger, so
 * the two questions are separated — who is in the car at all, then which way
 * the car went — and this is the second one written down.
 */
const OUTBOUND_GIVEN_LIFT = 0.94;

/**
 * Who drove, and who was in the car.
 *
 * Every draw is taken in party id order off the convener's stream, so each
 * party replays the same sequence and reaches the same car. The driver is
 * elected rather than drawn — smallest total detour, ties to the lower id —
 * for the same reason: an election is a total order and needs no randomness to
 * be agreed on.
 */
function ride(
  input: MeetingInput,
  rng: Rng,
  parties: readonly number[],
  venue: Venue,
  homes: ReadonlyMap<number, Point>,
): Draft | null {
  const { world } = input;
  const people = parties
    .map((id) => world.persons.get(id))
    .filter((person): person is Person => !!person)
    .sort((a, b) => a.id - b.id);
  const eligible = people.filter((person) => atTheWheel(world, person));
  if (eligible.length === 0) return null;

  const detourOf = (driver: Person, rider: Person): number => {
    const mine = homes.get(driver.id);
    const theirs = homes.get(rider.id);
    if (!mine || !theirs) return Infinity;
    return haversineKm(mine, theirs) + haversineKm(theirs, venue) - haversineKm(mine, venue);
  };
  // What it would cost each candidate to collect everybody. Not what they will
  // actually collect — that is drawn below and would be circular here.
  const cost = (driver: Person): number =>
    people.reduce(
      (total, one) => (one.id === driver.id ? total : total + Math.min(detourOf(driver, one), 50)),
      0,
    );
  const driver = eligible.slice().sort((a, b) => cost(a) - cost(b) || a.id - b.id)[0]!;

  const riders: number[] = [];
  let best = 0;
  for (const person of people) {
    if (person.id === driver.id) continue;
    const home = homes.get(person.id);
    if (!home || haversineKm(home, venue) < LIFT_MIN_KM) continue;
    const detour = detourOf(driver, person);
    if (!Number.isFinite(detour)) continue;
    const base = drives(world, person) ? SHARE_BASE : SHARE_CARLESS;
    const share = base * Math.exp(-detour / DETOUR_SCALE);
    if (!rng.bool(share)) continue;
    riders.push(person.id);
    best = Math.max(best, share);
  }
  if (riders.length === 0) return null;

  const outbound = rng.bool(OUTBOUND_GIVEN_LIFT);
  const inbound = outbound ? rng.bool(Math.min(0.95, best * RETURN_LIFT)) : true;
  return { driver: driver.id, riders, outbound, inbound };
}

/**
 * The household's own car, which needs no draw at all.
 *
 * A family going out goes out together — that is what the outing is — so the
 * only question is whether anybody at the address can drive. Where nobody can,
 * everyone travels as they otherwise would and the planner decides what that
 * means, which for a carless household is a walk or a fare.
 */
function householdRide(input: MeetingInput, going: readonly number[], venue: Venue, home: Point): Draft | null {
  const { world } = input;
  // Close enough to walk to is close enough to walk to together, and the whole
  // household then arrives on foot rather than one of them driving four
  // passengers four hundred metres. See LIFT_MIN_KM.
  if (haversineKm(home, venue) < LIFT_MIN_KM) return null;
  const drivers = going
    .map((id) => world.persons.get(id))
    .filter((person): person is Person => !!person && atTheWheel(world, person))
    .sort((a, b) => b.age - a.age || a.id - b.id);
  const driver = drivers[0];
  if (!driver) return null;
  const riders = going.filter((id) => id !== driver.id);
  if (riders.length === 0) return null;
  return { driver: driver.id, riders, outbound: true, inbound: true };
}

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

/**
 * The meetings this person actually attends today.
 *
 * Two passes. The first resolves this person's own collisions — nobody is in
 * two places — and the second checks that every surviving pair meeting also
 * survived on the other side, because a meeting one party has dropped is not a
 * meeting. Both passes are pure functions of the same inputs from either end,
 * which is what makes the two answers agree.
 */
export function meetingsFor(input: MeetingInput, person: Person): Meeting[] {
  // Term-time only for a school run, and calendar-only for everything else,
  // are already handled by `commitments`; what this guards is the date arriving
  // as something the roster cannot answer for.
  if (!Number.isFinite(input.day)) return [];
  forDay(input.day);

  const mine = keep(candidates(input, person));
  const home = homeOf(input.world, person);
  const out: Meeting[] = [];
  for (const meeting of mine) {
    // Self is not re-asked: this meeting came out of `mine`, which is exactly
    // the answer `attends` would recompute.
    const attending = meeting.parties.filter((id) => id === person.id || attends(input, id, meeting.id));
    if (attending.length < 2) continue;
    // The convener is the one party it cannot be held without. Not a rule about
    // manners — the venue, the hour and the car were all drawn from their seed,
    // and a gathering that outlived them would be an arrangement nobody made.
    if (meeting.host !== null && !attending.includes(meeting.host)) continue;
    if (attending.length === meeting.parties.length) {
      out.push({ ...meeting, ride: settle(input, meeting, meeting.ride) });
      continue;
    }
    // Somebody had something better on. What is left is the same gathering with
    // a shorter guest list, and it needs a party, a car and a bill that every
    // remaining party computes the same way — so all three are functions of who
    // turned up and none of them is re-drawn. A guest who dropped out is simply
    // struck from the car; a driver who dropped takes the car with them.
    const shrunk = meeting.kind === "household"
      ? householdRide(input, attending, meeting.venue, home ?? meeting.venue)
      : trim(meeting.ride, attending);
    out.push({
      ...meeting,
      parties: attending,
      ride: settle(input, meeting, shrunk),
      payer: meeting.kind === "household"
        ? payerFor(input.world, attending)
        : meeting.payer !== null && attending.includes(meeting.payer) ? meeting.payer : null,
    });
  }
  return out;
}

/** The same car minus whoever is not coming, or none if the driver is not. */
function trim(ride: Ride | null, attending: readonly number[]): Draft | null {
  if (!ride) return null;
  if (!attending.includes(ride.driver)) return null;
  const riders = ride.riders.filter((rider) => attending.includes(rider));
  if (riders.length === 0) return null;
  return { driver: ride.driver, riders, outbound: ride.outbound, inbound: ride.inbound };
}

// ---------------------------------------------------------------------------
// The route of a lift, and whether every party can keep it
// ---------------------------------------------------------------------------

/**
 * Assumed speed for a lift, in km/h, which nothing routes.
 *
 * Every party has to compute the same pickup minute without planning a day,
 * so the route is priced on a straight-line estimate and the planner, which
 * does route, is entitled to disagree. Deliberately pessimistic, with six
 * minutes on top for the door and the parking: erring slow means the car
 * reaches the venue early, which is what happens.
 */
const PICKUP_SPEED = 25;

/** Minutes at the kerb, engine running, while somebody gets in or out. */
const PICKUP_DWELL = 2;

/**
 * The longest a lift may add to either end of a meeting, in minutes.
 *
 * A rider whose stop would push the first pickup earlier than this before the
 * start, or the last drop-off later than this after the end, makes their own
 * way. It bounds how far a ride reaches past the meeting, which is what the
 * check against a party's other meetings relies on.
 */
const RIDE_REACH = 75;

/** Margin kept around a school run, for the drive to and from the gate. */
const ESCORT_PAD = 15;

function liftMinutes(from: Point, to: Point): number {
  return Math.round((haversineKm(from, to) * 1.35 * 60) / PICKUP_SPEED) + 6;
}

/**
 * The doors a lift stops at, and when.
 *
 * Riders are grouped by door, and the doors visited nearest-neighbour from the
 * driver's own, ties to the lower rider id. The way there is timed backwards
 * from the start, so the last door is left in time to reach the venue and each
 * earlier door in time to reach the next. The way back visits the same doors
 * in reverse, timed forwards from the end. Every party computes this from the
 * same inputs, so two riders never get one pickup minute at two doors.
 */
function route(world: World, draft: Draft | null, venue: Point, start: number, end: number): Ride | null {
  if (!draft) return null;
  const driver = world.persons.get(draft.driver);
  const origin = driver ? homeOf(world, driver) : null;
  if (!origin) return null;

  const doors: { door: Point; riders: number[] }[] = [];
  for (const id of [...draft.riders].sort((a, b) => a - b)) {
    const rider = world.persons.get(id);
    const door = rider ? homeOf(world, rider) : null;
    // A rider with no door has nowhere to be collected from and makes their
    // own way.
    if (!door) continue;
    const shared = doors.find((one) => one.door.lat === door.lat && one.door.lon === door.lon);
    if (shared) shared.riders.push(id);
    else doors.push({ door: { lat: door.lat, lon: door.lon }, riders: [id] });
  }
  if (doors.length === 0) return null;

  const order: typeof doors = [];
  let here: Point = origin;
  const left = [...doors];
  while (left.length > 0) {
    let pick = 0;
    for (let i = 1; i < left.length; i += 1) {
      if (haversineKm(here, left[i]!.door) < haversineKm(here, left[pick]!.door)) pick = i;
    }
    const next = left.splice(pick, 1)[0]!;
    order.push(next);
    here = next.door;
  }

  const pickups: RideStop[] = [];
  if (draft.outbound) {
    let leave = start - liftMinutes(order[order.length - 1]!.door, venue);
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const arrive = leave - PICKUP_DWELL;
      pickups.unshift({ door: order[i]!.door, riders: order[i]!.riders, arrive, leave });
      if (i > 0) leave = arrive - liftMinutes(order[i - 1]!.door, order[i]!.door);
    }
  }
  const dropoffs: RideStop[] = [];
  if (draft.inbound) {
    let from: Point = venue;
    let at = end;
    for (const stop of [...order].reverse()) {
      const arrive = at + liftMinutes(from, stop.door);
      dropoffs.push({ door: stop.door, riders: stop.riders, arrive, leave: arrive + PICKUP_DWELL });
      at = arrive + PICKUP_DWELL;
      from = stop.door;
    }
  }

  return {
    driver: draft.driver,
    riders: order.flatMap((stop) => stop.riders).sort((a, b) => a - b),
    outbound: draft.outbound,
    inbound: draft.inbound,
    pickups,
    dropoffs,
  };
}

/**
 * The minutes a lift takes from one party's day beyond the meeting itself.
 *
 * The driver's span runs from the first pickup to the start and from the end
 * to the last drop-off. A rider's runs from their own pickup to the start and
 * from the end to their own drop-off. Empty for somebody not in the car.
 */
export function rideSpans(meeting: Meeting, person: number): [number, number][] {
  const ride = meeting.ride;
  if (!ride) return [];
  const spans: [number, number][] = [];
  if (ride.driver === person) {
    if (ride.pickups.length > 0) spans.push([ride.pickups[0]!.arrive, meeting.start]);
    if (ride.dropoffs.length > 0) spans.push([meeting.end, ride.dropoffs[ride.dropoffs.length - 1]!.leave]);
    return spans;
  }
  const pickup = ride.pickups.find((stop) => stop.riders.includes(person));
  if (pickup) spans.push([pickup.arrive, meeting.start]);
  const dropoff = ride.dropoffs.find((stop) => stop.riders.includes(person));
  if (dropoff) spans.push([meeting.end, dropoff.leave]);
  return spans;
}

/** The school runs this person makes today, padded for the drive. */
function escorting(world: World, person: Person, date: Date, day: number): Span[] {
  return escortStays(world, person, date, day)
    .map((stay) => [stay.arrive - ESCORT_PAD, stay.leave + ESCORT_PAD] as Span);
}

/** Yesterday's fixed blocks that run past midnight, in today's minutes. */
function overhang(world: World, person: Person, date: Date, day: number): Span[] {
  const yesterday = new Date(date);
  yesterday.setDate(date.getDate() - 1);
  const spans: Span[] = [];
  for (const block of rosterFor(world, person, yesterday, day - 1)) {
    if (!block.fixed || block.end <= 1440) continue;
    spans.push([block.start - 1440, block.end - 1440]);
  }
  return spans;
}

/**
 * What a party's lift must not overlap, computable by any other party.
 *
 * Fixed roster blocks today and the tail of yesterday's, school runs, and the
 * party's other meetings today with the reach of their own lifts. The other
 * meetings are the party's whole candidate set after its own collisions, which
 * is a superset of what it attends and is the same set every party builds.
 */
function rideBusy(input: MeetingInput, person: Person, meeting: string): Span[] {
  const { world, date, day } = input;
  const spans: Span[] = [
    ...commitments(world, person, date, day),
    ...overhang(world, person, date, day),
    ...escorting(world, person, date, day),
  ];
  for (const other of keep(candidates(input, person))) {
    if (other.id === meeting) continue;
    const inCar = other.ride !== null
      && (other.ride.driver === person.id || other.ride.riders.includes(person.id));
    const reach = inCar ? RIDE_REACH : 0;
    spans.push([other.start - TRAVEL_PAD - reach, other.end + TRAVEL_PAD + reach]);
  }
  return spans;
}

/** Settled rides for today, keyed by meeting and the riders offered. */
const settled = new Map<string, Ride | null>();

/**
 * The lift every party can actually keep.
 *
 * Without this one party's planner could reject its half of the lift — a
 * pickup over a shift, a drop-off over a school run — while the others kept
 * theirs, and a rider would ride as a passenger of a driver who never came.
 * The check uses only what every party can compute: rosters, school runs and
 * the meeting draws. Riders are offered to the car in id order and each is
 * kept only if the route with them in it fits the driver and every rider
 * already kept; a driver who cannot fit any rider means no lift.
 *
 * A rider who drives and is driven only one way would leave their car at the
 * venue or at work, so a lift home alone is offered only to riders without a
 * car. The way there alone is kept: the rider leaves from home and their car
 * stays there.
 */
function settle(input: MeetingInput, meeting: Meeting, draft: Draft | null): Ride | null {
  if (!draft) return null;
  const key = `${meeting.id}|${draft.driver}|${draft.riders.join(",")}|${draft.outbound}|${draft.inbound}`;
  const cached = settled.get(key);
  if (cached !== undefined) return cached;

  const { world } = input;
  const memo = new Map<number, Span[]>();
  const busyOf = (id: number): Span[] => {
    let spans = memo.get(id);
    if (!spans) {
      const person = world.persons.get(id);
      spans = person ? rideBusy(input, person, meeting.id) : [];
      memo.set(id, spans);
    }
    return spans;
  };
  const fits = (ride: Ride): boolean => {
    if (ride.pickups.length > 0 && ride.pickups[0]!.arrive < meeting.start - RIDE_REACH) return false;
    if (ride.dropoffs.length > 0 && ride.dropoffs[ride.dropoffs.length - 1]!.leave > meeting.end + RIDE_REACH) {
      return false;
    }
    const routed = { ...meeting, ride };
    for (const id of [ride.driver, ...ride.riders]) {
      const spans = busyOf(id);
      for (const [from, to] of rideSpans(routed, id)) if (busySpan(spans, from, to)) return false;
    }
    return true;
  };

  const offered = [...draft.riders].sort((a, b) => a - b).filter((id) => {
    if (draft.outbound) return true;
    const rider = world.persons.get(id);
    return rider !== undefined && !drives(world, rider);
  });
  const kept: number[] = [];
  let result: Ride | null = null;
  for (const id of offered) {
    const trial = route(world, { ...draft, riders: [...kept, id] }, meeting.venue, meeting.start, meeting.end);
    if (!trial || !trial.riders.includes(id) || !fits(trial)) continue;
    kept.push(id);
    result = trial;
  }
  settled.set(key, result);
  return result;
}

/** `busy` for one span against a list, with the span itself allowed to be empty. */
function busySpan(spans: readonly Span[], from: number, to: number): boolean {
  if (to <= from) return false;
  return busy(spans, from, to);
}

/**
 * Does this person, on their own reckoning, turn up to this meeting?
 *
 * The question every party has to be able to ask about every other party, and
 * the reason `candidates` takes a person rather than reading one. It is one
 * level deep: their candidate set is built, their collisions resolved, and
 * whether *their* counterparts turn up is not pursued. A fixpoint over the
 * city's whole evening is not something a per-person parallel pass can
 * compute, and the cost of stopping here is a meeting that quietly does not
 * happen rather than one that half happens.
 */
function attends(input: MeetingInput, person: number, meeting: string): boolean {
  const who = input.world.persons.get(person);
  if (!who) return false;
  return keep(candidates(input, who)).some((theirs) => theirs.id === meeting);
}

/**
 * Greedy, earliest first, on a set both parties can build identically.
 *
 * Greedy rather than optimal because "optimal" would need a preference between
 * two evenings and there is none to be had — and because whatever rule is used
 * has to be cheap enough to run twice per surviving meeting.
 */
function keep(sorted: readonly Meeting[]): Meeting[] {
  const out: Meeting[] = [];
  let until = -Infinity;
  for (const meeting of sorted) {
    if (meeting.start - TRAVEL_PAD < until) continue;
    out.push(meeting);
    until = meeting.end + TRAVEL_PAD;
  }
  return out;
}

/**
 * What one handset does on the network, minute by minute, for a whole day.
 *
 * The state is re-derived every simulated minute: where the person is, what is
 * between them and the antenna, which cells their operator runs there, which
 * of those their radio can use, and how strongly each is heard. What comes out
 * is not a minute-by-minute log — it is the spans between changes, plus the
 * changes themselves, which is what a network's own records consist of and
 * what the minute track collapses to without losing anything. A span and its
 * events reconstruct any minute of the day exactly.
 *
 * Why hysteresis is the whole design
 * ----------------------------------
 * The obvious implementation — every minute, attach to whichever cell is
 * strongest — produces a log that is wrong in a way that is instantly visible.
 * Two cells at a boundary are within a decibel of each other, the fading term
 * crosses that gap constantly, and a person asleep in their own bed generates
 * four hundred handovers a night. No real phone behaves like that, because no
 * real phone is allowed to: a candidate has to beat the serving cell by a
 * margin, and hold that margin for a period, before anything moves at all.
 * That is what 3GPP calls an A3 event with a time-to-trigger, and it is the
 * single mechanism standing between this file and nonsense.
 *
 * The margin is not one number, because the two regimes it governs are not one
 * problem. A connected phone is carrying a bearer and a late handover drops
 * it, so the network watches closely and moves quickly. An idle phone is
 * carrying nothing, and reselecting costs signalling to buy nothing, so the
 * rule is lazier and slower by design. The visible consequence is the right
 * one: a driver on the arterial hands over every minute or two, and a sleeper
 * holds one cell until morning.
 *
 * Idle and connected, and why the distinction is not cosmetic
 * ----------------------------------------------------------
 * A network does not know which cell an idle phone is camped on. It knows the
 * tracking area, because that is all the phone tells it — the whole point of
 * tracking areas is that a phone crossing between cells inside one says
 * nothing at all, and the network pages the entire area when it needs to find
 * it. Only a connected phone is followed cell by cell.
 *
 * So the two record streams this produces are genuinely different in kind. The
 * spans are ground truth: where the handset actually was. The events are what
 * the operator would hold, and they are sparser than the truth on purpose. A
 * consumer that treats every reselection as something an investigator could
 * have obtained is making a mistake, and the record has to be shaped so that
 * mistake is visible rather than invited.
 *
 * The periodic tracking-area update is the exception that makes idle phones
 * traceable at all, and it is real: T3412 defaults to 54 minutes, so a phone
 * that has said nothing for that long checks in from wherever it is. It is why
 * a switched-on phone in a drawer still leaves a trail, and why the trail is
 * hourly rather than continuous. The timer resets on any signalling, which is
 * why an active handset never emits one and a sleeping city emits little else.
 *
 * One serving cell, and what that leaves out
 * ------------------------------------------
 * A handset here is attached to exactly one cell at a time. A real 2026 phone
 * is not: it camps on one cell and aggregates others alongside it, which is
 * what EN-DC and carrier aggregation are, and it is how the capacity layer is
 * actually used. Nobody camps on C-band. They camp on the anchor and n77 is
 * added underneath when there is data to move.
 *
 * The visible consequence is that the C-band layer carries approximately none
 * of this city's attached minutes, and that is the model being consistent
 * rather than the model being broken — those hundred and fifty cells are
 * secondary carriers and this layer has no concept of one. It is worth stating
 * plainly because the number looks like a bug and is not, and because a
 * traffic layer built on top of this would need the concept before it could
 * say anything sensible about where the bytes went.
 *
 * What it does distort is location, and that is why the records now carry a
 * second cell. The serving cell of an idle phone is very often a low-band
 * sector whose footprint is three kilometres deep; the carrier that gets
 * added underneath when the phone connects is a mid or C-band sector with a
 * footprint a fraction of that, and it is usually the one the phone is
 * physically closest to. `secondary` on a span and on an event is that cell,
 * chosen the way the network chooses it — the strongest eligible cell of a
 * higher layer — and recorded only for the minutes the radio was connected,
 * because a secondary carrier does not exist while the phone is camped.
 *
 * Timing advance
 * --------------
 * Every span and every event also carries `ta`, the timing advance the
 * serving cell commanded. It is the network's own measure of how far the
 * handset is from the antenna, in 78 m steps along the path the signal took
 * (see `TA_UNIT_M` in cells.ts), and it is what turns "somewhere in this
 * sector" into a ring a few hundred metres wide. A span's value is the mean
 * over its minutes; an event's is the value at that minute, which is exactly
 * what the network measured when the handset spoke to it.
 *
 * Phones that are not on the network
 * ----------------------------------
 * A power-off overnight, a battery that dies on the way home, a phone left on
 * the kitchen table while its owner goes out. These are recorded as detach and
 * re-attach rather than smoothed over, because a gap that the data explains is
 * worth far more than a day where everybody is reachable at every minute — and
 * because a phone whose day contradicts its owner's is the case any tool that
 * reasons from cell data most needs to be tested against.
 */

import { LAYER, mix } from "../shared/index.ts";
import { INDOOR, OUTDOOR, RADIO_LAYERS, RSRP_CEILING, RSRP_FLOOR, VEHICLE, type Cells } from "./cells.ts";
import type { Subscriber } from "./subscribers.ts";
import { MINUTES, type Track } from "./track.ts";

/** Event kinds. Appended to, never reordered: the packed file stores indices. */
export const EVENT_KINDS = [
  "attach", "detach", "handover", "reselect", "tau", "connect", "release",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Why it happened, which is the field that makes a log readable. */
export const EVENT_CAUSES = [
  "power-on", "power-off", "battery", "coverage", "better-cell",
  "ta-change", "periodic", "session", "idle", "left-behind",
  /**
   * The attach at minute zero, which did not happen.
   *
   * The day is simulated from midnight, so every handset that was already on
   * the network at midnight — which is nearly all of them — opens its span
   * table with an attach. Recording those as `power-on` would put ninety-odd
   * thousand fictional switch-ons in the log at exactly 00:00, a spike no real
   * network has ever seen, and would drown the eight thousand real ones. This
   * cause names the boundary for what it is.
   */
  "day-start",
] as const;
export type EventCause = (typeof EVENT_CAUSES)[number];

const kindOf = (kind: EventKind) => EVENT_KINDS.indexOf(kind);
const causeOf = (cause: EventCause) => EVENT_CAUSES.indexOf(cause);

/** No serving cell: powered off, out of coverage, or nowhere to be. */
export const UNATTACHED = -1;

export interface CellSpan {
  subscriber: number;
  /** Index into `Cells.records`, or UNATTACHED. */
  cell: number;
  start: number;
  /** Exclusive, so `end - start` is the minutes held. */
  end: number;
  /** Mean RSRP over the span in dBm. NaN where there is no serving cell. */
  rsrp: number;
  /** The exposure held for most of the span: OUTDOOR, INDOOR or VEHICLE. */
  exposure: number;
  /** Minutes of the span the radio spent connected rather than camped. */
  connected: number;
  /** Mean timing advance over the span, in TA_UNIT_M steps. -1 with no serving cell. */
  ta: number;
  /**
   * The secondary cell held for most of the connected minutes, or UNATTACHED.
   * A carrier-aggregation or EN-DC leg: present only while connected.
   */
  secondary: number;
}

export interface NetEvent {
  subscriber: number;
  minute: number;
  kind: number;
  /** The cell the event is about, or UNATTACHED. */
  cell: number;
  /** The cell left behind, for a handover or reselection. */
  previous: number;
  cause: number;
  /** Timing advance the event's cell measured at this minute, or -1. */
  ta: number;
  /** The secondary cell at this minute, or UNATTACHED when idle. */
  secondary: number;
}

export interface DayNetwork {
  spans: CellSpan[];
  events: NetEvent[];
}

/** Everything the handset state machine needs on the next minute after midnight. */
export interface RadioState {
  subscriber: number;
  serving: number;
  servingArea: number;
  connected: boolean;
  pending: number;
  pendingSince: number;
  lastSignalling: number;
  attached: boolean;
}

// ---------------------------------------------------------------------------
// Constants, and where each comes from
// ---------------------------------------------------------------------------

/**
 * How much better a candidate must be, in dB, and for how many minutes.
 *
 * The connected figures are an A3 offset of 2.5 dB with the shortest
 * time-to-trigger this simulation can express, which is its one-minute
 * resolution — real time-to-trigger values run from 40 ms to a few hundred, so
 * a connected handover here is effectively immediate and that is the right
 * approximation. The idle figures are Qhyst plus Treselection, which really is
 * of the order of seconds to a minute or two, and lazier by exactly the
 * margin that stops a stationary phone from thrashing.
 */
const CONNECTED_OFFSET = 2.5;
const CONNECTED_TRIGGER = 1;
const IDLE_OFFSET = 4;
const IDLE_TRIGGER = 2;

/**
 * Frequency priority, and the level each layer has to reach to earn it.
 *
 * This is the correction to the most tempting wrong model in the file. Cell
 * reselection is not a contest between signal levels. A network broadcasts an
 * absolute priority per frequency and a handset camps on the highest-priority
 * layer it can hear *adequately* — not the loudest one — which is why a phone
 * standing in the open sits on 5G mid-band while a low-band cell from the same
 * mast is fifteen decibels stronger.
 *
 * It has to work that way, and the reason is capacity rather than coverage.
 * The anchor layer is 10 MHz of 700 MHz spectrum shared by everyone in three
 * square kilometres; the mid bands are 20 MHz each and n77 is a hundred.
 * Leaving every idle handset camped on the loudest cell would park the entire
 * city on the narrowest carrier it owns, which no operator would do and no
 * network could survive.
 *
 * Measured naively this model does exactly that. Before these thresholds went
 * in, 99% of the city's attached minutes were on anchor bands and the C-band
 * layer — a hundred and fifty cells of it — carried nothing at all, which is
 * not a network anyone has built.
 *
 * So the bonus is large and it is conditional. A layer above its threshold is
 * strongly preferred; below it the bonus vanishes and the handset falls back
 * down the ladder on signal strength alone. The thresholds rise with frequency
 * because a wider carrier needs a better signal to be worth using, and because
 * that is what stops a phone chasing C-band indoors where it cannot follow.
 */
interface Layer {
  bonus: number;
  /** dBm the measured level must reach before the bonus applies. */
  threshold: number;
}

const LAYER_TABLE: Record<string, Layer> = {
  "LTE anchor": { bonus: 0, threshold: -Infinity },
  "LTE mid": { bonus: 8, threshold: -102 },
  "LTE capacity": { bonus: 10, threshold: -98 },
  // Band 14 is FirstNet. An ordinary AT&T handset is allowed on it and is
  // pre-empted the moment a public-safety user wants the capacity, so the
  // network does not camp civilians there by choice.
  "LTE firstnet": { bonus: -8, threshold: -Infinity },
  "NR anchor": { bonus: 4, threshold: -108 },
  "NR mid": { bonus: 12, threshold: -100 },
  "NR capacity": { bonus: 14, threshold: -95 },
};

/** The same table, positional, so the hot loop indexes rather than hashes. */
const LAYER_BONUS: Layer[] = RADIO_LAYERS.map(
  (name) => LAYER_TABLE[name] ?? { bonus: 0, threshold: -Infinity },
);

/**
 * Which layers can be added under a connected handset as a secondary carrier.
 *
 * The mid and capacity layers, on either radio: they are the wide carriers
 * the network adds when there is data to move, and the anchor layers are
 * never added because the anchor is what the handset is already on. A layer
 * is eligible only above its own threshold — the same rule that decides
 * whether it can be camped on — so C-band is added in the street and not in
 * the back bedroom.
 */
const SECONDARY_LAYER: boolean[] = RADIO_LAYERS.map(
  (name) => name.endsWith(" mid") || name.endsWith(" capacity"),
);

/**
 * Shadow fading, in dB, as two terms with different jobs.
 *
 * The spatial term is keyed on the tile rather than on the clock, and that is
 * deliberate: shadowing is a property of what is standing between the handset
 * and the antenna, so it should change when the person moves and hold when
 * they do not. Keyed on time instead, a phone on a bedside table would be
 * handed a new radio environment every few minutes all night.
 *
 * The drift term is the small concession that the world is not perfectly
 * static — a door closes, a lorry parks, the cell next door picks up load. It
 * is what stops a stationary handset from freezing onto one cell until
 * morning, which is very nearly but not quite what real ones do. The size and
 * the block length are set by the rate it produces: at two decibels every half
 * hour a phone that never left the house reselected eleven times a day, which
 * is a little busier than a real one. These figures give about six, and the
 * gradient against people who actually travelled stays where it should be.
 */
const SHADOW_SIGMA = 6.5;
const DRIFT_SIGMA = 1.5;
/** Minutes a drift sample holds. Long enough that nothing flaps on it alone. */
const DRIFT_BLOCK = 45;

/**
 * How much better than the floor a cell has to be before an unattached
 * handset will camp on it. Pure hysteresis: it is subtracted again the moment
 * the phone is on the cell, so the pair of thresholds is -120 to acquire and
 * -122 to hold, and nothing sits on the knife edge of a single number.
 */
const ATTACH_MARGIN = 2;
const ATTACH_FLOOR = RSRP_FLOOR + ATTACH_MARGIN;

/** T3412. The 3GPP default periodic tracking-area update timer, in minutes. */
const PERIODIC_TAU = 54;

/**
 * The connected-state chain, as per-minute transition probabilities.
 *
 * A handset is connected when something is moving: a sync, a notification, a
 * map tile, somebody looking at it. That is bursty rather than continuous, so
 * two probabilities describe it — how often a bout starts, and how likely one
 * is to continue — and both depend on what the person is doing. Someone asleep
 * is not looking at anything, but their phone still wakes to talk to a server
 * every so often, which is why the sleeping rate is small and not zero.
 */
const WAKE_START = 0.055;
const TRAVEL_START = 0.08;
const SLEEP_START = 0.012;
/** Continuation probability; the mean bout is about four minutes. */
const STAY_CONNECTED = 0.75;

/** Day-level draws for a handset that is not on the network as usual. */
const POWER_OFF_NIGHT = 0.09;
const BATTERY_DIES = 0.05;
const LEFT_AT_HOME = 0.03;

/** A cheap gaussian: a table, indexed by hash. Box-Muller is too dear here. */
const FADE_TABLE = (() => {
  const table = new Float64Array(4096);
  for (let i = 0; i < table.length; i += 1) {
    // The inverse normal by summing uniforms is close enough in the body and
    // short in the tails, which for a shadow term is the harmless direction.
    const u = (i + 0.5) / table.length;
    const v = ((i * 2654435761) >>> 0) / 4294967296;
    table[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return table;
})();

const fade = (key: number) => FADE_TABLE[key & 4095]!;

/** A uniform in [0,1) from a hash, for the per-minute draws. */
const roll = (key: number) => (mix(key) >>> 8) / 16777216;

/**
 * When the handset is off the network today, drawn once per subscriber per day.
 *
 * Three independent things, because they happen to different people for
 * different reasons and at different times of day. A phone powered down for
 * the night is off from bedtime; a battery dies in the evening on the way
 * home; a phone left behind never leaves the house at all and its day is its
 * owner's day minus the owner.
 */
interface Availability {
  offFrom: number;
  offUntil: number;
  offCause: number;
  deadFrom: number;
  deadUntil: number;
  deadUntilMorning: number;
  leftBehind: boolean;
}

function availabilityDraw(seed: number, subscriber: Subscriber, day: number) {
  const key = mix(seed, subscriber.index, LAYER.handset, day);
  const powersOff = roll(key ^ 0x11) < POWER_OFF_NIGHT;
  const dies = roll(key ^ 0x22) < BATTERY_DIES;
  const behind = roll(key ^ 0x33) < LEFT_AT_HOME;
  const offFrom = powersOff ? 1290 + Math.floor(roll(key ^ 0x44) * 120) : Number.MAX_SAFE_INTEGER;
  const offUntil = powersOff ? 330 + Math.floor(roll(key ^ 0x55) * 180) : -1;
  const deadFrom = dies ? 990 + Math.floor(roll(key ^ 0x66) * 330) : Number.MAX_SAFE_INTEGER;
  const deadUntil = dies ? deadFrom + 45 + Math.floor(roll(key ^ 0x77) * 135) : -1;
  return { powersOff, behind, offFrom, offUntil, deadFrom, deadUntil };
}

/** Whether this handset's day drew "left at home": the owner goes out, the phone stays. */
export function leftBehindToday(seed: number, subscriber: Subscriber, day: number): boolean {
  return availabilityDraw(seed, subscriber, day).behind;
}

/** Whether the handset is switched on and has battery at `minute`. The one rule `attachDay` and `unpoweredMinutes` share. */
function poweredAt(available: Availability, minute: number): boolean {
  return !(minute >= available.offFrom || minute < available.offUntil) &&
    !(minute >= available.deadFrom && minute < available.deadUntil) &&
    !(minute < available.deadUntilMorning);
}

/**
 * The minutes this handset is powered off or has a dead battery today, as a
 * per-minute mask (1 = off). The same draws `attachDay` detaches on, so the
 * comms layer can stop the owner using the phone in exactly the minutes the
 * span table shows it unattached for that reason.
 */
export function unpoweredMinutes(seed: number, subscriber: Subscriber, day: number): Uint8Array {
  const available = availability(seed, subscriber, day);
  const off = new Uint8Array(MINUTES);
  for (let minute = 0; minute < MINUTES; minute += 1) if (!poweredAt(available, minute)) off[minute] = 1;
  return off;
}

/**
 * What a scenario says about one person's handsets for the day. `pinned`: a
 * hold places the phone, so the left-at-home draw is ignored. `alwaysOn`: the
 * phone stays on, charged and on the person, so no availability draw applies.
 */
export interface HandsetDirectives { pinned?: boolean; alwaysOn?: boolean }

const ALWAYS_ON = (available: Availability): Availability => ({
  ...available, offFrom: Number.MAX_SAFE_INTEGER, offUntil: -1, deadFrom: Number.MAX_SAFE_INTEGER, deadUntil: -1,
  deadUntilMorning: -1, leftBehind: false,
});

function availability(seed: number, subscriber: Subscriber, day: number): Availability {
  const today = availabilityDraw(seed, subscriber, day);
  const yesterday = availabilityDraw(seed, subscriber, day - 1);

  return {
    // The morning half belongs to last night's draw. Using today's draw for
    // both halves let a handset be on at 23:59 and independently off at 00:00.
    offFrom: today.offFrom,
    offUntil: yesterday.powersOff ? yesterday.offUntil : -1,
    offCause: causeOf("power-off"),
    deadFrom: today.deadFrom,
    deadUntil: today.deadUntil,
    deadUntilMorning: Math.max(-1, yesterday.deadUntil - MINUTES),
    leftBehind: today.behind,
  };
}

/**
 * One subscriber's day on the radio network.
 *
 * `track` is the person's minute-by-minute position. Where the handset was
 * left at home, the caller's `homeAt` is used for every minute instead, which
 * is the one case where the phone's day and the person's day are different
 * days.
 */
export function attachDay(
  cells: Cells,
  subscriber: Subscriber,
  track: Track,
  homeAt: { x: number; y: number } | null,
  seed: number,
  day: number,
  out: DayNetwork,
  opening: RadioState | null = null,
  sessions?: Uint8Array,
  handset: HandsetDirectives = {},
): RadioState {
  const drawn = availability(seed, subscriber, day);
  // A scenario that keeps a phone on its owner all day overrides every draw.
  const available = handset.alwaysOn ? ALWAYS_ON(drawn) : drawn;
  // A scenario that says where the phone lies is the authority; the day's own
  // left-at-home draw does not get to move it back to the house.
  const behind = !handset.pinned && available.leftBehind && homeAt !== null;

  if (!track.known && !behind) {
    // No position all day. Honest emptiness: one unattached span covering the
    // date, and no events, because nothing is known to have happened.
    out.spans.push({
      subscriber: subscriber.index, cell: UNATTACHED, start: 0, end: MINUTES,
      rsrp: Number.NaN, exposure: INDOOR, connected: 0, ta: -1, secondary: UNATTACHED,
    });
    return {
      subscriber: subscriber.index, serving: UNATTACHED, servingArea: -1,
      connected: false, pending: UNATTACHED, pendingSince: 0,
      lastSignalling: -PERIODIC_TAU, attached: false,
    };
  }

  const tier = subscriber.tier;
  // Shadowing belongs to the path, not to the handset: terrain, the building's
  // own walls, the trees in the way. Keyed on the subscriber it made a
  // coverage hole a property of *a person*, and two phones in one house on one
  // network disagreed by a dozen decibels about whether their home had signal.
  // So this key carries no subscriber, and every handset standing on the same
  // tile measures the same cell the same way. The drift below stays
  // per-subscriber, because what a door or a passing lorry does is local to
  // the handset that is near it.
  const shadowKey = mix(seed, LAYER.fading);
  const fadeKey = mix(seed, subscriber.index, LAYER.fading);
  const bearerKey = mix(seed, subscriber.index, LAYER.bearer, day);

  let serving = opening?.serving ?? UNATTACHED;
  let servingArea = opening?.servingArea ?? -1;
  let connected: boolean = opening?.connected ?? false;
  let pending = opening?.pending ?? UNATTACHED;
  let pendingSince = opening?.pendingSince ?? 0;
  let lastSignalling = opening?.lastSignalling ?? -PERIODIC_TAU;
  let attached = opening?.attached ?? false;

  let spanCell = attached ? serving : UNATTACHED;
  let spanStart = 0;
  let spanRsrp = 0;
  let spanSamples = 0;
  let spanConnected = 0;
  const spanExposure = [0, 0, 0];
  let spanTa = 0;
  /** Connected minutes per secondary cell this span, for the mode. Rarely more than two keys. */
  const spanSecondary = new Map<number, number>();

  // The memo that makes a per-minute evaluation affordable. Nothing is
  // approximated by it: the serving decision is a function of the tile, the
  // exposure, the drift block and the connected flag, so while all four hold
  // and no trigger is part-way through, re-running the arithmetic is
  // guaranteed to produce the answer it produced last minute. Most of the
  // city is asleep in one tile for eight hours, and this is why that costs
  // eight lookups rather than four hundred and eighty.
  let lastTile = -1;
  let lastExposure = -1;
  let lastDrift = -1;
  let lastConnected = false;

  // Two numbers per cell and they are not the same number. `score` is what the
  // reselection rule compares, and it carries the shadow term and the
  // network's frequency priorities. `level` is what the handset measured and
  // would report, and it carries the shadow but not the policy — a cell is not
  // physically louder because the operator would rather you camped on it. The
  // records get `level`; only the decision gets `score`.
  let bestCell = UNATTACHED;
  let bestScore = -Infinity;
  let bestLevel = Number.NaN;
  let servingScore = -Infinity;
  let servingLevel = Number.NaN;

  // Candidates for a secondary carrier, refilled with the scan. At most the
  // candidate list's length, and read once per connected minute.
  const secondaryPool: number[] = [];
  const secondaryLevel: number[] = [];
  const pickSecondary = (serving: number): number => {
    let best = UNATTACHED;
    let level = -Infinity;
    for (let i = 0; i < secondaryPool.length; i += 1) {
      if (secondaryPool[i] !== serving && secondaryLevel[i]! > level) {
        level = secondaryLevel[i]!;
        best = secondaryPool[i]!;
      }
    }
    return best;
  };

  // Where the handset is this minute, for the timing advance. The measure is
  // memoised on position and cell: a phone on a table all night costs one
  // square root, and a phone in a car costs one a minute, which is the same
  // count as the position samples it moved through.
  let atX = 0;
  let atY = 0;
  let taCell = UNATTACHED;
  let taX = Number.NaN;
  let taY = Number.NaN;
  let currentTa = -1;
  const taFor = (cell: number): number => {
    if (cell === UNATTACHED) return -1;
    if (cell === taCell && atX === taX && atY === taY) return currentTa;
    const tile = cells.tile(atX, atY);
    const ta = cells.timingAdvance(cell, atX, atY, roll(mix(shadowKey, cell, tile) ^ 0x7a));
    taCell = cell; taX = atX; taY = atY; currentTa = ta;
    return ta;
  };

  const closeSpan = (minute: number) => {
    if (minute <= spanStart) return;
    let exposure = OUTDOOR;
    if (spanExposure[1]! >= spanExposure[0]! && spanExposure[1]! >= spanExposure[2]!) exposure = INDOOR;
    else if (spanExposure[2]! > spanExposure[0]!) exposure = VEHICLE;
    let secondary = UNATTACHED;
    let held = 0;
    for (const [cell, minutes] of spanSecondary) {
      if (minutes > held) { held = minutes; secondary = cell; }
    }
    out.spans.push({
      subscriber: subscriber.index,
      cell: spanCell,
      start: spanStart,
      end: minute,
      rsrp: spanSamples > 0 ? spanRsrp / spanSamples : Number.NaN,
      exposure,
      connected: spanConnected,
      ta: spanCell !== UNATTACHED && spanSamples > 0 ? Math.round(spanTa / spanSamples) : -1,
      secondary,
    });
  };

  const openSpan = (minute: number, cell: number) => {
    spanCell = cell;
    spanStart = minute;
    spanRsrp = 0;
    spanSamples = 0;
    spanConnected = 0;
    spanExposure[0] = spanExposure[1] = spanExposure[2] = 0;
    spanTa = 0;
    spanSecondary.clear();
  };

  const emit = (minute: number, kind: EventKind, cell: number, previous: number, cause: EventCause) => {
    // The timing advance is measured on the cell the event names, at the
    // position the handset holds this minute; a detach names the cell being
    // left and reads its last value. A secondary is a property of a
    // connected radio, so an idle event carries none.
    out.events.push({
      subscriber: subscriber.index, minute, kind: kindOf(kind), cell, previous, cause: causeOf(cause),
      ta: taFor(cell),
      secondary: connected && cell !== UNATTACHED ? pickSecondary(cell) : UNATTACHED,
    });
    lastSignalling = minute;
  };

  for (let minute = 0; minute < MINUTES; minute += 1) {
    const powered = poweredAt(available, minute);

    if (!powered) {
      if (attached) {
        const cause: EventCause = minute < available.deadUntilMorning
          || minute >= available.deadFrom && minute < available.deadUntil
          ? "battery" : "power-off";
        emit(minute, "detach", serving, UNATTACHED, cause);
        if (connected) connected = false;
        closeSpan(minute);
        openSpan(minute, UNATTACHED);
        attached = false;
        serving = UNATTACHED;
        servingArea = -1;
        pending = UNATTACHED;
        lastTile = -1;
      }
      continue;
    }

    const x = behind ? homeAt!.x : track.x[minute]!;
    const y = behind ? homeAt!.y : track.y[minute]!;
    const exposure = behind ? INDOOR : track.exposure[minute]!;
    atX = x;
    atY = y;

    // The bearer chain first: whether the radio is connected changes which
    // margin applies, so it has to be settled before the serving decision.
    //
    // A phone left at home follows the sleeping rate all day. Nobody is
    // looking at it, and the background traffic of a handset on a worktop is
    // the same background traffic as a handset on a bedside table.
    const activity = behind || track.asleep[minute]
      ? SLEEP_START
      : exposure === OUTDOOR || exposure === VEHICLE
        ? TRAVEL_START
        : WAKE_START;
    const draw = roll(bearerKey ^ (minute * 0x9e37));
    const wasConnected: boolean = connected;
    connected = attached && ((!behind && sessions?.[minute] === 1)
      || (connected ? draw < STAY_CONNECTED : draw < activity));

    const tile = cells.tile(x, y);
      // Absolute blocks continue through midnight; resetting to block zero on
      // every date made the fading field jump even for a stationary handset.
      const drift = Math.floor((day * MINUTES + minute) / DRIFT_BLOCK);
    const stale =
      tile !== lastTile || exposure !== lastExposure || drift !== lastDrift ||
      connected !== lastConnected || pending !== UNATTACHED || !attached;

    if (stale) {
      bestCell = UNATTACHED;
      bestScore = -Infinity;
      bestLevel = Number.NaN;
      servingScore = -Infinity;
      servingLevel = Number.NaN;
      secondaryPool.length = 0;
      secondaryLevel.length = 0;

      const consider = (index: number, ranked: boolean) => {
        const measured = Math.min(RSRP_CEILING,
          cells.rsrp(index, x, y, exposure as 0 | 1 | 2) +
          fade(mix(shadowKey, index, tile)) * SHADOW_SIGMA +
          fade(mix(fadeKey, index, drift)) * DRIFT_SIGMA);
        const layer = LAYER_BONUS[cells.layerOf(index)]!;
        // Camping on a cell is easier than finding one, by ATTACH_MARGIN.
        // Without that, a handset whose best server sits *at* the floor — a
        // fringe house is the usual case — attached and detached on the drift
        // sample alone, and reported no service for half a day in
        // 45-minute blocks.
        const usable = measured >= (attached ? RSRP_FLOOR : ATTACH_FLOOR);
        const score = usable && measured >= layer.threshold ? measured + layer.bonus : measured;
        if (ranked && usable && measured >= layer.threshold && SECONDARY_LAYER[cells.layerOf(index)]) {
          secondaryPool.push(index);
          secondaryLevel.push(measured);
        }
        if (index === serving) {
          servingLevel = measured;
          servingScore = usable ? score : -Infinity;
        }
        if (ranked && usable && score > bestScore) {
          bestScore = score;
          bestLevel = measured;
          bestCell = index;
        }
      };

      const scan = (operator: number) => {
        const list = cells.candidates(tile, operator, tier);
        for (let i = 0; i < list.length; i += 1) consider(list[i]!, true);
      };

      // The home network first, always. Roaming is what happens when it has
      // nothing to offer at this point — not a cell-by-cell competition, which
      // is not how a roaming agreement works: a handset stays on its own PLMN
      // while it can hear one at all, however badly, and only goes looking for
      // a partner when it cannot.
      scan(subscriber.operator);
      if (bestCell === UNATTACHED && subscriber.roaming >= 0) scan(subscriber.roaming);

      // A handset always measures the cell it is on, whether or not that cell
      // is among the six its current tile ranks highest. Without this, walking
      // from one tile to the next reads as losing the serving cell every time
      // it falls to seventh — which is a fact about the size of the candidate
      // list and not about the radio, and it was producing seven spurious
      // coverage-loss reselections per subscriber per day.
      if (serving !== UNATTACHED && Number.isNaN(servingLevel)) consider(serving, false);

      lastTile = tile;
      lastExposure = exposure;
      lastDrift = drift;
      lastConnected = connected;
    }

    if (bestCell === UNATTACHED) {
      // Nothing audible. A real handset scans, fails, and reports no service.
      if (attached) {
        emit(minute, "detach", serving, UNATTACHED, "coverage");
        closeSpan(minute);
        openSpan(minute, UNATTACHED);
        attached = false;
        serving = UNATTACHED;
        servingArea = -1;
        connected = false;
      }
      pending = UNATTACHED;
      continue;
    }

    if (!attached) {
      serving = bestCell;
      servingScore = bestScore;
      servingLevel = bestLevel;
      attached = true;
      closeSpan(minute);
      openSpan(minute, serving);
      servingArea = cells.trackingAreaOf(serving);
      emit(minute, "attach", serving, UNATTACHED,
        minute === 0 && !opening ? "day-start" : behind ? "left-behind" : "power-on");
      // The opening attach is a boundary, not signalling, so it must not set
      // the periodic timer running from zero: that would put every idle
      // handset's first update at 00:54 and give the city a signalling peak
      // made entirely of where the simulation happens to start. The timer was
      // already part-way through when the date began, and where in its cycle
      // is a per-subscriber phase.
      if (minute === 0) {
        lastSignalling = -Math.floor(roll(fadeKey ^ 0x5a5a) * PERIODIC_TAU);
      }
    } else if (serving !== bestCell) {
      // The serving cell may have fallen off the candidate list entirely,
      // which is what crossing out of its reach looks like from here. That is
      // an immediate move and not a margin question.
      const lost = servingScore <= RSRP_FLOOR || servingScore === -Infinity;
      const offset = connected ? CONNECTED_OFFSET : IDLE_OFFSET;
      const trigger = connected ? CONNECTED_TRIGGER : IDLE_TRIGGER;
      const better = bestScore - servingScore >= offset;

      if (lost) {
        const previous = serving;
        serving = bestCell;
        servingScore = bestScore;
        servingLevel = bestLevel;
        pending = UNATTACHED;
        closeSpan(minute);
        openSpan(minute, serving);
        emit(minute, connected ? "handover" : "reselect", serving, previous, "coverage");
      } else if (better) {
        if (pending !== bestCell) {
          pending = bestCell;
          pendingSince = minute;
        }
        if (minute - pendingSince + 1 >= trigger) {
          const previous = serving;
          serving = bestCell;
          servingScore = bestScore;
          servingLevel = bestLevel;
          pending = UNATTACHED;
          closeSpan(minute);
          openSpan(minute, serving);
          // Idle reselection is invisible to the network unless the tracking
          // area changed with it. It is still recorded, because the span table
          // is the truth and the event table is what the operator holds; the
          // cause says which of the two a consumer is looking at.
          emit(minute, connected ? "handover" : "reselect", serving, previous, "better-cell");
        }
      } else {
        pending = UNATTACHED;
      }
    } else {
      pending = UNATTACHED;
    }

    // A tracking-area change is the one thing an idle phone always reports,
    // and it is the boundary that decides how precisely the network can place
    // it between one report and the next.
    const area = cells.trackingAreaOf(serving);
    if (area !== servingArea) {
      emit(minute, "tau", serving, UNATTACHED, "ta-change");
      servingArea = area;
    } else if (minute - lastSignalling >= PERIODIC_TAU) {
      emit(minute, "tau", serving, UNATTACHED, "periodic");
    }

    if (connected !== wasConnected) {
      if (connected) emit(minute, "connect", serving, UNATTACHED, "session");
      else emit(minute, "release", serving, UNATTACHED, "idle");
    }

    spanRsrp += Number.isNaN(servingLevel) ? bestLevel : servingLevel;
    spanSamples += 1;
    spanExposure[exposure]! += 1;
    spanTa += taFor(serving);
    if (connected) {
      spanConnected += 1;
      const secondary = pickSecondary(serving);
      if (secondary !== UNATTACHED) spanSecondary.set(secondary, (spanSecondary.get(secondary) ?? 0) + 1);
    }
  }

  closeSpan(MINUTES);
  return {
    subscriber: subscriber.index,
    serving,
    servingArea,
    connected,
    pending,
    pendingSince: pendingSince - MINUTES,
    lastSignalling: lastSignalling - MINUTES,
    attached,
  };
}

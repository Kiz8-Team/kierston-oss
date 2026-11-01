/**
 * How likely one person is to look at their phone, minute by minute.
 *
 * This is the primitive the whole communications layer rests on, and it is one
 * array. Every other question the layer asks turns out to be this question:
 *
 *   when does somebody start a conversation      sample a minute from the curve
 *   how long do they take to reply               walk the curve until it fires
 *   do they answer the phone                     read the curve at that minute
 *
 * Writing three models would have meant three sets of parameters that quietly
 * disagreed — someone unreachable for calls but replying instantly to texts.
 * One curve makes that impossible by construction, and it makes the numbers
 * fall out of the day the scheduler already planned rather than out of a
 * distribution fitted to nothing.
 *
 * Why the day plan is the model
 * -----------------------------
 * The tempting implementation is a diurnal curve: low at night, high in the
 * evening, sampled per person. It produces a city where everyone is reachable
 * at the same times, which is exactly the property that makes real call data
 * useful and synthetic call data worthless. The interesting facts are all
 * individual — the night-shift nurse who answers at four in the morning and
 * not at two in the afternoon, the machinist unreachable for eight hours with
 * a fifteen-minute window at ten and half an hour at noon, the delivery driver
 * who never answers while moving and always answers between drops.
 *
 * All three are already in the plan. `activities/work` knows the shift,
 * `activities/sleep` knows the bouts as the planner actually allowed them, and
 * every leg carries its mode. So the curve is derived, not drawn, and the only
 * thing this file contributes is a table of how attentive each state is.
 *
 * Occupation is the term that does the most work
 * ----------------------------------------------
 * The gap between a claims adjuster and a line cook is larger than any other
 * distinction here — roughly 0.6 against 0.05 for a third of the waking day —
 * and it is the difference between a city whose daytime traffic is flat and
 * one where it is sorted by job. OCCP is on the assignment already, so this
 * costs a range lookup.
 *
 * The breaks are modelled here rather than in the roster because nothing else
 * needs them. A shift is not eight hours of uniform unavailability: there is a
 * meal break near the middle and two short ones either side of it, and for the
 * hands-busy occupations those windows are the *entire* daytime communications
 * life of about a third of this city. Leaving them out does not merely lower
 * the volume, it deletes the lunchtime spike that is the most recognisable
 * feature of any real messaging dataset.
 *
 * Resolution
 * ----------
 * Per minute, as a byte, because the state that drives it cannot change faster
 * than a minute — the track and the timeline are both minute-resolution. The
 * *events* sampled from it are placed at second resolution: a curve says which
 * minute somebody looked at their phone, and the second within it is uniform.
 */

import { LAYER, stream } from "../shared/index.ts";
import type { Day } from "../scheduler/index.ts";
import type { LegMode } from "../transport/index.ts";
import type { Person } from "../world/index.ts";

export const MINUTES = 1440;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS = MINUTES * SECONDS_PER_MINUTE;

/** Probability is stored as a byte. 255 is certainty, which nothing reaches. */
export const ATTENTION_SCALE = 255;

export interface Attention {
  /**
   * Probability × 255 of glancing at the handset in this minute.
   *
   * Not a probability of *replying* — a person who looks at their phone during
   * a meeting may well not answer. The reply decision is the conversation
   * layer's, and it multiplies this.
   */
  minute: Uint8Array;
  /**
   * Whether the person is asleep, per minute.
   *
   * Carried beside the curve rather than folded into it because the two states
   * behave differently and only in one direction. A sleeping person initiates
   * nothing — the curve is zero, so `sampleMinute` cannot land there — but can
   * still be woken by something arriving, and that second probability is far
   * smaller than the byte array can represent. Keeping the mask lets
   * `nextGlance` apply a float where the curve would have had to round.
   */
  asleep: Uint8Array;
  /**
   * False where the day gave nothing to derive a curve from, which is a real
   * state: an off-map worker's day is surveyed rather than planned, and a
   * person with no handset has no curve worth building. Such a person is
   * unreachable all day rather than being quietly given an average one.
   */
  known: boolean;
}

// ---------------------------------------------------------------------------
// How attentive each state is
// ---------------------------------------------------------------------------

/**
 * Asleep, in the curve: exactly zero.
 *
 * It was 0.004 and had to stop being a curve value at all. The curve is a byte,
 * so the smallest non-zero level it can hold is 1/255 — and over a median
 * sleep bout of 531 minutes that gives an 88% chance of a glance, which put a
 * quarter of the city's people on their phones every single night. The floor
 * could not be lowered because it was already the smallest number the array
 * can express: a representation limit, not a tuning one.
 *
 * Worse, a non-zero level here also fed `sampleMinute`, which is how a
 * conversation *starts*. That is a different and less defensible claim: seven
 * percent of the city's calls were being dialled by people who were asleep.
 * Answering the phone at three in the morning is real; ringing somebody at
 * three in the morning while unconscious is not.
 *
 * So sleep is zero in the curve — nothing is ever initiated during it — and
 * the night glance is handled separately in `nextGlance`, at a probability the
 * byte array does not have to be able to hold. See NIGHT_GLANCE.
 */
const ASLEEP = 0;

/**
 * Chance per minute that a sleeping person surfaces far enough to look at a
 * message that has arrived.
 *
 * A float, deliberately, and applied only on the reply path. Over a median
 * 531-minute night it comes to about one night in ten — which is roughly how
 * often people actually do wake up and answer something, and is a fifth of
 * what the byte floor was producing.
 */
const NIGHT_GLANCE = 0.0002;

/** At home, awake, with nothing else claimed on the timeline. */
const HOME = 0.62;

/**
 * Out somewhere discretionary — a shop, a cafe, the pub. Lower than home
 * because attention is on the errand, higher than work because nothing forbids
 * it.
 */
const STOP = 0.42;

/**
 * At a congregation, a class, a club night, a match. The one civilian state
 * with a social prohibition attached rather than a practical one.
 */
const AFFILIATION = 0.14;

/**
 * Out with somebody, on purpose.
 *
 * Below `STOP` and above `AFFILIATION`: nothing forbids the phone, but the
 * person it would otherwise be for is sitting opposite. This is the same
 * argument `graph.ts` makes when it damps a messaging rate by exposure, now
 * applied to the minute rather than to the week, and it is why an evening that
 * shows up as co-presence should not also show up as a texting peak.
 */
const MEET = 0.22;

/**
 * Travelling, by mode.
 *
 * Driving is the sharpest number in the file and the one most worth being
 * strict about. People do look at phones while driving, which is why it is not
 * zero, but a model that let them reply normally would put a large share of
 * this city's messages on the road and produce a co-location signal that is
 * simply false. A passenger is the opposite case — a bus or a back seat is the
 * most attentive state in the entire day, better than sitting at home, because
 * there is nothing else to do.
 */
const TRAVEL: Record<LegMode, number> = {
  car: 0.03,
  taxi: 0.03,
  cab: 0.02,
  // An officer at the wheel is driving, and the radio is the channel the job
  // actually uses — nothing in this simulation carries police traffic, so a
  // patrol shift is the least attentive state a phone can be in.
  patrol: 0.02,
  ambulance: 0.02,
  carpool: 0.10,
  transit: 0.86,
  bus: 0.86,
  passenger: 0.84,
  walk: 0.34,
  bike: 0.04,
  other: 0.40,
};

/**
 * At work, by what the hands are doing.
 *
 * Six classes rather than a number per occupation, because the evidence does
 * not support more and the differences that matter are between classes. The
 * names say what the constraint is, which is not the same as how skilled the
 * work is: a surgeon and a fry cook are both `hands`, and a dispatcher and a
 * corporate lawyer are both `desk`.
 */
const WORK = {
  /** In front of a screen, phone beside the keyboard, nobody watching. */
  desk: 0.58,
  /** Screen work with a public counter: a teller, a receptionist, a clerk. */
  counter: 0.30,
  /** Moving between people or rooms: a nurse, a teacher, a site supervisor. */
  mobile: 0.16,
  /** Serving customers face to face, where a phone in hand is a reprimand. */
  service: 0.11,
  /** Both hands occupied and often gloved: a line, a kitchen, a ward, a site. */
  hands: 0.05,
  /** Driving for a living, which is the strictest state anyone is paid to be in. */
  driving: 0.02,
} as const;

type WorkClass = keyof typeof WORK;

/**
 * OCCP major groups, as census codes, mapped to what the hands are doing.
 *
 * Ranges rather than a per-code table: the 2018 OCCP list is five hundred
 * codes and the boundaries between its major groups are exactly the boundaries
 * that matter here. Read as "codes below `below` are `work`", in order.
 */
const OCCUPATION_CLASSES: readonly (readonly [below: number, work: WorkClass])[] = [
  [500, "desk"],      // MGR management
  [1000, "desk"],     // BUS business and financial
  [1300, "desk"],     // CMM computer and mathematical
  [1600, "desk"],     // ENG architecture and engineering
  [2000, "mobile"],   // SCI life, physical and social science
  [2100, "mobile"],   // CMS community and social service
  [2200, "desk"],     // LGL legal
  [2600, "mobile"],   // EDU education — a teacher is not at a desk in class
  [3000, "mobile"],   // ENT arts, design, entertainment, sports, media
  [3600, "hands"],    // MED healthcare practitioners
  [3700, "hands"],    // HLS healthcare support
  [4000, "mobile"],   // PRT protective service
  [4200, "hands"],    // EAT food preparation and serving
  [4330, "hands"],    // CLN building and grounds cleaning
  [4700, "service"],  // PRS personal care and service
  [5000, "service"],  // SAL sales
  [6000, "counter"],  // OFF office and administrative support
  [6200, "hands"],    // FFF farming, fishing and forestry
  [7000, "hands"],    // CON construction and extraction
  [7700, "hands"],    // RPR installation, maintenance and repair
  [9000, "hands"],    // PRD production
  [9800, "driving"],  // TRN transportation and material moving
];

/**
 * Codes inside TRN that are not driving.
 *
 * The major group is the largest employer in this city and treating all of it
 * as driving would make several thousand people unreachable for their whole
 * shift on the strength of a range boundary. Movers, packers and warehouse
 * hands are `hands`; only the vehicle operators are `driving`.
 */
const NOT_DRIVING: readonly (readonly [number, number])[] = [
  [9600, 9760], // material moving: labourers, packers, stockers, machine operators
];

function workClass(occupation: string | null): WorkClass {
  if (!occupation) return "hands";
  const code = Number.parseInt(occupation, 10);
  if (!Number.isFinite(code)) return "hands";
  for (const [low, high] of NOT_DRIVING) if (code >= low && code <= high) return "hands";
  for (const [below, work] of OCCUPATION_CLASSES) if (code < below) return work;
  return "hands";
}

/**
 * School, by grade.
 *
 * A phone ban is universal on paper and enforced in inverse proportion to age,
 * which is the honest description. What actually decides the numbers here is
 * that most primary-age children have no handset at all — `devices.py` already
 * settled that — so this only ever applies to somebody who owns one.
 */
function schoolAttention(grade: number | null): number {
  if (grade === null) return 0.06;
  if (grade <= 5) return 0.02;
  if (grade <= 8) return 0.05;
  if (grade <= 12) return 0.09;
  return 0.45; // college, where nobody is confiscating anything
}

/**
 * Breaks inside a work block: when they fall and how long they last.
 *
 * Placed proportionally rather than at fixed clock times, because a third of
 * this city is not on a nine-to-five and a hard-coded 12:30 would put the
 * lunchtime spike in the middle of the night shift's small hours. A shift's
 * meal break falls near its own midpoint, wherever on the clock that is.
 */
const MEAL_MINUTES = 30;
const SHORT_MINUTES = 15;
/** Below this many hours a shift gets one short break and no meal. */
const MEAL_THRESHOLD = 6 * 60;
/** How attentive a break is. Close to being at home: the phone comes out. */
const BREAK = 0.88;

/**
 * The curve, for one planned day.
 *
 * `paid` is the person's OCCP from their assignment, which the caller has and
 * this layer would otherwise have to load the employment table to find.
 */
export function attentionCurve(
  planned: Day,
  person: Person,
  occupation: string | null,
  seed: number,
  day: number,
): Attention {
  const timeline = planned.scheduled.timeline;
  if (timeline.length === 0 && planned.legs.length === 0) {
    return { minute: new Uint8Array(0), asleep: new Uint8Array(0), known: false };
  }

  const curve = new Float64Array(MINUTES).fill(HOME);
  const work = WORK[workClass(occupation)];
  const school = schoolAttention(person.grade ?? null);

  // Stays first, then travel over the top. A leg and a stay cannot overlap in
  // a placed day, but writing them in this order means a rounding collision at
  // a boundary resolves in favour of the journey, which is the state with the
  // stronger constraint attached.
  for (const event of timeline) {
    if (event.kind !== "stay") continue;
    const level = stayAttention(event.source, work, school);
    fill(curve, event.start, event.end, level);
    if (event.source === "work") breaks(curve, event.start, event.end, seed, person.id, day);
  }

  for (const leg of planned.legs) {
    fill(curve, leg.depart, leg.arrive, TRAVEL[leg.mode] ?? TRAVEL.other);
  }

  // Discretionary time is not evenly spread through the waking day, and the
  // states above have no way to say so: a person at home at ten in the morning
  // and the same person at home at nine at night get the same level, which put
  // this city's messaging peak in the middle of the afternoon.
  //
  // This is the one place a clock enters the model, and it is deliberately
  // narrow — it lifts only the unclaimed states, never work, school or travel,
  // and it is applied before sleep so it cannot wake anybody. A night worker
  // at home at eight in the evening does get the lift, because they are in
  // fact at leisure; the same worker asleep at eight gets nothing, because the
  // next loop overwrites them.
  leisure(curve);

  // Sleep last and unconditionally. It is the one state that overrides
  // everything else: a person asleep at their desk on a night shift is asleep,
  // and the planner's own bouts are the authority on when that was.
  const asleep = new Uint8Array(MINUTES);
  for (const event of timeline) {
    if (event.kind !== "stay" || event.source !== "sleep") continue;
    fill(curve, event.start, event.end, ASLEEP);
    const from = Math.max(0, Math.floor(event.start));
    const to = Math.min(MINUTES, Math.ceil(event.end));
    for (let minute = from; minute < to; minute += 1) asleep[minute] = 1;
  }

  return { minute: quantise(curve, seed, person.id), asleep, known: true };
}

/**
 * The evening lift, applied to unclaimed time only.
 *
 * Peaks at nine in the evening and is gone by one in the morning. The states
 * it may touch are the two that mean "not committed to anything" — home and a
 * discretionary stop — because those are the ones whose level is really a
 * statement about free time rather than about a constraint.
 */
const LEISURE_PEAK_MINUTE = 21 * 60;
const LEISURE_WIDTH = 3.4 * 60;
const LEISURE_LIFT = 0.55;

function leisure(curve: Float64Array): void {
  for (let minute = 0; minute < MINUTES; minute += 1) {
    const level = curve[minute]!;
    if (level !== HOME && level !== STOP) continue;
    // Circular distance, so an hour past midnight is close to eleven at night.
    let offset = Math.abs(minute - LEISURE_PEAK_MINUTE);
    if (offset > MINUTES / 2) offset = MINUTES - offset;
    const shape = Math.exp(-0.5 * (offset / LEISURE_WIDTH) ** 2);
    curve[minute] = level + (1 - level) * LEISURE_LIFT * shape;
  }
}

function stayAttention(source: string, work: number, school: number): number {
  switch (source) {
    case "sleep": return ASLEEP;
    case "work": return work;
    case "school": return school;
    case "affiliation": return AFFILIATION;
    case "meet": return MEET;
    case "stop": return STOP;
    default: return HOME;
  }
}

function fill(curve: Float64Array, from: number, to: number, level: number): void {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(MINUTES, Math.ceil(to));
  for (let minute = start; minute < end; minute += 1) curve[minute] = level;
}

/**
 * Cut breaks into one work block.
 *
 * The jitter is per person per day rather than per person: breaks move, and a
 * worker whose lunch landed at exactly the same minute every day for a year
 * would be the most conspicuous pattern in the whole dataset.
 */
function breaks(curve: Float64Array, start: number, end: number, seed: number, person: number, day: number): void {
  const length = end - start;
  if (length < 3 * 60) return;
  const rng = stream(seed, person, LAYER.attention, day);

  if (length >= MEAL_THRESHOLD) {
    const at = start + length / 2 + rng.between(-45, 45);
    fill(curve, at - MEAL_MINUTES / 2, at + MEAL_MINUTES / 2, BREAK);
    // Two short breaks, a quarter and three quarters of the way through.
    const first = start + length * 0.25 + rng.between(-20, 20);
    const second = start + length * 0.75 + rng.between(-20, 20);
    fill(curve, first, first + SHORT_MINUTES, BREAK);
    fill(curve, second, second + SHORT_MINUTES, BREAK);
    return;
  }

  const only = start + length / 2 + rng.between(-25, 25);
  fill(curve, only, only + SHORT_MINUTES, BREAK);
}

/**
 * Per-person temperament, applied on the way into the byte array.
 *
 * One multiplier drawn once and never redrawn, because being the person who
 * always has the phone in their hand is a personality and not a mood. Without
 * it every machinist in the city has an identical curve and the only variation
 * in the whole layer comes from their shifts differing.
 *
 * Log-normal rather than uniform: the distribution of how attached people are
 * to their phones has a long right tail and no meaningful left one — nobody is
 * ten times less attentive than the median, and plenty of people are three
 * times more.
 *
 * Applied to the odds rather than to the probability, which is the part that
 * is easy to get wrong. Multiplying the probability directly sends anyone
 * above the median past 1 during their breaks, where the state level is
 * already 0.88, and the clamp then flattens the entire top half of the
 * population onto certainty — the most attentive people in the city would
 * become indistinguishable from each other at exactly the times they are most
 * active. An odds shift cannot leave (0, 1) at all, and it preserves the
 * ordering the draw intended, so a keen phone user is still keener than a
 * reluctant one at their break and neither of them is certain.
 */
function quantise(curve: Float64Array, seed: number, person: number): Uint8Array {
  const temperament = Math.exp(stream(seed, person, LAYER.attention).gauss(0, 0.42));
  const out = new Uint8Array(MINUTES);
  for (let minute = 0; minute < MINUTES; minute += 1) {
    const p = curve[minute]!;
    const shifted = p <= 0 ? 0 : (p * temperament) / (p * temperament + (1 - p));
    out[minute] = Math.max(0, Math.min(ATTENTION_SCALE - 1, Math.round(shifted * ATTENTION_SCALE)));
  }
  return out;
}

/** The curve at a minute, as a probability. Zero outside a known day. */
export function attentionAt(attention: Attention, minute: number): number {
  if (!attention.known || minute < 0 || minute >= MINUTES) return 0;
  return attention.minute[minute]! / ATTENTION_SCALE;
}

/**
 * The next second at which this person picks up their phone, at or after
 * `second`, or NONE if they do not do so again today.
 *
 * This is the reply-latency model in its entirety, and it is a search rather
 * than a distribution. Walk forward through the recipient's own curve; the
 * first minute whose draw succeeds is when they saw the message, and the
 * second within it is uniform. Somebody at a desk answers in forty seconds,
 * somebody on a production line answers when the ten o'clock break comes, and
 * somebody asleep answers at twenty past six — and none of those three numbers
 * was written down anywhere. They are the same rule reading three different
 * days.
 *
 * The stream is keyed on the message as well as the person, so the same
 * message always gets the same latency and a second message arriving later in
 * the day does not reuse the first one's draws.
 *
 * `wakingOnly` refuses to return a minute the person is asleep in, and exists
 * because the two things a glance can lead to are not equally plausible. Half
 * waking to thumb a reply at four in the morning is ordinary. Half waking and
 * then *placing a call* is not, and the callback path was doing exactly that
 * — a missed call noticed during a sleep bout produced a return call dialled
 * from inside it.
 */
export function nextGlance(
  attention: Attention,
  second: number,
  seed: number,
  person: number,
  day: number,
  nonce: number,
  wakingOnly = false,
): number {
  if (!attention.known) return -1;
  const from = Math.floor(second / SECONDS_PER_MINUTE);
  if (from >= MINUTES) return -1;
  const rng = stream(seed, person, LAYER.reply, day, nonce);

  for (let minute = from; minute < MINUTES; minute += 1) {
    // A sleeping person's chance of surfacing is a float the curve cannot
    // hold, so it is read from the mask instead of from the byte. This is the
    // only place the two differ, and it is why the mask exists.
    if (wakingOnly && attention.asleep[minute]) continue;
    const probability = attention.asleep[minute]
      ? NIGHT_GLANCE
      : attention.minute[minute]! / ATTENTION_SCALE;
    if (probability <= 0) continue;
    if (!rng.bool(probability)) continue;
    // Within the minute the glance is uniform, except in the minute the
    // message arrived, where it cannot precede the message itself.
    const floor = minute === from ? second % SECONDS_PER_MINUTE : 0;
    const at = minute * SECONDS_PER_MINUTE + Math.floor(rng.between(floor, SECONDS_PER_MINUTE));
    return Math.max(at, second);
  }
  return -1;
}

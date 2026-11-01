/**
 * The part of the day nobody chooses.
 *
 * Sleep used to be two constants in `tours.ts` — nothing happened before 06:00
 * or after 23:30, for anybody — and the officer coming off the night watch at
 * 07:00 was in a café at 08:00 because the model had no idea they had been
 * awake all night. Worse, it did not know they were still at work at 06:14,
 * because a day was planned from its own roster alone and a shift that started
 * at 23:00 yesterday is not in today's.
 *
 * Both are the same mistake: the day boundary is not a boundary a person
 * observes. So this module works over a three-day window — yesterday, today,
 * tomorrow — and answers two questions that midnight makes hard:
 *
 *   overhang   what is still running after 00:00 because it started yesterday
 *   bouts      when this person is asleep, in today's minutes, possibly negative
 *
 * Nothing here is sequential
 * --------------------------
 * The window is bounded and every input to it is a pure function of seed,
 * person and date, so a person's Tuesday is still answerable without running
 * their Monday. That is the invariant `rng.ts` and `roster.ts` are built on and
 * it survives intact: sleep need is a trait drawn once, the lie-in is a
 * function of what tomorrow demands, and there is no sleep debt carried from
 * one night to the next. Debt would have been the one genuinely sequential
 * quantity in the simulation, and it is deliberately not modelled — the cost of
 * a night worked short is paid the same night, in a shorter bout, not banked.
 *
 * Where the bout goes
 * -------------------
 * Not "at night", and not "after the shift" either — both are special cases of
 * one rule. A person has a preferred sleep centre, roughly half three in the
 * morning shifted by their chronotype, and the commitments they cannot move
 * carve the day into gaps. Each night's bout goes in the gap that can host it
 * nearest to that night's centre, and the ideal bout is then slid the least it
 * can be to sit inside. That single rule puts the day worker in bed at half
 * eleven and the night worker in bed at twenty past seven in the morning,
 * without either being written down anywhere.
 */

import type { Person, World } from "../../world/index.ts";
import { LAYER, MINUTES_PER_DAY, stream } from "../../shared/index.ts";
import { rosterFor, type Block } from "../work/index.ts";

/** A span of sleep in minutes from today's midnight. `start` may be negative. */
export interface Bout {
  start: number;
  end: number;
  /**
   * The latest this bout may begin if the evening runs long.
   *
   * Sleep is the one commitment a person is allowed to spend. Somebody who
   * stays at the bar until midnight goes to bed at midnight and gets less
   * sleep; they do not decline the pint because their bedtime says so. So the
   * discretionary layers are tested against this rather than against `start`,
   * and `start` is moved to what the day turned out to contain.
   */
  latest: number;
}

export interface Carry {
  /**
   * Yesterday's commitments that are still running after midnight, rewritten
   * into today's minutes. A night watch ending at 1860 arrives here as a block
   * from 0 to 420, which is what stops today's layers treating the small hours
   * as free time and putting the person in two places.
   */
  overhang: Block[];
  /** Sleep in today's minutes, clipped to the bouts that touch [0, 1440). */
  bouts: Bout[];
}

/**
 * Time in bed, in minutes, before the person's own draw.
 *
 * ATUS reports around 8.7 hours of "sleeping" for adults, which is higher than
 * anybody's answer to how much they sleep because it is time in bed and it
 * counts naps. Time in bed is the right quantity here — it is what makes a
 * person unavailable — but the main nocturnal bout is not all of it, so the
 * baseline sits a little under the published figure and the rest is left in the
 * tails and in the lie-in.
 *
 * The age shape is ATUS's and is not subtle: teenagers sleep an hour and a half
 * more than their parents, and the retired sleep more than the employed because
 * nothing wakes them.
 */
function baselineNeed(age: number): number {
  if (age < 13) return 9.7 * 60;
  if (age < 18) return 9.0 * 60;
  if (age < 25) return 8.6 * 60;
  if (age < 45) return 8.1 * 60;
  if (age < 65) return 8.0 * 60;
  return 8.3 * 60;
}

/** How far a person's need strays from their age's baseline. */
const NEED_SPREAD = 66;
const NEED_MIN = 5.5 * 60;
const NEED_MAX = 11 * 60;

/**
 * The lie-in, taken on the mornings nothing is due.
 *
 * Keyed on whether the person has a fixed commitment to wake for rather than on
 * the calendar, which is the same thing for most of the city and deliberately
 * not the same thing for the quarter of it that works rotating weeks. A nurse
 * whose days off are Tuesday and Wednesday lies in on Tuesday and Wednesday.
 * Around forty minutes is what the social-jetlag literature measures between
 * free days and work days, and it is a floor rather than a ceiling because the
 * absent alarm clock also removes the cap.
 */
const LIE_IN = 42;

/**
 * How much later an owl goes to bed than a lark, as one standard deviation.
 *
 * Halved when there is something to wake for, because the alarm clock wins the
 * morning and the chronotype only gets the evening — which is exactly why owls
 * sleep less on work days and is the whole of the effect worth modelling.
 */
const CHRONOTYPE_SPREAD = 52;
const CHRONOTYPE_CAP = 110;

/** Preferred centre of the night's sleep, for a person with no chronotype. */
const PREFERRED_CENTRE = 3 * 60 + 30;

/**
 * What daylight costs a bout.
 *
 * A day sleep is shorter than a night sleep of the same intention — the shift
 * worker who lies down at eight in the morning gets around an hour less than
 * they would have at eleven at night, because light and noise end it early and
 * no amount of intending otherwise changes that. Applied by where the bout
 * lands rather than by who the person is, so the officer loses it on their work
 * days and sleeps properly on their rest days.
 */
const DAYLIGHT_PENALTY = 68;
const DAYLIGHT_FROM = 8 * 60;
const DAYLIGHT_TO = 17 * 60;

/** Getting up, washed, fed and out of the door. */
const READINESS_MIN = 26;
const READINESS_MAX = 64;

/** Winding down after getting home, before the bout can start. */
const SETTLE = 24;

/** How much of the night a late evening may eat. */
const MAX_COMPRESSION = 105;
/** Below this it is not a night's sleep and the bout is not placed. */
const MIN_BOUT = 3.5 * 60;

/** Everything about one person that never changes. Three draws, kept forever. */
export interface SleepTraits {
  /** Minutes in bed on an ordinary night. */
  need: number;
  /** Positive is an owl, negative a lark. */
  chronotype: number;
  /** Minutes between waking and being able to leave the house. */
  readiness: number;
}

/**
 * The three traits, read off the person rather than invented here.
 *
 * `init/population/traits.py` draws them, and it has to be the one that does:
 * which officer works nights is decided in `init/work/init_work.py`, and a
 * trait this layer conjured out of a hash long after that roster existed could
 * never have fed into it. So the night watch used to be a uniform sample of
 * the force when in life it is nothing of the kind. Drawing them with the
 * person also means the chronotype knows the person's age, which is its
 * largest covariate by a wide margin and something a hash of an id cannot see.
 *
 * The fallback is transitional and exists so a population built before the
 * trait stage still produces people who sleep. It reproduces the old
 * behaviour, age-blind chronotype and all, and should be deleted once
 * `population.json` has been rebuilt.
 */
export function traitsFor(seed: number, person: Person): SleepTraits {
  if (person.chronotype !== undefined && person.sleep_need !== undefined && person.readiness !== undefined) {
    return { need: person.sleep_need, chronotype: person.chronotype, readiness: person.readiness };
  }

  const rng = stream(seed, person.id, LAYER.sleep);
  const need = Math.min(NEED_MAX, Math.max(NEED_MIN, baselineNeed(person.age) + rng.gauss(0, NEED_SPREAD)));
  const chronotype = Math.max(-CHRONOTYPE_CAP, Math.min(CHRONOTYPE_CAP, rng.gauss(0, CHRONOTYPE_SPREAD)));
  const readiness = Math.round(READINESS_MIN + rng.next() * (READINESS_MAX - READINESS_MIN));
  return { need, chronotype, readiness };
}

/**
 * What a commitment costs either side of itself.
 *
 * The survey's travel time rather than a routed one, on purpose. Routing here
 * would mean the sleep layer depended on the commute layer, which depends on
 * the roster, and reconstructing yesterday's carry would cost a full commute
 * per person per day rather than the arithmetic it costs now. The difference
 * between a routed door-to-door and PUMS's own answer is a few minutes at the
 * edge of a bout that is eight hours long, and the bout's start is re-solved
 * against the real legs once the day is chained anyway.
 */
function travelOf(person: Person): number {
  return Math.max(5, Math.min(75, person.travel ?? 18));
}

/** Spans a person is away from home, in minutes from today's midnight. */
function awaySpans(world: World, person: Person, date: Date, day: number): [number, number][] {
  const travel = travelOf(person);
  const traits = traitsFor(world.seed, person);
  const spans: [number, number][] = [];

  for (const offset of [-1, 0, 1]) {
    const when = new Date(date);
    when.setDate(date.getDate() + offset);
    const shift = offset * MINUTES_PER_DAY;
    for (const block of rosterFor(world, person, when, day + offset)) {
      if (!block.fixed) continue;
      // Working from home is a commitment to be working and not to be anywhere,
      // so it costs no travel — but it still cannot be slept through.
      const lead = block.mode === "home" ? 0 : travel + traits.readiness;
      const trail = block.mode === "home" ? 0 : travel + SETTLE;
      spans.push([block.start + shift - lead, block.end + shift + trail]);
    }
  }

  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/**
 * Whether the morning after a bout has anything to get up for.
 *
 * Asked of the spans rather than of the calendar, so the rotating quarter of
 * the workforce lies in on their own days off and not on everybody else's.
 */
function freeMorning(spans: readonly (readonly [number, number])[], wake: number): boolean {
  return !spans.some(([from]) => from > wake - 30 && from < wake + 10 * 60);
}

/**
 * The night's sleep, placed in the gap that suits it.
 *
 * One bout per calendar night — `k` walks yesterday's, tonight's and
 * tomorrow's preferred centres — and for each, the gap between commitments
 * whose available room sits nearest that centre. A gap with
 * no room for `MIN_BOUT` is not offered one, which is how a medic's 24-hour
 * tour ends up with a person who genuinely does not sleep at home that night.
 */
export function boutsFor(world: World, person: Person, date: Date, day: number): Bout[] {
  const traits = traitsFor(world.seed, person);
  const spans = awaySpans(world, person, date, day);

  // Gaps, over a window wide enough that a bout starting yesterday evening and
  // one ending tomorrow morning are both reachable.
  const from = -MINUTES_PER_DAY;
  const to = 2 * MINUTES_PER_DAY;
  const gaps: [number, number][] = [];
  let cursor = from;
  for (const [start, end] of spans) {
    if (start > cursor) gaps.push([cursor, Math.min(start, to)]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < to) gaps.push([cursor, to]);

  const bouts: Bout[] = [];
  const used: [number, number][] = [];

  for (const k of [-1, 0, 1]) {
    const centre = PREFERRED_CENTRE + traits.chronotype + k * MINUTES_PER_DAY;

    let best: Bout | null = null;
    let bestDistance = Infinity;

    for (const [gapStart, gapEnd] of gaps) {
      const room = gapEnd - gapStart;
      if (room < MIN_BOUT) continue;

      // A day sleep is shorter, and whether this is one depends on where the
      // bout lands, which depends on the length — so the length is solved once
      // with the penalty guessed off the gap and then trusted.
      let length = Math.min(traits.need, room);
      const provisional = Math.max(gapStart, Math.min(gapEnd - length, centre - length / 2));
      const middle = ((provisional + length / 2) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      if (middle > DAYLIGHT_FROM && middle < DAYLIGHT_TO) length = Math.max(MIN_BOUT, length - DAYLIGHT_PENALTY);
      length = Math.min(length, room);
      if (length < MIN_BOUT) continue;

      // Nearest fit: the ideal bout, slid the least it can be to sit inside
      // the gap. Where the ideal already fits, nothing moves.
      const start = Math.max(gapStart, Math.min(gapEnd - length, centre - length / 2));
      let end = start + length;

      // The lie-in, taken at the far end because that is the end an alarm
      // clock would otherwise have held. Only where the gap has room for it.
      if (freeMorning(spans, end)) end += Math.min(LIE_IN, gapEnd - end);

      // Two nights may share one gap — somebody with no fixed commitment at
      // all has exactly one gap spanning the whole window, and their three
      // nights go in it one after another. What may not happen is two bouts on
      // top of each other, so the test is against the placed bouts and not
      // against the gap that held them. Testing the gap was worth 51% of the
      // city sleeping not at all: every retired person, every unemployed one
      // and everybody's Saturday got one bout for three days and often it fell
      // outside the day being planned.
      if (used.some(([a, b]) => start < b && end > a)) continue;

      // Linear against an absolute centre, and emphatically not circular. A
      // circular metric cannot tell this morning's eleven o'clock from
      // tomorrow's, so it let a night worker's Tuesday sleep get placed in
      // Wednesday's gap and leave Tuesday morning wide open — the exact hole
      // this module exists to close. `k` already says which night is being
      // placed; the distance only has to say which gap is nearest to it.
      const distance = Math.abs(start + (end - start) / 2 - centre);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { start: Math.round(start), end: Math.round(end), latest: Math.round(start) };
      }
    }

    if (!best) continue;
    bouts.push(best);
    used.push([best.start, best.end]);
  }

  return finish(bouts, traits);
}

/**
 * The compression allowance, applied once every bout is placed.
 *
 * `latest` is how late the evening may run before the bout is refused outright,
 * and it is bounded twice: by how much of the night a person will actually give
 * up, and by the bout still being long enough to be a night's sleep.
 */
function finish(bouts: Bout[], traits: SleepTraits): Bout[] {
  for (const bout of bouts) {
    const room = Math.max(0, bout.end - bout.start - MIN_BOUT);
    bout.latest = Math.round(bout.start + Math.min(MAX_COMPRESSION, room));
  }
  return bouts.sort((a, b) => a.start - b.start);
}

/**
 * Everything that crosses midnight into `date`, and the only thing that does.
 *
 * Both halves are recomputed rather than remembered, which is what keeps
 * `--person 88927 --date` a one-day command. Producing this from a stored
 * previous day would be exact in the same way and would cost the whole year up
 * to that date; there is nothing in it that a bounded roster window cannot
 * answer, so nothing is stored.
 */
export function carryFor(world: World, person: Person, date: Date, day: number): Carry {
  const yesterday = new Date(date);
  yesterday.setDate(date.getDate() - 1);

  const overhang: Block[] = [];
  for (const block of rosterFor(world, person, yesterday, day - 1)) {
    if (block.end <= MINUTES_PER_DAY) continue;
    overhang.push({
      ...block,
      start: Math.max(0, block.start - MINUTES_PER_DAY),
      end: block.end - MINUTES_PER_DAY,
    });
  }

  const bouts = boutsFor(world, person, date, day).filter((bout) => bout.end > 0 && bout.start < MINUTES_PER_DAY);
  return { overhang, bouts };
}

/** Sleep as roster blocks, for the layers and the timeline that read blocks. */
export function sleepBlocks(bouts: readonly Bout[]): Block[] {
  return bouts.map((bout) => ({
    kind: "sleep" as const,
    start: bout.start,
    end: bout.end,
    site: null,
    mode: "home" as const,
    fixed: true,
  }));
}

export { LIE_IN, MAX_COMPRESSION, MIN_BOUT, PREFERRED_CENTRE };

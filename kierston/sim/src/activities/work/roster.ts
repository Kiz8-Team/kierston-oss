/**
 * What is compulsory about a person's day.
 *
 * Work is not an activity. It is a schedule generator, and which generator runs
 * is decided by two fields `init/work` already wrote: `mode`, which says what
 * shape the day has, and `class`, which says whether the schedule comes from a
 * rota or from the survey.
 *
 *   sited      a fixed site, entered and left once — the ordinary case
 *   itinerant  a base, and a day spent away from it
 *   home       no commute, and a block that other activities can interrupt
 *   external   the person leaves the extract and is not in the city at all
 *
 * The output is blocks, not events. A block says "this person is committed
 * here between these minutes"; turning that into departures and arrivals is
 * the commute layer's job, because only it knows how long the trip takes.
 *
 * Nothing here reads another person. That is what makes the whole pass
 * parallel and what makes a single person's day reproducible on its own.
 */

import type { Assignment, Person, Shift, World } from "../../world/index.ts";
import { LAYER, MINUTES_PER_DAY, stream, trait, weekday } from "../../shared/index.ts";

export type BlockKind = "work" | "school" | "sleep";

/**
 * School terms, as the days of the week a school building is open.
 *
 * The calendar — holidays, in-service days, the summer — is not modelled and
 * this is not a stand-in for it. It is the one part of a school year that
 * changes a person's Tuesday, and leaving it out would put nine thousand
 * children in classrooms on a Saturday.
 */
const SCHOOL_DAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

/** Is school open? Exported because every school layer has to ask it. */
export function schoolDay(date: Date): boolean {
  return SCHOOL_DAYS.has(weekday(date));
}

/**
 * A bus driver's report time before the first bell, and the wrap after the last.
 *
 * A run does not start when the bus leaves the depot; it starts with the
 * pre-trip inspection, which is a legal requirement and about fifteen minutes.
 * The same at the other end, minus the paperwork.
 */
const BUS_REPORT = 15;
const BUS_WRAP = 10;

export interface Block {
  kind: BlockKind;
  /** Minutes from midnight of the planning day. `end` may exceed 1440. */
  start: number;
  end: number;
  site: string | null;
  mode: Assignment["mode"];
  /** Present for class: primary, so the runtime knows a rostered day from a job. */
  role?: string;
  duty?: string;
  crew?: string | null;
  watch?: string;
  /** True where the block is a commitment to be somewhere, false where it is porous. */
  fixed: boolean;
}

/**
 * How much of the week a filler worker actually works.
 *
 * WKHP is the only evidence, and it constrains days and length together. The
 * split below is a habit, not a rule the data supplies: someone on 60 hours is
 * far more likely to be working five twelves or six tens than seven eights, and
 * someone on 12 is working two or three short ones rather than five two-hour
 * shifts nobody schedules.
 */
function weekPattern(hours: number, rng: ReturnType<typeof stream>): { days: number; length: number } {
  let days: number;
  if (hours <= 14) days = rng.pick([2, 2, 3]);
  else if (hours <= 24) days = rng.pick([3, 3, 4]);
  else if (hours <= 34) days = rng.pick([4, 4, 5]);
  else if (hours <= 44) days = rng.pick([5, 5, 5, 6]);
  else if (hours <= 55) days = rng.pick([5, 5, 6]);
  else days = rng.pick([5, 6, 6]);
  const length = Math.max(120, Math.min(13 * 60, Math.round((hours * 60) / days / 15) * 15));
  return { days, length };
}

/**
 * Which weekdays a person works, drawn once per person and kept.
 *
 * A schedule that changed every week would be a person with no routine, and
 * routine is most of what makes a week of simulated movement look like a week.
 *
 * The split is between two kinds of week, not a single weighted draw over
 * seven days. Weighting the weekend down and picking five of seven cannot
 * produce the distribution the country actually has: dropping only two days
 * leaves everyone working some of the weekend, and the first version of this
 * had 64% of Kierston's workforce in on a Saturday. Most people work a
 * Monday-to-Friday week and never see the weekend at all; a real minority —
 * retail, hospitality, care, transport, everyone who keeps a city open — work
 * a rotating week where Saturday is a day like any other. So the person draws
 * which kind of worker they are first, and the days follow from that.
 */
const WEEKEND_WORKER = 0.27;
const ROTATING_WEIGHT = [1.0, 1.0, 1.0, 1.0, 1.0, 0.86, 0.62];

function workingDays(person: Person, days: number, seed: number): Set<number> {
  const rng = stream(seed, person.id, LAYER.workDays);
  const rotating = rng.bool(WEEKEND_WORKER);
  const pool = [0, 1, 2, 3, 4, 5, 6];
  // A standard week only reaches the weekend if it has more than five days in
  // it, which is what the near-zero weights express rather than forbid.
  const weights = rotating ? [...ROTATING_WEIGHT] : [1, 1, 1, 1, 1, 0.06, 0.02];

  const chosen = new Set<number>();
  for (let i = 0; i < days && pool.length > 0; i += 1) {
    const day = rng.weighted(pool, weights);
    const at = pool.indexOf(day);
    pool.splice(at, 1);
    weights.splice(at, 1);
    chosen.add(day);
  }
  return chosen;
}

/** Does a rostered role work this calendar day? */
function onWatch(shift: Shift, person: Person, day: number, date: Date, seed: number): boolean {
  const rota = shift.rota;
  if (rota.kind === "platoon") {
    // a/b/c tile the cycle exactly, so the city always has one shift on.
    return (day - rota.offset) % (rota.on + rota.off) === 0;
  }
  if (rota.kind === "person") {
    return !(rota.rest ?? []).includes(weekday(date));
  }
  // A cab driver picks their own days around a habitual count.
  return workingDays(person, rota.days, seed).has(weekday(date));
}

/**
 * Overtime, as minutes past the scheduled end.
 *
 * Held over on a job, a late meeting, a shift that would not hand over. It is
 * one-sided on purpose — almost nobody leaves early, and the tail is what puts
 * an officer's end-of-watch at 23:41 instead of 23:00.
 */
function overtime(person: Person, day: number, seed: number, scale: number): number {
  const rng = stream(seed, person.id, LAYER.overtime, day);
  if (!rng.bool(0.55)) return 0;
  return Math.round(Math.min(150, Math.abs(rng.gauss(0, 22)) * scale));
}

/**
 * The compulsory blocks for one person on one day, or an empty list.
 *
 * A person with no assignment — a child, a retiree, anyone out of the labour
 * force — has no compulsory work block, and that is not a hole. It is the
 * whole discretionary day that the activity layers will fill.
 */
export function rosterFor(world: World, person: Person, date: Date, day: number): Block[] {
  const assignment = world.assignments.get(person.id);
  const school = schoolBlocks(world, person, date);

  // A student who also works gets both, and the two are left to overlap if the
  // data says they do. Reconciling them here would be the wrong place: the
  // caller's `free` test already arbitrates between fixed commitments, and a
  // roster that quietly dropped one of them would hide a fifteen-year-old
  // rostered onto a shift during double maths rather than report it.
  if (!assignment) return school;

  const driving = busRuns(world, person, date);
  if (driving.length > 0) return [...school, ...driving];

  if (assignment.class === "primary" && assignment.shift) {
    const shift = assignment.shift;
    if (!onWatch(shift, person, day, date, world.seed)) return [];
    const extra = overtime(person, day, world.seed, assignment.role === "police_officer" ? 1.4 : 1.0);
    return [
      {
        kind: "work",
        start: shift.start - shift.report,
        end: shift.end + extra,
        site: assignment.site,
        mode: assignment.mode,
        role: assignment.role,
        duty: assignment.duty,
        crew: assignment.crew ?? null,
        watch: shift.watch,
        fixed: true,
      },
    ];
  }

  const hours = person.hours ?? assignment.hours ?? 0;
  if (hours <= 0) return school;

  const rng = stream(world.seed, person.id, LAYER.workDays, 0);
  const { days, length } = weekPattern(hours, rng);
  if (!workingDays(person, days, world.seed).has(weekday(date))) return school;

  // `arrive` is the survey's answer for when this person reaches work. It is
  // the anchor; the commute layer works backwards from it to a departure, and
  // does not trust the survey's own `depart` to be consistent with it.
  const arrive = person.arrive ?? 9 * 60;
  const extra = overtime(person, day, world.seed, 1.0);

  return [
    ...school,
    {
      kind: "work",
      start: arrive,
      end: arrive + length + extra,
      site: assignment.site,
      mode: assignment.mode,
      // Working from home is a commitment to be working, not to be anywhere.
      // Leaving it porous is what lets an errand land at 11:00 for the 4,418
      // people whose day has no commute to hang one off.
      fixed: assignment.mode !== "home",
    },
  ];
}

/**
 * The school day, for a student who has one.
 *
 * A schedule generator like any other, and the argument for putting it here
 * rather than in a layer of its own is that it is the same *kind* of fact as a
 * shift: a commitment to be in a particular building between two minutes, which
 * the person did not choose and cannot move. Everything discretionary in a
 * student's day has to fit around it for exactly the reason a worker's does.
 *
 * College is the exception and is deliberately porous. A timetable is not a
 * shift — a student with two lectures on a Tuesday is on campus for two hours
 * and not for seven — and marking it fixed would invent a presence nobody has.
 * The block still exists, because they are on campus and their errands hang off
 * that, but it does not claim they cannot be interrupted.
 */
function schoolBlocks(world: World, person: Person, date: Date): Block[] {
  if (!SCHOOL_DAYS.has(weekday(date))) return [];
  const rider = world.school.riders.get(person.id);
  if (!rider) return [];

  const start = world.school.startTimes[rider.band];
  const length = world.school.dayLength[rider.band];
  if (start === undefined || length === undefined) return [];

  return [
    {
      kind: "school",
      start,
      end: start + length,
      site: rider.school,
      mode: "sited",
      role: rider.band,
      fixed: rider.band !== "college",
    },
  ];
}

/**
 * A school bus driver's day: two runs, and the gap between them.
 *
 * The split shift is the whole point and it is not a detail. A driver works
 * from before six until the last elementary bell and again from the early
 * afternoon until the last child is home, and the four hours in between are not
 * a break at work — they are the driver at home, or at a second job, and they
 * are the largest genuinely free midday block anybody in this city has.
 * Modelling the shift as one continuous block from 06:00 to 16:30 would delete
 * that, and with it the reason the job is hard to fill.
 *
 * The site is the depot, and it is taken from the run rather than from the
 * assignment. `init_work.py` posts a driver at their own dwelling, because the
 * yard is not a building the extract contains and that stage has no way to know
 * which operator they turn out for; the yard `school.ts` brackets every run
 * with is the one place the block could honestly claim to be. What happens
 * after the bus leaves it is the run, and the run is `school.ts`'s to generate
 * — the same division that gives a cab driver a shift starting at a base the
 * day does not describe.
 */
function busRuns(world: World, person: Person, date: Date): Block[] {
  if (!SCHOOL_DAYS.has(weekday(date))) return [];
  const runs = world.school.driving.get(person.id);
  if (!runs || runs.length === 0) return [];

  const blocks: Block[] = [];

  for (const direction of ["am", "pm"] as const) {
    const mine = runs.filter((run) => run.direction === direction);
    if (mine.length === 0) continue;

    // The morning is solved backwards from the last bell and the afternoon
    // forwards from the first, because that is which end of each is fixed: the
    // bus has to *arrive* by the morning bell and can only *leave* after the
    // afternoon one.
    const first = Math.min(...mine.map((run) => run.bell));
    const last = Math.max(...mine.map((run) => run.bell));
    // The runs' own durations, measured by the simulation and written back by
    // `--measure-runs`. Estimating the envelope from a per-stop constant was the
    // first version, and it put the block's edges minutes away from the legs
    // inside it — the driver's timeline showed them departing before their own
    // shift began.
    const span = mine.reduce((total, run) => total + run.minutes, 0);

    blocks.push({
      kind: "work",
      start: Math.round(direction === "am" ? first - span - BUS_REPORT : first - BUS_REPORT),
      end: Math.round(direction === "am" ? last + BUS_WRAP : last + span + BUS_WRAP),
      site: `depot/${mine[0]!.operator}`,
      mode: "itinerant",
      role: "school_bus_driver",
      duty: direction === "am" ? "morning runs" : "afternoon runs",
      watch: direction,
      fixed: true,
    });
  }

  return blocks;
}

/**
 * Scheduled work minutes per week — the check that WKHP survived the roster.
 *
 * Averaged over three weeks, not measured over one. A 24/48 rotation puts two
 * tours in some weeks and three in others, so a single week reads 48 hours or
 * 72 against a 56-hour contract and neither number means anything. Three weeks
 * is the shortest window that contains a whole number of every cycle in use.
 */
const CHECK_DAYS = 21;

export function weeklyMinutes(world: World, person: Person, from: Date, fromDay: number): number {
  let total = 0;
  for (let i = 0; i < CHECK_DAYS; i += 1) {
    const date = new Date(from);
    date.setDate(from.getDate() + i);
    for (const block of rosterFor(world, person, date, fromDay + i)) {
      if (block.kind === "work") total += Math.min(block.end, block.start + MINUTES_PER_DAY) - block.start;
    }
  }
  return (total / CHECK_DAYS) * 7;
}

/** Persistent minutes-early/late. Used by the commute layer, drawn once ever. */
export function punctuality(seed: number, person: Person): number {
  return (trait(seed, person.id, LAYER.punctuality) - 0.45) * 18;
}

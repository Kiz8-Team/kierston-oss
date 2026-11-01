/**
 * Run the roster and commute layers and look at what came out.
 *
 *   bun run day --person 0 --date 2026-07-28      one person's day, as a timeline
 *   bun run day --person 70213 --week             the same person's whole week
 *   bun run check                                  the aggregate checks
 *   bun run day --export-day --date 2026-07-28     pack the city's day into one binary
 *   bun run day --export-day --week --date 2026-08-17  cold-start and pack seven consecutive dates
 *   bun run day --export-day --week --days 2 --date 2026-08-17  the same chain, two dates long
 *   bun run day --export-day --date 2026-07-28 --init-cold-start-day
 *                                                   reconstruct the preceding day first
 *   bun run day --export-day --date 2026-09-04 --from-state day_2026-09-03.bin --output-dir <dir>
 *                                                   continue from a KDAY's closing state
 *   bun run day --person 0 --money                 the same day, as their bank saw it
 *   bun run day --sample 4000 --money              what the city spent, against CEX and DCPC
 *   bun run day --export-taxi                      write the cab stands out for the viewer
 *   bun run day --city <build> --export-day --date 2026-07-28
 *                                                   the same, on another city build (see day.ts)
 *   bun run day --seed 7 --export-day --date 2026-07-28
 *                                                   the same, with day draws keyed on seed 7
 *
 * The checks are the point of the second mode. Every number they print has a
 * published counterpart — PUMS travel times, NHTS trip rates, WKHP — and a
 * layer that cannot reproduce its own inputs is not worth running at scale.
 */

import { SIM_DATA_DIR, homeOf, placeOf, type Person, type World } from "./world/index.ts";
import { commuteFor, rosterFor, tourKilometres, unitFor, weeklyMinutes, type Block, type CommuteContext } from "./activities/work/index.ts";
import { timing } from "./activities/school/index.ts";
import { CADENCE, EXPOSURE, GYM_VISITS_PER_WEEK, impliedAttendance } from "./activities/social/index.ts";
import { entries, HouseholdDayPlanner, planDay } from "./scheduler/index.ts";
import { SimulationState, loadDayContext, type Cohort, type DayContext } from "./engine/index.ts";
import { DRIVER_ROLE, NOMINAL_WAIT, fleetTally, geography, hirerFor, patrolKilometres, stands } from "./transport/index.ts";
import { Timings, WEEKDAY_NAMES, clock, dayNumber, isoDate, parseDate, weekday } from "./shared/index.ts";
import { join } from "node:path";
import { dispatchDate, exportWeek } from "./export/index.ts";
import { Comms } from "./comms/index.ts";
import { BILL_KINDS, Bank, Bills, billsDue, chargesFor, incomeDue, settleDay } from "./economy/index.ts";
import {
  EVENT_CAUSES, EVENT_KINDS, Network, OPERATORS, RADIO_LAYERS, TA_UNIT_M, UNATTACHED,
  emptyDayNetwork, orphanSubscribers,
} from "./network/index.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

/** KDAYs carry closing state; workers remain disabled until they can return it. */
const DEFAULT_WORKERS = 0;

interface Args {
  person?: number;
  date: Date;
  dateProvided: boolean;
  week: boolean;
  sample?: number;
  measureRuns: boolean;
  taxi: boolean;
  exportTaxi: boolean;
  exportDay: boolean;
  exportWeek: boolean;
  initColdStartDay: boolean;
  /** A KDAY (or KSTATE JSON) whose closing state this export continues from. */
  fromState?: string;
  /** Where the KDAY and its manifest go, instead of sim_outputs. */
  outputDir?: string;
  /** How many worker processes an export plans in. */
  workers: number;
  money: boolean;
  radio: boolean;
  /** Length of an `--export-day --week` chain; seven when absent. */
  days?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    date: new Date(), dateProvided: false, week: false, measureRuns: false, taxi: false, exportTaxi: false,
    exportDay: false, exportWeek: false, initColdStartDay: false,
    money: false, radio: false, workers: DEFAULT_WORKERS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--person") { args.person = Number(value); i += 1; }
    else if (flag === "--date") { args.date = parseDate(value!); args.dateProvided = true; i += 1; }
    else if (flag === "--sample") { args.sample = Number(value); i += 1; }
    else if (flag === "--week") { args.week = true; }
    else if (flag === "--days") { args.days = Number(value); i += 1; }
    else if (flag === "--measure-runs") { args.measureRuns = true; }
    else if (flag === "--taxi") { args.taxi = true; }
    else if (flag === "--export-taxi") { args.exportTaxi = true; }
    else if (flag === "--export-day") { args.exportDay = true; }
    // Compatibility with the short-lived spelling used before `--export-day --week`.
    else if (flag === "--export-week") { args.exportWeek = true; }
    else if (flag === "--init-cold-start-day") { args.initColdStartDay = true; }
    else if (flag === "--from-state") { args.fromState = value; i += 1; }
    else if (flag === "--output-dir") { args.outputDir = value; i += 1; }
    else if (flag === "--workers") { args.workers = Number(value); i += 1; }
    else if (flag === "--money") { args.money = true; }
    else if (flag === "--radio") { args.radio = true; }
    // Read by day.ts before this module loads; skipped here with their values.
    else if (flag === "--city" || flag === "--seed") { i += 1; }
  }
  return args;
}

async function context(): Promise<DayContext> {
  const started = performance.now();
  const ctx = await loadDayContext();
  const { world, roads, venues, affiliations, ties } = ctx;
  console.log(
    `${DIM}loaded ${world.persons.size.toLocaleString()} people, ${world.places.size.toLocaleString()} places, `
    + `${roads.graph.nodeCount.toLocaleString()} nodes, `
    + `${venues.size.toLocaleString()} venues, `
    + `${affiliations.orgs.size.toLocaleString()} orgs, `
    + `${ctx.stands?.length ?? 0} cab stands, `
    + `${ties.size.toLocaleString()} ties `
    + `in ${Math.round(performance.now() - started)} ms${OFF}\n`,
  );
  return ctx;
}

/**
 * Allocate the fleet for a date and report what it cost to do it.
 *
 * Separate from `context` because it is per-date and the context is not. Every
 * mode that plans a real day needs it first — a day planned without it is the
 * demand pass, and its taxi trips are requests nobody has answered.
 */
function dispatch(context: DayContext, date: Date, cohort?: Cohort, timings?: Timings): void {
  // Calls are drawn before the fleet so the taxi demand pass plans with this
  // date's holds; see `dispatchDate`. The two are timed together.
  const started = performance.now();
  dispatchDate(context, date, dayNumber(date), cohort, timings);
  const fleet = context.fleet!;
  const calls = context.calls!;
  const tally = fleetTally(fleet);
  console.log(
    `${DIM}dispatched ${tally.fares.toLocaleString()} fares to ${tally.working} of ${tally.drivers} `
    + `drivers on the road in ${Math.round(performance.now() - started)} ms${OFF}`,
  );
  context.householdPlanner = new HouseholdDayPlanner();
  const police = calls.responses.filter((r) => r.service === "police").length;
  console.log(
    `${DIM}dispatched ${calls.incidents.length.toLocaleString()} calls for service: ${police} police runs, `
    + `${calls.responses.length - police} ambulance runs, `
    + `${calls.incidents.filter((i) => i.disposition === "unserved").length} unserved, `
    + `in ${Math.round(performance.now() - started)} ms${OFF}\n`,
  );
}

function describeBlock(block: Block, world: World): string {
  const bits = [`${clock(block.start)}–${clock(block.end)}`, block.role ?? "work"];
  if (block.watch) bits.push(`${block.watch} watch`);
  if (block.duty) bits.push(block.duty);
  if (block.crew) bits.push(`crew ${block.crew}`);
  bits.push(`(${block.mode}${block.fixed ? "" : ", porous"})`);
  return bits.join("  ");
}

function timeline(context: DayContext, person: Person, date: Date): void {
  const { world } = context;
  const day = dayNumber(date);
  const assignment = world.assignments.get(person.id);
  const household = world.households.get(person.household);
  const home = homeOf(world, person);

  console.log(
    `${BOLD}person ${person.id}${OFF}  age ${person.age}  household ${person.household} `
    + `(size ${household?.size ?? "?"}, income ${household?.income?.toLocaleString() ?? "?"})`,
  );
  if (assignment) {
    console.log(
      `  ${assignment.class} · ${assignment.role ?? `occupation ${assignment.occupation}`} · `
      + `${assignment.mode}${assignment.site ? ` · ${assignment.site}` : ""}`
      + `${assignment.shift ? ` · ${assignment.shift.watch} watch` : ""}`,
    );
  } else {
    console.log(`  no work assignment`);
  }
  console.log(
    `  home ${home ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}` : "unplaced"} · `
    + `PUMS depart ${person.depart === null ? "—" : clock(person.depart)} `
    + `arrive ${person.arrive === null ? "—" : clock(person.arrive)} `
    + `travel ${person.travel ?? "—"}m · ${person.hours ?? 0} h/wk\n`,
  );

  console.log(`${BOLD}${WEEKDAY_NAMES[weekday(date)]} ${isoDate(date)}${OFF}`);

  const plan = planDay(context, person, date, day);
  const memberships = context.affiliations.of(person.id).filter((row) => row.class !== "work" && row.class !== "school");
  if (memberships.length > 0) {
    console.log(
      `  ${DIM}belongs to: ${memberships
        .map((row) => `${row.class}${row.role !== "member" ? ` (${row.role})` : ""} since ${row.since}`)
        .join(", ")}${OFF}`,
    );
  }

  const timeline = entries(plan);
  if (timeline.length === 0) {
    console.log(`  ${DIM}nothing planned (no work, meetings or errands)${OFF}`);
    return;
  }

  const COLOUR: Record<string, string> = { work: "", school: "", travel: DIM, affiliation: "", stop: "" };
  for (const entry of timeline) {
    const span = `${clock(entry.at)}–${clock(entry.end)}`.padEnd(13);
    console.log(`  ${COLOUR[entry.kind] ?? ""}${span} ${entry.kind.padEnd(11)} ${entry.label}${OFF}`);
  }

  for (const tour of plan.tours) {
    if (tour.note) console.log(`    ${DIM}${tour.note}${OFF}`);
  }
  console.log(
    `\n  ${DIM}${plan.drivenKm.toFixed(1)} km driven · ${plan.walkedKm.toFixed(1)} km walked · ${plan.trips} trips`
    + `${plan.late > 0 ? ` · ${plan.late} min late` : ""}${OFF}`,
  );
}

function week(context: CommuteContext, person: Person, from: Date): void {
  const { world } = context;
  const fromDay = dayNumber(from);
  console.log(`${BOLD}week from ${isoDate(from)}${OFF}`);
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(from);
    date.setDate(from.getDate() + i);
    const blocks = rosterFor(world, person, date, fromDay + i);
    if (blocks.length === 0) {
      console.log(`  ${WEEKDAY_NAMES[weekday(date)]}  ${DIM}off${OFF}`);
      continue;
    }
    for (const block of blocks) {
      const tour = commuteFor(context, person, block, fromDay + i);
      const outbound = tour.legs.find((leg) => leg.purpose === "work");
      const back = tour.legs.find((leg) => leg.purpose === "home");
      console.log(
        `  ${WEEKDAY_NAMES[weekday(date)]}  ${clock(block.start)}–${clock(block.end)}`
        + `  ${DIM}${outbound ? `leave ${clock(outbound.depart)}` : "no commute"}`
        + `${back ? `, home ${clock(back.arrive)}` : ""}${OFF}`,
      );
    }
  }
  const minutes = weeklyMinutes(world, person, from, fromDay);
  console.log(
    `\n  scheduled ${(minutes / 60).toFixed(1)} h against WKHP ${person.hours ?? 0} `
    + `(${person.hours ? (((minutes / 60) / person.hours - 1) * 100).toFixed(0) : "—"}%)`,
  );
}

/**
 * Who a sampled run touches, drawn once for the whole run.
 *
 * Each pass used to take this filter for itself, which was three walks of the
 * population to arrive at the same people and — more to the point — left the
 * dispatcher out of the arrangement entirely. The step is carried alongside the
 * people because the fleet has to be thinned by the same fraction: see
 * `dispatchFor`.
 */
function cohortOf(world: World, sampleSize: number): Cohort {
  const people = [...world.persons.values()];
  const step = Math.max(1, Math.floor(people.length / sampleSize));
  return { people: people.filter((_, i) => i % step === 0), step };
}

/** The aggregate checks. Every one of these has a number it should reproduce. */
function checks(context: DayContext, sample: readonly Person[], date: Date): void {
  const { world, roads } = context;
  const day = dayNumber(date);

  // Kept apart on purpose. Car and walk are now both routed, so both have an
  // independent estimate to check against PUMS, but they are calibrated by
  // different constants and pooling them would let one hide the other's drift.
  const travelSim: number[] = [];
  const travelPums: number[] = [];
  const walkSim: number[] = [];
  const walkPums: number[] = [];
  const walkKm: number[] = [];
  let noFootway = 0;
  const departs: number[] = [];
  const parkingKinds = new Map<string, number>();
  const modes = new Map<string, number>();
  let working = 0;
  let offMap = 0;
  let unplaced = 0;
  let hoursDrift = 0;
  let hoursChecked = 0;
  let kilometres = 0;

  const started = performance.now();
  for (const person of sample) {
    const blocks = rosterFor(world, person, date, day);
    if (blocks.length === 0) continue;
    working += 1;

    for (const block of blocks) {
      const tour = commuteFor(context, person, block, day);
      if (tour.offMap) offMap += 1;
      if (tour.legs.length === 0 && block.mode !== "home") unplaced += 1;
      kilometres += tourKilometres(tour);

      for (const leg of tour.legs) {
        modes.set(leg.mode, (modes.get(leg.mode) ?? 0) + 1);
        if (leg.purpose !== "work") continue;
        departs.push(((leg.depart % 1440) + 1440) % 1440);
        if (!leg.estimated && person.travel) {
          if (leg.mode === "walk") {
            walkSim.push(leg.arrive - leg.depart);
            walkPums.push(person.travel);
            walkKm.push(leg.kilometres);
          } else {
            travelSim.push(leg.arrive - leg.depart);
            travelPums.push(person.travel);
          }
        }
        if (leg.mode === "walk" && context.roads.walk(leg.from, leg.to).viaMotorway) noFootway += 1;
        if (leg.parking) parkingKinds.set(leg.parking.kind, (parkingKinds.get(leg.parking.kind) ?? 0) + 1);
      }
    }

    if (person.hours) {
      const scheduled = weeklyMinutes(world, person, date, day) / 60;
      hoursDrift += scheduled / person.hours - 1;
      hoursChecked += 1;
    }
  }
  const elapsed = performance.now() - started;

  const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

  console.log(`${BOLD}checks${OFF}  ${sample.length.toLocaleString()} people, ${WEEKDAY_NAMES[weekday(date)]} ${isoDate(date)}\n`);
  console.log(`  working today          ${working.toLocaleString()} (${((working / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  off-map blocks         ${offMap.toLocaleString()}`);
  console.log(`  no routable commute    ${unplaced.toLocaleString()}`);
  console.log();
  console.log(`  ${BOLD}commute time${OFF}    simulated median ${median(travelSim).toFixed(0)}m  mean ${mean(travelSim).toFixed(1)}m`);
  console.log(`  ${DIM}(driven)${OFF}        PUMS      median ${median(travelPums).toFixed(0)}m  mean ${mean(travelPums).toFixed(1)}m`);
  console.log(`                  ${DIM}simulated and PUMS should agree${OFF}`);
  console.log();
  console.log(`  ${BOLD}commute time${OFF}    simulated median ${median(walkSim).toFixed(0)}m  mean ${mean(walkSim).toFixed(1)}m`);
  console.log(`  ${DIM}(walked)${OFF}        PUMS      median ${median(walkPums).toFixed(0)}m  mean ${mean(walkPums).toFixed(1)}m`);
  console.log(
    `                  ${DIM}${walkSim.length.toLocaleString()} walks, median ${median(walkKm).toFixed(2)} km`
    + `${noFootway ? `, ${noFootway} routed along a road with no footway` : ""}${OFF}`,
  );
  console.log();
  console.log(`  ${BOLD}departure${OFF}       median ${clock(median(departs))}, ${departs.length.toLocaleString()} commutes`);
  console.log(`  ${BOLD}weekly hours${OFF}    mean drift from WKHP ${((hoursDrift / Math.max(1, hoursChecked)) * 100).toFixed(1)}%`);
  console.log(`  ${BOLD}driving${OFF}         ${(kilometres / Math.max(1, working)).toFixed(1)} km per working person`);
  console.log();
  console.log(`  ${BOLD}parking${OFF}`);
  const totalParked = [...parkingKinds.values()].reduce((a, b) => a + b, 0);
  for (const [kind, count] of [...parkingKinds].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(10)} ${String(count).padStart(6)}  ${((count / totalParked) * 100).toFixed(1)}%`);
  }
  console.log();
  console.log(`  ${BOLD}mode${OFF}`);
  const totalLegs = [...modes.values()].reduce((a, b) => a + b, 0);
  for (const [mode, count] of [...modes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mode.padEnd(10)} ${String(count).padStart(6)}  ${((count / totalLegs) * 100).toFixed(1)}%`);
  }
  console.log();
  const cache = roads.stats;
  console.log(
    `  ${DIM}${elapsed.toFixed(0)} ms for ${sample.length.toLocaleString()} people `
    + `(${((elapsed / sample.length) * 1000).toFixed(0)} µs each) · `
    + `route cache ${cache.cached.toLocaleString()} entries, ${((cache.hits / Math.max(1, cache.hits + cache.misses)) * 100).toFixed(0)}% hit${OFF}`,
  );
  console.log(
    `  ${DIM}extrapolated to ${world.persons.size.toLocaleString()} people: `
    + `${((elapsed / sample.length) * world.persons.size / 1000).toFixed(1)} s per simulated day${OFF}`,
  );
}

/**
 * Activity checks. Three of them have a published counterpart and one has
 * something better — a counterpart inside this repository.
 */
function activityChecks(context: DayContext, cohort: Cohort, date: Date): void {
  const { world, affiliations } = context;
  const day = dayNumber(date);
  const { people: sample, step } = cohort;

  const purposes = new Map<string, number>();
  const where = new Map<string, number>();
  let intercepted = 0;
  let standalone = 0;
  let trips = 0;
  let adults = 0;
  let allTrips = 0;
  let everyone = 0;
  let attended = 0;
  let couldHave = 0;
  const visited = new Map<string, number>();
  const legPurposes = new Map<string, number>();
  const legModes = new Map<string, number>();
  let lateMinutes = 0;
  let lateDays = 0;
  let drivenKm = 0;
  let walkedKm = 0;
  const meetPurposes = new Map<string, number>();
  const seenMeetings = new Set<string>();
  let meetAttendances = 0;
  let meetPeople = 0;
  let meetParties = 0;
  let meetLifts = 0;
  let meetTreated = 0;
  let meetHousehold = 0;
  /** Party sizes among gatherings from the tie graph, which is the thing a
   * convener-keyed draw can do and a pair-keyed one cannot. */
  const meetSizes = new Map<number, number>();
  let meetRejected = 0;

  const started = performance.now();
  for (const person of sample) {
    const plan = planDay(context, person, date, day);
    everyone += 1;
    allTrips += plan.trips;
    if (person.age >= 16) {
      adults += 1;
      trips += plan.trips;
      drivenKm += plan.drivenKm;
      walkedKm += plan.walkedKm;
    }
    for (const leg of plan.legs) {
      legPurposes.set(leg.purpose, (legPurposes.get(leg.purpose) ?? 0) + 1);
      legModes.set(leg.mode, (legModes.get(leg.mode) ?? 0) + 1);
    }
    if (plan.late > 0) {
      lateMinutes += plan.late;
      lateDays += 1;
    }
    // Only people who actually made a journey today can have intercepted
    // anything, so they are the only ones in the denominator. Pooling them
    // with the retired and the off-shift halves the number and hides whether
    // the corridor search is working.
    const travelled = plan.tours.some((t) => t.legs.length > 0);
    for (const stop of plan.plan.stops) {
      purposes.set(stop.purpose, (purposes.get(stop.purpose) ?? 0) + 1);
      where.set(stop.on, (where.get(stop.on) ?? 0) + 1);
      if (travelled) {
        if (stop.on === "to-work" || stop.on === "to-home") intercepted += 1;
        else standalone += 1;
      }
      visited.set(stop.venue.id, (visited.get(stop.venue.id) ?? 0) + 1);
    }
    for (const row of affiliations.of(person.id)) {
      if (row.class === "work" || row.class === "school" || row.class === "gym") continue;
      couldHave += 1;
    }
    attended += plan.attendance.filter((a) => a.occurrence.class !== "gym").length;

    let here = 0;
    for (const event of plan.scheduled.timeline) {
      if (event.kind !== "stay" || event.payload?.kind !== "meet") continue;
      // The pickup and the set-down are stays of the same kind at somebody's
      // door. Only the venue is the meeting.
      if (event.place.kind !== "venue") continue;
      const meeting = event.payload.meeting;
      here += 1;
      meetAttendances += 1;
      meetPurposes.set(meeting.purpose, (meetPurposes.get(meeting.purpose) ?? 0) + 1);
      if (meeting.payer === person.id) meetTreated += 1;
      // Counted once per gathering rather than once per attendee, which only
      // works because the id is derived from the party and not from either
      // person. A sampled cohort will hold one end of most of them.
      if (seenMeetings.has(meeting.id)) continue;
      seenMeetings.add(meeting.id);
      meetParties += meeting.parties.length;
      if (meeting.kind === "household") meetHousehold += 1;
      else meetSizes.set(meeting.parties.length, (meetSizes.get(meeting.parties.length) ?? 0) + 1);
      if (meeting.ride) meetLifts += 1;
    }
    if (here > 0) meetPeople += 1;
    meetRejected += plan.scheduled.rejected.filter((r) => r.intent.source === "meet").length;
  }
  const elapsed = performance.now() - started;

  console.log(`\n  ${BOLD}trips${OFF}           ${(allTrips / Math.max(1, everyone)).toFixed(2)} per person per day`);
  console.log(`                  ${DIM}NHTS 3.5–4.0 per person · ${(trips / Math.max(1, adults)).toFixed(2)} per adult${OFF}`);

  console.log(
    `                  ${DIM}${(drivenKm / Math.max(1, adults)).toFixed(1)} km driven and `
    + `${(walkedKm / Math.max(1, adults)).toFixed(2)} km walked per adult${OFF}`,
  );

  /**
   * Every trip, by what it was for and how it was made.
   *
   * The point of the table is that it has more than two rows in it. Before
   * `travel.ts` the only legs in the city were commutes, so every purpose here
   * except work and home was silently worth zero trips — the shop visit, the
   * meeting, the drive to the gym and the walk to lunch all happened with
   * nobody moving.
   */
  console.log(`\n  ${BOLD}trip purpose${OFF}`);
  const totalLegs = [...legPurposes.values()].reduce((a, b) => a + b, 0);
  for (const [purpose, count] of [...legPurposes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${purpose.padEnd(13)} ${String(count).padStart(6)}  ${((count / totalLegs) * 100).toFixed(1)}%`);
  }

  console.log(`\n  ${BOLD}trip mode${OFF}   ${DIM}all trips${OFF}`);
  for (const [mode, count] of [...legModes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mode.padEnd(13)} ${String(count).padStart(6)}  ${((count / totalLegs) * 100).toFixed(1)}%`);
  }

  console.log(
    `\n  ${BOLD}late${OFF}            ${lateDays.toLocaleString()} people late to a fixed commitment, `
    + `mean ${(lateMinutes / Math.max(1, lateDays)).toFixed(0)} min`,
  );
  console.log(`                  ${DIM}a high count means a layer schedules places the roads cannot connect in time${OFF}`);

  console.log(`\n  ${BOLD}stop purpose${OFF}`);
  const totalStops = [...purposes.values()].reduce((a, b) => a + b, 0);
  for (const [purpose, count] of [...purposes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${purpose.padEnd(13)} ${String(count).padStart(6)}  ${((count / totalStops) * 100).toFixed(1)}%`);
  }
  console.log(
    `\n  ${BOLD}intercepted${OFF}     ${((intercepted / Math.max(1, intercepted + standalone)) * 100).toFixed(1)}% `
    + `of stops by people who traveled today`,
  );
  console.log(`                  ${DIM}below the DEMAND propensity: many routes pass no suitable venue`);
  console.log(`                  under 20%: suspect the scheduler, not the corridor (Demand.slack in tours.ts)${OFF}`);

  // The habit check. A city where everyone shops everywhere has no regulars in
  // it, and regulars are the whole substitute for a membership at a venue.
  const counts = [...visited.values()].sort((a, b) => b - a);
  const topShare = counts.slice(0, Math.ceil(counts.length * 0.1)).reduce((a, b) => a + b, 0) / Math.max(1, totalStops);
  console.log(
    `  ${BOLD}concentration${OFF}   top 10% of venues take ${(topShare * 100).toFixed(0)}% of visits, `
    + `${counts.length} venues used`,
  );

  console.log(
    `  ${BOLD}attendance${OFF}      ${((attended / Math.max(1, couldHave)) * 100).toFixed(1)}% of non-gym memberships `
    + `produced a visit today`,
  );

  /**
   * Shared activities, and the one aggregate they exist to move.
   *
   * Occupancy is the number to watch. NHTS puts the average car at about 1.67
   * people; before this layer existed the only passengers in this city were
   * children being taken to school and it read 1.12, which is not a city where
   * anybody ever goes anywhere with anybody. It is a ratio of legs and not of
   * person-kilometres, so it is not the same statistic NHTS publishes — but it
   * is the same direction, and the gap between it and 1.67 is the honest size
   * of what is still missing.
   */
  const carLegs = (legModes.get("car") ?? 0) + (legModes.get("carpool") ?? 0);
  const occupancy = (carLegs + (legModes.get("passenger") ?? 0)) / Math.max(1, carLegs);
  console.log(`\n  ${BOLD}meetings${OFF}  ${DIM}arranged gatherings${OFF}`);
  console.log(
    `    who            ${((meetPeople / Math.max(1, everyone)) * 100).toFixed(1)}% of people had one today, `
    + `${(meetAttendances / Math.max(1, everyone)).toFixed(2)} each`,
  );
  console.log(
    `    gatherings     ${seenMeetings.size.toLocaleString()} seen, ${meetHousehold} of them a whole household, `
    + `${(meetParties / Math.max(1, seenMeetings.size)).toFixed(2)} people at each`,
  );
  const sizes = [...meetSizes].sort((a, b) => a[0] - b[0]);
  const hosted = sizes.reduce((total, [, count]) => total + count, 0);
  const beyondPairs = sizes.filter(([size]) => size > 2).reduce((total, [, count]) => total + count, 0);
  console.log(
    `    group size     ${sizes.map(([size, count]) => `${size}:${count}`).join("  ")}`
    + `${DIM}  ${((beyondPairs / Math.max(1, hosted)) * 100).toFixed(0)}% of arranged gatherings are more than two people${OFF}`,
  );
  console.log(
    `    travel         ${((meetLifts / Math.max(1, seenMeetings.size)) * 100).toFixed(0)}% arrived in one car; `
    + `${((meetTreated / Math.max(1, meetAttendances)) * 100).toFixed(0)}% of attendances paid the bill`,
  );
  console.log(
    `    occupancy      ${occupancy.toFixed(2)} people per car leg`
    + `${DIM}  NHTS 1.67; counts legs, not person-km${OFF}`,
  );
  if (meetRejected > 0) {
    console.log(
      `    unreachable    ${meetRejected} arrangements with no feasible route`
      + `${DIM}  still planned by both parties; a high count is a bug${OFF}`,
    );
  }
  if (meetPurposes.size > 0) {
    const total = [...meetPurposes.values()].reduce((a, b) => a + b, 0);
    for (const [purpose, count] of [...meetPurposes].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${purpose.padEnd(14)} ${String(count).padStart(5)}  ${((count / total) * 100).toFixed(1)}%`);
    }
  }

  /**
   * The exposure check.
   *
   * `ties.py` assigned every edge in the social graph a share of days on which
   * the two people are in the same room, and weighted the whole graph by it.
   * This layer decides whether that is true. Two members of one unit are
   * simulated over three weeks and the days they were both there are counted;
   * if the answer is not the number the graph was built on, one of the two is
   * wrong and it is worth knowing which before anything is built on either.
   */
  /**
   * How many units per class the window is measured over.
   *
   * This is by far the most expensive thing the checks do and it used to be a
   * flat 260 — seven classes over four weeks, two people each, which is a
   * hundred thousand planned days whether the run asked for the whole city or
   * for one person. It is thinned by the cohort's step like everything else.
   *
   * The units themselves are still drawn from the whole affiliation layer
   * rather than from the cohort, because the question here is whether the
   * cadences in `affiliations.ts` reproduce the exposure `ties.py` assumed, and
   * that is a fact about the layer and not about who was sampled. What a small
   * cohort costs is precision: a rate measured over a handful of pairs is
   * mostly noise, so a drift flagged here on a thin run is worth re-checking at
   * full size before it is believed.
   */
  const wanted = Math.max(1, Math.round(260 / step));

  console.log(`\n  ${BOLD}exposure${OFF}  ${DIM}simulated co-attendance against the target ties.py used`
    + `${step > 1 ? `, ${wanted} units per class` : ""}${OFF}`);
  console.log(`    ${"class".padEnd(11)} ${"target".padStart(7)} ${"sim".padStart(7)} ${"attend".padStart(7)}  cadence`);

  for (const orgClass of ["worship", "sports", "civic", "fraternal", "youth", "union", "gym"]) {
    const units = affiliations.unitsOfClass(orgClass, 2);
    if (units.length === 0) continue;
    const stride = Math.max(1, Math.floor(units.length / wanted));

    // The window has to contain a whole number of the cadence being measured.
    // Three weeks against a local that meets monthly is a coin toss between
    // 0.00 and 0.05, and neither number is about the model.
    const cadence = CADENCE[orgClass];
    const perWeek = cadence ? cadence.org + cadence.unit : 7;
    const DAYS = perWeek >= 1 ? 28 : Math.round(28 / perWeek);

    let both = 0;
    let dayCount = 0;
    for (let u = 0; u < units.length; u += stride) {
      const unit = units[u]!;
      const a = world.persons.get(unit[0]!.person);
      const b = world.persons.get(unit[1]!.person);
      if (!a || !b) continue;
      for (let d = 0; d < DAYS; d += 1) {
        const when = new Date(date);
        when.setDate(date.getDate() + d);
        const aDay = planDay(context, a, when, day + d);
        const bDay = planDay(context, b, when, day + d);
        const aHere = aDay.attendance.some((v) => v.occurrence.org === unit[0]!.org);
        const bHere = bDay.attendance.some((v) => v.occurrence.org === unit[1]!.org);
        if (aHere && bHere) both += 1;
        dayCount += 1;
      }
    }

    const simulated = both / Math.max(1, dayCount);
    const target = EXPOSURE[orgClass] ?? 0;
    const implied = orgClass === "gym" ? GYM_VISITS_PER_WEEK / 7 : impliedAttendance(orgClass);
    const drift = target > 0 ? (simulated / target - 1) * 100 : 0;
    // An attendance this high is not a model that fits, it is a model with no
    // headroom: the class reaches its target only because almost nobody ever
    // misses, which means the cadence or the target is wrong.
    const flag = Math.abs(drift) > 35 ? "  ← off" : implied > 0.95 ? "  ← pinned" : "";
    console.log(
      `    ${orgClass.padEnd(11)} ${target.toFixed(3).padStart(7)} ${simulated.toFixed(3).padStart(7)} `
      + `${implied.toFixed(2).padStart(7)}  ${cadence ? `${cadence.org + cadence.unit}/wk` : `${GYM_VISITS_PER_WEEK.toFixed(1)} visits/wk`}`
      + `${DIM}  ${drift >= 0 ? "+" : ""}${drift.toFixed(0)}%${OFF}${flag}`,
    );
  }
  console.log(
    `    ${DIM}pinned: target reached only at near-universal attendance; cadence likely too sparse (LIFT in affiliations.ts)${OFF}`,
  );

  console.log(
    `\n  ${DIM}${elapsed.toFixed(0)} ms for activities over ${sample.length.toLocaleString()} people${OFF}`,
  );
}

/**
 * Taxi checks: is the fleet the right size, and is it driving sensibly?
 *
 * The load-bearing one is the empty share. A dispatcher that is working sends
 * cars a short way to fares that are near them, and the published figure for a
 * real taxi fleet is that somewhere between two fifths and a half of the miles
 * it turns have nobody in the back. A simulation well under that has cabs
 * teleporting to their fares; one well over has too few cars covering too much
 * map, which is the same thing the unserved share reports from the other end.
 *
 * The drift check is the one that guards the construction rather than the
 * result. `taxi.ts` closes its two passes by having the passenger plan against
 * a constant wait, so the minute they ask for a car is the same before and
 * after the cars are allocated. If that stops being true — because a fare's
 * first trip ran late and pushed their second one — the assignment is addressed
 * to a request that no longer exists at that minute, and this is where it shows.
 */
/** Fares in a shift above which a driver is having a working day, not a quiet one. */
const BUSY_SHIFT = 5;

/**
 * The patrol layer, checked against the force rather than against the sample.
 *
 * Two hundred and ten officers is a small enough population to plan whole, and
 * a sampled one would tell you nothing: at one person in thirty the cohort
 * holds six of them, and the question here is how many units the city has on
 * the road at once, which is a fact about all of them.
 *
 * The mileage is the number with a counterpart. A municipal patrol unit turns
 * roughly sixty to a hundred and thirty kilometres on an eight-hour shift; this
 * should land in the lower half of that, because the simulated unit drives
 * between its stops and does not cruise between them. See `patrol.ts`.
 */
function patrolChecks(context: DayContext, date: Date): void {
  const { world, roads } = context;
  const day = dayNumber(date);

  interface Watch { onDuty: number; units: number; km: number; stops: number; driving: number }
  const watches = new Map<string, Watch>();
  const cars = new Set<string>();
  let unitDays = 0;

  for (const assignment of world.assignments.values()) {
    if (assignment.role !== "police_officer" || assignment.duty !== "patrol") continue;
    const person = world.persons.get(assignment.person);
    const watch = assignment.shift?.watch;
    if (!person || !watch) continue;
    const block = rosterFor(world, person, date, day).find((row) => row.kind === "work");
    if (!block) continue;

    const row = watches.get(watch) ?? { onDuty: 0, units: 0, km: 0, stops: 0, driving: 0 };
    row.onDuty += 1;
    watches.set(watch, row);

    const unit = unitFor(world, roads, person, block, date, day);
    if (!unit) continue;
    row.units += 1;
    unitDays += 1;
    cars.add(unit.vin);

    const legs = planDay(context, person, date, day).legs.filter((leg) => leg.mode === "patrol");
    row.km += patrolKilometres(legs);
    row.stops += legs.length;
    row.driving += legs.reduce((total, leg) => total + (leg.arrive - leg.depart), 0);
  }

  if (unitDays === 0) return;
  const fleet = [...world.fleet.patrolCars.values()].reduce((total, mine) => total + mine.length, 0);
  console.log(`\n  ${BOLD}patrol${OFF}  ${DIM}units by watch${OFF}`);
  console.log(`    ${"watch".padEnd(9)} ${"units".padStart(12)} ${"km/unit".padStart(9)} ${"stops".padStart(7)} ${"moving".padStart(8)}`);
  for (const [watch, row] of [...watches].sort()) {
    const share = row.onDuty === 0 ? 0 : (row.units / row.onDuty) * 100;
    console.log(
      `    ${watch.padEnd(9)} ${`${row.units}/${row.onDuty}`.padStart(7)} ${`${share.toFixed(0)}%`.padStart(4)} `
      + `${(row.km / Math.max(1, row.units)).toFixed(0).padStart(8)} `
      + `${(row.stops / Math.max(1, row.units)).toFixed(0).padStart(7)} `
      + `${`${(row.driving / Math.max(1, row.units)).toFixed(0)}m`.padStart(8)}`,
    );
  }
  const km = [...watches.values()].reduce((total, row) => total + row.km, 0);
  console.log(
    `    ${DIM}${unitDays} unit-shifts over ${cars.size} of ${fleet} cars, ${km.toFixed(0)} fleet km`
    + `; real units: 60–130 km a shift${OFF}`,
  );
}

function taxiChecks(context: DayContext, date: Date, cohort?: Cohort): void {
  const { world, roads } = context;
  const fleet = context.fleet;
  if (!fleet) return;
  const day = dayNumber(date);
  const tally = fleetTally(fleet);

  let loaded = 0;
  let empty = 0;
  let driverDays = 0;
  let brokenDays = 0;
  // The same split over the drivers who actually had a shift's worth of work.
  // It mattered when the fleet was much larger than the demand and the
  // all-drivers figure was mostly the drive out and the drive back; with the
  // hire layer in place the two have converged, which is itself the finding.
  let busyLoaded = 0;
  let busyEmpty = 0;
  let busyDrivers = 0;
  // The drivers who were actually put on the road, rather than everybody the
  // employment layer calls a cabbie. The two are the same set on a full run —
  // a driver with no shift has no cab kilometres and was skipped below anyway
  // — but on a thinned fleet only this one is right, and it is a walk of a
  // hundred-odd cabs instead of every assignment in the city. A driver with
  // two shifts appears twice in `cabs` and must still be planned once.
  const driving = new Set(fleet.cabs.map((cab) => cab.person));
  for (const id of driving) {
    const person = world.persons.get(id);
    if (!person) continue;
    const plan = planDay(context, person, date, day);
    if (plan.cabKm.loaded + plan.cabKm.empty === 0) continue;
    driverDays += 1;
    loaded += plan.cabKm.loaded;
    empty += plan.cabKm.empty;
    if (fleet.jobsFor(person.id).length >= BUSY_SHIFT) {
      busyDrivers += 1;
      busyLoaded += plan.cabKm.loaded;
      busyEmpty += plan.cabKm.empty;
    }
    // A day the chain could not close is a day with no legs in it. The fares
    // were still assigned, so the fleet numbers above are right and this one
    // says how much of the driving they imply went missing.
    if (plan.legs.length === 0) brokenDays += 1;
  }

  const drifts: number[] = [];
  let matched = 0;
  let riders = 0;
  let stated = 0;
  for (const person of cohort?.people ?? world.persons.values()) {
    if (hirerFor(world, person, context.hire).usual !== "taxi") continue;
    riders += 1;
    if (person.transport === "7") stated += 1;
    for (const leg of planDay(context, person, date, day).legs) {
      if (leg.mode !== "taxi") continue;
      const asked = fleet.requestedAt(person.id, leg.from, leg.to, leg.depart);
      if (asked === null) continue;
      matched += 1;
      if (Math.abs(leg.depart - asked) > 1) drifts.push(Math.abs(leg.depart - asked));
    }
  }
  drifts.sort((a, b) => a - b);

  const requests = tally.fares + fleet.tally.walk + fleet.tally.transit;
  const share = (n: number) => `${((n / Math.max(1, requests)) * 100).toFixed(1)}%`;
  const waits = [...tally.waits].sort((a, b) => a - b);
  const median = waits[Math.floor(waits.length / 2)] ?? 0;
  const mean = waits.reduce((a, b) => a + b, 0) / Math.max(1, waits.length);
  const km = loaded + empty;

  console.log(`\n  ${BOLD}taxi${OFF}  ${DIM}fleet and demand${OFF}`);
  console.log(
    `    fleet         ${tally.drivers} drivers, ${tally.working} took a fare today, `
    + `${riders.toLocaleString()} people can order one `
    + `${DIM}(${stated} commute by cab, others have no car; see hire.ts)${OFF}`,
  );
  if (fleet.unavailable > 0) {
    console.log(`    ${fleet.unavailable} on-duty shifts could not obtain a free registered taxi`);
  }
  console.log(
    `    fares         ${tally.fares.toLocaleString()} of ${requests.toLocaleString()} requests, `
    + `${(tally.fares / Math.max(1, tally.working)).toFixed(1)} per driver who worked`,
  );
  console.log(`                  ${DIM}real cabs: 15–25 a shift; well under means more cars than trips`);
  console.log(`                  near the top of the range, check the unserved share instead${OFF}`);
  console.log(
    `    wait          median ${median.toFixed(0)}m  mean ${mean.toFixed(1)}m  `
    + `${DIM}against the ${NOMINAL_WAIT}m the passenger allowed${OFF}`,
  );
  console.log(
    `    outcome       straight away ${share(fleet.tally.ride)} · after walking on ${share(fleet.tally.relay)}`
    + ` · walked instead ${share(fleet.tally.walk)} · no cab ${share(fleet.tally.transit)}`,
  );
  const busyKm = busyLoaded + busyEmpty;
  console.log(
    `    cab km        ${km.toFixed(0)} km over ${driverDays} driver-days, `
    + `${((empty / Math.max(1, km)) * 100).toFixed(0)}% of it empty`,
  );
  console.log(
    `                  ${busyKm.toFixed(0)} km over the ${busyDrivers} who took ${BUSY_SHIFT} fares or more, `
    + `${((busyEmpty / Math.max(1, busyKm)) * 100).toFixed(0)}% empty`,
  );
  console.log(`                  ${DIM}real fleets: 40–50% empty; above that means too little demand${OFF}`);
  console.log(
    `    request drift ${drifts.length} of ${matched} fares departed over a minute from their dispatch time, `
    + `median ${(drifts[Math.floor(drifts.length / 2)] ?? 0).toFixed(0)}m, `
    + `max ${(drifts[drifts.length - 1] ?? 0).toFixed(0)}m`,
  );
  console.log(`                  ${DIM}cause: an earlier trip by the same passenger ran late (taxi.ts)${OFF}`);
  if (brokenDays > 0) {
    console.log(`    ${BOLD}${brokenDays} driver days with an unclosed chain${OFF}`);
  }
  void roads;
}

/**
 * Route every bus run and write down how long it really takes.
 *
 * This closes the one loop in the pipeline that runs backwards. `school_travel.py`
 * has to decide which bus covers which runs, and that decision needs each run's
 * duration — but the init stages are Python with no road graph, so the first
 * pass can only estimate it from straight-line distance at an assumed speed.
 * The estimate is optimistic, mostly because a run that serves several schools
 * ends with a long delivery leg no crow-flies figure anticipates, and a bus
 * scheduled on it cannot make the next tier's bell.
 *
 * So the simulation measures, and the init stage reads what it measured. One
 * pass is enough, and that is worth being precise about rather than trusting:
 * a run's stops, their order and its manifest are decided from the riders
 * alone, and nothing in `build_runs` consults the fleet. Only the *assignment*
 * of vehicles to runs uses the duration. So feeding measured durations back
 * cannot change the runs that were measured — the second pass reschedules the
 * same routes with honest numbers and the loop closes.
 *
 * If the file is stale — a re-run of `school_travel.py` with a different seed
 * renames every run — the ids simply miss and the estimate is used, which the
 * stage reports rather than silently accepting.
 */
async function measureRuns(context: DayContext): Promise<void> {
  const { world, roads } = context;
  const runs = [...world.school.runs.values()];
  const measured: Record<string, {
    fingerprint: string; span: number; kilometres: number; depart: number; ret: number;
  }> = {};

  const started = performance.now();
  let drift = 0;
  let optimistic = 0;
  for (const run of runs) {
    const clock = timing(world, roads, run);
    if (!clock) continue;
    measured[run.id] = {
      // The key the init stage actually matches on. The id is kept as the map
      // key only because it reads better in the file.
      fingerprint: run.fingerprint,
      span: clock.span,
      kilometres: Math.round(clock.kilometres * 100) / 100,
      depart: clock.depart,
      ret: clock.ret,
    };
    drift += clock.span - run.estimated_minutes;
    if (clock.span > run.estimated_minutes) optimistic += 1;
  }

  const path = join(SIM_DATA_DIR, "school_runs_measured.json");
  await Bun.write(path, JSON.stringify({
    source: "school_travel.json",
    runs: measured,
  }));

  const spans = Object.values(measured).map((m) => m.span).sort((a, b) => a - b);
  const km = Object.values(measured).reduce((total, m) => total + m.kilometres, 0);
  console.log(`${BOLD}measured ${spans.length} of ${runs.length} runs${OFF} in ${Math.round(performance.now() - started)} ms`);
  console.log(
    `  span   median ${spans[Math.floor(spans.length / 2)]} min  `
    + `shortest ${spans[0]} min  longest ${spans[spans.length - 1]} min`,
  );
  console.log(`  fleet  ${km.toFixed(0)} km a day, ${(km / Math.max(1, spans.length)).toFixed(1)} km per run`);
  console.log(
    `  ${DIM}${optimistic} of ${spans.length} runs take longer than the init estimate, `
    + `mean drift ${(drift / Math.max(1, spans.length)).toFixed(1)} min per run${OFF}`,
  );
  console.log(`
wrote ${path}`);
  console.log(`${DIM}re-run school_travel.py to reschedule the fleet${OFF}`);
}

/**
 * Write the part of the taxi layer that is the same every day.
 *
 * The counterpart of `measureRuns`, and the opposite direction: that one hands
 * a measurement back to an init stage, this one hands a derivation forward to
 * a viewer. What KierstonBlue can work out for itself it does — a driver is an
 * assignment with a role in employment.json, a cab commuter is a JWTRNS answer
 * — and what it cannot is the geometry, because the clustering and the habit
 * are both drawn through `rng.ts` from the population seed. Re-deriving those
 * in the browser would put ranks on a map that no driver in this simulation
 * waits at. See `taxi.ts`'s `geography`.
 *
 * Nothing here depends on a date, so there is no `--date` to pass: a fare is a
 * day's business and none of it is in this file.
 */
async function exportTaxi(context: DayContext): Promise<void> {
  const { world } = context;
  const all = context.stands ?? stands(world);
  const layer = geography(world, all);

  const path = join(SIM_DATA_DIR, "taxi.json");
  await Bun.write(path, JSON.stringify(
    { source: "sim/src/transport/taxi.ts", seed: world.seed, ...layer },
    // Six decimal places is about a tenth of a metre, which is finer than any
    // coordinate in this simulation means anything at, and it keeps the file
    // from being mostly float noise.
    (_key, value) => (typeof value === "number" && !Number.isInteger(value)
      ? Math.round(value * 1e6) / 1e6
      : value),
  ));

  const placed = layer.riders.filter((rider) => rider.home !== null).length;
  console.log(`${BOLD}wrote ${layer.stands.length} stands${OFF} to ${path}`);
  for (const [index, stand] of layer.stands.entries()) {
    const drivers = layer.drivers.filter((driver) => driver.stand === index).length;
    console.log(
      `  ${stand.id.padEnd(9)} ${stand.lat.toFixed(5)}, ${stand.lon.toFixed(5)}  `
      + `${String(stand.mass).padStart(4)} demand points  ${String(drivers).padStart(3)} drivers`,
    );
  }
  console.log(
    `\n  ${layer.drivers.length} drivers, ${layer.riders.length} people who commute by cab `
    + `${DIM}(${placed} with a home location)${OFF}`,
  );
}

/**
 * One person's day as their bank sees it.
 *
 * Printed beside the timeline rather than instead of it, because the whole
 * claim of `spend.ts` is that the two line up — the money leaves at the till
 * and not at the door, and the way to see whether it does is to read them
 * against each other.
 */
function ledger(context: DayContext, person: Person, date: Date): void {
  const bank = context.bank!;
  const day = dayNumber(date);
  const planned = planDay(context, person, date, day);
  const posted = settleDay(bank, context, person, planned, day,
                           billsDue(context, person, date, day, planned),
                           incomeDue(context, person, date, day));

  console.log(`\n${BOLD}money${OFF}`);
  if (posted.length === 0) {
    console.log(`  ${DIM}no transactions (no priced stop, fare or parking)${OFF}`);
    return;
  }

  for (const tx of posted) {
    const what = tx.kind === "transfer_in"
      ? `from ${tx.sender}${tx.memo ? ` ${DIM}(${tx.memo})${OFF}` : ""}`
      : tx.kind === "card_payment"
      ? `card payment · ${tx.merchant} ····${tx.card}`
      : tx.kind === "withdrawal"
      ? `cash out · ${tx.merchant}`
      : `${tx.merchant}${tx.mcc ? ` ${DIM}(${tx.mcc})${OFF}` : ""}`;
    const how = tx.approved
      ? `${tx.instrument}${tx.card ? ` ····${tx.card}` : ""}`
      : `${DIM}declined: ${tx.decline}${OFF}`;
    console.log(
      `  ${clock(tx._timestamp).padEnd(7)} ${`$${tx.amount.toFixed(2)}`.padStart(9)}  `
      + `${how.padEnd(28)} ${what}`,
    );
  }

  const spent = posted
    .filter((tx) => tx.approved && tx.kind === "payment")
    .reduce((total, tx) => total + tx.amount, 0);
  const position = bank.position(person.id);
  const cash = position.accounts.find((account) => account.type === "cash");
  console.log(
    `\n  ${DIM}$${spent.toFixed(2)} spent across ${posted.length} transactions · `
    + `$${(cash?.balance ?? 0).toFixed(2)} in pocket · `
    + `$${position.accounts.filter((a) => a.type !== "cash")
      .reduce((total, a) => total + a.balance, 0).toFixed(2)} on deposit${OFF}`,
  );
}

/**
 * The city's spending for one date, against the surveys it should reproduce.
 *
 * Two of them, doing different jobs. CEX says what a household spends in a
 * year by category, which is what the ticket sizes are answerable to; DCPC
 * says how many payments a person makes in a day and what share of them are
 * cash, which is what the *instrument* choice in `bank/routing.ts` is
 * answerable to — and that table has never been put against a number before.
 *
 * The annualised column is one weekday multiplied out, so it overstates
 * anything the weekend suppresses and understates the rest. It is a scale
 * check, not a fit, and the fit wants a week.
 */
function moneyChecks(context: DayContext, sample: readonly Person[], date: Date): void {
  const { world } = context;
  const bank = context.bank!;
  const day = dayNumber(date);

  const byReason = new Map<string, number[]>();
  const BILL_REASONS = new Set<string>(BILL_KINDS);
  // Declines by reason, because the headline rate on its own cannot say
  // whether the city is short of money or short of it on the 1st. A run where
  // every decline is a rent and none is a coffee is a run whose balances were
  // generated without knowing what was going to be asked of them.
  const declinedBy = new Map<string, number>();
  const byInstrument = new Map<string, number>();
  let transactions = 0;
  let declined = 0;
  let withdrawn = 0;
  let spent = 0;
  let settled = 0;
  let received = 0;
  let people16 = 0;

  const started = performance.now();
  for (const person of sample) {
    if (person.age >= 16) people16 += 1;
    // One plan, read twice. The two halves of this report want different
    // things — the category table wants charges with their `reason` still on
    // them, the instrument table wants what the bank posted — and `settleDay`
    // does not hand back the charges it priced. Planning a second day to get
    // them is the expensive half of the run for no gain, and worse than that:
    // the two tables would then be describing two different days.
    const plan = planDay(context, person, date, day);
    const bills = billsDue(context, person, date, day, plan);
    for (const charge of [...chargesFor(context, person, plan, day), ...bills]) {
      const list = byReason.get(charge.reason);
      if (list) list.push(charge.amount);
      else byReason.set(charge.reason, [charge.amount]);
    }
    for (const tx of settleDay(bank, context, person, plan, day, bills,
                               incomeDue(context, person, date, day))) {
      if (tx.kind === "withdrawal") { if (tx.approved) withdrawn += tx.amount; continue; }
      // Wages and benefits are movements, not payments, and counting them in
      // the transaction rate would put this figure against a DCPC number that
      // counts neither.
      if (tx.kind === "transfer_in") { if (tx.approved) received += tx.amount; continue; }
      // A card payment is a transaction and is counted as one, but it is not
      // spending: the money it moves was spent at a till weeks ago and is
      // already in `spent`. Adding it again would count the same dollar twice,
      // which is why CE treats a card payment as a transfer too.
      if (tx.kind === "card_payment") {
        transactions += 1;
        if (tx.approved) {
          settled += tx.amount;
          byInstrument.set("card payment", (byInstrument.get("card payment") ?? 0) + 1);
        } else declined += 1;
        continue;
      }
      transactions += 1;
      if (!tx.approved) {
        declined += 1;
        declinedBy.set(tx.reason, (declinedBy.get(tx.reason) ?? 0) + 1);
        continue;
      }
      spent += tx.amount;
      byInstrument.set(tx.instrument ?? "?", (byInstrument.get(tx.instrument ?? "?") ?? 0) + 1);
    }
  }

  // Per household rather than per person, because that is the unit CEX
  // reports: a consumer unit, which here is a dwelling's worth of people.
  const size = [...world.households.values()].reduce((total, h) => total + h.size, 0)
    / Math.max(1, world.households.size);
  const annual = (perPersonDay: number) => perPersonDay * 365 * size;

  console.log(`\n${BOLD}spending${OFF}  ${DIM}${sample.length.toLocaleString()} people, `
    + `${isoDate(date)}, ${Math.round(performance.now() - started)} ms${OFF}`);
  console.log(
    `  ${transactions.toLocaleString()} transactions · `
    // 0.93 and not 1.55. DCPC counts 47.2 payments a month, but 10 of those
    // are bills and 8.9 are remote purchases, and this module raises neither —
    // it only charges for somewhere a person physically went. The comparable
    // figure is in-person purchases alone, 28.3 a month.
    + `${(transactions / sample.length).toFixed(2)} per person-day ${DIM}(DCPC in-person ≈ 0.93 for adults)${OFF} · `
    + `${(transactions / Math.max(1, people16)).toFixed(2)} per adult-day`,
  );
  console.log(
    `  $${spent.toFixed(0)} spent · $${(spent / sample.length).toFixed(2)} per person-day · `
    + `${DIM}${(100 * declined / Math.max(1, transactions)).toFixed(2)}% declined · `
    + `$${withdrawn.toFixed(0)} withdrawn · $${settled.toFixed(0)} paid onto cards · `
    + `$${received.toFixed(0)} received${OFF}`,
  );

  console.log(`\n  ${DIM}instrument${OFF}`);
  for (const [instrument, count] of [...byInstrument].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${instrument.padEnd(8)} ${(100 * count / (transactions - declined)).toFixed(1)}%`);
  }

  const worst = [...declinedBy].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (worst.length) {
    console.log(`\n  ${DIM}declined${OFF}`);
    for (const [reason, count] of worst) {
      console.log(`    ${reason.padEnd(16)} ${String(count).padStart(5)} `
        + `${DIM}${(100 * count / declined).toFixed(1)}% of declines${OFF}`);
    }
  }

  console.log(`\n  ${DIM}category${" ".repeat(6)}charges   median      mean   annualized/household${OFF}`);
  const rows = [...byReason].sort((a, b) =>
    b[1].reduce((t, v) => t + v, 0) - a[1].reduce((t, v) => t + v, 0));
  for (const [reason, amounts] of rows) {
    const sorted = [...amounts].sort((a, b) => a - b);
    const total = amounts.reduce((t, v) => t + v, 0);
    // No annualised figure for a bill. The column multiplies one day out by
    // 365, which is the right arithmetic for something somebody might do on
    // any day and nonsense for something that happens on the 1st: it reported
    // a quarter of a million dollars of rent per household per year. What a
    // day's bills annualise to is in `recurring_spending.py`'s own report,
    // which knows each rule's cadence and can multiply by the right number.
    const yearly = BILL_REASONS.has(reason)
      ? `${DIM}—${OFF}`.padStart(19)
      : `$${annual(total / sample.length).toFixed(0)}`.padStart(11);
    console.log(
      `    ${reason.padEnd(13)} ${String(amounts.length).padStart(7)}  `
      + `${`$${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)}`.padStart(7)}  `
      + `${`$${(total / amounts.length).toFixed(2)}`.padStart(8)}  ${yearly}`,
    );
  }
  // The median column is the one that is answerable to a number, because that
  // is what `TICKETS` was fitted on. The annualised column is not: it is one
  // weekday multiplied out, and it carries the trip generator's errors as well
  // as this module's — a grocery median that is exactly right still annualises
  // low when `tours.ts` delivers half the shopping trips its own table asks for.
  console.log(
    `\n  ${DIM}CE Diary 2024 weighted median per occasion (ticket fit target):`
    + `\n  grocery $49.10, food-sit $35.00, food-quick $12.80, convenience $9.11, cafe $4.99,`
    + `\n  retail $8.23, personal $27.13, pharmacy $10.44, fuel $40.05, vehicle $32.12.`
    + `\n  Medians should match. Annualized totals read low because trip counts are short.${OFF}`,
  );
}

/**
 * The radio layer at aggregate, against what a real network would show.
 *
 * Four questions, and each is one a wrong model fails differently:
 *
 *   movement    handovers should track how far somebody went. A day with the
 *               same rate for a driver and a sleeper is a day where the
 *               hysteresis is broken, which is the single most likely fault in
 *               `attach.ts` and the one that is invisible in any one person's
 *               timeline.
 *
 *   layers      the share of attached minutes by band. A macro network that
 *               carries nothing on its mid bands has a link budget with a
 *               missing term; one that carries everything there has lost the
 *               indoor penetration.
 *
 *   operators   attached minutes per network against the subscriptions
 *               `devices.py` sold. They should agree closely, and the gap is
 *               where somebody's own network failed to reach them.
 *
 *   demand      busy-hour load per cell against the demand surface
 *               `towers.py` sited the network on. The two models were built
 *               independently and from different data; if the cells that
 *               actually carry the city are not the cells the planner put
 *               where the people are, one of them is wrong.
 */
function radioChecks(context: DayContext, people: readonly Person[], date: Date): void {
  const network = context.network;
  if (!network) return;
  const day = dayNumber(date);
  const out = emptyDayNetwork();

  const byLayer = new Float64Array(RADIO_LAYERS.length);
  const byOperator = new Float64Array(4);
  const subsPerOperator = new Float64Array(4);
  const causes = new Map<string, number>();
  const load = new Map<number, number>();
  /** Handovers and reselections against kilometres, in four distance bands. */
  const bands = [0, 1, 5, 20];
  const moves = new Float64Array(bands.length);
  const days = new Float64Array(bands.length);
  let attachedMinutes = 0;
  let totalMinutes = 0;
  let roamed = 0;
  let subscribers = 0;

  for (const person of people) {
    const mine = network.subscribers.forPerson(person.id);
    if (mine.length === 0) continue;
    const planned = planDay(context, person, date, day);
    out.spans.length = 0;
    out.events.length = 0;
    network.day(planned, homeOf(context.world, person), day, context.world.seed, null, out);

    const km = planned.drivenKm + planned.walkedKm;
    let band = 0;
    while (band + 1 < bands.length && km >= bands[band + 1]!) band += 1;

    for (const subscriber of mine) {
      subscribers += 1;
      subsPerOperator[subscriber.operator]! += 1;
      days[band]! += 1;
    }
    for (const span of out.spans) {
      const held = span.end - span.start;
      totalMinutes += held;
      if (span.cell === UNATTACHED) continue;
      attachedMinutes += held;
      byLayer[network.cells.layerOf(span.cell)]! += held;
      const operator = network.cells.operatorOf(span.cell);
      byOperator[operator]! += held;
      const owner = network.subscribers.all[span.subscriber]!;
      if (operator !== owner.operator) roamed += held;
      // Busy hour, taken as the eight-to-nine window every network peaks in.
      if (span.start < 540 && span.end > 480) {
        load.set(span.cell, (load.get(span.cell) ?? 0) + Math.min(span.end, 540) - Math.max(span.start, 480));
      }
    }
    for (const event of out.events) {
      const kind = EVENT_KINDS[event.kind]!;
      causes.set(`${kind}/${EVENT_CAUSES[event.cause]}`, (causes.get(`${kind}/${EVENT_CAUSES[event.cause]}`) ?? 0) + 1);
      if (kind === "handover" || kind === "reselect") moves[band]! += 1;
    }
  }

  if (subscribers === 0) return;
  const pct = (n: number, of: number) => `${((n / Math.max(1, of)) * 100).toFixed(1)}%`;

  console.log(`\n  ${BOLD}radio${OFF}  ${DIM}${subscribers.toLocaleString()} handsets on the network${OFF}`);
  console.log(
    `    attached      ${pct(attachedMinutes, totalMinutes)} of handset-minutes had a serving cell`
    + `${roamed > 0 ? `, ${pct(roamed, attachedMinutes)} of them roaming` : ""}`,
  );

  console.log(`    serving-cell changes per handset, by distance traveled`);
  for (let i = 0; i < bands.length; i += 1) {
    if (days[i]! === 0) continue;
    const label = i + 1 < bands.length ? `${bands[i]}–${bands[i + 1]} km` : `${bands[i]}+ km`;
    console.log(`      ${label.padEnd(12)}${(moves[i]! / days[i]!).toFixed(1)}  ${DIM}over ${days[i]!.toLocaleString()} handset-days${OFF}`);
  }
  console.log(
    `                  ${DIM}expected: steep rise; a stationary phone holds one cell for hours,`
    + `\n                  one crossing the city changes every 1–2 min${OFF}`,
  );

  const layers = [...RADIO_LAYERS.entries()]
    .filter(([index]) => byLayer[index]! > 0)
    .sort((a, b) => byLayer[b[0]]! - byLayer[a[0]]!)
    .map(([index, name]) => `${name} ${pct(byLayer[index]!, attachedMinutes)}`);
  console.log(`    layers        ${layers.join("  ")}`);
  console.log(
    `                  ${DIM}expected: anchor bands dominate (most minutes are indoors, low band only)`
    + `\n                  0 on mid band is a fault; 0 on C-band is normal, since no handset camps there (attach.ts)${OFF}`,
  );

  const operators = [...OPERATORS.entries()].map(([index, name]) =>
    `${name} ${pct(byOperator[index]!, attachedMinutes)}${DIM}/${pct(subsPerOperator[index]!, subscribers)}${OFF}`);
  console.log(`    operators     ${operators.join("  ")}  ${DIM}minutes/subscriptions${OFF}`);

  const busiest = [...load.values()].sort((a, b) => b - a);
  const carrying = busiest.length;
  const top = busiest.slice(0, Math.max(1, Math.ceil(carrying * 0.1))).reduce((a, b) => a + b, 0);
  console.log(
    `    busy hour     ${carrying.toLocaleString()} of ${network.cells.records.length.toLocaleString()} cells carried anyone at 08:00; `
    + `busiest 10% carried ${pct(top, busiest.reduce((a, b) => a + b, 0))} of minutes`,
  );

  const events = [...causes].sort((a, b) => b[1] - a[1]);
  const total = events.reduce((a, b) => a + b[1], 0);
  console.log(`    events        ${(total / subscribers).toFixed(1)} per handset-day`);
  for (const [name, count] of events) {
    console.log(`      ${name.padEnd(24)}${(count / subscribers).toFixed(2)}`);
  }
}

/**
 * One person's day as their phone lived it.
 *
 * The two halves are printed apart on purpose. The spans are where the handset
 * actually was; the events are what the operator would have a record of, and
 * they are fewer. Reading the second as if it were the first is the mistake
 * this layer exists to make hard, so the view should not blend them.
 */
function radio(context: DayContext, person: Person, date: Date): void {
  const network = context.network;
  if (!network) return;
  const day = dayNumber(date);
  const subscribers = network.subscribers.forPerson(person.id);
  if (subscribers.length === 0) {
    console.log(`\n${BOLD}radio${OFF}  ${DIM}no subscription${OFF}`);
    return;
  }

  const planned = planDay(context, person, date, day);
  const out = emptyDayNetwork();
  network.day(planned, homeOf(context.world, person), day, context.world.seed, null, out);

  for (const subscriber of subscribers) {
    console.log(
      `\n${BOLD}radio${OFF}  ${subscriber.make} ${subscriber.model}  ${subscriber.msisdn}  `
      + `${subscriber.carrier}${subscriber.mvno ? ` ${DIM}on ${subscriber.operatorKey}${OFF}` : ""}\n`
      + `${DIM}  IMSI ${subscriber.imsi}  IMEI ${subscriber.imei}${OFF}`,
    );

    const spans = out.spans.filter((span) => span.subscriber === subscriber.index);
    for (const span of spans) {
      const held = span.end - span.start;
      if (span.cell === UNATTACHED) {
        console.log(`  ${clock(span.start)}–${clock(span.end)}  ${DIM}no service (${held} min)${OFF}`);
        continue;
      }
      const cell = network.cells.records[span.cell]!;
      const roaming = cell.operator_key !== subscriber.operatorKey ? `  ${BOLD}roaming${OFF}` : "";
      const secondary = span.secondary === UNATTACHED ? "" : `  +${network.cells.records[span.secondary]!.band}`;
      console.log(
        `  ${clock(span.start)}–${clock(span.end)}  ${cell.cgi}  ${cell.operator} ${cell.band}  `
        + `${span.rsrp.toFixed(0)} dBm  ${DIM}TA ${span.ta} (${Math.round(span.ta * TA_UNIT_M)} m)  `
        + `area ${cell.tracking_area}  PCI ${cell.pci}  `
        + `${held} min, ${span.connected} connected${secondary}${OFF}${roaming}`,
      );
    }

    // What the network itself would hold, minus the connection churn, which is
    // most of the volume and none of the story.
    const events = out.events.filter((event) =>
      event.subscriber === subscriber.index
      && EVENT_KINDS[event.kind] !== "connect" && EVENT_KINDS[event.kind] !== "release");
    console.log(`${DIM}  ${events.length} logged events, ${out.events.length - events.length} connection setups and releases${OFF}`);
    for (const event of events) {
      const cell = event.cell === UNATTACHED ? null : network.cells.records[event.cell]!;
      const from = event.previous === UNATTACHED ? "" : ` from ${network.cells.records[event.previous]!.cgi}`;
      console.log(
        `  ${clock(event.minute)}  ${EVENT_KINDS[event.kind]}  ${DIM}${EVENT_CAUSES[event.cause]}${OFF}`
        + `${cell ? `  ${cell.cgi}` : ""}${DIM}${from}${OFF}`,
      );
    }
  }
}

const args = parseArgs(Bun.argv.slice(2));
if ((args.exportWeek || (args.exportDay && args.week)) && !args.dateProvided) {
  throw new Error("--export-day --week requires an explicit --date YYYY-MM-DD start date");
}
// Opened before the first file is read, so an export's report accounts for the
// whole command and not only the part of it that packs.
const timings = new Timings();
const ctx = await timings.timeAsync("load city", context);
// An export always carries the money, without being asked. The viewer reads
// one file per date and there is nothing else for it to read a ledger out of,
// so an export written without a bank is a day KierstonBlue can only half show
// — and the settlement is a few seconds on top of a run that takes minutes.
if (args.money || args.exportDay || args.exportWeek) {
  const started = performance.now();
  ctx.bank = Bank.load();
  // The schedule comes with the bank, always. A day settled without it is a
  // day in which nobody in Kierston pays rent, and that is not a smaller
  // version of the money model — it is a different city, with two thirds of
  // its outgoings missing and every balance drifting upward.
  ctx.bills = Bills.load();
  timings.since("load banking", started);
}
// And the radio, on the same terms and for the same reason: one file per date
// is all a consumer reads, so a day packed without the network is a day whose
// cellular half simply does not exist. `--radio` is for looking at one
// person's without paying for the city's.
if (args.exportDay || args.exportWeek || args.radio || (args.sample !== undefined && !args.money)) {
  const started = performance.now();
  ctx.network = await timings.timeAsync("load network", () => Network.open());
  console.log(
    `${DIM}loaded ${ctx.network.cells.records.length.toLocaleString()} cells and `
    + `${ctx.network.subscribers.size.toLocaleString()} subscribers `
    + `in ${Math.round(performance.now() - started)} ms${OFF}\n`,
  );
  const orphans = orphanSubscribers(ctx.network, (person) => ctx.world.persons.has(person));
  if (orphans > 0) {
    console.log(
      `${BOLD}warning${OFF}  ${orphans.toLocaleString()} of `
      + `${ctx.network.subscribers.size.toLocaleString()} subscriptions name a person who is not in `
      + `the population.\n         devices.json and population.json were built from different runs; `
      + `those handsets\n         produce no records. Rebuild with `
      + `\`init_sim.py --from identity\`.\n`,
    );
  }
}

// The communications layer, on a full export only.
//
// Deliberately narrower than the radio's condition above. A `--radio` or
// `--sample` run plans a cohort, and this layer resolves a reply against the
// *recipient's* day — so a cohort produces a city where almost nobody's
// correspondent exists and the traffic that comes out is a fraction of the
// real answer, silently. Better to have no conversations in a sampled run
// than a plausible-looking wrong number of them.
if (args.exportDay || args.exportWeek) {
  const started = performance.now();
  ctx.comms = await timings.timeAsync("load comms", () => Comms.open(ctx.network!.subscribers, ctx.ties));
  console.log(
    `${DIM}loaded ${ctx.comms.accounts.size.toLocaleString()} accounts, `
    + `${ctx.comms.accounts.conversations.length.toLocaleString()} group threads and `
    + `${ctx.comms.graph.size.toLocaleString()} live contacts `
    + `in ${Math.round(performance.now() - started)} ms${OFF}\n`,
  );
  if (ctx.comms.accounts.orphans > 0) {
    console.log(
      `${BOLD}warning${OFF}  ${ctx.comms.accounts.orphans.toLocaleString()} accounts name a phone number `
      + `no subscription has.\n         accounts.json and devices.json were built from different runs; `
      + `those accounts\n         will carry no subscriber. Rebuild with `
      + `\`init_sim.py --from devices\`.\n`,
    );
  }
}

if (args.measureRuns) {
  await measureRuns(ctx);
} else if (args.exportTaxi) {
  await exportTaxi(ctx);
} else if (args.exportWeek || (args.exportDay && args.week)) {
  if (args.workers !== 0) {
    console.log(
      `${DIM}--workers ${args.workers} ignored: week exports run serially${OFF}\n`,
    );
  }
  const state = SimulationState.cold(args.date, ctx.bank!);
  const result = await exportWeek(ctx, args.date, state, {
    days: args.days,
    initColdStartDay: args.initColdStartDay,
    progress: (date, done, total) => {
      console.log(`${DIM}${date}: packed ${done.toLocaleString()} / ${total.toLocaleString()} people${OFF}`);
    },
    status: (date, stage) => {
      console.log(`${DIM}${date}: ${stage}…${OFF}`);
    },
    dayComplete: (day) => {
      console.log(
        `${BOLD}wrote ${day.date}${OFF}  ${day.export.persons.toLocaleString()} people, `
        + `${day.export.legs.toLocaleString()} legs, `
        + `${day.export.transactions.toLocaleString()} transactions, `
        + `${(day.export.bytes / 1e6).toFixed(1)} MB\n`
        + `  state ${day.startState.slice(0, 12)}… → ${day.endState.slice(0, 12)}…`,
      );
    },
  });
  console.log(
    `\n${BOLD}wrote week ${result.start} through ${result.end}${OFF}\n`
    + `  ${result.days.length} KDAY files with embedded opening and closing checkpoints\n`
    + `  manifest ${result.manifest}`,
  );
} else if (args.exportDay) {
  if (args.workers !== 0) {
    console.log(
      `${DIM}--workers ${args.workers} ignored: stateful exports run serially${OFF}\n`,
    );
  }
  const started = performance.now();
  if (args.fromState && args.initColdStartDay) {
    throw new Error("--from-state already carries an opening; drop --init-cold-start-day");
  }
  const state = args.fromState
    ? await SimulationState.open(args.fromState, ctx.bank!)
    : SimulationState.cold(args.date, ctx.bank!);
  const sequence = await exportWeek(ctx, args.date, state, {
    days: 1,
    initColdStartDay: args.initColdStartDay,
    ...(args.outputDir ? { outputDir: args.outputDir, manifestDir: args.outputDir } : {}),
    progress: (_date, done, total) => {
      console.log(`${DIM}packed ${done.toLocaleString()} / ${total.toLocaleString()} people${OFF}`);
    },
    status: (_date, stage) => {
      console.log(`${DIM}${stage}…${OFF}`);
    },
  });
  const result = sequence.days[0]!.export;
  console.log(
    `${BOLD}wrote ${result.path}${OFF}\n`
    + `  ${result.persons.toLocaleString()} people, ${result.schedules.toLocaleString()} schedule entries, `
    + `${result.legs.toLocaleString()} movement legs, ${result.points.toLocaleString()} path points\n`
    + `  ${result.transactions.toLocaleString()} transactions, $${result.spent.toFixed(0)} spent `
    + `${DIM}(${(result.transactions / Math.max(1, result.persons)).toFixed(2)} per person-day)${OFF}\n`
    + `  ${result.spans.toLocaleString()} serving-cell spans, ${result.events.toLocaleString()} network events `
    + `${DIM}(${(result.events / Math.max(1, result.persons)).toFixed(1)} per person-day)${OFF}\n`
    + `  ${result.messages.toLocaleString()} messages, ${result.calls.toLocaleString()} calls `
    + `${DIM}(${(result.messages / Math.max(1, result.persons)).toFixed(1)} messages per person-day)${OFF}\n`
    + `  ${result.meetings.toLocaleString()} gatherings, ${result.parties.toLocaleString()} people at them `
    + `${DIM}(${(result.parties / Math.max(1, result.meetings)).toFixed(2)} each; `
    + `${result.stoodUp.toLocaleString()} with no other attendee)${OFF}\n`
    + `  ${result.externalVehicles.toLocaleString()} external vehicles, `
    + `${result.externalTrips.toLocaleString()} routed movements `
    + `${DIM}(${result.throughTrips.toLocaleString()} through trips, `
    + `${result.stoppingTours.toLocaleString()} stopping tours)${OFF}\n`
    + `  ${result.incidents.toLocaleString()} calls for service, ${result.responses.toLocaleString()} unit runs `
    + `${DIM}(${result.unservedIncidents.toLocaleString()} unserved; `
    + `median ${result.medianResponseMinutes.toFixed(0)} min to first unit)${OFF}\n`
    + `  ${result.alprPasses.toLocaleString()} ALPR passes, ${result.alprReads.toLocaleString()} recorded reads `
    + `${DIM}(${result.alprCorrect.toLocaleString()} correct, ${result.alprMisread.toLocaleString()} misread, `
    + `${result.alprUnreadable.toLocaleString()} unreadable, `
    + `${result.alprNotCaptured.toLocaleString()} not captured)${OFF}\n`
    + `  ${(result.bytes / 1e6).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  // What the whole command cost, stage by stage, including the two loads and
  // the dispatch that ran before the packing did.
  console.log(`\n${BOLD}timings${OFF}\n${result.timings.format()}`);
  // The pool's own table, which is CPU across the workers rather than wall
  // clock, so it is printed apart and against its own total. A stage here
  // taking three times what the run took is three workers doing it at once.
  if (result.workers && !result.workers.empty) {
    console.log(
      `\n${BOLD}worker CPU${OFF} ${DIM}(${args.workers} workers, summed)${OFF}\n`
      + result.workers.format(result.workers.claimed, ""),
    );
  }
} else if (args.taxi) {
  // The fleet on its own. It touches only the drivers and the people who ride
  // with them — a few hundred days rather than the whole sample — so it is the
  // one check that can be run while a constant is being fitted.
  dispatch(ctx, args.date);
  taxiChecks(ctx, args.date);
} else if (args.sample) {
  // Drawn before the dispatcher runs, because the dispatcher is now one of the
  // things it narrows. Everything below plans this cohort and nobody else.
  const cohort = cohortOf(ctx.world, args.sample);
  dispatch(ctx, args.date, cohort);
  if (args.money) {
    moneyChecks(ctx, cohort.people, args.date);
  } else {
    checks(ctx, cohort.people, args.date);
    activityChecks(ctx, cohort, args.date);
    taxiChecks(ctx, args.date, cohort);
    patrolChecks(ctx, args.date);
    radioChecks(ctx, cohort.people, args.date);
  }
} else if (args.person !== undefined) {
  const person = ctx.world.persons.get(args.person);
  if (!person) throw new Error(`no person ${args.person}`);
  // The week view is roster and commute only, and neither has a cab in it.
  if (args.week) week(ctx, person, args.date);
  else {
    dispatch(ctx, args.date);
    timeline(ctx, person, args.date);
    if (args.money) ledger(ctx, person, args.date);
    if (args.radio) radio(ctx, person, args.date);
  }
} else {
  console.log(
    "usage: bun run day --person <id> [--date YYYY-MM-DD] [--week] [--money] [--radio]\n"
    + "       bun run day --sample <n> [--money] | --taxi | --measure-runs | --export-taxi\n"
    + "       bun run day --export-day [--week] [--days <n>] [--init-cold-start-day] [--from-state <kday>] [--output-dir <dir>]",
  );
}

/** Export consecutive dates against one accumulated simulation state. */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Cohort, DayContext } from "../engine/index.ts";
import { SimulationState } from "../engine/index.ts";
import { callsFor, dispatchFor, HouseholdDayPlanner, planDay } from "../scheduler/index.ts";
import { HOME_LABEL, type Place } from "../transport/index.ts";
import { SIM_DATA_DIR, SIM_OUTPUTS_DIR, homeOf } from "../world/index.ts";
import { emptyDayNetwork } from "../network/index.ts";
import { MINUTES_PER_DAY, Timings, dayNumber, isoDate } from "../shared/index.ts";
import { exportDay, type DayExportResult } from "./day.ts";
import { NONE, Strings } from "./pack.ts";
import { buildVehicleDay, vehicleBoundaryStates } from "./vehicles.ts";

export interface WeekDayResult {
  date: string;
  startState: string;
  endState: string;
  export: DayExportResult;
}

export interface WeekExportResult {
  start: string;
  end: string;
  coldStart: string;
  manifest: string;
  days: WeekDayResult[];
  state: SimulationState;
}

export interface WeekExportOptions {
  days?: number;
  /** Simulate the preceding day to initialize a cold start date. */
  initColdStartDay?: boolean;
  /** Directory for final KDAY binaries. */
  outputDir?: string;
  /** Directory for the rebuildable JSON manifest. */
  manifestDir?: string;
  progress?: (date: string, done: number, total: number) => void;
  status?: (date: string, stage: string) => void;
  dayComplete?: (day: WeekDayResult) => void;
}

function dateAt(start: Date, offset: number): Date {
  const date = new Date(start);
  date.setDate(start.getDate() + offset);
  return date;
}

/**
 * Put the date's calls for service and taxi fleet on the context.
 *
 * The taxi demand pass plans every possible passenger's day, and a caller's
 * day carries the hold its call puts on it. The calls are therefore drawn
 * first, with no fleet, so the demand pass sees this date's holds and not the
 * calls the context still holds from the previous date. The same draws are
 * then placed again against the dispatched fleet, because a caller riding or
 * driving a cab is somewhere else once the cab exists.
 */
export function dispatchDate(
  context: DayContext, date: Date, day: number, cohort?: Cohort, timings?: Timings,
): void {
  context.fleet = null;
  context.calls = callsFor(context, date, day, cohort, timings);
  context.fleet = dispatchFor(context, date, day, cohort, timings);
  context.calls = callsFor(context, date, day, cohort, timings);
}

/**
 * Reconstruct the one bounded predecessor needed to make an arbitrary cold
 * date physically self-contained. Money deliberately does not warm up: its
 * supplied holdings are the definition of the financial cold start.
 */
async function initColdStartDay(
  context: DayContext,
  start: Date,
  state: SimulationState,
  people: readonly number[],
): Promise<void> {
  if (state.initialized) return;
  const previous = dateAt(start, -1);
  const day = dayNumber(previous);
  const ordered = people.map((id) => context.world.persons.get(id)!).filter(Boolean);

  // The predecessor must not read the state it is in the process of creating.
  delete context.state;
  dispatchDate(context, previous, day);
  context.householdPlanner = new HouseholdDayPlanner();
  state.beginTransition();
  const radio = emptyDayNetwork();
  // The predecessor's physical legs, in the column shape `buildVehicleDay`
  // reads, so VINs open today where last night's continuation leaves them.
  const vins = new Strings();
  const legs = {
    vehicle: [] as number[], depart: [] as number[], arrive: [] as number[],
    fromLat: [] as number[], fromLon: [] as number[], toLat: [] as number[], toLon: [] as number[],
  };
  for (const person of ordered) {
    const planned = planDay(context, person, previous, day);
    for (const leg of planned.legs) {
      const vin = vins.id(leg.vehicleId ?? null);
      if (vin === NONE) continue;
      legs.vehicle.push(vin);
      legs.depart.push(leg.depart);
      legs.arrive.push(leg.arrive);
      legs.fromLat.push(Math.round(leg.from.lat * 1e6));
      legs.fromLon.push(Math.round(leg.from.lon * 1e6));
      legs.toLat.push(Math.round(leg.to.lat * 1e6));
      legs.toLon.push(Math.round(leg.to.lon * 1e6));
    }
    const point = homeOf(context.world, person);
    const home: Place | null = point
      ? { ...point, id: null, kind: "home", label: HOME_LABEL }
      : null;
    state.stagePerson(planned, home);
    if (context.network) {
      radio.spans.length = 0;
      radio.events.length = 0;
      context.network.day(planned, point, day, context.world.seed, null, radio, {
        opening: () => null,
        closing: (closing) => state.stageRadio(closing),
      });
    }
  }
  state.stageFleet(context.fleet?.cabs ?? []);
  // The same two city-level rows a warm day stages in `exportDay`: every VIN's
  // closing position, and the predecessor's calls received after midnight,
  // which today's comms dial and today's responders answer.
  state.stageVehicles(vehicleBoundaryStates(buildVehicleDay(context, vins.values, legs), "closing"));
  state.stageEmergencyCalls((context.calls?.incidents ?? [])
    .filter((incident) => incident.receivedAt >= MINUTES_PER_DAY)
    .map((incident) => ({
      date: isoDate(previous), incident: incident.index, person: incident.caller,
      minute: incident.receivedAt - MINUTES_PER_DAY,
    })));
  state.initializeBoundary();
  context.state = state;
}

/**
 * Run a chronological state chain.
 *
 * This is intentionally serial. A normal parallel day gives every worker its
 * own bank, which is valid while a person appears once and invalid when the
 * balance must survive into tomorrow. Establish the canonical transition
 * first; a state-aware worker protocol can optimize it later.
 */
export async function exportWeek(
  context: DayContext,
  start: Date,
  state: SimulationState,
  options: WeekExportOptions = {},
): Promise<WeekExportResult> {
  const count = options.days ?? 7;
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid week length ${count}`);
  state.enter(start);

  const outputDir = options.outputDir ?? SIM_OUTPUTS_DIR;
  const manifestDir = options.manifestDir ?? SIM_DATA_DIR;
  await Promise.all([
    mkdir(outputDir, { recursive: true }),
    mkdir(manifestDir, { recursive: true }),
  ]);
  const people = [...context.world.persons.keys()].sort((a, b) => a - b);
  context.bank = state.bank;
  if (options.initColdStartDay) {
    await initColdStartDay(context, start, state, people);
  }
  context.state = state;
  const days: WeekDayResult[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const date = dateAt(start, offset);
    const named = isoDate(date);
    state.enter(date);
    const startState = state.digest(people);
    state.beginTransition();

    // Both objects are date-local accumulators. The static city, the bank and
    // all immutable indexes remain on the context across the whole run.
    context.comms?.reset();
    const timings = new Timings();
    dispatchDate(context, date, dayNumber(date), undefined, timings);
    context.householdPlanner = new HouseholdDayPlanner();

    const output = join(outputDir, `day_${named}.bin`);
    const exported = await exportDay(
      context, date, output,
      (done, total) => options.progress?.(named, done, total),
      (stage) => options.status?.(named, stage),
      timings,
      0,
    );

    // The rows and closing checkpoint are now both in KDAY. Retaining the
    // statement objects would only grow memory; balances are in the embedded
    // checkpoint and remain live on the Bank used by tomorrow.
    state.bank.clearLedger();
    const endState = exported.closingState;

    const result: WeekDayResult = {
      date: named,
      startState,
      endState,
      export: exported,
    };
    days.push(result);
    options.dayComplete?.(result);
  }

  const end = days.at(-1)!.date;
  const manifest = join(manifestDir, `week_${isoDate(start)}_${end}.json`);
  await Bun.write(manifest, JSON.stringify({
    format: "KIERSTON_WEEK",
    version: 2,
    start: isoDate(start),
    end,
    coldStart: state.coldStart,
    days: days.map((day) => ({
      date: day.date,
      file: day.export.path,
      startState: day.startState,
      endState: day.endState,
      counts: {
        persons: day.export.persons,
        schedules: day.export.schedules,
        legs: day.export.legs,
        transactions: day.export.transactions,
        messages: day.export.messages,
        calls: day.export.calls,
      },
    })),
  }, null, 2));

  return { start: isoDate(start), end, coldStart: state.coldStart, manifest, days, state };
}

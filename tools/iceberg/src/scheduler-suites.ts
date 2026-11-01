/** Fast in-process scheduler profiles; no population rebuild or KDAY packing. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDayContext, type DayContext } from "../../../kierston/sim/src/engine/index.ts";
import { SIM_DATA_DIR, type Person } from "../../../kierston/sim/src/world/index.ts";
import { hirerFor, type Leg } from "../../../kierston/sim/src/transport/index.ts";
import { dispatchFor, entries, planDay, type Day, type Entry } from "../../../kierston/sim/src/scheduler/index.ts";
import { dayNumber, parseDate } from "../../../kierston/sim/src/shared/index.ts";
import { Builder, Cat, Num } from "./metrics.ts";
import type { IcebergSuite, SuitePolicy } from "./suites.ts";

const DATES = [parseDate("2026-07-28"), parseDate("2026-08-01")];
const GENERAL_SAMPLE = 400;

interface Observation {
  person: Person;
  date: Date;
  day: Day;
  timeline: Entry[];
  general: boolean;
}

interface Sample {
  context: DayContext;
  rows: Observation[];
}

let cached: Promise<Sample> | null = null;
let taxiCached: Promise<Sample> | null = null;

async function observations(): Promise<Sample> {
  if (cached) return cached;
  cached = (async () => {
    const context = await loadDayContext();
    const people = [...context.world.persons.values()];
    const stride = Math.max(1, Math.floor(people.length / GENERAL_SAMPLE));
    const selected = people.filter((_, index) => index % stride === 0);
    const general = new Set(selected.map((person) => person.id));
    // Rare coordinated roles are exhaustive even when the general stride
    // misses them, because a random sample is a poor school/taxi test.
    for (const person of people) {
      const assignment = context.world.assignments.get(person.id);
      if (assignment?.role !== "school_bus_driver" && assignment?.role !== "taxi_driver") continue;
      if (!selected.includes(person)) selected.push(person);
    }
    selected.sort((a, b) => a.id - b.id);
    const rows: Observation[] = [];
    for (const date of DATES) {
      const number = dayNumber(date);
      for (const person of selected) {
        const day = planDay(context, person, date, number);
        rows.push({ person, date, day, timeline: entries(day), general: general.has(person.id) });
      }
    }
    return { context, rows };
  })();
  return cached;
}

export function schedulerSuites(): IcebergSuite[] {
  return ["roster", "sleep", "activities", "affiliations", "travel", "school", "taxi", "scheduler"].map((name) => ({
    name,
    profile: async () => profile(name),
    policy: policy(name),
  }));
}

async function profile(name: string) {
  const { context, rows } = name === "taxi" ? await taxiObservations() : await observations();
  const b = new Builder();
  b.provenance.populationDigest = initDigest();
  b.provenance.seed = context.world.seed;
  b.provenance.dates = DATES.map((date) => date.toISOString().slice(0, 10));
  b.provenance.sample = `stride-${GENERAL_SAMPLE}-plus-coordinated-roles`;
  analyse(name, b, rows, context);
  return b.profile(name, name);
}

async function taxiObservations(): Promise<Sample> {
  if (taxiCached) return taxiCached;
  taxiCached = (async () => {
    const context = await loadDayContext();
    const date = DATES[0]!;
    const number = dayNumber(date);
    const dispatched: DayContext = { ...context, fleet: dispatchFor(context, date, number) };
    const eligible = [...context.world.persons.values()].filter((person) => {
      const role = context.world.assignments.get(person.id)?.role;
      return role === "taxi_driver" || hirerFor(context.world, person).usual === "taxi";
    });
    const rows: Observation[] = [];
    for (const person of eligible) {
      const day = planDay(dispatched, person, date, number);
      rows.push({ person, date, day, timeline: entries(day), general: true });
    }
    return { context, rows };
  })();
  return taxiCached;
}

function analyse(name: string, b: Builder, rows: readonly Observation[], context: DayContext): void {
  const trips = new Num();
  const driven = new Num();
  const walked = new Num();
  const late = new Num();
  const sleep = new Num();
  const dwell = new Num();
  const modes = new Cat();
  const purposes = new Cat();
  const stops = new Cat();
  const attendance = new Cat();
  let overlaps = 0;
  let backwards = 0;
  let disconnected = 0;
  let rejectedRequired = 0;
  let taxiLoaded = 0;
  let taxiEmpty = 0;
  let taxiFares = 0;
  let taxiDrivers = 0;
  const passengerJourneys = new Set<string>();
  const driverJourneys = new Set<string>();
  const examples: string[] = [];

  for (const row of rows) {
    const day = row.day;
    const role = context.world.assignments.get(row.person.id)?.role;
    const relevant = name === "school"
      ? role === "school_bus_driver" || context.world.school.riders.has(row.person.id)
      : name === "taxi"
        ? role === "taxi_driver" || day.legs.some((leg) => leg.mode === "taxi" || leg.mode === "cab")
        : row.general;
    if (relevant) {
      trips.push(day.trips);
      driven.push(day.drivenKm);
      walked.push(day.walkedKm);
      late.push(day.late);
      for (const block of day.blocks) if (block.kind === "sleep") sleep.push(block.end - block.start);
      for (const stop of day.plan.stops) {
        stops.add(stop.purpose);
        dwell.push(stop.leave - stop.arrive);
      }
      for (const visit of day.attendance) attendance.add(visit.occurrence.class);
      taxiLoaded += day.cabKm.loaded;
      taxiEmpty += day.cabKm.empty;
      taxiFares += day.legs.filter((leg) => leg.mode === "cab" && leg.purpose === "fare").length;
      if (day.legs.some((leg) => leg.mode === "cab" && leg.purpose === "fare")) taxiDrivers += 1;
    }
    for (let index = 0; index < day.legs.length; index += 1) {
      const leg = day.legs[index]!;
      if (leg.mode === "taxi" && leg.journeyId) passengerJourneys.add(leg.journeyId);
      if (leg.mode === "cab" && leg.purpose === "fare" && leg.journeyId) driverJourneys.add(leg.journeyId);
      if (relevant) {
        modes.add(leg.mode);
        purposes.add(leg.purpose);
      }
      if (leg.arrive < leg.depart) backwards += 1;
      const previous = day.legs[index - 1];
      if (previous && previous.toLabel !== leg.fromLabel && leg.depart <= previous.arrive + 1) disconnected += 1;
    }
    const timed = row.timeline.filter((entry) => entry.kind !== "travel").sort((a, b) => a.at - b.at);
    for (let index = 1; index < timed.length; index += 1) {
      if (timed[index]!.at >= timed[index - 1]!.end) continue;
      overlaps += 1;
      if (examples.length < 5) examples.push(`person ${row.person.id}: ${timed[index - 1]!.label} overlaps ${timed[index]!.label}`);
    }
    rejectedRequired += day.scheduled.rejected.filter((item) => item.intent.policy === "required").length;
  }

  const prefix = name;
  if (name === "roster" || name === "scheduler") b.num(`${prefix}.trips`, trips);
  if (name === "sleep" || name === "scheduler") b.num(`${prefix}.duration`, sleep);
  if (name === "activities") {
    b.cat(`${prefix}.purpose`, stops);
    b.num(`${prefix}.dwell`, dwell);
  }
  if (name === "affiliations") b.cat(`${prefix}.class`, attendance);
  if (name === "travel" || name === "school" || name === "taxi" || name === "scheduler") {
    b.cat(`${prefix}.mode`, modes);
    b.cat(`${prefix}.purpose`, purposes);
    b.num(`${prefix}.drivenKm`, driven);
    b.num(`${prefix}.walkedKm`, walked);
  }
  if (name === "scheduler") {
    b.num(`${prefix}.late`, late);
    b.invariant(`${prefix}.timeline.overlap`, "non-travel activities do not overlap", overlaps, rows.length, examples);
    b.invariant(`${prefix}.leg.backwards`, "travel does not run backwards", backwards, rows.length);
    b.invariant(`${prefix}.leg.disconnected`, "adjacent travel remains connected", disconnected, rows.length);
    b.invariant(`${prefix}.required.rejected`, "required activities are never rejected", rejectedRequired, rows.length);
  }
  if (name === "taxi") {
    const total = taxiLoaded + taxiEmpty;
    b.scalar("taxi.emptyKm.share", total ? taxiEmpty / total : 0, "share");
    b.scalar("taxi.fares", taxiFares);
    b.scalar("taxi.faresPerDriver", taxiDrivers ? taxiFares / taxiDrivers : 0, "rate");
    b.invariant(
      "taxi.emptyKm.range",
      "empty taxi kilometers stay between 40% and 50%",
      total && (taxiEmpty / total < 0.4 || taxiEmpty / total > 0.5) ? 1 : 0,
      total ? 1 : 0,
    );
    const unmatched = [...driverJourneys].filter((id) => ![...passengerJourneys].some(
      (passenger) => passenger === id || passenger.startsWith(`${id}/`) || id.startsWith(`${passenger}/`),
    ));
    b.invariant(
      "taxi.journey.passengerDriver",
      "every loaded driver journey has the same stable id in a passenger day",
      unmatched.length,
      driverJourneys.size,
      unmatched.slice(0, 5),
    );
    const faresPerDriver = taxiDrivers ? taxiFares / taxiDrivers : 0;
    b.invariant(
      "taxi.faresPerDriver.range",
      "working taxi drivers complete approximately 15 to 25 fares per shift",
      faresPerDriver < 14.5 || faresPerDriver > 25 ? 1 : 0,
      taxiDrivers ? 1 : 0,
    );
  }
}

function policy(name: string): SuitePolicy {
  const bands: SuitePolicy["bands"] = {};
  if (name === "roster" || name === "scheduler") bands[`${name}.trips`] = { relative: 0.03 };
  if (name === "sleep" || name === "scheduler") bands[`${name}.duration`] = { absolute: 15 };
  if (name === "travel" || name === "school" || name === "scheduler") {
    bands[`${name}.drivenKm`] = { relative: 0.05 };
    // Walking is zero-inflated; a few metres around a near-zero median makes a
    // relative-only band meaningless. Fifty metres/person is the absolute cap.
    bands[`${name}.walkedKm`] = { relative: 0.05, absolute: 0.05 };
    bands[`${name}.mode`] = { categoryAbsolute: 0.01 };
    bands[`${name}.purpose`] = { categoryAbsolute: 0.01 };
  }
  if (name === "taxi") {
    bands[`${name}.mode`] = { categoryAbsolute: 0.01 };
    bands[`${name}.purpose`] = { categoryAbsolute: 0.01 };
  }
  if (name === "activities") bands[`${name}.purpose`] = { categoryAbsolute: 0.01 };
  return { invariants: "zero", bands };
}

function initDigest(): string | null {
  const path = join(SIM_DATA_DIR, "sim_init.bin");
  const bytes = readFileSync(path);
  if (bytes.toString("utf8", 0, 4) !== "KSIM") return null;
  const size = bytes.readUInt32LE(4);
  return (JSON.parse(bytes.toString("utf8", 8, 8 + size)) as { digest?: string }).digest ?? null;
}

export type { Leg };

/**
 * Cuts the website's summary of one staged incident, read from the scenario's ground-truth header.
 *
 *   bun run site-scenario --day <base.bin> --scenario <x.kdiff> --tasks <run_series_*_tasks_data.json> --out <dir>
 *
 * Every scenario this exports is the base of a scored bench case, and the site publishes by-model
 * scores only. The output therefore carries no person ids, names, roles, fates, trajectories,
 * task id or prompt: only the event kind, its time window, the records cutoff and head counts.
 * `--tasks` is read to confirm the delta belongs to a case and to take that case's cutoff.
 *
 * Writes scenario.json:
 *   { date, name, event: { kind, start, end }, cutoff, counts: { people, deaths, roles, fates } }
 * with times in minutes after midnight and counts as plain integers.
 */

import { join } from "node:path";
import { KdayReader } from "../../kierston_bench/task_generators/src/kday.ts";
import { required } from "./args.ts";

const USAGE = "bun run site-scenario --day <base.bin> --scenario <x.kdiff> --tasks <tasks_data.json> --out <dir>";
const dayFile = required("--day", USAGE);
const scenarioFile = required("--scenario", USAGE);
const tasksFile = required("--tasks", USAGE);
const out = required("--out", USAGE);

const day = await KdayReader.open(dayFile, { delta: scenarioFile });
const header = (day.meta as unknown as {
  scenario: {
    name: string;
    groups: Record<string, number[]>;
    events: { kind: string; start: number; end: number }[];
    deaths: { person: number; minute: number }[];
  };
}).scenario;
const event = header.events[0]!;

// The bench case built on this delta: only its cutoff instant is used.
const { tasks } = (await Bun.file(tasksFile).json()) as { tasks: { kdiPolicy?: { cutoff?: string }; scenario?: { delta: string } }[] };
const task = tasks.find((candidate) => candidate.scenario?.delta && scenarioFile.endsWith(candidate.scenario.delta));
if (!task) throw new Error(`no task in ${tasksFile} is built on ${scenarioFile}`);
const cutoffClock = task.kdiPolicy?.cutoff?.match(/T(\d\d):(\d\d)/);
const cutoff = cutoffClock ? Number(cutoffClock[1]) * 60 + Number(cutoffClock[2]) : null;

const groups = header.groups;
const size = (group: string) => new Set(groups[group] ?? []).size;
const everyone = new Set([...(groups.crowd ?? []), ...(groups.shooter ?? []), ...(groups.police ?? [])]);

const scenario = {
  date: day.meta.date,
  name: header.name,
  event: { kind: event.kind, start: event.start, end: event.end },
  cutoff,
  counts: {
    people: everyone.size,
    deaths: new Set(header.deaths.map((death) => death.person)).size,
    roles: { shooter: size("shooter"), police: size("police"), bystander: size("bystanders") },
    fates: { killed: size("fate/dead"), hid: size("fate/hiding"), fled: size("fate/fleeing") },
  },
};
const body = JSON.stringify(scenario);
await Bun.write(join(out, "scenario.json"), body);
console.log(`Wrote scenario summary: ${header.name}, ${scenario.counts.people} people, ${scenario.counts.deaths} deaths`);
await day.close();

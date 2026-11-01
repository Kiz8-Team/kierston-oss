/**
 * The benchmark scenarios: which script stages which kind of event, and
 * which task families read the result.
 *
 * Scripts are grouped by the task group their families belong to: `rti/`
 * holds the staged incidents the Real-Time Investigations read, `dt/` the
 * incidents with a story attached that the Deception Tasks read. A series
 * config names a scenario by `id`; the prep step runs the script against
 * each base day, writes the delta, and generates the listed families from
 * the scenario day. Scripts under `demo/` are not benchmark scenarios and
 * are not listed.
 */

export interface BenchScenario {
  /** Name used in series configs and output file names. */
  id: string;
  /** The task group whose families read this scenario; also the script's directory. */
  group: "rti" | "dt";
  /** Script path relative to this directory. */
  file: string;
  /** The `kind` of the event the script records, which the task families key on. */
  eventKind: string;
  /** Task families generated from a scenario day of this scenario. */
  families: readonly string[];
  /** Person-affecting footprint, so a prep step can size a run. */
  maxAffected: number;
}

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  { id: "mass-shooting", group: "rti", file: "rti/mass-shooting.ts", eventKind: "shooting", families: ["mass-shooting"], maxAffected: 1500 },
  { id: "shots-fired", group: "rti", file: "rti/shots-fired.ts", eventKind: "shots-fired", families: ["shots-fired"], maxAffected: 256 },
  { id: "protest", group: "rti", file: "rti/protest.ts", eventKind: "protest", families: ["protest-members"], maxAffected: 2000 },
  { id: "mass-gathering", group: "rti", file: "rti/mass-gathering.ts", eventKind: "gathering", families: ["mass-gathering"], maxAffected: 1200 },
  { id: "explosion", group: "rti", file: "rti/explosion.ts", eventKind: "explosion", families: ["explosion"], maxAffected: 2500 },
  { id: "school-shooting", group: "rti", file: "rti/school-shooting.ts", eventKind: "school-shooting", families: ["school-shooting"], maxAffected: 2500 },
  { id: "abduction", group: "rti", file: "rti/abduction.ts", eventKind: "abduction", families: ["abduction"], maxAffected: 64 },
  { id: "stabbing-alibi", group: "dt", file: "dt/stabbing-alibi.ts", eventKind: "stabbing", families: ["stabbing"], maxAffected: 64 },
  { id: "swatting", group: "dt", file: "dt/swatting.ts", eventKind: "swatting", families: ["swatting"], maxAffected: 64 },
  { id: "never-arrived", group: "dt", file: "dt/never-arrived.ts", eventKind: "disappearance", families: ["disappearance"], maxAffected: 64 },
];

/** The task-group directories under `scenarios/`, every script in which is catalogued. */
export const SCENARIO_GROUPS = [...new Set(BENCH_SCENARIOS.map((entry) => entry.group))];

export const scenarioById = new Map(BENCH_SCENARIOS.map((entry) => [entry.id, entry]));

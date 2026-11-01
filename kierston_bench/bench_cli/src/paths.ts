/** Where the console looks for everything, in one place. */

import { resolve } from "node:path";

export const BENCH_ROOT = resolve(import.meta.dir, "../..");
export const REPO_ROOT = resolve(BENCH_ROOT, "..");

export const PATHS = {
  runs: resolve(BENCH_ROOT, "runs"),
  runSeries: resolve(BENCH_ROOT, "run_series"),
  sweeps: resolve(BENCH_ROOT, "sweeps"),
  seriesConfigs: resolve(BENCH_ROOT, "run_series_prep/configs"),
  simData: resolve(REPO_ROOT, "kierston/sim_data"),
  simOutputs: resolve(REPO_ROOT, "kierston/sim_outputs"),
  evalRunner: resolve(BENCH_ROOT, "eval_runner/src/cli.ts"),
  kdiService: resolve(BENCH_ROOT, "agent_eval_runtime/kdi_service.ts"),
  seriesPrep: resolve(BENCH_ROOT, "run_series_prep/src/cli.ts"),
  kdiLog: resolve(BENCH_ROOT, "agent_eval_runtime/kdi_log"),
  envLocal: resolve(REPO_ROOT, ".env.local"),
};

export const DEFAULTS = {
  image: "kierston-eval-env",
  concurrency: 2,
  timeout: "0",
  /** Minutes each task's agent gets before it is told to stop; 0 means no deadline. */
  deadlineMinutes: 20,
  /** Minutes past the deadline before a container still running is killed. */
  deadlineGraceMinutes: 3,
  kdiServiceUrl: "http://host.docker.internal:8765",
  kdiServiceProbeUrl: "http://127.0.0.1:8765",
  docker: process.env.BENCH_DOCKER ?? "docker",
};

/** The series file a series id is generated into. */
export function seriesFileFor(id: string): string {
  return resolve(PATHS.runSeries, `run_series_${id}_tasks_data.json`);
}

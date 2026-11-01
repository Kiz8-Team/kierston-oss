import { beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRun, listRuns, listSeries, loadLiveTaskRows, loadRun, summariseRun } from "../src/inventory.ts";
import { PATHS } from "../src/paths.ts";

let root: string;
let runsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kbench-cli-"));
  runsDir = join(root, "runs");
  await mkdir(runsDir, { recursive: true });
});

async function taskDir(run: string, id: string, meta: Record<string, unknown> | null): Promise<string> {
  const dir = join(runsDir, "unit", run, id.replace(/[^A-Za-z0-9_.-]/g, "_"));
  await mkdir(dir, { recursive: true });
  if (meta) await writeFile(join(dir, "meta.json"), JSON.stringify({ id, family: id.split(":")[0], date: "2026-09-01", ...meta }));
  return dir;
}

test("a finished run reads its counts from run.json", async () => {
  const dir = join(runsDir, "unit", "done");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      series: "unit",
      runId: "done",
      image: "kierston-eval-env",
      startedAt: "2026-09-01T10:00:00.000Z",
      finishedAt: "2026-09-01T10:30:00.000Z",
      concurrency: 2,
      timeoutMs: 1000,
      tasks: [{ id: "a:1", status: "answered" }],
      counts: { answered: 1, "no-answer": 0, "invalid-answer": 0, timeout: 0, error: 0, skipped: 0 },
    }),
  );
  const summary = await summariseRun(dir, "unit", "done", 3);
  expect(summary.state).toBe("complete");
  expect(summary.done).toBe(1);
  expect(summary.total).toBe(1);
  expect(summary.counts.answered).toBe(1);
});

test("a run reads its custom name from launch metadata", async () => {
  const dir = join(runsDir, "unit", "named");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "launch.json"), JSON.stringify({ spec: { name: "Baseline GPT" } }));
  expect((await summariseRun(dir, "unit", "named", 3)).name).toBe("Baseline GPT");
});

test("a run with a task still open is running, and its tasks are pending", async () => {
  await taskDir("live", "a:1", { status: "answered", finishedAt: new Date().toISOString(), durationMs: 10, kdiCalls: 2 });
  // A task in flight has no meta.json yet. The bundle the container is reading
  // carries only its opaque case id; active.json is where its real id comes from.
  const open = await taskDir("live", "b:2", null);
  await mkdir(join(open, "input"), { recursive: true });
  await writeFile(join(open, "input", "input.json"), JSON.stringify({ id: "case-0b2", date: "2026-09-01" }));
  await writeFile(join(open, "active.json"), JSON.stringify({ container: "bench-b-2", kdiTaskId: "live/b:2" }));
  const summary = await summariseRun(join(runsDir, "unit", "live"), "unit", "live", 3);
  expect(summary.state).toBe("running");
  expect(summary.done).toBe(1);
  expect(summary.inFlight).toBe(1);

  const detail = await loadRun(join(runsDir, "unit", "live"), "unit", "live");
  expect(detail.tasks.find((task) => task.id === "b:2")!.status).toBe("running");
});

test("an active task does not flip back to pending after five minutes", async () => {
  const open = await taskDir("long-running", "b:2", null);
  await mkdir(join(open, "input"), { recursive: true });
  await writeFile(join(open, "input", "input.json"), JSON.stringify({ id: "case-0b2", date: "2026-09-01" }));
  await writeFile(join(open, "active.json"), JSON.stringify({ container: "bench-b-2", kdiTaskId: "long-running/b:2" }));

  const stale = new Date(Date.now() - 10 * 60_000);
  await utimes(open, stale, stale);
  const active = new Date();
  await utimes(join(open, "active.json"), active, active);

  const detail = await loadRun(join(runsDir, "unit", "long-running"), "unit", "long-running");
  expect(detail.state).toBe("running");
  expect(detail.tasks.find((task) => task.id === "b:2")!.status).toBe("running");
});

test("a run nothing has touched for a while is interrupted, not running", async () => {
  const dir = await taskDir("stale", "a:1", {
    status: "answered",
    finishedAt: new Date(Date.now() - 3600_000).toISOString(),
    durationMs: 10,
    kdiCalls: 0,
  });
  await Bun.write(join(dir, "answer.json"), JSON.stringify({ taskId: "a:1", answer: ["x"] }));
  const summary = await summariseRun(join(runsDir, "unit", "stale"), "unit", "stale", 2);
  expect(summary.state).toBe("interrupted");
  const detail = await loadRun(join(runsDir, "unit", "stale"), "unit", "stale");
  expect(detail.tasks[0]!.hasAnswer).toBe(true);
});

test("a runner-written interrupted report is immediately shown as interrupted", async () => {
  const dir = join(root, "runs", "s", "stopped");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({
    series: "s", runId: "stopped", image: "image", startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), concurrency: 1, timeoutMs: 1000,
    tasks: [], counts: { answered: 0, "no-answer": 0, "invalid-answer": 0, timeout: 0, error: 0, skipped: 0 },
    interrupted: true,
  }));
  expect((await summariseRun(dir, "s", "stopped", 3)).state).toBe("interrupted");
});

test("a live selection supplies its true total and per-task states", async () => {
  const dir = join(root, "selected-run");
  await mkdir(join(dir, "a_1"), { recursive: true });
  await mkdir(join(dir, "b_2"), { recursive: true });
  await writeFile(join(dir, "selection.json"), JSON.stringify({ taskIds: ["a:1", "b:2", "c:3"] }));
  await writeFile(join(dir, "a_1", "meta.json"), JSON.stringify({
    id: "a:1", family: "a", date: "2026-09-01", status: "answered",
    durationMs: 1000, kdiCalls: 2, startedAt: "2026-09-01T00:00:00Z",
  }));

  expect((await summariseRun(dir, "unit", "selected", 79)).total).toBe(3);
  const live = await loadLiveTaskRows(dir, ["a:1", "b:2", "c:3"], true);
  expect(live.map((task) => task.status)).toEqual(["answered", "running", "pending"]);
  const stopped = await loadLiveTaskRows(dir, ["a:1", "b:2", "c:3"], false);
  expect(stopped.map((task) => task.status)).toEqual(["answered", "not-run", "not-run"]);
});

test("runs are listed newest first", async () => {
  const runs = await listRuns(runsDir);
  expect(runs.map((run) => run.runId).sort()).toEqual(["done", "live", "long-running", "named", "stale", "stopped"]);
  expect((await findRun("Baseline GPT", runsDir))?.runId).toBe("named");
});

// run_series/ is generated and gitignored, so a fresh checkout has none to read.
const seriesOnDisk = existsSync(PATHS.runSeries) && readdirSync(PATHS.runSeries).some((name) => name.endsWith(".json"));

test.skipIf(!seriesOnDisk)("the repository's own series are readable", async () => {
  const series = await listSeries(PATHS.runs, PATHS.runSeries);
  expect(series.length).toBeGreaterThan(0);
  expect(series[0]!.taskCount).toBeGreaterThan(0);
});

test("a killed container's exit code reaches the task row", async () => {
  // Without it, a container docker killed reads exactly like an agent that ran
  // fine and chose to write nothing.
  await taskDir("killed", "a:1", {
    status: "no-answer",
    exitCode: 137,
    timedOut: false,
    finishedAt: new Date().toISOString(),
    durationMs: 400,
    kdiCalls: 0,
  });
  const detail = await loadRun(join(runsDir, "unit", "killed"), "unit", "killed");
  const row = detail.tasks.find((task) => task.id === "a:1");
  expect(row?.exitCode).toBe(137);
  expect(row?.timedOut).toBe(false);
  expect(row?.hasAnswer).toBe(false);
});

test("listing a series reads its header, never the truth payload behind the tasks", async () => {
  const { seriesText } = await import("../../run_series_prep/src/series.ts");
  const dir = join(root, "series-header");
  await mkdir(dir, { recursive: true });
  const header = { id: "big", createdAt: "2026-09-01T00:00:00Z", seed: 3, days: [{ file: "day_2026-09-01.bin", date: "2026-09-01" }], families: ["colocation"], taskCount: 1, config: { tasks: 1 }, generatorVersion: "x" };
  const text = seriesText({ series: header, outcomes: [], tasks: [{ id: "colocation:2026-09-01:1" } as never], truth: { source: "kierston/sim_data" } as never });
  // A truth line that would not even parse proves it is never read.
  await writeFile(join(dir, "run_series_big_tasks_data.json"), text.replace(/"truth": .*\n/, '"truth": {not json\n'));
  const [entry] = await listSeries(join(root, "no-runs"), dir);
  expect(entry!.id).toBe("big");
  expect(entry!.taskCount).toBe(1);
  expect(entry!.days).toEqual(header.days);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { KierstonBenchTask } from "../../task_generators/src/task.ts";
import { ScenarioLock } from "../src/scenario-lock.ts";
import { containerName, runArgs } from "../src/docker.ts";
import type { ActiveScenario, ScenarioStore } from "../src/scenarios.ts";
import { DEFAULT_STARTUP_COMMAND, deadlineFor, kdiLogName, runSeries, runTask, startupCommandFor, taskDirName, type RunOptions, type TaskStatus } from "../src/runner.ts";

import { BENCH_CONTEXT } from "../src/context.ts";

const FAKE = resolve(import.meta.dir, "fixtures/fake-docker.sh");

function task(n: number, family = "colocation"): KierstonBenchTask {
  return {
    id: `${family}:2026-09-01:${n}`,
    family,
    date: "2026-09-01",
    seed: n,
    prompt: "?",
    evidence: { n },
    answer: { kind: "ranked-ids", description: "ids" },
    groundTruth: `secret-${n}`,
    scoring: { method: "rank", aggregate: "mrr" },
  };
}

let root: string;
let seriesFile: string;
let kdiLogDir: string;
let kdiPolicyDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "eval-runner-"));
  kdiLogDir = join(root, "kdi_log");
  kdiPolicyDir = join(root, "kdi_policy");
  await mkdir(kdiLogDir);
  await mkdir(kdiPolicyDir);
  seriesFile = join(root, "series.json");
  await writeFile(
    seriesFile,
    JSON.stringify({
      series: { id: "t", createdAt: "", seed: 1, days: [], families: [], taskCount: 3, config: {}, generatorVersion: "x" },
      outcomes: [],
      tasks: [task(1), task(2), task(3, "trip-mode")],
    }),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    seriesFile,
    image: "agent:test",
    outDir: join(root, "runs"),
    runId: "run1",
    concurrency: 2,
    timeoutMs: 60_000,
    kdiServiceUrl: "http://kdi-service",
    kdiLogDir,
    kdiPolicyDir,
    resume: false,
    dockerArgs: [],
    command: [],
    docker: FAKE,
    log: () => {},
    ...overrides,
  };
}

describe("docker args", () => {
  test("container names are docker-safe", () => {
    expect(containerName("bench", "run 1", "case-0123456789ab")).toBe("bench-run_1-case-0123456789ab");
  });
  test("run args carry mounts, env, passthrough flags and command in order", () => {
    const args = runArgs({
      docker: "docker",
      image: "img",
      name: "n",
      mounts: [{ host: "/h/task", container: "/task", readOnly: true }, { host: "/h/out", container: "/out" }],
      env: { AT: "r/t" },
      extraArgs: ["--network=none"],
      command: ["bash", "-c", "true"],
      timeoutMs: 1,
      consolePath: "/dev/null",
    });
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--name", "n"]);
    expect(args).toContain("/h/task:/task:ro");
    expect(args).toContain("/h/out:/out");
    expect(args).toContain("AT=r/t");
    expect(args.join(" ")).not.toMatch(/KDI_|BENCH_|AC=/);
    expect(args.slice(-5)).toEqual(["--network=none", "img", "bash", "-c", "true"]);
  });
  test("task directory and kdi log names agree with the KDI service", () => {
    expect(taskDirName("a:b:1")).toBe("a_b_1");
    expect(kdiLogName("run1/a:b:1")).toBe("run1_a_b_1.jsonl");
  });
});

describe("runSeries", () => {
  test("one directory per task with answer, logs, work, console and kdi calls", async () => {
    process.env.FAKE_KDI_LOG_DIR = kdiLogDir;
    process.env.FAKE_KDI_POLICY_DIR = options().kdiPolicyDir!;
    const report = await runSeries(options());
    delete process.env.FAKE_KDI_LOG_DIR;
    delete process.env.FAKE_KDI_POLICY_DIR;
    expect(report.counts.answered).toBe(3);
    expect(report.tasks.map((t) => t.id)).toEqual(["colocation:2026-09-01:1", "colocation:2026-09-01:2", "trip-mode:2026-09-01:3"]);

    const dir = join(root, "runs/t/run1/colocation_2026-09-01_1");
    expect(await readFile(join(dir, "context.txt"), "utf8")).toBe(BENCH_CONTEXT + "\n");
    expect(await readFile(join(dir, "logs/context.txt"), "utf8")).toBe(BENCH_CONTEXT + "\n");
    const bundle = JSON.parse(await readFile(join(dir, "input.json"), "utf8"));
    const meta0 = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    expect(bundle.id).toBe(meta0.caseId);
    expect(bundle.id).not.toContain("colocation");
    expect(JSON.stringify(bundle)).not.toContain("secret");
    expect(JSON.parse(await readFile(join(dir, "answer.json"), "utf8")).answer).toEqual(["p1", "p2"]);
    expect(await readFile(join(dir, "logs/agent.log"), "utf8")).toBe("transcript\n");
    expect(await readFile(join(dir, "work/script.py"), "utf8")).toBe("print('hi')\n");
    const console = await readFile(join(dir, "console.log"), "utf8");
    expect(console).toContain(`fake docker: task ${meta0.caseId}`);
    expect(console).toContain("stderr line");
    expect(console).toContain(`fake docker: startup: ${DEFAULT_STARTUP_COMMAND}`);
    expect(bundle).not.toHaveProperty("startupCommand");
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    expect(meta.status).toBe("answered");
    expect(meta.startupCommand).toBe(DEFAULT_STARTUP_COMMAND);
    expect(meta.exitCode).toBe(0);
    expect(meta.kdiCalls).toBe(2);
    expect(meta.kdiTaskId).toBe("run1/colocation:2026-09-01:1");
    expect((await readFile(join(dir, "kdi_calls.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
    expect(await stat(join(dir, "out")).catch(() => null)).toBeNull();
    const run = JSON.parse(await readFile(join(root, "runs/t/run1/run.json"), "utf8"));
    expect(run.counts.answered).toBe(3);
    expect(run.provenance.image).toBe("agent:test");
    expect(run.provenance.model).toBeNull();
    expect(typeof run.provenance.gitDirty === "boolean" || run.provenance.gitDirty === null).toBe(true);
    expect(run.selectedTaskIds).toEqual([
      "colocation:2026-09-01:1", "colocation:2026-09-01:2", "trip-mode:2026-09-01:3",
    ]);
    expect(JSON.parse(await readFile(join(root, "runs/t/run1/selection.json"), "utf8")).taskIds).toEqual(run.selectedTaskIds);
  });

  test("family and task filters select", async () => {
    const byFamily = await runSeries(options({ runId: "run2", families: new Set(["trip-mode"]) }));
    expect(byFamily.tasks.map((t) => t.id)).toEqual(["trip-mode:2026-09-01:3"]);
    const byId = await runSeries(options({ runId: "run3", taskIds: new Set(["colocation:2026-09-01:2"]) }));
    expect(byId.tasks.map((t) => t.id)).toEqual(["colocation:2026-09-01:2"]);
  });

  test("resume skips finished tasks", async () => {
    await runSeries(options({ runId: "run4", taskIds: new Set(["colocation:2026-09-01:2"]) }));
    const report = await runSeries(options({ runId: "run4", resume: true }));
    expect(report.counts.skipped).toBe(1);
    expect(report.tasks).toHaveLength(2);
  });

  test("an interrupt stops active tasks and never starts queued tasks", async () => {
    const controller = new AbortController();
    const runId = "run-stop";
    process.env.FAKE_MODE = "hang";
    process.env.FAKE_OUT_ROOT = join(root, `runs/t/${runId}`);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const report = await runSeries(options({ runId, concurrency: 1, signal: controller.signal }));
      expect(report.interrupted).toBe(true);
      expect(report.tasks).toHaveLength(1);
      expect(report.tasks[0]!.id).toBe("colocation:2026-09-01:1");
      expect(JSON.parse(await readFile(join(root, `runs/t/${runId}/run.json`), "utf8")).interrupted).toBe(true);
    } finally {
      clearTimeout(timer);
      delete process.env.FAKE_MODE;
      delete process.env.FAKE_OUT_ROOT;
    }
  });
});

describe("scenario tasks", () => {
  const DATE = "2026-09-01";

  function scenarioTask(n: number): KierstonBenchTask {
    return {
      ...task(n, "swatting"),
      scenario: { name: "swatting", seed: n, base: `kierston/sim_outputs/day_${DATE}.bin`, delta: `kierston/sim_outputs/scenarios/s/swatting_${DATE}_${n}.kdiff` },
    };
  }

  /** Behaves as Fastgate does: one scenario per date, apply refuses over another, revert refuses on nothing. */
  function fakeStore(initial: string[], applyError?: string) {
    const applied = new Map<string, ActiveScenario>(initial.map((date) => [date, { date, baseDigest: "b", scenarioDigest: "leftover", status: "complete" }]));
    const events: { at: number; what: string }[] = [];
    const store: ScenarioStore = {
      async active() {
        return [...applied.values()];
      },
      async apply(delta) {
        expect(delta).toStartWith("/");
        if (applyError) throw new Error(applyError);
        if (applied.has(DATE)) throw new Error(`a different scenario is already active for ${DATE}`);
        await Bun.sleep(20);
        applied.set(DATE, { date: DATE, baseDigest: "b", scenarioDigest: basename(delta), status: "complete" });
        events.push({ at: Date.now(), what: `apply ${basename(delta)}` });
      },
      async revert(date) {
        if (!applied.delete(date)) throw new Error(`no scenario is active for ${date}`);
        events.push({ at: Date.now(), what: `revert ${date}` });
      },
    };
    return { store, events, applied };
  }

  async function seriesOf(name: string, tasks: KierstonBenchTask[]): Promise<string> {
    const file = join(root, `${name}.json`);
    await writeFile(file, JSON.stringify({
      series: { id: name, createdAt: "", seed: 1, days: [], families: [], taskCount: tasks.length, config: {}, generatorVersion: "x" },
      outcomes: [],
      tasks,
    }));
    return file;
  }

  test("leftovers are reverted, and a scenario task runs alone: no task of any date beside it, reverted after", async () => {
    const otherDay = { ...task(6), id: "colocation:2026-09-05:6", date: "2026-09-05" };
    const seriesFile = await seriesOf("scenarios", [scenarioTask(1), task(2), scenarioTask(3), otherDay, { ...task(7), id: "colocation:2026-09-05:7", date: "2026-09-05" }]);
    const { store, events, applied } = fakeStore([DATE, "2026-08-31"]);
    const report = await runSeries(options({ seriesFile, runId: "scen", concurrency: 4, scenarios: store, scenarioLock: new ScenarioLock(join(root, "lock"), 5) }));
    expect(report.counts.answered).toBe(5);
    expect(applied.size).toBe(0);
    expect(events.slice(0, 2).map((event) => event.what).sort()).toEqual(["revert 2026-08-31", `revert ${DATE}`]);
    const rest = events.slice(2);
    expect(rest.map((event) => event.what).filter((what) => what.startsWith("apply"))).toHaveLength(2);
    const scenarioIds = new Set([scenarioTask(1).id, scenarioTask(3).id]);
    const spans = (id: string) => { const meta = report.tasks.find((m) => m.id === id)!; return [Date.parse(meta.startedAt), Date.parse(meta.finishedAt)] as const; };
    for (const id of scenarioIds) {
      const [start, end] = spans(id);
      for (const other of report.tasks.filter((meta) => meta.id !== id)) {
        const [otherStart, otherEnd] = spans(other.id);
        expect(otherEnd <= start || otherStart >= end).toBe(true);
      }
    }
    rest.forEach((event, i) => {
      if (event.what.startsWith("apply")) expect(rest[i + 1]!.what).toBe(`revert ${DATE}`);
    });
  });

  test("RTI and DT tasks start only after every TT is done, and never side by side", async () => {
    const plain = [1, 2, 3].map((n) => ({ ...task(30 + n), id: `colocation:2026-09-0${n}:${30 + n}`, date: `2026-09-0${n}` }));
    const seriesFile = await seriesOf("phases", [scenarioTask(31), plain[0]!, scenarioTask(32), plain[1]!, plain[2]!]);
    const { store } = fakeStore([]);
    process.env.FAKE_MODE = "slow";
    try {
      const report = await runSeries(options({ seriesFile, runId: "phases", concurrency: 3, scenarios: store, scenarioLock: new ScenarioLock(join(root, "lock"), 5) }));
      expect(report.counts.answered).toBe(5);
      const span = (meta: { startedAt: string; finishedAt: string }) => [Date.parse(meta.startedAt), Date.parse(meta.finishedAt)] as const;
      const plainMetas = report.tasks.filter((meta) => meta.family === "colocation");
      const stagedMetas = report.tasks.filter((meta) => meta.family !== "colocation").map(span).sort((a, b) => a[0] - b[0]);
      const lastPlainEnd = Math.max(...plainMetas.map((meta) => span(meta)[1]));
      expect(Math.max(...plainMetas.map((meta) => span(meta)[0]))).toBeLessThan(Math.min(...plainMetas.map((meta) => span(meta)[1])));
      for (const [start] of stagedMetas) expect(start).toBeGreaterThanOrEqual(lastPlainEnd);
      expect(stagedMetas[1]![0]).toBeGreaterThanOrEqual(stagedMetas[0]![1]);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  test("plain tasks still run side by side", async () => {
    const tasks = [1, 2, 3].map((n) => ({ ...task(20 + n), id: `colocation:2026-09-0${n}:${20 + n}`, date: `2026-09-0${n}` }));
    const seriesFile = await seriesOf("plain-parallel", tasks);
    const { store } = fakeStore([]);
    process.env.FAKE_MODE = "slow";
    try {
      const report = await runSeries(options({ seriesFile, runId: "par", concurrency: 3, scenarios: store, scenarioLock: new ScenarioLock(join(root, "lock"), 5) }));
      const starts = report.tasks.map((meta) => Date.parse(meta.startedAt));
      const ends = report.tasks.map((meta) => Date.parse(meta.finishedAt));
      expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  test("a refused apply is the task's error, the container never starts, and nothing is left applied", async () => {
    const seriesFile = await seriesOf("scenario-refused", [scenarioTask(4)]);
    const { store, applied } = fakeStore([], "the exact base KDAY must be completely imported before applying its KDIF");
    const report = await runSeries(options({ seriesFile, runId: "refused", scenarios: store, scenarioLock: new ScenarioLock(join(root, "lock"), 5) }));
    expect(report.counts.error).toBe(1);
    expect(applied.size).toBe(0);
    const dir = join(root, "runs/scenario-refused/refused", taskDirName(scenarioTask(4).id));
    expect(JSON.parse(await readFile(join(dir, "meta.json"), "utf8")).error).toContain("base KDAY must be completely imported");
    expect(await readFile(join(dir, "console.log"), "utf8").catch(() => "")).not.toContain("fake docker");
  });

  test("a stop during scenario setup never starts the container, and the apply is reverted", async () => {
    const seriesFile = await seriesOf("scenario-stopped", [scenarioTask(8), scenarioTask(9)]);
    const { store, events, applied } = fakeStore([]);
    const controller = new AbortController();
    const apply = store.apply;
    store.apply = async (delta) => {
      controller.abort();
      await apply(delta);
    };
    const report = await runSeries(options({ seriesFile, runId: "stopped", concurrency: 1, scenarios: store, scenarioLock: new ScenarioLock(join(root, "lock"), 5), signal: controller.signal }));
    expect(report.interrupted).toBe(true);
    expect(report.tasks).toHaveLength(0);
    expect(applied.size).toBe(0);
    expect(events.map((event) => event.what)).toEqual([`apply swatting_${DATE}_8.kdiff`, `revert ${DATE}`]);
    const dir = join(root, "runs/scenario-stopped/stopped", taskDirName(scenarioTask(8).id));
    expect(await stat(join(dir, "console.log")).catch(() => null)).toBeNull();
  });

  test("without a scenario store a scenario task is an error, not a run against the base day", async () => {
    const seriesFile = await seriesOf("scenario-no-store", [scenarioTask(5)]);
    const report = await runSeries(options({ seriesFile, runId: "no-store" }));
    expect(report.counts.error).toBe(1);
  });

  test("scenario lock: shared holders share across instances, exclusive waits for them, and a waiting exclusive keeps new shared out", async () => {
    const dir = join(root, "lock-unit");
    const a = new ScenarioLock(dir, 5);
    const b = new ScenarioLock(dir, 5);
    const shared = await a.acquire("shared", "a");
    const sharedToo = await b.acquire("shared", "b", { wait: false });
    expect(sharedToo).not.toBeNull();
    expect(await b.acquire("exclusive", "b", { wait: false })).toBeNull();
    let granted = false;
    const exclusive = b.acquire("exclusive", "b").then((release) => ((granted = true), release));
    await Bun.sleep(40);
    expect(granted).toBe(false);
    expect(await a.acquire("shared", "a2", { wait: false })).toBeNull();
    await shared!();
    await sharedToo!();
    const release = await exclusive;
    expect(granted).toBe(true);
    expect(await a.acquire("shared", "a3", { wait: false })).toBeNull();
    await release!();
    const after = await a.acquire("shared", "a4", { wait: false });
    expect(after).not.toBeNull();
    await after!();
  });
});

describe("runTask statuses", () => {
  const modes: [string, TaskStatus, number | null][] = [
    ["none", "no-answer", 0],
    ["bad-json", "invalid-answer", 0],
    ["wrong-id", "answered", 0],
    ["fail", "no-answer", 3],
  ];
  for (const [mode, status, exitCode] of modes) {
    test(`${mode} -> ${status}`, async () => {
      process.env.FAKE_MODE = mode;
      const meta = await runTask(task(9), join(root, `status-${mode}`), options());
      delete process.env.FAKE_MODE;
      expect(meta.status).toBe(status);
      expect(meta.exitCode).toBe(exitCode);
      expect(await readFile(join(root, `status-${mode}/logs/pi-sessions/--work--/2026-09-06T00-00-00-000Z_test.jsonl`), "utf8")).toContain("toolResult");
    });
  }

  test("legacy timeout values do not kill tasks", async () => {
    const meta = await runTask(task(10), join(root, "status-no-deadline"), options({ timeoutMs: 1 }));
    expect(meta.status).toBe("answered");
    expect(meta.timedOut).toBe(false);
    expect(meta.durationMs).toBeGreaterThan(1);
  });

  test("a deadline reaches the agent, closes the KDI service's door and kills a container that outlives it", async () => {
    const dir = join(root, "runs/t/deadline/x");
    process.env.FAKE_MODE = "hang";
    process.env.FAKE_OUT_ROOT = join(root, "runs/t/deadline");
    try {
      const meta = await runTask(task(12), dir, options({ runId: "deadline", deadlineMs: 50, deadlineGraceMs: 50 }));
      expect(meta.status).toBe("timeout");
      expect(meta.timedOut).toBe(true);
      expect(meta.deadlineMs).toBe(50);
      expect(meta.forcedAt).toBeUndefined();
    } finally {
      delete process.env.FAKE_MODE;
      delete process.env.FAKE_OUT_ROOT;
    }
    const context = await readFile(join(dir, "context.txt"), "utf8");
    expect(context).toContain("need your findings within");
    expect(await readFile(join(dir, "console.log"), "utf8")).toContain("-e /opt/pi-ext/clock.ts");
  });
  test("without a deadline nothing about time reaches the agent", async () => {
    const dir = join(root, "runs/t/no-deadline/x");
    await runTask(task(13), dir, options({ runId: "no-deadline" }));
    expect(await readFile(join(dir, "context.txt"), "utf8")).toBe(BENCH_CONTEXT + "\n");
  });
  test("the series' deadline applies unless the operator sets one", () => {
    const series = { series: { agent: { deadlineMinutes: 20 } } } as never;
    expect(deadlineFor(series, {})).toBe(1_200_000);
    expect(deadlineFor(series, { deadlineMs: 60_000 })).toBe(60_000);
    expect(deadlineFor(series, { deadlineMs: 0 })).toBeUndefined();
    expect(deadlineFor({ series: {} } as never, {})).toBeUndefined();
  });

  test("a missing docker binary is an error, not a crash", async () => {
    const meta = await runTask(task(11), join(root, "status-error"), options({ docker: "/nonexistent/docker" }));
    expect(meta.status).toBe("error");
    expect(JSON.parse(await readFile(join(root, "status-error/meta.json"), "utf8")).error).toBeString();
  });

  test("a task the bundle refuses is that task's error; the rest of the series still runs", async () => {
    const legacy = { ...task(1), prompt: "The victim is person 102466." };
    const file = join(root, "legacy-series.json");
    await writeFile(file, JSON.stringify({
      series: { id: "legacy", createdAt: "", seed: 1, days: [], families: [], taskCount: 2, config: {}, generatorVersion: "x" },
      outcomes: [],
      tasks: [legacy, task(2)],
    }));
    const report = await runSeries(options({ seriesFile: file, runId: "legacy-run" }));
    expect(report.tasks.map((t) => [t.id, t.status])).toEqual([
      ["colocation:2026-09-01:1", "error"],
      ["colocation:2026-09-01:2", "answered"],
    ]);
    const meta = JSON.parse(await readFile(join(root, "runs/legacy/legacy-run/colocation_2026-09-01_1/meta.json"), "utf8"));
    expect(meta.error).toContain("legacy numeric person anchor");
  });
});

describe("startup command", () => {
  const series = (agent?: string) => ({
    series: { id: "s", createdAt: "", seed: 1, days: [], families: [], taskCount: 0, config: {}, generatorVersion: "x", ...(agent ? { agent: { startupCommand: agent } } : {}) },
    outcomes: [],
    tasks: [],
  });
  test("operator beats task beats series beats default", () => {
    const own = { ...task(1), startupCommand: "from-task" };
    expect(startupCommandFor(task(1), series(), {})).toBe(DEFAULT_STARTUP_COMMAND);
    expect(startupCommandFor(task(1), series("from-series"), {})).toBe("from-series");
    expect(startupCommandFor(own, series("from-series"), {})).toBe("from-task");
    expect(startupCommandFor(own, series("from-series"), { startupCommand: "from-cli" })).toBe("from-cli");
  });
  test("the task's own command runs under bash -c and is recorded", async () => {
    const own = { ...task(9), startupCommand: "pi -p hello" };
    const dir = join(root, "runs/t/cmd/x");
    const meta = await runTask(own, dir, options({ runId: "cmd", model: "m", env: { KEY: "v" }, agentDir: join(root, "auth") }));
    expect(meta.startupCommand).toBe("pi -p hello");
    expect(await readFile(join(dir, "logs/pi-sessions/--work--/2026-09-06T00-00-00-000Z_test.jsonl"), "utf8")).toContain("toolResult");
    expect(await readFile(join(dir, "console.log"), "utf8")).toContain("fake docker: startup: pi -p hello");
    expect(JSON.parse(await readFile(join(dir, "input.json"), "utf8"))).not.toHaveProperty("startupCommand");
  });
  test("a raw -- command bypasses the shell", async () => {
    const dir = join(root, "runs/t/raw/x");
    const meta = await runTask(task(8), dir, options({ runId: "raw", command: ["true"] }));
    expect(meta.startupCommand).toBe("true");
    expect(await readFile(join(dir, "console.log"), "utf8")).not.toContain("fake docker: startup:");
  });
  test("model and env reach the container", () => {
    const args = runArgs({
      docker: "docker", image: "img", name: "n", mounts: [], extraArgs: [], command: ["bash", "-c", "x"], timeoutMs: 1, consolePath: "/dev/null",
      env: { KEY: "v", EM: "m" },
    });
    expect(args).toContain("KEY=v");
    expect(args).toContain("EM=m");
  });
});

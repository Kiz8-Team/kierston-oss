import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile, chmod, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { defaultSpec, runDirFor } from "../src/dispatch.ts";
import { rerunTaskBackground, readManaged, saveLaunch, saveManaged } from "../src/background.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import { summariseRun } from "../src/inventory.ts";

// The scenario lock is machine-wide by default; a live run elsewhere must not stall these tests.
process.env.BENCH_SCENARIO_LOCK_DIR ??= await mkdtemp(join(tmpdir(), "bench-scenario-lock-"));

for (const state of ["finished", "failed", "running"] as const) test(`single-task rerun of ${state} run preserves its worker and scope and rescores`, async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-rerun-test-"));
  try {
    const fake = join(root, "docker");
    await writeFile(fake, `#!${process.execPath}\nprocess.exit(0);\n`);
    await chmod(fake, 0o755);
    const tasks = ["a", "b"].map(id => ({ id, family: "colocation", date: "2026-09-01", prompt: "?", answer: { kind: "ranked-ids", description: "ids" }, scoring: { method: "rank", aggregate: "mrr" } }));
    const series = join(root, "series.json");
    await writeFile(series, JSON.stringify({ series: { id: "unit", families: [], days: [], taskCount: 2 }, tasks }));
    const spec = { ...defaultSpec(series, "unit"), outDir: root, runId: "past", agentDir: "none", env: [`BENCH_DOCKER=${fake}`] };
    const dir = runDirFor(spec);
    await saveLaunch(spec, { BENCH_DOCKER: fake });
    for (const task of tasks) {
      await mkdir(join(dir, taskDirName(task.id)));
      await writeFile(join(dir, taskDirName(task.id), "meta.json"), JSON.stringify({ ...task, status: "error", finishedAt: new Date().toISOString(), durationMs: 1, kdiCalls: 0 }));
    }
    const untouched = await Bun.file(join(dir, "b", "meta.json")).text();
    if (state !== "running") await writeFile(join(dir, "run.json"), JSON.stringify({ series: "unit", runId: "past", image: spec.image, selectedTaskIds: ["a", "b"], tasks, counts: { error: 2 }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...(state === "failed" ? { interrupted: true } : {}) }));
    await writeFile(join(dir, "selection.json"), JSON.stringify({ taskIds: ["a", "b"] }));
    await saveManaged(dir, { token: "old", host: hostname(), backend: "process", state, heartbeat: Date.now() });
    const originalManager = await Bun.file(join(dir, "manager.json")).text();
    const originalReport = await Bun.file(join(dir, "run.json")).text().catch(() => null);
    const originalLaunch = await Bun.file(join(dir, "launch.json")).text();
    if (state === "running") {
      await rm(join(dir, "b", "meta.json"));
      await expect(rerunTaskBackground(dir, "b")).rejects.toThrow("running or queued");
      await writeFile(join(dir, "b", "meta.json"), untouched);
    }
    expect(await Bun.file(join(dir, "b", "meta.json")).text()).toBe(untouched);
    const worker = await rerunTaskBackground(dir, "a");
    const deadline = Date.now() + 10000;
    while (!["finished", "failed"].includes((await readManaged(worker.dir))!.state) && Date.now() < deadline) await Bun.sleep(50);
    const manager = (await readManaged(worker.dir))!;
    if (manager.state !== "finished") throw new Error(await Bun.file(join(worker.dir, "runner.log")).text());
    expect(await Bun.file(join(dir, "manager.json")).text()).toBe(originalManager);
    expect(await Bun.file(join(dir, "run.json")).text().catch(() => null)).toBe(originalReport);
    expect(await Bun.file(join(dir, "launch.json")).text()).toBe(originalLaunch);
    const summary = await summariseRun(dir, "unit", "past", 2);
    expect(summary.total).toBe(2);
    expect(summary.counts["no-answer"]).toBe(1);
    expect(summary.counts.error).toBe(1);
    if (state === "running") {
      // An already-running, older runner can later write its cached report.
      // The TUI must still use the replacement task's current metadata.
      await writeFile(join(dir, "run.json"), JSON.stringify({ tasks, selectedTaskIds: ["a", "b"], counts: { error: 2 }, finishedAt: new Date().toISOString() }));
      expect((await summariseRun(dir, "unit", "past", 2)).counts["no-answer"]).toBe(1);
    }
    expect(await Bun.file(join(dir, "b", "meta.json")).text()).toBe(untouched);
    const score = await Bun.file(join(dir, "score.json")).json();
    expect(score.tasks.map((task: { id: string }) => task.id)).toEqual(["a", "b"]);
    const attempts = (await readdir(join(dir, ".reruns"))).filter(name => name.startsWith("attempt-"));
    expect((await Bun.file(join(dir, ".reruns", attempts[0]!, "previous-task", "meta.json")).json()).status).toBe("error");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

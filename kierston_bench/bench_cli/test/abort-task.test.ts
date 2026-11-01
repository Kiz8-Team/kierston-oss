import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortTask } from "../src/abort-task.ts";
import { defaultSpec, runDirFor } from "../src/dispatch.ts";
import { saveLaunch } from "../src/background.ts";
import { containerName } from "../../eval_runner/src/docker.ts";
import { runSeries, taskDirName } from "../../eval_runner/src/runner.ts";

test("abort targets one container, ignores old deadline, and lets queued tasks finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-abort-test-"));
  const controller = new AbortController();
  let running: ReturnType<typeof runSeries> | undefined;
  try {
    const fake = join(root, "docker");
    const legacyName = containerName("bench", "abort-test", "a");
    await writeFile(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const registry = name => root + '/' + name + '.json';
if (args[0] === 'inspect') {
  const r = await Bun.file(registry(args[1])).json();
  console.log(JSON.stringify([{ Id: args[1], State: { Running: true }, Config: { Env: ['AT=' + r.identity] } }]));
} else if (args[0] === 'kill') {
  const r = await Bun.file(registry(args[1])).json();
  process.kill(r.pid, 'SIGTERM');
} else {
  const name = args[args.indexOf('--name') + 1];
  const identity = args.find(a => a.startsWith('AT=')).slice(3);
  // Containers are named by opaque case id and mounted from opaque live
  // directories, so nothing on the command line names the task. The series
  // runs one task at a time in order, so the first container is task a.
  const first = root + '/first-container';
  if (!(await Bun.file(first).exists())) {
    await Bun.write(first, name);
    await Bun.write(registry(name), JSON.stringify({pid: process.pid, identity}));
    // Runners from before opaque case ids named the container by task id; answer to that name too.
    await Bun.write(registry(${JSON.stringify(legacyName)}), JSON.stringify({pid: process.pid, identity}));
    process.on('SIGTERM', () => process.exit(137));
    setInterval(() => {}, 1000);
  }
}
`);
    await chmod(fake, 0o755);
    const seriesFile = join(root, "series.json");
    await writeFile(seriesFile, JSON.stringify({ series: { id: "unit" }, tasks: ["a", "b"].map(id => ({ id, family: "colocation", date: "2026-09-01", prompt: "?", answer: { kind: "ranked-ids", description: "ids" }, scoring: { method: "rank", aggregate: "mrr" } })) }));
    const spec = { ...defaultSpec(seriesFile, "unit"), outDir: root, runId: "abort-test" };
    const dir = runDirFor(spec);
    await saveLaunch(spec, { BENCH_DOCKER: fake });
    running = runSeries({ seriesFile, image: "test", runId: spec.runId, outDir: root, concurrency: 1, timeoutMs: 1, kdiServiceUrl: "http://unused", kdiLogDir: join(root, "calls"), kdiPolicyDir: join(root, "policy"), resume: false, dockerArgs: [], command: [], docker: fake, log: () => {}, signal: controller.signal });
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(root, legacyName + ".json")).exists()) {
      if (Date.now() > deadline) throw new Error("Fake container did not start");
      await Bun.sleep(10);
    }
    await Bun.sleep(50);
    expect(await Bun.file(join(dir, "a", "meta.json")).exists()).toBe(false);
    await expect(abortTask(dir, "b")).rejects.toThrow();
    // Pre-existing runners do not have active.json. Exercise that fallback too.
    await rm(join(dir, taskDirName("a"), "active.json"));
    await abortTask(dir, "a");
    const report = await running;
    expect(report.interrupted).toBeUndefined();
    expect(report.timeoutMs).toBe(0);
    expect(report.tasks.find(task => task.id === "a")?.status).toBe("error");
    expect(report.tasks.find(task => task.id === "b")?.status).toBe("no-answer");
    expect((await Bun.file(join(dir, "a", "meta.json")).json()).error).toBe("Aborted by operator");
    await expect(abortTask(dir, "a")).rejects.toThrow("already finished");
  } finally {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

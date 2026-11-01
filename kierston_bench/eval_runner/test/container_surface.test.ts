/**
 * Nothing a container can read names the task: not its family, not its id,
 * not its generator seed. The fake docker here records exactly what the
 * runner hands `docker run` — container-side mount targets, environment,
 * container name — and everything in the mounted case directory.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KierstonBenchTask } from "../../task_generators/src/task.ts";
import { GENERATORS } from "../../task_generators/src/index.ts";
import { LEAK } from "../../model_visible_text.ts";
import { runTask, type RunOptions } from "../src/runner.ts";

let root: string;
let docker: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "container-surface-"));
  docker = join(root, "docker");
  // Writes what a container would see to $SURFACE_OUT, then writes an answer.
  await writeFile(docker, `#!${process.execPath}
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(0);
const mounts = [], env = {};
let name = "";
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "-v") { const [host, target] = args[++i].split(":"); mounts.push({ host, target }); }
  else if (args[i] === "-e") { const s = args[++i]; env[s.slice(0, s.indexOf("="))] = s.slice(s.indexOf("=") + 1); }
  else if (args[i] === "--name") name = args[++i];
}
const files = {};
const walk = (dir, prefix) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) walk(path, prefix + entry + "/"); else files[prefix + entry] = readFileSync(path, "utf8"); } };
for (const mount of mounts) walk(mount.host, mount.target + "/");
writeFileSync(process.env.SURFACE_OUT, JSON.stringify({ mounts: mounts.map((m) => m.target), hosts: mounts.map((m) => m.host), env, name, files }));
writeFileSync(join(mounts.find((m) => m.target === "/out").host, "answer.json"), JSON.stringify({ answer: ["x"] }));
`);
  await chmod(docker, 0o755);
});
afterAll(() => rm(root, { recursive: true, force: true }));

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    seriesFile: join(root, "series.json"),
    image: "kierston-eval-env",
    outDir: join(root, "runs"),
    runId: "kierston-eval-env-20260901T000000Z",
    concurrency: 1,
    timeoutMs: 0,
    kdiServiceUrl: "http://host.docker.internal:8765",
    kdiLogDir: join(root, "kdi_log"),
    kdiPolicyDir: join(root, "kdi_policy"),
    resume: false,
    dockerArgs: [],
    command: [],
    docker,
    log: () => {},
    ...overrides,
  };
}

function task(family: string, seed: number): KierstonBenchTask {
  return {
    id: `${family}:2026-09-05:${seed}`,
    family,
    date: "2026-09-05",
    seed,
    prompt: "Who made the call?",
    evidence: { line: "610-555-0100" },
    answer: { kind: "ranked-ids", identifier: "ssn", description: "SSNs (taxpayer_id strings)" },
    groundTruth: { person: 7 },
    scoring: { method: "rank", aggregate: "mrr" },
    kdiPolicy: { cutoff: "2026-09-05T12:00:00-04:00" },
  };
}

const FAMILIES = GENERATORS.map((generator) => generator.family);

for (const family of ["swatting", "colocation", "disappearance"]) {
  test(`${family}: no family name, task id or seed reaches the container`, async () => {
    const subject = task(family, 4282107066);
    const out = join(root, `${family}.json`);
    process.env.SURFACE_OUT = out;
    const dir = join(root, "runs", family);
    await mkdir(dir, { recursive: true });
    const meta = await runTask(subject, dir, options({ env: { ANTHROPIC_API_KEY: "sk-test" }, deadlineMs: 60_000 }));
    delete process.env.SURFACE_OUT;
    const seen = JSON.parse(await readFile(out, "utf8")) as { mounts: string[]; hosts: string[]; env: Record<string, string>; name: string; files: Record<string, string> };

    // Mount sources show inside the container (`mount`, /proc/mounts); they sit
    // under a per-attempt directory named by the case id, not the task directory.
    for (const host of seen.hosts) {
      expect(host).toContain(join(root, "runs", ".live", meta.caseId!));
      expect(host).not.toContain(family);
      expect(host).not.toContain(String(subject.seed));
    }
    // After the container exits the attempt is moved into the task directory.
    expect(await readFile(join(dir, "answer.json"), "utf8")).toContain("answer");
    expect(await readFile(join(root, "runs", ".live", meta.caseId!, "input", "input.json"), "utf8").catch(() => null)).toBeNull();

    // Everything the container can read, apart from the host-side paths behind its mounts.
    const surface = JSON.stringify({ mounts: seen.mounts, env: seen.env, name: seen.name, files: seen.files });
    expect(surface).not.toContain(subject.id);
    expect(surface).not.toContain(String(subject.seed));
    for (const name of FAMILIES) expect(surface).not.toContain(name);
    // The container name carries the run id (host tooling finds a run's containers by it),
    // and docker does not show it inside: the hostname is the container id. So only
    // what the container reads directly is held to the word ban.
    expect(JSON.stringify({ mounts: seen.mounts, env: seen.env, files: seen.files }).toLowerCase()).not.toContain("kierston");
    expect(Object.keys(seen.files).some((file) => file.startsWith("/input/"))).toBe(true);
    for (const [file, text] of Object.entries(seen.files)) {
      if (file.startsWith("/input/")) expect(text).not.toMatch(LEAK);
    }
    // Only these directories are mounted; the KDI log and policy directories never are.
    expect(seen.mounts.sort()).toEqual(["/home/agent/.claude/agent/sessions", "/input", "/out", "/work", "/work/.pi/agent/sessions"]);
    expect(Object.keys(seen.env).filter((key) => /CLICKHOUSE|POSTGRES|KDI_/.test(key))).toEqual([]);

    // Host-side, the run still maps the answer back to the task.
    expect(meta.id).toBe(subject.id);
    expect(meta.caseId).toMatch(/^case-[0-9a-f]{12}$/);
    expect(seen.name).toContain(meta.caseId!);
    expect(meta.status).toBe("answered");
    const bundle = JSON.parse(await readFile(join(dir, "input.json"), "utf8"));
    expect(bundle.id).toBe(meta.caseId);
  });
}

test("an agent directory is copied per task, auth files only, and the copy is gone afterwards", async () => {
  const agent = join(root, "agent-src");
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", expires: Date.now() + 60_000 } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultModel: "x" }));
  const out = join(root, "agent.json");
  process.env.SURFACE_OUT = out;
  const dir = join(root, "runs", "agent");
  await runTask(task("colocation", 1), dir, options({ agentDir: agent }));
  delete process.env.SURFACE_OUT;
  const seen = JSON.parse(await readFile(out, "utf8")) as { mounts: string[]; env: Record<string, string>; files: Record<string, string> };
  expect(seen.mounts).toContain("/opt/pi-agent");
  expect(seen.env.PI_CODING_AGENT_DIR).toBe("/opt/pi-agent");
  expect(Object.keys(seen.files)).toContain("/opt/pi-agent/auth.json");
  expect(Object.keys(seen.files)).not.toContain("/opt/pi-agent/settings.json");
  expect(await readFile(join(dir, "agent", "auth.json"), "utf8").catch(() => null)).toBeNull();
  expect(await readFile(join(agent, "auth.json"), "utf8")).toContain("oauth");
});

test("database credentials are refused as container environment", async () => {
  const meta = await runTask(task("colocation", 2), join(root, "runs", "db"), options({ env: { CLICKHOUSE_PASSWORD: "x" } }));
  expect(meta.status).toBe("error");
});

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

async function bench(...args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, "run", CLI, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, BENCH_AGENT_DIR: "" } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out + err };
}

test("an unknown subcommand prints usage and fails instead of opening the TUI", async () => {
  const result = await bench("dispach", "s3");
  expect(result.code).toBe(1);
  expect(result.out).toContain('unknown command "dispach"');
  expect(result.out).toContain("bench dispatch <series>");
});

test("numeric flags that are not numbers are errors, not silent defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-args-"));
  const series = join(dir, "series.json");
  await writeFile(series, JSON.stringify({ series: { id: "unit" }, tasks: [] }));
  for (const [flag, value] of [["--deadline", "abc"], ["--concurrency", "abc"], ["--concurrency", "0"], ["--deadline-grace", "-1"]]) {
    const result = await bench("dispatch", series, flag!, value!, "--dry-run");
    expect(result.code).toBe(1);
    expect(result.out).toContain(flag!);
  }
  const ok = await bench("dispatch", series, "--deadline", "1.5", "--concurrency", "3", "--dry-run");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("--concurrency 3");
  expect(ok.out).toContain("--deadline 1.5m");
  expect(ok.out).toContain("--agent-dir none");
});

test("a foreground dispatch whose preflight fails exits non-zero and starts nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-args-"));
  const series = join(dir, "series.json");
  await writeFile(series, JSON.stringify({ series: { id: "unit" }, tasks: [] }));
  const child = Bun.spawn([process.execPath, "run", CLI, "dispatch", series, "--out", dir, "--kdi-service-url", "http://192.0.2.1:9"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, BENCH_DOCKER: "/nonexistent/docker" },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(out + err).toContain("preflight: docker");
  expect(out + err).not.toContain("dispatching");
}, 20_000);

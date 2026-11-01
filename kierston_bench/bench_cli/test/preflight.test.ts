import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCredentials, databaseLogins, ensureKdiService, probeKdiService, kdiServiceProbeUrl } from "../src/preflight.ts";

test("the container's default KDI service URL maps to its host probe endpoint", () => {
  expect(kdiServiceProbeUrl("http://host.docker.internal:8765")).toBe("http://127.0.0.1:8765");
});

test("custom KDI service hosts and paths are preserved", () => {
  expect(kdiServiceProbeUrl("https://kdi.example.test:9443/api")).toBe("https://kdi.example.test:9443/api");
  expect(kdiServiceProbeUrl("not a URL")).toBe("not a URL");
});

test("kickstart reuses a KDI service that is already listening", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ code: 0, out: "{}\n", err: "" }) });
  try {
    const result = await ensureKdiService(`http://127.0.0.1:${server.port}`);
    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.detail).not.toContain("started automatically");
  } finally {
    server.stop(true);
  }
});

test("a health probe can use a longer cold-start timeout", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return new Response("listening", { status: 405 });
      await Bun.sleep(30);
      return Response.json({ code: 0, out: "{}\n", err: "" });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    expect((await probeKdiService(url, 1)).ok).toBe(false);
    expect((await probeKdiService(url, 100)).ok).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a health probe understands the KDI service's streaming response", async () => {
  const frames = [
    { stream: "out", data: Buffer.from('{"status":"online"}\n').toString("base64") },
    { stream: "end", code: 0 },
  ];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method === "GET") return new Response("listening", { status: 405 });
      return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n", {
        headers: { "content-type": "application/x-adi-stream+jsonl" },
      });
    },
  });
  try {
    const result = await probeKdiService(`http://127.0.0.1:${server.port}`);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("KDI healthy");
  } finally {
    server.stop(true);
  }
});

test("expired agent credentials are caught before a run burns a container per task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbench-agent-"));
  const yesterday = Date.now() - 86_400_000;
  await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", expires: yesterday } }));
  const stale = await agentCredentials(dir, []);
  expect(stale.ok).toBe(false);
  expect(stale.detail).toContain("expired");

  // A forwarded key is authentication enough, whatever the mount holds.
  process.env.KBENCH_TEST_KEY = "x";
  expect((await agentCredentials(dir, ["ANTHROPIC_API_KEY=sk-test"])).ok).toBe(true);
  delete process.env.KBENCH_TEST_KEY;

  await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { expires: Date.now() + 86_400_000 } }));
  expect((await agentCredentials(dir, [])).ok).toBe(true);
});

test("a name with no value on the host forwards nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbench-agent-"));
  await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { expires: 1 } }));
  delete process.env.ANTHROPIC_API_KEY;
  expect((await agentCredentials(dir, ["ANTHROPIC_API_KEY"])).ok).toBe(false);
});

test("with no agent directory, a forwarded key of any provider pi knows is credentials enough", async () => {
  for (const variable of ["OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY"]) {
    expect((await agentCredentials(undefined, [`${variable}=k`])).ok).toBe(true);
  }
  expect((await agentCredentials("none", [])).ok).toBe(false);
});

test("an explicit --env for a provider the table does not know is taken as credentials, not refused", async () => {
  const check = await agentCredentials(undefined, ["MY_LLM_API_KEY=k"]);
  expect(check.ok).toBe(true);
  expect(check.detail).toContain("MY_LLM_API_KEY");
  // Run settings are not credentials.
  expect((await agentCredentials(undefined, ["BENCH_DOCKER=/bin/true"])).ok).toBe(false);
});

test("databases without passwords block a run unless explicitly allowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbench-env-"));
  const file = join(dir, ".env.local");
  const saved = { ch: process.env.CLICKHOUSE_PASSWORD, pg: process.env.POSTGRES_URL };
  delete process.env.CLICKHOUSE_PASSWORD;
  delete process.env.POSTGRES_URL;
  try {
    await writeFile(file, "CLICKHOUSE_PASSWORD=\nPOSTGRES_URL=postgres://postgres@127.0.0.1:5432/city_data\n");
    const open = await databaseLogins(file, false);
    expect(open.ok).toBe(false);
    expect(open.detail).toContain("CLICKHOUSE_PASSWORD is empty");
    expect(open.detail).toContain("POSTGRES_URL carries no password");
    const allowed = await databaseLogins(file, true);
    expect(allowed.ok).toBe(true);
    expect(allowed.advisory).toBe(true);
    await writeFile(file, "CLICKHOUSE_PASSWORD='s3cret'\nPOSTGRES_URL=postgres://postgres:s3cret@127.0.0.1:5432/city_data\n");
    expect((await databaseLogins(file, false)).ok).toBe(true);
  } finally {
    if (saved.ch !== undefined) process.env.CLICKHOUSE_PASSWORD = saved.ch;
    if (saved.pg !== undefined) process.env.POSTGRES_URL = saved.pg;
  }
});

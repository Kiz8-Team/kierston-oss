import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ADI } from "../../model_visible_text";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

// The agent reads stderr through the KDI service; the operator reads the cause file.
test("a failure prints the generic message and files its real cause host-side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kdi-cause-"));
  const causeFile = join(dir, "cause.txt");
  const child = Bun.spawn([process.execPath, "run", CLI, "days", "--format", "json"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CLICKHOUSE_URL: "http://127.0.0.1:1", KDI_CAUSE_FILE: causeFile },
  });
  const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(JSON.parse(err.trim()).error).toEqual({ code: "QUERY_FAILED", message: ADI.failed });
  const cause = await readFile(causeFile, "utf8");
  expect(cause).toStartWith("failed: ");
  expect(cause).not.toBe(`failed: ${ADI.failed}\n`);
  expect(err).not.toContain("127.0.0.1:1");
}, 20_000);

test("health reports a store offline to the caller and its cause only host-side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kdi-cause-"));
  const causeFile = join(dir, "cause.txt");
  const child = Bun.spawn([process.execPath, "run", CLI, "health", "--format", "json"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CLICKHOUSE_URL: "http://127.0.0.1:1", KDI_CAUSE_FILE: causeFile },
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(out).toContain('"offline"');
  expect(out + err).not.toContain("127.0.0.1:1");
  expect(await readFile(causeFile, "utf8")).toContain("health: event stores");
}, 20_000);

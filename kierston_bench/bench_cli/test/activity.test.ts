import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, SESSION_DIR } from "../src/activity.ts";

let root: string;

/**
 * One session transcript, as pi appends it: one JSON object per line. `--session-dir`
 * puts it flat in the log directory; older builds nested it a level or two down, so
 * both shapes are worth a test.
 */
async function session(name: string, records: unknown[], nested = false): Promise<string> {
  const dir = join(root, name);
  const into = nested ? join(dir, SESSION_DIR, "pi-sessions", "--work--") : join(dir, SESSION_DIR);
  await mkdir(into, { recursive: true });
  await writeFile(
    join(into, "2026-09-01T00-00-00-000Z_abc.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return dir;
}

const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const toolResult = { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kbench-activity-"));
});

test("the newest tool call and thinking heading are read from the transcript tail", async () => {
  const dir = await session("working", [
    { type: "session", version: 3 },
    assistant([{ type: "thinking", thinking: "**Reading the task**\n\nFirst I will look." }, { type: "toolCall", name: "read" }]),
    toolResult,
    assistant([{ type: "thinking", thinking: "**Identifying candidates**" }, { type: "toolCall", name: "bash" }]),
    toolResult,
  ]);
  expect(await readActivity(dir)).toEqual({ tool: "bash", header: "Identifying candidates" });
});

test("a heading is taken from an older message when the newest call has none", async () => {
  const dir = await session("carried", [
    assistant([{ type: "thinking", thinking: "**Checking towers**" }, { type: "toolCall", name: "bash" }]),
    toolResult,
    assistant([{ type: "toolCall", name: "write" }]),
  ]);
  expect(await readActivity(dir)).toEqual({ tool: "write", header: "Checking towers" });
});

test("a task with no transcript yet reports nothing rather than failing", async () => {
  expect(await readActivity(join(root, "absent"))).toEqual({});
  const empty = await session("empty", []);
  expect(await readActivity(empty)).toEqual({});
});

test("a transcript nested under the session mount is found too", async () => {
  const dir = await session("nested", [assistant([{ type: "thinking", thinking: "**Reading towers**" }, { type: "toolCall", name: "bash" }])], true);
  expect(await readActivity(dir)).toEqual({ tool: "bash", header: "Reading towers" });
});

test("redacted thinking falls back to what the agent last said", async () => {
  // Anthropic returns a signature with no readable thinking; every bench run so far is one.
  const dir = await session("redacted", [
    assistant([{ type: "text", text: "Now let's query the ALPR reads.\nThen rank them." }, { type: "toolCall", name: "bash" }]),
    toolResult,
    assistant([{ type: "thinking", thinking: "", thinkingSignature: "abc" }, { type: "toolCall", name: "read" }]),
  ]);
  expect(await readActivity(dir)).toEqual({ tool: "read", header: "Now let's query the ALPR reads." });
});

test("a task whose agent never took a turn reports nothing", async () => {
  const dir = await session("no-turn", [
    { type: "session", version: 3 },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "the task" }] } },
  ]);
  expect(await readActivity(dir)).toEqual({});
});

test("a half-written line is skipped, not thrown on", async () => {
  const dir = await session("torn", [assistant([{ type: "toolCall", name: "kdi" }])]);
  await writeFile(
    join(dir, SESSION_DIR, "2026-09-01T00-00-00-000Z_abc.jsonl"),
    JSON.stringify(assistant([{ type: "toolCall", name: "kdi" }])) + '\n{"type":"mess',
  );
  expect(await readActivity(dir)).toEqual({ tool: "kdi" });
});

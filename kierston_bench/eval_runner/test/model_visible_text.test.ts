import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ADI, CLIENT, LEAK, everyString } from "../../model_visible_text.ts";
import { MESSAGES_FILE, messagesJson } from "../../agent_eval_runtime/gen_messages.ts";

const BENCH = resolve(import.meta.dir, "../..");

test("nothing the model can read carries a banned word", () => {
  const strings = everyString();
  expect(strings.length).toBeGreaterThan(100);
  for (const text of strings) expect(text).not.toMatch(LEAK);
});

test("everyString reaches every message, whatever its arguments", () => {
  const strings = new Set(everyString());
  expect(strings.has(ADI.windowNeedsBothBounds)).toBe(true);
  expect(strings.has(CLIENT.unreachable)).toBe(true);
});

test("bin/messages.json is what gen_messages.ts would write", async () => {
  expect(await readFile(MESSAGES_FILE, "utf8")).toBe(messagesJson());
});

// The model can `cat` these: the clients on its PATH and the clock pi loads.
test("files carried into the container hold no banned word and no prose of their own", async () => {
  const bin = join(BENCH, "agent_eval_runtime/bin");
  const files = [...(await readdir(bin)).map((name) => join(bin, name)), join(BENCH, "agent_eval_runtime/pi-ext/clock.ts")];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(LEAK);
    expect(source).not.toMatch(/\btasks?\b|model|capabilit/i);
    // Anything a client writes to stderr comes from messages.json.
    if (!file.endsWith(".json") && !file.endsWith(".ts")) expect(source).not.toMatch(/stderr\.write\((?!MESSAGES\[|result\[)/);
  }
});

// A rejection written inline in the ADI command would bypass the review file.
test("the ADI command takes every rejection from model_visible_text.ts", async () => {
  for (const name of ["cli.ts", "execute.ts", "interface.ts"]) {
    const source = await readFile(join(BENCH, "kdi/src", name), "utf8");
    for (const line of source.split("\n")) {
      if (line.includes("new QueryRejected(") && !line.includes("constructor")) expect(line).toMatch(/new QueryRejected\("[A-Z_]+", ADI\./);
    }
  }
});

test("the gateway writes no response text of its own", async () => {
  const source = await readFile(join(BENCH, "agent_eval_runtime/kdi_service.ts"), "utf8");
  expect(source).not.toMatch(/badRequest\("/);
  expect(source).not.toMatch(/new Response\("/);
});

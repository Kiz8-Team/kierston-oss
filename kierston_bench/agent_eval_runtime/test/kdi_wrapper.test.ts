import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const wrapper = new URL("../bin/kdi", import.meta.url);

test("the KDI wrapper keeps the bounded request timeout and streaming support", async () => {
  const source = await readFile(wrapper, "utf8");
  expect(source).toContain("urlopen(request, timeout=60)");
  expect(source).toContain('application/x-adi-stream+jsonl');
});

import { expect, test } from "bun:test";
import { eachLine } from "../src/lines.ts";

test("lines split across chunks arrive whole, blank ones are skipped, and the text comes back intact", async () => {
  const chunks = ["Reading base", " day\n\n@progress {\"done\"", ":1}\nlast"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const seen: string[] = [];
  const text = await eachLine(stream, (line) => seen.push(line));
  expect(seen).toEqual(["Reading base day", '@progress {"done":1}', "last"]);
  expect(text).toBe(chunks.join(""));
});

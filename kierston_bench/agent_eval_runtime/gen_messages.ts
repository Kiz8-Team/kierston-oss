#!/usr/bin/env bun
// Writes bin/messages.json from CLIENT in ../model_visible_text.ts. The image
// carries that file; the container-side clients and the response clock read
// their text from it. Run after changing CLIENT; a test fails when it is stale.
import { join } from "node:path";
import { CLIENT } from "../model_visible_text.ts";

export const MESSAGES_FILE = join(import.meta.dir, "bin/messages.json");
export function messagesJson(): string {
  return JSON.stringify(CLIENT, null, 2) + "\n";
}

if (import.meta.main) {
  await Bun.write(MESSAGES_FILE, messagesJson());
  console.log(`wrote ${MESSAGES_FILE}`);
}

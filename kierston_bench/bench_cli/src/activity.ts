/**
 * What a running task is doing right now.
 *
 * A task writes nothing the inventory can read until its container exits and
 * `meta.json` appears, so an in-flight row would otherwise stay blank for the
 * whole run. The agent's session transcript is the exception: pi appends to it
 * a message at a time, and it is bind-mounted onto the host, so tailing it says
 * what the agent is doing while it is still doing it.
 *
 * Only two things are taken from it — the tool it called last, and the last
 * heading it gave its own thinking. That is enough to tell working from stuck
 * without turning the progress table into a transcript viewer.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the transcript is while the task runs: `--session-dir` points pi at
 * /out/logs, which is this directory on the host, and the runner moves it to
 * logs/ once the container exits. Older pi builds ignored the flag and wrote
 * to their own sessions mount at out/logs/pi-sessions/--work--/ instead, so
 * the search below is recursive and reads either.
 */
export const SESSION_DIR = join("out", "logs");

/** Enough of the tail to hold the last few messages, whatever their size. */
const TAIL_BYTES = 96 * 1024;

export interface Activity {
  /** The name of the most recent tool call, e.g. `bash`, `write`. */
  tool?: string;
  /**
   * The most recent heading the agent gave its own work: the first line of its
   * thinking where that is readable, and otherwise the last thing it said.
   */
  header?: string;
}

interface SessionLine {
  type?: string;
  message?: {
    role?: string;
    content?: { type?: string; name?: string; thinking?: string; text?: string }[];
  };
}

/** The newest .jsonl anywhere under a directory; pi nests one per working directory. */
async function newestSession(dir: string): Promise<string | null> {
  let best: { path: string; at: number } | null = null;
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".jsonl")) {
        const at = await stat(child).then((info) => info.mtimeMs, () => 0);
        if (best === null || at > best.at) best = { path: child, at };
      }
    }
  };
  await walk(dir);
  return best === null ? null : (best as { path: string }).path;
}

/**
 * The first line of a block, as a heading. pi's thinking starts with a bold
 * title — `**Planning the answer**` — and an assistant's prose starts with a
 * sentence; either reads as a heading once the markup is off.
 */
function heading(text: string): string | undefined {
  const first = text.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return undefined;
  const clean = first.replace(/\*\*/g, "").replace(/^#+\s*/, "").trim();
  return clean === "" ? undefined : clean;
}

/**
 * Where the out mount lives while the task runs. Runners since 2026-10-06
 * mount a per-attempt directory named by the case id and record it as `live`
 * in active.json; older runners mounted the task directory itself.
 */
async function sessionRoot(taskDir: string): Promise<string> {
  try {
    const live = (JSON.parse(await readFile(join(taskDir, "active.json"), "utf8")) as { live?: unknown }).live;
    return typeof live === "string" ? live : taskDir;
  } catch {
    return taskDir;
  }
}

/** Reads the tail of a task's session transcript. Absent or unreadable means no activity yet. */
export async function readActivity(taskDir: string): Promise<Activity> {
  const path = await newestSession(join(await sessionRoot(taskDir), SESSION_DIR));
  if (path === null) return {};
  const file = Bun.file(path);
  const size = await file.size;
  const text = await file.slice(Math.max(0, size - TAIL_BYTES)).text().catch(() => "");
  const lines = text.split("\n");
  // The first line of a mid-file tail is half a record; the last is unflushed.
  if (size > TAIL_BYTES) lines.shift();

  const activity: Activity = {};
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    let parsed: SessionLine;
    try {
      parsed = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    if (parsed.type !== "message" || parsed.message?.role !== "assistant") continue;
    for (const part of parsed.message.content ?? []) {
      if (activity.tool === undefined && part.type === "toolCall" && part.name) activity.tool = part.name;
      if (activity.header !== undefined) continue;
      // Anthropic redacts thinking to a signature, leaving `thinking` empty;
      // there the agent's own prose is the only heading it ever writes.
      if (part.type === "thinking" && part.thinking) activity.header = heading(part.thinking);
      else if (part.type === "text" && part.text) activity.header = heading(part.text);
    }
    if (activity.tool !== undefined && activity.header !== undefined) break;
  }
  return activity;
}

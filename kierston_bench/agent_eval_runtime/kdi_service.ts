#!/usr/bin/env bun
// KDI service: the only door from the evaluation container to host data.
//
// Listens on loopback, accepts {"args": [...]} and runs the KDI CLI with those
// arguments as an argv array. No shell is involved, so the agent cannot smuggle
// anything past the CLI's own parser; KDI itself never accepts SQL or paths.
// Credentials stay in the host's .env.local and never enter the container.
//
// A request carries an opaque capability (AT in the container); the host maps it to
// the task id, and calls are filed under kdi_log/<task id>.jsonl, one line per call.
// A failure's full cause goes to this process's stderr and the line's `error`
// field; the container only ever gets the model-facing message.
//
//   bun run kdi_service.ts [--host <address>] [--port <port>]
//
// The bind address defaults to KDI_SERVICE_HOST, else 127.0.0.1, which Docker
// Desktop reaches as host.docker.internal. On native Linux Docker the
// host-gateway is the docker0 bridge (`ip -4 addr show docker0`, often
// 172.17.0.1), which a loopback listener never sees: bind that address there.

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { searchPlaces, validatePlaceSearch } from "./place_search.ts";

import { lookupAddress, validateAddressQuery, type AddressQuery } from "./address_lookup.ts";
// Every response body a container can receive is text the model reads; it lives in GATEWAY.
import { GATEWAY } from "../model_visible_text.ts";

const BENCH_ROOT = resolve(import.meta.dir, "..");
const { values: flags } = parseArgs({ args: process.argv.slice(2), options: { host: { type: "string" }, port: { type: "string" } } });
const PORT = Number(flags.port ?? process.env.KDI_SERVICE_PORT ?? 8765);
const HOST = flags.host ?? (process.env.KDI_SERVICE_HOST?.trim() || "127.0.0.1");
const MAX_ARGS = 512;
const MAX_ARG_LENGTH = 4096;
const MAX_TASK_ID_LENGTH = 512;
const LOG_DIR = resolve(process.env.KDI_SERVICE_LOG_DIR ?? join(import.meta.dir, "kdi_log"));
const POLICY_DIR = resolve(process.env.KDI_SERVICE_POLICY_DIR ?? join(import.meta.dir, "kdi_policy"));
// Full failure causes from KDI, one file per call, read back and deleted after
// the call. Host-only like the rest of LOG_DIR: nothing here is mounted into a
// container, and the runner copies a task's log out only after its container exits.
const CAUSE_DIR = join(LOG_DIR, ".causes");
await mkdir(LOG_DIR, { recursive: true });
await mkdir(CAUSE_DIR, { recursive: true, mode: 0o700 });
await mkdir(POLICY_DIR, { recursive: true });

/** File name for a task id; the runner derives the same name to find it. */
function logFile(taskId: string): string {
  return join(LOG_DIR, taskId.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl");
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

/** First-call time per capability, so concurrent first calls agree on one start. */
const opened = new Map<string, number>();

/**
 * When the records clock started for a capability: the `openedAt` the file
 * already holds, else now, written back so the runner and a restarted service
 * see the same start. The first call arrives after the agent's own clock
 * started in the container, so the gateway never closes before the agent is
 * told to stop.
 */
async function openedAtFor(capability: string, file: string, registered: Record<string, unknown>): Promise<number> {
  if (typeof registered.openedAt === "number") return registered.openedAt;
  const known = opened.get(capability);
  if (known !== undefined) return known;
  const now = Date.now();
  opened.set(capability, now);
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ ...registered, openedAt: now }) + "\n", { mode: 0o600 });
  await rename(temp, file);
  return now;
}

async function logCall(taskId: string | undefined, args: string[], code: number, started: number, out: string, err = "", attempt?: string) {
  const ms = Date.now() - started;
  const stamp = new Date().toISOString();
  const display = args[0] === "places" ? ["km_search_places", ...args.slice(1)] : args[0] === "address" ? ["km_address_lookup", ...args.slice(1)] : ["kdi", ...args];
  console.log(`${stamp} ${taskId ? `[${taskId}] ` : ""}${display.join(" ")} -> ${code} (${ms} ms)`);
  const error = err.trim() || undefined;
  if (error && code !== 0) console.error(`${stamp} ${taskId ? `[${taskId}] ` : ""}${display[0]} failed: ${error}`);
  if (taskId) {
    const line = JSON.stringify({ at: stamp, taskId, ...(attempt ? { attempt } : {}), args, code, ms, outBytes: Buffer.byteLength(out), err: error, ...(error && code !== 0 ? { error } : {}) });
    await appendFile(logFile(taskId), line + "\n");
  }
}

async function logStreamCall(taskId: string | undefined, args: string[], code: number, started: number, outBytes: number, error?: string, attempt?: string) {
  const ms = Date.now() - started;
  const stamp = new Date().toISOString();
  console.log(`${stamp} ${taskId ? `[${taskId}] ` : ""}kdi ${args.join(" ")} -> ${code} (${ms} ms, ${outBytes} bytes)`);
  if (error) console.error(`${stamp} ${taskId ? `[${taskId}] ` : ""}kdi ${args[0] ?? ""} failed: ${error}`);
  if (taskId) {
    await appendFile(logFile(taskId), JSON.stringify({ at: stamp, taskId, ...(attempt ? { attempt } : {}), args, code, ms, outBytes, ...(error ? { error } : {}) }) + "\n");
  }
}

/** What KDI wrote to its cause file for one call, then the file is gone. */
async function takeCause(file: string): Promise<string | undefined> {
  const text = await readFile(file, "utf8").catch(() => "");
  await rm(file, { force: true });
  return text.trim() || undefined;
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    if (request.method !== "POST") return new Response(GATEWAY.method, { status: 405 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return badRequest(GATEWAY.notJson);
    }
    const { args, token: taskCapability } = (payload ?? {}) as { args?: unknown; token?: unknown };
    // The container never learns its task id. The runner hands it an opaque
    // capability (AT) and the host resolves that to the task here.
    // The host's read-only preflight probe is the sole unscoped operation.
    // Every data-bearing or catalog request must belong to a registered task.
    const unscopedHealth = new URL(request.url).pathname === "/" && taskCapability === undefined
      && Array.isArray(args) && args.length === 1 && args[0] === "health";
    if (taskCapability === undefined && !unscopedHealth) return badRequest(GATEWAY.capabilityRequired);
    let taskPolicy: string | undefined;
    let taskId: string | undefined;
    let closesAt: number | undefined;
    let attempt: string | undefined;
    if (!unscopedHealth) {
      if (typeof taskCapability !== "string" || !/^[a-f0-9-]{36}$/.test(taskCapability)) return badRequest(GATEWAY.capabilityInvalid);
      try {
        const file = join(POLICY_DIR, `${taskCapability}.json`);
        const registered = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        if (typeof registered.taskId !== "string" || registered.taskId.length > MAX_TASK_ID_LENGTH) return badRequest(GATEWAY.capabilityUnknown);
        taskId = registered.taskId;
        taskPolicy = JSON.stringify(registered.policy ?? {});
        // A task's log file is shared by its attempts; every line carries the
        // attempt so the runner keeps only its own.
        attempt = typeof registered.attempt === "string" ? registered.attempt : undefined;
        // An explicit closesAt (older runners) wins; otherwise the allowance
        // runs from the first call this capability makes.
        if (typeof registered.closesAt === "number") closesAt = registered.closesAt;
        else if (typeof registered.deadlineMs === "number") {
          const lag = typeof registered.closeLagMs === "number" ? registered.closeLagMs : 0;
          closesAt = (await openedAtFor(taskCapability, file, registered)) + registered.deadlineMs + lag;
        }
      } catch { return badRequest(GATEWAY.capabilityUnknown); }
      if (closesAt !== undefined && Date.now() >= closesAt) {
        const path = new URL(request.url).pathname;
        const refused = path === "/places" ? ["places"] : path === "/address" ? ["address"] : Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string").slice(0, MAX_ARGS) : [];
        await logCall(taskId, refused, 403, Date.now(), "", "closed", attempt);
        return new Response(GATEWAY.closed, { status: 403 });
      }
    }

    if (new URL(request.url).pathname === "/address") {
      const invalid = validateAddressQuery(payload);
      if (invalid) return badRequest(invalid);
      const q = payload as AddressQuery;
      const callArgs = ["address", ...("address" in q ? [q.address] : [String(q.latitude), String(q.longitude), String(q.radiusMetres)])];
      const started = Date.now();
      try {
        const out = JSON.stringify(await lookupAddress(q)) + "\n";
        await logCall(taskId, callArgs, 0, started, out, "", attempt);
        return Response.json({ code: 0, out, err: "" });
      } catch (error) {
        // The cause stays in the host's log; it can name host paths.
        await logCall(taskId, callArgs, 1, started, "", `${error instanceof Error ? error.message : String(error)}\n`, attempt);
        return Response.json({ code: 1, out: "", err: GATEWAY.failed });
      }
    }

    if (new URL(request.url).pathname === "/places") {
      const { latitude, longitude, radiusMetres } = (payload ?? {}) as Record<string, unknown>;
      if (typeof latitude !== "number" || typeof longitude !== "number" || typeof radiusMetres !== "number") {
        return badRequest(GATEWAY.places.numbers);
      }
      const invalid = validatePlaceSearch(latitude, longitude, radiusMetres);
      if (invalid) return badRequest(invalid);
      const started = Date.now();
      try {
        const result = await searchPlaces(latitude, longitude, radiusMetres);
        const out = JSON.stringify(result) + "\n";
        await logCall(taskId, ["places", String(latitude), String(longitude), String(radiusMetres)], 0, started, out, "", attempt);
        return Response.json({ code: 0, out, err: "" });
      } catch (error) {
        await logCall(taskId, ["places", String(latitude), String(longitude), String(radiusMetres)], 1, started, "", `${error instanceof Error ? error.message : String(error)}\n`, attempt);
        return Response.json({ code: 1, out: "", err: GATEWAY.failed });
      }
    }

    if (!Array.isArray(args) || args.length > MAX_ARGS) return badRequest(GATEWAY.argsNotArray);
    for (const arg of args) {
      if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH) return badRequest(GATEWAY.argsNotStrings);
    }
    const started = Date.now();
    const causeFile = join(CAUSE_DIR, `${randomUUID()}.txt`);
    const child = Bun.spawn(["bun", "run", "kdi/src/cli.ts", ...args], {
      cwd: BENCH_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", KDI_CAUSE_FILE: causeFile, ...(taskPolicy ? { KDI_TASK_POLICY: taskPolicy } : {}) },
    });
    let outBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const frame = (stream: "out" | "err", chunk: Uint8Array) => {
          if (stream === "out") outBytes += chunk.byteLength;
          controller.enqueue(encoder.encode(JSON.stringify({ stream, data: Buffer.from(chunk).toString("base64") }) + "\n"));
        };
        const pump = async (stream: "out" | "err", readable: ReadableStream<Uint8Array>) => {
          const reader = readable.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            frame(stream, value);
          }
        };
        void (async () => {
          const [code] = await Promise.all([child.exited, pump("out", child.stdout), pump("err", child.stderr)]);
          await logStreamCall(taskId, args, code, started, outBytes, await takeCause(causeFile), attempt);
          controller.enqueue(encoder.encode(JSON.stringify({ stream: "end", code }) + "\n"));
          controller.close();
        })().catch(async (error) => {
          const cause = await takeCause(causeFile);
          await logStreamCall(taskId, args, 1, started, outBytes, [cause, `gateway: ${error instanceof Error ? error.stack ?? error.message : String(error)}`].filter(Boolean).join("\n"), attempt);
          try {
            controller.enqueue(encoder.encode(JSON.stringify({ stream: "err", data: Buffer.from(GATEWAY.failed).toString("base64") }) + "\n"));
            controller.enqueue(encoder.encode(JSON.stringify({ stream: "end", code: 1 }) + "\n"));
            controller.close();
          } catch { /* the client may already have closed the stream */ }
        });
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-adi-stream+jsonl" } });
  },
});

console.log(`KDI service listening on http://${server.hostname}:${server.port}, running kdi from ${BENCH_ROOT}, task logs in ${LOG_DIR}`);

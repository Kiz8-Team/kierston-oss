/**
 * Every registered family against the built city: each generator must turn
 * one of a handful of seeds into a well-formed task. Plain families read the
 * newest base day in kierston/sim_outputs; scenario families read a staged
 * `.kdiff` already on disk over the base it was written against. Nothing is
 * staged or exported here, and a family whose day is missing is skipped by
 * name rather than failed.
 *
 * Every task produced is also checked against LEAK from model_visible_text.ts:
 * the prompt, the evidence and the answer spec reach the model, so none may
 * carry a banned word.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { constants as zlibConstants, gunzipSync } from "node:zlib";
import { Glob } from "bun";
import { GENERATORS, openContext, Rng, TASK_GROUPS, type TaskContext, type TaskGenerator } from "../src/index.ts";
import { KdayReader } from "../src/kday.ts";
import { fileDigest, readKdif } from "../src/kdif.ts";
import type { AnswerKind, KierstonBenchTask } from "../src/task.ts";
import { LEAK } from "../../model_visible_text.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SIM_DATA = join(REPO_ROOT, "kierston/sim_data");
const SIM_OUTPUTS = join(REPO_ROOT, "kierston/sim_outputs");
const SERIES_DIR = join(REPO_ROOT, "kierston_bench/run_series");
const ATTEMPTS = 5;
const TEST_TIMEOUT_MS = 60_000;

const ANSWER_KINDS: readonly AnswerKind[] = [
  "integer", "text", "time", "interval", "id", "ranked-ids", "id-set", "label", "label-set", "point", "record",
];
const SCORING_METHODS = ["top1", "rank", "recall-at-k", "set-f1", "distance", "interval-iou", "hierarchical", "record"];

const cityBuilt = existsSync(join(SIM_DATA, "population.json"));

interface DayHeader { file: string; date: string; version: number }

async function dayHeader(file: string): Promise<DayHeader | undefined> {
  try {
    const reader = await KdayReader.open(file);
    const header = { file, date: reader.meta.date, version: reader.meta.version };
    await reader.close();
    return header;
  } catch {
    return undefined;
  }
}

/** Every KDAY under sim_outputs (top level and engine-version subdirectories), newest date first. */
async function allDays(): Promise<DayHeader[]> {
  if (!existsSync(SIM_OUTPUTS)) return [];
  const files = [...new Glob("**/day_*.bin").scanSync(SIM_OUTPUTS)].map((path) => join(SIM_OUTPUTS, path));
  const headers = (await Promise.all(files.map(dayHeader))).filter((header): header is DayHeader => header !== undefined);
  return headers.sort((a, b) => b.date.localeCompare(a.date)
    || Number(dirOf(a.file) !== SIM_OUTPUTS) - Number(dirOf(b.file) !== SIM_OUTPUTS)
    || statSync(b.file).mtimeMs - statSync(a.file).mtimeMs);
}

function dirOf(path: string): string {
  return resolve(path, "..");
}

/** Staged deltas on disk: sim_outputs/*.kdiff, sim_outputs/scenarios/**, and whatever a series names. */
function candidateDeltas(): string[] {
  const found = new Set<string>();
  if (existsSync(SIM_OUTPUTS)) {
    for (const path of new Glob("*.kdiff").scanSync(SIM_OUTPUTS)) found.add(join(SIM_OUTPUTS, path));
    const scenarios = join(SIM_OUTPUTS, "scenarios");
    if (existsSync(scenarios)) for (const path of new Glob("**/*.kdiff").scanSync(scenarios)) found.add(join(scenarios, path));
  }
  if (existsSync(SERIES_DIR)) {
    for (const name of readdirSync(SERIES_DIR).filter((file) => file.endsWith(".json"))) {
      const text = readFileSync(join(SERIES_DIR, name), "utf8");
      for (const match of text.matchAll(/"delta":\s*"([^"]+\.kdiff)"/g)) {
        const path = resolve(REPO_ROOT, match[1]!);
        if (existsSync(path)) found.add(path);
      }
    }
  }
  return [...found].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * What a delta binds to — base hash, date, schema version — read from the
 * start of its gzipped manifest, which opens with those keys; the full
 * manifest (megabytes of patches) is read only when the head does not parse.
 */
async function deltaBinding(delta: string): Promise<{ baseHash: string; date: string; baseVersion?: number } | undefined> {
  try {
    const handle = openSync(delta, "r");
    const head = Buffer.alloc(16 * 1024);
    let length: number;
    try {
      length = readSync(handle, head, 0, head.length, 0);
    } finally {
      closeSync(handle);
    }
    if (length > 8 && head.toString("ascii", 0, 4) === "KDIF") {
      const text = gunzipSync(head.subarray(8, length), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8", 0, 4096);
      const baseHash = /"baseHash":"([a-f0-9]{64})"/.exec(text)?.[1];
      const date = /"date":"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
      const version = /"baseVersion":(\d+)/.exec(text)?.[1];
      if (baseHash && date && text.indexOf('"baseVersion"') < text.indexOf('"metadata"')) {
        return { baseHash, date, ...(version ? { baseVersion: Number(version) } : {}) };
      }
    }
  } catch {
    // Fall through to the full read.
  }
  try {
    return await readKdif(delta);
  } catch {
    return undefined;
  }
}

/** Each delta paired with the base it binds to, matched by date, schema version and whole-file hash. */
async function pairDeltas(days: DayHeader[]): Promise<{ delta: string; base: string }[]> {
  const pairs: { delta: string; base: string }[] = [];
  for (const delta of candidateDeltas()) {
    const manifest = await deltaBinding(delta);
    if (!manifest) continue;
    const version = manifest.baseVersion ?? 11;
    for (const day of days) {
      if (day.date !== manifest.date || day.version !== version) continue;
      if ((await fileDigest(day.file)) !== manifest.baseHash) continue;
      pairs.push({ delta, base: day.file });
      break;
    }
  }
  return pairs;
}

const days = cityBuilt ? await allDays() : [];
const plainDay = days[0];
const stagedKinds = [...new Set(GENERATORS.map((generator) => generator.eventKind).filter((kind): kind is string => kind !== undefined))];
const needsScenarios = cityBuilt && stagedKinds.length > 0;
const deltaPairs = needsScenarios ? await pairDeltas(days) : [];

/** One open context per day file / delta, shared by every family that reads it. */
const contexts = new Map<string, Promise<TaskContext>>();

function contextFor(dayFile: string, deltaFile?: string): Promise<TaskContext> {
  const key = `${dayFile}|${deltaFile ?? ""}`;
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = openContext({ dayFile, simDataDir: SIM_DATA, ...(deltaFile ? { deltaFile } : {}) });
    contexts.set(key, ctx);
  }
  return ctx;
}

/** Every paired delta whose staged header records exactly one event of the kind, newest first. */
const scenariosByKind = new Map<string, { delta: string; base: string }[]>();
for (const pair of deltaPairs) {
  let events: string[];
  try {
    // Opened here and kept: the family tests read the same context.
    const ctx = await contextFor(pair.base, pair.delta);
    events = ctx.day.meta.scenario?.events.map((event) => event.kind) ?? [];
  } catch {
    continue;
  }
  for (const kind of stagedKinds) {
    if (events.filter((event) => event === kind).length !== 1) continue;
    const list = scenariosByKind.get(kind) ?? [];
    list.push(pair);
    scenariosByKind.set(kind, list);
  }
}

afterAll(async () => {
  for (const ctx of contexts.values()) {
    try {
      await (await ctx).day.close();
    } catch {
      // A context that failed to open has nothing to close.
    }
  }
});

function fnv1a(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function checkShape(task: KierstonBenchTask, generator: TaskGenerator, ctx: TaskContext): void {
  expect(typeof task.id).toBe("string");
  expect(task.id.length).toBeGreaterThan(0);
  expect(task.family).toBe(generator.family);
  expect(task.date).toBe(ctx.date);
  expect(typeof task.prompt).toBe("string");
  expect(task.prompt.length).toBeGreaterThan(0);
  expect(task.evidence).toBeDefined();
  expect(typeof task.evidence).toBe("object");
  expect(task.answer).toBeDefined();
  expect(ANSWER_KINDS).toContain(task.answer.kind);
  if (task.answer.kind === "record") {
    expect(task.answer.fields).toBeDefined();
    expect(Object.keys(task.answer.fields!).length).toBeGreaterThan(0);
    for (const field of Object.values(task.answer.fields!)) expect(ANSWER_KINDS).toContain(field.kind);
  }
  if (task.answer.kind === "label" || task.answer.kind === "label-set") {
    expect(task.answer.labels?.length ?? 0).toBeGreaterThan(0);
  }
  expect(task.scoring).toBeDefined();
  expect(SCORING_METHODS).toContain(task.scoring.method);
  expect(typeof task.scoring.aggregate).toBe("string");
  expect("groundTruth" in task).toBe(true);
  expect(nonEmpty(task.groundTruth)).toBe(true);
}

/** Evidence keys whose values are record data (names, numbers, merchants), not wording. */
const DATA_KEYS = new Set(["name", "dob", "phone", "ssn", "plate", "merchant", "venue", "vin"]);

/** Every string value under `value`, with the record-data values collected apart. */
function strings(value: unknown, out: { text: string[]; data: string[] }, key = ""): void {
  if (typeof value === "string") (DATA_KEYS.has(key) ? out.data : out.text).push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, key);
  else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) strings(item, out, name);
}

/**
 * The prompt, the evidence and the answer spec are what the model reads.
 * Record data quoted in them (a resident's name, a merchant) is removed
 * before matching: a real name may contain a banned stem by chance, and that
 * is not wording the generator chose.
 */
function checkModelVisible(task: KierstonBenchTask): void {
  const found = { text: [task.prompt], data: [] as string[] };
  strings(task.evidence, found);
  strings(task.answer, found);
  const data = [...new Set(found.data)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  for (let text of found.text) {
    for (const value of data) text = text.split(value).join(" ");
    expect(text).not.toMatch(LEAK);
  }
}

/**
 * Up to ATTEMPTS seeds; a thrown seed is a legitimate refusal. Two seeds
 * refused for the identical reason mean the day itself (usually the staged
 * scenario's fixed actors) rules the family out, so the rest are not tried.
 */
async function tryDay(generator: TaskGenerator, ctx: TaskContext, reasons: string[]): Promise<KierstonBenchTask | undefined> {
  let last: string | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const seed = fnv1a(`smoke|${ctx.date}|${generator.family}|${attempt}`);
    try {
      return await generator.generate(ctx, new Rng(seed ^ fnv1a(generator.family)), seed);
    } catch (error) {
      const message = (error as Error).message;
      reasons.push(`seed ${seed}: ${message}`);
      if (message === last) break;
      last = message;
    }
  }
  return undefined;
}

/**
 * The first task any of the days yields. A family that every seed refuses is
 * a warning, not a failure: the refusals are the generator's own eligibility
 * checks, and which seeds a family gets depends on its name and the day on disk.
 */
async function firstTask(generator: TaskGenerator, days: { base: string; delta?: string }[]): Promise<{ task: KierstonBenchTask; ctx: TaskContext } | undefined> {
  const reasons: string[] = [];
  for (const day of days) {
    const ctx = await contextFor(day.base, day.delta);
    reasons.push(`${rel(day.delta ?? day.base)}:`);
    const task = await tryDay(generator, ctx, reasons);
    if (task) return { task, ctx };
  }
  console.warn(`${generator.family} produced no task:\n  ${reasons.join("\n  ")}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Generator smoke test::${generator.family} produced no task in ${ATTEMPTS} seeds per day`);
  return undefined;
}

const rel = (path: string) => relative(REPO_ROOT, path);

for (const group of TASK_GROUPS) {
  describe.skipIf(!cityBuilt)(`${group.abbreviation} generators on the built city`, () => {
    for (const generator of group.generators) {
      if (generator.eventKind === undefined) {
        const label = plainDay ? `${generator.family} on ${basename(plainDay.file)}` : `${generator.family} (skipped: no day_*.bin in kierston/sim_outputs)`;
        test.skipIf(!plainDay)(label, async () => {
          const first = await firstTask(generator, [{ base: plainDay!.file }]);
          if (first) checkShape(first.task, generator, first.ctx);
          if (first) checkModelVisible(first.task);
        }, TEST_TIMEOUT_MS);
      } else {
        // Every matching staging is a candidate, newest first; a later one is
        // read only when the ones before it refuse the family.
        const pairs = scenariosByKind.get(generator.eventKind) ?? [];
        const label = pairs.length
          ? `${generator.family} on a staged ${generator.eventKind} day (${pairs.map((pair) => basename(pair.delta)).join(", ")})`
          : `${generator.family} (skipped: no staged .kdiff with a ${generator.eventKind} event matches a base day on disk)`;
        test.skipIf(!pairs.length)(label, async () => {
          const first = await firstTask(generator, pairs);
          if (first) checkShape(first.task, generator, first.ctx);
          if (first) checkModelVisible(first.task);
        }, TEST_TIMEOUT_MS);
      }
    }
  });
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { products, checkpointFromKday, STATE_VERSION, type StateCheckpoint } from "../../kierston/sim/src/index.ts";
import { writeDelta, materializeScenario, readDelta, type ScenarioDelta } from "../src/storage/delta.ts";
import { diffBytes } from "../src/storage/patch.ts";

let directory: string, input: string;
const opening: StateCheckpoint = { magic: "KSTATE", version: STATE_VERSION, coldStart: "2026-08-23", nextDate: "2026-08-23",
  completedDays: 0, initialized: true, bank: [], persons: [], vehicles: [], fleet: [], radio: [],
  communications: { pending: [], contactRecency: [] }, emergencyCalls: [] };
const closing: StateCheckpoint = { ...opening, completedDays: 1, nextDate: "2026-08-24",
  communications: { pending: Array.from({ length: 10_000 }, (_, i) => ({ kind: "active-call" as const, participants: [i, i + 1], remainingSeconds: (i * 7919) % 86_400 })), contactRecency: [] } };

async function writeManifest(path: string, manifest: ScenarioDelta) {
  const prefix = Buffer.alloc(8); prefix.write("KDIF"); prefix.writeUInt32LE(1, 4);
  await Bun.write(path, Buffer.concat([prefix, gzipSync(Buffer.from(JSON.stringify(manifest)))]));
}

beforeAll(async () => {
  // These fixtures are built without a city, so the zone the provider rows are
  // stamped in is pinned here rather than read from sim_data/city.json.
  process.env.CITY_TIME_ZONE = "America/New_York";
  directory = await mkdtemp(join(tmpdir(), "kierston-delta-storage-"));
  input = join(directory, "base.bin");
  // An empty KDAY with an opaque extension column exercises the codec without
  // loading city assets, and ensures unknown data survives the delta round trip.
  const payload = new Uint8Array(1_000_000);
  let seed = 42;
  for (let i = 0; i < payload.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; payload[i] = seed >>> 24; }
  const columns = products.PERSON_COLUMNS.map(({ name, type }) => ({ name, type, count: 0, byteOffset: 0, byteLength: 0 }));
  columns.push({ name: "extension.bytes", type: "u8", count: payload.length, byteOffset: 0, byteLength: payload.length });
  const header = Buffer.from(JSON.stringify({ magic: "KDAY", version: 11, date: opening.nextDate, day: 0,
    counts: {}, enums: {}, strings: ["retained"], columns, extension: { preserve: true } }));
  const prefix = Buffer.alloc(Math.ceil((8 + header.length) / 8) * 8);
  prefix.write("KDAY"); prefix.writeUInt32LE(header.length, 4); header.copy(prefix, 8);
  const skeleton = join(directory, "skeleton.bin");
  await Bun.write(skeleton, Buffer.concat([prefix, payload]));
  const file = await products.KdayFile.open(skeleton);
  try { await file.write(input, opening, closing); } finally { await file.close(); }
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("KDIF storage without initialized city assets", () => {
  test("materialization is byte-identical to the ordinary writer, including unknown data and changed checkpoints", async () => {
    const file = await products.KdayFile.open(input);
    const delta = join(directory, "edited.kdiff"), expected = join(directory, "expected.bin"), output = join(directory, "actual.bin");
    const changedState = structuredClone(closing);
    changedState.communications.pending[5] = { kind: "active-call", participants: [5, 77], remainingSeconds: 12 };
    changedState.communications.pending[9_000] = { kind: "active-call", participants: [9_000], remainingSeconds: 3_600 };
    try {
      const original = await file.column("extension.bytes");
      file.set("extension.bytes", [...original.subarray(0, 100), 99, 98, ...original.subarray(100, 900_000), ...original.subarray(900_010)]);
      file.strings.id("new scenario string");
      file.header.scenario = { name: "storage-fixture", seed: 7 };
      await file.write(expected, opening, changedState);
      await writeDelta(file, delta, opening, changedState, await products.fileDigest(input));
    } finally { await file.close(); }
    const manifest = await readDelta(delta);
    expect(manifest.columns.map((column) => column.name)).toEqual(["extension.bytes"]);
    expect(manifest.opening).toBeUndefined();
    expect(manifest.closing).toBeDefined();
    expect(Bun.file(delta).size).toBeLessThan(5_000);
    await materializeScenario({ input, delta, output });
    expect(await products.fileDigest(output)).toBe(await products.fileDigest(expected));
    expect(await checkpointFromKday(output)).toEqual(changedState);
    const result = await products.KdayFile.open(output);
    try { expect(result.header.extension).toEqual({ preserve: true }); } finally { await result.close(); }

    const cliOutput = join(directory, "cli.bin");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "merge", "--input", input,
      "--delta", delta, "--output", cliOutput], { cwd: directory, env: { ...process.env, KIERSTON_CITY: "no-such-city" }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, error: exit ? stderr : "" }).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(stdout).output).toBe(cliOutput);
    expect(await products.fileDigest(cliOutput)).toBe(await products.fileDigest(expected));
  });

  test("legacy base without an opening checkpoint stores the supplied opening once in its delta", async () => {
    const data = Buffer.from(await Bun.file(input).arrayBuffer()), length = data.readUInt32LE(4);
    const header = JSON.parse(data.subarray(8, 8 + length).toString("utf8"));
    delete header.openingState;
    const encoded = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(Math.ceil((8 + encoded.length) / 8) * 8);
    prefix.write("KDAY"); prefix.writeUInt32LE(encoded.length, 4); encoded.copy(prefix, 8);
    const legacy = join(directory, "legacy.bin");
    await Bun.write(legacy, Buffer.concat([prefix, data.subarray(Math.ceil((8 + length) / 8) * 8)]));
    const file = await products.KdayFile.open(legacy), delta = join(directory, "legacy.kdiff"), output = join(directory, "legacy-result.bin");
    try { await writeDelta(file, delta, opening, closing, await products.fileDigest(legacy)); } finally { await file.close(); }
    expect((await readDelta(delta)).opening).toBeDefined();
    await materializeScenario({ input: legacy, delta, output });
    expect(await checkpointFromKday(output, "opening")).toEqual(opening);
    expect(await checkpointFromKday(output)).toEqual(closing);
  });

  test("invalid patches fail before replacing an existing output or leaving temporary files", async () => {
    const file = await products.KdayFile.open(input), good = join(directory, "good.kdiff");
    try { await writeDelta(file, good, opening, closing, await products.fileDigest(input)); } finally { await file.close(); }
    const manifest = await readDelta(good), bad = join(directory, "bad.kdiff"), output = join(directory, "protected.bin");
    await Bun.write(output, "existing output");
    const patch = diffBytes(Buffer.alloc(0), Buffer.from("x"))!;
    for (const columns of [
      [{ name: "extension.bytes", patch: { ...patch, digest: "0".repeat(64) } }],
      [{ name: "extension.bytes", patch: { ...patch, operations: [[9_000_000, 1] as [number, number]] } }],
      [{ name: "unknown.column", patch }],
      [{ name: "extension.bytes", patch }, { name: "extension.bytes", patch }],
    ]) {
      await writeManifest(bad, { ...manifest, columns });
      await expect(materializeScenario({ input, delta: bad, output })).rejects.toThrow();
      expect(await Bun.file(output).text()).toBe("existing output");
    }
    const future = Buffer.from(await Bun.file(good).arrayBuffer()); future.writeUInt32LE(99, 4);
    await Bun.write(bad, future);
    await expect(readDelta(bad)).rejects.toThrow("unsupported");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

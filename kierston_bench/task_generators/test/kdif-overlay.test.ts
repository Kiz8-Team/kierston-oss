/**
 * A scenario day read as base + `.kdiff` in memory. The delta is built with
 * the scenarios package's own patch writer, so the reader is checked against
 * the bytes a real `create` would emit.
 */

import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { diffBytes } from "../../../kierston_scenarios/src/storage/patch.ts";
import { KdayReader } from "../src/kday.ts";
import { reducedHeader } from "../src/kdif.ts";

const dir = await mkdtemp(join(tmpdir(), "kdif-overlay-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const align8 = (value: number) => (value + 7) & ~7;

async function writeKday(path: string, header: Record<string, unknown>, columns: Record<string, Uint32Array>): Promise<string> {
  let offset = 0;
  const specs = Object.entries(columns).map(([name, values]) => {
    const spec = { name, type: "u32", count: values.length, byteOffset: offset, byteLength: values.byteLength };
    offset = align8(offset + values.byteLength);
    return spec;
  });
  const json = Buffer.from(JSON.stringify({ ...header, columns: specs }));
  const start = align8(8 + json.length);
  const file = Buffer.alloc(start + offset);
  file.write("KDAY");
  file.writeUInt32LE(json.length, 4);
  json.copy(file, 8);
  Object.values(columns).forEach((values, i) => Buffer.from(values.buffer).copy(file, start + specs[i]!.byteOffset));
  await Bun.write(path, file);
  return JSON.stringify({ ...header, columns: specs });
}

const baseHeader = { magic: "KDAY", version: 13, date: "2026-09-04", counts: { person: 3 }, enums: {}, strings: ["home", "work"] };
const basePath = join(dir, "day_2026-09-04.bin");
const rawHeader = await writeKday(basePath, baseHeader, {
  "person.id": new Uint32Array([10, 11, 12]),
  "leg.toLabel": new Uint32Array([0, 1, 0, 1]),
});
const baseHash = createHash("sha256").update(await Bun.file(basePath).bytes()).digest("hex");

async function writeDelta(path: string, hash: string): Promise<void> {
  const scenario = { format: "KIERSTON_SCENARIO", version: 1, name: "swatting", seed: 7, actors: {}, places: {}, groups: {}, events: [] };
  const patchedHeader = Buffer.from(JSON.stringify({ ...JSON.parse(reducedHeader(rawHeader).toString()), strings: ["home", "work", "scene"], scenario }));
  const manifest = {
    format: "KIERSTON_DELTA", version: 1, baseHash: hash, baseVersion: 13, date: "2026-09-04",
    metadata: diffBytes(reducedHeader(rawHeader), patchedHeader),
    columns: [{
      name: "leg.toLabel",
      patch: diffBytes(Buffer.from(new Uint32Array([0, 1, 0, 1]).buffer), Buffer.from(new Uint32Array([0, 1, 0, 1, 2]).buffer)),
    }],
  };
  const prefix = Buffer.alloc(8);
  prefix.write("KDIF");
  prefix.writeUInt32LE(1, 4);
  await Bun.write(path, Buffer.concat([prefix, gzipSync(JSON.stringify(manifest))]));
}

test("without a delta the base reads as it is", async () => {
  const day = await KdayReader.open(basePath);
  try {
    expect(day.meta.scenario).toBeUndefined();
    expect([...(await day.column("leg.toLabel"))]).toEqual([0, 1, 0, 1]);
  } finally {
    await day.close();
  }
});

test("a delta patches the header and the columns it names, in memory", async () => {
  const delta = join(dir, "swatting_2026-09-04_7.kdiff");
  await writeDelta(delta, baseHash);
  const day = await KdayReader.open(basePath, { delta });
  try {
    expect(day.meta.scenario?.name).toBe("swatting");
    expect(day.string(2)).toBe("scene");
    expect(day.spec("leg.toLabel").count).toBe(5);
    expect([...(await day.column("leg.toLabel"))]).toEqual([0, 1, 0, 1, 2]);
    expect([...(await day.column("person.id"))]).toEqual([10, 11, 12]);
    expect(day.meta.columns.map((column) => column.name)).toEqual(["person.id", "leg.toLabel"]);
  } finally {
    await day.close();
  }
});

test("a delta for another base refuses to apply", async () => {
  const delta = join(dir, "wrong-base.kdiff");
  await writeDelta(delta, "0".repeat(64));
  expect(KdayReader.open(basePath, { delta })).rejects.toThrow("base hash mismatch");
});

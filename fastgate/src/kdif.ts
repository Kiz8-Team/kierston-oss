import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { KdayReader, type KdayMeta, type NumericColumn, type TypeName } from "kierston-provider-rows";
import { scenarioIdentity, scenarioRecords, type RecordsProgress, type ScenarioRecords } from "kierston-provider-rows";

type Operation = [offset: number, length: number] | string;
interface BytePatch { length: number; digest: string; operations: Operation[] }

export interface ScenarioDelta {
  format: "KIERSTON_DELTA";
  version: 1;
  baseHash: string;
  baseVersion?: number;
  date: string;
  metadata?: BytePatch;
  columns: { name: string; patch: BytePatch }[];
  opening?: BytePatch;
  closing?: BytePatch;
  /** The ClickHouse rows this scenario changes; see `scenario-rows.ts` in kierston-provider-rows.
   * Absent on deltas written before the section existed. */
  records?: ScenarioRecords;
}

const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;
const WIDTH: Record<TypeName, number> = { u8: 1, u32: 4, i32: 4, f32: 4 };
const ARRAYS = { u8: Uint8Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array } as const;

function applyBytes(base: Buffer, patch: BytePatch): Buffer {
  if (!patch || !Number.isSafeInteger(patch.length) || patch.length < 0 || patch.length > 0xffffffff
    || typeof patch.digest !== "string" || !/^[a-f0-9]{64}$/.test(patch.digest)
    || !Array.isArray(patch.operations)) throw new Error("invalid KDIF byte patch");
  let length = 0;
  for (const operation of patch.operations) {
    if (typeof operation === "string") {
      if (operation.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(operation)) {
        throw new Error("invalid KDIF literal");
      }
      length += Buffer.byteLength(operation, "base64");
    } else {
      if (!Array.isArray(operation) || operation.length !== 2 || !operation.every(Number.isSafeInteger)
        || operation[0] < 0 || operation[1] < 1 || operation[0] + operation[1] > base.length) {
        throw new Error("KDIF copy is outside its base section");
      }
      length += operation[1];
    }
    if (length > patch.length) throw new Error("KDIF patch length mismatch");
  }
  if (length !== patch.length) throw new Error("KDIF patch length mismatch");
  const output = Buffer.allocUnsafe(length);
  let at = 0;
  for (const operation of patch.operations) {
    const bytes = typeof operation === "string"
      ? Buffer.from(operation, "base64")
      : base.subarray(operation[0], operation[0] + operation[1]);
    output.set(bytes, at);
    at += bytes.length;
  }
  if (createHash("sha256").update(output).digest("hex") !== patch.digest) {
    throw new Error("KDIF section digest mismatch");
  }
  return output;
}

function metadata(meta: KdayMeta): Record<string, unknown> {
  const source = meta as KdayMeta & Record<string, unknown>;
  const { columns: _columns, openingState: _opening, closingState: _closing, ...header } = source;
  return header;
}

export async function readDelta(path: string): Promise<ScenarioDelta> {
  const data = await readFile(path);
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "KDIF") {
    throw new Error(`${path} is not a KDIF scenario delta`);
  }
  if (data.readUInt32LE(4) !== 1) throw new Error("unsupported KDIF version");
  let delta: ScenarioDelta;
  try {
    delta = JSON.parse(gunzipSync(data.subarray(8), { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8"));
  } catch {
    throw new Error("invalid or corrupt KDIF payload");
  }
  if (!delta || delta.format !== "KIERSTON_DELTA" || delta.version !== 1
    || typeof delta.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(delta.baseHash)
    || !/^\d{4}-\d{2}-\d{2}$/.test(delta.date)
    || (delta.baseVersion !== undefined && (!Number.isSafeInteger(delta.baseVersion) || delta.baseVersion < 1))
    || !Array.isArray(delta.columns)) throw new Error("invalid KDIF manifest");
  const names = new Set<string>();
  for (const column of delta.columns) {
    if (!column || typeof column.name !== "string" || names.has(column.name) || !column.patch) {
      throw new Error("invalid KDIF column manifest");
    }
    names.add(column.name);
  }
  return delta;
}

export async function writeDelta(path: string, delta: ScenarioDelta): Promise<void> {
  const manifest = Buffer.from(JSON.stringify(delta));
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error("KDIF v1 manifest exceeds 512 MiB");
  const prefix = Buffer.alloc(8);
  prefix.write("KDIF", 0, "ascii"); prefix.writeUInt32LE(1, 4);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, Buffer.concat([prefix, gzipSync(manifest, { level: 9 })]), { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Adds (or recomputes) the records section of a delta on disk from its exact
 * base KDAY, for deltas written before the section existed. */
export async function annotateDelta(
  basePath: string, deltaPath: string, baseDigest: string, timeZone: string, progress?: RecordsProgress,
): Promise<ScenarioRecords> {
  const delta = await readDelta(deltaPath);
  const { records: _records, ...content } = delta;
  const scenarioId = scenarioIdentity(content);
  const [base, scenario] = await Promise.all([
    KdayReader.open(basePath), KdifReader.open(basePath, deltaPath, baseDigest),
  ]);
  let records: ScenarioRecords;
  try {
    records = await scenarioRecords(base, scenario, baseDigest, scenarioId, timeZone, progress);
  } finally {
    await Promise.all([base.close(), scenario.close()]);
  }
  await writeDelta(deltaPath, { ...content, records });
  return records;
}

/** A KDAY view with a KDIF applied lazily. Only columns requested by an
 * extractor are restored; no materialized scenario KDAY is written.
 */
export class KdifReader {
  readonly meta: KdayMeta;
  readonly baseHash: string;
  private readonly base: KdayReader;
  private readonly patches: Map<string, BytePatch>;
  private constructor(
    base: KdayReader,
    meta: KdayMeta,
    baseHash: string,
    patches: Map<string, BytePatch>,
  ) {
    this.base = base;
    this.patches = patches;
    this.meta = meta;
    this.baseHash = baseHash;
  }

  static async open(basePath: string, deltaPath: string, baseDigest: string): Promise<KdifReader> {
    const [base, delta] = await Promise.all([KdayReader.open(basePath), readDelta(deltaPath)]);
    try {
      if (delta.baseHash !== baseDigest) throw new Error("KDIF base hash does not match the supplied KDAY");
      const expectedVersion = delta.baseVersion ?? 11;
      if (base.meta.date !== delta.date || base.meta.version !== expectedVersion) {
        throw new Error("KDIF base date/version does not match the supplied KDAY");
      }
      const baseMetadata = metadata(base.meta);
      const restored = delta.metadata
        ? JSON.parse(applyBytes(Buffer.from(JSON.stringify(baseMetadata)), delta.metadata).toString("utf8"))
        : baseMetadata;
      if (!restored || restored.magic !== "KDAY" || restored.version !== expectedVersion
        || restored.date !== delta.date || !Array.isArray(restored.strings)
        || !restored.strings.every((value: unknown) => typeof value === "string")
        || restored.strings.length < base.meta.strings.length
        || base.meta.strings.some((value, index) => restored.strings[index] !== value)) {
        throw new Error("invalid KDIF KDAY metadata");
      }
      const patches = new Map(delta.columns.map((entry) => [entry.name, entry.patch]));
      const columns = base.meta.columns.map((column) => {
        const patch = patches.get(column.name);
        if (!patch) return column;
        const width = WIDTH[column.type];
        if (patch.length % width) throw new Error(`unaligned KDIF column ${column.name}`);
        return { ...column, count: patch.length / width, byteLength: patch.length };
      });
      for (const name of patches.keys()) if (!base.has(name)) throw new Error(`unknown KDIF column ${name}`);
      const meta = { ...restored, columns } as unknown as KdayMeta;
      return new KdifReader(base, meta, delta.baseHash, patches);
    } catch (error) {
      await base.close();
      throw error;
    }
  }

  has(name: string): boolean { return this.base.has(name); }

  async column(name: string): Promise<NumericColumn> {
    const original = await this.base.column(name);
    const patch = this.patches.get(name);
    if (!patch) return original;
    const bytes = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
    const restored = applyBytes(bytes, patch);
    const type = this.base.spec(name).type;
    const aligned = Uint8Array.from(restored);
    return new ARRAYS[type](aligned.buffer);
  }

  string(id: number): string | null {
    return id === 0xffffffff ? null : (this.meta.strings[id] ?? null);
  }

  enum(group: string, id: number): string | null {
    return id === 0xff ? null : (this.meta.enums[group]?.[id] ?? null);
  }

  close(): Promise<void> { return this.base.close(); }
}

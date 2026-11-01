import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KdayReader } from "kierston-provider-rows";

const align8 = (value: number): number => (value + 7) & ~7;

test("reads a self-describing KDAY column without touching the closing state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-kday-test-"));
  const path = join(directory, "day.bin");
  try {
    const values = new Uint32Array([7, 11]);
    const header = {
      magic: "KDAY",
      version: 10,
      date: "2026-07-28",
      counts: {},
      enums: {},
      strings: [],
      columns: [{
        name: "sample.value",
        type: "u32",
        count: values.length,
        byteOffset: 0,
        byteLength: values.byteLength,
      }],
    };
    const encoded = Buffer.from(JSON.stringify(header));
    const dataStart = align8(8 + encoded.length);
    const file = Buffer.alloc(dataStart + values.byteLength + 64, 0xaa);
    file.write("KDAY", 0, "utf8");
    file.writeUInt32LE(encoded.length, 4);
    encoded.copy(file, 8);
    Buffer.from(values.buffer).copy(file, dataStart);
    await writeFile(path, file);

    const reader = await KdayReader.open(path);
    try {
      expect(Array.from(await reader.column("sample.value"))).toEqual([7, 11]);
    } finally {
      await reader.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

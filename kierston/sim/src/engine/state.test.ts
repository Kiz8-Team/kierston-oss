import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bank } from "../economy/index.ts";
import { simDataPresent } from "../world/index.ts";
import {
  SimulationState, STATE_MAGIC, STATE_VERSION, checkpointDigest,
  checkpointFromKday, decodeCheckpoint, encodeCheckpoint, type EmbeddedStateDescriptor,
} from "./state.ts";

/** Bank.load reads the built city's holdings; skipped, not failed, without one. */
const CITY = simDataPresent("holdings.bin");
const monday = new Date(2026, 7, 17);
const tuesday = new Date(2026, 7, 18);

describe.skipIf(!CITY)("the day-boundary state", () => {
  test("accepts exactly the next chronological date", () => {
    const state = SimulationState.cold(monday, Bank.load());
    state.enter(monday);
    state.advance(monday);
    expect(state.nextDate).toBe("2026-08-18");
    expect(state.completedDays).toBe(1);
    expect(() => state.enter(monday)).toThrow("expects 2026-08-18");
    expect(() => state.enter(new Date(2026, 7, 19))).toThrow("expects 2026-08-18");
    state.enter(tuesday);
  });

  test("a checkpoint restores every balance future dates can observe", () => {
    const state = SimulationState.cold(monday, Bank.load());
    const position = state.bank.position(0);
    position.accounts[0]!.balance = Math.round((position.accounts[0]!.balance - 12.34) * 100) / 100;
    const credit = position.cards.find((card) => card.kind === "credit");
    if (credit) credit.balance = Math.round((credit.balance + 8.76) * 100) / 100;
    state.advance(monday);

    const checkpoint = state.checkpoint([0]);
    const restored = SimulationState.restore(checkpoint, Bank.load());
    expect(restored.nextDate).toBe("2026-08-18");
    expect(restored.bank.position(0).accounts.map((account) => account.balance))
      .toEqual(position.accounts.map((account) => account.balance));
    expect(restored.bank.position(0).cards.map((card) => [card.limit, card.balance]))
      .toEqual(position.cards.map((card) => [card.limit, card.balance]));
    expect(restored.digest([0])).toBe(state.digest([0]));
  });

  test("the end-state hash is the next day's start-state hash", () => {
    const state = SimulationState.cold(monday, Bank.load());
    state.advance(monday);
    const end = state.digest([0, 1, 2]);
    state.enter(tuesday);
    const nextStart = state.digest([0, 1, 2]);
    expect(nextStart).toBe(end);
  }, 60_000);

  test("carries active call occupancy into the next day", () => {
    const state = SimulationState.cold(monday, Bank.load());
    state.beginTransition();
    state.stageCommunications({
      pending: [{ kind: "active-call", participants: [7, 9], remainingSeconds: 83 }],
      contactRecency: [],
    });
    state.advance(monday);
    expect(state.communicationsForDay().pending).toEqual([
      { kind: "active-call", participants: [7, 9], remainingSeconds: 83 },
    ]);
    const restored = SimulationState.restore(state.checkpoint([]), Bank.load());
    expect(restored.communicationsForDay()).toEqual(state.communicationsForDay());
  });

  test("the checkpoint envelope is content-addressed and versioned", () => {
    const state = SimulationState.cold(monday, Bank.load());
    const checkpoint = state.checkpoint([0]);
    expect(checkpoint.magic).toBe(STATE_MAGIC);
    expect(checkpoint.version).toBe(STATE_VERSION);
    expect(checkpointDigest(checkpoint)).toHaveLength(64);
    expect(() => SimulationState.restore({ ...checkpoint, version: 99 as 4 }, Bank.load()))
      .toThrow("unsupported simulation state");
  });

  test("the embedded checkpoint codec is compact and authenticates its contents", () => {
    const state = SimulationState.cold(monday, Bank.load());
    state.advance(monday);
    const checkpoint = state.checkpoint([0, 1, 2]);
    const encoded = encodeCheckpoint(checkpoint);
    const descriptor = {
      magic: STATE_MAGIC,
      version: STATE_VERSION,
      encoding: "gzip-json" as const,
      boundary: "closing" as const,
      nextDate: checkpoint.nextDate,
      digest: encoded.digest,
      byteOffset: 0,
      byteLength: encoded.bytes.byteLength,
      rawByteLength: encoded.rawByteLength,
    } satisfies EmbeddedStateDescriptor;
    expect(decodeCheckpoint(encoded.bytes, descriptor)).toEqual(checkpoint);
    expect(decodeCheckpoint(encoded.bytes, { ...descriptor, boundary: "opening" })).toEqual(checkpoint);
    expect(encoded.bytes.byteLength).toBeLessThan(encoded.rawByteLength);
    expect(() => decodeCheckpoint(encoded.bytes, { ...descriptor, digest: "0".repeat(64) }))
      .toThrow("does not match KDAY header");
  }, 120_000);

  test("restores a closing checkpoint by seeking past KDAY's analytical payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kierston-state-"));
    try {
      const state = SimulationState.cold(monday, Bank.load());
      state.advance(monday);
      const checkpoint = state.checkpoint([0, 1, 2]);
      const encoded = encodeCheckpoint(checkpoint);
      const byteOffset = 16;
      const descriptor = {
        magic: STATE_MAGIC,
        version: STATE_VERSION,
        encoding: "gzip-json" as const,
        boundary: "closing" as const,
        nextDate: checkpoint.nextDate,
        digest: encoded.digest,
        byteOffset,
        byteLength: encoded.bytes.byteLength,
        rawByteLength: encoded.rawByteLength,
      } satisfies EmbeddedStateDescriptor;
      const header = new TextEncoder().encode(JSON.stringify({ magic: "KDAY", version: 10, closingState: descriptor }));
      const dataStart = (8 + header.byteLength + 7) & ~7;
      const file = new Uint8Array(dataStart + byteOffset + encoded.bytes.byteLength);
      file.set(new TextEncoder().encode("KDAY"), 0);
      new DataView(file.buffer).setUint32(4, header.byteLength, true);
      file.set(header, 8);
      file.set(encoded.bytes, dataStart + byteOffset);
      const path = join(directory, "day_2026-08-17.bin");
      await Bun.write(path, file);
      expect(await checkpointFromKday(path)).toEqual(checkpoint);
      await expect(checkpointFromKday(path, "opening")).rejects.toThrow("no embedded opening state");
      expect((await SimulationState.open(path, Bank.load())).nextDate).toBe("2026-08-18");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

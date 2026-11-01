import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { KdayReader } from "kierston-provider-rows";
import { annotateDelta } from "../src/kdif.ts";
import type { NumericColumn, TypeName } from "kierston-provider-rows";

const typeOf = (column: NumericColumn): TypeName => column instanceof Uint8Array ? "u8"
  : column instanceof Uint32Array ? "u32"
    : column instanceof Int32Array ? "i32" : "f32";
const align8 = (value: number): number => (value + 7) & ~7;

export async function writeObservableFixture(path: string): Promise<void> {
  const none = 0xffffffff;
  const noneByte = 0xff;
  const bag: Record<string, NumericColumn> = {
    "camera.id": new Uint32Array([0]),
    "camera.side": new Uint8Array([0]),
    "camera.latE6": new Int32Array([40_610_000]),
    "camera.lonE6": new Int32Array([-75_480_000]),
    "camera.role": new Uint32Array([1]),
    "camera.owner": new Uint32Array([2]),
    "alprObservation.camera": new Uint32Array([0, 0]),
    "alprObservation.second": new Uint32Array([3_600, 3_601]),
    "alprObservation.detectedText": new Uint32Array([3, none]),
    "alprObservation.canonicalText": new Uint32Array([4, none]),
    "alprObservation.confidence": new Float32Array([0.94, 0]),
    "alprObservation.lighting": new Uint8Array([0, 0]),
    "cell.cgi": new Uint32Array([5]),
    "cell.structure": new Uint32Array([6]),
    "cell.operator": new Uint8Array([0]),
    "cell.layer": new Uint8Array([0]),
    "cell.band": new Uint32Array([7]),
    "cell.trackingArea": new Uint32Array([42]),
    "cell.pci": new Uint32Array([17]),
    "cell.latE6": new Int32Array([40_620_000]),
    "cell.lonE6": new Int32Array([-75_470_000]),
    "subscriber.imsi": new Uint32Array([8]),
    "subscriber.imei": new Uint32Array([9]),
    "subscriber.msisdn": new Uint32Array([10]),
    "subscriber.carrier": new Uint32Array([11]),
    "subscriber.operator": new Uint8Array([0]),
    "subscriber.tier": new Uint8Array([0]),
    "subscriber.mvno": new Uint8Array([0]),
    "subscriber.prepaid": new Uint8Array([1]),
    "event.subscriber": new Uint32Array([0]),
    "event.minute": new Int32Array([10]),
    "event.kind": new Uint8Array([0]),
    "event.cell": new Int32Array([0]),
    "event.previous": new Int32Array([-1]),
    "event.cause": new Uint8Array([0]),
    "event.ta": new Int32Array([9]),
    "event.secondary": new Int32Array([-1]),
    "message.at": new Uint32Array([900]),
    "message.conversation": new Uint32Array([0]),
    "message.channel": new Uint8Array([0]),
    "sms.message": new Uint32Array([0]),
    "sms.from": new Int32Array([0]),
    "sms.to": new Int32Array([-1]),
    "sms.cell": new Int32Array([0]),
    "sms.toCell": new Int32Array([-1]),
    "sms.part": new Uint8Array([0]),
    "sms.parts": new Uint8Array([1]),
    "sms.delivered": new Int32Array([902]),
    "call.at": new Uint32Array([1_200]),
    "call.outcome": new Uint8Array([0]),
    "call.ring": new Uint32Array([4]),
    "call.duration": new Uint32Array([90]),
    "cdr.call": new Uint32Array([0]),
    "cdr.from": new Int32Array([0]),
    "cdr.to": new Int32Array([-1]),
    "cdr.originCell": new Int32Array([0]),
    "cdr.endCell": new Int32Array([0]),
    "cdr.toOriginCell": new Int32Array([-1]),
    "cdr.toEndCell": new Int32Array([-1]),
    "cdr.handoverAt": new Uint32Array([0]),
    "cdr.handoverCount": new Uint32Array([1]),
    "handover.second": new Uint32Array([1_260]),
    "handover.cell": new Int32Array([0]),
    "tx.minute": new Int32Array([30]),
    "tx.amount": new Float32Array([12.5]),
    "tx.kind": new Uint8Array([0]),
    "tx.approved": new Uint8Array([1]),
    "tx.decline": new Uint8Array([noneByte]),
    "tx.instrument": new Uint8Array([0]),
    "tx.mcc": new Uint32Array([5411]),
    "tx.merchant": new Uint32Array([12]),
    "tx.account": new Uint32Array([13]),
    "tx.card": new Uint32Array([14]),
    "tx.network": new Uint32Array([15]),
    "tx.balanceAfter": new Float32Array([87.5]),
    "tx.latE6": new Int32Array([40_630_000]),
    "tx.lonE6": new Int32Array([-75_460_000]),
  };

  let payloadLength = 0;
  const columns = Object.entries(bag).map(([name, values]) => {
    payloadLength = align8(payloadLength);
    const byteOffset = payloadLength;
    payloadLength += values.byteLength;
    return {
      name, type: typeOf(values), count: values.length, byteOffset, byteLength: values.byteLength,
    };
  });
  const meta = {
    magic: "KDAY",
    version: 10,
    date: "2099-01-02",
    counts: {},
    enums: {
      plateSide: ["rear"],
      lighting: ["day"],
      operator: ["carrier-one"],
      radioLayer: ["LTE anchor"],
      radioTier: ["lte"],
      eventKind: ["attach"],
      eventCause: ["power-on"],
      channel: ["sms", "mms"],
      callOutcome: ["answered"],
      txKind: ["payment"],
      instrument: ["debit"],
      decline: [],
    },
    strings: [
      "ALPR-TEST", "arterial", "city", "ABC-1234", "ABC1234", "cgi-1", "tower-1", "B12",
      "imsi-1", "imei-1", "+15550000001", "Carrier One", "Market", "acct-1", "1234", "Visa",
    ],
    columns,
  };
  const header = Buffer.from(JSON.stringify(meta));
  const dataStart = align8(8 + header.length);
  const output = Buffer.alloc(dataStart + payloadLength);
  output.write("KDAY", 0, "utf8");
  output.writeUInt32LE(header.length, 4);
  header.copy(output, 8);
  for (const [index, values] of Object.values(bag).entries()) {
    Buffer.from(values.buffer, values.byteOffset, values.byteLength)
      .copy(output, dataStart + columns[index]!.byteOffset);
  }
  await writeFile(path, output);
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const literal = (bytes: Uint8Array) => ({
  length: bytes.byteLength,
  digest: digest(bytes),
  operations: [Buffer.from(bytes).toString("base64")],
});

/** A minimal valid KDIF that changes the fixture's sole provider-visible bank
 * transaction while leaving every other provider record byte-for-byte equal.
 */
export async function writeAmountScenarioFixture(basePath: string, deltaPath: string): Promise<string> {
  const baseBytes = await readFile(basePath), baseDigest = digest(baseBytes);
  const base = await KdayReader.open(basePath);
  try {
    const amount = new Float32Array(await base.column("tx.amount") as Float32Array);
    amount[0] = 19.75;
    const source = base.meta as typeof base.meta & Record<string, unknown>;
    const { columns: _columns, openingState: _opening, closingState: _closing, ...metadata } = source;
    const nextMetadata = { ...metadata, scenario: {
      format: "KIERSTON_SCENARIO", version: 1, name: "fixture", affected: [{ person: 0 }],
    } };
    const manifest = {
      format: "KIERSTON_DELTA", version: 1, baseHash: baseDigest, baseVersion: base.meta.version,
      date: base.meta.date,
      metadata: literal(Buffer.from(JSON.stringify(nextMetadata))),
      columns: [{ name: "tx.amount", patch: literal(
        Buffer.from(amount.buffer, amount.byteOffset, amount.byteLength),
      ) }],
    };
    const payload = gzipSync(Buffer.from(JSON.stringify(manifest)));
    const output = Buffer.alloc(8 + payload.length);
    output.write("KDIF", 0, "ascii"); output.writeUInt32LE(1, 4); payload.copy(output, 8);
    await writeFile(deltaPath, output);
  } finally {
    await base.close();
  }
  await annotateDelta(basePath, deltaPath, baseDigest, "America/New_York");
  return baseDigest;
}

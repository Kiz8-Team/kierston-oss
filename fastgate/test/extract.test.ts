import { describe, expect, test } from "bun:test";
import {
  alprReads, bankTransactions, networkEvents, smsRecords, type CellReference, type DaySource,
} from "kierston-provider-rows";
import type { KdayMeta, NumericColumn, TypeName } from "kierston-provider-rows";

const typeOf = (column: NumericColumn): TypeName => column instanceof Uint8Array ? "u8"
  : column instanceof Uint32Array ? "u32"
    : column instanceof Int32Array ? "i32" : "f32";

function source(
  bag: Record<string, NumericColumn>,
  options: {
    strings?: string[];
    enums?: Record<string, string[]>;
    date?: string;
  } = {},
): DaySource {
  const meta: KdayMeta = {
    magic: "KDAY",
    version: 10,
    date: options.date ?? "2026-07-28",
    counts: {},
    enums: options.enums ?? {},
    strings: options.strings ?? [],
    columns: Object.entries(bag).map(([name, values]) => ({
      name,
      type: typeOf(values),
      count: values.length,
      byteOffset: 0,
      byteLength: values.byteLength,
    })),
  };
  return {
    meta,
    has: (name) => name in bag,
    column: async (name) => {
      const found = bag[name];
      if (!found) throw new Error(`missing ${name}`);
      return found;
    },
    string: (id) => id === 0xffffffff ? null : (meta.strings[id] ?? null),
    enum: (group, id) => id === 0xff ? null : (meta.enums[group]?.[id] ?? null),
  };
}

describe("observable record filtering", () => {
  test("ALPR exports only reads that produced text", async () => {
    const input = source({
      "alprObservation.camera": new Uint32Array([0, 0]),
      "alprObservation.second": new Uint32Array([3_600, 3_601]),
      "alprObservation.detectedText": new Uint32Array([0, 0xffffffff]),
      "alprObservation.canonicalText": new Uint32Array([1, 0xffffffff]),
      "alprObservation.confidence": new Float32Array([0.93, 0]),
      "alprObservation.lighting": new Uint8Array([0, 0]),
      // Their presence in the source must not make them part of the output.
      "alprObservation.outcome": new Uint8Array([0, 3]),
      "alprTruth.plate": new Uint32Array([2, 3]),
    }, {
      strings: ["ABC-1234", "ABC1234", "ACTUAL", "MISSED"],
      enums: { lighting: ["day"] },
    });

    const rows = await alprReads(input, "a".repeat(64), "America/New_York", ["ALPR-001"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      camera_id: "ALPR-001",
      plate_text: "ABC-1234",
      normalized_plate: "ABC1234",
      lighting: "day",
    });
    expect(Object.keys(rows[0]!)).not.toContain("outcome");
    expect(Object.keys(rows[0]!)).not.toContain("plate");
    expect(Object.keys(rows[0]!)).not.toContain("correlation_id");
  });

  test("network output drops idle reselections and the synthetic day boundary", async () => {
    const input = source({
      "event.subscriber": new Uint32Array([0, 0, 0, 0]),
      "event.minute": new Int32Array([0, 10, 20, 30]),
      "event.kind": new Uint8Array([0, 3, 4, 2]),
      "event.cell": new Int32Array([0, 1, 1, 1]),
      "event.previous": new Int32Array([-1, 0, -1, 0]),
      "event.cause": new Uint8Array([2, 1, 3, 1]),
    }, {
      enums: {
        eventKind: ["attach", "detach", "handover", "reselect", "tau"],
        eventCause: ["power-on", "better-cell", "day-start", "periodic"],
      },
    });
    const sites: CellReference[] = [
      { cgi: "cell-a", tracking_area: 7 },
      { cgi: "cell-b", tracking_area: 8 },
    ];

    const rows = await networkEvents(
      input, "b".repeat(64), "America/New_York", ["imsi-1"], ["imei-1"], sites,
    );
    expect(rows.map((row) => row.event_type)).toEqual(["tau", "handover"]);
    expect(rows[0]).toMatchObject({ cell_cgi: null, previous_cell_cgi: null, tracking_area: 8 });
    expect(Object.keys(rows[0]!)).not.toContain("cause");
    // A file from before the measurement carries neither, and says so.
    expect(rows[0]).toMatchObject({ timing_advance: null, secondary_cell_cgi: null });
  });

  test("network output keeps the timing advance and the secondary carrier where the file measured them", async () => {
    const input = source({
      "event.subscriber": new Uint32Array([0, 0, 0]),
      "event.minute": new Int32Array([10, 20, 30]),
      "event.kind": new Uint8Array([4, 2, 1]),
      "event.cell": new Int32Array([1, 1, -1]),
      "event.previous": new Int32Array([-1, 0, 1]),
      "event.cause": new Uint8Array([3, 1, 0]),
      "event.ta": new Int32Array([12, 3, -1]),
      "event.secondary": new Int32Array([-1, 0, -1]),
    }, {
      enums: {
        eventKind: ["attach", "detach", "handover", "reselect", "tau"],
        eventCause: ["power-on", "better-cell", "day-start", "periodic"],
      },
    });
    const sites: CellReference[] = [
      { cgi: "cell-a", tracking_area: 7 },
      { cgi: "cell-b", tracking_area: 8 },
    ];
    const rows = await networkEvents(
      input, "b".repeat(64), "America/New_York", ["imsi-1"], ["imei-1"], sites,
    );
    expect(rows.map((row) => row.event_type)).toEqual(["tau", "handover", "detach"]);
    // The tracking-area update withholds its cell but keeps the distance it measured.
    expect(rows[0]).toMatchObject({ cell_cgi: null, tracking_area: 8, timing_advance: 12, secondary_cell_cgi: null });
    expect(rows[1]).toMatchObject({ cell_cgi: "cell-b", timing_advance: 3, secondary_cell_cgi: "cell-a" });
    expect(rows[2]).toMatchObject({ cell_cgi: null, timing_advance: null, secondary_cell_cgi: null });
  });

  test("SMS records flag MMS as multimedia", async () => {
    const input = source({
      "message.channel": new Uint8Array([0, 1]),
      "message.at": new Uint32Array([100, 200]),
      "sms.message": new Uint32Array([0, 1]),
      "sms.from": new Int32Array([0, 0]),
      "sms.to": new Int32Array([-1, -1]),
      "sms.cell": new Int32Array([-1, -1]),
      "sms.toCell": new Int32Array([-1, -1]),
      "sms.part": new Uint8Array([0, 0]),
      "sms.parts": new Uint8Array([1, 1]),
      "sms.delivered": new Int32Array([-1, -1]),
    }, {
      enums: { channel: ["sms", "mms"] },
    });

    const rows = await smsRecords(input, "d".repeat(64), "America/New_York", ["imsi-1"], ["imei-1"], []);
    expect(rows.map((row) => row.multimedia)).toEqual([false, true]);
  });

  // A pair spills to their secondary channel, so a carrier send can sit in a
  // thread the operator never saw. The send's channel decides, not the thread's.
  test("SMS records accept a carrier send inside an app thread", async () => {
    const input = source({
      "message.channel": new Uint8Array([0, 7]),
      "message.at": new Uint32Array([100, 200]),
      "sms.message": new Uint32Array([0]),
      "sms.from": new Int32Array([0]),
      "sms.to": new Int32Array([0]),
      "sms.cell": new Int32Array([0]),
      "sms.toCell": new Int32Array([1]),
      "sms.part": new Uint8Array([0]),
      "sms.parts": new Uint8Array([1]),
      "sms.delivered": new Int32Array([-1]),
    }, {
      enums: { channel: ["sms", "mms", "voice", "imessage", "whatsapp", "telegram", "signal", "messenger"] },
    });

    const rows = await smsRecords(
      input, "d".repeat(64), "America/New_York", ["imsi-1"], ["imei-1"], ["cell-a", "cell-b"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      multimedia: false,
      originating_imei: "imei-1",
      destination_imei: "imei-1",
      // Each end's own cell: the sender's at submission, the recipient's at delivery.
      originating_cell_cgi: "cell-a",
      destination_cell_cgi: "cell-b",
    });
    // Identity belongs in the provider tables, never copied onto a carrier record.
    for (const name of Object.keys(rows[0]!)) expect(name).not.toContain("_name");
  });

  test("bank output drops cash purchases but retains bank-visible withdrawals", async () => {
    const none = 0xffffffff;
    const noneByte = 0xff;
    const input = source({
      "tx.minute": new Int32Array([10, 20, 30]),
      "tx.amount": new Float32Array([8.25, 12.5, 40]),
      "tx.kind": new Uint8Array([0, 0, 1]),
      "tx.approved": new Uint8Array([1, 1, 1]),
      "tx.decline": new Uint8Array([noneByte, noneByte, noneByte]),
      "tx.instrument": new Uint8Array([1, 0, 1]),
      "tx.mcc": new Uint32Array([5814, 5411, 0]),
      "tx.merchant": new Uint32Array([0, 1, 2]),
      "tx.account": new Uint32Array([none, 3, 3]),
      "tx.card": new Uint32Array([none, 4, none]),
      "tx.network": new Uint32Array([none, 5, none]),
      "tx.balanceAfter": new Float32Array([25, 100, 60]),
      "tx.latE6": new Int32Array([40_000_000, 40_000_000, 40_000_000]),
      "tx.lonE6": new Int32Array([-75_000_000, -75_000_000, -75_000_000]),
    }, {
      strings: ["Cafe", "Market", "ATM", "acct-1", "1234", "Visa"],
      enums: {
        txKind: ["payment", "withdrawal"],
        instrument: ["debit", "cash"],
        decline: [],
      },
    });

    const rows = await bankTransactions(input, "c".repeat(64), "America/New_York");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.transaction_type)).toEqual(["payment", "withdrawal"]);
    expect(rows.map((row) => row.merchant)).toEqual(["Market", "ATM"]);
    expect(Object.keys(rows[0]!)).not.toContain("reason");
    expect(Object.keys(rows[0]!)).not.toContain("person_id");
  });
});

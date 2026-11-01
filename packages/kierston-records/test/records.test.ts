import { describe, expect, test } from "bun:test";
import { dateYear, decodeRecords, formatDate, NULL_INT, type RecordMeta, type TableSpec } from "../src/index.ts";

type Kind = RecordMeta["arrays"][number]["kind"];
type Typed = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

const kindOf = (array: Typed): Kind =>
  array instanceof Uint8Array ? "u8" : array instanceof Uint16Array ? "u16" : array instanceof Uint32Array ? "u32"
    : array instanceof Int32Array ? "i32" : array instanceof Float32Array ? "f32" : "f64";

/** Interned strings the way pack_records.py writes them: code 0 is the empty string. */
function strings(column: string, values: string[]): Record<string, Typed> {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const offsets = new Uint32Array(encoded.length + 1);
  encoded.forEach((bytes, i) => { offsets[i + 1] = offsets[i]! + bytes.length; });
  const bytes = new Uint8Array(offsets[encoded.length]!);
  encoded.forEach((chunk, i) => bytes.set(chunk, offsets[i]!));
  return { [`${column}_offset`]: offsets, [`${column}_bytes`]: bytes };
}

/** A KREC container: magic, header length, JSON header, 8-aligned typed arrays. */
function pack(tables: TableSpec[], columns: Record<string, Typed>, extra: Partial<RecordMeta> = {}): ArrayBuffer {
  const arrays: RecordMeta["arrays"] = [];
  let offset = 0;
  for (const [name, array] of Object.entries(columns)) {
    arrays.push({ name, kind: kindOf(array), length: array.length, byteOffset: offset });
    offset = (offset + array.byteLength + 7) & ~7;
  }
  const meta: RecordMeta = { dataset: "fixture", source: "test", builtAt: "2026-01-01", seed: 1, referenceYear: 2026,
    surveyed: [], modelled: [], counts: {}, tables, arrays, ...extra };
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const start = (8 + header.length + 7) & ~7;
  const buffer = new ArrayBuffer(start + offset);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode("KREC"), 0);
  new DataView(buffer).setUint32(4, header.length, true);
  bytes.set(header, 8);
  for (const spec of arrays) {
    const array = columns[spec.name]!;
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), start + spec.byteOffset);
  }
  return buffer;
}

const tables: TableSpec[] = [
  {
    name: "case", rows: 3,
    fields: [
      { name: "person", kind: "id", column: "case_person" },
      { name: "court", kind: "enum", column: "case_court" },
      { name: "docket", kind: "str", column: "case_docket" },
      { name: "filed", kind: "date", column: "case_filed" },
      { name: "sealed", kind: "bool", column: "case_sealed" },
      { name: "year", kind: "year", column: "case_year" },
      { name: "priors", kind: "u8", column: "case_priors" },
      { name: "days", kind: "u16", column: "case_days" },
      { name: "fine", kind: "money", column: "case_fine" },
      { name: "rate", kind: "rate", column: "case_rate" },
      { name: "score", kind: "int", column: "case_score" },
      { name: "tags", kind: "list", column: "case_tags", offsets: "case_tags_offsets" },
    ],
    children: [{ name: "charges", table: "charge", offsets: "case_charges" }],
  },
  {
    name: "charge", rows: 3,
    fields: [{ name: "statute", kind: "enum", column: "charge_statute" }],
    children: [],
  },
];

const columns: Record<string, Typed> = {
  case_person: new Uint32Array([7, 4294967295, 7]),
  case_court: new Uint8Array([1, 2, 1]),
  ...strings("case_court", ["District", "Common Pleas"]),
  case_docket: new Uint16Array([1, 0, 2]),
  ...strings("case_docket", ["MJ-1", "CP-2"]),
  case_filed: new Int32Array([20240229, 0, 19991231]),
  case_sealed: new Uint8Array([1, 0, 2]),
  case_year: new Uint16Array([2024, 0, 1999]),
  case_priors: new Uint8Array([3, 255, 0]),
  case_days: new Uint16Array([65535, 30, 0]),
  case_fine: new Float64Array([125.5, Number.NaN, 0]),
  case_rate: new Float32Array([0.25, Number.NaN, 1]),
  case_score: new Int32Array([-5, NULL_INT, 12]),
  case_tags: new Uint8Array([1, 2, 2]),
  case_tags_offsets: new Uint32Array([0, 2, 2, 3]),
  ...strings("case_tags", ["dui", "théft"]),
  case_charges: new Uint32Array([0, 2, 2, 3]),
  charge_statute: new Uint8Array([1, 2, 1]),
  ...strings("charge_statute", ["75 § 3802", "18 § 3921"]),
};

describe("decodeRecords", () => {
  const set = decodeRecords(pack(tables, columns, { persons: 2 }));
  const cases = set.table("case");

  test("reads the header and the tables it names", () => {
    expect(set.dataset).toBe("fixture");
    expect(set.meta.persons).toBe(2);
    expect(set.tableNames).toEqual(["case", "charge"]);
    expect(cases.rows).toBe(3);
    expect(cases.fieldNames[0]).toBe("person");
    expect(cases.kindOf("filed")).toBe("date");
    expect(cases.kindOf("missing")).toBeNull();
    expect(cases.childNames).toEqual(["charges"]);
  });

  test("every kind round-trips, and each sentinel reads back as null", () => {
    expect(cases.row(0)).toEqual({
      person: 7, court: "District", docket: "MJ-1", filed: "2024-02-29", sealed: true, year: 2024,
      priors: 3, days: null, fine: 125.5, rate: 0.25, score: -5, tags: ["dui", "théft"],
    });
    expect(cases.row(1)).toEqual({
      person: null, court: "Common Pleas", docket: null, filed: null, sealed: false, year: null,
      priors: null, days: 30, fine: null, rate: null, score: null, tags: [],
    });
    expect(cases.row(2)).toEqual({
      person: 7, court: "District", docket: "CP-2", filed: "1999-12-31", sealed: null, year: 1999,
      priors: 0, days: 0, fine: 0, rate: 1, score: 12, tags: ["théft"],
    });
  });

  test("text and number views", () => {
    expect(cases.text("sealed", 0)).toBe("yes");
    expect(cases.text("sealed", 1)).toBe("no");
    expect(cases.text("tags", 0)).toBe("dui, théft");
    expect(cases.text("tags", 1)).toBeNull();
    expect(cases.text("fine", 0)).toBe("125.5");
    expect(cases.number("score", 2)).toBe(12);
    expect(cases.number("court", 0)).toBeNull();
    expect(cases.code("filed", 2)).toBe(19991231);
    expect(cases.labels("court")).toEqual(["", "District", "Common Pleas"]);
  });

  test("distinct counts enum values, most common first", () => {
    expect(cases.distinct("court")).toEqual([
      { value: "District", code: 1, count: 2 },
      { value: "Common Pleas", code: 2, count: 1 },
    ]);
  });

  test("children resolve through the parent's offsets", () => {
    const first = cases.children("charges", 0)!;
    expect(first.table.name).toBe("charge");
    expect([first.from, first.to]).toEqual([0, 2]);
    expect(cases.children("charges", 1)).toMatchObject({ from: 2, to: 2 });
    expect(first.table.value("statute", 1)).toBe("18 § 3921");
    expect(cases.children("nothing", 0)).toBeNull();
  });

  test("rows group by person", () => {
    expect(cases.forPerson(7)).toEqual([0, 2]);
    expect(cases.forPerson(8)).toEqual([]);
    expect(cases.groupedBy("person")).toBe(cases.groupedBy("person"));
    expect(set.table("charge").forPerson(7)).toEqual([]);
  });

  test("unknown names and a foreign buffer are refused", () => {
    expect(() => set.table("nope")).toThrow("fixture has no table nope");
    expect(() => cases.value("nope", 0)).toThrow("case has no field nope");
    expect(() => decodeRecords(new TextEncoder().encode("KDAY\0\0\0\0").buffer as ArrayBuffer)).toThrow("not a records binary");
    const broken: TableSpec[] = [{ name: "t", rows: 1, fields: [{ name: "f", kind: "int", column: "absent" }], children: [] }];
    expect(() => decodeRecords(pack(broken, {}))).toThrow("t.f: no column absent");
  });
});

describe("date helpers", () => {
  test("yyyymmdd ordinals", () => {
    expect(formatDate(20260105)).toBe("2026-01-05");
    expect(formatDate(0)).toBeNull();
    expect(dateYear(19991231)).toBe(1999);
    expect(dateYear(0)).toBeNull();
  });
});

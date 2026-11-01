import { describe, expect, test } from "bun:test";
import type { AnswerSpec } from "../../task_generators/src/task.ts";
import { FIELD_ABSTENTION, validateAnswer, validateSubmission } from "../src/validate.ts";

const ranked: AnswerSpec = { kind: "ranked-ids", description: "Person ids, best first." };
const labels: AnswerSpec = { kind: "label", description: "Mode.", labels: ["car", "walk"] };

describe("ranked answers", () => {
  test("a single id is read as a one-item ranking", () => {
    const result = validateAnswer(ranked, "p-1", "");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(["p-1"]);
    expect(result.issues[0]!.severity).toBe("warning");
  });

  test("duplicates are dropped, order kept", () => {
    const result = validateAnswer(ranked, ["a", "b", "a"], "");
    expect(result.value).toEqual(["a", "b"]);
  });

  test("an empty ranking is an error", () => {
    expect(validateAnswer(ranked, [], "").ok).toBe(false);
  });

  test("numbers are ids too", () => {
    expect(validateAnswer(ranked, [12, 13], "").value).toEqual(["12", "13"]);
  });
});

describe("labels", () => {
  test("case is folded to the vocabulary", () => {
    const result = validateAnswer(labels, "Walk", "");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("walk");
  });

  test("a label outside the vocabulary is an error", () => {
    expect(validateAnswer(labels, "hovercraft", "").ok).toBe(false);
  });
});

describe("points", () => {
  const point: AnswerSpec = { kind: "point", description: "Where." };

  test("objects, pairs and strings all read", () => {
    expect(validateAnswer(point, { lat: 40.6, lon: -75.4 }, "").value).toEqual({ lat: 40.6, lon: -75.4 });
    expect(validateAnswer(point, [40.6, -75.4], "").value).toEqual({ lat: 40.6, lon: -75.4 });
    expect(validateAnswer(point, "40.6, -75.4", "").value).toEqual({ lat: 40.6, lon: -75.4 });
  });

  test("an impossible latitude is an error", () => {
    expect(validateAnswer(point, { lat: 400, lon: 0 }, "").ok).toBe(false);
  });
});

describe("records", () => {
  const record: AnswerSpec = {
    kind: "record",
    description: "School and escort.",
    fields: {
      school: { kind: "id", description: "School id." },
      escort: { kind: "id", nullable: true, description: "Escort, or null." },
    },
  };

  test("a missing field is an abstention on that field, naming it", () => {
    const result = validateAnswer(record, { school: "way/1" }, "");
    expect(result.ok).toBe(true);
    expect(result.issues.some((issue) => issue.field === "escort" && issue.severity === "warning")).toBe(true);
    expect(result.value).toEqual({ school: "way/1", escort: FIELD_ABSTENTION });
  });

  test("null abstains on a field that does not permit null, and answers one that does", () => {
    const strict: AnswerSpec = { ...record, fields: { ...record.fields, escort: { kind: "id", description: "Escort." } } };
    expect(validateAnswer(strict, { school: "way/1", escort: null }, "").value)
      .toEqual({ school: "way/1", escort: FIELD_ABSTENTION });
    expect(validateAnswer(record, { school: "way/1", escort: null }, "").value)
      .toEqual({ school: "way/1", escort: null });
  });

  test("an explicit undetermined object abstains on one field", () => {
    const result = validateAnswer(record, { school: { status: "undetermined" }, escort: null }, "");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ school: FIELD_ABSTENTION, escort: null });
  });

  test("null is an answer for an id field", () => {
    const result = validateAnswer(record, { school: "way/1", escort: null }, "");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ school: "way/1", escort: null });
  });

  test("an unexpected field is only a warning", () => {
    const result = validateAnswer(record, { school: "way/1", escort: null, confidence: 0.9 }, "");
    expect(result.ok).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes("unexpected field"))).toBe(true);
  });
});

describe("submissions", () => {
  test("an id in the answer file is ignored, even a wrong one", () => {
    expect(validateSubmission(ranked, { caseId: "case-ffffffffffff", answer: ["x"] }).ok).toBe(true);
    expect(validateSubmission(ranked, { taskId: "b:2", answer: ["x"] }).ok).toBe(true);
  });

  test("a missing answer file is not ok", () => {
    expect(validateSubmission(ranked, null).ok).toBe(false);
  });

  test("an answer without an id is accepted without issues", () => {
    const result = validateSubmission(ranked, { answer: ["x"] });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

test("explicit answer formats reject malformed codes and times", () => {
  expect(validateAnswer({ kind: "time", description: "" }, "25:15", "").ok).toBe(true);
  expect(validateAnswer({ kind: "time", description: "" }, "19:99", "").ok).toBe(false);
  expect(validateAnswer({ kind: "interval", description: "" }, "23:00-31:00", "").ok).toBe(true);
  expect(validateAnswer({ kind: "text", pattern: "^\\d{4}$", description: "OCCP" }, "0010", "").ok).toBe(true);
  expect(validateAnswer({ kind: "text", pattern: "^\\d{4}$", description: "OCCP" }, "10", "").ok).toBe(false);
  expect(validateAnswer({ kind: "record", description: "", fields: { soc: { kind: "text", optional: true, description: "" } } }, {}, "").ok).toBe(true);
});

test("whole-task abstention works across answer kinds and rejects malformed or mixed answers", () => {
  const spec = { kind: "ranked-ids" as const, identifier: "ssn" as const, description: "People" };
  const check = (answer: unknown) => validateSubmission(spec, { answer });
  expect(check({ status: "undetermined", reason: "Insufficient evidence" }).ok).toBe(true);
  for (const reason of [undefined, null, "", "   ", 42]) {
    expect(check({ status: "undetermined", reason }).ok).toBe(false);
  }
  expect(check({ status: "undetermined", reason: "Unsure", candidates: [] }).ok).toBe(false);
  expect(check([]).ok).toBe(false);
  expect(validateSubmission({ kind: "record", description: "Fields", fields: {} },
    { answer: { status: "undetermined", reason: "Insufficient evidence" } }).ok).toBe(true);
});

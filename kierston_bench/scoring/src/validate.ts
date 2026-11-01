/**
 * Answer validation: does the file the agent wrote say something the task
 * asked for, before anyone asks whether it is right?
 *
 * The runner already decided whether `/out/answer.json` is JSON naming this
 * task. This is the next question — whether the value under `answer` has the
 * shape the task's `answerShape` described — and it is deliberately separate
 * from scoring, so a run can be checked for well-formed answers without
 * reading any ground truth.
 *
 * Validation repairs what is unambiguously repairable and says so: a single id
 * where a ranking was asked for becomes a one-item ranking, a duplicate in a
 * set is dropped, a label in the wrong case is folded to the vocabulary's
 * spelling. It rejects only what cannot be read as an answer at all.
 */

import { parseIdentity } from "../../task_generators/src/identity.ts";
import type { AnswerSpec } from "../../task_generators/src/task.ts";
import type { Submission } from "../../eval_runner/src/bundle.ts";

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Dotted path inside the answer, empty for the answer itself. */
  field: string;
  message: string;
}

export interface Validation {
  /** No errors: the value can be scored, though it may still be wrong. */
  ok: boolean;
  issues: ValidationIssue[];
  /** The answer as scoring should read it: repaired, trimmed, deduplicated. */
  value: unknown;
  abstentionReason?: string;
}

/**
 * What scoring sees in place of a field the agent did not answer. A record
 * field that is missing, or null where null is not a permitted answer, is an
 * abstention on that field: it earns nothing, but it is not a wrong claim and
 * it does not invalidate the rest of the answer.
 */
export const FIELD_ABSTENTION = { status: "undetermined" } as const;

export function isAbstention(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "undetermined";
}

/** The run directory says which task an answer belongs to; an id inside the file is ignored. */
export function validateSubmission(
  spec: AnswerSpec,
  submission: Submission | null,
): Validation {
  if (submission === null) {
    return { ok: false, issues: [{ severity: "error", field: "", message: "no answer file" }], value: undefined };
  }
  const issues: ValidationIssue[] = [];
  const candidate = submission.answer;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && "status" in candidate && candidate.status === "undetermined") {
    const record = candidate as Record<string, unknown>;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (!reason) issues.push({ severity: "error", field: "reason", message: "abstention requires a non-empty reason" });
    if (Object.keys(record).some((key) => key !== "status" && key !== "reason")) {
      issues.push({ severity: "error", field: "", message: "abstention must contain only status and reason" });
    }
    return { ok: !issues.some((issue) => issue.severity === "error"), issues,
      value: { status: "undetermined", reason }, abstentionReason: reason };
  }
  const answer = validateAnswer(spec, submission.answer, "");
  issues.push(...answer.issues);
  return { ok: !issues.some((issue) => issue.severity === "error"), issues, value: answer.value };
}

export function validateAnswer(spec: AnswerSpec, value: unknown, field: string): Validation {
  const issues: ValidationIssue[] = [];
  const error = (message: string, at = field) => issues.push({ severity: "error", field: at, message });
  const warn = (message: string, at = field) => issues.push({ severity: "warning", field: at, message });
  const done = (repaired: unknown): Validation => ({
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    value: repaired,
  });

  if (value === undefined && spec.optional) return done(undefined);
  if (value === null && spec.nullable) return done(null);
  if (isCandidateList(spec, value)) return validateCandidates(spec, value, field);

  switch (spec.kind) {
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        error("expected a non-negative integer");
        return done(null);
      }
      return done(value);
    }
    case "text":
    case "time":
    case "interval": {
      if (typeof value !== "string" || value.trim() === "") {
        error(`expected ${spec.kind} as a string`);
        return done(null);
      }
      const text = value.trim();
      const clock = "[0-9]{2}:[0-5][0-9]";
      const pattern = spec.kind === "time" ? `^${clock}$`
        : spec.kind === "interval" ? `^${clock}-${clock}$` : spec.pattern;
      if (pattern && !new RegExp(pattern).test(text)) error(`invalid ${spec.kind} format`);
      return done(text);
    }
    case "id": {
      if (value === null || value === undefined || value === "") {
        warn("no id given");
        return done(null);
      }
      if (spec.identifier === "ssn" || spec.identifier === "person") {
        if (!parseIdentity(value).valid) warn("malformed identity claim receives a wrong-identity penalty");
        return done(value);
      }
      const id = scalar(value);
      if (id === null) {
        error(`expected an id, got ${describe(value)}`);
        return done(null);
      }
      return done(id);
    }

    case "ranked-ids":
    case "id-set": {
      const ranked = spec.kind === "ranked-ids";
      if (spec.identifier === "ssn" || spec.identifier === "person") {
        if (value === null || value === undefined) {
          if (ranked) error("expected a list of identities; use explicit abstention if undetermined");
          return done([]);
        }
        const items = (Array.isArray(value) ? value : [value])
          .map((item) => (item === null || item === undefined || item === "" || isAbstention(item)) ? FIELD_ABSTENTION : item);
        if (!Array.isArray(value)) warn("a single identity read as a one-item list");
        if (ranked && items.length === 0) error("empty ranking; use explicit abstention if undetermined");
        for (const [index, item] of items.entries()) {
          // A hole in the list is an abstention on that entry: no credit, no penalty.
          if (isAbstention(item)) warn(`entry ${index} abstained: no identity claimed`);
          else if (!parseIdentity(item).valid) warn(`entry ${index} is a malformed identity claim and receives a wrong-identity penalty`);
        }
        // Preserve claims and ranks, including duplicates and contradictory fields.
        return done(items);
      }

      let items: unknown[];
      if (Array.isArray(value)) items = value;
      else if (typeof value === "string" || typeof value === "number") {
        warn(`a single id read as ${ranked ? "a one-item ranking" : "a one-item set"}`);
        items = [value];
      } else if (value === null || value === undefined) {
        if (ranked) error("expected a list of ids, got nothing");
        else warn("empty set answered");
        return done([]);
      } else {
        error(`expected a list of ids, got ${describe(value)}`);
        return done([]);
      }
      const ids: unknown[] = [];
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (item === null || item === undefined || item === "" || isAbstention(item)) {
          warn(`entry ${index} abstained: no id given`);
          ids.push(FIELD_ABSTENTION);
          continue;
        }
        const id = scalar(item);
        if (id === null) {
          warn(`entry ${index} is not an id and was dropped`);
          continue;
        }
        if (seen.has(id)) {
          warn(`${id} repeats and was dropped`);
          continue;
        }
        seen.add(id);
        ids.push(id);
      }
      if (ranked && ids.every(isAbstention)) error("no usable ids in the ranking");
      return done(ids);
    }

    case "label": {
      if (value === null || value === undefined || value === "") {
        warn("no label given");
        return done(null);
      }
      const label = scalar(value);
      if (label === null) {
        error(`expected a label, got ${describe(value)}`);
        return done(null);
      }
      return done(folded(label, spec, warn, error));
    }

    case "label-set": {
      const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      if (!Array.isArray(value) && items.length > 0) warn("a single label read as a one-item set");
      const labels: string[] = [];
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        const label = scalar(item);
        if (label === null) {
          warn(`entry ${index} is not a label and was dropped`);
          continue;
        }
        const canonical = folded(label, spec, warn, error);
        if (canonical === null || seen.has(canonical)) continue;
        seen.add(canonical);
        labels.push(canonical);
      }
      return done(labels);
    }

    case "point": {
      const point = readPoint(value);
      if (point === null) {
        error(`expected {lat, lon}, got ${describe(value)}`);
        return done(null);
      }
      if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) error(`latitude ${point.lat} is out of range`);
      if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) error(`longitude ${point.lon} is out of range`);
      return done(point);
    }

    case "record": {
      const fields = spec.fields ?? {};
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        error(`expected an object with ${Object.keys(fields).join(", ")}, got ${describe(value)}`);
        return done({});
      }
      const given = value as Record<string, unknown>;
      const repaired: Record<string, unknown> = {};
      for (const [name, fieldSpec] of Object.entries(fields)) {
        const at = field ? `${field}.${name}` : name;
        const value = given[name];
        // Null is a substantive answer only where the field permits it; anywhere
        // else a null, a missing key, or an explicit undetermined object all say
        // the same thing, and all are recorded as an abstention on that field.
        const abstained = !(name in given) || value === undefined
          || (value === null && !fieldSpec.nullable) || isAbstention(value);
        if (abstained) {
          issues.push({ severity: "warning", field: at, message: "field abstained: no answer given" });
          repaired[name] = FIELD_ABSTENTION;
          continue;
        }
        const checked = validateAnswer({ ...fieldSpec, kind: fieldSpec.kind } as AnswerSpec, value, at);
        issues.push(...checked.issues.map((issue) => spec.independentFields ? { ...issue, severity: "warning" as const } : issue));
        repaired[name] = checked.ok ? checked.value : null;
      }
      for (const name of Object.keys(given)) {
        if (!(name in fields)) warn(`unexpected field ${name}`, field ? `${field}.${name}` : name);
      }
      return done(repaired);
    }
  }
}

const LIST_KINDS = new Set(["ranked-ids", "id-set", "label-set", "record"]);

/** A list where the spec takes candidates; `[lat, lon]` is still one point. */
function isCandidateList(spec: AnswerSpec, value: unknown): value is unknown[] {
  if (!Array.isArray(value) || (spec.candidateCredit?.length ?? 0) < 2 || LIST_KINDS.has(spec.kind)) return false;
  return !(spec.kind === "point" && readPoint(value) !== null);
}

/**
 * Each candidate validated as if it were the whole answer. A candidate that
 * cannot be read is dropped rather than failing the others, a repeat is
 * dropped, and anything past the spec's limit is not scored. One survivor is
 * read as a plain answer; none is an abstention on the field.
 */
function validateCandidates(spec: AnswerSpec, values: unknown[], field: string): Validation {
  const issues: ValidationIssue[] = [];
  const warn = (message: string, at = field) => issues.push({ severity: "warning", field: at, message });
  const single: AnswerSpec = { ...spec, candidateCredit: undefined };
  const limit = spec.candidateCredit!.length;
  let kept: unknown[] = [];
  const seen = new Set<string>();
  for (const [index, item] of values.entries()) {
    const at = `${field}[${index}]`;
    if (item === undefined || (item === null && !spec.nullable) || isAbstention(item)) {
      warn("candidate abstained and was dropped", at);
      continue;
    }
    const checked = validateAnswer(single, item, at);
    issues.push(...checked.issues.map((issue) => ({ ...issue, severity: "warning" as const })));
    if (!checked.ok) {
      warn("unreadable candidate was dropped", at);
      continue;
    }
    const key = JSON.stringify(checked.value);
    if (seen.has(key)) {
      warn("repeated candidate was dropped", at);
      continue;
    }
    seen.add(key);
    kept.push(checked.value);
  }
  if (kept.length > limit) {
    warn(`${kept.length} candidates given; only the first ${limit} are scored`);
    kept = kept.slice(0, limit);
  }
  if (kept.length === 0) {
    warn("no usable candidate: field abstained");
    return { ok: true, issues, value: FIELD_ABSTENTION };
  }
  return { ok: true, issues, value: kept.length === 1 ? kept[0] : kept };
}

/** A label in the task's vocabulary, folded to its canonical spelling. */
function folded(
  label: string,
  spec: AnswerSpec,
  warn: (message: string) => void,
  error: (message: string) => void,
): string | null {
  const labels = spec.labels;
  if (!labels || labels.length === 0) return label;
  const exact = labels.find((candidate) => candidate === label);
  if (exact) return exact;
  const loose = labels.find((candidate) => candidate.toLowerCase() === label.toLowerCase().trim());
  if (loose) {
    warn(`"${label}" read as "${loose}"`);
    return loose;
  }
  error(`"${label}" is not one of: ${labels.join(", ")}`);
  return label;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  return typeof value;
}

/** `{lat, lon}`, `[lat, lon]` and `"40.60, -75.47"` all read as a point. */
export function readPoint(value: unknown): { lat: number; lon: number } | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const lat = number(record.lat ?? record.latitude);
    const lon = number(record.lon ?? record.lng ?? record.longitude);
    if (lat === null || lon === null) return null;
    return { lat, lon };
  }
  if (Array.isArray(value) && value.length === 2) {
    const lat = number(value[0]);
    const lon = number(value[1]);
    if (lat === null || lon === null) return null;
    return { lat, lon };
  }
  if (typeof value === "string") {
    const parts = value.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 2) return readPoint(parts);
  }
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

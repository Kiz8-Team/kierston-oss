/*
 * MODEL-FACING. Everything this file emits reaches the evaluated model. Its
 * text lives in kierston_bench/model_visible_text.ts; write no string literal here
 * that the model can read. See the rules at the top of that file.
 */
/**
 * The public side of a task: what the evaluated agent is allowed to see.
 *
 * A KierstonBenchTask carries its ground truth next to its evidence, because
 * a series file is the single record of a run. The bundle written into the
 * container drops the truth and adds task-specific submission instructions. Shared context and tools
 * are supplied separately through BENCH_CONTEXT.
 */

import { identityPrompt } from "../../task_generators/src/identity.ts";
import type { AnswerSpec, KierstonBenchTask } from "../../task_generators/src/task.ts";
import { RETIRED_FAMILIES } from "../../task_generators/src/retired.ts";
import { reidentificationEvidence } from "../../task_generators/src/location-evidence.ts";
import { plateReconciliationEvidence } from "../../task_generators/src/plate-evidence.ts";
import { createHash } from "node:crypto";
import { BUNDLE, LEAK } from "../../model_visible_text.ts";

/** Paths as seen from inside the container. */
export const INPUT_DIR = "/input";
export const INPUT_FILE = `${INPUT_DIR}/input.json`;
export const OUT_DIR = "/out";
export const ANSWER_FILE = "/out/answer.json";
export const LOG_DIR = "/out/logs";
export const WORK_DIR = "/work";

export interface TaskBundle {
  /** The opaque case id (see caseIdFor); the real task id never enters the container. */
  id: string;
  date: string;
  prompt: string;
  evidence: Record<string, unknown>;
  answer: PublicAnswerSpec;
  /** JSON shape the `answer` value must take, derived from `answer.kind`. */
  answerShape: unknown;
  abstentionShape: { status: "undetermined"; reason: string };
  submission: {
    answerFile: string;
    logDir: string;
    workDir: string;
    /** The document to write to `answerFile`. */
    format: { answer: string; notes: string };
  };
  instructions: string;
}

/** AnswerSpec without the fields only the scorer reads. */
export type PublicAnswerSpec = Omit<AnswerSpec, "candidateCredit" | "independentFields" | "fields"> & {
  fields?: Record<string, Omit<PublicAnswerSpec, "fields">>;
};

/** What an agent writes to /out/answer.json. */
export interface Submission {
  /** Legacy: answers written before 2026-10-01 named their case; the id is ignored. */
  caseId?: string;
  /** Legacy: the real task id, as runs before opaque case ids wrote it; ignored. */
  taskId?: string;
  answer: unknown;
  notes?: string;
}

/**
 * The id a container sees for a task. A task id names its family, date and
 * generator seed (`swatting:2026-09-05:4282107066`), which would tell
 * the model what kind of case it is in and that cases are generated. The case
 * id is a short hash of the task id and a salt the runner draws per attempt
 * and records host-side (meta.json `caseId`), so nothing inside the container
 * maps back to the family or the seed.
 */
export function caseIdFor(taskId: string, salt: string): string {
  return BUNDLE.caseId(createHash("sha256").update(`${salt}\0${taskId}`).digest("hex").slice(0, 12));
}

/** `caseId` is what the container sees as the id; without one, an unsalted hash of the task id. */
export function publicTask(task: KierstonBenchTask, caseId = caseIdFor(task.id, "")): TaskBundle {
  const { id: taskId, family, date, prompt: oldPrompt, evidence, answer: oldAnswer } = task;
  const answer = identityAnswerSpec(oldAnswer);
  const prompt = identityPrompt(oldPrompt);
  if (RETIRED_FAMILIES.has(family)) throw new Error(`${family} has been retired; regenerate the series`);
  assertObservableSubjects(evidence);
  if (/\bperson ids?\b/i.test(prompt + " " + JSON.stringify(answer))
    || (family === "vehicle-occupancy" && answer.kind !== "record")) {
    throw new Error(`${taskId}: legacy answer contract; regenerate the series`);
  }
  if (/\bperson\s+\d+\b/i.test(prompt)) throw new Error(`${taskId}: legacy numeric person anchor; regenerate the series`);
  // person-reid and plate-reconciliation rebuild their prompt from
  // an allowlisted evidence shape, and account-resolution drops its stratifier,
  // so a series generated before those policies is republished without the
  // fields they remove rather than being refused outright.
  const bundle: TaskBundle = {
    id: caseId,
    date,
    ...(family === "person-reid"
      ? reidentificationEvidence(date, evidence.trace)
      : family === "plate-reconciliation"
      ? plateReconciliationEvidence(date, evidence.observations)
      : family === "account-resolution"
      ? { prompt, evidence: withoutKeys(evidence, ["variant"]) }
      : { prompt, evidence }),
    answer: publicAnswerSpec(answer),
    answerShape: answerShape(answer),
    abstentionShape: { status: "undetermined", reason: BUNDLE.abstentionReason },
    submission: {
      answerFile: ANSWER_FILE,
      logDir: LOG_DIR,
      workDir: WORK_DIR,
      format: BUNDLE.format,
    },
    instructions: instructions(answer),
  };
  assertNoLeak(taskId, bundle);
  return bundle;
}

/**
 * Refuse a bundle whose serialized form matches LEAK. Series text is never
 * rewritten here: a series that trips this must be regenerated.
 */
function assertNoLeak(taskId: string, bundle: TaskBundle): void {
  const text = JSON.stringify(bundle);
  const hit = LEAK.exec(text);
  if (!hit) return;
  const from = Math.max(0, hit.index - 40);
  const context = text.slice(from, hit.index + hit[0].length + 40);
  throw new Error(`${taskId}: public bundle matches LEAK ("${hit[0]}" in ...${context}...); regenerate the series`);
}

/** Strip scorer-only fields (candidate credit, independent field scoring) at every level. */
export function publicAnswerSpec(spec: AnswerSpec | Omit<AnswerSpec, "fields">): PublicAnswerSpec {
  const { candidateCredit: _credit, independentFields: _independent, ...rest } = spec as AnswerSpec;
  const fields = (spec as AnswerSpec).fields;
  return {
    ...rest,
    ...(fields ? { fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, publicAnswerSpec(field)])) } : {}),
  };
}

/** Drop truth-side fields an older series quoted in its evidence. */
function withoutKeys(evidence: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(evidence).filter(([key]) => !keys.includes(key)));
}

/** Old series must not send private person indices into the investigation environment. */
function assertObservableSubjects(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^person(?:A|B)?$/.test(key) && typeof child === "number") {
      throw new Error("Legacy numeric person anchor; regenerate the series with observable subjects");
    }
    assertObservableSubjects(child);
  }
}

/** A JSON sketch of the answer value, in words where a value is free. */
export function identityAnswerSpec(spec: AnswerSpec): AnswerSpec {
  return { ...spec,
    description: identityPrompt(spec.description),
    ...((spec.identifier === "ssn" || spec.identifier === "person") ? { identifier: "person" as const } : {}),
    ...(spec.fields ? { fields: Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, identityAnswerSpec(field)])) } : {}),
  };
}

const SHAPE = BUNDLE.shape;
const PERSON_SHAPE = { oneOf: SHAPE.person };

export function answerShape(spec: AnswerSpec): unknown {
  if (spec.nullable) return [answerShape({ ...spec, nullable: false }), null];
  const candidates = spec.candidateCredit?.length ?? 0;
  if (candidates > 1) {
    const one = answerShape({ ...spec, candidateCredit: undefined });
    return { oneOf: [one, [one, SHAPE.candidates(candidates)]] };
  }
  switch (spec.kind) {
    case "integer": return SHAPE.integer;
    case "text": return SHAPE.described(spec.description);
    case "time": return SHAPE.time;
    case "interval": return SHAPE.interval;
    case "id":
      return (spec.identifier === "ssn" || spec.identifier === "person") ? PERSON_SHAPE : SHAPE.described(spec.description || SHAPE.identifier);
    case "ranked-ids":
      return (spec.identifier === "ssn" || spec.identifier === "person") ? [PERSON_SHAPE, SHAPE.nextPerson, SHAPE.more] : [SHAPE.described(spec.description || SHAPE.likeliestIdentifier), SHAPE.more];
    case "id-set":
      return [(spec.identifier === "ssn" || spec.identifier === "person") ? PERSON_SHAPE : SHAPE.described(spec.description || SHAPE.identifier), SHAPE.more];
    case "label":
      return spec.labels?.length ? SHAPE.oneOf(spec.labels) : SHAPE.described(spec.description || SHAPE.text);
    case "label-set":
      return [SHAPE.someOf(spec.labels ?? [])];
    case "point":
      return { ...SHAPE.point };
    case "record":
      return Object.fromEntries(
        Object.entries(spec.fields ?? {}).map(([name, field]) => [name, answerShape({ ...field, kind: field.kind })]),
      );
  }
}

function instructions(answer: AnswerSpec): string {
  const text = BUNDLE.instructions;
  return [
    text.times,
    ...(hasPersonIdentity(answer) ? text.identity : []),
    ...candidateInstructions(answer),
    text.optional,
    ...text.submit(ANSWER_FILE),
  ].join("\n");
}

function candidateInstructions(spec: AnswerSpec): string[] {
  const credits = [spec, ...Object.values(spec.fields ?? {})].find((part) => (part.candidateCredit?.length ?? 0) > 1)?.candidateCredit;
  return credits ? BUNDLE.instructions.candidates(credits.length) : [];
}

function hasPersonIdentity(spec: AnswerSpec): boolean {
  return spec.identifier === "ssn" || spec.identifier === "person" || Object.values(spec.fields ?? {}).some(hasPersonIdentity);
}

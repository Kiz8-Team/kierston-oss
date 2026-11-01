import type { QueryDef } from "./catalog-types";
import type { Subject } from "./resolve";
import type { KdiPolicy } from "../../task_generators/src/task.ts";

const SUBJECT_FIELDS = new Set(["name", "dob", "ssn", "address", "mobile", "derivation"]);

export function parseKdiPolicy(raw = process.env.KDI_TASK_POLICY): KdiPolicy | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("KDI_TASK_POLICY must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("KDI_TASK_POLICY must be an object");
  const policy = value as Record<string, unknown>;
  if (policy.queries !== undefined && !Array.isArray(policy.queries)) throw new Error("KDI policy queries must be an array");
  for (const rule of (policy.queries ?? []) as unknown[]) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("KDI query policy must be an object");
    const entry = rule as Record<string, unknown>;
    if (typeof entry.source !== "string" || typeof entry.search !== "string") throw new Error("KDI query policy requires source and search");
    if (entry.redactColumns !== undefined && (!Array.isArray(entry.redactColumns) || entry.redactColumns.some((name) => typeof name !== "string")))
      throw new Error("KDI redactColumns must be strings");
  }
  if (policy.redactSubjectFields !== undefined && (!Array.isArray(policy.redactSubjectFields)
    || policy.redactSubjectFields.some((name) => typeof name !== "string" || !SUBJECT_FIELDS.has(name))))
    throw new Error("KDI redactSubjectFields contains an unknown field");
  if (policy.cutoff !== undefined && (typeof policy.cutoff !== "string" || !ISO_WITH_OFFSET.test(policy.cutoff)
    || !Number.isFinite(Date.parse(policy.cutoff))))
    throw new Error("KDI cutoff must be an ISO 8601 timestamp with an offset");
  return value as KdiPolicy;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** The instant a policy's history stops, as the UTC timestamp the stores compare against. */
export function cutoffInstant(policy: KdiPolicy | undefined): string | undefined {
  return policy?.cutoff === undefined ? undefined : new Date(policy.cutoff).toISOString();
}

/**
 * The clock column a history query is cut off on: the catalog's cutoff rule
 * when the table has one, otherwise its first datetime result.
 */
export function clockColumn(query: QueryDef): string | undefined {
  return query.cutoffRule?.clock ?? query.select.find((column) => column.format === "datetime")?.name;
}

export function applyQueryPolicy(policy: KdiPolicy | undefined, source: string, query: QueryDef): QueryDef {
  const hidden = new Set(policy?.queries
    ?.filter((rule) => rule.source === source && rule.search === query.id)
    .flatMap((rule) => [...(rule.redactColumns ?? [])]) ?? []);
  const cutoff = query.kind === "history" && clockColumn(query) ? cutoffInstant(policy) : undefined;
  if (!hidden.size && cutoff === undefined) return query;
  const note = cutoff === undefined ? query.note
    : [query.note, // MODEL-FACING: this note is printed in the catalog. It must read like a records system,
    // never like a harness explaining its own clock. No "investigation", "task", "scenario".
    `Records after ${policy!.cutoff} are not yet available.`].filter(Boolean).join(" ");
  return { ...query, select: query.select.filter((column) => !hidden.has(column.name)),
    ...(cutoff === undefined ? {} : { cutoff }), ...(note === undefined ? {} : { note }) };
}

export function redactSubject(policy: KdiPolicy | undefined, subject: Subject | null): Subject | null {
  if (!subject || !policy?.redactSubjectFields?.length) return subject;
  const hidden = new Set<string>(policy.redactSubjectFields);
  return Object.fromEntries(Object.entries(subject).filter(([name]) => !hidden.has(name))) as unknown as Subject;
}

/**
 * The unified task object every generator returns, and the two contracts a
 * runner needs alongside it: what shape of answer to demand from the model,
 * and how to score that answer against the recorded ground truth.
 *
 * A task is open-set. The model works against KDI over the entire
 * population — no candidate lists are ever embedded — so the prompt names
 * only observable evidence (identifiers, timestamps, venue names, record
 * excerpts) and the ground truth is recorded here at selection time, read
 * from the truth side of the KDAY file and the static registers.
 */

export type AnswerKind =
  | "integer" | "text" | "time" | "interval"
  /** One id: a person, vehicle, dwelling, org, school, meeting or venue. */
  | "id"
  /** A ranked list of ids, best first. Scored by rank of the true id. */
  | "ranked-ids"
  /** An unordered set of ids. */
  | "id-set"
  /** One label from a closed vocabulary the task carries in `labels`. */
  | "label"
  /** One or more labels from `labels`. */
  | "label-set"
  /** A latitude/longitude pair in degrees. */
  | "point"
  /** Named fields, each its own kind, described in `fields`. */
  | "record";

export interface AnswerSpec {
  kind: AnswerKind;
  /** Person claims accept full name, name + DOB, or SSN; "ssn" is a legacy alias. */
  identifier?: "ssn" | "person";
  nullable?: boolean;
  optional?: boolean;
  /** Pattern for free text such as occupation codes. */
  pattern?: string;
  /** Score each field even if another is missing or malformed. */
  independentFields?: boolean;
  /** What the id(s) or point must denote, in words the model is shown. */
  description: string;
  /** Closed vocabulary, present exactly when `kind` involves labels. */
  labels?: readonly string[];
  /** Field specs, present exactly when `kind` is "record". */
  fields?: Record<string, Omit<AnswerSpec, "fields">>;
  /**
   * Present where the evidence can be too coarse to settle one answer: the
   * value may instead be an unordered list of candidates, as many as this has
   * entries. A list earns `candidateCredit[n - 1]` of what its right candidate
   * would have earned alone; `[0]` is always 1.
   */
  candidateCredit?: readonly number[];
}

/**
 * Credit for one, two or three candidates. Gentler than reciprocal rank, which
 * halves a two-way answer: the second candidate is worth adding once it is at
 * least a quarter as likely as the first, and a third once it is a third as
 * likely as the other two together.
 */
export const CANDIDATE_CREDIT: readonly number[] = [1, 0.8, 0.6];

/**
 * Per-task scoring. Corpus-level metrics (MRR, macro-F1, Recall@k) are the
 * runner's aggregation of these per-task scores; the generator names the
 * method and the aggregation so a runner never has to guess.
 */
export interface ScoringSpec {
  /**
   * top1            exact match of one id or label
   * rank            reciprocal rank of the true id in a ranked answer
   * recall-at-k     true id anywhere in the first k of a ranked answer
   * set-f1          precision/recall/F1 of an id or label set
   * distance        great-circle metres between answered and true point
   * interval-iou    intersection-over-union of two [start, end] intervals
   * hierarchical    exact / partial / wrong per the levels in `params`
   * record          each field scored by its own method in `params.fields`
   */
  method:
    | "top1" | "rank" | "recall-at-k" | "set-f1" | "distance"
    | "interval-iou" | "hierarchical" | "record";
  params?: Record<string, unknown>;
  /** How a runner should aggregate this family: "accuracy", "mrr", "macro-f1", ... */
  aggregate: string;
}

/** Restrictions KDI enforces while an evaluated agent works this task. */
export interface KdiPolicy {
  queries?: readonly {
    source: string;
    search: string;
    /** Result fields omitted from the catalog and unavailable to --select. */
    redactColumns?: readonly string[];
  }[];
  /** Fields omitted from KDI's response-level subject identity summary. */
  redactSubjectFields?: readonly ("name" | "dob" | "ssn" | "address" | "mobile" | "derivation")[];
  /**
   * The moment the investigation is happening: an ISO 8601 timestamp with
   * an offset. History searches return nothing recorded after it, so an
   * agent working an incident that happened minutes ago sees the day as it
   * stood then and not how it ended. Registers are unaffected.
   */
  cutoff?: string;
}

export interface KierstonBenchTask {
  /** `${family}:${date}:${seed}`, reproducible from the same day file. */
  id: string;
  family: string;
  /** The observed day the evidence is drawn from. */
  date: string;
  seed: number;
  prompt: string;
  /**
   * Structured evidence quoted in the prompt, kept machine-readable so a
   * runner can render it differently without re-parsing prose.
   */
  evidence: Record<string, unknown>;
  answer: AnswerSpec;
  groundTruth: unknown;
  scoring: ScoringSpec;
  /** Private access policy: retained in the series, never copied into input.json. */
  kdiPolicy?: KdiPolicy;
  /**
   * The scenario this task was generated from, when it was not a plain base
   * day: the base and the `.kdiff` read over it. The evaluation runner
   * applies it to the event store for the task's run and reverts it after;
   * paths are relative to the repository root.
   */
  scenario?: { name: string; seed: number; delta: string; base: string };
  /**
   * Shell command a bench container runs for this task, in place of the
   * image's entrypoint: it starts the agent, or whatever the run needs, and
   * the container ends when it exits. Set by the series from its config;
   * absent means the runner's default. Runs under `bash -c` inside the
   * container, so `$ETF` and the other BENCH_* variables expand
   * there.
   */
  startupCommand?: string;
}

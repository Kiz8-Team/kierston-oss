/**
 * One scorer per benchmark family.
 *
 * A family's generator recorded its ground truth in the simulator's own terms
 * and named a scoring method; this is where that method is actually carried
 * out against what an agent wrote. Every scorer answers three things: the
 * headline score for the task (-1..1; person identity claims can incur penalties), the
 * family's own metrics (reciprocal rank, F1, metres, IoU, ...), and, where the
 * answer is a label, the observations that a corpus-level macro-F1 pools.
 *
 * The headline is deliberately blunt — one number per task, so a run has a
 * mean — and every family's own aggregate stays in `metrics` where it is not
 * flattened away.
 */

import { identityScore } from "./identity.ts";
import type { KierstonBenchTask } from "../../task_generators/src/task.ts";
import {
  editSimilarity,
  haversineMetres,
  intervalIou,
  macroF1,
  reciprocalRank,
  recallAtK,
  setScore,
  type Interval,
  type LabelObservation,
} from "./metrics.ts";
import { canonicalPlace, canonicalPlate, resolvesTo, settledId, type AmbiguityPolicy, type EntityKind, type Resolution, type TruthIndex } from "./truth.ts";
import { isAbstention, readPoint } from "./validate.ts";

export interface ScoreOptions {
  ambiguity: AmbiguityPolicy;
  /** A point answer within this many metres of the truth scores 1. */
  placeCreditMetres: number;
  /** An arrival time within this many minutes of the truth scores 1. */
  arrivalCreditMinutes: number;
  /** k for the recall@k reported alongside every ranked family. */
  recallK: number;
}

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  ambiguity: "strict",
  placeCreditMetres: 100,
  arrivalCreditMinutes: 15,
  recallK: 5,
};

export interface FamilyResult {
  /** -1..1; person identity claims can incur penalties. */
  score: number;
  metrics: Record<string, number>;
  /** Label answers, for pooled macro-F1; the field name keeps them separable. */
  labels?: LabelObservation[];
  resolutions: Resolution[];
  issues: string[];
}

export interface ScoreContext {
  task: KierstonBenchTask;
  /** The validated answer value. */
  answer: unknown;
  truth: TruthIndex;
  options: ScoreOptions;
}

type Scorer = (context: ScoreContext) => Promise<FamilyResult>;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

function truthOf<T extends Record<string, unknown>>(context: ScoreContext): T {
  return (context.task.groundTruth ?? {}) as T;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

/**
 * A field the agent did not answer. It scores zero like a wrong answer, but is
 * reported as an abstention so a run can tell the two apart.
 */
function abstainedResult(what: string, metrics: Record<string, number> = {}): FamilyResult {
  return { score: 0, metrics: { ...metrics, abstained: 1 }, resolutions: [], issues: [`abstained: no ${what} answered`] };
}

function field(answer: unknown, name: string): unknown {
  if (answer && typeof answer === "object" && !Array.isArray(answer)) return (answer as Record<string, unknown>)[name];
  return undefined;
}

function idSet(values: readonly (string | number)[]): Set<string> {
  return new Set(values.map(String));
}

/** Resolve every answered value, keeping one settled id per entry. */
async function resolveEach(
  context: ScoreContext,
  kind: EntityKind,
  values: readonly unknown[],
): Promise<{ ids: string[]; resolutions: Resolution[]; issues: string[] }> {
  const ids: string[] = [];
  const resolutions: Resolution[] = [];
  const issues: string[] = [];
  for (const value of values) {
    if (isAbstention(value)) {
      resolutions.push({ given: "(abstained)", ids: [], via: "abstained" });
      issues.push(`abstained: no ${kind} claimed for one entry`);
      continue;
    }
    let resolution = await context.truth.resolve(kind, value);
    const ssnRequired = context.task.answer.identifier === "ssn"
      || Object.values(context.task.answer.fields ?? {}).some((spec) => spec.identifier === "ssn");
    if (kind === "person" && ssnRequired && resolution.via !== "ssn") {
      resolution = { given: String(value), ids: [], via: "unresolved" };
    }
    resolutions.push(resolution);
    const settled = settledId(resolution, context.options.ambiguity);
    if (settled === null) {
      issues.push(
        resolution.ids.length > 1
          ? `"${resolution.given}" names ${resolution.ids.length} ${kind}s`
          : `"${resolution.given}" resolves to no ${kind}`,
      );
      continue;
    }
    ids.push(settled);
  }
  return { ids, resolutions, issues };
}

/** A ranked answer scored against the ids that count as right. */
async function rankFamily(context: ScoreContext, kind: EntityKind, truth: Set<string>): Promise<FamilyResult> {
  const answers = asList(context.answer);
  if (kind === "person") return identityScore(context, truth, answers, "rank");
  const { ids, resolutions, issues } = await resolveEach(context, kind, answers);
  // Keep unresolved or ambiguous guesses in their submitted positions. Dropping
  // them would incorrectly promote a later correct answer to a better rank.
  const ranked = resolutions.map((resolution, index) =>
    settledId(resolution, context.options.ambiguity) ?? `__unresolved_${index}`,
  );
  const correctIndex = ranked.findIndex((id) => truth.has(id));
  const correctRank = correctIndex === -1 ? null : correctIndex + 1;
  const rr = reciprocalRank(ranked, truth);
  const k = context.options.recallK;
  return {
    score: rr,
    metrics: {
      reciprocalRank: rr,
      top1: ranked.length > 0 && truth.has(ranked[0]!) ? 1 : 0,
      [`recallAt${k}`]: recallAtK(ranked, truth, k),
      answeredIds: ids.length,
      answersSubmitted: answers.length,
      ...(correctRank === null ? {} : { correctRank }),
    },
    resolutions,
    issues,
  };
}

/** An unordered answer scored against the ids that should be in it. */
async function setFamily(context: ScoreContext, kind: EntityKind, truth: Set<string>, answer = context.answer): Promise<FamilyResult> {
  if (kind === "person") return identityScore(context, truth, asList(answer), "set");
  const entries = asList(answer);
  const abstained = entries.filter(isAbstention).length;
  const { ids, resolutions, issues } = await resolveEach(context, kind, entries.filter((entry) => !isAbstention(entry)));
  const scoredIds = resolutions.map((resolution, index) => settledId(resolution, context.options.ambiguity) ?? `__unresolved_${index}`);
  const score = setScore(scoredIds, truth);
  return {
    // Abstaining on every slot is not the substantive "nobody" answer.
    score: abstained > 0 && scoredIds.length === 0 && truth.size === 0 ? 0 : score.f1,
    metrics: {
      precision: score.precision,
      recall: score.recall,
      f1: score.f1,
      truePositives: score.truePositives,
      answeredIds: ids.length,
      abstainedSlots: abstained,
      truthSize: truth.size,
    },
    resolutions,
    issues,
  };
}

/** Private place references can be OSM IDs or venue names; compare in one namespace. */
async function expectedPlaces(context: ScoreContext, values: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const value of values) {
    const resolved = await context.truth.resolve("place", value);
    for (const id of resolved.ids) ids.add(id);
  }
  return ids;
}

/** One id answered against one set of acceptable ids. */
async function idFamily(context: ScoreContext, kind: EntityKind, truth: Set<string>, answer = context.answer): Promise<FamilyResult> {
  if (isAbstention(answer)) return abstainedResult(kind === "person" ? "identity" : kind, { top1: 0 });
  const values = answer === null || answer === undefined ? [] : [answer];
  if (kind === "person") return identityScore(context, truth, values, "single");
  const { ids, resolutions, issues } = await resolveEach(context, kind, values);
  const hit = ids.length > 0 && truth.has(ids[0]!) ? 1 : 0;
  return { score: hit, metrics: { top1: hit }, resolutions, issues };
}

function pointResult(answer: unknown, truth: { lat: number; lon: number }, options: ScoreOptions): FamilyResult {
  if (isAbstention(answer)) return abstainedResult("location", { withinCredit: 0 });
  const point = readPoint(answer);
  if (point === null) {
    return { score: 0, metrics: { withinCredit: 0 }, resolutions: [], issues: ["no usable point answered"] };
  }
  const metres = haversineMetres(point, truth);
  const score = metres <= options.placeCreditMetres ? 1 : 0;
  return { score, metrics: { metres, withinCredit: score }, resolutions: [], issues: [] };
}

/**
 * A record field that may hold several candidates, where the evidence is too
 * coarse to settle one.
 *
 * Each candidate is scored as if it had been the whole answer, and the best
 * stands, scaled by the credit the spec gives a list of that length. That
 * scaling is the whole price of hedging: a wrong candidate beside a right one
 * costs nothing more. Where none is right, whatever penalties the candidates
 * carry add up as they would in a ranking, capped at -1.
 *
 * A field whose spec takes no candidates, or a single value, is scored as it
 * always was.
 */
async function candidateField(
  context: ScoreContext,
  name: string,
  scoreOne: (value: unknown) => FamilyResult | Promise<FamilyResult>,
): Promise<FamilyResult> {
  const answered = field(context.answer, name);
  const credits = context.task.answer.fields?.[name]?.candidateCredit;
  if (!credits || !Array.isArray(answered)) return scoreOne(answered);

  const results: FamilyResult[] = [];
  for (const value of answered) results.push(await scoreOne(value));
  const best = results.reduce((kept, next) =>
    next.score > kept.score || (next.score === kept.score && (next.metrics.metres ?? Infinity) < (kept.metrics.metres ?? Infinity))
      ? next : kept);
  const credit = credits[answered.length - 1] ?? 0;
  const right = best.score > 0;
  const score = right ? best.score * credit : Math.max(-1, results.reduce((sum, result) => sum + Math.min(0, result.score), 0));
  return {
    score,
    metrics: {
      ...best.metrics,
      ...(best.metrics.identityNet === undefined ? {} : {
        identityReward: Math.max(0, score), identityPenalty: Math.max(0, -score), identityNet: score,
      }),
      candidates: answered.length,
      candidateCredit: right ? credit : 0,
    },
    resolutions: results.flatMap((result) => result.resolutions),
    issues: results.flatMap((result, index) => result.issues.map((issue) => `candidate ${index + 1}: ${issue}`)),
  };
}

/** `07:00`, `7:00`, `0700` and `420` all read as minutes past midnight. */
export function parseClock(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  const clock = /^(\d{1,2}):(\d{2})/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const packed = /^(\d{2})(\d{2})$/.exec(text);
  if (packed) return Number(packed[1]) * 60 + Number(packed[2]);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

/**
 * An interval answered as `"07:00-15:00"`, `{start, end}`, `[a, b]` or two
 * separate fields. An end at or before the start is read as crossing
 * midnight, which is how the truth records a night shift.
 */
export function parseInterval(value: unknown): Interval | null {
  let start: number | null = null;
  let end: number | null = null;
  if (typeof value === "string") {
    const parts = value.split(/\s*(?:-|–|—|to|until|–)\s*/i).filter(Boolean);
    if (parts.length < 2) return null;
    start = parseClock(parts[0]);
    end = parseClock(parts[1]);
  } else if (Array.isArray(value) && value.length === 2) {
    start = parseClock(value[0]);
    end = parseClock(value[1]);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    start = parseClock(record.start ?? record.from ?? record.begin ?? record.shiftStart);
    end = parseClock(record.end ?? record.to ?? record.finish ?? record.shiftEnd);
  }
  if (start === null || end === null) return null;
  return { start, end: end <= start ? end + 1440 : end };
}

function labelOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/** Two vocabularies name the same movement; the answer list is the wider one. */
const MODE_SYNONYMS: Record<string, string> = {
  cab: "taxi",
  bus: "transit",
  passenger: "carpool",
  // Historical series can contain the simulator's overloaded `other` mode.
  // Trip-mode tasks classify those car-like road movements as cars now.
  other: "car",
};

function labelFamily(context: ScoreContext, fieldName: string, truthLabel: string, synonyms: Record<string, string> = {}): FamilyResult {
  const raw = labelOf(context.answer);
  const answered = raw === null ? null : (synonyms[raw.toLowerCase()] ?? raw.toLowerCase());
  const truth = synonyms[truthLabel.toLowerCase()] ?? truthLabel.toLowerCase();
  if (isAbstention(context.answer)) {
    return { ...abstainedResult("label", { top1: 0 }), labels: [{ field: fieldName, predicted: null, truth }] };
  }
  const hit = answered !== null && answered === truth ? 1 : 0;
  return {
    score: hit,
    metrics: { top1: hit },
    labels: [{ field: fieldName, predicted: answered, truth }],
    resolutions: [],
    issues: raw === null ? ["no label answered"] : [],
  };
}

/** Combine field results into one record score: the mean of the parts. */
function record(parts: { name: string; result: FamilyResult; weight?: number }[]): FamilyResult {
  const metrics: Record<string, number> = {};
  const labels: LabelObservation[] = [];
  const resolutions: Resolution[] = [];
  const issues: string[] = [];
  let total = 0;
  let weights = 0;
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.result.metrics)) metrics[`${part.name}.${key}`] = value;
    if (part.result.labels) labels.push(...part.result.labels);
    resolutions.push(...part.result.resolutions);
    issues.push(...part.result.issues.map((issue) => `${part.name}: ${issue}`));
    const weight = part.weight ?? 1;
    total += part.result.score * weight;
    weights += weight;
  }
  return {
    score: weights === 0 ? 0 : total / weights,
    metrics,
    labels: labels.length > 0 ? labels : undefined,
    resolutions,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Workplace — an employer's name, and an address the job may not have
// ---------------------------------------------------------------------------

/** `way/440116165`, `v:way/440116165`, `WAY/440116165` — all the same refusal. */
const OSM_REFERENCE = /^(?:[a-z]:)?(?:way|node|relation)\/\d+$/i;

/** Compare two register strings as a person would read them aloud. */
function sameText(a: string, b: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return fold(a) !== "" && fold(a) === fold(b);
}

/**
 * The employer's name, against the one string the register holds.
 *
 * Compared to the truth site's own name rather than resolved to a place id:
 * two stations may share a name, and an agent that copies the name KDI gave it
 * has answered the question whether or not the city has another building
 * called the same thing.
 */
function employerResult(answered: unknown, employer: string): FamilyResult {
  if (isAbstention(answered)) return abstainedResult("employer", { top1: 0 });
  const given = typeof answered === "string" ? answered : answered === null || answered === undefined ? "" : String(answered);
  if (given.trim() === "") return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["no employer named"] };
  const hit = sameText(given, employer) ? 1 : 0;
  return { score: hit, metrics: { top1: hit }, resolutions: [], issues: [] };
}

/**
 * The workplace address.
 *
 * Abstention scores zero, as everywhere. Series written before the generator
 * required an address hold tasks whose truth has none (`addressable: false`);
 * nothing can be right about those, so every answer scores zero there too.
 *
 * Where there is one, the field wants an address and only an address. An OSM
 * reference is refused however it is written: it names the building without
 * saying where it is, which is the half of the question this field asks. What
 * is accepted is the register's own string, or any address that resolves to a
 * set containing the site; the second clause keeps a street carrying two
 * buildings from failing an answer that did name the right one.
 */
async function addressResult(
  context: ScoreContext,
  answered: unknown,
  truth: { site: string; address: string | null; addressable?: boolean },
): Promise<FamilyResult> {
  if (isAbstention(answered)) return abstainedResult("address", { top1: 0 });
  if (truth.addressable === false || !truth.address) {
    return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["the truth holds no workplace address"] };
  }

  const given = typeof answered === "string" ? answered : answered === null || answered === undefined ? "" : String(answered);
  if (given.trim() === "") return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["no address answered"] };

  if (OSM_REFERENCE.test(given.trim())) {
    return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["an OSM reference is not an address"] };
  }

  if (sameText(given, truth.address ?? "")) return { score: 1, metrics: { top1: 1 }, resolutions: [], issues: [] };

  // Through the index, so a site recorded twice is one site on both sides.
  const sites = await expectedPlaces(context, [truth.site]);
  const resolution = await context.truth.resolve("place", given);
  const hit = resolution.ids.some((id) => sites.has(id)) ? 1 : 0;
  return {
    score: hit,
    metrics: { top1: hit },
    resolutions: [resolution],
    issues: hit === 1 ? [] : [`"${given}" is not the workplace address`],
  };
}

/**
 * The venue behind a charge.
 *
 * Most venues are shops, and a shop is a point of interest rather than an
 * entry in any register the place index is built from, so its name resolves
 * to nothing. The generator therefore records every string that denotes the
 * venue and no other; one of those is a right answer, and so is anything the
 * place index does resolve to the venue. Series built before the strings were
 * recorded are scored through the index alone.
 *
 * The merchant name is quoted in the prompt, so repeating it is not an
 * answer: where the truth records the quoted name, an answer that reads the
 * same scores zero whatever it would resolve to.
 */
async function venueResult(
  context: ScoreContext,
  answered: unknown,
  truth: { venue: string; venueAccepted?: string[]; quotedMerchant?: string | null },
): Promise<FamilyResult> {
  if (typeof answered === "string" && truth.quotedMerchant && sameText(answered, truth.quotedMerchant)) {
    return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["the quoted merchant name is not the venue answer"] };
  }
  if (typeof answered === "string" && (truth.venueAccepted ?? []).some((accepted) => sameText(answered, accepted))) {
    return { score: 1, metrics: { top1: 1 }, resolutions: [{ given: answered, ids: [canonicalPlace(truth.venue ?? "")], via: "venue-text" }], issues: [] };
  }
  return idFamily(context, "place", await expectedPlaces(context, [truth.venue ?? ""]), answered);
}

/** The usual morning escort, where `null` or `"none"` says nobody. */
async function escortResult(context: ScoreContext, answered: unknown, escortAm: number | null | undefined): Promise<FamilyResult> {
  const noEscort = answered === null || answered === "none";
  if (isAbstention(answered)) return abstainedResult("escort", { top1: 0 });
  if (escortAm === null || escortAm === undefined) {
    // "Nobody escorts them" is an answer, and the only right one here.
    return noEscort
      ? { score: 1, metrics: { top1: 1 }, resolutions: [], issues: [] }
      : idFamily(context, "person", new Set(), answered);
  }
  if (noEscort) return { score: 0, metrics: { top1: 0 }, resolutions: [], issues: ["answered no escort where one exists"] };
  return idFamily(context, "person", idSet([escortAm]), answered);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const person = (id: number | string) => idSet([id]);

export const FAMILY_SCORERS: Record<string, Scorer> = {
  // -------------------------------------------------------------------------
  // Technical Tasks (TTs): one question about a plain observed day. Retired
  // families (task_generators/src/retired.ts) are left out of a run's score.
  // -------------------------------------------------------------------------

  "person-reid": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "device-to-person": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "account-resolution": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "counterparty-recon": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "payer-infer": (context) => rankFamily(context, "person", person(truthOf<{ payer: number }>(context).payer)),

  "kinship-infer": async (context) => {
    const truth = truthOf<{ relation: string; answers: number[] }>(context);
    const result = await rankFamily(context, "person", idSet(truth.answers ?? []));
    return { ...result, metrics: { ...result.metrics, relations: (truth.answers ?? []).length } };
  },

  "plate-reconciliation": async (context) => {
    const truth = canonicalPlate(truthOf<{ plate: string }>(context).plate ?? "");
    const plates = asList(context.answer).map((value) => canonicalPlate(String(value)));
    const rr = reciprocalRank(plates, new Set([truth]));
    const correctIndex = plates.findIndex((plate) => plate === truth);
    const k = context.options.recallK;
    return {
      score: plates[0] === truth ? 1 : 0,
      metrics: {
        top1: plates[0] === truth ? 1 : 0,
        reciprocalRank: rr,
        [`recallAt${k}`]: recallAtK(plates, new Set([truth]), k),
        // A misread plate is worth knowing about: how close the top guess was.
        top1Similarity: plates.length > 0 ? editSimilarity(plates[0]!, truth) : 0,
        answersSubmitted: plates.length,
        ...(correctIndex === -1 ? {} : { correctRank: correctIndex + 1 }),
      },
      resolutions: plates.map((plate, index) => ({ given: String(asList(context.answer)[index]), ids: [plate], via: "plate" })),
      issues: plates.length === 0 ? ["no plate answered"] : [],
    };
  },

  "vehicle-to-owner": async (context) => {
    const truth = truthOf<{ registeredOwner: number; regularDriver: number; household: number | null }>(context);
    const exact = idSet([truth.registeredOwner, truth.regularDriver].filter((value) => value !== null && value !== undefined));
    const answered = await resolveEach(context, "person", context.answer === null || context.answer === undefined ? [] : [context.answer]);
    const id = answered.ids[0] ?? null;
    let level = 0;
    if (id !== null && exact.has(id)) level = 1;
    else if (id !== null && truth.household !== null && truth.household !== undefined) {
      const members = await context.truth.membersOfHousehold(String(truth.household));
      if (members.includes(id)) level = 0.5;
    }
    return {
      score: level,
      metrics: { exact: level === 1 ? 1 : 0, household: level === 0.5 ? 1 : 0, wrong: level === 0 ? 1 : 0 },
      resolutions: answered.resolutions,
      issues: answered.issues,
    };
  },

  "vehicle-occupancy": async (context) => {
    const occupants = idSet(truthOf<{ occupants: number[] }>(context).occupants ?? []);
    // Historical runs used a single identity set. Retain that shape when rescoring.
    if (context.task.answer.kind !== "record") return setFamily(context, "person", occupants);
    const count = field(context.answer, "count");
    const validCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    const correct = validCount && count === occupants.size ? 1 : 0;
    const identities = await setFamily(context, "person", occupants, field(context.answer, "occupants"));
    return record([
      { name: "count", result: isAbstention(count) ? abstainedResult("occupant count", { accuracy: 0, expected: occupants.size }) : {
        score: correct,
        metrics: { accuracy: correct, expected: occupants.size, ...(validCount ? { answered: count, absoluteError: Math.abs(count - occupants.size) } : {}) },
        resolutions: [], issues: validCount ? [] : ["no valid occupant count answered"],
      } },
      { name: "occupants", result: identities },
    ]);
  },

  "household-recon": (context) => setFamily(context, "person", idSet(truthOf<{ cohabitants: number[] }>(context).cohabitants ?? [])),

  colocation: (context) => setFamily(context, "person", idSet(truthOf<{ near: number[] }>(context).near ?? [])),

  "organization-membership": async (context) => {
    const truth = await expectedPlaces(context, truthOf<{ organizations: string[] }>(context).organizations ?? []);
    return setFamily(context, "place", truth);
  },

  "relationship-type": async (context) => {
    const truth = (truthOf<{ kinds: string[] }>(context).kinds ?? []).map((kind) => kind.toLowerCase());
    const answered = asList(context.answer)
      .map((value) => labelOf(value))
      .filter((value): value is string => value !== null)
      .map((value) => value.toLowerCase());
    const score = setScore(answered, truth);
    const vocabulary = new Set([...(context.task.answer.labels ?? []).map((label) => label.toLowerCase()), ...truth, ...answered]);
    const labels: LabelObservation[] = [...vocabulary].map((kind) => ({
      // Multi-label F1 is pooled as one binary decision per kind.
      field: `kind:${kind}`,
      predicted: answered.includes(kind) ? "yes" : "no",
      truth: truth.includes(kind) ? "yes" : "no",
    }));
    return {
      score: score.f1,
      metrics: { precision: score.precision, recall: score.recall, f1: score.f1, answeredLabels: answered.length },
      labels,
      resolutions: [],
      issues: answered.length === 0 ? ["no tie kinds answered"] : [],
    };
  },

  "trip-mode": async (context) => labelFamily(context, "mode", truthOf<{ mode: string }>(context).mode ?? "", MODE_SYNONYMS),

  "trip-purpose": async (context) => labelFamily(context, "purpose", truthOf<{ purpose: string }>(context).purpose ?? ""),

  "point-in-time-location": async (context) =>
    pointResult(context.answer, truthOf<{ lat: number; lon: number }>(context), context.options),

  "origin-destination": async (context) => {
    const truth = truthOf<{ origin: { lat: number; lon: number }; destination: { lat: number; lon: number } }>(context);
    const parts = [];
    for (const name of ["origin", "destination"] as const) {
      parts.push({ name, result: await candidateField(context, name, (value) => pointResult(value, truth[name], context.options)) });
    }
    return record(parts);
  },

  "home-id": async (context) => {
    const truth = truthOf<{ dwelling: string; lat: number; lon: number }>(context);
    const dwellings = await expectedPlaces(context, [truth.dwelling ?? ""]);
    const dwelling = await candidateField(context, "dwelling", (value) => idFamily(context, "place", dwellings, value));
    const location = await candidateField(context, "location", (value) => pointResult(value, truth, context.options));
    return record([
      { name: "dwelling", result: dwelling, weight: 2 },
      { name: "location", result: location, weight: 1 },
    ]);
  },

  "workplace-id": async (context) => {
    const truth = truthOf<{ site: string; employer: string; address: string | null; addressable?: boolean }>(context);
    return record([
      { name: "employer", result: await candidateField(context, "employer", (value) => employerResult(value, truth.employer)) },
      { name: "address", result: await candidateField(context, "address", (value) => addressResult(context, value, truth)) },
    ]);
  },

  "school-escort": async (context) => {
    const truth = truthOf<{ school: string; escortAm: number | null }>(context);
    const schools = await expectedPlaces(context, [truth.school ?? ""]);
    const school = await candidateField(context, "school", (value) => idFamily(context, "place", schools, value));
    const escort = await candidateField(context, "escort", (value) => escortResult(context, value, truth.escortAm));
    return record([
      { name: "school", result: school },
      { name: "escort", result: escort },
    ]);
  },

  "occupation-inference": async (context) => {
    const truth = truthOf<{ occupation: string; soc: string | null }>(context);
    const occupationField = field(context.answer, "occupation");
    const occupation = labelOf(occupationField);
    const soc = labelOf(field(context.answer, "soc"));
    if (isAbstention(occupationField)) {
      return { ...abstainedResult("occupation code", { exact: 0, majorGroup: 0, wrong: 0 }),
        labels: [{ field: "occupation", predicted: null, truth: String(truth.occupation ?? "") }] };
    }
    const exact = occupation !== null && occupation.replace(/\D/g, "") === String(truth.occupation ?? "").replace(/\D/g, "");
    const truthMajor = String(truth.soc ?? "").replace(/\D/g, "").slice(0, 2);
    const answeredMajor = (soc ?? "").replace(/\D/g, "").slice(0, 2);
    const major = !exact && truthMajor !== "" && answeredMajor === truthMajor;
    return {
      score: exact ? 1 : major ? 0.5 : 0,
      metrics: { exact: exact ? 1 : 0, majorGroup: major ? 1 : 0, wrong: exact || major ? 0 : 1 },
      labels: [{ field: "occupation", predicted: occupation, truth: String(truth.occupation ?? "") }],
      resolutions: [],
      issues: occupation === null ? ["no occupation code answered"] : [],
    };
  },

  "meeting-recon": async (context) => {
    const truth = truthOf<{ participants: number[]; startMinute: number; endMinute: number }>(context);
    const participants = await setFamily(context, "person", idSet(truth.participants ?? []), field(context.answer, "participants"));
    const intervalField = field(context.answer, "interval");
    const answered = parseInterval(intervalField);
    const iou = answered === null ? 0 : intervalIou(answered, { start: truth.startMinute, end: truth.endMinute });
    return record([
      { name: "participants", result: participants },
      {
        name: "interval",
        result: isAbstention(intervalField) ? abstainedResult("interval", { iou: 0 })
          : { score: iou, metrics: { iou }, resolutions: [], issues: answered === null ? ["no readable interval"] : [] },
      },
    ]);
  },

  "shared-travel": async (context) => {
    const truth = truthOf<{ travellers: number[]; driver: number }>(context);
    const travellers = await setFamily(context, "person", idSet(truth.travellers ?? []), field(context.answer, "travellers"));
    const driver = await idFamily(context, "person", person(truth.driver), field(context.answer, "driver"));
    return record([
      { name: "travellers", result: travellers },
      { name: "driver", result: driver },
    ]);
  },

  "conversation-classif": async (context) => {
    const truth = truthOf<{ kind: string; focus: string }>(context);
    const parts = (["kind", "focus"] as const).map((name) => ({
      name,
      result: labelFamily({ ...context, answer: field(context.answer, name) }, name, truth[name] ?? ""),
    }));
    return record(parts);
  },

  "transaction-to-visit": async (context) => {
    const truth = truthOf<{ venue: string; venueAccepted?: string[]; quotedMerchant?: string | null; visitStartMinute: number }>(context);
    // Older series did not record the quoted name in the truth; their
    // evidence carries it.
    const quoted = truth.quotedMerchant ?? (context.task.evidence as { charge?: { merchant?: string | null } }).charge?.merchant ?? null;
    const venue = await venueResult(context, field(context.answer, "venue"), { ...truth, quotedMerchant: quoted });
    const arrivalField = field(context.answer, "arrival");
    const arrival = parseClock(arrivalField);
    const error = arrival === null ? null : Math.abs(arrival - truth.visitStartMinute);
    const credit = error !== null && error <= context.options.arrivalCreditMinutes ? 1 : 0;
    return record([
      { name: "venue", result: venue, weight: 2 },
      {
        name: "arrival",
        result: isAbstention(arrivalField) ? abstainedResult("arrival time", { withinCredit: 0 }) : {
          score: credit,
          metrics: error === null ? { withinCredit: 0 } : { minutesError: error, withinCredit: credit },
          resolutions: [],
          issues: arrival === null ? ["no readable arrival time"] : [],
        },
        weight: 1,
      },
    ]);
  },

  // -------------------------------------------------------------------------
  // Real-Time Investigations (RTIs): staged incidents, investigated as they happen
  // -------------------------------------------------------------------------

  "mass-shooting": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "shots-fired": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "explosion": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "school-shooting": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),
  // Every member of the crew is a right answer; the driver is not worth more than the rest.
  "abduction": (context) => rankFamily(context, "person", idSet(truthOf<{ people: number[] }>(context).people ?? [])),

  "protest-members": async (context) => {
    const truth = truthOf<{ members: number[]; bystanders?: number }>(context);
    const result = await setFamily(context, "person", idSet(truth.members ?? []));
    return { ...result, metrics: { ...result.metrics, participants: (truth.members ?? []).length, bystanders: truth.bystanders ?? 0 } };
  },

  "mass-gathering": async (context) => {
    const truth = truthOf<{ gathering?: string; lat: number; lon: number }>(context);
    const params = (context.task.scoring.params ?? {}) as { placeCreditMetres?: number };
    const options = params.placeCreditMetres === undefined ? context.options : { ...context.options, placeCreditMetres: params.placeCreditMetres };
    // Current tasks ask only for the point.
    if (context.task.answer.kind !== "record") return pointResult(context.answer, truth, options);
    // Older series asked yes/no first; their truth is always "yes". An omitted
    // field is an abstention and scores zero; only an explicit null says
    // "no gathering".
    const detected = labelFamily({ ...context, answer: field(context.answer, "gathering") }, "gathering", truth.gathering ?? "yes");
    const located = field(context.answer, "location");
    const yes = (truth.gathering ?? "yes") === "yes";
    const location = yes ? pointResult(located, truth, options)
      : { score: located === null ? 1 : 0, metrics: { withinCredit: located === null ? 1 : 0 }, resolutions: [], issues: [] };
    return record([
      { name: "gathering", result: detected },
      { name: "location", result: location },
    ]);
  },
  // -------------------------------------------------------------------------
  // Deception Tasks (DTs): a staged incident with a story attached
  // -------------------------------------------------------------------------

  "stabbing": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  "swatting": (context) => rankFamily(context, "person", person(truthOf<{ person: number }>(context).person)),

  // Where she is, or who did it: only the suspects earn anything. A location
  // is reported as given or not and never scored; an answer that gives only
  // a location scores zero like any abstention on the suspects.
  "disappearance": async (context) => {
    const truth = person(truthOf<{ person: number }>(context).person);
    const suspects = field(context.answer, "suspects"), located = field(context.answer, "location");
    const result = suspects === undefined || isAbstention(suspects)
      ? abstainedResult("suspects", { reciprocalRank: 0, top1: 0 })
      : await rankFamily({ ...context, answer: suspects }, "person", truth);
    const locationGiven = located !== undefined && located !== null && !isAbstention(located) ? 1 : 0;
    return { ...result, metrics: { ...result.metrics, locationGiven } };
  },
};

/**
 * The scorer for a family. There is no fallback: a family without a scorer of
 * its own used to be scored by guessing from its declared method and the first
 * truth field, which could look plausible and be wrong. Now it throws, and the
 * task is reported as a scoring error ("scorer failed: no scorer for family
 * ..."), never as a score. family_scorers.test.ts checks that every family in
 * the generator registry has an entry in FAMILY_SCORERS.
 */
export function scorerFor(family: string): Scorer {
  const scorer = FAMILY_SCORERS[family];
  if (!scorer) throw new Error(`no scorer for family ${family}; add one to FAMILY_SCORERS in scoring/src/families.ts`);
  return scorer;
}

export { macroF1 };

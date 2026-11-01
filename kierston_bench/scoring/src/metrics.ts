/**
 * The measures every family's scorer is built from.
 *
 * Each one is pure and takes values already resolved to their truth form —
 * person ids, canonical plates, minutes past midnight — so nothing here has
 * to know what an answer looked like before it was resolved.
 */

/** Reciprocal rank of the first true id in a ranked answer; 0 when absent. */
export function reciprocalRank(ranked: readonly string[], truth: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) if (truth.has(ranked[i]!)) return 1 / (i + 1);
  return 0;
}

/** True id within the first k of a ranked answer. */
export function recallAtK(ranked: readonly string[], truth: ReadonlySet<string>, k: number): number {
  return ranked.slice(0, k).some((id) => truth.has(id)) ? 1 : 0;
}

export interface SetScore {
  truePositives: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Precision, recall and F1 of an unordered answer. Two empty sets score 1. */
export function setScore(answered: Iterable<string>, truth: Iterable<string>): SetScore {
  const predicted = new Set(answered);
  const expected = new Set(truth);
  if (predicted.size === 0 && expected.size === 0) return { truePositives: 0, precision: 1, recall: 1, f1: 1 };
  let hits = 0;
  for (const id of predicted) if (expected.has(id)) hits += 1;
  const precision = predicted.size === 0 ? 0 : hits / predicted.size;
  const recall = expected.size === 0 ? 0 : hits / expected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: hits, precision, recall, f1 };
}

const EARTH_RADIUS_METRES = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversineMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Interval {
  start: number;
  end: number;
}

/** Intersection over union of two [start, end] minute intervals. */
export function intervalIou(a: Interval, b: Interval): number {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  const overlap = Math.max(0, end - start);
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  if (union <= 0) return overlap > 0 ? 1 : 0;
  return overlap / union;
}

/** Levenshtein distance, used to weight a near-miss plate read. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const candidate = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous[j]!;
      previous[j] = candidate;
    }
  }
  return previous[b.length]!;
}

/** 1 for identical strings, falling to 0 as the edit distance reaches their length. */
export function editSimilarity(a: string, b: string): number {
  const span = Math.max(a.length, b.length);
  return span === 0 ? 1 : Math.max(0, 1 - editDistance(a, b) / span);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface LabelObservation {
  /** The field the label belongs to, so per-field macro-F1 stays separable. */
  field: string;
  predicted: string | null;
  truth: string;
}

export interface MacroF1 {
  macroF1: number;
  accuracy: number;
  perLabel: { label: string; precision: number; recall: number; f1: number; support: number }[];
}

/** Macro-F1 over one field's pooled observations; unanswered counts as wrong. */
export function macroF1(observations: readonly LabelObservation[]): MacroF1 {
  const labels = new Set<string>();
  for (const observation of observations) {
    labels.add(observation.truth);
    if (observation.predicted !== null) labels.add(observation.predicted);
  }
  const perLabel = [...labels].sort().map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const observation of observations) {
      const isTruth = observation.truth === label;
      const isPredicted = observation.predicted === label;
      if (isTruth) support += 1;
      if (isTruth && isPredicted) tp += 1;
      else if (isPredicted) fp += 1;
      else if (isTruth) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, precision, recall, f1, support };
  });
  const scored = perLabel.filter((entry) => entry.support > 0);
  const correct = observations.filter((observation) => observation.predicted === observation.truth).length;
  return {
    macroF1: scored.length === 0 ? 0 : scored.reduce((sum, entry) => sum + entry.f1, 0) / scored.length,
    accuracy: observations.length === 0 ? 0 : correct / observations.length,
    perLabel,
  };
}

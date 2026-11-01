/**
 * The three shapes every measurement in a profile takes.
 *
 * Iceberg's whole design rests on this file being small. A profile is not a
 * report — it is a flat map from a dotted path to one of three metrics, and
 * because there are only three, `diff.ts` can compare two profiles it knows
 * nothing about. Adding "firearms by age band" to the analysis is one call
 * here; the comparison, the scoring and the report follow for free.
 *
 *     scalar   one number. A count, a share, a total.
 *     num      a distribution over numbers, with the tails kept.
 *     cat      counts per category, which is also how every cross-tab is
 *              stored — the category is just "35-44 × female".
 *
 * Quantiles are exact wherever they can be. A column of ages has 100 distinct
 * values and a tally over them answers any percentile precisely, so that is
 * what happens for anything under `EXACT` distinct values. Incomes and
 * kilometres blow past that and fall back to a reservoir — sampled with a
 * seeded generator, because a p95 that moves when nothing changed would make
 * every diff a little bit false.
 */

/** Distinct values a `num` will tally exactly before it starts sampling. */
const EXACT = 8192;
const RESERVOIR = 40_000;
/** Categories kept before the tail is folded into one bucket. */
const TOP = 160;
export const OTHER = "«other»";
export const NULL_LABEL = "«null»";

export interface ScalarMetric {
  t: "scalar";
  v: number;
  /** "count" scales with population size; "share" and "rate" do not. */
  unit: "count" | "share" | "rate" | "money" | "km" | "minutes" | "years";
}

export interface NumMetric {
  t: "num";
  n: number;
  nulls: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  sum: number;
  zeros: number;
  negatives: number;
  /** p1, p5, p25, p50, p75, p95, p99. */
  q: number[];
  /** Whether the quantiles came from a tally or a sample. */
  exact: boolean;
}

export interface CatMetric {
  t: "cat";
  n: number;
  distinct: number;
  counts: Record<string, number>;
}

export interface InvariantMetric {
  t: "invariant";
  /** Rows that broke the rule. Should be 0; is not always. */
  violations: number;
  /** Rows the rule was checked against, so a share is meaningful. */
  checked: number;
  /** A handful of offending rows, to make a regression findable. */
  examples: string[];
  /** What the rule says, in one line. */
  rule: string;
}

export type Metric = ScalarMetric | NumMetric | CatMetric | InvariantMetric;

export interface Profile {
  iceberg: 1;
  /** "init" or "day" — only like is compared with like. */
  kind: string;
  source: string;
  recordedAt: string;
  /** Whatever the file said about itself: seed, digest, date, counts. */
  provenance: Record<string, unknown>;
  metrics: Record<string, Metric>;
}

const QUANTILES = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];

/** xorshift32, so a reservoir samples the same rows on every run. */
function seeded(seed: number): () => number {
  let state = seed | 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) % 0x100000000) / 0x100000000;
  };
}

/**
 * A distribution, accumulated one value at a time.
 *
 * Nulls are counted rather than dropped silently: a field that goes from 4%
 * missing to 40% missing is the kind of change iceberg exists to catch, and it
 * would be invisible in a mean.
 */
export class Num {
  private count = 0;
  private nullCount = 0;
  private total = 0;
  private squares = 0;
  private low = Infinity;
  private high = -Infinity;
  private zero = 0;
  private negative = 0;
  private tally: Map<number, number> | null = new Map();
  private sample: number[] = [];
  private random = seeded(0x1ceb0);

  push(value: number | null | undefined): void {
    if (value === null || value === undefined || Number.isNaN(value)) {
      this.nullCount += 1;
      return;
    }
    this.count += 1;
    this.total += value;
    this.squares += value * value;
    if (value < this.low) this.low = value;
    if (value > this.high) this.high = value;
    if (value === 0) this.zero += 1;
    else if (value < 0) this.negative += 1;

    if (this.tally) {
      this.tally.set(value, (this.tally.get(value) ?? 0) + 1);
      if (this.tally.size > EXACT) {
        // Too many distinct values to tally. Seed the reservoir from what has
        // been seen so the sample covers the whole column, not just its tail.
        for (const [seen, times] of this.tally) {
          for (let i = 0; i < times && this.sample.length < RESERVOIR; i += 1) this.sample.push(seen);
        }
        this.tally = null;
      }
      return;
    }
    if (this.sample.length < RESERVOIR) this.sample.push(value);
    else {
      const slot = Math.floor(this.random() * this.count);
      if (slot < RESERVOIR) this.sample[slot] = value;
    }
  }

  pushAll(values: ArrayLike<number>, skip?: (value: number) => boolean): void {
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      this.push(skip?.(value) ? null : value);
    }
  }

  get empty(): boolean { return this.count === 0 && this.nullCount === 0; }

  metric(): NumMetric {
    const n = this.count;
    const mean = n ? this.total / n : 0;
    const variance = n > 1 ? Math.max(0, this.squares / n - mean * mean) : 0;
    return {
      t: "num",
      n,
      nulls: this.nullCount,
      min: n ? this.low : 0,
      max: n ? this.high : 0,
      mean: round(mean),
      sd: round(Math.sqrt(variance)),
      sum: round(this.total),
      zeros: this.zero,
      negatives: this.negative,
      q: this.quantiles().map(round),
      exact: this.tally !== null,
    };
  }

  private quantiles(): number[] {
    if (!this.count) return QUANTILES.map(() => 0);
    if (this.tally) {
      const values = [...this.tally.entries()].sort((a, b) => a[0] - b[0]);
      const out: number[] = [];
      let seen = 0;
      let at = 0;
      for (const q of QUANTILES) {
        const want = q * (this.count - 1);
        while (at < values.length - 1 && seen + values[at][1] - 1 < want) {
          seen += values[at][1];
          at += 1;
        }
        out.push(values[at][0]);
      }
      return out;
    }
    const sorted = [...this.sample].sort((a, b) => a - b);
    return QUANTILES.map((q) => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))]);
  }
}

/** Counts per category, which is also how cross-tabs and histograms are held. */
export class Cat {
  private readonly counts = new Map<string, number>();
  private total = 0;

  add(label: string, times = 1): void {
    if (times <= 0) return;
    this.counts.set(label, (this.counts.get(label) ?? 0) + times);
    this.total += times;
  }

  get size(): number { return this.counts.size; }
  get n(): number { return this.total; }

  metric(): CatMetric {
    const sorted = [...this.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const out: Record<string, number> = {};
    let other = 0;
    for (const [label, count] of sorted) {
      if (Object.keys(out).length < TOP) out[label] = count;
      else other += count;
    }
    if (other) out[OTHER] = other;
    return { t: "cat", n: this.total, distinct: this.counts.size, counts: out };
  }
}

const round = (value: number) =>
  Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;

/**
 * The thing an analysis writes into.
 *
 * Paths are dotted and grouped by their first two segments in the report, so
 * `population.person.age` and `population.person.income` sit together without
 * anything declaring a section.
 */
export class Builder {
  readonly metrics: Record<string, Metric> = {};
  readonly provenance: Record<string, unknown> = {};

  scalar(path: string, value: number, unit: ScalarMetric["unit"] = "count"): void {
    this.metrics[path] = { t: "scalar", v: round(value), unit };
  }

  /** A count and its share of a whole, which is what almost every count wants. */
  countAndShare(path: string, count: number, of: number): void {
    this.scalar(path, count, "count");
    this.scalar(`${path}.share`, of ? count / of : 0, "share");
  }

  num(path: string, values: Num | ArrayLike<number>, skip?: (value: number) => boolean): void {
    if (values instanceof Num) {
      if (!values.empty) this.metrics[path] = values.metric();
      return;
    }
    const sketch = new Num();
    sketch.pushAll(values, skip);
    if (!sketch.empty) this.metrics[path] = sketch.metric();
  }

  cat(path: string, cat: Cat): void {
    if (cat.n || cat.size) this.metrics[path] = cat.metric();
  }

  invariant(path: string, rule: string, violations: number, checked: number, examples: string[] = []): void {
    this.metrics[path] = {
      t: "invariant", rule, violations, checked, examples: examples.slice(0, 5),
    };
  }

  profile(kind: string, source: string): Profile {
    return {
      iceberg: 1,
      kind,
      source,
      recordedAt: new Date().toISOString(),
      provenance: this.provenance,
      metrics: this.metrics,
    };
  }
}

/** Age bands, fixed here so every cross-tab in every module uses the same ones. */
export function ageBand(age: number): string {
  if (age < 5) return "00-04";
  if (age < 18) return age < 12 ? "05-11" : "12-17";
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  if (age < 55) return "45-54";
  if (age < 65) return "55-64";
  if (age < 75) return "65-74";
  if (age < 85) return "75-84";
  return "85+";
}

/** Log-ish money bands, so an income distribution cross-tabs against anything. */
export function moneyBand(value: number): string {
  if (value < 0) return "negative";
  if (value === 0) return "0";
  const steps = [10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000, 1_000_000];
  let low = 0;
  for (const step of steps) {
    if (value < step) return `${short(low)}-${short(step)}`;
    low = step;
  }
  return `${short(low)}+`;
}

const short = (value: number) => (value >= 1000 ? `${value / 1000}k` : String(value));

export function band(value: number, edges: number[], unit = ""): string {
  if (value < edges[0]) return `<${edges[0]}${unit}`;
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value < edges[i + 1]) return `${edges[i]}-${edges[i + 1]}${unit}`;
  }
  return `${edges[edges.length - 1]}+${unit}`;
}

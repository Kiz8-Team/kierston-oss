/**
 * Where a handset was, estimated only from what an operator's records say.
 *
 * The bench gives an agent carrier records and the public cell-site table,
 * never the span table the sim keeps. This file is an analyst working from
 * exactly those: network events (cell, previous cell, timing advance,
 * secondary carrier, the tracking area of an update), SMS and call records
 * (a cell at a second), call handovers, and each sector's position, azimuth,
 * beamwidth, height, planning range and morphology. Nothing here reads the
 * sim's radio model; the numbers below are generic assumptions a competent
 * analyst would make, so the output is an honest idea of how fine a location
 * the evidence supports, not a replay of how the sim produced it.
 *
 * The estimator
 * -------------
 * A grid over the city, and for every record a likelihood surface over it:
 *
 *   timing advance  The cell measured a round trip, quantised to 78.125 m, and
 *                   a reflected path only ever reads long. So a TA of k says
 *                   the slant range plus an exponential excess fell in
 *                   [k, k+1) steps; the excess mean grows with the sector's
 *                   morphology. A ring, sharp on the inside and soft outside.
 *   sector          The 3GPP horizontal pattern, 12(θ/θ3dB)² dB capped at
 *                   20 dB, softened because shadow fading lets a side lobe
 *                   win. A wedge. Omni small cells contribute no bearing.
 *   no TA           SMS and call rows carry a cell and nothing else: a soft
 *                   disc at 1.3× the planning range, times the wedge.
 *   secondary       The carrier added under a connected handset is one the
 *                   handset hears well, so the handset is inside its
 *                   coverage: a disc at 1.2× its range, times its wedge.
 *   previous cell   A handover happens near the edge between two cells, so
 *                   the old one's coverage is a weak extra disc.
 *   update (TAU)    The cell is withheld and the tracking area and TA kept:
 *                   a mixture of the TA ring over every cell of the handset's
 *                   operator in that area.
 *
 * Every surface is floored at a thousandth of its peak, so a record that the
 * model gets wrong narrows the answer instead of deleting the truth.
 *
 * One record on a flat prior is what an agent reading a single row can say.
 * The fused track is what an agent joining the whole day can say: a forward-
 * backward pass over the grid, with a motion model between records that is
 * a mixture of staying roughly put and driving somewhere, so both a sleeping
 * phone and a commuting one are plausible.
 *
 * Every estimate reports its posterior mean, the radius of a disc with the
 * area of its 50% and 95% credible regions, and — against ground truth — the
 * error of the mean and whether the truth fell inside the 95% region. The
 * last is the calibration check: a model that is confidently wrong shows up
 * as a 95% region that holds the truth far less than 95% of the time.
 */

export const TA_UNIT_M = 78.125;

/** Mean excess path length by the sector's morphology, metres. */
const MULTIPATH_M: Record<string, number> = { open: 10, suburban: 25, urban: 45, "dense urban": 65 };

/**
 * A surface's floor, as a fraction of its own peak.
 *
 * It keeps a record the model gets wrong from deleting the truth, so it has to
 * be small against the number of grid cells: at a thousandth, thirty thousand
 * floored cells outweigh the peak and every credible region came back the size
 * of the city.
 */
const FLOOR = 1e-6;

/** Weight of a record that repeats the previous reading exactly. */
const REPEAT_WEIGHT = 0.35;

/**
 * Weight of every record in the fused track.
 *
 * Under 1 because records from one handset are never the independent draws the
 * arithmetic assumes: they share a mast, a room and whatever the propagation
 * model gets wrong about that street. Left at 1, the fused track's 95% region
 * held the truth about half the time — confident and wrong, which is the one
 * failure mode this tool exists to expose rather than commit.
 */
const FUSION_WEIGHT = 0.8;

const PATTERN_CAP_DB = 20;
/** dB of pattern loss per decade of likelihood; above 10 it is softer than the antenna. */
const PATTERN_SOFTNESS = 1.5;
const UE_HEIGHT_M = 1.5;
const METRES_PER_DEGREE = 111_320;

export interface LatLon {
  lat: number;
  lon: number;
}

/** One sector as the public cell-site table describes it. */
export interface SiteCell {
  cgi: string;
  structure: string;
  operator: string;
  radio: string;
  band: string;
  role: string;
  sector: number;
  trackingArea: number;
  lat: number;
  lon: number;
  azimuth: number;
  beamwidth: number;
  heightM: number;
  rangeM: number;
  morphology: string;
}

export type RecordTable = "network_events" | "sms_records" | "call_records" | "call_handovers";

/** One row an agent could read, reduced to what locates the handset. */
export interface Observation {
  id: number;
  /** Seconds from midnight. Network events are minute-resolution. */
  second: number;
  table: RecordTable;
  /** Event type for a network event; `sms`, `call` or `call handover` otherwise. */
  kind: string;
  cell: string | null;
  previous: string | null;
  secondary: string | null;
  ta: number | null;
  /** Only on a tracking-area update, whose cell is withheld. */
  trackingArea: number | null;
}

export interface GridSpec {
  south: number;
  west: number;
  step: number;
  nx: number;
  ny: number;
  mLat: number;
  mLon: number;
}

export interface Estimate extends LatLon {
  /** Radius of a disc with the area of the 50% credible region, metres. */
  r50: number;
  r95: number;
}

export interface Scored extends Estimate {
  truth: LatLon | null;
  /** Metres from the posterior mean to the truth, or null with no truth. */
  error: number | null;
  covered: boolean | null;
}

export interface ObservationResult extends Observation {
  single: Scored | null;
  /** The naive answer: the serving mast's own coordinates. */
  mast: { lat: number; lon: number; error: number | null } | null;
  truth: LatLon | null;
}

export interface TrackPoint extends Scored {
  minute: number;
  /** A record fell in this minute. */
  observed: boolean;
}

export interface ErrorRow {
  error: number | null;
  r95: number | null;
  covered: boolean | null;
}

export interface ErrorStats {
  key: string;
  count: number;
  scored: number;
  median: number | null;
  p90: number | null;
  r95: number | null;
  coverage: number | null;
}

/** Row order in every accuracy table. */
export const STAT_KEYS = [
  "mast", "attach", "detach", "connect", "release", "handover", "tau",
  "sms", "call", "call handover", "fused-records", "fused-grid",
] as const;

export const STAT_LABEL: Record<string, string> = {
  mast: "Serving mast position",
  attach: "Attach event",
  detach: "Detach event",
  connect: "Connect event",
  release: "Release event",
  handover: "Handover event",
  tau: "Tracking-area update",
  sms: "SMS record",
  call: "Call record",
  "call handover": "Call handover",
  "fused-records": "Whole-day estimate · per record",
  "fused-grid": "Whole-day estimate · 15 min",
};

export const KIND_COLOR: Record<string, string> = {
  attach: "#1baf7a",
  detach: "#8b9298",
  connect: "#3b82f6",
  release: "#60a5fa",
  handover: "#a855f7",
  tau: "#eda100",
  sms: "#c2417a",
  call: "#e0483c",
  "call handover": "#f97316",
};

export interface HandsetEstimate {
  subscriber: number;
  imsi: string | null;
  msisdn: string | null;
  carrier: string | null;
  operator: string;
  observations: ObservationResult[];
  track: TrackPoint[];
  stats: ErrorStats[];
}

export interface CellularEstimate {
  date: string;
  person: number;
  grid: GridSpec;
  /** Every sector the records name, so the page can draw wedges and rings. */
  cells: Record<string, SiteCell>;
  legs: { depart: number; arrive: number; path: [number, number][]; from: LatLon; to: LatLon }[];
  handsets: HandsetEstimate[];
}

export interface PosteriorCells {
  minute: number;
  cells: number[];
  /** 1–255 against the region's own peak. */
  weights: number[];
}

export interface SampleResult {
  date: string;
  people: number;
  handsets: number;
  records: number;
  stats: ErrorStats[];
}

// ---- Numbers ----------------------------------------------------------------

/** A copy that keeps its own buffer — `Float32Array.from` widens the type. */
function copyOf(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  out.set(values);
  return out;
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function statsFromRows(key: string, rows: ErrorRow[]): ErrorStats {
  const errors = rows.map((row) => row.error).filter((value): value is number => value !== null);
  const radii = rows.map((row) => row.r95).filter((value): value is number => value !== null);
  const judged = rows.filter((row) => row.covered !== null);
  return {
    key,
    count: rows.length,
    scored: errors.length,
    median: quantile(errors, 0.5),
    p90: quantile(errors, 0.9),
    r95: quantile(radii, 0.5),
    coverage: judged.length ? judged.filter((row) => row.covered).length / judged.length : null,
  };
}

export function metres(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} km`;
}

export function clockSeconds(second: number): string {
  const s = Math.max(0, Math.round(second));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Ground radius of a timing-advance step boundary, for drawing a ring. */
export function taGroundRadius(steps: number, heightM: number): number {
  const slant = steps * TA_UNIT_M;
  const h = Math.max(0, heightM - UE_HEIGHT_M);
  return Math.sqrt(Math.max(0, slant * slant - h * h));
}

export function gridPoint(grid: GridSpec, index: number): LatLon {
  const i = index % grid.nx;
  const j = Math.floor(index / grid.nx);
  return { lat: grid.south + (j * grid.step) / grid.mLat, lon: grid.west + (i * grid.step) / grid.mLon };
}

function distance(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * METRES_PER_DEGREE * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = (b.lat - a.lat) * METRES_PER_DEGREE;
  return Math.sqrt(x * x + y * y);
}

// ---- The grid ---------------------------------------------------------------

interface Summary extends Estimate {
  threshold: number;
}

export class Estimator {
  readonly grid: GridSpec;
  readonly size: number;
  private readonly byCgi: Map<string, SiteCell>;
  private readonly byArea = new Map<string, SiteCell[]>();

  constructor(cells: SiteCell[], step: number, marginM = 1500) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const cell of cells) {
      minLat = Math.min(minLat, cell.lat); maxLat = Math.max(maxLat, cell.lat);
      minLon = Math.min(minLon, cell.lon); maxLon = Math.max(maxLon, cell.lon);
    }
    const mLat = METRES_PER_DEGREE;
    const mLon = METRES_PER_DEGREE * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const nx = Math.ceil(((maxLon - minLon) * mLon + 2 * marginM) / step) + 1;
    const ny = Math.ceil(((maxLat - minLat) * mLat + 2 * marginM) / step) + 1;
    this.grid = { south: minLat - marginM / mLat, west: minLon - marginM / mLon, step, nx, ny, mLat, mLon };
    this.size = nx * ny;
    this.byCgi = new Map(cells.map((cell) => [cell.cgi, cell]));
    for (const cell of cells) {
      const key = `${cell.operator}/${cell.trackingArea}`;
      const list = this.byArea.get(key) ?? [];
      list.push(cell);
      this.byArea.set(key, list);
    }
  }

  cell(cgi: string | null): SiteCell | undefined {
    return cgi ? this.byCgi.get(cgi) : undefined;
  }

  indexOf(point: LatLon): number {
    const { south, west, step, nx, ny, mLat, mLon } = this.grid;
    const i = Math.round(((point.lon - west) * mLon) / step);
    const j = Math.round(((point.lat - south) * mLat) / step);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  }

  private origin(cell: SiteCell): [number, number] {
    const { south, west, mLat, mLon } = this.grid;
    return [(cell.lon - west) * mLon, (cell.lat - south) * mLat];
  }

  /** P(TA = k | position), unnormalised, into `out`. Zero past the ring's reach. */
  private ta(cell: SiteCell, k: number, out: Float32Array): void {
    const { nx, ny, step } = this.grid;
    const [cx, cy] = this.origin(cell);
    const h2 = Math.max(0, cell.heightM - UE_HEIGHT_M) ** 2;
    const mu = MULTIPATH_M[cell.morphology] ?? 30;
    const lo = k * TA_UNIT_M;
    const hi = lo + TA_UNIT_M;
    // Wider than half a grid cell on purpose: the ring is 78 m thick, and the
    // handset's own position, the mast's, and the reflection the cell actually
    // measured are each worth tens of metres. A ring drawn to its nominal
    // width alone is sharper than the evidence.
    const jitter = Math.max(step / 2, 75);
    const reach = hi + jitter;
    const cdf = (x: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / mu));
    const band = (s: number) => cdf(hi - s) - cdf(lo - s);
    out.fill(0);
    const i0 = Math.max(0, Math.floor((cx - reach) / step));
    const i1 = Math.min(nx - 1, Math.ceil((cx + reach) / step));
    const j0 = Math.max(0, Math.floor((cy - reach) / step));
    const j1 = Math.min(ny - 1, Math.ceil((cy + reach) / step));
    for (let j = j0; j <= j1; j += 1) {
      const dy = j * step - cy;
      for (let i = i0; i <= i1; i += 1) {
        const dx = i * step - cx;
        const s = Math.sqrt(dx * dx + dy * dy + h2);
        // Averaged across the grid cell, so a ring narrower than a cell is not
        // missed by sampling only its centre.
        out[j * nx + i] = (band(s - jitter) + band(s) + band(s + jitter)) / 3;
      }
    }
  }

  /** Multiply the horizontal pattern into `out`. */
  private pattern(cell: SiteCell, out: Float32Array): void {
    if (cell.beamwidth >= 360) return;
    const { nx, ny, step } = this.grid;
    const [cx, cy] = this.origin(cell);
    for (let j = 0; j < ny; j += 1) {
      const dy = j * step - cy;
      for (let i = 0; i < nx; i += 1) {
        const index = j * nx + i;
        if (out[index] === 0) continue;
        const dx = i * step - cx;
        let off = Math.abs((Math.atan2(dx, dy) * 180) / Math.PI - cell.azimuth) % 360;
        if (off > 180) off = 360 - off;
        const ratio = off / cell.beamwidth;
        const loss = Math.min(12 * ratio * ratio, PATTERN_CAP_DB);
        out[index]! *= Math.pow(10, -loss / (10 * PATTERN_SOFTNESS));
      }
    }
  }

  /** A soft disc at `factor` × the planning range, into `out`. */
  private coverage(cell: SiteCell, factor: number, out: Float32Array): void {
    const { nx, ny, step } = this.grid;
    const [cx, cy] = this.origin(cell);
    const radius = Math.max(150, cell.rangeM * factor);
    const width = 0.2 * radius;
    for (let j = 0; j < ny; j += 1) {
      const dy = j * step - cy;
      for (let i = 0; i < nx; i += 1) {
        const dx = i * step - cx;
        const exponent = (Math.sqrt(dx * dx + dy * dy) - radius) / width;
        out[j * nx + i] = exponent > 50 ? 0 : 1 / (1 + Math.exp(exponent));
      }
    }
  }

  private multiplyFloored(target: Float32Array, part: Float32Array): void {
    let max = 0;
    for (let i = 0; i < part.length; i += 1) if (part[i]! > max) max = part[i]!;
    if (max <= 0) return;
    const inverse = 1 / max;
    for (let i = 0; i < target.length; i += 1) target[i]! *= Math.max(part[i]! * inverse, FLOOR);
  }

  /** Everything one record says, as a surface peaking at 1; null if it says nothing. */
  likelihood(observation: Observation, operator: string): Float32Array | null {
    const out = new Float32Array(this.size).fill(1);
    const part = new Float32Array(this.size);
    let informative = false;

    const serving = this.cell(observation.cell);
    if (serving) {
      if (observation.ta !== null) this.ta(serving, observation.ta, part);
      else this.coverage(serving, 1.3, part);
      this.pattern(serving, part);
      this.multiplyFloored(out, part);
      informative = true;
    } else if (observation.ta !== null && observation.trackingArea !== null) {
      const candidates = this.byArea.get(`${operator}/${observation.trackingArea}`) ?? [];
      if (candidates.length) {
        const sum = new Float32Array(this.size);
        for (const cell of candidates) {
          this.ta(cell, observation.ta, part);
          this.pattern(cell, part);
          for (let i = 0; i < sum.length; i += 1) sum[i]! += part[i]!;
        }
        this.multiplyFloored(out, sum);
        informative = true;
      }
    }

    const secondary = this.cell(observation.secondary);
    if (secondary) {
      this.coverage(secondary, 1.2, part);
      this.pattern(secondary, part);
      this.multiplyFloored(out, part);
      informative = true;
    }

    const previous = this.cell(observation.previous);
    if (previous) {
      this.coverage(previous, 1.5, part);
      this.multiplyFloored(out, part);
    }
    return informative ? out : null;
  }

  normalise(values: Float32Array): Float32Array {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[i]!;
    if (!(sum > 0) || !Number.isFinite(sum)) return values.fill(1 / values.length);
    const inverse = 1 / sum;
    for (let i = 0; i < values.length; i += 1) values[i]! *= inverse;
    return values;
  }

  /**
   * Mean, and the 50% and 95% credible areas, from a log histogram of the
   * probabilities — one pass instead of a sort, and exact enough for a radius.
   */
  summarise(posterior: Float32Array): Summary {
    const { nx, step } = this.grid;
    let max = 0, mx = 0, my = 0;
    for (let index = 0; index < posterior.length; index += 1) {
      const p = posterior[index]!;
      if (p > max) max = p;
      mx += p * (index % nx);
      my += p * Math.floor(index / nx);
    }
    const centre = gridPoint(this.grid, 0);
    const lat = centre.lat + (my * step) / this.grid.mLat;
    const lon = centre.lon + (mx * step) / this.grid.mLon;
    if (max <= 0) return { lat, lon, r50: 0, r95: 0, threshold: 0 };

    const BINS = 240;
    const DECADES = 9;
    const top = Math.log10(max);
    const mass = new Float64Array(BINS);
    const count = new Uint32Array(BINS);
    for (let index = 0; index < posterior.length; index += 1) {
      const p = posterior[index]!;
      if (p <= 0) continue;
      const bin = Math.min(BINS - 1, Math.floor(((top - Math.log10(p)) / DECADES) * BINS));
      mass[bin]! += p;
      count[bin]! += 1;
    }
    let cumulative = 0, area = 0;
    let a50: number | null = null, a95: number | null = null, threshold = 0;
    for (let bin = 0; bin < BINS; bin += 1) {
      if (!count[bin]) continue;
      const m = mass[bin]!;
      if (a50 === null && cumulative + m >= 0.5) a50 = area + count[bin]! * ((0.5 - cumulative) / m);
      if (a95 === null && cumulative + m >= 0.95) {
        a95 = area + count[bin]! * ((0.95 - cumulative) / m);
        threshold = Math.pow(10, top - ((bin + 1) * DECADES) / BINS);
      }
      cumulative += m;
      area += count[bin]!;
    }
    const radius = (cells: number | null) => Math.sqrt(((cells ?? area) * step * step) / Math.PI);
    return { lat, lon, r50: radius(a50), r95: radius(a95), threshold };
  }

  score(posterior: Float32Array, summary: Summary, truth: LatLon | null): Scored {
    const { threshold, ...estimate } = summary;
    if (!truth) return { ...estimate, truth: null, error: null, covered: null };
    const index = this.indexOf(truth);
    return {
      ...estimate,
      truth,
      error: distance(estimate, truth),
      covered: index >= 0 && posterior[index]! >= threshold,
    };
  }

  /** The 95% region of a posterior, heaviest first, for drawing. */
  region(posterior: Float32Array, limit = 6000): { cells: number[]; weights: number[] } {
    const { threshold } = this.summarise(posterior);
    const picked: number[] = [];
    let max = 0;
    for (let index = 0; index < posterior.length; index += 1) {
      const p = posterior[index]!;
      if (p >= threshold && p > 0) { picked.push(index); if (p > max) max = p; }
    }
    picked.sort((a, b) => posterior[b]! - posterior[a]!);
    const cells = picked.slice(0, limit);
    return { cells, weights: cells.map((index) => Math.max(1, Math.round((posterior[index]! / max) * 255))) };
  }

  // ---- Motion -----------------------------------------------------------------

  private boxH(source: Float32Array, target: Float32Array, radius: number): void {
    const { nx, ny } = this.grid;
    const norm = 1 / (2 * radius + 1);
    for (let j = 0; j < ny; j += 1) {
      const row = j * nx;
      let sum = 0;
      for (let i = 0; i <= Math.min(radius, nx - 1); i += 1) sum += source[row + i]!;
      for (let i = 0; i < nx; i += 1) {
        target[row + i] = sum * norm;
        if (i + radius + 1 < nx) sum += source[row + i + radius + 1]!;
        if (i - radius >= 0) sum -= source[row + i - radius]!;
      }
    }
  }

  private boxV(source: Float32Array, target: Float32Array, radius: number): void {
    const { nx, ny } = this.grid;
    const norm = 1 / (2 * radius + 1);
    for (let i = 0; i < nx; i += 1) {
      let sum = 0;
      for (let j = 0; j <= Math.min(radius, ny - 1); j += 1) sum += source[j * nx + i]!;
      for (let j = 0; j < ny; j += 1) {
        target[j * nx + i] = sum * norm;
        if (j + radius + 1 < ny) sum += source[(j + radius + 1) * nx + i]!;
        if (j - radius >= 0) sum -= source[(j - radius) * nx + i]!;
      }
    }
  }

  /** Three box passes each way, which is a Gaussian to within a few percent. */
  private blur(values: Float32Array, sigmaM: number): Float32Array {
    const sigma = sigmaM / this.grid.step;
    if (sigma < 0.4) return copyOf(values);
    const radius = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    let a = copyOf(values);
    for (let pass = 0; pass < 3; pass += 1) {
      const across = new Float32Array(values.length);
      this.boxH(a, across, radius);
      const down = new Float32Array(values.length);
      this.boxV(across, down, radius);
      a = down;
    }
    return a;
  }

  /**
   * Where the handset could be `minutes` later. Mostly still — a phone spends
   * most of a day on a bedside table or a desk — and otherwise driven
   * somewhere at town speeds. Symmetric, so the backward pass uses it as is.
   */
  private transition(values: Float32Array, minutes: number): Float32Array {
    if (minutes <= 0) return copyOf(values);
    const stay = 0.35 + 0.65 * Math.exp(-minutes / 30);
    const near = this.blur(values, Math.min(30 * Math.sqrt(minutes), 400));
    const far = this.blur(values, Math.min(300 * minutes, 6000));
    const floor = 1e-4 / values.length;
    for (let i = 0; i < near.length; i += 1) near[i] = stay * near[i]! + (1 - stay) * far[i]! + floor;
    return this.normalise(near);
  }

  /** Forward-backward over the steps; one scored posterior per step. */
  fuse(
    steps: { minute: number; likelihood: Float32Array | null }[],
    truthAt: (minute: number) => LatLon | null,
    keep: boolean,
  ): { points: Scored[]; posteriors: Float32Array[] | null } {
    const alphas: Float32Array[] = [];
    let previous: Float32Array | null = null;
    let previousMinute = 0;
    for (const step of steps) {
      const alpha: Float32Array = previous
        ? this.transition(previous, step.minute - previousMinute)
        : new Float32Array(this.size).fill(1 / this.size);
      if (step.likelihood) for (let i = 0; i < alpha.length; i += 1) alpha[i]! *= step.likelihood[i]!;
      this.normalise(alpha);
      alphas.push(alpha);
      previous = alpha;
      previousMinute = step.minute;
    }

    const points: Scored[] = new Array(steps.length);
    const posteriors: Float32Array[] | null = keep ? new Array(steps.length) : null;
    let beta: Float32Array = new Float32Array(this.size).fill(1);
    for (let t = steps.length - 1; t >= 0; t -= 1) {
      const gamma = copyOf(alphas[t]!);
      for (let i = 0; i < gamma.length; i += 1) gamma[i]! *= beta[i]!;
      this.normalise(gamma);
      points[t] = this.score(gamma, this.summarise(gamma), truthAt(steps[t]!.minute));
      if (posteriors) posteriors[t] = gamma;
      if (t > 0) {
        const message = copyOf(beta);
        const likelihood = steps[t]!.likelihood;
        if (likelihood) for (let i = 0; i < message.length; i += 1) message[i]! *= likelihood[i]!;
        beta = this.transition(this.normalise(message), steps[t]!.minute - steps[t - 1]!.minute);
      }
    }
    return { points, posteriors };
  }
}

// ---- One handset ------------------------------------------------------------

export interface HandsetRun {
  observations: ObservationResult[];
  track: TrackPoint[];
  rows: Record<string, ErrorRow[]>;
  posteriors: Float32Array[] | null;
}

export function estimateHandset(
  estimator: Estimator,
  records: Observation[],
  operator: string,
  truthAt: (second: number) => LatLon | null,
  options: { gridEvery: number; keep: boolean },
): HandsetRun {
  const ordered = [...records].sort((a, b) => a.second - b.second || a.id - b.id);
  const rows: Record<string, ErrorRow[]> = {};
  const push = (key: string, row: ErrorRow) => { (rows[key] ??= []).push(row); };
  const byMinute = new Map<number, Float32Array>();
  const observations: ObservationResult[] = [];
  let lastEvidence: string | null = null;

  for (const record of ordered) {
    const truth = truthAt(record.second);
    const likelihood = estimator.likelihood(record, operator);
    let single: Scored | null = null;
    if (likelihood) {
      const posterior = estimator.normalise(copyOf(likelihood));
      single = estimator.score(posterior, estimator.summarise(posterior), truth);
      push(record.kind, single);

      // A phone on a desk files the same cell, the same timing advance and the
      // same secondary every few minutes all afternoon. Those rows are one
      // measurement repeated, not thirty independent ones, and multiplying
      // them as if they were independent is what makes a fused track certain
      // and wrong. A repeat of the last reading is tempered to a fraction of
      // its weight; a reading that changed counts in full.
      const evidence = `${record.cell}|${record.ta}|${record.secondary}|${record.previous}|${record.trackingArea}`;
      const weight = evidence === lastEvidence ? REPEAT_WEIGHT : FUSION_WEIGHT;
      const contribution = copyOf(likelihood);
      for (let i = 0; i < contribution.length; i += 1) contribution[i] = Math.pow(contribution[i]!, weight);
      lastEvidence = evidence;

      const minute = Math.floor(record.second / 60);
      const existing = byMinute.get(minute);
      if (existing) {
        let max = 0;
        for (let i = 0; i < existing.length; i += 1) { existing[i]! *= contribution[i]!; if (existing[i]! > max) max = existing[i]!; }
        if (max > 0) for (let i = 0; i < existing.length; i += 1) existing[i]! /= max;
      } else {
        byMinute.set(minute, contribution);
      }
    }
    const serving = estimator.cell(record.cell);
    const mast = serving
      ? { lat: serving.lat, lon: serving.lon, error: truth ? distance(serving, truth) : null }
      : null;
    if (mast) push("mast", { error: mast.error, r95: null, covered: null });
    observations.push({ ...record, single, mast, truth });
  }

  const minutes = new Set(byMinute.keys());
  for (let minute = 0; minute < 1440; minute += options.gridEvery) minutes.add(minute);
  const steps = [...minutes].sort((a, b) => a - b)
    .map((minute) => ({ minute, likelihood: byMinute.get(minute) ?? null }));
  const truthAtMinute = (minute: number) => truthAt(minute * 60 + 30);
  const fused = estimator.fuse(steps, truthAtMinute, options.keep);

  const track: TrackPoint[] = steps.map((step, t) => ({
    ...fused.points[t]!,
    minute: step.minute,
    observed: step.likelihood !== null,
  }));
  for (const point of track) {
    if (point.observed) push("fused-records", point);
    if (point.minute % options.gridEvery === 0) push("fused-grid", point);
  }
  return { observations, track, rows, posteriors: fused.posteriors };
}

export function statsTable(rows: Record<string, ErrorRow[]>): ErrorStats[] {
  return STAT_KEYS.filter((key) => rows[key]?.length).map((key) => statsFromRows(key, rows[key]!));
}

/**
 * The radio side of the network: which cell a point on the ground can hear.
 *
 * `init/network/towers.py` decided what exists — structures, sectors, bands,
 * identifiers — and stopped there, because choosing a serving cell needs a
 * position at a time and only a running simulation has one. This is the other
 * half. It answers one question, for one point, as many million times a day as
 * it is asked: of the cells this operator runs and this handset can hear, which
 * are the strongest, and how strong is each.
 *
 * The link budget, and why it is this shape
 * -----------------------------------------
 * Nothing here is a propagation prediction. A real planning tool ray-traces
 * against a terrain and clutter database, and the answer it gives is only as
 * good as the clutter — which for a synthetic city is a thing nobody has. What
 * this needs instead is an ordering that is *right for the right reasons*: the
 * near cell usually wins, the one you are behind the back of usually does not,
 * a low band gets indoors and 3.7 GHz does not, and none of it is a clean
 * function of distance alone. Every term below earns its place by changing that
 * ordering somewhere in the city.
 *
 *   two-slope       free space to a 200 m breakpoint, then an exponent and a
 *                   clutter loss set by the building density around the
 *                   *handset*. Dense urban attenuates faster than open ground.
 *                   The cell's own `morphology` is a planning label for the
 *                   mast's surroundings and is not read here; see `MORPHOLOGY`.
 *
 *   horizontal      a sector points somewhere. The 3GPP parabolic pattern,
 *                   using the file's `beamwidth` as the 3 dB width, capped at
 *                   the front-to-back ratio. This is what makes standing
 *                   behind a mast different from standing in front of it.
 *
 *   vertical        `downtilt` against the elevation angle from antenna height
 *                   to street level. It is what stops the tallest mast in the
 *                   city serving its own car park, which is exactly what a
 *                   distance-only model has it do.
 *
 *   penetration     by frequency, and this is the term that matters most for
 *                   how the day reads. Two thirds of a life is indoors, and
 *                   the cell that serves a person in their kitchen is very
 *                   often not the cell that served them on their doorstep.
 *
 * The output is an RSRP in dBm — power per resource element, which is what a
 * handset actually measures and reports, rather than a unitless score. That is
 * worth the extra term because the numbers end up in the records, and a record
 * carrying a plausible -104 can be reasoned about while one carrying 0.37
 * cannot.
 *
 * Shadow fading is deliberately not here: it depends on who is asking, and it
 * belongs to `attach.ts`, which knows.
 *
 * Why the candidate raster is lazy
 * --------------------------------
 * Scoring every cell in the city for every person-minute is 2694 x 115343 x
 * 1440 and is not a thing that finishes. The city is instead cut into 50 m
 * tiles, and a tile's candidate list is computed once and reused by everyone
 * who ever stands in it — which for a tile containing a tower block is
 * hundreds of people for hours each.
 *
 * Lazily, though, and that is the part worth arguing for. Building the whole
 * raster up front costs a pass over a fourteen-kilometre square, most of which
 * is farmland nobody in the population ever occupies, and it would be paid in
 * full by `--person 0` inspecting one day. Computed on demand and memoised, a
 * full city day touches the tiles the city is actually in and a single person's
 * day touches a few dozen.
 *
 * The list is ranked on the better of the indoor and outdoor scores rather than
 * on either, because the two orderings genuinely differ — a low band that is
 * eighth on the doorstep can be first in the back bedroom — and a candidate
 * list that only knew one of them would make the walk through the front door
 * pick the wrong cell.
 */

import { join } from "node:path";
import { SIM_DATA_DIR } from "../world/index.ts";

/** One cell, as `towers.json` wrote it. Field names are the file's. */
export interface CellRecord {
  id: string;
  structure: string;
  operator: string;
  operator_key: string;
  mcc: string;
  mnc: string;
  radio: "LTE" | "NR";
  band: string;
  role: "anchor" | "mid" | "capacity" | "firstnet";
  frequency_mhz: number;
  station_id: number;
  cell_id: number;
  cgi: string;
  identity: number;
  tracking_area: number;
  sector: number;
  azimuth: number;
  beamwidth: number;
  downtilt: number;
  height_m: number;
  eirp_dbm: number;
  range_m: number;
  morphology: string;
  lat: number;
  lon: number;
  pci: number;
}

export interface StructureRecord {
  id: string;
  source: "asr" | "modelled";
  asr: string | null;
  lat: number;
  lon: number;
  structure: string;
  height_m: number;
  owner: string | null;
  in_city: boolean;
}

/** The four networks with spectrum here. Index order is fixed and packed. */
export const OPERATORS = ["verizon", "att", "tmobile", "boost"] as const;
export type OperatorKey = (typeof OPERATORS)[number];

/** What the host network is called in `devices.json`, to its key here. */
export const HOST_NETWORKS: Record<string, OperatorKey> = {
  "Verizon": "verizon",
  "AT&T": "att",
  "T-Mobile": "tmobile",
  "Boost": "boost",
};

/**
 * Whose cells an operator's customers use where its own do not reach.
 *
 * One entry, and it is a fact about this city's build rather than a general
 * rule. Boost is 5G-only here — n71, n70 and n77 from thirty-nine sites, with
 * no LTE layer at all — which is what a greenfield operator that never owned a
 * 4G network looks like. Its customers are therefore off-network wherever that
 * thin footprint runs out, and an LTE-only handset on a Boost SIM is
 * off-network everywhere. Both cases roam, and in the records they appear
 * exactly as they would in life: a 313/340 subscriber attached to a 310/410
 * cell.
 */
export const ROAMS_ONTO: Partial<Record<OperatorKey, OperatorKey>> = { boost: "att" };

/**
 * What a handset's radio can reach, as three nested tiers.
 *
 * Nested because that is how the hardware actually went: every phone here does
 * LTE, 5G arrived on the low and mid bands, and C-band came later and last to
 * the cheap end of the range. A tier is therefore a superset of the one below
 * and a capability check is a comparison rather than a set membership test.
 *
 *   LTE_ONLY    no NR radio at all
 *   SUB6        NR on low band and the mid bands below 3 GHz
 *   CBAND       and n77, the 3.4-3.8 GHz capacity layer
 */
export const LTE_ONLY = 0;
export const SUB6 = 1;
export const CBAND = 2;
export const TIERS = 3;

/**
 * Which tier a model belongs to, from its release year and market position.
 *
 * The years are the US deployment history and not a guess: no handset sold
 * before 2019 has an NR radio, C-band did not light up until January 2022 and
 * the phones that support it are the 2021 flagships onward, and the budget end
 * of the range took another two years to get there. A 2017 phone in this city
 * is LTE-only, will never appear on an NR cell, and that is a fact about the
 * device rather than a modelling choice.
 */
export function radioTier(released: number, tier: string): number {
  if (released < 2019 || (released === 2019 && tier !== "flagship")) return LTE_ONLY;
  if (released >= 2023) return CBAND;
  if (released >= 2021 && tier !== "budget") return CBAND;
  return SUB6;
}

/**
 * The layers a network is built in, as radio and role together.
 *
 * Named once here because two things key on it — the reselection priority in
 * `attach.ts` and the reporting in the checks — and a pair of strings compared
 * per candidate per minute is a hash and an allocation in the hottest loop the
 * simulation has. Cells resolve to an index into this list when they load.
 */
export const RADIO_LAYERS = [
  "LTE anchor", "LTE mid", "LTE capacity", "LTE firstnet",
  "NR anchor", "NR mid", "NR capacity", "NR firstnet",
] as const;
export type RadioLayer = (typeof RADIO_LAYERS)[number];

/** Which tier a cell's band demands of the handset that wants to use it. */
function bandTier(cell: CellRecord): number {
  if (cell.radio === "LTE") return LTE_ONLY;
  return cell.frequency_mhz >= 3000 ? CBAND : SUB6;
}

// ---------------------------------------------------------------------------
// The link budget
// ---------------------------------------------------------------------------

/**
 * Path loss by the surroundings of the *handset*, not of the mast.
 *
 * The planner labels each cell with a `morphology`, and the first version of
 * this file took the exponent from that label. It was the wrong end of the
 * link. Zoning puts masts on depot yards and rail strips, so 58% of cells are
 * "open", and an open-labelled mast on the edge of town then out-shouted the
 * dense-urban mast a downtown handset was standing under — the median home
 * was served from 2.5 km when its nearest site was 850 m away. What decides
 * how a signal decays is the district the handset is in, which is what Hata
 * and every measurement campaign since classify. So the label is looked up
 * from building density at the handset, on the same 1200 m radius and the
 * same thresholds `towers.py` uses to label sites.
 *
 * The shape is two-slope. Free space out to a breakpoint, then a steeper
 * exponent, plus a clutter constant. A single exponent anchored at one metre
 * cannot match measured loss: with 3.5 it runs 10 dB below Hata at a
 * kilometre and 20 dB below by three, and indoor coverage collapsed to 71% of
 * homes when the open-exponent accident above stopped hiding that. The
 * breakpoint and clutter here are fitted so that 700 MHz from a 30 m mast
 * lands on Okumura-Hata at one kilometre for each class — 124 dB urban, 114
 * suburban, 96 open — and the exponent then carries the difference beyond.
 * Free space is 2.0 and no real environment achieves it past the breakpoint.
 */
const MORPHOLOGY = ["open", "suburban", "urban", "dense urban"] as const;
/** Buildings per km² within MORPHOLOGY_RADIUS_M, ascending; `towers.py`'s table. */
const MORPHOLOGY_DENSITY = [0, 250, 800, 1600];
const MORPHOLOGY_RADIUS_M = 1200;
/** Metres of free-space propagation before the environment takes over. */
const BREAKPOINT_M = 200;
/** Exponent beyond the breakpoint, indexed as MORPHOLOGY. */
const EXPONENT = [2.9, 3.2, 3.5, 3.8];
/** dB of clutter loss, indexed as MORPHOLOGY, fitted at one kilometre. */
const CLUTTER = [0, 16, 24, 22];
/** The density raster the handset-side lookup reads. Same grid as `towers.py`. */
const DENSITY_CELL_M = 250;
/** Half-width of the raster in cells; 16 km each way holds the reach of every cell. */
const DENSITY_HALF = 64;
const LG_BREAKPOINT = Math.log10(BREAKPOINT_M);

/** Front-to-back ratio, dB. Beyond this an antenna is not more ignorable. */
const MAX_HORIZONTAL_LOSS = 25;
/** Vertical 3 dB beamwidth, degrees. A macro panel is narrow in elevation. */
const VERTICAL_BEAMWIDTH = 10;
const MAX_VERTICAL_LOSS = 20;

/** Where a handset is, which decides how much building is in the way. */
export const OUTDOOR = 0;
export const INDOOR = 1;
export const VEHICLE = 2;
export type Exposure = 0 | 1 | 2;

/**
 * Building and vehicle penetration loss in dB, by frequency.
 *
 * The frequency dependence is the whole reason the network has a low band. At
 * 600-900 MHz a wall costs something like 12 dB and a phone in the middle of a
 * house still hears the macro; at 3.7 GHz it is closer to 22 dB and the C-band
 * layer effectively stops at the front door, which is why capacity spectrum is
 * deployed where the people are outdoors and in the street.
 *
 * A car is a smaller version of the same effect — glass rather than masonry —
 * and the modern metallised windscreen is why it is not negligible.
 */
function penetration(frequencyMhz: number, exposure: Exposure): number {
  if (exposure === OUTDOOR) return 0;
  if (exposure === VEHICLE) return frequencyMhz < 1000 ? 6 : frequencyMhz < 3000 ? 8 : 11;
  return frequencyMhz < 1000 ? 12 : frequencyMhz < 3000 ? 17 : 23;
}

/**
 * Resource blocks, which turn a sector's total power into power per subcarrier.
 *
 * RSRP is defined per resource element, so a cell radiating its whole EIRP
 * across 100 MHz reports a *lower* RSRP than one putting the same power into
 * 10 MHz — and a phone therefore prefers the narrow low band by more than the
 * frequency alone would suggest. Leaving this out is the usual way a naive
 * model ends up parking everybody on C-band.
 */
function resourceBlocks(cell: CellRecord): number {
  if (cell.frequency_mhz >= 3000) return 273;
  if (cell.role === "anchor") return 50;
  return 100;
}

/**
 * Beamforming gain toward the served handset, in dB, by layer.
 *
 * Without this term the model gets the band mix badly wrong, and it is worth
 * saying why rather than quietly patching it. Arithmetic alone says a 1900 MHz
 * carrier arrives about twelve decibels below a 700 MHz one from the same
 * mast: eight or nine from the frequency, three more because the same power is
 * spread over twice the resource blocks. Measured against a real network that
 * gap is nowhere near twelve, and the first version of this file consequently
 * put ninety-nine percent of the city on the anchor layer and left a hundred
 * and fifty C-band cells carrying nothing at all.
 *
 * The missing physics is the antenna. A low-band sector in 2026 is still a
 * two-port panel radiating a fixed pattern, but the mid-band and C-band
 * sectors on the same steel are 32- and 64-port arrays that form a beam per
 * user. That beam is the entire commercial case for massive MIMO, it is worth
 * the better part of ten decibels toward whoever is being served, and it is
 * precisely what closes the gap the frequency opens.
 *
 * It belongs here rather than in `towers.py` because `eirp_dbm` is a property
 * of the site — what it is licensed and configured to radiate — while this is
 * a property of the link to one handset, which only exists once somebody is
 * standing somewhere.
 */
const ARRAY_GAIN: Record<string, number> = {
  "LTE anchor": 0,
  "LTE firstnet": 0,
  "LTE mid": 5,
  "LTE capacity": 7,
  "NR anchor": 0,
  "NR mid": 9,
  "NR capacity": 11,
};

/** Nominal transmit-side constant per cell, so the hot loop does no logs. */
interface Cached {
  /** EIRP less the spreading over resource elements: RSRP before path loss. */
  reference: number;
  /** Free-space loss at one metre for this frequency, dB. */
  fspl1m: number;
  azimuth: number;
  beamwidth: number;
  downtilt: number;
  height: number;
  frequency: number;
  tier: number;
  operator: number;
  /** Index into RADIO_LAYERS, which is what reselection priority keys on. */
  layer: number;
  x: number;
  y: number;
  /** Beyond this there is no point evaluating; well past the planning range. */
  reach: number;
}

/** Handset height above ground. Chest height, and only the tilt term cares. */
const UE_HEIGHT_M = 1.5;

/**
 * The weakest signal worth camping on, dBm.
 *
 * Below about -120 dBm RSRP a handset is at the edge of demodulating the
 * broadcast channel; the 3GPP minimum requirement sits just under this. A
 * point where nothing beats it is a coverage hole, and this city has a few in
 * the river valley, which is correct and should not be smoothed away.
 */
export const RSRP_FLOOR = -122;

/**
 * The strongest level a handset reports, dBm.
 *
 * The 3GPP measurement range for RSRP ends at -44, and a phone standing under
 * a mast reports that whatever the link budget says. The budget can say more:
 * free space to fifty metres from a 62 dBm sector is -30 before the vertical
 * pattern takes its capped twenty, and shadow fading can hand back half of
 * that. The clamp is applied after fading, in `attach.ts`, so the record
 * carries what a handset would have written and not what the arithmetic did.
 */
export const RSRP_CEILING = -44;

/**
 * Timing advance, which is the one thing a cell measures about distance.
 *
 * A cell tells every connected handset how far ahead of its own clock to
 * transmit so the uplink lands in the right slot, and that correction is the
 * round-trip flight time. On LTE the command is quantised to 16 samples of
 * the 30.72 MHz clock, which is 0.52 µs of round trip and 78.12 m of range —
 * so a handset reporting TA 12 is between 937 and 1,015 m from the antenna,
 * along the path the signal actually took. NR uses the same 78 m step at the
 * 15 kHz numerology the sub-6 layers here run, so one unit serves both.
 *
 * "The path the signal took" is the part that makes this a measurement rather
 * than a ruler. Indoors or behind a block the strongest ray is a reflection
 * and arrives late, so the value reads long by a distance that grows with how
 * built-up the surroundings are. The excess is drawn per handset tile and
 * cell, like the shadow term, so a phone on a bedside table reports the same
 * TA all night and the next street over reports a different one.
 */
export const TA_UNIT_M = 78.125;
/** Mean multipath excess in metres, indexed as MORPHOLOGY. Urban paths read long. */
const TA_EXCESS_M = [8, 20, 40, 60];
/** The 3GPP range: 11 bits of TA index, so a cell cannot see past 160 km. */
const TA_MAX = 1282;

const TILE_M = 50;
/** Bin size for the reach index. Bigger bins, fewer of them, longer lists. */
const BIN_M = 1000;
/** How many cells a tile keeps per operator and tier. */
const CANDIDATES = 6;

export class Cells {
  readonly records: readonly CellRecord[];
  readonly structures: ReadonlyMap<string, StructureRecord>;
  readonly centre: readonly [number, number];
  private readonly cached: Cached[];
  private readonly scale: number;
  /** Bin key to the cells whose reach covers it. Built once, read constantly. */
  private readonly bins = new Map<number, number[]>();
  /** Tile key and operator/tier to that tile's candidates. Grown on demand. */
  private readonly tiles = new Map<number, Uint16Array>();
  /** Morphology index per DENSITY_CELL_M raster cell, from building density. */
  private readonly morphology: Uint8Array;

  private constructor(
    records: CellRecord[],
    structures: StructureRecord[],
    centre: [number, number],
    buildings: readonly (readonly [number, number])[],
  ) {
    this.records = records;
    this.centre = centre;
    this.structures = new Map(structures.map((row) => [row.id, row]));
    this.scale = 111_320 * Math.cos((centre[0] * Math.PI) / 180);
    this.morphology = this.classify(buildings);

    this.cached = records.map((cell) => {
      const frequency = cell.frequency_mhz;
      // Free-space loss at one metre: 32.44 + 20log10(f MHz) + 20log10(d km)
      // at d = 1e-3 km. The distance term is added per handset in `rsrp`.
      const fspl1m = 20 * Math.log10(frequency) - 27.55;
      const layerName = `${cell.radio} ${cell.role}`;
      // A radio and role combination nobody has named is a new layer in
      // towers.json, and it must not resolve to -1 and quietly take the
      // priority and the array gain of whatever sits at the end of the table.
      if (!RADIO_LAYERS.includes(layerName as RadioLayer)) {
        throw new Error(`cell ${cell.id} is on layer "${layerName}", which RADIO_LAYERS does not name`);
      }
      return {
        reference:
          cell.eirp_dbm + (ARRAY_GAIN[layerName] ?? 0) -
          10 * Math.log10(12 * resourceBlocks(cell)),
        fspl1m,
        azimuth: cell.azimuth,
        beamwidth: cell.beamwidth,
        downtilt: cell.downtilt,
        height: Math.max(cell.height_m - UE_HEIGHT_M, 1),
        frequency,
        tier: bandTier(cell),
        operator: OPERATORS.indexOf(cell.operator_key as OperatorKey),
        layer: RADIO_LAYERS.indexOf(layerName as RadioLayer),
        ...this.project(cell.lat, cell.lon),
        // The planner's `range_m` is a design radius, not a hard edge; a cell
        // is still faintly audible well past it and a handset with nothing
        // better will camp there. Three times it, capped, is where evaluating
        // stops being worth the arithmetic rather than where the signal ends.
        reach: Math.min(cell.range_m * 3, 12_000),
      };
    });

    for (let index = 0; index < this.cached.length; index += 1) {
      const cell = this.cached[index]!;
      const span = Math.ceil(cell.reach / BIN_M);
      const bx = Math.floor(cell.x / BIN_M);
      const by = Math.floor(cell.y / BIN_M);
      for (let dx = -span; dx <= span; dx += 1) {
        for (let dy = -span; dy <= span; dy += 1) {
          const key = binKey(bx + dx, by + dy);
          const bucket = this.bins.get(key);
          if (bucket) bucket.push(index);
          else this.bins.set(key, [index]);
        }
      }
    }
  }

  static async open(): Promise<Cells> {
    const file = (await Bun.file(join(SIM_DATA_DIR, "towers.json")).json()) as {
      centre: [number, number];
      cell_records: CellRecord[];
      structure_records: StructureRecord[];
    };
    // Building positions classify the handset's surroundings. The world
    // loader reads the same file for its own purposes; here only the two
    // coordinates are kept, and the parse is a fraction of a second.
    const buildings = (await Bun.file(join(SIM_DATA_DIR, "buildings.json")).json()) as {
      points: [number, number, ...unknown[]][];
    };
    return new Cells(
      file.cell_records,
      file.structure_records,
      file.centre,
      buildings.points.map((point) => [point[0], point[1]] as const),
    );
  }

  /**
   * Morphology at every raster cell, from buildings per km² within
   * MORPHOLOGY_RADIUS_M — the same measure `towers.py` labels sites with,
   * applied at the other end of the link. Computed once; the hot path does
   * two integer divisions and an array read.
   */
  private classify(buildings: readonly (readonly [number, number])[]): Uint8Array {
    const side = DENSITY_HALF * 2;
    const counts = new Int32Array(side * side);
    for (const [lat, lon] of buildings) {
      const { x, y } = this.project(lat, lon);
      const gx = Math.floor(x / DENSITY_CELL_M) + DENSITY_HALF;
      const gy = Math.floor(y / DENSITY_CELL_M) + DENSITY_HALF;
      if (gx < 0 || gy < 0 || gx >= side || gy >= side) continue;
      counts[gx * side + gy] += 1;
    }
    const reach = Math.floor(MORPHOLOGY_RADIUS_M / DENSITY_CELL_M) + 1;
    const disc: [number, number][] = [];
    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        if (Math.hypot(dx, dy) * DENSITY_CELL_M <= MORPHOLOGY_RADIUS_M) disc.push([dx, dy]);
      }
    }
    const area = Math.PI * (MORPHOLOGY_RADIUS_M / 1000) ** 2;
    const out = new Uint8Array(side * side);
    for (let gx = 0; gx < side; gx += 1) {
      for (let gy = 0; gy < side; gy += 1) {
        let total = 0;
        for (const [dx, dy] of disc) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (cx < 0 || cy < 0 || cx >= side || cy >= side) continue;
          total += counts[cx * side + cy]!;
        }
        const density = total / area;
        let label = 0;
        while (label + 1 < MORPHOLOGY_DENSITY.length && density >= MORPHOLOGY_DENSITY[label + 1]!) label += 1;
        out[gx * side + gy] = label;
      }
    }
    return out;
  }

  /** Morphology index (into MORPHOLOGY) at a projected point. Open off-raster. */
  morphologyAt(x: number, y: number): number {
    const side = DENSITY_HALF * 2;
    const gx = Math.floor(x / DENSITY_CELL_M) + DENSITY_HALF;
    const gy = Math.floor(y / DENSITY_CELL_M) + DENSITY_HALF;
    if (gx < 0 || gy < 0 || gx >= side || gy >= side) return 0;
    return this.morphology[gx * side + gy]!;
  }

  /** The morphology label at a projected point, for reports. */
  morphologyLabelAt(x: number, y: number): string {
    return MORPHOLOGY[this.morphologyAt(x, y)]!;
  }

  /** Metres east and north of the city centre. Planar, which is exact enough. */
  project(lat: number, lon: number): { x: number; y: number } {
    return { x: (lon - this.centre[1]) * this.scale, y: (lat - this.centre[0]) * 111_320 };
  }

  /** RSRP in dBm at a projected point, before any per-person fading. */
  rsrp(index: number, x: number, y: number, exposure: Exposure): number {
    const cell = this.cached[index]!;
    const dx = x - cell.x;
    const dy = y - cell.y;
    // Never let the ground distance fall below one metre: the log-distance
    // model is anchored there and a person standing at the foot of the mast
    // would otherwise be handed an infinite signal.
    const ground = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const slant = Math.sqrt(ground * ground + cell.height * cell.height);

    // Two-slope: free space to the breakpoint, then the handset-side
    // environment's exponent and clutter. See the table above `MORPHOLOGY`.
    const morphology = this.morphologyAt(x, y);
    const lg = Math.log10(slant);
    const loss = cell.fspl1m + CLUTTER[morphology]! + (lg <= LG_BREAKPOINT
      ? 20 * lg
      : 20 * LG_BREAKPOINT + EXPONENT[morphology]! * 10 * (lg - LG_BREAKPOINT));

    // Horizontal: the 3GPP parabolic pattern, 12(θ/θ3dB)² with θ3dB the
    // file's full 3 dB beamwidth, on the smaller of the two angles between
    // the sector's boresight and the handset. That puts 3 dB at the half-
    // width edge, which is what the width means. An earlier 2θ/θ3dB put
    // 12 dB there and 25 dB between two sectors of the same site, and a
    // handset between sectors then camped on a distant site instead.
    const compass = (Math.atan2(dx, dy) * 180) / Math.PI;
    let offAxis = Math.abs(compass - cell.azimuth) % 360;
    if (offAxis > 180) offAxis = 360 - offAxis;
    const ratio = offAxis / cell.beamwidth;
    const horizontal = Math.min(12 * ratio * ratio, MAX_HORIZONTAL_LOSS);

    // Vertical: the elevation angle down from the antenna to the handset,
    // against where the antenna is actually pointed.
    const elevation = (Math.atan2(cell.height, ground) * 180) / Math.PI;
    const offTilt = (elevation - cell.downtilt) / VERTICAL_BEAMWIDTH;
    const vertical = Math.min(12 * offTilt * offTilt, MAX_VERTICAL_LOSS);

    return cell.reference - loss - horizontal - vertical - penetration(cell.frequency, exposure);
  }

  /**
   * The timing advance a cell would command a handset at a projected point,
   * in TA units of TA_UNIT_M, given a uniform draw in (0, 1] for the
   * multipath excess. See the note above TA_UNIT_M.
   */
  timingAdvance(index: number, x: number, y: number, draw: number): number {
    const cell = this.cached[index]!;
    const dx = x - cell.x;
    const dy = y - cell.y;
    const slant = Math.sqrt(dx * dx + dy * dy + cell.height * cell.height);
    // An exponential excess: most paths are nearly direct, a few are well off.
    const excess = -TA_EXCESS_M[this.morphologyAt(x, y)]! * Math.log(Math.max(draw, 1e-9));
    return Math.min(TA_MAX, Math.floor((slant + excess) / TA_UNIT_M));
  }

  /** Metres from the antenna to a projected point, along the slant. */
  distanceTo(index: number, x: number, y: number): number {
    const cell = this.cached[index]!;
    const dx = x - cell.x;
    const dy = y - cell.y;
    return Math.sqrt(dx * dx + dy * dy + cell.height * cell.height);
  }

  operatorOf(index: number): number {
    return this.cached[index]!.operator;
  }

  tierOf(index: number): number {
    return this.cached[index]!.tier;
  }

  /** Index into RADIO_LAYERS for one cell. */
  layerOf(index: number): number {
    return this.cached[index]!.layer;
  }

  trackingAreaOf(index: number): number {
    return this.records[index]!.tracking_area;
  }

  /** The tile a projected point falls in, as one packed integer. */
  tile(x: number, y: number): number {
    return tileKey(Math.floor(x / TILE_M), Math.floor(y / TILE_M));
  }

  /**
   * The cells worth considering in a tile, for one operator and radio tier.
   *
   * Computed on first visit and kept. Ranked on the better of the indoor and
   * outdoor score so that walking through a door re-ranks the list it already
   * has rather than needing a different one.
   */
  candidates(tile: number, operator: number, tier: number): Uint16Array {
    const key = tile * (OPERATORS.length * TIERS) + operator * TIERS + tier;
    const known = this.tiles.get(key);
    if (known) return known;

    const tx = ((tile / 8192) | 0) - 4096;
    const ty = (tile % 8192) - 4096;
    // The tile's middle, not its corner: the candidate list stands for every
    // point inside it and the centre is the least wrong of them.
    const x = (tx + 0.5) * TILE_M;
    const y = (ty + 0.5) * TILE_M;

    const nearby = this.bins.get(binKey(Math.floor(x / BIN_M), Math.floor(y / BIN_M))) ?? [];
    const best: number[] = [];
    const scores: number[] = [];
    for (const index of nearby) {
      const cell = this.cached[index]!;
      if (cell.operator !== operator || cell.tier > tier) continue;
      const outdoor = this.rsrp(index, x, y, OUTDOOR);
      const indoor = this.rsrp(index, x, y, INDOOR);
      // Outdoors is scored against the floor and indoors against a lower one:
      // a phone in a basement is not disqualified from a cell it can hear.
      if (outdoor < RSRP_FLOOR && indoor < RSRP_FLOOR - 8) continue;
      const rank = Math.max(outdoor, indoor);
      let at = best.length;
      while (at > 0 && scores[at - 1]! < rank) at -= 1;
      if (at >= CANDIDATES) continue;
      best.splice(at, 0, index);
      scores.splice(at, 0, rank);
      if (best.length > CANDIDATES) { best.pop(); scores.pop(); }
    }

    const packed = new Uint16Array(best);
    this.tiles.set(key, packed);
    return packed;
  }

  /** How many tiles have been evaluated, which is a cost worth reporting. */
  get evaluated(): number {
    return this.tiles.size;
  }
}

function binKey(x: number, y: number): number {
  return (x + 512) * 1024 + (y + 512);
}

function tileKey(x: number, y: number): number {
  return (x + 4096) * 8192 + (y + 4096);
}

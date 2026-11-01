/**
 * The cellular network: the structures that carry antennas, and the cells on
 * them.
 *
 * Two tables, because the file has two and the difference is the point. A
 * STRUCTURE is a physical object at a coordinate — a monopole, a lattice, a
 * rooftop — with a height and an owner, and the owner is usually a tower
 * company rather than a carrier. A CELL is one operator's one sector on one
 * band transmitting from a structure, and it is what a call record names.
 * Colocation is the norm here: three operators can transmit from one mast with
 * entirely unrelated identifiers, so a viewer that drew a cell as a dot would
 * be drawing three dots on one pole and calling them three sites.
 *
 * What this file adds to what towers.py wrote
 * -------------------------------------------
 * The join from cell to structure, the tracking areas rolled up out of the
 * cells that carry them, and the geometry — a sector wedge from an azimuth, a
 * beamwidth and a range, and a hull around each tracking area. Nothing here
 * re-derives a decision the generator made; the hull in particular is drawn
 * around the sites that report an area rather than around the angular wedge
 * towers.py cut, so if that rule changes the drawing follows the data.
 *
 * The ranges are indicative
 * -------------------------
 * `range_m` is a planning estimate — base radius for the morphology, scaled by
 * frequency and antenna height. It is not who the cell serves. Who a cell
 * serves is a path-loss calculation against a real position at a real minute,
 * which only the simulation can do. A wedge on this map says "this is roughly
 * what this sector is pointed at and roughly how far it reaches", and two
 * overlapping wedges do not mean a handset sees both.
 */

// ---- The file ---------------------------------------------------------------

export interface TowerSource {
  source: string;
  url?: string;
  license: string;
  retrieved?: string;
  file_creation_date?: string;
  note?: string;
}

export interface StructureRecord {
  id: string;
  source: "asr" | "modelled";
  asr: string | null;
  lat: number;
  lon: number;
  structure: string;
  structure_type: string;
  height_m: number;
  building_levels?: number | null;
  owner: string | null;
  in_city: boolean;
}

export interface CellRecord {
  id: string;
  structure: string;
  operator: string;
  operator_key: string;
  mcc: string;
  mnc: string;
  radio: "LTE" | "NR";
  band: string;
  role: CellRole;
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

export interface TowerFile {
  seed: number;
  city: string;
  centre: [number, number];
  structures_source: TowerSource;
  identifiers_source: TowerSource;
  structures: number;
  cells: number;
  structure_records: StructureRecord[];
  cell_records: CellRecord[];
}

export type CellRole = "anchor" | "mid" | "capacity" | "firstnet";

// ---- What the viewer works with ---------------------------------------------

export interface Site extends StructureRecord {
  index: number;
  /** Indices into `Network.cells`, in the file's order. */
  cells: number[];
  /** Operator keys transmitting from here, in the order they first appear. */
  tenants: string[];
  /** The furthest any sector on this structure claims to reach. */
  reach: number;
}

export interface Cell extends CellRecord {
  index: number;
  /** Index into `Network.sites`. */
  site: number;
}

export interface Operator {
  key: string;
  label: string;
  color: string;
  mcc: string;
  mnc: string;
  cells: number;
  sites: number;
  /** Structures this operator's own name is on the registration of. */
  owned: number;
}

export interface BandInfo {
  label: string;
  radio: "LTE" | "NR";
  frequency: number;
  role: CellRole;
  color: string;
  cells: number;
  /** Median indicative range, which is most of why a band is worth naming. */
  reach: number;
}

export interface TrackingArea {
  /** The tracking area code itself — what a call record carries. */
  tac: number;
  operator: string;
  operatorLabel: string;
  color: string;
  cells: number;
  sites: number;
  /** Convex hull of the sites reporting this area, closed. */
  hull: [number, number][];
  centre: [number, number];
}

export const ROLES: { id: CellRole; label: string; hint: string }[] = [
  {
    id: "anchor",
    label: "Anchor",
    hint: "Low band",
  },
  {
    id: "mid",
    label: "Mid-band",
    hint: "1.9–2.5 GHz",
  },
  {
    id: "capacity",
    label: "Capacity",
    hint: "C-band, 2.5 GHz",
  },
  {
    id: "firstnet",
    label: "FirstNet",
    hint: "AT&T Band 14, public safety",
  },
];

export const ROLE_LABEL: Record<CellRole, string> = {
  anchor: "Anchor", mid: "Mid-band", capacity: "Capacity", firstnet: "FirstNet",
};

export const ROLE_COLOR: Record<CellRole, string> = {
  anchor: "#1baf7a",
  mid: "#2a78d6",
  capacity: "#8a4fd0",
  firstnet: "#d0021b",
};

/**
 * Carrier colours, taken from the liveries a reader already associates with
 * each name — the map is read against a legend, and a legend that called
 * T-Mobile blue would be fought every time.
 */
export const OPERATOR_COLOR: Record<string, string> = {
  verizon: "#d0021b",
  att: "#2a78d6",
  tmobile: "#e6178b",
  boost: "#f5691f",
};

const FALLBACK_COLOR = "#8a97a3";

/** Structures the ASR knows about, against the ones this pipeline inferred. */
export const SOURCE_LABEL: Record<string, string> = {
  asr: "FCC registered",
  modelled: "Modelled rooftop",
};

export const SOURCE_COLOR: Record<string, string> = {
  asr: "#3d4b57",
  modelled: "#00a0a8",
};

// ---- Colour ------------------------------------------------------------------

/** Mix a hex colour toward white (positive) or black (negative). */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const base = (value >> shift) & 0xff;
    const mixed = amount >= 0
      ? base + (255 - base) * amount
      : base * (1 + amount);
    return Math.round(Math.max(0, Math.min(255, mixed)));
  };
  const out = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return `#${out.toString(16).padStart(6, "0")}`;
}

/**
 * A tracking area's colour: its operator's hue, its index within that operator
 * as lightness.
 *
 * Twelve areas need twelve colours, and twelve unrelated hues would say the
 * areas are twelve unrelated things. They are not — they are three districts
 * numbered four times over, once per carrier, and which carrier is the first
 * thing a reader needs off the map.
 */
function areaColor(operator: string, index: number): string {
  const base = OPERATOR_COLOR[operator] ?? FALLBACK_COLOR;
  return shade(base, [-0.28, 0, 0.36][index % 3]);
}

/**
 * The ramp the bands are coloured along, warm to cool.
 *
 * Bands are not categories to a reader looking at coverage — they are the
 * reason one wedge is three times the other, and the ordering that explains
 * that is the frequency. Low band is warm and wide, C-band is cool and small.
 */
const BAND_RAMP: [number, number, number][] = [
  [176, 32, 32],
  [235, 104, 52],
  [240, 168, 0],
  [47, 168, 79],
  [22, 103, 216],
  [138, 79, 208],
];

/**
 * A colour at `t` along that ramp, 0 to 1.
 *
 * Sampled by position in the frequency-ordered band list rather than by the
 * frequency itself, which sounds like the wrong choice and is not: the twelve
 * bands cluster at 600–900 MHz and again at 2 GHz, so ramping on the number
 * gave four low bands four shades of the same orange. Spacing them evenly
 * keeps the ordering the ramp is there to show and makes all twelve legible
 * against a legend — and it separates B5 from n5, which are the same 869 MHz
 * and would otherwise be the same colour on a map where one is LTE and the
 * other is 5G.
 */
function rampColor(t: number): string {
  const scaled = Math.max(0, Math.min(1, t)) * (BAND_RAMP.length - 1);
  const index = Math.min(BAND_RAMP.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const mix = (i: number) =>
    Math.round(BAND_RAMP[index][i] + (BAND_RAMP[index + 1][i] - BAND_RAMP[index][i]) * frac);
  return `#${((mix(0) << 16) | (mix(1) << 8) | mix(2)).toString(16).padStart(6, "0")}`;
}

// ---- Geometry ----------------------------------------------------------------

const EARTH_M = 6_371_000;

/**
 * A point `metres` away from (lat, lon) on a compass bearing.
 *
 * Equirectangular rather than great-circle: the furthest thing drawn here is
 * an 8 km range ring, where the two agree to well under a metre, and the whole
 * map is one city.
 */
export function offset(
  lat: number, lon: number, bearing: number, metres: number,
): [number, number] {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / EARTH_M;
  const dLon = (metres * Math.sin(rad)) / (EARTH_M * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
}

/**
 * The wedge one sector claims: the mast, an arc of `beamwidth` about the
 * azimuth at `range_m`, and back to the mast.
 *
 * Drawn to the half-power beamwidth, which is where the sector is a sector and
 * not a circle. A real antenna radiates outside it — into the next sector's
 * arc, mostly, which is exactly the overlap that makes a serving cell a
 * decision rather than a lookup.
 */
export function sectorWedge(cell: Cell, steps = 12): [number, number][] {
  const half = cell.beamwidth / 2;
  const points: [number, number][] = [[cell.lat, cell.lon]];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = cell.azimuth - half + (cell.beamwidth * i) / steps;
    points.push(offset(cell.lat, cell.lon, bearing, cell.range_m));
  }
  points.push([cell.lat, cell.lon]);
  return points;
}

/** Andrew's monotone chain, in degrees — the areas are small and flat enough. */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);

  const half = (input: [number, number][]) => {
    const out: [number, number][] = [];
    for (const point of input) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) {
        out.pop();
      }
      out.push(point);
    }
    out.pop();
    return out;
  };

  return [...half(sorted), ...half(sorted.reverse())];
}

// ---- The network -------------------------------------------------------------

export class Network {
  readonly seed: number;
  readonly centre: [number, number];
  readonly structuresSource: TowerSource;
  readonly identifiersSource: TowerSource;

  readonly sites: Site[] = [];
  readonly cells: Cell[] = [];
  readonly operators: Operator[] = [];
  readonly bands: BandInfo[] = [];
  readonly areas: TrackingArea[] = [];

  /** Structure id to index, for the cell join and for a search by site. */
  private readonly siteById = new Map<string, number>();
  private readonly areaByKey = new Map<string, TrackingArea>();

  constructor(file: TowerFile) {
    this.seed = file.seed;
    this.centre = file.centre;
    this.structuresSource = file.structures_source;
    this.identifiersSource = file.identifiers_source;

    for (const record of file.structure_records) {
      const index = this.sites.length;
      this.siteById.set(record.id, index);
      this.sites.push({ ...record, index, cells: [], tenants: [], reach: 0 });
    }

    for (const record of file.cell_records) {
      const index = this.cells.length;
      const site = this.siteById.get(record.structure) ?? -1;
      this.cells.push({ ...record, index, site });
      if (site < 0) continue;
      const host = this.sites[site];
      host.cells.push(index);
      host.reach = Math.max(host.reach, record.range_m);
      if (!host.tenants.includes(record.operator_key)) host.tenants.push(record.operator_key);
    }

    this.operators = this.rollUpOperators();
    this.bands = this.rollUpBands();
    this.areas = this.rollUpAreas();
    for (const area of this.areas) this.areaByKey.set(`${area.operator}/${area.tac}`, area);
  }

  private rollUpOperators(): Operator[] {
    const found = new Map<string, Operator>();
    const sitesSeen = new Map<string, Set<number>>();

    for (const cell of this.cells) {
      let operator = found.get(cell.operator_key);
      if (!operator) {
        operator = {
          key: cell.operator_key,
          label: cell.operator,
          color: OPERATOR_COLOR[cell.operator_key] ?? FALLBACK_COLOR,
          mcc: cell.mcc,
          mnc: cell.mnc,
          cells: 0,
          sites: 0,
          owned: 0,
        };
        found.set(cell.operator_key, operator);
        sitesSeen.set(cell.operator_key, new Set());
      }
      operator.cells += 1;
      sitesSeen.get(cell.operator_key)!.add(cell.site);
    }

    for (const [key, sites] of sitesSeen) {
      const operator = found.get(key)!;
      operator.sites = sites.size;
      // Whose name is on the registration, which is a different question from
      // who transmits — AT&T owns nothing here and is on the air everywhere.
      for (const index of sites) {
        const owner = (this.sites[index].owner ?? "").toLowerCase();
        if (owner && ownerMatches(owner, key)) operator.owned += 1;
      }
    }

    return [...found.values()].sort((a, b) => b.cells - a.cells);
  }

  private rollUpBands(): BandInfo[] {
    const found = new Map<string, { info: BandInfo; ranges: number[] }>();
    for (const cell of this.cells) {
      let entry = found.get(cell.band);
      if (!entry) {
        entry = {
          info: {
            label: cell.band,
            radio: cell.radio,
            frequency: cell.frequency_mhz,
            role: cell.role,
            color: "#8a97a3",
            cells: 0,
            reach: 0,
          },
          ranges: [],
        };
        found.set(cell.band, entry);
      }
      entry.info.cells += 1;
      entry.ranges.push(cell.range_m);
    }

    const bands = [...found.values()]
      .map(({ info, ranges }) => {
        ranges.sort((a, b) => a - b);
        info.reach = ranges[Math.floor(ranges.length / 2)] ?? 0;
        return info;
      })
      // Ordered by frequency, so the legend reads as the ramp it is coloured
      // on. Two bands on the same frequency are separated by label, which is
      // arbitrary and only has to be stable.
      .sort((a, b) => a.frequency - b.frequency || a.label.localeCompare(b.label));

    bands.forEach((band, index) => {
      band.color = rampColor(index / Math.max(1, bands.length - 1));
    });
    return bands;
  }

  private rollUpAreas(): TrackingArea[] {
    const found = new Map<string, {
      area: TrackingArea; points: [number, number][]; sites: Set<number>;
    }>();

    for (const cell of this.cells) {
      const key = `${cell.operator_key}/${cell.tracking_area}`;
      let entry = found.get(key);
      if (!entry) {
        entry = {
          area: {
            tac: cell.tracking_area,
            operator: cell.operator_key,
            operatorLabel: cell.operator,
            color: FALLBACK_COLOR,
            cells: 0,
            sites: 0,
            hull: [],
            centre: [cell.lat, cell.lon],
          },
          points: [],
          sites: new Set(),
        };
        found.set(key, entry);
      }
      entry.area.cells += 1;
      if (!entry.sites.has(cell.site)) {
        entry.sites.add(cell.site);
        entry.points.push([cell.lat, cell.lon]);
      }
    }

    const byOperator = new Map<string, number>();
    const areas = [...found.values()]
      .sort((a, b) => a.area.operator.localeCompare(b.area.operator) || a.area.tac - b.area.tac)
      .map(({ area, points, sites }) => {
        const index = byOperator.get(area.operator) ?? 0;
        byOperator.set(area.operator, index + 1);
        area.color = areaColor(area.operator, index);
        area.sites = sites.size;
        area.hull = convexHull(points);
        area.centre = [
          points.reduce((sum, p) => sum + p[0], 0) / (points.length || 1),
          points.reduce((sum, p) => sum + p[1], 0) / (points.length || 1),
        ];
        return area;
      });

    // Operators in the order the legend uses them, areas ascending within.
    const rank = new Map(this.operators.map((operator, i) => [operator.key, i]));
    return areas.sort(
      (a, b) => (rank.get(a.operator) ?? 9) - (rank.get(b.operator) ?? 9) || a.tac - b.tac,
    );
  }

  siteOf(id: string): Site | null {
    const index = this.siteById.get(id);
    return index === undefined ? null : this.sites[index];
  }

  area(operator: string, tac: number): TrackingArea | null {
    return this.areaByKey.get(`${operator}/${tac}`) ?? null;
  }

  operator(key: string): Operator | null {
    return this.operators.find((entry) => entry.key === key) ?? null;
  }

  /** Structures the FCC has a registration for, against inferred rooftops. */
  get registered(): number {
    return this.sites.reduce((sum, site) => sum + (site.source === "asr" ? 1 : 0), 0);
  }

  /** Structures carrying more than one operator — the colocation the file is for. */
  get colocated(): number {
    return this.sites.reduce((sum, site) => sum + (site.tenants.length > 1 ? 1 : 0), 0);
  }
}

/** Whether a registration's owner name belongs to a carrier we know. */
function ownerMatches(owner: string, key: string): boolean {
  const names: Record<string, string[]> = {
    verizon: ["smsa", "verizon", "cellco"],
    att: ["at&t", "new cingular"],
    tmobile: ["t-mobile", "omnipoint", "sprint", "stc "],
    boost: [],
  };
  return (names[key] ?? []).some((name) => owner.includes(name));
}

/** A cell's own name for a legend or a list — "Verizon B13 · sector 2". */
export function cellLabel(cell: Cell): string {
  return `${cell.operator} ${cell.band} · sector ${cell.sector + 1}`;
}

/** The structure's kind, capitalised, with the ASR's own code where it has one. */
export function structureLabel(site: Site): string {
  const kind = site.structure.trim();
  if (!kind) return "Unrecorded structure";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Where a car actually ends up, which is not where its driver was going.
 *
 * The first version of this sent every driving trip to the nearest
 * `amenity=parking` POI, and that is wrong for most of Kierston. Downtown
 * the reference city parks at the kerb: Hamilton, Linden, Turner, the numbered streets
 * and nearly every residential block off them carry metered or unrestricted
 * kerbside parking, and a driver going to a downtown address takes a space on
 * the street and walks the last fifty metres. Lots and decks are the fallback
 * when the kerb is full, not the default.
 *
 * So kerbside supply is estimated rather than assumed, from the one thing that
 * is genuinely known about every block: how much road there is. The car graph
 * has every drivable way with its length and class, so the kerb length within
 * a short walk of a destination is a sum over edges, and the number of spaces
 * that length holds is that sum divided by the length of a parked car plus
 * clearance, discounted for everything that eats kerb without parking on it.
 *
 *     spaces  =  Σ length(edge) × sides(class) / 6.5 m  ×  usable share
 *
 * Demand is the crude half and is a placeholder in the same sense as the spend
 * shares: POI count within the same radius stands in for how many people want
 * to be here, scaled by hour. What would replace it is the simulation's own
 * output — count the vehicles the sim parks in each cell in each ten-minute
 * bin and feed that back as the occupancy, which closes the loop the same way
 * network loading would for congestion.
 */

import type { Point } from "../world/index.ts";
import { LAYER, MINUTES_PER_DAY, stream } from "../shared/index.ts";
import type { Roads } from "./routing.ts";

export type ParkingKind = "driveway" | "kerb" | "lot" | "deck";

export interface Parking {
  kind: ParkingKind;
  /** Where the vehicle is left. Differs from the destination for kerb and deck. */
  at: Point;
  /** Minutes spent circling before a space was found. */
  searchMinutes: number;
  /** Minutes walking from the space to the door. */
  walkMinutes: number;
  /** Metres between the space and the destination. */
  metres: number;
}

/** Metres of kerb one parked car occupies, including the gap to the next one. */
const CAR_LENGTH_M = 6.5;

/**
 * How many sides of a street park, by highway class. A residential street
 * parks both sides; an arterial parks one at best and often neither; a
 * motorway does not park. Service roads are parking aisles and driveways —
 * they are counted at nothing here because whatever they serve is counted
 * separately as a lot.
 */
const KERB_SIDES: Record<string, number> = {
  residential: 2,
  living_street: 2,
  unclassified: 1.4,
  tertiary: 1.2,
  tertiary_link: 0,
  secondary: 0.7,
  secondary_link: 0,
  primary: 0.4,
  primary_link: 0,
  road: 1,
  trunk: 0,
  trunk_link: 0,
  motorway: 0,
  motorway_link: 0,
  service: 0,
  busway: 0,
};

/**
 * The share of nominal kerb that is actually parkable. Driveways, hydrants,
 * crossings, bus stops, loading zones, corner clearances and the bits nobody
 * parks on. 0.55 is the figure kerb inventories in comparable American grids
 * tend to land near, and it is the single number here most worth replacing
 * with a measured one.
 */
const USABLE_KERB = 0.55;

/** How far someone will walk from a space, by how urban the destination is. */
const WALK_RADIUS_M = 220;
const WALK_SPEED_M_PER_MIN = 78;

interface Cell {
  spaces: number;
  demand: number;
}

export class Kerb {
  private readonly cells = new Map<number, Cell>();
  private readonly cellDegLat: number;
  private readonly cellDegLon: number;
  private readonly cellMetres = 250;

  private constructor(
    private readonly roads: Roads,
    private readonly lots: Point[],
    centreLat: number,
  ) {
    this.cellDegLat = this.cellMetres / 111_320;
    this.cellDegLon = this.cellMetres / (111_320 * Math.cos((centreLat * Math.PI) / 180));
  }

  /**
   * Build the supply grid once, in a single pass over the graph's edges.
   *
   * Each edge contributes its kerb to the cell its source node sits in. At 250
   * metres a cell is about a block and a half, which is the scale a driver
   * actually searches at — nobody drives four blocks to a space they cannot
   * see, and nobody gives up on the one round the corner.
   */
  static build(roads: Roads, poiPoints: Point[], lots: Point[]): Kerb {
    const graph = roads.graph;
    const centre = (graph.bbox.minLat + graph.bbox.maxLat) / 2;
    const kerb = new Kerb(roads, lots, centre);

    for (let node = 0; node < graph.nodeCount; node += 1) {
      const cell = kerb.cellFor(graph.lat[node]!, graph.lon[node]!);
      for (let slot = graph.offset[node]!; slot < graph.offset[node + 1]!; slot += 1) {
        const className = graph.classes[graph.classId[slot]!] ?? "residential";
        const sides = KERB_SIDES[className] ?? 1;
        if (sides === 0) continue;
        // Each direction of a two-way street appears as its own edge, so the
        // length is halved to avoid counting the same kerb twice.
        const metres = (graph.length[slot]! / 2) * sides;
        kerb.bump(cell, (metres / CAR_LENGTH_M) * USABLE_KERB, 0);
      }
    }

    for (const poi of poiPoints) kerb.bump(kerb.cellFor(poi.lat, poi.lon), 0, 1);
    return kerb;
  }

  private cellFor(lat: number, lon: number): number {
    const row = Math.floor(lat / this.cellDegLat);
    const col = Math.floor(lon / this.cellDegLon);
    return row * 100_000 + col;
  }

  private bump(cell: number, spaces: number, demand: number): void {
    const existing = this.cells.get(cell);
    if (existing) {
      existing.spaces += spaces;
      existing.demand += demand;
    } else {
      this.cells.set(cell, { spaces, demand });
    }
  }

  /** Supply and demand in the cell a point falls in, plus its eight neighbours. */
  private around(point: Point): Cell {
    const row = Math.floor(point.lat / this.cellDegLat);
    const col = Math.floor(point.lon / this.cellDegLon);
    let spaces = 0;
    let demand = 0;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const cell = this.cells.get((row + dr) * 100_000 + (col + dc));
        if (cell) {
          spaces += cell.spaces;
          demand += cell.demand;
        }
      }
    }
    return { spaces, demand };
  }

  /**
   * Kerb occupancy at a point, 0 to just under 1.
   *
   * Demand per space is the ratio that matters, not either number alone: a
   * downtown block has plenty of kerb and far more competition for it than a
   * cul-de-sac with none. The hour curve is the working day — the kerb outside
   * an office fills at 09:00 and empties at 18:00, the kerb outside a bar does
   * the opposite, and this does not yet know the difference.
   */
  occupancy(point: Point, minute: number): number {
    const { spaces, demand } = this.around(point);
    if (spaces < 1) return 1;
    const pressure = (demand * 9) / spaces;
    const hour = Math.floor((((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60);
    const curve = HOUR_PRESSURE[hour]!;
    return Math.min(0.985, 1 - Math.exp(-pressure * curve));
  }

  /**
   * Park a car arriving at `destination` at `minute`.
   *
   * `atHome` short-circuits everything: a dwelling parks in its own driveway or
   * directly outside, and the 34,950 homes in the extract are overwhelmingly
   * not downtown. Everywhere else, the kerb is tried first and a lot or deck
   * catches whatever the kerb turns away.
   */
  park(destination: Point, minute: number, seed: number, person: number, atHome: boolean): Parking {
    if (atHome) {
      return { kind: "driveway", at: destination, searchMinutes: 0, walkMinutes: 0, metres: 0 };
    }

    const rng = stream(seed, person, LAYER.parking, Math.floor(minute));
    const busy = this.occupancy(destination, minute);

    if (rng.next() > busy) {
      // A space on the street. How far away it is scales with how full the
      // kerb was — at 30% occupancy it is outside the door, at 90% it is the
      // next street but one.
      const metres = Math.round(WALK_RADIUS_M * busy * rng.between(0.3, 1.1));
      return {
        kind: "kerb",
        at: offset(destination, metres, rng.next() * 2 * Math.PI),
        searchMinutes: Math.round(busy * busy * rng.between(0, 7) * 10) / 10,
        walkMinutes: Math.round((metres / WALK_SPEED_M_PER_MIN) * 10) / 10,
        metres,
      };
    }

    const lot = this.nearestLot(destination);
    if (!lot) {
      // No kerb, no lot — the destination has its own ground, which is the
      // normal suburban case: a strip mall or an office park with a field of
      // spaces nobody bothered to tag.
      return { kind: "lot", at: destination, searchMinutes: rng.between(0.5, 2), walkMinutes: rng.between(0.5, 2), metres: 60 };
    }
    const metres = Math.round(haversineMetres(destination, lot.point));
    return {
      kind: lot.deck ? "deck" : "lot",
      at: lot.point,
      searchMinutes: Math.round(rng.between(1, lot.deck ? 5 : 3) * 10) / 10,
      walkMinutes: Math.round((metres / WALK_SPEED_M_PER_MIN) * 10) / 10,
      metres,
    };
  }

  private nearestLot(point: Point): { point: Point; deck: boolean } | null {
    let best: Point | null = null;
    let bestMetres = 600;
    for (const lot of this.lots) {
      const metres = haversineMetres(point, lot);
      if (metres < bestMetres) {
        bestMetres = metres;
        best = lot;
      }
    }
    // A lot more than 250 m from the destination is being used as a deck: you
    // are parking in a structure and walking, not pulling up outside.
    return best ? { point: best, deck: bestMetres > 250 } : null;
  }
}

/** Relative pressure on the kerb through the day. */
const HOUR_PRESSURE = [
  0.25, 0.2, 0.18, 0.18, 0.2, 0.3, 0.5, 0.75, 0.95, 1.0, 0.95, 0.95,
  1.0, 0.98, 0.95, 0.95, 0.98, 1.0, 0.9, 0.8, 0.72, 0.65, 0.5, 0.35,
];

function haversineMetres(a: Point, b: Point): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) ** 2 * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function offset(point: Point, metres: number, bearing: number): Point {
  const dLat = (metres * Math.cos(bearing)) / 111_320;
  const dLon = (metres * Math.sin(bearing)) / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  return { lat: point.lat + dLat, lon: point.lon + dLon };
}

/**
 * Routing for the simulation, over the pathfinder's own graph.
 *
 * In-process, not over HTTP. The pathfinder's server exists so a map in a
 * browser can ask it questions; a simulation asking a million questions a
 * simulated day should not pay for a round trip and a JSON encode to get an
 * answer that is two numbers long.
 *
 * Two things are added on top of `Router`:
 *
 *   caching     a town's trips are not uniformly distributed over its road
 *               network. The same origin-destination node pairs recur
 *               constantly — every household on a street shares a snap node,
 *               and 46k households resolve to far fewer distinct pairs than
 *               there are trips. The cache is keyed on the snapped node pair
 *               and holds the free-flow result, which is the expensive part.
 *
 *   congestion  the graph is free-flow by construction, so the cached duration
 *               is scaled at use time by the hour the trip departs. Keeping the
 *               scaling outside the cache is what lets one cached path serve
 *               the same trip at 08:00 and at 23:00.
 */

import { NodeIndex, Router, loadGraph, type CarGraph } from "../../../pathfinder/src/index.ts";
import { GRAPH_FILE } from "../../../pathfinder/src/config.ts";
import type { Point } from "../world/index.ts";
import { congestion } from "../shared/index.ts";

export interface Trip {
  /** Minutes, after congestion scaling. */
  minutes: number;
  kilometres: number;
  /** Snapped endpoints, which is where the vehicle actually joins the network. */
  fromNode: number;
  toNode: number;
  /** True when no route existed and the result is a straight-line estimate. */
  estimated: boolean;
  /** Walking only: the path used a road with no plausible footway. */
  viaMotorway?: boolean;
}

/** Straight-line fallback speed, km/h, for the 5.4% of nodes off the main component. */
const FALLBACK_KPH = 28;

/**
 * The gap between a routed drive and a real one, in two terms.
 *
 * The pathfinder prices every edge from `maxspeed` or its class default, which
 * is what a routing tool should do: it answers "how long does this road take"
 * and the answer is the posted speed. A simulated commute needs the other
 * question — how long the trip takes — and the difference between the two, on
 * an eight-kilometre crossing of the city, is a factor of two. Free-flow puts
 * person 0 at 66 km/h door to door, which no one has ever driven to work.
 *
 * Trying to absorb all of that into one per-junction constant does not work,
 * and the version that did needed 9 seconds at every node with three exits —
 * 144 of them on that trip, one every sixty metres, which is not what a
 * junction is. Splitting it in two makes both halves defensible:
 *
 *   RUNNING     achieved speed as a share of posted, by road class. An urban
 *               arterial with signals, turning traffic and buses does not run
 *               at its sign; a motorway very nearly does. Applied per edge, so
 *               a trip that is mostly highway is barely touched and a trip
 *               through the grid is halved.
 *
 *   SIGNAL      seconds at a junction where the path crosses another road of
 *               comparable rank. Counted as a node where three or more
 *               tertiary-or-better edges meet, which comes out at about two
 *               per kilometre — the density of signalised intersections in a
 *               small American city, rather than the density of driveways.
 *
 * Both are calibration constants, fitted so the simulated commute distribution
 * lands on the surveyed one. See the `--sample` checks.
 */
const RUNNING: Record<string, number> = {
  motorway: 0.95, motorway_link: 0.85,
  trunk: 0.82, trunk_link: 0.75,
  primary: 0.62, primary_link: 0.6,
  secondary: 0.6, secondary_link: 0.58,
  tertiary: 0.6, tertiary_link: 0.58,
  unclassified: 0.62, residential: 0.6, living_street: 0.7,
  road: 0.62, service: 0.55, busway: 0.6,
};
const DEFAULT_RUNNING = 0.62;

const SIGNAL_DELAY_S = 40;

/** Classes that make a junction worth stopping at. */
const RANKED: ReadonlySet<string> = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link",
  "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link",
]);

/**
 * Getting to and from the vehicle at the home end.
 *
 * PUMS commute time is door to door and includes it. Free-flow routing starts
 * when the car starts moving.
 */
export const ACCESS_MINUTES = 1.6;

/**
 * Walking, on the same graph.
 *
 * The assumption is deliberate and it is an assumption: every road in Kierston
 * is treated as having a footway of some kind, so a pedestrian's path is the
 * driver's path. For a small American city laid out on a grid this is close
 * enough to true to be worth more than the alternative, which is a survey
 * number with no geometry attached and therefore no route to intercept a shop
 * on. What it costs is the footpaths that are not roads — park cut-throughs,
 * the alley between two blocks, the campus diagonal — so a simulated walk is
 * biased slightly long. The router's walking mode treats the directed car graph
 * as undirected, so one-way lane directions do not constrain pedestrians.
 *
 * Pricing is distance over speed, not the car cost rescaled — a pedestrian does
 * not go faster on an arterial than on a residential street, which is exactly
 * what the class-keyed `RUNNING` derate would imply if it were reused here.
 *
 * The wait is smaller than a driver's. A pedestrian at a signal waits a random
 * point in the cycle rather than clearing a queue, and crosses on the parallel
 * phase they were already walking with about half the time.
 */
export const WALK_SPEED_M_PER_MIN = 78;
const PED_SIGNAL_DELAY_S = 22;

/** Roads a person cannot walk along, whatever the graph says. */
const NO_FOOTWAY: ReadonlySet<string> = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link",
]);

/** Straight-line walking fallback: crow flies, people do not. */
const WALK_DETOUR = 1.3;

export function haversineKm(a: Point, b: Point): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * What one node pair cost, and the road it went over.
 *
 * The nodes are kept because the router already produced them: pricing a trip
 * walks the whole path to add up its edges, and throwing the sequence away
 * means routing the same pair a second time later to draw it. The export used
 * to do exactly that for all three hundred thousand of the city's legs — a
 * fifth of its wall clock spent re-deriving geometry it had already had in
 * hand — and `path` now reads it off the entry the pricing left behind.
 *
 * A `Uint32Array` rather than the router's own path object because this is
 * long-lived: one entry per distinct pair the city ever asks for, held for the
 * length of the run. The node ids are all that is needed to draw it; the edge
 * list is a pricing artefact and is not kept.
 */
interface Priced {
  minutes: number;
  kilometres: number;
  nodes: Uint32Array;
  /** Walking only: the path used a road with no plausible footway. */
  viaMotorway?: boolean;
}

export class Roads {
  private readonly cache = new Map<number, Priced | null>();
  private readonly walkCache = new Map<number, Priced | null>();
  private hits = 0;
  private misses = 0;

  private constructor(
    readonly graph: CarGraph,
    readonly nodes: NodeIndex,
    private readonly router: Router,
  ) {}

  static async open(graphFile = GRAPH_FILE): Promise<Roads> {
    const graph = await loadGraph(graphFile);
    return new Roads(graph, new NodeIndex(graph), new Router(graph));
  }

  snap(point: Point): number {
    return this.nodes.nearest(point.lat, point.lon)?.node ?? -1;
  }

  /**
   * Geometry for an accepted movement leg. Door coordinates bookend the
   * snapped road nodes; an unroutable pair remains an honest straight segment.
   */
  path(from: Point, to: Point, walking = false): Point[] {
    const fromNode = this.snap(from);
    const toNode = this.snap(to);
    if (fromNode < 0 || toNode < 0 || fromNode === toNode) return [from, to];

    // Priced, not routed: for a leg the day actually contains this is a hit,
    // because the leg exists only because the planner priced it first. A miss
    // here routes and prices the pair like any other, so a caller drawing a
    // path nobody costed still gets one.
    const priced = walking ? this.walked(fromNode, toNode) : this.driven(fromNode, toNode);
    if (!priced) return [from, to];

    const points: Point[] = [from];
    for (const node of priced.nodes) {
      points.push({ lat: this.graph.lat[node]!, lon: this.graph.lon[node]! });
    }
    points.push(to);
    return points;
  }

  /**
   * The free-flow drive over one node pair, priced once and kept.
   *
   * Free-flow because the congestion multiplier belongs to the departure
   * minute and not to the road — see `trip`, which is where it is applied.
   */
  private driven(fromNode: number, toNode: number): Priced | null {
    // Both node ids fit in 21 bits at this graph size, so one key is one number
    // and the map stays a integer-keyed map rather than a string-keyed one.
    const key = fromNode * 0x100000 + toNode;
    const known = this.cache.get(key);
    if (known !== undefined) {
      this.hits += 1;
      return known;
    }
    this.misses += 1;
    const path = this.router.route(fromNode, toNode);
    const priced = path
      ? {
          minutes: this.driveSeconds(path) / 60,
          kilometres: path.distanceMeters / 1000,
          nodes: Uint32Array.from(path.nodes),
        }
      : null;
    this.cache.set(key, priced);
    return priced;
  }

  /** The same pair on foot, which is a different road and a different price. */
  private walked(fromNode: number, toNode: number): Priced | null {
    const key = fromNode * 0x100000 + toNode;
    const known = this.walkCache.get(key);
    if (known !== undefined) {
      this.hits += 1;
      return known;
    }
    this.misses += 1;
    const path = this.router.route(fromNode, toNode, { walking: true });
    let priced: Priced | null = null;
    if (path) {
      const { seconds, metres, viaMotorway } = this.walkSeconds(path);
      priced = {
        minutes: seconds / 60,
        kilometres: metres / 1000,
        viaMotorway,
        nodes: Uint32Array.from(path.nodes),
      };
    }
    this.walkCache.set(key, priced);
    return priced;
  }

  /**
   * Re-price a free-flow path as a drive: running speed by class, plus the
   * signals. Endpoints are not junctions — you do not wait to leave a driveway.
   */
  private driveSeconds(path: { nodes: Uint32Array; edges: Uint32Array }): number {
    const { offset, cost, classId, classes } = this.graph;

    let seconds = 0;
    for (let i = 0; i < path.edges.length; i += 1) {
      const slot = path.edges[i]!;
      const running = RUNNING[classes[classId[slot]!] ?? ""] ?? DEFAULT_RUNNING;
      seconds += cost[slot]! / running;
    }

    for (let i = 1; i < path.nodes.length - 1; i += 1) {
      const node = path.nodes[i]!;
      let ranked = 0;
      for (let slot = offset[node]!; slot < offset[node + 1]!; slot += 1) {
        if (RANKED.has(classes[classId[slot]!] ?? "")) ranked += 1;
      }
      if (ranked >= 3) seconds += SIGNAL_DELAY_S;
    }
    return seconds;
  }

  /**
   * The same path, walked: metres over pace, plus a wait at each signal.
   *
   * `length` rather than `cost`, because the edge's cost is a car's.
   */
  private walkSeconds(path: { nodes: Uint32Array; edges: Uint32Array }): { seconds: number; metres: number; viaMotorway: boolean } {
    const { offset, length, classId, classes } = this.graph;

    let metres = 0;
    let viaMotorway = false;
    for (let i = 0; i < path.edges.length; i += 1) {
      const slot = path.edges[i]!;
      metres += length[slot]!;
      if (NO_FOOTWAY.has(classes[classId[slot]!] ?? "")) viaMotorway = true;
    }

    let waits = 0;
    for (let i = 1; i < path.nodes.length - 1; i += 1) {
      const node = path.nodes[i]!;
      let ranked = 0;
      for (let slot = offset[node]!; slot < offset[node + 1]!; slot += 1) {
        if (RANKED.has(classes[classId[slot]!] ?? "")) ranked += 1;
      }
      if (ranked >= 3) waits += 1;
    }

    return { seconds: (metres / WALK_SPEED_M_PER_MIN) * 60 + waits * PED_SIGNAL_DELAY_S, metres, viaMotorway };
  }

  /**
   * A walked trip. No departure minute, because congestion is a queue and a
   * pedestrian does not join it — the pavement runs at the same pace at 08:00
   * as at midnight, and the only thing rush hour costs a walker is a slightly
   * longer wait at the crossings, which is inside the constant already.
   */
  walk(from: Point, to: Point): Trip {
    const fromNode = this.snap(from);
    const toNode = this.snap(to);
    const straight = haversineKm(from, to);
    const fallback = (): Trip => ({
      minutes: (straight * WALK_DETOUR * 1000) / WALK_SPEED_M_PER_MIN,
      kilometres: straight * WALK_DETOUR,
      fromNode,
      toNode,
      estimated: true,
    });

    if (fromNode < 0 || toNode < 0) return fallback();
    if (fromNode === toNode) {
      // Both ends hang off one road segment: the walk is the straight line
      // between the doors, not a trip round the block.
      return {
        minutes: Math.max(1, (straight * 1000) / WALK_SPEED_M_PER_MIN),
        kilometres: straight,
        fromNode,
        toNode,
        estimated: false,
      };
    }

    const walked = this.walked(fromNode, toNode);
    if (!walked) return fallback();
    return {
      minutes: walked.minutes,
      kilometres: walked.kilometres,
      fromNode,
      toNode,
      estimated: false,
      viaMotorway: walked.viaMotorway,
    };
  }

  /** Is this node a crossing worth waiting at? Shared by both pricings. */
  private signalled(node: number): boolean {
    const { offset, classId, classes } = this.graph;
    let ranked = 0;
    for (let slot = offset[node]!; slot < offset[node + 1]!; slot += 1) {
      if (RANKED.has(classes[classId[slot]!] ?? "")) ranked += 1;
    }
    return ranked >= 3;
  }

  /**
   * Set off walking toward somewhere and stop after a given distance.
   *
   * The point returned is a junction on the route rather than a coordinate
   * between the two ends, and the difference is not cosmetic. Interpolating a
   * fraction of the way along the straight line lands wherever that happens to
   * be — the middle of a rail yard, the far side of a river, a field with no
   * road touching it — and the walk to it then snaps to whatever node is
   * nearest, which can be most of a kilometre off the path and reachable only
   * the long way round. That produced a seven-hundred-metre stroll priced as a
   * six-kilometre, eighty-minute hike.
   *
   * Null when the route is shorter than the distance asked for, which is the
   * caller's signal that there is no "part of the way" left: they have arrived.
   */
  walkPrefix(from: Point, to: Point, metres: number): { at: Point; minutes: number; kilometres: number } | null {
    const fromNode = this.snap(from);
    const toNode = this.snap(to);
    if (fromNode < 0 || toNode < 0 || fromNode === toNode) return null;

    const path = this.router.route(fromNode, toNode, { walking: true });
    if (!path) return null;

    const { lat, lon, length } = this.graph;
    let walked = 0;
    let waits = 0;
    for (let i = 0; i < path.edges.length; i += 1) {
      walked += length[path.edges[i]!]!;
      const node = path.nodes[i + 1];
      if (node === undefined) break;
      if (this.signalled(node)) waits += 1;
      if (walked >= metres) {
        return {
          at: { lat: lat[node]!, lon: lon[node]! },
          minutes: walked / WALK_SPEED_M_PER_MIN + (waits * PED_SIGNAL_DELAY_S) / 60,
          kilometres: walked / 1000,
        };
      }
    }
    return null;
  }

  /**
   * Free-flow path between two points, then scaled for the departure minute.
   *
   * `departAt` only scales; it does not change the path. Time-dependent routing
   * — where the road chosen depends on when you set off — needs a graph that
   * knows its own loading, and that is the network-loading pass this does not
   * have yet.
   */
  trip(from: Point, to: Point, departAt: number): Trip {
    const fromNode = this.snap(from);
    const toNode = this.snap(to);
    const straight = haversineKm(from, to);

    if (fromNode < 0 || toNode < 0) {
      return { minutes: (straight / FALLBACK_KPH) * 60, kilometres: straight, fromNode, toNode, estimated: true };
    }
    if (fromNode === toNode) {
      return { minutes: Math.max(1, (straight / 4.5) * 60), kilometres: straight, fromNode, toNode, estimated: false };
    }

    const free = this.driven(fromNode, toNode);
    if (!free) {
      return { minutes: (straight / FALLBACK_KPH) * 60, kilometres: straight, fromNode, toNode, estimated: true };
    }
    return {
      minutes: free.minutes * congestion(departAt),
      kilometres: free.kilometres,
      fromNode,
      toNode,
      estimated: false,
    };
  }

  /**
   * Work backwards from a required arrival to a departure.
   *
   * Not the same as routing forwards and subtracting: the trip's duration
   * depends on when it starts, so an 08:30 arrival needs the departure that
   * makes the congestion multiplier and the travel time agree. Two iterations
   * converge to well under a minute, which is finer than anyone plans a
   * commute anyway.
   */
  departureFor(from: Point, to: Point, arriveBy: number): Trip {
    let guess = this.trip(from, to, arriveBy);
    for (let i = 0; i < 2; i += 1) {
      guess = this.trip(from, to, arriveBy - guess.minutes);
    }
    return guess;
  }

  get stats() {
    return { cached: this.cache.size + this.walkCache.size, hits: this.hits, misses: this.misses };
  }
}

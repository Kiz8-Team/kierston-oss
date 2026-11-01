/**
 * The pathfinder as one object: address in, driving route out.
 *
 *   const pathfinder = await Pathfinder.open();
 *   const plan = await pathfinder.route("1 Main St", "40.6031, -75.4712");
 */

import { GRAPH_FILE } from "./config.ts";
import { NodeIndex, loadGraph, type CarGraph } from "./graph.ts";
import { AddressIndex, NominatimClient, parseCoordinates, type Place } from "./geocode.ts";
import { Router, type RoutePath } from "./router.ts";
import { buildGeometry, buildSteps, type Endpoint, type RoutePlan } from "./plan.ts";

export { AddressIndex, NodeIndex, Router, loadGraph };
export type { RouteOptions } from "./router.ts";
export type { CarGraph, Place, RoutePlan, Endpoint };
export type { RouteStep } from "./plan.ts";

export type PathfinderErrorCode = "unresolved" | "off-network" | "no-route" | "invalid-waypoints";

export class PathfinderError extends Error {
  constructor(readonly code: PathfinderErrorCode, message: string) {
    super(message);
    this.name = "PathfinderError";
  }
}

export type Waypoint = string | { lat: number; lon: number };

const queryText = (waypoint: Waypoint): string =>
  typeof waypoint === "string" ? waypoint : `${waypoint.lat.toFixed(6)}, ${waypoint.lon.toFixed(6)}`;

export interface PathfinderOptions {
  graphFile?: string;
  /** Fall back to Nominatim for addresses the local index does not know. */
  onlineGeocoding?: boolean;
  /** Skip loading the address index when only coordinates will be routed. */
  addresses?: boolean;
}

export class Pathfinder {
  private constructor(
    readonly graph: CarGraph,
    private readonly nodes: NodeIndex,
    private readonly router: Router,
    private readonly addresses: AddressIndex | null,
    private readonly nominatim: NominatimClient,
  ) {}

  static async open(options: PathfinderOptions = {}): Promise<Pathfinder> {
    const graph = await loadGraph(options.graphFile ?? GRAPH_FILE);
    const addresses = options.addresses === false ? null : await AddressIndex.load();
    return new Pathfinder(
      graph,
      new NodeIndex(graph),
      new Router(graph),
      addresses,
      new NominatimClient(options.onlineGeocoding !== false),
    );
  }

  get stats() {
    return {
      source: this.graph.source,
      builtAt: this.graph.builtAt,
      nodes: this.graph.nodeCount,
      edges: this.graph.edgeCount,
      streets: this.graph.names.length - 1,
      components: this.graph.componentCount,
      routableNodes: this.graph.largestComponentSize,
      bbox: this.graph.bbox,
      addresses: this.addresses ? this.addresses.size : 0,
      addressStreets: this.addresses ? this.addresses.streetCount : 0,
    };
  }

  /** Ranked candidates for a free-text query; the local index only. */
  suggest(query: string, limit = 5): Place[] {
    return this.addresses?.search(query, limit) ?? [];
  }

  /** The nearest known address to a coordinate, used to label map picks. */
  describe(lat: number, lon: number): Place | null {
    return this.addresses?.reverse(lat, lon) ?? null;
  }

  async resolve(waypoint: Waypoint): Promise<Place> {
    if (typeof waypoint !== "string") {
      const known = this.describe(waypoint.lat, waypoint.lon);
      return {
        label: known?.label ?? `${waypoint.lat.toFixed(6)}, ${waypoint.lon.toFixed(6)}`,
        lat: waypoint.lat, lon: waypoint.lon, source: "coordinates", score: 1,
      };
    }

    const coordinates = parseCoordinates(waypoint);
    if (coordinates) return this.resolve(coordinates);

    const local = this.addresses?.search(waypoint, 1) ?? [];
    if (local.length) return local[0];

    const remote = await this.nominatim.lookup(waypoint);
    if (remote) return remote;

    throw new PathfinderError("unresolved", `no place in Kierston matches ${JSON.stringify(waypoint)}`);
  }

  async route(from: Waypoint, to: Waypoint): Promise<RoutePlan>;
  async route(waypoints: readonly Waypoint[]): Promise<RoutePlan>;
  async route(fromOrWaypoints: Waypoint | readonly Waypoint[], to?: Waypoint): Promise<RoutePlan> {
    const startedAt = performance.now();
    const waypoints = Array.isArray(fromOrWaypoints)
      ? [...fromOrWaypoints]
      : to === undefined ? [fromOrWaypoints] : [fromOrWaypoints, to];
    if (waypoints.length < 2) {
      throw new PathfinderError("invalid-waypoints", "a route requires at least two waypoints");
    }

    const places = await Promise.all(waypoints.map((waypoint) => this.resolve(waypoint)));
    const snapped = places.map((place, index) => this.snap(
      place,
      queryText(waypoints[index]),
      index === 0 ? "start" : index === waypoints.length - 1 ? "destination" : `waypoint ${index + 1}`,
    ));
    const legs: RoutePath[] = [];
    for (let index = 0; index < snapped.length - 1; index += 1) {
      const path = this.router.route(snapped[index].snapped.nodeId, snapped[index + 1].snapped.nodeId);
      if (!path) {
        throw new PathfinderError(
          "no-route",
          `no drivable route from ${places[index].label} to ${places[index + 1].label}`,
        );
      }
      legs.push(path);
    }
    const path = joinPaths(legs);
    const endpoints = snapped.map((item) => item.endpoint);

    return {
      waypoints: endpoints,
      from: endpoints[0],
      to: endpoints[endpoints.length - 1],
      // The snapped ends are metres from the door; report the driven distance.
      distanceMeters: path.distanceMeters,
      durationSeconds: path.durationSeconds,
      geometry: buildGeometry(this.graph, path),
      steps: buildSteps(this.graph, path),
      stats: {
        settledNodes: path.settledNodes,
        searchMs: Number(path.milliseconds.toFixed(3)),
        totalMs: Number((performance.now() - startedAt).toFixed(3)),
      },
    };
  }

  private snap(place: Place, query: string, role: string): { endpoint: Endpoint; snapped: { nodeId: number } } {
    const hit = this.nodes.nearest(place.lat, place.lon);
    if (!hit) {
      throw new PathfinderError("off-network", `${role} ${place.label} is outside the mapped road network`);
    }
    return {
      snapped: { nodeId: hit.node },
      endpoint: {
        query,
        label: place.label,
        source: place.source,
        lat: place.lat,
        lon: place.lon,
        snapped: {
          lat: hit.lat, lon: hit.lon,
          osmid: this.graph.osmid[hit.node],
          metersAway: Number(hit.meters.toFixed(1)),
        },
      },
    };
  }
}

/** Join consecutive route legs without duplicating their shared boundary nodes. */
function joinPaths(paths: readonly RoutePath[]): RoutePath {
  const nodeCount = paths.reduce((total, path, index) =>
    total + path.nodes.length - (index === 0 ? 0 : 1), 0);
  const edgeCount = paths.reduce((total, path) => total + path.edges.length, 0);
  const nodes = new Uint32Array(nodeCount);
  const edges = new Uint32Array(edgeCount);
  let nodeOffset = 0;
  let edgeOffset = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const pathNodes = index === 0 ? paths[index].nodes : paths[index].nodes.subarray(1);
    nodes.set(pathNodes, nodeOffset);
    edges.set(paths[index].edges, edgeOffset);
    nodeOffset += pathNodes.length;
    edgeOffset += paths[index].edges.length;
  }
  return {
    nodes,
    edges,
    distanceMeters: paths.reduce((total, path) => total + path.distanceMeters, 0),
    durationSeconds: paths.reduce((total, path) => total + path.durationSeconds, 0),
    settledNodes: paths.reduce((total, path) => total + path.settledNodes, 0),
    milliseconds: paths.reduce((total, path) => total + path.milliseconds, 0),
  };
}

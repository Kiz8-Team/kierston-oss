/** Turn a raw node path into the shape a caller (or a map) wants to consume. */

import type { CarGraph } from "./graph.ts";
import type { RoutePath } from "./router.ts";
import type { PlaceSource } from "./geocode.ts";
import { bearingDegrees, turnAngle } from "./geo.ts";

export interface Endpoint {
  query: string;
  label: string;
  source: PlaceSource;
  lat: number;
  lon: number;
  /** Where the router actually started or finished: the nearest road node. */
  snapped: { lat: number; lon: number; osmid: number; metersAway: number };
}

export interface RouteStep {
  maneuver: "depart" | "straight" | "slight left" | "slight right" | "left" | "right"
    | "sharp left" | "sharp right" | "u-turn" | "arrive";
  instruction: string;
  name: string;
  highway: string;
  distanceMeters: number;
  durationSeconds: number;
  lat: number;
  lon: number;
}

export interface RoutePlan {
  /** Every requested stop in traversal order, including the start and end. */
  waypoints: Endpoint[];
  /** Convenience aliases for the first and last waypoint. */
  from: Endpoint;
  to: Endpoint;
  distanceMeters: number;
  durationSeconds: number;
  /** [lat, lon] pairs, one per node along the path. */
  geometry: [number, number][];
  steps: RouteStep[];
  stats: { settledNodes: number; searchMs: number; totalMs: number };
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

function compass(bearing: number): string {
  return COMPASS[Math.round(bearing / 45) % 8];
}

function maneuverFor(angle: number): RouteStep["maneuver"] {
  const magnitude = Math.abs(angle);
  if (magnitude < 20) return "straight";
  if (magnitude > 150) return "u-turn";
  const side = angle < 0 ? "left" : "right";
  if (magnitude < 45) return `slight ${side}` as RouteStep["maneuver"];
  if (magnitude < 120) return side as RouteStep["maneuver"];
  return `sharp ${side}` as RouteStep["maneuver"];
}

function roadLabel(graph: CarGraph, nameId: number, classId: number): string {
  const name = graph.names[nameId];
  if (name) return name;
  // An unnamed way still has a class, which is more use than "unnamed road".
  const highway = graph.classes[classId] ?? "road";
  return `unnamed ${highway.replace(/_/g, " ")}`;
}

/**
 * Collapse the path into one step per street, with the turn taken to get onto
 * it. Consecutive edges of the same name are one instruction, which is what
 * makes a 900-edge path readable as a dozen lines.
 */
export function buildSteps(graph: CarGraph, path: RoutePath): RouteStep[] {
  if (path.edges.length === 0) return [];

  const steps: RouteStep[] = [];
  let startIndex = 0;
  let distance = 0;
  let duration = 0;
  let nameId = graph.nameId[path.edges[0]];
  let classId = graph.classId[path.edges[0]];

  const bearingAt = (index: number) => bearingDegrees(
    graph.lat[path.nodes[index]], graph.lon[path.nodes[index]],
    graph.lat[path.nodes[index + 1]], graph.lon[path.nodes[index + 1]],
  );

  const emit = (index: number) => {
    const node = path.nodes[startIndex];
    const name = roadLabel(graph, nameId, classId);
    const first = steps.length === 0;
    const maneuver = first
      ? "depart"
      : maneuverFor(turnAngle(bearingAt(startIndex - 1), bearingAt(startIndex)));
    const instruction = first
      ? `Head ${compass(bearingAt(0))} on ${name}`
      : maneuver === "straight"
        ? `Continue onto ${name}`
        : maneuver === "u-turn"
          ? `Make a U-turn onto ${name}`
          : `Turn ${maneuver} onto ${name}`;
    steps.push({
      maneuver, instruction, name,
      highway: graph.classes[classId] ?? "road",
      distanceMeters: distance, durationSeconds: duration,
      lat: graph.lat[node], lon: graph.lon[node],
    });
    startIndex = index;
    distance = 0;
    duration = 0;
  };

  for (let i = 0; i < path.edges.length; i += 1) {
    const edge = path.edges[i];
    if (graph.nameId[edge] !== nameId) {
      emit(i);
      nameId = graph.nameId[edge];
      classId = graph.classId[edge];
    }
    distance += graph.length[edge];
    duration += graph.cost[edge];
  }
  emit(path.edges.length);

  const last = path.nodes[path.nodes.length - 1];
  steps.push({
    maneuver: "arrive", instruction: "Arrive at destination", name: "",
    highway: "", distanceMeters: 0, durationSeconds: 0,
    lat: graph.lat[last], lon: graph.lon[last],
  });
  return steps;
}

export function buildGeometry(graph: CarGraph, path: RoutePath): [number, number][] {
  const geometry: [number, number][] = new Array(path.nodes.length);
  for (let i = 0; i < path.nodes.length; i += 1) {
    const node = path.nodes[i];
    geometry[i] = [graph.lat[node], graph.lon[node]];
  }
  return geometry;
}

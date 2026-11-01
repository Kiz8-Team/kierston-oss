import { resolve } from "node:path";
import { loadGraph, type CarGraph } from "../../kierston/pathfinder/src/graph.ts";
import { haversineMetres, validatePlaceSearch } from "./place_search.ts";
import { GATEWAY } from "../model_visible_text.ts";

export type AddressQuery = { address: string } | { latitude: number; longitude: number; radiusMetres: number };
export function validateAddressQuery(value: unknown): string | null {
  if (!value || typeof value !== "object") return GATEWAY.address.missing;
  const q = value as Record<string, unknown>;
  if (q.address !== undefined) {
    if (q.latitude !== undefined || q.longitude !== undefined || q.radiusMetres !== undefined) return GATEWAY.address.both;
    return typeof q.address === "string" && normalize(q.address).length > 0 && q.address.length <= 4096 ? null : GATEWAY.address.text;
  }
  if (typeof q.latitude !== "number" || typeof q.longitude !== "number" || typeof q.radiusMetres !== "number") return GATEWAY.places.numbers;
  return validatePlaceSearch(q.latitude, q.longitude, q.radiusMetres);
}
const aliases: Record<string, string> = { st: "street", rd: "road", ave: "avenue", blvd: "boulevard", dr: "drive", ln: "lane", ct: "court", pl: "place", n: "north", s: "south", e: "east", w: "west" };
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).map(t => aliases[t] ?? t).join(" ");
}
function matches(text: string, query: string): boolean {
  return (` ${normalize(text)} `).includes(` ${normalize(query)} `);
}
type Location = { latitude: number; longitude: number };
/** Projection onto a graph edge's endpoint chord, not a surveyed road geometry. */
function nearestPoint(q: Location, a: Location, b: Location): Location {
  const scale = Math.cos(q.latitude * Math.PI / 180);
  const dx = (b.longitude - a.longitude) * scale, dy = b.latitude - a.latitude;
  const t = Math.max(0, Math.min(1, (((q.longitude - a.longitude) * scale * dx) + (q.latitude - a.latitude) * dy) / (dx * dx + dy * dy || 1)));
  return { latitude: a.latitude + t * dy, longitude: a.longitude + t * (b.longitude - a.longitude) };
}
export function lookupInCatalog(query: AddressQuery, points: unknown[][], graph: CarGraph) {
  const reverse = "latitude" in query;
  const addresses = points.flatMap((p, index) => {
    const tags = (p[8] ?? {}) as Record<string, string>;
    const address = typeof p[7] === "string" ? p[7] : "";
    const street = tags["addr:street"] ?? "";
    if (!street && !tags["addr:housenumber"]) return [];
    const location = { latitude: Number(p[0]), longitude: Number(p[1]) };
    const distance = reverse ? haversineMetres(query, location) : undefined;
    if (reverse ? distance! > query.radiusMetres : !matches(address, query.address)) return [];
    return [{ id: String(p[9] ?? `building/${index}`), address, street, ...location, coordinateKind: "building_centroid", ...(reverse ? { distanceMetres: distance } : {}) }];
  });
  const streets = new Map<string, { street: string; latitude: number; longitude: number; coordinateKind: string; distanceMetres?: number }>();
  for (let from = 0; from < graph.nodeCount; from++) {
    for (let edge = graph.offset[from]!; edge < graph.offset[from + 1]!; edge++) {
      const street = graph.names[graph.nameId[edge]!]!;
      if (!street || (!reverse && !matches(street, query.address))) continue;
      const to = graph.target[edge]!;
      const a = { latitude: graph.lat[from]!, longitude: graph.lon[from]! };
      const b = { latitude: graph.lat[to]!, longitude: graph.lon[to]! };
      const location = reverse ? nearestPoint(query, a, b) : a;
      const distance = reverse ? haversineMetres(query, location) : undefined;
      if (reverse && distance! > query.radiusMetres) continue;
      const previous = streets.get(street);
      if (!previous || (reverse && distance! < previous.distanceMetres!)) streets.set(street, { street, ...location, coordinateKind: reverse ? "nearest_graph_edge_point" : "representative_graph_node", ...(reverse ? { distanceMetres: distance } : {}) });
    }
  }
  const order = (a: { distanceMetres?: number }, b: { distanceMetres?: number }) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0);
  addresses.sort(order);
  return { query, addresses, streets: [...streets.values()].sort(order), addressCount: addresses.length, streetCount: streets.size };
}
export async function lookupAddress(query: AddressQuery, directory = resolve(import.meta.dir, "../../kierston/sim_data")) {
  const invalid = validateAddressQuery(query);
  if (invalid) throw new RangeError(invalid);
  const [buildings, graph] = await Promise.all([Bun.file(resolve(directory, "buildings.json")).json(), loadGraph(resolve(directory, "car_graph.bin"))]);
  return lookupInCatalog(query, buildings.points, graph);
}

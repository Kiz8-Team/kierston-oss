import { GATEWAY } from "../model_visible_text.ts";
import { resolve } from "node:path";

interface PoiType {
  i: number;
  id: string;
  label: string;
}

interface PoiGroup {
  id: string;
  label: string;
  types: PoiType[];
}

interface PoiFile {
  groups: PoiGroup[];
  points: unknown[][];
}

export interface PlaceSearchResult {
  query: { latitude: number; longitude: number; radiusMetres: number };
  count: number;
  places: Array<{
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    group: string;
    groupLabel: string;
    address: string;
    latitude: number;
    longitude: number;
    distanceMetres: number;
  }>;
}

export const DEFAULT_POI_FILE = resolve(import.meta.dir, "../../kierston/sim_data/pois.json");

/** Great-circle distance is accurate enough for a city-scale radius search. */
export function haversineMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = Math.PI / 180;
  const lat1 = a.latitude * radians;
  const lat2 = b.latitude * radians;
  const deltaLat = (b.latitude - a.latitude) * radians;
  const deltaLon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function validatePlaceSearch(latitude: number, longitude: number, radiusMetres: number): string | null {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return GATEWAY.places.latitude;
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return GATEWAY.places.longitude;
  }
  if (!Number.isFinite(radiusMetres) || radiusMetres < 0) {
    return GATEWAY.places.radius;
  }
  return null;
}

/** Read the compact simulation POI catalogue and return every point in range. */
export async function searchPlaces(
  latitude: number,
  longitude: number,
  radiusMetres: number,
  poiFile = DEFAULT_POI_FILE,
): Promise<PlaceSearchResult> {
  const invalid = validatePlaceSearch(latitude, longitude, radiusMetres);
  if (invalid) throw new RangeError(invalid);

  const source = Bun.file(poiFile);
  if (!(await source.exists())) throw new Error(`POI catalog not found: ${poiFile}`);
  const catalog = await source.json() as PoiFile;
  const groups = new Map<number, PoiGroup>();
  const types = new Map<number, PoiType>();
  for (const [index, group] of catalog.groups.entries()) {
    groups.set(index, group);
    for (const type of group.types) types.set(type.i, type);
  }

  const origin = { latitude, longitude };
  const places: PlaceSearchResult["places"] = [];
  for (const [index, point] of catalog.points.entries()) {
    const placeLatitude = Number(point[0]);
    const placeLongitude = Number(point[1]);
    const distance = haversineMetres(origin, { latitude: placeLatitude, longitude: placeLongitude });
    if (distance > radiusMetres) continue;
    const group = groups.get(Number(point[2]));
    const type = types.get(Number(point[3]));
    places.push({
      id: `poi/${index}`,
      name: typeof point[4] === "string" ? point[4] : "",
      type: type?.id ?? "",
      typeLabel: type?.label ?? "",
      group: group?.id ?? "",
      groupLabel: group?.label ?? "",
      address: typeof point[5] === "string" ? point[5] : "",
      latitude: placeLatitude,
      longitude: placeLongitude,
      distanceMetres: Math.round(distance),
    });
  }
  places.sort((a, b) => a.distanceMetres - b.distanceMetres || a.id.localeCompare(b.id, "en", { numeric: true }));
  return { query: { latitude, longitude, radiusMetres }, count: places.length, places };
}

/**
 * Address lookup for the city, offline first.
 *
 * `buildings.json` and `pois.json` already carry ~60k addresses for the area,
 * which is everything a local route needs, so the index is built from those and
 * answers in memory. Nominatim is only consulted when the local index has
 * nothing, and every answer it gives is cached to disk — its policy allows one
 * request a second, which is far too slow to sit in a request path.
 */

import { BUILDING_FILE, center, GEOCODE_FILE, POI_FILE } from "./config.ts";
import { haversineMeters } from "./geo.ts";

export type PlaceSource = "coordinates" | "address" | "street" | "name" | "nominatim";

export interface Place {
  label: string;
  lat: number;
  lon: number;
  source: PlaceSource;
  /** Rough 0–1 ranking hint, not a probability. */
  score: number;
  /** Postal address when the record has one, even if it is named after a shop. */
  address?: string;
}

/** Street-type and directional words, folded to one spelling before indexing. */
const CANONICAL: Record<string, string> = {
  street: "st", str: "st",
  avenue: "ave", av: "ave",
  road: "rd", drive: "dr", lane: "ln", court: "ct", place: "pl",
  boulevard: "blvd", terrace: "ter", circle: "cir", parkway: "pkwy",
  highway: "hwy", turnpike: "tpke", square: "sq", trail: "trl",
  extension: "ext", alley: "aly", crossing: "xing", heights: "hts",
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  saint: "st",
};

export function normalizeStreet(value: string): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  return words.filter(Boolean).map((word) => CANONICAL[word] ?? word).join(" ");
}

interface ParsedQuery {
  houseNumber: string;
  street: string;
  raw: string;
}

export function parseAddress(query: string): ParsedQuery {
  const head = query.split(",")[0].trim();
  const match = /^(\d+[a-z]?)\s+(.+)$/i.exec(head);
  return {
    houseNumber: match ? match[1].toLowerCase() : "",
    street: normalizeStreet(match ? match[2] : head),
    raw: query.trim(),
  };
}

/** "40.60, -75.47" typed into an address box is a coordinate, not an address. */
export function parseCoordinates(query: string): { lat: number; lon: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const REVERSE_CELL = 0.002;
const cellKey = (lat: number, lon: number) =>
  `${Math.floor(lat / REVERSE_CELL)}:${Math.floor(lon / REVERSE_CELL)}`;

export class AddressIndex {
  private readonly byHouse = new Map<string, Place[]>();
  private readonly byStreet = new Map<string, { number: number; place: Place }[]>();
  private readonly byName = new Map<string, Place[]>();
  private readonly nameList: { key: string; place: Place }[] = [];
  private readonly grid = new Map<string, Place[]>();
  private loadedAt = "";

  get size(): number {
    return this.grid.size ? [...this.grid.values()].reduce((sum, list) => sum + list.length, 0) : 0;
  }

  get streetCount(): number {
    return this.byStreet.size;
  }

  static async load(): Promise<AddressIndex> {
    const index = new AddressIndex();
    await index.ingestBuildings(BUILDING_FILE);
    await index.ingestPois(POI_FILE);
    index.sortStreets();
    index.loadedAt = new Date().toISOString();
    return index;
  }

  private add(place: Place, address: string, name: string): void {
    const bucket = this.grid.get(cellKey(place.lat, place.lon));
    if (bucket) bucket.push(place);
    else this.grid.set(cellKey(place.lat, place.lon), [place]);

    if (address) {
      const parsed = parseAddress(address);
      if (parsed.street) {
        if (parsed.houseNumber) {
          const key = `${parsed.houseNumber}|${parsed.street}`;
          const list = this.byHouse.get(key);
          if (list) list.push(place);
          else this.byHouse.set(key, [place]);
        }
        const street = this.byStreet.get(parsed.street);
        const entry = { number: Number.parseInt(parsed.houseNumber, 10) || 0, place };
        if (street) street.push(entry);
        else this.byStreet.set(parsed.street, [entry]);
      }
    }

    if (name) {
      const key = normalizeStreet(name);
      if (!key) return;
      const list = this.byName.get(key);
      if (list) list.push(place);
      else this.byName.set(key, [place]);
      this.nameList.push({ key, place });
    }
  }

  private async ingestBuildings(path: string): Promise<void> {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    // [lat, lon, category, kind, levels, flats, name, address, tags, osmId, living]
    const data = await file.json() as { points: [number, number, number, string, number, number, string, string][] };
    for (const point of data.points) {
      const [lat, lon, , kind, , , name, address] = point;
      if (!address && !name) continue;
      // A named building is best identified by its name; the address stays
      // available for street lookups and for labelling a picked point.
      this.add({
        label: name || address, address: address || undefined, lat, lon,
        source: name ? "name" : "address", score: 1,
      }, address, name || "");
      void kind;
    }
  }

  private async ingestPois(path: string): Promise<void> {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    // [lat, lon, group, type, name, address, addressSource]
    const data = await file.json() as { points: [number, number, number, number, string, string, number][] };
    for (const point of data.points) {
      const [lat, lon, , , name, address] = point;
      if (!address && !name) continue;
      this.add({
        label: name || address, address: address || undefined, lat, lon,
        source: name ? "name" : "address", score: 1,
      }, address, name || "");
    }
  }

  private sortStreets(): void {
    for (const entries of this.byStreet.values()) entries.sort((a, b) => a.number - b.number);
  }

  /** Best local matches, most exact first. Empty when nothing matches at all. */
  search(query: string, limit = 5): Place[] {
    const coordinates = parseCoordinates(query);
    if (coordinates) {
      return [{
        label: `${coordinates.lat.toFixed(6)}, ${coordinates.lon.toFixed(6)}`,
        ...coordinates, source: "coordinates", score: 1,
      }];
    }

    const parsed = parseAddress(query);
    const results: Place[] = [];
    const seen = new Set<string>();
    const push = (place: Place, label = place.label, source = place.source, score = place.score) => {
      const key = `${place.lat.toFixed(6)},${place.lon.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ ...place, label, source, score });
    };

    if (parsed.houseNumber) {
      for (const place of this.byHouse.get(`${parsed.houseNumber}|${parsed.street}`) ?? []) {
        push(place, place.address ?? place.label, "address", 1);
      }
    }

    if (results.length < limit) {
      const exact = this.byName.get(normalizeStreet(parsed.raw)) ?? [];
      for (const place of exact.slice(0, limit)) push(place, place.label, "name", 0.9);
    }

    // A known street but an unknown number still pins the route to the block.
    if (results.length < limit && parsed.street) {
      const entries = this.byStreet.get(parsed.street);
      if (entries?.length) {
        const wanted = Number.parseInt(parsed.houseNumber, 10);
        const pick = Number.isFinite(wanted)
          ? entries.reduce((best, entry) =>
            Math.abs(entry.number - wanted) < Math.abs(best.number - wanted) ? entry : best)
          : entries[Math.floor(entries.length / 2)];
        const known = pick.place.address ?? pick.place.label;
        const label = parsed.houseNumber ? `${known} (nearest known number)` : known;
        push(pick.place, label, "street", 0.7);
      }
    }

    if (results.length < limit) {
      const needle = normalizeStreet(parsed.raw);
      if (needle.length >= 3) {
        for (const { key, place } of this.nameList) {
          if (!key.includes(needle)) continue;
          push(place, place.label, "name", 0.5);
          if (results.length >= limit) break;
        }
      }
    }

    if (results.length < limit && parsed.street.length >= 3) {
      for (const [street, entries] of this.byStreet) {
        if (!street.includes(parsed.street)) continue;
        const pick = entries[Math.floor(entries.length / 2)];
        push(pick.place, pick.place.address ?? pick.place.label, "street", 0.4);
        if (results.length >= limit) break;
      }
    }

    return results.slice(0, limit);
  }

  /** Closest known address to a coordinate, for labelling a point picked on the map. */
  reverse(lat: number, lon: number, maxMeters = 200): Place | null {
    let best: Place | null = null;
    let bestMeters = maxMeters;
    const row = Math.floor(lat / REVERSE_CELL);
    const col = Math.floor(lon / REVERSE_CELL);
    for (let r = row - 1; r <= row + 1; r += 1) {
      for (let c = col - 1; c <= col + 1; c += 1) {
        for (const place of this.grid.get(`${r}:${c}`) ?? []) {
          if (!place.address) continue;
          const meters = haversineMeters(lat, lon, place.lat, place.lon);
          if (meters < bestMeters) {
            bestMeters = meters;
            best = { ...place, label: place.address, source: "address" };
          }
        }
      }
    }
    return best;
  }
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Kierston/0.1 (kierston pathfinder)";
const NOMINATIM_INTERVAL_MS = 1100;

/** Forward geocoder for the queries the local index cannot answer. */
export class NominatimClient {
  private cache: Record<string, { lat: number; lon: number; label: string } | null> = {};
  private lastRequest = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly enabled = true) {}

  async lookup(query: string): Promise<Place | null> {
    if (!this.enabled) return null;
    await this.ensureCache();
    const key = query.trim().toLowerCase();
    if (key in this.cache) {
      const hit = this.cache[key];
      return hit ? { ...hit, source: "nominatim", score: 0.6 } : null;
    }

    // One request at a time, spaced to stay inside the usage policy.
    const pending = this.queue.then(() => this.request(key));
    this.queue = pending.catch(() => undefined);
    const result = await pending;
    this.cache[key] = result;
    await Bun.write(GEOCODE_FILE, JSON.stringify(this.cache));
    return result ? { ...result, source: "nominatim", score: 0.6 } : null;
  }

  private async ensureCache(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = Bun.file(GEOCODE_FILE);
    if (await file.exists()) this.cache = await file.json();
  }

  private async request(query: string): Promise<{ lat: number; lon: number; label: string } | null> {
    const wait = NOMINATIM_INTERVAL_MS - (Date.now() - this.lastRequest);
    if (wait > 0) await Bun.sleep(wait);
    this.lastRequest = Date.now();

    const [lat, lon] = center();
    const url = new URL(NOMINATIM);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    // Bias hard to the modelled area: the city is the only place we can route in.
    url.searchParams.set("viewbox", `${lon - 0.15},${lat + 0.12},${lon + 0.15},${lat - 0.12}`);
    url.searchParams.set("bounded", "1");

    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      const hits = await response.json() as { lat: string; lon: string; display_name: string }[];
      const hit = hits[0];
      if (!hit) return null;
      return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
    } catch {
      return null;
    }
  }
}

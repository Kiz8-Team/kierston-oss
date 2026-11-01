/**
 * Place names and addresses, as the generators and the scorer both read them.
 *
 * A generator has to know whether the place it is about to make the answer
 * can be written down at all, and the scorer has to turn what was written
 * back into the place. Those are one question asked from two ends, so the
 * index lives here and both sides build it from the same records.
 */

export interface PlaceRecord {
  id: string;
  name?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface PlaceMatch {
  /** Every place the text could denote, canonical form, sorted. */
  ids: string[];
  via: "place" | "name" | "address" | "name+address" | "unresolved";
}

/** `v:way/123`, `WAY/123` and `way/123` all denote the same place. */
export function canonicalPlace(value: string): string {
  return value.trim().replace(/^[a-z]:/i, "").toLowerCase();
}

/** A name or an address as a person would read it aloud. */
export function foldPlaceText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const OSM_REFERENCE = /^(way|node|relation)\/\d+$/;

/**
 * Two records of one name this close together are one place written twice:
 * a church as the map's node and as the register's own entry, a gym as its
 * node and its building. Further apart they are branches, and stay apart.
 */
const SAME_PLACE_METRES = 150;

export class PlaceBook {
  private readonly ids = new Set<string>();
  private readonly name = new Map<string, Set<string>>();
  private readonly address = new Map<string, Set<string>>();
  private readonly texts = new Map<string, { name: string; address: string }>();
  private readonly points = new Map<string, { lat: number; lon: number }>();
  /** Each id's representative, once co-located namesakes are merged; rebuilt after any `add`. */
  private merged: Map<string, string> | null = null;

  add(place: PlaceRecord): void {
    if (!place?.id) return;
    const id = canonicalPlace(place.id);
    this.ids.add(id);
    this.merged = null;
    if (typeof place.lat === "number" && typeof place.lon === "number") this.points.set(id, { lat: place.lat, lon: place.lon });
    // One building can sit in several registers; keep whichever text it has.
    const text = this.texts.get(id) ?? { name: "", address: "" };
    if (place.name?.trim()) text.name ||= place.name.trim();
    if (place.address?.trim()) text.address ||= place.address.trim();
    this.texts.set(id, text);
    if (place.name) index(this.name, foldPlaceText(place.name), id);
    if (place.address) index(this.address, foldPlaceText(place.address), id);
  }

  /** The one id a place is known by, whichever of its records was named. */
  same(reference: string): string {
    const id = canonicalPlace(reference);
    return this.aliases().get(id) ?? id;
  }

  private aliases(): Map<string, string> {
    if (this.merged) return this.merged;
    const merged = new Map<string, string>();
    const find = (id: string): string => {
      let root = id;
      while (merged.has(root) && merged.get(root) !== root) root = merged.get(root)!;
      return root;
    };
    for (const bucket of this.name.values()) {
      if (bucket.size < 2) continue;
      const ids = [...bucket].sort();
      for (let a = 0; a < ids.length; a += 1) {
        for (let b = a + 1; b < ids.length; b += 1) {
          const from = this.points.get(ids[a]!), to = this.points.get(ids[b]!);
          if (!from || !to || metres(from, to) > SAME_PLACE_METRES) continue;
          const [low, high] = [find(ids[a]!), find(ids[b]!)].sort() as [string, string];
          merged.set(high, low);
          merged.set(low, low);
        }
      }
    }
    for (const id of [...merged.keys()]) merged.set(id, find(id));
    this.merged = merged;
    return merged;
  }

  private settle(ids: Iterable<string>): string[] {
    return [...new Set([...ids].map((id) => this.same(id)))].sort();
  }

  resolve(given: string): PlaceMatch {
    const id = canonicalPlace(given);
    if (this.ids.has(id) || OSM_REFERENCE.test(id)) return { ids: [this.same(id)], via: "place" };
    const folded = foldPlaceText(given);
    const byName = this.name.get(folded);
    if (byName) return { ids: this.settle(byName), via: "name" };
    const byAddress = this.address.get(folded);
    if (byAddress) return { ids: this.settle(byAddress), via: "address" };
    // "Name, 12 Some Street, Town, ST 00000": the form a task asks for when a
    // name alone is shared. Neither half need be unique; together they must
    // agree on a place.
    const parts = given.split(",");
    for (let cut = 1; cut < parts.length; cut += 1) {
      const named = this.name.get(foldPlaceText(parts.slice(0, cut).join(",")));
      const addressed = this.address.get(foldPlaceText(parts.slice(cut).join(",")));
      if (!named || !addressed) continue;
      const there = new Set(this.settle(addressed));
      const both = this.settle(named).filter((candidate) => there.has(candidate));
      if (both.length > 0) return { ids: both, via: "name+address" };
    }
    return { ids: [], via: "unresolved" };
  }

  /** The name and address on record for a place; empty strings where there is none. */
  textOf(reference: string): { name: string; address: string } {
    const id = canonicalPlace(reference);
    const own = this.texts.get(id) ?? { name: "", address: "" };
    if (own.address) return own;
    // The register's entry often has the name and the map's node the address.
    const twin = [...this.aliases()].find(([other, root]) => other !== id && root === this.same(id) && this.texts.get(other)?.address);
    return twin ? { name: own.name, address: this.texts.get(twin[0])!.address } : own;
  }
}

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.add(id);
  else map.set(key, new Set([id]));
}

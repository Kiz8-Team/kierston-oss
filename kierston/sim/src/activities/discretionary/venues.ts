/**
 * Places people go without belonging to them.
 *
 * `init/social/orgs.py` drew the line this module sits on the other side of,
 * and drew it in a comment worth repeating: only tags that describe somewhere
 * with a membership become an org, because "a restaurant has regulars but not
 * a roster, and the difference is whether the same forty people are there
 * every week". A congregation is a list of people. A supermarket is a
 * catchment and an occupancy, and nobody can enumerate who is in it on Tuesday
 * without simulating Tuesday.
 *
 * So a venue is not a small org. It has no members, no units, no `since`, and
 * it generates no ties. What it has is a location, a pull, and an opening
 * pattern, and everything else about it is emergent.
 *
 * Ids are the `v:` scheme `orgs.py` already uses, which is deliberate: a
 * community centre is a venue *and* an org, a sports centre likewise, and
 * keying both off `v:way/123` means the two layers land in the same pool
 * rather than in two pools at the same coordinates. Where a venue and an org
 * are the same building, they are the same id.
 *
 * The catalogue is built from `data/export.json` rather than the compact
 * `data/pois.json` for two reasons. The compact file has dropped the tags that
 * decide behaviour — `cuisine`, `takeaway`, `opening_hours`, `brand` — and,
 * more basically, it has dropped the OSM ids, so nothing built from it could
 * be pointed at by an event log that has to survive a re-export.
 */

import { join } from "node:path";
import { SIM_DATA_DIR, SOURCES_DIR, type Point } from "../../world/index.ts";
import { haversineKm } from "../../transport/index.ts";
import { LAYER, mix, Rng, stream } from "../../shared/index.ts";

/**
 * What someone is going out to do. Not what the building is.
 *
 * The distinction matters because one building serves several purposes and the
 * purpose is what the trip generator reasons about. A supermarket is a weekly
 * shop and a forgotten-the-milk stop, and those are different trips with
 * different lengths, different times and different baskets, from the same POI.
 */
export type Purpose =
  | "grocery"
  | "convenience"
  | "cafe"
  | "food-quick"
  | "food-sit"
  | "bar"
  | "fuel"
  | "pharmacy"
  | "health"
  | "personal"
  | "errand"
  | "retail"
  | "vehicle"
  | "park";

/**
 * OSM tag to purpose. A tag may appear more than once — a bakery is somewhere
 * to buy bread and somewhere to sit with a coffee, and which one it is depends
 * on who is asking and when.
 */
const TAGS: Record<Purpose, readonly string[]> = {
  grocery: [
    "shop=supermarket", "shop=greengrocer", "shop=butcher", "shop=deli",
    "shop=health_food", "shop=farm", "shop=seafood", "shop=dairy",
    "amenity=marketplace", "shop=wholesale",
  ],
  convenience: ["shop=convenience", "shop=variety_store", "shop=beverages", "shop=alcohol", "shop=tobacco"],
  // Five cafés in a city of 120,000 is a tagging artefact, not a fact about
  // the reference city — see CAFE_THINNESS below for what is done about it.
  cafe: ["amenity=cafe", "shop=coffee", "shop=bakery"],
  "food-quick": ["amenity=fast_food", "amenity=ice_cream"],
  "food-sit": ["amenity=restaurant", "amenity=pub"],
  bar: ["amenity=bar", "amenity=pub", "amenity=nightclub", "amenity=hookah_lounge", "amenity=stripclub"],
  fuel: ["amenity=fuel", "amenity=charging_station", "shop=fuel", "shop=gas"],
  pharmacy: ["amenity=pharmacy", "shop=chemist"],
  health: ["amenity=doctors", "amenity=dentist", "amenity=clinic", "amenity=hospital", "amenity=optician", "shop=optician"],
  personal: ["shop=hairdresser", "shop=beauty", "shop=massage", "shop=tattoo", "shop=laundry", "shop=dry_cleaning", "shop=nail"],
  errand: ["amenity=bank", "amenity=post_office", "amenity=atm", "office=government", "amenity=townhall", "amenity=library"],
  retail: [
    "shop=clothes", "shop=shoes", "shop=furniture", "shop=hardware", "shop=doityourself",
    "shop=electronics", "shop=mobile_phone", "shop=computer", "shop=books", "shop=jewelry",
    "shop=florist", "shop=pet", "shop=toys", "shop=sports", "shop=department_store",
    "shop=mall", "shop=second_hand", "shop=gift", "shop=stationery", "shop=games",
    "shop=video_games", "shop=music", "shop=appliance", "shop=yes",
  ],
  vehicle: ["shop=car_repair", "shop=car_parts", "shop=tyres", "amenity=car_wash", "shop=motorcycle_repair"],
  park: ["leisure=park", "leisure=playground", "leisure=dog_park", "leisure=garden"],
};

/**
 * How far someone will go, as the decay in the Huff weight.
 *
 * Bigger is more local. A convenience store is worth no detour at all — the
 * whole point of one is that it is the nearest — while a weekly shop is worth
 * driving past two supermarkets to reach the one with the right car park, and
 * a restaurant is worth crossing town for. These are the shape of the choice,
 * and the number that would replace them is a survey nobody has run here.
 */
const DECAY: Record<Purpose, number> = {
  grocery: 1.5,
  convenience: 3.2,
  cafe: 2.4,
  "food-quick": 2.2,
  "food-sit": 1.3,
  bar: 1.4,
  fuel: 2.6,
  pharmacy: 2.0,
  health: 1.1,
  personal: 1.6,
  errand: 1.8,
  retail: 1.2,
  vehicle: 1.4,
  park: 2.8,
};

/**
 * How far the choice set reaches, in kilometres, before it is truncated.
 *
 * The decay does most of the work; this is what stops a search scanning the
 * whole town to find candidates whose weight rounds to zero. Where the radius
 * finds nothing the search widens rather than failing — a person who lives on
 * the edge of the extract still gets petrol somewhere.
 *
 * Every figure here is twice what it was, because the truncation had stopped
 * being a cutoff on negligible weight and become the thing deciding the answer.
 * The reference city is about eleven kilometres across and its diagonal is fifteen, so a
 * grocery radius of four could not reach half the city's supermarkets from most
 * addresses, and the average stop leg came out at 2.58 km against a city that
 * ought to be crossed for a weekly shop. Doubling puts the boundary back
 * outside the range where the decay has already made the weight small.
 *
 * The effect is uneven by construction and should be. Candidate count grows
 * with the square of the radius while weight falls as distance to the power of
 * DECAY, so the ring added by doubling only matters where DECAY is below two —
 * groceries, restaurants, retail, health. Convenience at 3.2 and park at 2.8
 * barely move whatever radius they are given, which is right: the point of a
 * corner shop is that it is the corner one.
 */
const REACH: Record<Purpose, number> = {
  grocery: 8.0, convenience: 3.2, cafe: 6.0, "food-quick": 6.0, "food-sit": 10.0,
  bar: 10.0, fuel: 7.0, pharmacy: 7.0, health: 12.0, personal: 8.0,
  errand: 9.0, retail: 12.0, vehicle: 10.0, park: 4.0,
};

/**
 * Spread of venue sizes within a purpose, as the sigma of a lognormal on
 * `pull`. Same device as `orgs.py`, for the same reason: a catalogue where
 * every supermarket is equally likely produces a city with no anchor store in
 * it, and the anchor store is where a third of the grocery trips go.
 *
 * Where OSM knows the answer it is used instead — a `brand` tag is a chain,
 * and a chain outlet is a known quantity rather than a draw.
 */
const SIZE_SIGMA: Record<Purpose, number> = {
  grocery: 0.85, convenience: 0.35, cafe: 0.5, "food-quick": 0.45, "food-sit": 0.6,
  bar: 0.55, fuel: 0.4, pharmacy: 0.4, health: 0.7, personal: 0.45,
  errand: 0.6, retail: 0.9, vehicle: 0.5, park: 1.1,
};

/**
 * Cafés, and what to do about there being five of them.
 *
 * The extract tags 5 cafés, 46 fast food and 125 restaurants. Five is not the
 * number of places in the city where somebody buys a coffee on the way to
 * work; it is the number where a mapper wrote `amenity=cafe`. In the US most
 * of that trade is at counters tagged `amenity=fast_food` — Dunkin', the
 * McDonald's drive-through, the Wawa — and a morning-coffee model that ignores
 * them sends the whole city to two Starbucks.
 *
 * So a breakfast stop draws from cafés *and* fast food, with fast food
 * discounted rather than excluded. The discount is a guess. The alternative —
 * five cafés serving 120,000 people — is not a guess, it is a known error.
 */
const CAFE_THINNESS = 0.55;

export interface Venue {
  id: string;
  lat: number;
  lon: number;
  name: string;
  /** The OSM tag it was matched on, kept so a check can group by it. */
  tag: string;
  purposes: Purpose[];
  /** Relative size. Weighs the Huff draw; not a capacity. */
  pull: number;
  /**
   * ISO 18245 merchant category, from the tag. Null where the tag names
   * somewhere that takes no money — a park, a library, a town hall.
   *
   * A fact about the building rather than about the trip, which is why it is
   * read off `tag` and not off `purposes`. A restaurant with `takeaway=yes` is
   * a lunch counter as far as `tours.ts` is concerned and still clears as 5812.
   */
  mcc: number | null;
  /** True where `pull` is a draw rather than anything the tags said. */
  estimated: boolean;
  chain: string | null;
  opens: number;
  closes: number;
}

/**
 * Opening hours, by purpose, as minutes from midnight.
 *
 * `opening_hours` is tagged on about a fifth of these and in a syntax with a
 * full grammar behind it. Parsing that grammar properly is a day's work for a
 * result this layer would use to answer one question — is it open — so the
 * tag is read only when it is simple and the default carries the rest. A bar
 * closing at 02:00 is expressed as 1560, past midnight, because `time.ts`
 * does not wrap and neither does this.
 */
const HOURS: Record<Purpose, [number, number]> = {
  grocery: [7 * 60, 22 * 60],
  convenience: [6 * 60, 23 * 60],
  cafe: [6 * 60, 17 * 60],
  "food-quick": [6 * 60 + 30, 23 * 60],
  "food-sit": [11 * 60, 22 * 60],
  bar: [16 * 60, 26 * 60],
  fuel: [5 * 60, 23 * 60],
  pharmacy: [8 * 60, 21 * 60],
  health: [8 * 60, 17 * 60],
  personal: [9 * 60, 19 * 60],
  errand: [9 * 60, 17 * 60],
  retail: [10 * 60, 20 * 60],
  vehicle: [8 * 60, 18 * 60],
  park: [5 * 60, 23 * 60],
};

/** Cell size for the grid index. About 550 m of latitude. */
const CELL = 0.005;

function cellKey(lat: number, lon: number): number {
  // A single integer rather than a string: the index is probed a few million
  // times a simulated day and a template literal per probe is not free.
  return (Math.floor(lat / CELL) + 20000) * 100000 + (Math.floor(lon / CELL) + 40000);
}

export class Venues {
  private readonly byId = new Map<string, Venue>();
  private readonly byPurpose = new Map<Purpose, Venue[]>();
  /** purpose → cell → venues. Built once; the town does not gain shops. */
  private readonly grid = new Map<Purpose, Map<number, Venue[]>>();

  private constructor(venues: Venue[]) {
    for (const venue of venues) {
      this.byId.set(venue.id, venue);
      for (const purpose of venue.purposes) {
        let list = this.byPurpose.get(purpose);
        if (!list) this.byPurpose.set(purpose, (list = []));
        list.push(venue);

        let cells = this.grid.get(purpose);
        if (!cells) this.grid.set(purpose, (cells = new Map()));
        const key = cellKey(venue.lat, venue.lon);
        const cell = cells.get(key);
        if (cell) cell.push(venue);
        else cells.set(key, [venue]);
      }
    }
  }

  static async open(
    seed: number,
    file = join(SOURCES_DIR, "pois_export.json"),
    mccFile = join(SIM_DATA_DIR, "mcc_by_tag.json"),
  ): Promise<Venues> {
    const [elements, codes] = await Promise.all([
      Bun.file(file).json().then((data) => (data as { elements: OsmElement[] }).elements),
      // Absent is not an error. The table is generated by a util script and a
      // checkout that has not run it should still be able to plan days; what
      // it loses is the ability to charge for them, which `spend.ts` reports
      // rather than papers over.
      Bun.file(mccFile).exists().then((there) =>
        there ? Bun.file(mccFile).json().then((data) => (data as MccTable).tags) : {}),
    ]);
    return new Venues(build(elements, seed, codes));
  }

  get(id: string): Venue | undefined {
    return this.byId.get(id);
  }

  all(purpose: Purpose): readonly Venue[] {
    return this.byPurpose.get(purpose) ?? [];
  }

  count(purpose: Purpose): number {
    return this.byPurpose.get(purpose)?.length ?? 0;
  }

  /** Distinct venues, which is fewer than the purposes sum to. */
  get size(): number {
    return this.byId.size;
  }

  /** Every id in the catalogue, for the loader that resolves ids to points. */
  points(): Iterable<[string, Point]> {
    const out: [string, Point][] = [];
    for (const venue of this.byId.values()) out.push([venue.id, { lat: venue.lat, lon: venue.lon }]);
    return out;
  }

  /**
   * Candidates within a radius, widening until something is found.
   *
   * Widening rather than failing is the whole reason this is not a plain
   * bounding-box query. About a hundred dwellings in the extract have no
   * supermarket inside four kilometres, and the right answer for them is a
   * long trip, not a person who never buys food.
   */
  near(from: Point, purpose: Purpose, radiusKm = REACH[purpose]): Venue[] {
    const cells = this.grid.get(purpose);
    if (!cells) return [];

    for (let radius = radiusKm; radius <= radiusKm * 8; radius *= 2) {
      const found: Venue[] = [];
      const span = Math.ceil(radius / 111 / CELL);
      const lat0 = Math.floor(from.lat / CELL);
      const lon0 = Math.floor(from.lon / CELL);
      // Longitude cells are narrower than latitude ones this far north, so the
      // span in x is widened by 1/cos(lat) or the box is short of the radius.
      const spanX = Math.ceil(span / Math.cos((from.lat * Math.PI) / 180));

      for (let dy = -span; dy <= span; dy += 1) {
        for (let dx = -spanX; dx <= spanX; dx += 1) {
          const cell = cells.get(((lat0 + dy) + 20000) * 100000 + ((lon0 + dx) + 40000));
          if (!cell) continue;
          for (const venue of cell) {
            if (haversineKm(from, venue) <= radius) found.push(venue);
          }
        }
      }
      if (found.length > 0) return found;
    }
    return [...(this.byPurpose.get(purpose) ?? [])];
  }

  /**
   * Huff: pick by size over distance, from wherever the person is.
   *
   * Straight-line distance, not routed. Routing every candidate would mean a
   * few hundred shortest paths to choose one shop, and the choice is not
   * sensitive enough to the difference to pay for it — the winner is routed
   * afterwards, and that is the number the plan actually uses.
   */
  choose(from: Point, purpose: Purpose, rng: Rng, at?: number): Venue | null {
    const candidates = this.near(from, purpose).filter((v) => at === undefined || isOpen(v, at));
    if (candidates.length === 0) return null;

    const decay = DECAY[purpose];
    const weights = candidates.map((venue) => {
      const km = Math.max(0.12, haversineKm(from, venue));
      const thin = purpose === "cafe" && venue.tag === "amenity=fast_food" ? CAFE_THINNESS : 1;
      return (venue.pull * thin) / Math.pow(km, decay);
    });
    return rng.weighted(candidates, weights);
  }

  /**
   * The same choice, but for a stop on the way between two points.
   *
   * The choice set is everything whose detour is inside a budget, and the
   * weight trades size against the minutes the detour costs rather than
   * against distance from an origin. This is what makes an intercept stop an
   * intercept stop: the supermarket that wins on the way home is not the one
   * nearest home, it is the one nearest the line, and those are different
   * shops for most of the city.
   *
   * Detour is measured in straight lines for the same reason `choose` is. A
   * corridor that is right to within a few hundred metres is enough to decide
   * which shops are candidates; the cost that goes into the plan is routed.
   */
  chooseOnRoute(from: Point, to: Point, purpose: Purpose, budgetKm: number, rng: Rng, at?: number): Venue | null {
    const direct = haversineKm(from, to);
    // Search from the midpoint with a radius that covers the whole ellipse the
    // budget allows, which is what a corridor is.
    const mid = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 };
    const candidates = this.near(mid, purpose, direct / 2 + budgetKm);

    const kept: Venue[] = [];
    const weights: number[] = [];
    for (const venue of candidates) {
      if (at !== undefined && !isOpen(venue, at)) continue;
      const detour = haversineKm(from, venue) + haversineKm(venue, to) - direct;
      if (detour > budgetKm) continue;
      const thin = purpose === "cafe" && venue.tag === "amenity=fast_food" ? CAFE_THINNESS : 1;
      // Detour is cheap near zero and expensive near the budget, which is why
      // this is not the same decay `choose` uses. A shop you pass the door of
      // beats one that costs four minutes, by much more than their sizes differ.
      kept.push(venue);
      weights.push((venue.pull * thin) / Math.pow(1 + detour, 2.6));
    }
    if (kept.length === 0) return null;
    return rng.weighted(kept, weights);
  }

  /**
   * The venue this person uses for this purpose — their supermarket, their
   * petrol station, their café.
   *
   * This is the mechanism that does the work a membership record would do for
   * an org, and it is why a café needs no roster. People are not redrawn into
   * a new shop every week; they have one, and a second they use when the first
   * is awkward, and they go somewhere new only occasionally. Drawing the venue
   * fresh at every visit would give every person in Kierston a uniform smear
   * over every shop in range — which destroys exactly the thing that makes a
   * venue log legible, that the same face is at the same counter on most
   * Tuesdays.
   *
   * Loyalty is not total, and the tail matters: the fresh draw is what puts
   * somebody in a shop they have no business being in, which is the trip an
   * analyst actually notices.
   */
  habitual(seed: number, person: number, home: Point, purpose: Purpose, rng: Rng, at?: number): Venue | null {
    const roll = rng.next();
    if (roll > PRIMARY + SECONDARY) return this.choose(home, purpose, rng, at);

    // The habit itself is one draw per person per purpose, never per day.
    const habit = new Rng(mix(seed, person, LAYER.habit, hashPurpose(purpose)));
    const first = this.choose(home, purpose, habit, undefined);
    if (roll <= PRIMARY) {
      if (first && (at === undefined || isOpen(first, at))) return first;
      // Shut. The second choice is where a person actually goes at 22:30, and
      // returning nothing here would silently delete the trip.
      return this.choose(home, purpose, rng, at);
    }
    const second = this.choose(home, purpose, habit, undefined);
    if (second && (at === undefined || isOpen(second, at))) return second;
    return this.choose(home, purpose, rng, at);
  }
}

/** Share of visits that go to the habitual venue, and to the fallback. */
const PRIMARY = 0.62;
const SECONDARY = 0.23;

export function isOpen(venue: Venue, minute: number): boolean {
  // Minutes may run past midnight for a night shift, and a shop that closes at
  // 22:00 is shut at 25:00 as well as at 01:00.
  const within = ((minute % 1440) + 1440) % 1440;
  if (venue.closes > 1440) return within >= venue.opens || within <= venue.closes - 1440;
  return within >= venue.opens && within <= venue.closes;
}

/** Stable integer for a string key, so a stream can be keyed on one. */
function hashPurpose(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return h;
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const PURPOSE_OF_TAG = (() => {
  const map = new Map<string, Purpose[]>();
  for (const [purpose, tags] of Object.entries(TAGS) as [Purpose, readonly string[]][]) {
    for (const tag of tags) {
      const list = map.get(tag);
      if (list) list.push(purpose);
      else map.set(tag, [purpose]);
    }
  }
  return map;
})();

/** `data/mcc_by_tag.json`, as `util_scripts/assign_mcc.py --write` emits it. */
interface MccTable {
  tags: Record<string, number>;
  labels: Record<string, string>;
}

function build(elements: OsmElement[], seed: number, codes: Record<string, number>): Venue[] {
  const venues: Venue[] = [];

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (lat === undefined || lon === undefined) continue;

    let tag: string | null = null;
    let purposes: Purpose[] | undefined;
    for (const key of ["amenity", "shop", "leisure", "office", "tourism"]) {
      const value = tags[key];
      if (!value) continue;
      const found = PURPOSE_OF_TAG.get(`${key}=${value}`);
      if (found) {
        tag = `${key}=${value}`;
        purposes = found;
        break;
      }
    }
    if (!tag || !purposes) continue;

    // A café that is also a bakery, a restaurant that is also a bar. The tag
    // picks one purpose; `cuisine` and `takeaway` add the others, because a
    // sandwich shop with `takeaway=yes` is a lunch stop as well as a sit-down.
    const extra = new Set(purposes);
    if (tag === "amenity=restaurant" && tags["takeaway"] === "yes") extra.add("food-quick");
    if (tag === "amenity=restaurant" && (tags["cuisine"] ?? "").includes("coffee")) extra.add("cafe");
    // Every fast food counter is somewhere you can buy a coffee, which is the
    // whole of CAFE_THINNESS made real. Gating this on a `cuisine` tag — as
    // this did at first — left the cafe purpose with sixteen venues in the
    // whole town, so a morning coffee was almost never on anybody's way and
    // the model sent them out on a dedicated trip for it instead. The weight
    // discount, not the tag, is what keeps a McDonald's from reading as a café.
    if (tag === "amenity=fast_food") extra.add("cafe");
    if (tag === "shop=convenience" && tags["fuel"] === "yes") extra.add("fuel");
    if (tag === "amenity=fuel" && tags["shop"] === "convenience") extra.add("convenience");

    const id = `v:${element.type}/${element.id}`;
    const rng = new Rng(mix(seed, hashPurpose(id), 0x5e1));
    const primary = purposes[0]!;
    const chain = tags["brand"] ?? null;

    // A chain outlet is a known quantity: it is the format that is standard,
    // not the site. Drawing one a tenth the size of another is inventing a
    // difference the brand exists to remove.
    const pull = chain
      ? Math.exp(SIZE_SIGMA[primary] * 0.35)
      : Math.exp(rng.gauss(0, SIZE_SIGMA[primary]));

    const [opens, closes] = simpleHours(tags["opening_hours"]) ?? HOURS[primary];

    venues.push({
      id,
      lat,
      lon,
      name: tags["name"] ?? tags["brand"] ?? "",
      tag,
      purposes: [...extra],
      pull: Math.round(pull * 1000) / 1000,
      mcc: codes[tag] ?? null,
      estimated: true,
      chain,
      opens,
      closes,
    });
  }

  return venues;
}

/**
 * `opening_hours`, read only where it is one plain range.
 *
 * The tag has a real grammar — day sets, month rules, public holidays, `off`
 * exceptions, sunset — and a parser for it is not what this layer is for. So
 * the simple case is honoured and everything else falls back to the purpose
 * default, which is the honest thing to do: a half-parsed rule that silently
 * ignores the exception it was written to express is worse than a default that
 * never claimed to know.
 */
function simpleHours(text: string | undefined): [number, number] | null {
  if (!text) return null;
  if (text === "24/7") return [0, 1440];
  const match = /^(?:Mo-Su\s+|Mo-Fr\s+)?(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const opens = Number(match[1]) * 60 + Number(match[2]);
  let closes = Number(match[3]) * 60 + Number(match[4]);
  if (closes <= opens) closes += 1440;
  return [opens, closes];
}

export { DECAY, REACH, PURPOSE_OF_TAG };

"use client";

import { humanise } from "./format";

/**
 * Who knows whom, and how well.
 *
 * sim_data/ties.bin is written by init/social/ties.py and holds 3.3 million
 * edges over the whole city. The container is the one population.bin and the
 * record files use — magic, a JSON header, then the columns as raw typed
 * arrays — and the header carries the vocabularies, so the kind names, the
 * focus bits and the affinity tiers are read out of the file rather than
 * restated here. Change a tier cut in the generator and this follows it.
 *
 * Two numbers per tie, not one, and the whole file is built on their being
 * independent:
 *
 *     exposure   how often the two are in the same room. A shift is daily,
 *                a congregation weekly, an old friend across town never.
 *     affinity   how much they actually like each other.
 *
 * The man on the next pick line has high exposure and low affinity; the golf
 * partner has the reverse. A viewer that averaged them into one "strength"
 * would draw those two identically, which is exactly the distinction the
 * generator exists to make — so every view here shows both, side by side.
 *
 * Edges are stored once, canonically, with the lower id first. That makes the
 * file half the size and makes every question a reader asks — "who does this
 * person know" — need an index that does not exist in it. Building that index
 * is the whole cost of loading: one counting pass and one filling pass over
 * 3.3 million edges, about 26 MB of Int32Array, and after it a person's ties
 * are a slice rather than a scan.
 */

const MAGIC = "KTIE";

/** A relative or friend left behind in the country somebody emigrated from. */
export interface AbroadStub {
  id: number;
  region: string;
  /** The resident this stub belongs to. */
  of: number;
}

/** A colleague from a job the resident has since left. */
export interface FormerStub {
  id: number;
  of: number;
}

export interface TieHeader {
  magic: string;
  seed: number;
  reference_year: number;
  edges: number;
  kinds: string[];
  foci: string[];
  /** [affinity floor, name], strongest first. */
  tiers: [number, string][];
  external_base: number;
  abroad_base: number;
  former_base: number;
  /** Per-focus realisation rates, for the page that explains the model. */
  intercepts: Record<string, number>;
  stubs: { abroad: AbroadStub[]; former: FormerStub[] };
  columns: { name: string; dtype: string }[];
}

/** One end of one tie, as seen from the person who asked for it. */
export interface Tie {
  /** Row in the edge columns, and the identity a view can key on. */
  edge: number;
  /** The other end: a resident id, or a stub at or above `abroadBase`. */
  other: number;
  kind: string;
  /** The focus classes that produced it, as a bitmask — see `fociOf`. */
  focus: number;
  /** 0–1. How often they are in the same room. */
  exposure: number;
  /** 0–1. How much they like each other. */
  affinity: number;
  /** +1 for a live tie, −1 for one that exists precisely because it does not. */
  valence: number;
  /** The year it started, or 0 where the generator did not date it. */
  since: number;
  /** The affinity band it falls in — "close_friend" down to "acquaintance". */
  tier: string;
}

export interface TieStats {
  ties: number;
  /** Ties in each positive tier, keyed by tier name. */
  byTier: Map<string, number>;
  /** Ties by provenance, keyed by kind, strongest count first. */
  byKind: { kind: string; count: number }[];
  negative: number;
  /** Ties to somebody outside the population — abroad, or a job since left. */
  outside: number;
  meanExposure: number;
  meanAffinity: number;
  /** How many hours a week of exposure the whole ego network adds up to. */
  exposureSum: number;
}

/**
 * The six groups the ego network is drawn and coloured by.
 *
 * Provenance has seventeen values, which is four more hues than anybody can
 * hold apart on a scatter. These are the cuts that survive being looked at:
 * where somebody knows you from, at the resolution a reader actually reasons
 * in. The full kind is still on every row of the list beside the diagram.
 */
export type TieGroup =
  | "family" | "work" | "school" | "community" | "neighbourhood" | "elsewhere";

export const TIE_GROUPS: TieGroup[] = [
  "family", "work", "school", "community", "neighbourhood", "elsewhere",
];

export const GROUP_LABEL: Record<TieGroup, string> = {
  family: "Family and household",
  work: "Work",
  school: "School",
  community: "Clubs and congregations",
  neighbourhood: "Neighbours",
  elsewhere: "Elsewhere",
};

const GROUP_OF_KIND: Record<string, TieGroup> = {
  household: "family",
  parent: "family",
  child: "family",
  sibling: "family",
  partner: "family",
  ex_partner: "family",
  coparent: "family",
  grandparent: "family",
  kin_ext: "family",
  colleague: "work",
  ex_colleague: "work",
  classmate: "school",
  clubmate: "community",
  congregant: "community",
  neighbour: "neighbourhood",
  elsewhere: "elsewhere",
  abroad: "elsewhere",
};

export function groupOf(kind: string): TieGroup {
  return GROUP_OF_KIND[kind] ?? "elsewhere";
}

/**
 * What to call a tie of each provenance.
 *
 * Edges are stored with the lower resident id first, so the two asymmetric
 * kinds — parent and grandparent — carry no direction. `relationLabel` puts it
 * back from the two ages, which is the only honest source for it here:
 * kinship.json is where the roles are actually stated, and the record page
 * reads them from there.
 */
export const KIND_LABEL: Record<string, string> = {
  household: "Household",
  parent: "Parent",
  child: "Child",
  sibling: "Sibling",
  partner: "Partner",
  ex_partner: "Ex-partner",
  coparent: "Co-parent",
  grandparent: "Grandparent",
  kin_ext: "Extended family",
  colleague: "Colleague",
  ex_colleague: "Former colleague",
  classmate: "Classmate",
  clubmate: "Club or team",
  congregant: "Congregation",
  neighbour: "Neighbour",
  elsewhere: "Elsewhere",
  abroad: "Abroad",
};

export const FOCUS_LABEL: Record<string, string> = {
  work: "work",
  school: "school",
  worship: "worship",
  gym: "gym",
  sports: "team",
  civic: "civic group",
  fraternal: "lodge",
  youth: "youth group",
  union: "union",
  household: "household",
  kin: "family",
  neighbour: "street",
  elsewhere: "elsewhere",
  abroad: "abroad",
};

export const TIER_LABEL: Record<string, string> = {
  close_friend: "Close friends",
  friend: "Friends",
  friendly: "Friendly",
  acquaintance: "Acquaintances",
  known_of: "Known of",
};

/** A relation named from one side, with the direction the file cannot state. */
export function relationLabel(
  kind: string,
  egoAge: number | null,
  otherAge: number | null,
): string {
  if ((kind === "parent" || kind === "grandparent")
    && egoAge !== null && otherAge !== null) {
    const older = otherAge > egoAge;
    if (kind === "parent") return older ? "Parent" : "Child";
    return older ? "Grandparent" : "Grandchild";
  }
  return KIND_LABEL[kind] ?? humanise(kind);
}

/**
 * A typed view onto the buffer, copied only where it has to be.
 *
 * The columns are written back to back with no padding between them, so a
 * 4-byte column can land on an offset a 4-byte view is not allowed to start
 * at. With the shapes ties.py writes today that never happens; a generator
 * that grew an odd-length column would make it happen silently, and a decoder
 * that threw on it would be a strange way to find out.
 */
function view<T>(
  Ctor: new (buffer: ArrayBufferLike, offset?: number, length?: number) => T,
  bytes: number,
  buffer: ArrayBuffer,
  offset: number,
  length: number,
): T {
  if (offset % bytes === 0) return new Ctor(buffer, offset, length);
  const copy = buffer.slice(offset, offset + length * bytes);
  return new Ctor(copy, 0, length);
}

export class TieGraph {
  readonly header: TieHeader;
  readonly seed: number;
  readonly referenceYear: number;
  readonly edges: number;
  readonly kinds: string[];
  readonly foci: string[];
  readonly tiers: [number, string][];
  readonly abroadBase: number;
  readonly formerBase: number;
  /** Every id at or above this belongs to somebody with no record. */
  readonly externalBase: number;

  readonly a: Int32Array;
  readonly b: Int32Array;
  private readonly kind: Uint8Array;
  private readonly focus: Uint16Array;
  private readonly exposure: Uint8Array;
  private readonly affinity: Uint8Array;
  private readonly valence: Int8Array;
  private readonly sinceYear: Uint16Array;

  /** How many residents the index covers — the population's own count. */
  readonly persons: number;
  /** CSR over both directions: `slots[start[p] … start[p + 1])` are edge rows. */
  private readonly start: Int32Array;
  private readonly slots: Int32Array;
  /** Ties per person, which is the column the browser sorts on. */
  readonly degrees: Int32Array;

  private readonly stubOf = new Map<number, AbroadStub | FormerStub>();
  private closeCounts: Int32Array | null = null;
  /** Kind code to group index, so the table can colour a row without objects. */
  private readonly groupCode: Uint8Array;

  constructor(header: TieHeader, buffer: ArrayBuffer, dataStart: number, persons: number) {
    this.header = header;
    this.seed = header.seed;
    this.referenceYear = header.reference_year;
    this.edges = header.edges;
    this.kinds = header.kinds;
    this.foci = header.foci;
    this.tiers = header.tiers;
    this.abroadBase = header.abroad_base;
    this.formerBase = header.former_base;
    this.externalBase = header.external_base;
    this.persons = persons;

    const n = header.edges;
    let at = dataStart;
    this.a = view(Int32Array, 4, buffer, at, n); at += n * 4;
    this.b = view(Int32Array, 4, buffer, at, n); at += n * 4;
    this.kind = view(Uint8Array, 1, buffer, at, n); at += n;
    this.focus = view(Uint16Array, 2, buffer, at, n); at += n * 2;
    this.exposure = view(Uint8Array, 1, buffer, at, n); at += n;
    this.affinity = view(Uint8Array, 1, buffer, at, n); at += n;
    this.valence = view(Int8Array, 1, buffer, at, n); at += n;
    this.sinceYear = view(Uint16Array, 2, buffer, at, n);

    for (const stub of header.stubs.abroad) this.stubOf.set(stub.id, stub);
    for (const stub of header.stubs.former) this.stubOf.set(stub.id, stub);

    this.groupCode = new Uint8Array(header.kinds.length);
    header.kinds.forEach((kind, code) => {
      this.groupCode[code] = TIE_GROUPS.indexOf(groupOf(kind));
    });

    // The index. Both ends of a resident-to-resident edge get a slot; a stub
    // gets none, because nobody browses the social life of a cousin in
    // Santo Domingo who exists as three fields in a header.
    const counts = new Int32Array(persons + 1);
    for (let e = 0; e < n; e += 1) {
      const x = this.a[e];
      const y = this.b[e];
      if (x < persons) counts[x] += 1;
      if (y < persons) counts[y] += 1;
    }
    this.degrees = counts.slice(0, persons);

    const start = new Int32Array(persons + 1);
    let total = 0;
    for (let p = 0; p < persons; p += 1) {
      start[p] = total;
      total += counts[p];
    }
    start[persons] = total;

    const slots = new Int32Array(total);
    const cursor = start.slice(0, persons);
    for (let e = 0; e < n; e += 1) {
      const x = this.a[e];
      const y = this.b[e];
      if (x < persons) slots[cursor[x]++] = e;
      if (y < persons) slots[cursor[y]++] = e;
    }
    this.start = start;
    this.slots = slots;
  }

  /** Whether an id stands for somebody outside the population. */
  isStub(id: number): boolean { return id >= this.externalBase; }

  stub(id: number): AbroadStub | FormerStub | null {
    return this.stubOf.get(id) ?? null;
  }

  /** One line for a person who is not here — all there is to say about them. */
  stubLabel(id: number): string {
    const stub = this.stub(id);
    if (!stub) return "Non-resident";
    if ("region" in stub) return `Abroad · ${humanise(stub.region)}`;
    return "Former job";
  }

  /** The affinity band a tie falls in. */
  tierOf(affinity: number): string {
    for (const [floor, name] of this.tiers) {
      if (affinity >= floor) return name;
    }
    return this.tiers[this.tiers.length - 1][1];
  }

  /** The affinity a tie needs to count as a friendship. */
  get friendFloor(): number {
    return this.tiers.find(([, name]) => name === "friend")?.[0] ?? 0.5;
  }

  get closeFloor(): number {
    return this.tiers.find(([, name]) => name === "close_friend")?.[0] ?? 0.85;
  }

  /** The focus classes behind a tie, named. */
  fociOf(mask: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.foci.length; i += 1) {
      if (mask & (1 << i)) out.push(this.foci[i]);
    }
    return out;
  }

  degreeOf(person: number): number {
    return person >= 0 && person < this.persons ? this.degrees[person] : 0;
  }

  /** One edge, read from the side of the person who asked. */
  private read(edge: number, person: number): Tie {
    const affinity = this.affinity[edge] / 255;
    return {
      edge,
      other: this.a[edge] === person ? this.b[edge] : this.a[edge],
      kind: this.kinds[this.kind[edge]] ?? "elsewhere",
      focus: this.focus[edge],
      exposure: this.exposure[edge] / 255,
      affinity,
      valence: this.valence[edge],
      since: this.sinceYear[edge],
      tier: this.tierOf(affinity),
    };
  }

  /**
   * Everyone this person knows, closest first.
   *
   * Negative ties sort to the bottom rather than out: an estrangement is a
   * fact about somebody, and the ordering says so by putting it last instead
   * of by hiding it.
   */
  tiesOf(person: number): Tie[] {
    if (person < 0 || person >= this.persons) return [];
    const out: Tie[] = [];
    for (let i = this.start[person]; i < this.start[person + 1]; i += 1) {
      out.push(this.read(this.slots[i], person));
    }
    out.sort((x, y) => y.valence - x.valence
      || y.affinity - x.affinity
      || y.exposure - x.exposure);
    return out;
  }

  /**
   * Where most of somebody's circle comes from, counted off the columns.
   *
   * The browser draws this on every visible row, so it goes nowhere near
   * `tiesOf`: a table scrolling past forty people with four hundred ties each
   * would allocate twenty thousand objects a frame to end up with one word.
   */
  topGroup(person: number): { group: TieGroup; count: number } | null {
    if (person < 0 || person >= this.persons) return null;
    const counts = new Int32Array(TIE_GROUPS.length);
    for (let i = this.start[person]; i < this.start[person + 1]; i += 1) {
      counts[this.groupCode[this.kind[this.slots[i]]]] += 1;
    }
    let best = -1;
    for (let g = 0; g < counts.length; g += 1) {
      if (best < 0 || counts[g] > counts[best]) best = g;
    }
    return best >= 0 && counts[best] > 0
      ? { group: TIE_GROUPS[best], count: counts[best] }
      : null;
  }

  /** The tie between two people, if there is one. */
  between(person: number, other: number): Tie | null {
    if (person < 0 || person >= this.persons) return null;
    for (let i = this.start[person]; i < this.start[person + 1]; i += 1) {
      const edge = this.slots[i];
      if (this.a[edge] === other || this.b[edge] === other) {
        return this.read(edge, person);
      }
    }
    return null;
  }

  /**
   * How many friendships each person holds, built on first use.
   *
   * The browser sorts on it, so it is a column and not a per-row call: 3.3
   * million edges is a scan worth paying for once and never again.
   */
  get closeDegrees(): Int32Array {
    if (this.closeCounts) return this.closeCounts;
    const floor = Math.round(this.friendFloor * 255);
    const counts = new Int32Array(this.persons);
    for (let e = 0; e < this.edges; e += 1) {
      if (this.affinity[e] < floor || this.valence[e] < 0) continue;
      const x = this.a[e];
      const y = this.b[e];
      if (x < this.persons) counts[x] += 1;
      if (y < this.persons) counts[y] += 1;
    }
    this.closeCounts = counts;
    return counts;
  }

  /** The shape of one person's social life, for the panel above their ties. */
  statsOf(person: number, ties?: Tie[]): TieStats {
    const list = ties ?? this.tiesOf(person);
    const byTier = new Map<string, number>();
    const kinds = new Map<string, number>();
    let negative = 0;
    let outside = 0;
    let exposureSum = 0;
    let affinitySum = 0;

    for (const tie of list) {
      if (tie.valence < 0) negative += 1;
      else byTier.set(tie.tier, (byTier.get(tie.tier) ?? 0) + 1);
      if (this.isStub(tie.other)) outside += 1;
      kinds.set(tie.kind, (kinds.get(tie.kind) ?? 0) + 1);
      exposureSum += tie.exposure;
      affinitySum += tie.affinity;
    }

    return {
      ties: list.length,
      byTier,
      byKind: [...kinds]
        .map(([kind, count]) => ({ kind, count }))
        .sort((x, y) => y.count - x.count),
      negative,
      outside,
      meanExposure: list.length ? exposureSum / list.length : 0,
      meanAffinity: list.length ? affinitySum / list.length : 0,
      exposureSum,
    };
  }

  /**
   * The people two hops away, and how many friends they have in common.
   *
   * Only friendships are walked, in both hops. Walking every tie would return
   * most of the city — a shift of twelve times a congregation of two hundred
   * is not a social circle — and the number that makes this worth showing is
   * the count of shared friends, which is what closure in the generator built
   * and what a reader is actually looking for.
   */
  mutuals(person: number, limit = 12): { id: number; shared: number }[] {
    const floor = this.friendFloor;
    const friends: number[] = [];
    const known = new Set<number>([person]);
    for (const tie of this.tiesOf(person)) {
      known.add(tie.other);
      if (tie.valence > 0 && tie.affinity >= floor && !this.isStub(tie.other)) {
        friends.push(tie.other);
      }
    }

    const shared = new Map<number, number>();
    for (const friend of friends) {
      for (const tie of this.tiesOf(friend)) {
        if (tie.valence < 0 || tie.affinity < floor) continue;
        if (known.has(tie.other) || this.isStub(tie.other)) continue;
        shared.set(tie.other, (shared.get(tie.other) ?? 0) + 1);
      }
    }

    return [...shared]
      .map(([id, count]) => ({ id, shared: count }))
      .sort((x, y) => y.shared - x.shared || x.id - y.id)
      .slice(0, limit);
  }
}

const align8 = (value: number) => (value + 7) & ~7;

export function decodeTies(buffer: ArrayBuffer, persons: number): TieGraph {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a ties binary — run kierston/init/social/ties.py");
  }
  const headerLength = new DataView(buffer).getUint32(4, true);
  const header: TieHeader = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  return new TieGraph(header, buffer, align8(8 + headerLength), persons);
}

export async function loadTies(url: string, persons: number): Promise<TieGraph> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return decodeTies(await response.arrayBuffer(), persons);
}

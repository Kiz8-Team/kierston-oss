"use client";

/**
 * Who is whose parent, and everything that follows from it.
 *
 * sim_data/kinship.json is written by init/social/kinship.py and holds one
 * direction of the graph only: for each person, the parents above them. That
 * is the honest way to store it — a parent edge is drawn once and inferred
 * from one child's household — but it is the wrong way round for every
 * question a reader asks. Nobody opens a record to find out who somebody's
 * mother is and stops there; they want the children, the siblings, and the
 * partner, none of which the file states.
 *
 * So this inverts it once, on load, and answers the rest by lookup. Children
 * are the parent map read backwards. Siblings are the people who share a
 * parent, graded by how many they share — two makes a full sibling, one a
 * half. Partners are the pairs the household pass established, indexed both
 * ways.
 *
 * Two kinds of id appear here. Anything below `externalBase` is a resident and
 * indexes the population, identity and record files like every other id in the
 * app. Anything at or above it is a stub: a parent who is dead or living
 * outside Kierston, who exists only as the handful of facts in `externals` and
 * has no record to open. Callers that render a parent have to handle both,
 * which is what `isExternal` is for.
 */

export type Role = "mother" | "father";
export type ParentKind = "birth" | "adoptive" | "step" | "foster";
export type ParentBasis = "household" | "matched" | "external";
export type PartnerKind = "spouse" | "partner";
export type ExternalStatus = "elsewhere" | "deceased";

/** Kinds that sit beside a birth parent rather than replacing one. */
const STEP_KINDS = new Set<ParentKind>(["step", "foster"]);

export interface ParentEdge {
  id: number;
  role: Role;
  kind: ParentKind;
  /**
   * How the edge was arrived at: read out of the household roster, matched
   * against the wider city, or filled by a stub. It is the field that says how
   * much to trust the rest, so the views show it.
   */
  basis: ParentBasis;
}

/** A parent who is not in the population — dead, or living somewhere else. */
export interface External {
  id: number;
  /** PUMS coding: 1 male, 2 female. */
  sex: number;
  birth_year: number;
  race_ethnicity: string;
  status: ExternalStatus;
  /** How many people in the city this stub is the parent of. */
  children: number;
}

/** [a, b, kind] — undirected, stated once. */
export type PartnerEdge = [number, number, PartnerKind];

export interface KinshipFile {
  seed: number;
  reference_year: number;
  persons: number;
  external_base: number;
  parent_in_city: number;
  externals: External[];
  partners: PartnerEdge[];
  parents: Record<string, ParentEdge[]>;
}

/** How closely two people who share a parent are related. */
export type Tie = "full" | "half" | "step";

export interface Sibling {
  id: number;
  tie: Tie;
  /** The parents held in common, which is what the tie is graded on. */
  shared: ParentEdge[];
}

export interface Partner {
  id: number;
  kind: PartnerKind;
}

export const TIE_LABEL: Record<Tie, string> = {
  full: "Full sibling",
  half: "Half sibling",
  step: "Stepsibling",
};

/**
 * What to call a parent, given the role and the kind together.
 *
 * Spelled out rather than composed, because "step mother" and "birth mother"
 * are what composition produces and neither is what anybody writes.
 */
export const PARENT_LABEL: Record<ParentKind, Record<Role, string>> = {
  birth: { mother: "Mother", father: "Father" },
  adoptive: { mother: "Adoptive mother", father: "Adoptive father" },
  step: { mother: "Stepmother", father: "Stepfather" },
  foster: { mother: "Foster mother", father: "Foster father" },
};

export const BASIS_NOTE: Record<ParentBasis, string> = {
  household: "Household roster",
  matched: "Matched resident",
  external: "Outside population",
};

export const STATUS_LABEL: Record<ExternalStatus, string> = {
  elsewhere: "living elsewhere",
  deceased: "deceased",
};

/** Mother before father, birth before step, so a list reads the same way twice. */
const ROLE_ORDER: Record<Role, number> = { mother: 0, father: 1 };

function edgeOrder(a: ParentEdge, b: ParentEdge): number {
  const step = Number(STEP_KINDS.has(a.kind)) - Number(STEP_KINDS.has(b.kind));
  return step || ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
}

export class Kinship {
  readonly seed: number;
  readonly referenceYear: number;
  readonly persons: number;
  readonly externalBase: number;
  /** The share of missing parents the generator kept inside the city. */
  readonly parentInCity: number;

  /** Parent edges by resident id. Sparse — a third of the city has none. */
  private readonly up: Map<number, ParentEdge[]>;
  /** The same edges read downwards, keyed by parent, residents and stubs alike. */
  private readonly down: Map<number, number[]>;
  private readonly partners: Map<number, Partner>;
  private readonly stubs: Map<number, External>;

  readonly edges: number;

  constructor(file: KinshipFile) {
    this.seed = file.seed;
    this.referenceYear = file.reference_year;
    this.persons = file.persons;
    this.externalBase = file.external_base;
    this.parentInCity = file.parent_in_city;

    this.up = new Map();
    this.down = new Map();
    let edges = 0;
    for (const [key, list] of Object.entries(file.parents)) {
      const child = Number(key);
      const sorted = [...list].sort(edgeOrder);
      this.up.set(child, sorted);
      edges += sorted.length;
      for (const edge of sorted) {
        const kids = this.down.get(edge.id);
        if (kids) kids.push(child);
        else this.down.set(edge.id, [child]);
      }
    }
    this.edges = edges;

    // Children arrive in whatever order the parent map was written in, which
    // is by child id and so is already the order a family reads in — oldest
    // last, since the population is not sorted by age. Sorting by id keeps it
    // stable rather than meaningful; age is the view's business, not this one's.
    for (const kids of this.down.values()) kids.sort((a, b) => a - b);

    this.partners = new Map();
    for (const [a, b, kind] of file.partners) {
      this.partners.set(a, { id: b, kind });
      this.partners.set(b, { id: a, kind });
    }

    this.stubs = new Map();
    for (const stub of file.externals) this.stubs.set(stub.id, stub);
  }

  /** Whether an id is a stub rather than a resident with a record. */
  isExternal(id: number): boolean {
    return id >= this.externalBase;
  }

  external(id: number): External | null {
    return this.stubs.get(id) ?? null;
  }

  parentsOf(person: number): ParentEdge[] {
    return this.up.get(person) ?? [];
  }

  /** Everyone in the city this person is a parent of. Works for stubs too. */
  childrenOf(person: number): number[] {
    return this.down.get(person) ?? [];
  }

  partnerOf(person: number): Partner | null {
    return this.partners.get(person) ?? null;
  }

  /**
   * The people this person shares a parent with, closest tie first.
   *
   * Graded on the birth and adoptive edges only: two in common is a full
   * sibling, one is a half sibling, and anyone reached solely through a
   * stepparent is a stepsibling. The distinction matters more here than it
   * would in a family tree drawn by hand, because half siblings are what the
   * city pass produces when it hands one woman's spare parity to children in
   * two different households — so a record that called them all "sibling"
   * would be hiding the generator's most interesting output.
   */
  siblingsOf(person: number): Sibling[] {
    const mine = this.parentsOf(person);
    if (!mine.length) return [];

    const shared = new Map<number, ParentEdge[]>();
    for (const edge of mine) {
      for (const other of this.childrenOf(edge.id)) {
        if (other === person) continue;
        const list = shared.get(other);
        if (list) list.push(edge);
        else shared.set(other, [edge]);
      }
    }

    const out: Sibling[] = [];
    for (const [id, edges] of shared) {
      // A shared parent only counts towards a full or half tie where the
      // relationship is a parental one on both sides. A stepmother shared with
      // her own son makes him a stepsibling, not a half brother.
      const blood = edges.filter(
        (edge) => !STEP_KINDS.has(edge.kind)
          && this.parentsOf(id).some(
            (theirs) => theirs.id === edge.id && !STEP_KINDS.has(theirs.kind),
          ),
      );
      const tie: Tie = blood.length >= 2 ? "full" : blood.length === 1 ? "half" : "step";
      out.push({ id, tie, shared: edges.sort(edgeOrder) });
    }

    const rank: Record<Tie, number> = { full: 0, half: 1, step: 2 };
    out.sort((a, b) => rank[a.tie] - rank[b.tie] || a.id - b.id);
    return out;
  }

  /**
   * The generation above the parents, each labelled with the side it is on.
   *
   * A stub has no parents of its own, so the only grandparents that exist are
   * the ones reached through a parent who lives here — which makes this
   * sparser than it sounds and worth showing when it is there: a resident with
   * four grandparents in the file is three generations of one city.
   *
   * Climbed through birth and adoptive parents only. A stepmother's parents
   * are not this person's grandparents in any sense the label "maternal
   * grandmother" would survive, and including them gave people six.
   */
  grandparentsOf(person: number): { edge: ParentEdge; via: ParentEdge }[] {
    const out: { edge: ParentEdge; via: ParentEdge }[] = [];
    const seen = new Set<number>([person]);
    for (const via of this.parentsOf(person)) {
      if (this.isExternal(via.id) || STEP_KINDS.has(via.kind)) continue;
      for (const edge of this.parentsOf(via.id)) {
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        out.push({ edge, via });
      }
    }
    return out;
  }

  /** Whether this person has any relative at all worth drawing a section for. */
  hasFamily(person: number): boolean {
    return this.up.has(person) || this.down.has(person) || this.partners.has(person);
  }
}

/** A stub parent in one line — all there is to say about someone with no record. */
export function externalLabel(stub: External | null): string {
  if (!stub) return "Outside population";
  return `Born ${stub.birth_year} · ${STATUS_LABEL[stub.status]}`;
}

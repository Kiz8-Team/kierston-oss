/**
 * Who each person would actually contact, and how often — by phone, and in person.
 *
 * `ties.bin` holds every relationship in the city — around three and a quarter
 * million edges — and most of them are not communication. The man on the next
 * pick line is a tie with high exposure and low affinity, and `ties.py` is
 * explicit that he exists precisely so he can be told apart from a golf
 * partner: he generates shared location and no phone calls, and the golf
 * partner generates a text about a tee time and no shared location.
 *
 * This file used to be the half of that sentence about phone calls and lived
 * in `comms/`. It is now both halves. Every edge carries two rates rather than
 * one — `rate`, the phone traffic `comms/` samples, and `social`, the
 * deliberate meetings `meetings.ts` samples — because the two are different
 * functions of the same tie and disagree about exposure in opposite
 * directions. See `weeklyRate` and `socialRate`.
 *
 * The first reader of ties.bin in the runtime
 * -------------------------------------------
 * Nothing in `sim/` opened this file before. It is written as one packed
 * columnar table with a JSON header, the same envelope as every other init
 * binary, and it is read whole — a few million edges of eight columns is some
 * tens of MB in memory, which is affordable once and not affordable per person.
 * It is loaded with the day context rather than with the communications layer,
 * because a shared activity changes where somebody goes and a run that skipped
 * it would produce a different day.
 *
 * The contact rate, and why exposure subtracts
 * --------------------------------------------
 * Volume is affinity, damped by exposure. That is the counterintuitive term
 * and it is the correct one: people who share an office all day do not text
 * each other, because everything they have to say they have already said.
 * The messages go to the people you *cannot* see. A model that multiplied the
 * two together would produce a city whose phone traffic is a copy of its
 * co-location data, which would make every correlation task in the benchmark
 * trivial and wrong.
 *
 * Kin get a floor under all of this. You ring your mother whether or not the
 * affinity draw was generous, and a graph where a quarter of adults never
 * contact a parent because a number came out low is not a description of
 * anywhere.
 *
 * Anti-ties are kept and set near zero rather than dropped. `ties.py` writes a
 * negative valence for an estrangement, and the difference between "these two
 * have no relationship" and "these two have a relationship and do not speak"
 * is a fact about a person that the record should be able to express.
 */

import { join } from "node:path";
import { SIM_DATA_DIR } from "../../world/index.ts";

/** Kinds, in the order `ties.py` writes them. Read from the header, not assumed. */
export interface TieHeader {
  edges: number;
  kinds: string[];
  foci: string[];
  external_base: number;
  abroad_base: number;
  former_base: number;
  columns: { name: string; dtype: string }[];
}

/** One live contact of one person, from that person's side. */
export interface Contact {
  /** The other party. May be at or above `externalBase`: somebody off-map. */
  other: number;
  /** Tie kind index, into `TieHeader.kinds`. */
  kind: number;
  /** 0..1. */
  affinity: number;
  /** 0..1. How much of the week they are already in the same room. */
  exposure: number;
  /** Negative for an estrangement, which keeps the edge and kills the traffic. */
  valence: number;
  /** Expected contacts per week, which is what the day pass samples against. */
  rate: number;
  /**
   * Expected *meetings* per week: deliberate co-presence somewhere neither
   * party had to be anyway.
   *
   * Separate from `rate` and not derivable from it. Messaging is damped by
   * exposure because people who share an office have already said everything;
   * meeting up is damped by exposure for the same reason in one direction and
   * not at all in the other — you do not arrange to see the man on the next
   * pick line, but you do go out with the person you live with, and their
   * exposure is the highest in the file. `socialRate` is where that splits.
   */
  social: number;
}

// ---------------------------------------------------------------------------
// Turning a tie into a rate
// ---------------------------------------------------------------------------

/**
 * Contacts per week at full affinity and no shared exposure.
 *
 * Anchored on the top of the range rather than the middle because that is
 * where the evidence is: a person's closest correspondent is contacted most
 * days, and time-use surveys agree on that far better than they agree on what
 * the median tie does.
 *
 * A "contact" here is a whole exchange, not a message — the branching process
 * turns each one into three messages on average — so this is several separate
 * conversations a day with the person you are closest to, which is what a
 * partner or a teenager's best friend actually looks like. Calibrated against
 * the city's messages per person per day rather than set from the survey
 * directly; the first value tried was 11 and produced about a fifth of the
 * traffic a city this size sends.
 */
const PEAK_WEEKLY = 27;

/**
 * The exponent affinity is raised to before scaling.
 *
 * Above one, so the curve is convex and the mass of middling ties contributes
 * far less than the handful of close ones. A linear map puts a third of the
 * city's traffic in ties nobody would describe as a friendship, and the
 * resulting contact list is flat — everyone talking a little to everyone,
 * which is the single most recognisable failure mode of a synthetic social
 * dataset.
 */
const AFFINITY_SHAPE = 2.0;

/**
 * How much being together already suppresses messaging.
 *
 * At full exposure — a spouse, a workmate on the same line every day — the
 * rate falls to a third. Not to zero: people who live together still text,
 * and the logistical traffic between them ("on my way", "we're out of milk")
 * is real and is exactly what the `logistical` purpose exists for. What
 * collapses is the conversational share.
 */
const EXPOSURE_DAMPING = 0.66;

/** Weekly floor for a parent, child or partner, whatever the affinity says. */
const KIN_FLOOR = 1.6;

/**
 * What an estrangement leaves. Not zero — a negative tie still produces the
 * occasional contact, and a burst of them after years of silence is one of
 * the more interesting things this data can contain.
 */
const ESTRANGED = 0.02;

/** Below this weekly rate the contact is not worth carrying into the day pass. */
const LIVE_FLOOR = 0.04;

/**
 * Meetings per week for the closest possible tie.
 *
 * An order of magnitude below `PEAK_WEEKLY` and it should be: seeing somebody
 * costs an evening, and messaging them costs nothing. Anchored on ATUS, which
 * puts socialising away from home plus eating and drinking away from home at
 * a little under an hour a day averaged over everybody — which at the ninety
 * minutes a real occasion lasts is a few occasions a week spread across all of
 * a person's ties, not per tie. The peak is what a partner or a best friend
 * gets, and the affinity curve does the rest.
 *
 * Fitted rather than asserted. Summed over a person's non-co-resident ties
 * this produces a mean of 2.9 meetings a week, a median of 2.0 and a long
 * right tail, which is the shape a time-use survey describes and roughly its
 * level. Co-residents are excluded from that sum because a household outing
 * is drawn from the household and not from the pair — see `meetings.ts`.
 */
const SOCIAL_PEAK = 1.2;

/**
 * The exponent affinity is raised to for meetings.
 *
 * Slightly above `AFFINITY_SHAPE`, and it has to be. A person carries some
 * forty live ties, so a curve flat enough to give the middle of that list a
 * meeting now and again gives everybody nine outings a week. Concentrating it
 * puts the evenings where the friendships are: the closest non-co-resident tie
 * is seen about every other week at the median and weekly in the tail.
 */
const SOCIAL_SHAPE = 2.2;

/**
 * How much of a meeting rate survives full exposure, for the ties where
 * exposure means "we are already in the same building anyway".
 *
 * Sharper than the messaging damping. Colleagues who share a shift do still
 * message each other about the shift, but they emphatically do not arrange to
 * meet in a café on a Tuesday morning — they have just spent eight hours
 * together. This only applies to the kinds in `CROWDED`; see `socialRate`.
 */
const SOCIAL_EXPOSURE_DAMPING = 0.8;

/**
 * How much of a meeting a tie of each kind is worth, at equal affinity.
 *
 * The spread is what stops the layer producing a city where everyone meets
 * everyone equally. A former colleague and a sibling can carry the same
 * affinity and mean entirely different things about a Saturday.
 *
 * Names are `ties.py`'s, resolved through the header rather than assumed by
 * position — the same discipline `kinKinds` uses.
 */
const KIND_WEIGHT: Record<string, number> = {
  partner: 1.0, household: 0.9,
  parent: 0.55, child: 0.55, sibling: 0.45, coparent: 0.35,
  grandparent: 0.3, kin_ext: 0.25,
  clubmate: 0.5, elsewhere: 0.45, classmate: 0.35, neighbour: 0.3, congregant: 0.25,
  colleague: 0.25, ex_colleague: 0.15, ex_partner: 0.08,
  // Somebody off-map cannot be met in a venue in this city. The tie is real
  // and produces phone traffic; it produces no trip.
  abroad: 0,
};

/** The default for a kind the table above has not been taught. */
const KIND_DEFAULT = 0.2;

/**
 * The kinds whose exposure means "we are thrown together", rather than "we
 * choose to be together".
 *
 * A colleague's exposure is a rota. A partner's is a marriage, and damping a
 * meeting rate by it would produce couples who never go out precisely because
 * they live together, which is the wrong sign on the whole effect.
 */
const CROWDED = new Set(["colleague", "ex_colleague", "classmate", "congregant", "clubmate", "neighbour"]);

/** Below this, the pair are not carried as people who might meet. */
const SOCIAL_FLOOR = 0.02;

export class Graph {
  private readonly index: Int32Array;
  private readonly offsets: Int32Array;
  readonly contacts: Contact[];
  readonly header: TieHeader;

  private constructor(header: TieHeader, byPerson: Map<number, Contact[]>, people: number) {
    this.header = header;
    this.offsets = new Int32Array(people + 2);
    let total = 0;
    for (const list of byPerson.values()) total += list.length;
    this.contacts = new Array(total);
    this.index = new Int32Array(0);

    // Flattened into one array with an offset table rather than a Map of
    // arrays. Ninety thousand small arrays is ninety thousand allocations the
    // GC walks on every day of a year-long run; one array and an index is not.
    let cursor = 0;
    for (let person = 0; person <= people; person += 1) {
      this.offsets[person] = cursor;
      const list = byPerson.get(person);
      if (list) {
        for (const contact of list) this.contacts[cursor++] = contact;
      }
    }
    this.offsets[people + 1] = cursor;
  }

  static async open(): Promise<Graph> {
    const file = Bun.file(join(SIM_DATA_DIR, "ties.bin"));
    const blob = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (String.fromCharCode(...blob.subarray(0, 4)) !== "KTIE") {
      throw new Error("ties.bin is not a KTIE file");
    }
    const length = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + length))) as TieHeader;
    let offset = 8 + length;
    offset += (-offset % 8 + 8) % 8;

    const count = header.edges;
    const columns = new Map<string, ArrayBufferView>();
    for (const column of header.columns) {
      const width = Number(column.dtype.slice(-1));
      const bytes = blob.buffer.slice(blob.byteOffset + offset, blob.byteOffset + offset + width * count);
      columns.set(column.name, viewFor(column.dtype, bytes));
      offset += width * count;
    }

    const a = columns.get("a") as Int32Array;
    const b = columns.get("b") as Int32Array;
    const kind = columns.get("kind") as Uint8Array;
    const exposure = columns.get("exposure") as Uint8Array;
    const affinity = columns.get("affinity") as Uint8Array;
    const valence = columns.get("valence") as Int8Array;

    const kinKinds = new Set(
      ["parent", "child", "partner"].map((name) => header.kinds.indexOf(name)).filter((i) => i >= 0),
    );
    // Kind weight and crowdedness by kind *number*, resolved once. The inner
    // loop runs three and a quarter million times and must not be doing string
    // lookups inside it.
    const weightByKind = header.kinds.map((name) => KIND_WEIGHT[name] ?? KIND_DEFAULT);
    const crowdedByKind = header.kinds.map((name) => CROWDED.has(name));

    const byPerson = new Map<number, Contact[]>();
    let people = 0;
    for (let edge = 0; edge < count; edge += 1) {
      const rate = weeklyRate(affinity[edge]! / 255, exposure[edge]! / 255, valence[edge]!, kinKinds.has(kind[edge]!));
      const social = socialRate(
        affinity[edge]! / 255, exposure[edge]! / 255, valence[edge]!,
        weightByKind[kind[edge]!] ?? KIND_DEFAULT, crowdedByKind[kind[edge]!] ?? false,
      );
      // Either rate keeps the edge. The two select nearly disjoint sets at the
      // margin — a workmate is dropped by one and kept by the other — and a
      // filter that used only the messaging rate would hand the meetings layer
      // a graph with the colleagues already deleted from it.
      if (rate < LIVE_FLOOR && social < SOCIAL_FLOOR) continue;
      const from = a[edge]!;
      const to = b[edge]!;
      // Both directions. A tie is symmetric in the file and asymmetric in use:
      // each party has to be able to find the other in their own contact list,
      // and who initiates is decided per pair in the exchange layer rather
      // than by which way round `ties.py` happened to write the row.
      push(byPerson, from, { other: to, kind: kind[edge]!, affinity: affinity[edge]! / 255, exposure: exposure[edge]! / 255, valence: valence[edge]!, rate, social });
      if (to < header.external_base) {
        push(byPerson, to, { other: from, kind: kind[edge]!, affinity: affinity[edge]! / 255, exposure: exposure[edge]! / 255, valence: valence[edge]!, rate, social });
        people = Math.max(people, to);
      }
      people = Math.max(people, from < header.external_base ? from : people);
    }

    return new Graph(header, byPerson, people);
  }

  /** Everybody this person would message, in file order. */
  forPerson(person: number): readonly Contact[] {
    if (person < 0 || person + 1 >= this.offsets.length) return [];
    return this.contacts.slice(this.offsets[person]!, this.offsets[person + 1]!);
  }

  /** The same, without the copy, for the hot path. */
  range(person: number): [start: number, end: number] {
    if (person < 0 || person + 1 >= this.offsets.length) return [0, 0];
    return [this.offsets[person]!, this.offsets[person + 1]!];
  }

  get size(): number {
    return this.contacts.length;
  }

  /** Whether an id names somebody outside the population. */
  external(person: number): boolean {
    return person >= this.header.external_base;
  }
}

function push(map: Map<number, Contact[]>, person: number, contact: Contact): void {
  const list = map.get(person);
  if (list) list.push(contact);
  else map.set(person, [contact]);
}

function weeklyRate(affinity: number, exposure: number, valence: number, kin: boolean): number {
  if (valence < 0) return ESTRANGED;
  const base = PEAK_WEEKLY * Math.pow(affinity, AFFINITY_SHAPE);
  const damped = base * (1 - EXPOSURE_DAMPING * exposure);
  return kin ? Math.max(damped, KIN_FLOOR) : damped;
}

/**
 * Meetings per week, from the same four numbers the messaging rate uses.
 *
 * The shape is deliberately parallel to `weeklyRate` so the two can be read
 * against each other, and differs in exactly the two places the phenomena
 * differ: the kind of tie matters here and does not there, and exposure damps
 * only the ties where being together is something that happens *to* the pair.
 *
 * An estrangement produces no meetings at all rather than a trickle. That is
 * the one place this is stricter than messaging: the occasional call after
 * years of silence is a real and interesting event, and turning up at
 * somebody's local is not the same kind of accident.
 */
function socialRate(
  affinity: number,
  exposure: number,
  valence: number,
  weight: number,
  crowded: boolean,
): number {
  if (valence < 0) return 0;
  const base = SOCIAL_PEAK * weight * Math.pow(affinity, SOCIAL_SHAPE);
  return crowded ? base * (1 - SOCIAL_EXPOSURE_DAMPING * exposure) : base;
}

function viewFor(dtype: string, bytes: ArrayBuffer): ArrayBufferView {
  // NumPy dtype strings: '<i4', '|u1', '|i1', '<u2'.
  const kind = dtype[1];
  const width = Number(dtype.slice(-1));
  if (kind === "i" && width === 4) return new Int32Array(bytes);
  if (kind === "u" && width === 4) return new Uint32Array(bytes);
  if (kind === "u" && width === 2) return new Uint16Array(bytes);
  if (kind === "i" && width === 1) return new Int8Array(bytes);
  if (kind === "u" && width === 1) return new Uint8Array(bytes);
  throw new Error(`ties.bin has a column of unsupported dtype ${dtype}`);
}

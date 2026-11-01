/**
 * Who is on the network, and on whose network they actually are.
 *
 * `init/personal_records/devices.py` wrote two tables for one reason this
 * layer depends on completely: a handset and a subscription are different
 * objects with different identifiers, and the radio cares about both. The
 * handset decides which cells the person *can* hear — a 2017 phone has no NR
 * radio and will never appear on n77 no matter how strong it is. The
 * subscription decides which cells they are *allowed* to hear.
 *
 * The MVNO join is the part worth stating plainly, because it is the one thing
 * here that would be wrong in an obvious way if it were skipped. A third of
 * this city's subscriptions are on a brand that owns no spectrum: Spectrum
 * Mobile, Xfinity Mobile, Mint, Cricket. Their traffic is carried on a host
 * network's cells and appears in that host's radio logs. So the cell a
 * Spectrum Mobile customer attaches to is a Verizon cell, broadcasting
 * 310/004, and nothing in the radio layer knows or cares that the bill goes to
 * a cable company. `host_network` is the field that carries this and `carrier`
 * is the one that must *not* be used for it.
 *
 * Identifiers are carried through untouched so a record can name the thing it
 * is about the way a real one would: IMSI for the subscriber, IMEI for the
 * equipment, MSISDN for the human. A radio log names the first two and not the
 * third, which is a distinction the records layer is entitled to make and
 * cannot make if this layer flattens them into one id.
 */

import { join } from "node:path";
import { SIM_DATA_DIR } from "../world/index.ts";
import { HOST_NETWORKS, OPERATORS, ROAMS_ONTO, radioTier, type OperatorKey } from "./cells.ts";

/** One SIM in one handset, which is what the network sees as one subscriber. */
export interface Subscriber {
  person: number;
  /** Index into this table, and the id every span and event is keyed on. */
  index: number;
  imsi: string;
  imei: string;
  msisdn: string;
  /** The brand on the bill, which may own no spectrum at all. */
  carrier: string;
  /** The network whose cells actually carry it. Index into `OPERATORS`. */
  operator: number;
  operatorKey: OperatorKey;
  /**
   * The network it falls back to where its own does not reach, or -1.
   *
   * Only Boost has one, and it is not a nicety: Boost's build here is NR on
   * three bands from thirty-nine sites and no LTE at all, which is a correct
   * description of a greenfield 5G operator and means an LTE-only handset on a
   * Boost SIM can hear nothing whatsoever. In the real network that phone is
   * on AT&T all day under a roaming agreement, and so is every Boost customer
   * standing outside the thin footprint. Without this the layer would hand a
   * couple of thousand people a day with no cellular life and no reason.
   */
  roaming: number;
  mvno: boolean;
  prepaid: boolean;
  /** What the handset's radio can reach: LTE_ONLY, SUB6 or CBAND. */
  tier: number;
  make: string;
  model: string;
  platform: string;
}

interface HandsetRow {
  user: number;
  primary: boolean;
  imei: string;
  make: string;
  model: string;
  model_released: number;
  tier: string;
  platform: string;
}

interface SubscriptionRow {
  user: number;
  primary: boolean;
  msisdn: string;
  imsi: string;
  carrier: string;
  host_network: string;
  mvno: boolean;
  plan_type: string;
  handset: string;
}

export class Subscribers {
  readonly all: readonly Subscriber[];
  /** Every subscriber belonging to one person, which is usually one. */
  private readonly byPerson = new Map<number, Subscriber[]>();

  private constructor(all: Subscriber[], private readonly incarcerated: ReadonlySet<number>) {
    this.all = all;
    for (const subscriber of all) {
      const mine = this.byPerson.get(subscriber.person);
      if (mine) mine.push(subscriber);
      else this.byPerson.set(subscriber.person, [subscriber]);
    }
  }

  static async open(): Promise<Subscribers> {
    // Old builds may still contain phones issued before custody was applied.
    // The current population, rather than those stale device rows, decides
    // who can own an active endpoint.
    const population = await Bun.file(join(SIM_DATA_DIR, "population.json")).json() as {
      person_records: { id: number; incarcerated?: boolean }[];
      quarters_records: { id: number; incarcerated?: boolean }[];
    };
    const incarcerated = new Set([...population.person_records, ...population.quarters_records]
      .filter((person) => person.incarcerated).map((person) => person.id));
    const file = (await Bun.file(join(SIM_DATA_DIR, "devices.json")).json()) as {
      devices: Record<string, HandsetRow[]>;
      subscriptions: Record<string, SubscriptionRow[]>;
    };

    const handsets = new Map<string, HandsetRow>();
    for (const rows of Object.values(file.devices)) {
      for (const row of rows) handsets.set(row.imei, row);
    }

    const all: Subscriber[] = [];
    // Sorted by person so the table's order is the population's order and two
    // runs of the same city produce the same subscriber indices. Object key
    // order in a parsed JSON file is not something to depend on for an id that
    // ends up packed into a binary.
    const people = Object.keys(file.subscriptions)
      .map(Number)
      .sort((a, b) => a - b);
    for (const person of people) {
      if (incarcerated.has(person)) continue;
      for (const row of file.subscriptions[String(person)]!) {
        if (incarcerated.has(row.user)) continue;
        const handset = handsets.get(row.handset);
        // A subscription whose handset is missing is a data fault, not a
        // silent phone: skipping it quietly would show up downstream as a
        // person with no cellular life and no explanation.
        if (!handset) {
          throw new Error(`subscription ${row.imsi} names handset ${row.handset}, which devices.json does not have`);
        }
        const operatorKey = HOST_NETWORKS[row.host_network];
        if (!operatorKey) {
          throw new Error(`subscription ${row.imsi} is hosted on ${row.host_network}, which towers.json has no spectrum for`);
        }
        all.push({
          person: row.user,
          index: all.length,
          imsi: row.imsi,
          imei: row.handset,
          msisdn: row.msisdn,
          carrier: row.carrier,
          operator: OPERATORS.indexOf(operatorKey),
          operatorKey,
          roaming: ROAMS_ONTO[operatorKey] === undefined
            ? -1
            : OPERATORS.indexOf(ROAMS_ONTO[operatorKey]!),
          mvno: row.mvno,
          prepaid: row.plan_type === "prepaid",
          tier: radioTier(handset.model_released, handset.tier),
          make: handset.make,
          model: handset.model,
          platform: handset.platform,
        });
      }
    }
    return new Subscribers(all, incarcerated);
  }

  isIncarcerated(person: number): boolean {
    return this.incarcerated.has(person);
  }

  forPerson(person: number): readonly Subscriber[] {
    return this.byPerson.get(person) ?? [];
  }

  get size(): number {
    return this.all.length;
  }
}

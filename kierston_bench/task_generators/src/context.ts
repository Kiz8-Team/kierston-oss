/**
 * What every generator works from: one open KDAY day, the static truth
 * registers, and the derived views several families share.
 *
 * The derived views are memoized on the context rather than rebuilt per
 * generator because a benchmark run generates many tasks against the same
 * day, and an index over three hundred thousand legs is worth building once.
 */

import { KdayReader, NONE, type NumericColumn } from "./kday.ts";
import { World } from "./world.ts";
import { degrees } from "./format.ts";

export interface PersonTable {
  id: Uint32Array;
  scheduleOffset: NumericColumn;
  scheduleCount: NumericColumn;
  legOffset: NumericColumn;
  legCount: NumericColumn;
  txOffset: NumericColumn;
  txCount: NumericColumn;
  /** Person id -> row in this table. */
  rowOf: Map<number, number>;
}

/** One stretch of a person's day spent in one place, derived from the legs. */
export interface Stay {
  /** Minutes; the first stay starts at 0 and the last ends at the day's end. */
  startMinute: number;
  endMinute: number;
  lat: number;
  lon: number;
  /** The arriving leg's destination label ("home", a venue, a site). */
  label: string | null;
  /** The arriving leg's purpose, naming why the person is here. */
  purpose: string | null;
}

export interface PositionAt {
  lat: number;
  lon: number;
  /** "stay" when parked somewhere, "leg" when mid-movement. */
  during: "stay" | "leg";
  label: string | null;
}

const END_OF_DAY = 1920; // Generously past midnight; sim days are not bounded to 24h.

export class TaskContext {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(readonly day: KdayReader, readonly world: World) {}

  get date(): string {
    return this.day.meta.date;
  }

  private derive<T>(key: string, make: () => Promise<T>): Promise<T> {
    const cached = this.memo.get(key);
    if (cached) return cached as Promise<T>;
    const made = make();
    this.memo.set(key, made);
    return made;
  }

  persons(): Promise<PersonTable> {
    return this.derive("persons", async () => {
      const cols = await this.day.columns(
        "person.id", "person.scheduleOffset", "person.scheduleCount",
        "person.legOffset", "person.legCount", "person.txOffset", "person.txCount",
      );
      const id = cols.id as Uint32Array;
      const rowOf = new Map<number, number>();
      for (let row = 0; row < id.length; row += 1) rowOf.set(id[row]!, row);
      return {
        id,
        scheduleOffset: cols.scheduleOffset, scheduleCount: cols.scheduleCount,
        legOffset: cols.legOffset, legCount: cols.legCount,
        txOffset: cols.txOffset, txCount: cols.txCount,
        rowOf,
      } satisfies PersonTable;
    });
  }

  /** The person's stays, reconstructed from the leg table. */
  async staysOf(personRow: number): Promise<Stay[]> {
    const persons = await this.persons();
    const legs = await this.day.columns(
      "leg.depart", "leg.arrive", "leg.purpose",
      "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
      "leg.fromLabel", "leg.toLabel",
    );
    const purposes = this.day.enumValues("purpose");
    const from = persons.legOffset[personRow]!;
    const count = persons.legCount[personRow]!;
    const stays: Stay[] = [];
    if (count === 0) return stays;
    stays.push({
      startMinute: 0,
      endMinute: legs.depart[from]!,
      lat: degrees(legs.fromLatE6[from]!),
      lon: degrees(legs.fromLonE6[from]!),
      label: this.day.string(legs.fromLabel[from]!),
      purpose: null,
    });
    for (let leg = from; leg < from + count; leg += 1) {
      const next = leg + 1 < from + count ? legs.depart[leg + 1]! : END_OF_DAY;
      stays.push({
        startMinute: legs.arrive[leg]!,
        endMinute: next,
        lat: degrees(legs.toLatE6[leg]!),
        lon: degrees(legs.toLonE6[leg]!),
        label: this.day.string(legs.toLabel[leg]!),
        purpose: purposes[legs.purpose[leg]!] ?? null,
      });
    }
    return stays;
  }

  /** Where the person's body was at a given minute, from the routed truth. */
  async positionAt(personRow: number, minute: number): Promise<PositionAt> {
    const persons = await this.persons();
    const legs = await this.day.columns(
      "leg.depart", "leg.arrive",
      "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
      "leg.pathOffset", "leg.pathCount", "leg.toLabel", "leg.fromLabel",
    );
    const path = await this.day.columns("path.latE6", "path.lonE6");
    const from = persons.legOffset[personRow]!;
    const count = persons.legCount[personRow]!;
    for (let leg = from; leg < from + count; leg += 1) {
      if (minute < legs.depart[leg]!) {
        // Between the previous arrival and this departure: a stay.
        const previous = leg > from ? leg - 1 : null;
        return previous === null
          ? {
              lat: degrees(legs.fromLatE6[leg]!), lon: degrees(legs.fromLonE6[leg]!),
              during: "stay", label: this.day.string(legs.fromLabel[leg]!),
            }
          : {
              lat: degrees(legs.toLatE6[previous]!), lon: degrees(legs.toLonE6[previous]!),
              during: "stay", label: this.day.string(legs.toLabel[previous]!),
            };
      }
      if (minute <= legs.arrive[leg]!) {
        // Mid-leg: interpolate along the routed path by time fraction.
        const span = legs.arrive[leg]! - legs.depart[leg]!;
        const fraction = span <= 0 ? 1 : (minute - legs.depart[leg]!) / span;
        const points = legs.pathCount[leg]!;
        if (points >= 2) {
          const at = legs.pathOffset[leg]! + Math.min(points - 1, Math.floor(fraction * (points - 1)));
          return {
            lat: degrees(path.latE6[at]!), lon: degrees(path.lonE6[at]!),
            during: "leg", label: null,
          };
        }
        const lat = degrees(legs.fromLatE6[leg]!)
          + fraction * (degrees(legs.toLatE6[leg]!) - degrees(legs.fromLatE6[leg]!));
        const lon = degrees(legs.fromLonE6[leg]!)
          + fraction * (degrees(legs.toLonE6[leg]!) - degrees(legs.fromLonE6[leg]!));
        return { lat, lon, during: "leg", label: null };
      }
    }
    // After the last leg, or a day with no legs at all: the final known place.
    if (count > 0) {
      const last = from + count - 1;
      return {
        lat: degrees(legs.toLatE6[last]!), lon: degrees(legs.toLonE6[last]!),
        during: "stay", label: this.day.string(legs.toLabel[last]!),
      };
    }
    throw new Error("positionAt on a person with no legs");
  }

  /** Journey id (interned string) -> the legs that carried it, across people. */
  journeys(): Promise<Map<number, { personRow: number; leg: number }[]>> {
    return this.derive("journeys", async () => {
      const persons = await this.persons();
      const journey = await this.day.column("leg.journey");
      const map = new Map<number, { personRow: number; leg: number }[]>();
      for (let row = 0; row < persons.id.length; row += 1) {
        const from = persons.legOffset[row]!;
        for (let leg = from; leg < from + persons.legCount[row]!; leg += 1) {
          const id = journey[leg]!;
          if (id === NONE) continue;
          const list = map.get(id);
          if (list) list.push({ personRow: row, leg });
          else map.set(id, [{ personRow: row, leg }]);
        }
      }
      return map;
    });
  }

  /** Vehicle string id (a VIN) -> the resident legs it carried, across people. */
  vehicleLegs(): Promise<Map<number, { personRow: number; leg: number }[]>> {
    return this.derive("vehicleLegs", async () => {
      const persons = await this.persons();
      const vehicle = await this.day.column("leg.vehicle");
      const map = new Map<number, { personRow: number; leg: number }[]>();
      for (let row = 0; row < persons.id.length; row += 1) {
        const from = persons.legOffset[row]!;
        for (let leg = from; leg < from + persons.legCount[row]!; leg += 1) {
          const id = vehicle[leg]!;
          if (id === NONE) continue;
          const list = map.get(id);
          if (list) list.push({ personRow: row, leg });
          else map.set(id, [{ personRow: row, leg }]);
        }
      }
      return map;
    });
  }

  /** Events on the carrier network per subscriber row, for eligibility checks. */
  eventCountBySubscriber(): Promise<Map<number, number>> {
    return this.derive("eventCounts", async () => {
      const subscriber = await this.day.column("event.subscriber");
      const counts = new Map<number, number>();
      for (let i = 0; i < subscriber.length; i += 1) {
        counts.set(subscriber[i]!, (counts.get(subscriber[i]!) ?? 0) + 1);
      }
      return counts;
    });
  }

  /** Messages sent per account row, for eligibility checks. */
  messageCountByAccount(): Promise<Map<number, number>> {
    return this.derive("messageCounts", async () => {
      const from = await this.day.column("message.from");
      const counts = new Map<number, number>();
      for (let i = 0; i < from.length; i += 1) {
        counts.set(from[i]!, (counts.get(from[i]!) ?? 0) + 1);
      }
      return counts;
    });
  }
}

export interface OpenOptions {
  dayFile: string;
  /** A scenario `.kdiff` to read over `dayFile`, in memory. */
  deltaFile?: string;
  simDataDir: string;
}

export async function openContext(options: OpenOptions): Promise<TaskContext> {
  const reader = await KdayReader.open(options.dayFile, { delta: options.deltaFile });
  return new TaskContext(reader, new World(options.simDataDir));
}

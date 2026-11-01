/**
 * Shards of a packed day, made into one.
 *
 * A shard is what one pass over a slice of the population produced: its own
 * columns, numbered from zero, and its own string table. Making a file out of
 * several means three things, and this is all three:
 *
 *   offsets     a person's rows start where the previous shard's ended, so
 *               every column holding an index into another table is shifted by
 *               that table's running total.
 *
 *   strings     each shard interned into its own table, so its ids mean
 *               nothing here. They are remapped — and remapped by *walking the
 *               rows in the order a serial run would have written them*, which
 *               is what makes a file packed by three workers byte-identical to
 *               one packed by none. The table comes out in the order the
 *               people were packed, not the order the workers finished.
 *
 *   the rest    what is not a column: the money spent, the gatherings that
 *               held, and each person's reading of their own day.
 *
 * A serial run goes through here too, as a single shard. Its remap is the
 * identity — a lone shard interned in exactly the order this walks — so the
 * one path is the tested path, and there is no second implementation to keep
 * honest.
 */

import type { Meeting } from "../activities/social/index.ts";
import type { Observation } from "../comms/index.ts";
import {
  ARRAYS, NONE, PERSON_COLUMNS, STRING_ORDER, Strings,
  type DayColumns, type Field, type NumberArray, type Table,
} from "./pack.ts";

/** One pass over a slice of the population, as something that can cross a wire. */
export interface Shard {
  /** Where this slice sits in person order. Shards are merged by this. */
  index: number;
  columns: Record<Field, NumberArray>;
  strings: readonly string[];
  spent: number;
  /** One per person in this slice, in the same order as `columns.personId`. */
  observations: readonly Observation[];
  /** Who sat at which gathering, flattened. */
  attended: readonly { person: number; meeting: Meeting }[];
}

/** The columns of a shard, as typed arrays, ready to be sent or merged. */
export function typedColumns(columns: DayColumns): Record<Field, NumberArray> {
  const out = {} as Record<Field, NumberArray>;
  for (const spec of PERSON_COLUMNS) {
    out[spec.field] = new ARRAYS[spec.type](columns[spec.field]);
  }
  return out;
}

/** Every buffer in a shard, so `postMessage` can hand them over rather than copy. */
export function buffersOf(shard: Shard): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const spec of PERSON_COLUMNS) buffers.push(shard.columns[spec.field].buffer as ArrayBuffer);
  for (const observation of shard.observations) {
    if (!observation.attention.known) continue;
    buffers.push(observation.attention.minute.buffer as ArrayBuffer);
    buffers.push(observation.attention.asleep.buffer as ArrayBuffer);
  }
  return buffers;
}

export class Merger {
  readonly strings = new Strings();
  /** The gatherings, accumulated across everybody rather than written per person.
   *
   * A meeting belongs to two or more days at once and must appear in the file
   * once, so it is collected here as the shards arrive and emitted after the
   * last of them. What is collected is *attendance* and not intent: a party
   * row exists because the person's planned timeline really contains the stay,
   * so somebody the roads could not deliver is absent from the table rather
   * than present and mysteriously never there.
   */
  readonly gatherings = new Map<string, { meeting: Meeting; attendees: Set<number> }>();
  spent = 0;

  private readonly parts = new Map<Field, NumberArray[]>();
  private readonly rows: Record<Table, number> = {
    person: 0, schedule: 0, leg: 0, path: 0, tx: 0, span: 0, event: 0, attention: 0,
  };
  private next = 0;

  /**
   * Take one shard, in person order.
   *
   * The order is not a convenience. The string table, the actor registry the
   * observations feed and the gathering map are all insertion-ordered, so a
   * caller adding shards as they finish rather than as they are numbered would
   * produce a different file — valid, and not the one a serial run makes.
   */
  add(shard: Shard, onObservation: (observation: Observation) => void): void {
    if (shard.index !== this.next) {
      throw new Error(`shard ${shard.index} arrived where ${this.next} was due`);
    }
    this.next += 1;

    this.remapStrings(shard);
    for (const spec of PERSON_COLUMNS) {
      const values = shard.columns[spec.field];
      if (spec.rebase) {
        const base = this.rows[spec.rebase];
        if (base > 0) for (let i = 0; i < values.length; i += 1) values[i] += base;
      }
      const held = this.parts.get(spec.field);
      if (held) held.push(values);
      else this.parts.set(spec.field, [values]);
    }

    this.rows.person += shard.columns.personId.length;
    this.rows.schedule += shard.columns.scheduleStart.length;
    this.rows.leg += shard.columns.legDepart.length;
    this.rows.path += shard.columns.pathLat.length;
    this.rows.tx += shard.columns.txMinute.length;
    this.rows.span += shard.columns.spanSubscriber.length;
    this.rows.event += shard.columns.eventSubscriber.length;
    this.rows.attention += shard.columns.attentionStart.length;

    this.spent += shard.spent;
    for (const { person, meeting } of shard.attended) {
      const held = this.gatherings.get(meeting.id)
        ?? this.gatherings.set(meeting.id, { meeting, attendees: new Set() }).get(meeting.id)!;
      held.attendees.add(person);
    }
    for (const observation of shard.observations) onObservation(observation);
  }

  /** One column, whole. The shards' pieces are not needed afterwards. */
  take(field: Field): NumberArray {
    const pieces = this.parts.get(field) ?? [];
    if (pieces.length === 1) return pieces[0]!;
    const spec = PERSON_COLUMNS.find((item) => item.field === field)!;
    let length = 0;
    for (const piece of pieces) length += piece.length;
    const whole = new ARRAYS[spec.type](length);
    let at = 0;
    for (const piece of pieces) {
      whole.set(piece as never, at);
      at += piece.length;
    }
    this.parts.set(field, [whole]);
    return whole;
  }

  get counts(): Readonly<Record<Table, number>> {
    return this.rows;
  }

  /**
   * Renumber one shard's string ids into the run's own table.
   *
   * The walk mirrors the packing exactly — every entry's label and place, then
   * every leg's two ends, then every transaction's five, person by person —
   * because the table being built is defined by the order it is filled in.
   * Anything cheaper here (remapping column by column, say) would give a
   * correct file with a permuted string table, which is a file that cannot be
   * compared against a serial one byte for byte.
   */
  private remapStrings(shard: Shard): void {
    const local = shard.strings;
    // -1 is "not seen yet", which no id can be; NONE is passed through
    // untouched because it is an absence and not a reference.
    const seen = new Int32Array(local.length).fill(-1);
    const id = (value: number): number => {
      if (value === NONE) return NONE;
      const known = seen[value]!;
      if (known >= 0) return known;
      const mine = this.strings.id(local[value]!);
      seen[value] = mine;
      return mine;
    };

    const cursor: Partial<Record<Table, number>> = { schedule: 0, leg: 0, tx: 0 };
    const counts: Record<string, NumberArray> = {
      schedule: shard.columns.personScheduleCount,
      leg: shard.columns.personLegCount,
      tx: shard.columns.personTxCount,
    };
    const people = shard.columns.personId.length;
    for (let person = 0; person < people; person += 1) {
      for (const { table, fields } of STRING_ORDER) {
        const rows = counts[table]![person]!;
        let at = cursor[table]!;
        for (let row = 0; row < rows; row += 1, at += 1) {
          for (const field of fields) {
            const column = shard.columns[field];
            column[at] = id(column[at]!);
          }
        }
        cursor[table] = at;
      }
    }
  }
}

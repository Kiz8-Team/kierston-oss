/**
 * What a gathering does to the phone traffic around it.
 *
 * Four effects, and the order below is the order they happen in a day:
 *
 *   1. arranging it        days ahead, between the convener and the guests
 *   2. the run-up          "on my way", in the hour before
 *   3. the silence         the people at the table stop texting each other
 *   4. afterwards          the photos, the thanks, the backlog
 *
 * Only the third of those is a correction; the rest are traffic that did not
 * exist. Before this file, two friends having dinner messaged each other at
 * exactly the ordinary rate for their tie on the day they met, which made the
 * co-presence in this simulation independent of the communications in it —
 * and a benchmark whose two most joinable signals are independent is a
 * benchmark that cannot be used to test joining them.
 *
 * Why this can read everybody's day and `meetings.ts` cannot
 * ----------------------------------------------------------
 * The whole discipline of `activities/` is that a person's day is planned in
 * isolation, which is why `meetings.ts` goes to such lengths to have every
 * party derive the same evening without consulting the others. None of that
 * applies here. The communications layer already runs in a second pass over a
 * city whose days are *all* planned — it has to, because a reply is a property
 * of the recipient's day — so this file may simply look at who actually turned
 * up. See `comms/index.ts`.
 *
 * That is worth stating plainly because it changes what is knowable. The
 * planner rejects a gathering it cannot route somebody to, so the party a
 * meeting *claims* and the party that *held* it are different sets, and only
 * this side of the wall can see the difference. That is where the calls to
 * somebody who never arrived come from.
 *
 * What is derived rather than observed
 * ------------------------------------
 * One exception, and it is unavoidable. Arranging something for Thursday
 * happens on Monday, and Thursday has not been planned — there is no timeline
 * to observe. So the arrangement is derived from `invitationFor`, the cheap
 * half of the convener's draw, which needs nothing but the tie graph and the
 * date. It follows that an arrangement can exist for a gathering that never
 * happens: the venue turned out to be shut, or the convener drew a shift. That
 * is a feature. People arrange things that fall through, and an invitation
 * with no meeting after it is one of the more useful shapes in the file.
 */

import type { Day, SchedulerPayload } from "../scheduler/index.ts";
import type { Meeting } from "../activities/social/index.ts";

/** A gathering as it actually happened, rather than as it was arranged. */
export interface Held {
  meeting: Meeting;
  /** Sorted person ids whose planned timeline really holds the stay. */
  attendees: number[];
  /** Parties whose day the planner could not deliver. Usually empty. */
  absent: number[];
}

/** One window in which a person was somewhere with somebody, deliberately. */
interface Window {
  start: number;
  end: number;
  /** The others at the table, so co-presence is a set test and not a scan. */
  with: Set<number>;
}

/**
 * Everything the communications layer needs to know about the day's shared
 * activities, accumulated as the exporter streams people past.
 *
 * Populated from planned timelines rather than from `meetingsFor`, so a
 * gathering somebody was drawn into but could not reach is correctly absent
 * from their windows and correctly present in `absent`.
 */
export class Gatherings {
  private readonly byId = new Map<string, { meeting: Meeting; attendees: Set<number> }>();
  private readonly byPerson = new Map<number, Window[]>();

  /** Record the gatherings this person's planned day actually contains. */
  observe(planned: Day, person: number): void {
    for (const meeting of heldIn(planned)) this.record(meeting, person);
  }

  /**
   * The same, from the reading rather than from the day.
   *
   * Split out because a day and the person who lived it need not be in the
   * same process: an export that plans its people in parallel workers has the
   * meeting and the attendee in hand and no timeline to scan. Both paths end
   * here, so neither can drift from the other.
   */
  record(meeting: Meeting, person: number): void {
    const held = this.byId.get(meeting.id)
      ?? this.byId.set(meeting.id, { meeting, attendees: new Set() }).get(meeting.id)!;
    held.attendees.add(person);
  }

  /**
   * Close the day: turn the attendance sets into the per-person windows the
   * exchange layer tests against.
   *
   * Separate from `observe` because a window has to name everybody else at the
   * table, and the last party is not known until the last person has been
   * streamed. Called once, by `resolve`.
   */
  seal(): void {
    this.byPerson.clear();
    for (const held of this.byId.values()) {
      const party = [...held.attendees];
      if (party.length < 2) continue;
      for (const person of party) {
        const others = new Set(party.filter((other) => other !== person));
        const list = this.byPerson.get(person) ?? this.byPerson.set(person, []).get(person)!;
        list.push({ start: held.meeting.start, end: held.meeting.end, with: others });
      }
    }
  }

  /**
   * Were these two sitting opposite each other at this minute?
   *
   * The hot path — asked of every message this layer places and every reply it
   * considers — so it is a walk of one person's windows, of which nobody has
   * more than a handful, and a set membership test.
   */
  together(a: number, b: number, minute: number): boolean {
    const windows = this.byPerson.get(a);
    if (!windows) return false;
    for (const window of windows) {
      if (minute < window.start || minute >= window.end) continue;
      if (window.with.has(b)) return true;
    }
    return false;
  }

  /** Every gathering at least two people reached today, in id order. */
  all(): Held[] {
    const out: Held[] = [];
    for (const [, held] of [...this.byId].sort((a, b) => a[0].localeCompare(b[0]))) {
      const attendees = [...held.attendees].sort((a, b) => a - b);
      if (attendees.length < 2) continue;
      const there = new Set(attendees);
      out.push({
        meeting: held.meeting,
        attendees,
        absent: held.meeting.parties.filter((party) => !there.has(party)),
      });
    }
    return out;
  }

  reset(): void {
    this.byId.clear();
    this.byPerson.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * The gatherings one planned day actually contains.
 *
 * Three intents can carry a meet payload — the stay, and a driver's two
 * kerbside stops. Only the stay is the gathering; a pickup is a doorstep and
 * nobody is sitting opposite anybody at one.
 */
export function heldIn(planned: Day): Meeting[] {
  const held: Meeting[] = [];
  for (const event of planned.scheduled.timeline) {
    if (event.kind === "travel") continue;
    const payload = event.payload as SchedulerPayload | null;
    if (!payload || payload.kind !== "meet") continue;
    if (payload.where === null) continue;
    held.push(payload.meeting);
  }
  return held;
}

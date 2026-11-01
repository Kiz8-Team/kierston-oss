/**
 * The day's deliberate gatherings, read out of the KDAY meeting tables.
 *
 * Everything else this app draws from a day file is keyed on one person: their
 * legs, their ledger, their handset. A gathering is the first object in the
 * file that is keyed on *several*, and that changes what a reader has to be
 * able to do — the question is no longer "where was she at seven" but "who
 * else was in that room, and where had each of them come from".
 *
 * So the index below is built once per file and holds every meeting with its
 * party attached, and the detail reader resolves the party into movement. The
 * party is small — the median gathering here is two or three people and the
 * largest a dozen — which is why the detail can afford to read whole days for
 * everybody at the table.
 *
 * What is in the file and what is not
 * -----------------------------------
 * `party` is *attendance*, not the guest list. The exporter writes the people
 * whose planned timeline really holds the stay, so somebody the convener drew
 * in but the planner could not route is simply absent, and the file keeps no
 * record of them. That is why nothing here reports who was stood up: the count
 * of gatherings that lost somebody is in the sim's own export summary, and
 * this side of the wall cannot see it.
 */

import { stat } from "node:fs/promises";
import {
  dayPath, openDay, personRow, value,
  type Reader,
} from "./kday";
import { readMovement, type DayMovementLeg, type DayScheduleEntry } from "./day";

/** One person at one gathering. */
export interface MeetingParty {
  person: number;
  /** attendee, driver or rider — see the exporter for why this is recorded. */
  role: string;
}

/** A gathering as the file holds it, without anybody's day attached. */
export interface MeetingRow {
  /** Row in the file's meeting table. The detail route's key. */
  index: number;
  /** The sim's own id, `meet/<host>/<day>` or `outing/<household>/<day>`. */
  key: string;
  kind: string;
  purpose: string;
  venue: string | null;
  lat: number;
  lon: number;
  start: number;
  end: number;
  /** Who picked up the bill, where somebody did. */
  payer: number | null;
  /** Whose draw this gathering came out of, for the hosted kind. */
  host: number | null;
  party: MeetingParty[];
}

export interface MeetingIndex {
  date: string;
  meetings: MeetingRow[];
}

/** A gathering with everybody's movement, which is what the viewer draws. */
export interface MeetingAttendee {
  person: number;
  role: string;
  schedule: DayScheduleEntry[];
  legs: DayMovementLeg[];
}

export interface MeetingDetail extends MeetingRow {
  date: string;
  attendees: MeetingAttendee[];
}

const MEETING_COLUMNS = [
  "meeting.key", "meeting.kind", "meeting.purpose", "meeting.venue",
  "meeting.latE6", "meeting.lonE6", "meeting.start", "meeting.end",
  "meeting.payer", "meeting.host", "meeting.partyOffset", "meeting.partyCount",
] as const;

/**
 * The index, cached against the file's own modification time.
 *
 * A whole-file pass rather than a seek per meeting: the tables are tens of
 * thousands of rows against a file of hundreds of millions, and the list page
 * wants to sort and filter across all of them. Keyed on mtime so re-exporting
 * a date invalidates it without anything having to say so.
 */
const indexCache = new Map<string, { mtimeMs: number; index: MeetingIndex }>();

export async function readMeetingIndex(date: string): Promise<MeetingIndex | null> {
  const path = await dayPath(date);
  if (!path) return null;
  const info = await stat(path);
  const cached = indexCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.index;

  const reader = await openDay(path);
  try {
    const index = await buildIndex(reader);
    indexCache.set(path, { mtimeMs: info.mtimeMs, index });
    return index;
  } finally {
    await reader.close();
  }
}

async function buildIndex(reader: Reader): Promise<MeetingIndex> {
  const { meta } = reader;
  const empty: MeetingIndex = { date: meta.date, meetings: [] };
  // Absent columns mean a file written before version 6, which had no
  // gatherings in it at all. Present and empty means a day nobody arranged
  // anything on, which the caller renders as an empty list either way.
  if (!reader.has("meeting.key")) return empty;

  const rows = reader.spec("meeting.key").count;
  if (!rows) return empty;

  const data = await Promise.all(MEETING_COLUMNS.map((name) => reader.whole(name)));
  const buffers = new Map(MEETING_COLUMNS.map((name, i) => [name as string, data[i]!]));
  const at = (name: string, row: number) => value(buffers.get(name)!, reader.spec(name).type, row);

  const [partyPerson, partyRole] = await Promise.all([
    reader.whole("party.person"), reader.whole("party.role"),
  ]);
  const roleAt = (row: number) => meta.enums.partyRole?.[value(partyRole, "u8", row)] ?? "attendee";

  const meetings: MeetingRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = at("meeting.partyOffset", row);
    const count = at("meeting.partyCount", row);
    const party: MeetingParty[] = Array.from({ length: count }, (_, i) => ({
      person: value(partyPerson, "u32", offset + i),
      role: roleAt(offset + i),
    }));
    const payer = at("meeting.payer", row);
    const host = at("meeting.host", row);
    meetings.push({
      index: row,
      key: reader.string(at("meeting.key", row)) ?? `meeting ${row}`,
      kind: meta.enums.meetingKind?.[at("meeting.kind", row)] ?? "unknown",
      purpose: reader.string(at("meeting.purpose", row)) ?? "unknown",
      venue: reader.string(at("meeting.venue", row)),
      lat: at("meeting.latE6", row) / 1e6,
      lon: at("meeting.lonE6", row) / 1e6,
      start: at("meeting.start", row),
      end: at("meeting.end", row),
      // -1 is nobody, not resident zero: no one treated, no one hosted.
      payer: payer < 0 ? null : payer,
      host: host < 0 ? null : host,
      party,
    });
  }
  return { date: meta.date, meetings };
}

/**
 * One gathering with everybody's day attached.
 *
 * Every attendee's movement comes off one open file — a party of six is six
 * `personRow` lookups and six sets of column slices, not six file opens — and
 * only the movement is read. See `readMovement` for why that matters.
 */
export async function readMeeting(date: string, index: number): Promise<MeetingDetail | null> {
  const path = await dayPath(date);
  const catalogue = await readMeetingIndex(date);
  if (!path || !catalogue) return null;
  const meeting = catalogue.meetings[index];
  if (!meeting) return null;

  const reader = await openDay(path);
  try {
    const attendees = await Promise.all(meeting.party.map(async (party) => {
      const row = await personRow(reader, party.person);
      const movement = row < 0
        ? { schedule: [], legs: [] }
        : await readMovement(reader, row);
      return { person: party.person, role: party.role, ...movement } satisfies MeetingAttendee;
    }));
    return { ...meeting, date: catalogue.date, attendees };
  } finally {
    await reader.close();
  }
}

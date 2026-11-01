/**
 * A gathering, arranged for drawing: who was there, what colour they are, and
 * the moments of the evening worth marking on a clock.
 *
 * The day file says a meeting happened at a venue between two minutes and
 * names the party. It does not say when any of them set out, who collected
 * whom on the way, or which of them stayed to the end — all of that is in the
 * attendees' own legs and schedules, and recovering it is what this file does.
 *
 * Everything here is derived by *position*, not by a foreign key. A leg that
 * ends within a stone's throw of the venue is an arrival at it; a leg carrying
 * a `meet` purpose that ends anywhere else is a doorstep, which is to say a
 * driver collecting somebody. That is deliberate: the export writes a person's
 * legs without a meeting id on them, and the geometry is the join.
 */

import { DAY_END, DAY_START, clock, type Movement } from "@/lib/day-timeline";
import type { Identity } from "@/lib/identity";
import type { MeetingAttendee, MeetingDetail } from "@/lib/server/meetings";

/** Where a gathering lives. The date rides along so the page can read a file. */
export const meetingHref = (date: string, index: number): string =>
  `/meetings/${index}?date=${encodeURIComponent(date)}`;

/**
 * A name, or the id when identity.bin was never generated.
 *
 * Here rather than in each component because the list, the timeline rows, the
 * map tooltips and the event log all say the same thing about the same person,
 * and three of those are not React.
 */
export const nameOf = (names: Identity | null, person: number): string =>
  names?.knows(person) ? names.name(person) : `Resident ${person}`;

/**
 * One hue per person at the table.
 *
 * Distinct at the widths these are drawn — a two-pixel route line and a small
 * disc on a map — and deliberately not the mode palette from `day-timeline`.
 * On this page colour answers "who", and travel mode is carried by the tooltip
 * instead; two colour languages on one map is one too many.
 */
export const PARTY_COLORS = [
  "#1667d8", "#eb6834", "#1baf7a", "#c2417a", "#7a5bd0", "#eda100",
  "#00a0a8", "#d0021b", "#5b8c00", "#b5651d", "#0e7490", "#9b1fa8",
] as const;

export const partyColor = (index: number): string =>
  PARTY_COLORS[index % PARTY_COLORS.length];

/** Close enough to the venue to be the venue. Doorways, car parks, a kerb. */
const AT_VENUE_METRES = 140;

/** Rough metres between two coordinates. Good enough to tell a door from a street. */
export function metresBetween(
  a: { lat: number; lon: number }, b: { lat: number; lon: number },
): number {
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = (b.lon - a.lon) * Math.cos(lat);
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** The attendee's own stay, which can be shorter than the gathering. */
export function stayOf(
  meeting: MeetingDetail, attendee: MeetingAttendee,
): { start: number; end: number } | null {
  // Strict overlap: a person can have two gatherings in an evening, and one
  // that starts the minute this one ends is the next one, not this one.
  const booked = attendee.schedule
    .filter((entry) => entry.kind === "meet" && entry.end > meeting.start && entry.start < meeting.end);
  if (!booked.length) return null;
  return {
    start: Math.min(...booked.map((entry) => entry.start)),
    end: Math.max(...booked.map((entry) => entry.end)),
  };
}

export type MeetingMomentKind =
  | "sets-out" | "arrives" | "leaves" | "collects" | "collected"
  | "drops-off" | "dropped-off" | "home";

export interface MeetingMoment {
  minute: number;
  kind: MeetingMomentKind;
  /** Index into the attendee list — whose moment this is. */
  attendee: number;
  person: number;
  label: string;
  detail: string;
  color: string;
}

const MOMENT_COLOR: Record<MeetingMomentKind, string> = {
  "sets-out": "#eda100",
  arrives: "#2fa84f",
  leaves: "#d0021b",
  collects: "#c2417a",
  collected: "#c2417a",
  "drops-off": "#7a5bd0",
  "dropped-off": "#7a5bd0",
  home: "#616e7a",
};

/** What to call a kind of mark in the legend, where there is no room for more. */
const MOMENT_LEGEND: Record<MeetingMomentKind, string> = {
  "sets-out": "set out",
  arrives: "arrival",
  leaves: "departure",
  collects: "pickup",
  collected: "picked up",
  "drops-off": "drop-off",
  "dropped-off": "dropped off",
  home: "home",
};

const MOMENT_LABEL: Record<MeetingMomentKind, string> = {
  "sets-out": "set out",
  arrives: "arrival",
  leaves: "departure",
  collects: "pickup",
  collected: "picked up",
  "drops-off": "drop-off",
  "dropped-off": "dropped off",
  home: "home",
};

const placeOf = (label: string | null) => label && label.trim() ? label : "Unnamed place";

/**
 * The longest a kerbside stop may sit between two legs and still be part of
 * the same journey. A driver's round is a door, a door, then the restaurant,
 * with a minute or two of idling at each; a quarter of an hour is generous and
 * still nowhere near the next thing anybody does.
 */
const CHAIN_GAP = 20;

/**
 * The evening as it happened to one person: when they set out, when they got
 * there, when they left, and any kerb they stopped at on the way.
 *
 * The chain is what keeps this honest. A `meet` purpose on a leg says somebody
 * was going to *a* gathering, not to this one — half the party has another one
 * later in the day — so a kerbside stop only counts when it is contiguous with
 * the journey that actually reached this venue. Without that test a driver's
 * lunch date shows up as a pickup for their evening at the pub.
 *
 * A lift appears twice on purpose: once as the pickup on the driver's line and
 * once as being collected on the passenger's, because they are the same minute
 * seen from inside and outside the car, and a reader scrubbing the timeline
 * wants both lines to move together.
 */
export function momentsFor(
  meeting: MeetingDetail, attendee: MeetingAttendee, index: number,
): MeetingMoment[] {
  const venue = { lat: meeting.lat, lon: meeting.lon };
  const atVenue = (point: { lat: number; lon: number }) =>
    metresBetween(point, venue) <= AT_VENUE_METRES;

  const moments: MeetingMoment[] = [];
  const add = (minute: number, kind: MeetingMomentKind, detail: string) => moments.push({
    minute, kind, attendee: index, person: attendee.person,
    label: MOMENT_LABEL[kind], detail, color: MOMENT_COLOR[kind],
  });

  const legs = attendee.legs;
  const driving = attendee.role === "driver";
  // Bounded by this person's own stay rather than by the gathering, because
  // they are not the same window: somebody who left the table at ten and drove
  // off from the same street at half eleven was doing something else by then,
  // and calling that departure "leaves" would put a ninety-minute lie on the
  // timeline. The gathering's own hours stand in where no stay was recorded.
  const stay = stayOf(meeting, attendee);
  const sat = stay ?? { start: meeting.start, end: meeting.end };
  const inbound = legs.findIndex((leg) =>
    atVenue(leg.to) && !atVenue(leg.from) && leg.arrive <= sat.start + CHAIN_GAP);
  const outbound = legs.findIndex((leg, at) =>
    at > inbound && atVenue(leg.from) && !atVenue(leg.to)
    && leg.depart >= sat.start && leg.depart <= sat.end + CHAIN_GAP);

  if (inbound >= 0) {
    // Walk back through any kerbside stops that ran straight into this arrival.
    let first = inbound;
    while (first > 0
      && legs[first - 1].purpose === "meet"
      && legs[first].depart - legs[first - 1].arrive <= CHAIN_GAP) first -= 1;

    const origin = legs[first];
    add(origin.depart, "sets-out", `${placeOf(origin.from.label)} · ${origin.mode}`);
    for (let at = first; at < inbound; at += 1) {
      add(legs[at].arrive, driving ? "collects" : "collected", placeOf(legs[at].to.label));
    }
    const arrival = legs[inbound];
    add(arrival.arrive, "arrives",
      `${placeOf(arrival.to.label)} · ${arrival.kilometres.toFixed(1)} km · ${arrival.mode}`);
  }

  if (outbound >= 0) {
    let last = outbound;
    while (last + 1 < legs.length
      && legs[last].purpose === "meet"
      && legs[last + 1].depart - legs[last].arrive <= CHAIN_GAP) last += 1;

    add(legs[outbound].depart, "leaves", `→ ${placeOf(legs[outbound].to.label)} · ${legs[outbound].mode}`);
    for (let at = outbound; at < last; at += 1) {
      add(legs[at].arrive, driving ? "drops-off" : "dropped-off", placeOf(legs[at].to.label));
    }
    const end = legs[last];
    if (end.purpose === "home") add(end.arrive, "home", placeOf(end.to.label));
  }

  return moments.sort((a, b) => a.minute - b.minute);
}

/** Every attendee's moments in one list, in the order the evening ran. */
export function meetingMoments(meeting: MeetingDetail): MeetingMoment[] {
  return meeting.attendees
    .flatMap((attendee, index) => momentsFor(meeting, attendee, index))
    .sort((a, b) => a.minute - b.minute);
}

export const movementOf = (attendee: MeetingAttendee): Movement => ({
  schedule: attendee.schedule, legs: attendee.legs,
});

/** "18:40–21:05 · 2h 25m", the line that qualifies every heading on the page. */
export function meetingSpan(meeting: { start: number; end: number }): string {
  const minutes = Math.max(0, Math.round(meeting.end - meeting.start));
  const length = minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${clock(Math.max(DAY_START, meeting.start))}–${clock(Math.min(DAY_END, meeting.end))} · ${length}`;
}

/**
 * What to call a gathering in a list.
 *
 * The file's own id is `meet/41207/20693`, which is precise and says nothing.
 * The purpose is what somebody went out to do, and it is the only field that
 * distinguishes a coffee from a birthday, so it leads.
 */
export function meetingTitle(meeting: { purpose: string; venue: string | null }): string {
  const purpose = meeting.purpose.replace(/-/g, " ");
  return meeting.venue ? `${purpose} · ${meeting.venue}` : purpose;
}

/**
 * One entry per kind of mark actually present, with how many there were.
 *
 * Counted rather than merely listed because the diamonds are the only thing on
 * the bars too small to tally by eye, and the order is the order of an evening
 * — setting out, pickups, arriving, leaving, home — so the legend reads as the
 * shape of the thing it is labelling.
 */
export function momentLegend(
  moments: MeetingMoment[],
): { kind: MeetingMomentKind; label: string; color: string; count: number }[] {
  const order: MeetingMomentKind[] = [
    "sets-out", "collects", "collected", "arrives", "leaves",
    "drops-off", "dropped-off", "home",
  ];
  const counts = new Map<MeetingMomentKind, number>();
  for (const moment of moments) counts.set(moment.kind, (counts.get(moment.kind) ?? 0) + 1);
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => ({
      kind, label: MOMENT_LEGEND[kind], color: MOMENT_COLOR[kind], count: counts.get(kind)!,
    }));
}

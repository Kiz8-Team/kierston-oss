/**
 * One resident's day on the cellular network, as the day file records it.
 *
 * The file carries two tables and the difference between them is the whole
 * point. SPANS are ground truth — which cell served which handset, minute by
 * minute, whether or not anything reported it. EVENTS are what an operator's
 * own signalling logs would hold, which is strictly less: an idle phone
 * reselecting between cells inside one tracking area moves in the span table
 * and leaves no trace anywhere else. A viewer that drew every span change as
 * something an investigator could have obtained would be inventing evidence,
 * so the two are shown as two lists and labelled as what they are.
 */

import type { DayCell, DayCellSpan, DayNetEvent, DayRadio, DaySubscriber } from "@/lib/server/day";

/**
 * Layer colours: hue is the role, saturation is the generation.
 *
 * Anchor, mid, capacity and FirstNet keep the hues the tower map already uses
 * for the same four roles, so a reader coming from /towers finds the same
 * green low-band and the same purple C-band. Within a hue the 5G cell is the
 * vivid one and the LTE cell the muted one, which is the comparison actually
 * being made when someone reads a day: not "which band" so much as "was this
 * minute on 4G or 5G, and on the wide carrier or the narrow one".
 */
export const LAYER_COLOR: Record<string, string> = {
  "LTE anchor": "#4c9a86", "NR anchor": "#1baf7a",
  "LTE mid": "#4a7fb5", "NR mid": "#2a78d6",
  "LTE capacity": "#8f76c0", "NR capacity": "#8a4fd0",
  "LTE firstnet": "#b06a6a", "NR firstnet": "#d0021b",
};

/** No serving cell at all, which is a state and not a gap. */
export const UNATTACHED_COLOR = "#c3cbd3";

export const layerColor = (layer: string | null): string =>
  layer === null ? UNATTACHED_COLOR : (LAYER_COLOR[layer] ?? "#8a97a3");

/**
 * Event colours. Attach and detach are the loud ones — they bound the minutes
 * the network could reach this handset at all — and periodic tracking-area
 * updates are the quiet ones, because a phone checking in on a timer says
 * nothing about the person carrying it.
 */
export const EVENT_COLOR: Record<string, string> = {
  attach: "#1baf7a", detach: "#d0021b", handover: "#2a78d6",
  reselect: "#8a97a3", tau: "#eda100", connect: "#7a5bd0", release: "#a1714a",
};

/**
 * What each kind of event is, in the words a reader needs rather than the
 * 3GPP ones. The acronym is kept alongside because it is what the record is
 * actually called and what any external document will name it.
 */
export const EVENT_LABEL: Record<string, string> = {
  attach: "Attach", detach: "Detach", handover: "Handover",
  reselect: "Reselection", tau: "Tracking-area update",
  connect: "Bearer up", release: "Bearer down",
};

export const CAUSE_LABEL: Record<string, string> = {
  "power-on": "powered on",
  "power-off": "powered off",
  battery: "battery flat",
  coverage: "coverage loss",
  "better-cell": "better cell",
  "ta-change": "tracking-area change",
  periodic: "periodic timer",
  session: "session",
  idle: "idle",
  "left-behind": "left behind",
  "day-start": "attached at 00:00",
};

export const EXPOSURE_LABEL: Record<string, string> = {
  outdoor: "outdoors", indoor: "indoors", vehicle: "in vehicle",
};

/**
 * The events worth listing, which is not the same as the events an operator
 * would hold — see `REPORTED` below.
 *
 * Bearer up and bearer down are excluded from the list a reader scrolls, not
 * because they are untrue but because there are around fifty of them in a day
 * and they say only that the phone synced something. They stay in the count.
 */
export const SIGNALLING = new Set(["attach", "detach", "handover", "reselect", "tau"]);

/**
 * The events that actually reach a network's records.
 *
 * The event table carries reselections too, and it has to: a phone that
 * retunes while idle really did change cell. But nothing reported it. An idle
 * handset decides alone from parameters the cell broadcasts, retunes, and
 * tells the network nothing — the network holds a tracking area for that
 * phone, not a cell, and pages the whole area when it wants it. A handover is
 * the opposite case in every respect: the network commanded it, in order to
 * keep a live bearer up, and therefore has it.
 *
 * A viewer that showed the two the same way would be presenting ground truth
 * as evidence, which is the one mistake this whole layer is shaped to prevent.
 */
export const REPORTED = new Set(["attach", "detach", "handover", "tau"]);

/**
 * RSRP is reference-signal received power, in dBm, and it is negative.
 *
 * The bands are the ones handset diagnostics conventionally use. −85 and
 * better is what standing under a sector looks like; −115 and worse is a phone
 * about to lose the cell, which in this simulation usually means somebody is
 * indoors on a high band and about to be handed down to the anchor layer.
 */
export function signalBars(rsrp: number | null): number {
  if (rsrp === null) return 0;
  if (rsrp >= -85) return 4;
  if (rsrp >= -95) return 3;
  if (rsrp >= -105) return 2;
  if (rsrp >= -115) return 1;
  return 0;
}

export function signalLabel(rsrp: number | null): string {
  if (rsrp === null) return "no serving cell";
  return `${rsrp.toFixed(0)} dBm`;
}

/** A handset with its own day pulled out of the person's two flat tables. */
export interface HandsetDay {
  subscriber: DaySubscriber;
  spans: DayCellSpan[];
  events: DayNetEvent[];
  /** Serving-cell changes across the day, which is spans minus the first. */
  changes: number;
  /** Minutes with any serving cell at all. */
  attached: number;
  /** Minutes carrying a bearer, which is a subset of the attached ones. */
  connected: number;
  /** Distinct cells touched, and distinct tracking areas among them. */
  cells: number;
  areas: number;
}

export interface RadioDay {
  handsets: HandsetDay[];
  /** Every cell the day touched, by its index in the file's cell table. */
  cells: Map<number, DayCell>;
}

export function buildRadioDay(radio: DayRadio): RadioDay {
  const cells = new Map(radio.cells.map((cell) => [cell.index, cell]));
  const handsets = radio.subscribers.map((subscriber) => {
    const spans = radio.spans
      .filter((span) => span.subscriber === subscriber.index)
      .sort((a, b) => a.start - b.start);
    const events = radio.events
      .filter((event) => event.subscriber === subscriber.index)
      .sort((a, b) => a.minute - b.minute);
    const touched = new Set<number>();
    const areas = new Set<number>();
    let attached = 0;
    let connected = 0;
    for (const span of spans) {
      connected += span.connected;
      if (span.cell === null) continue;
      attached += span.end - span.start;
      touched.add(span.cell);
      const cell = cells.get(span.cell);
      if (cell) areas.add(cell.trackingArea);
    }
    return {
      subscriber, spans, events,
      changes: Math.max(0, spans.length - 1),
      attached, connected,
      cells: touched.size,
      areas: areas.size,
    } satisfies HandsetDay;
  });
  return { handsets, cells };
}

/** The span covering a minute, or null where the handset has no day at all. */
export function spanAt(spans: DayCellSpan[], minute: number): DayCellSpan | null {
  for (const span of spans) {
    if (minute >= span.start && minute < span.end) return span;
  }
  return spans.length && minute >= spans[spans.length - 1].end
    ? spans[spans.length - 1]
    : null;
}

/**
 * How a cell is named in a list: the band a reader recognises, then the
 * identifier a record would actually carry.
 */
export function cellName(cell: DayCell | undefined): string {
  return cell ? `${cell.band ?? cell.layer}` : "no cell";
}

export function cellDetail(cell: DayCell | undefined): string {
  if (!cell) return "no serving cell";
  return `${cell.cgi ?? "unknown CGI"} · TAC ${cell.trackingArea} · PCI ${cell.pci}`;
}

/**
 * The handset's own network as the records name it.
 *
 * A subscription on a brand that owns no spectrum rides a host network, and
 * the cells in this person's day belong to that host. Saying "Mint" alone
 * would leave a reader unable to explain why every cell is T-Mobile's.
 */
export function carrierLine(subscriber: DaySubscriber): string {
  const brand = subscriber.carrier ?? "unknown carrier";
  const parts = [subscriber.mvno ? `${brand} on ${subscriber.operator}` : brand];
  if (subscriber.prepaid) parts.push("prepaid");
  return parts.join(" · ");
}

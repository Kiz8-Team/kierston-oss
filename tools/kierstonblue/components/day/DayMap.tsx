"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import { MODE_COLOR, clock, type TimelinePosition } from "@/lib/day-timeline";
import type { DayMovementLeg } from "@/lib/server/day";
import { Swatch } from "@/components/Charts";
import { cn } from "@/lib/utils";

const HOME_VIEW: [number, number] = [40.602989, -75.472188];

/**
 * The cell serving one handset at the cursor.
 *
 * Drawn as a line from the person to the antenna rather than as a dot on its
 * own, because the fact worth seeing is the pairing: this position, that mast,
 * this minute. It is also the one drawing on the page that has to be read
 * carefully — the line is the serving cell, not a claim about the direction
 * anyone was facing or how far the sector reaches.
 */
export interface ServingCell {
  lat: number;
  lon: number;
  color: string;
  label: string;
}

export function DayMap({ legs, active, position, serving = [], fitToken, onSelect, className }: {
  legs: DayMovementLeg[];
  /** Leg the timeline cursor is inside, or null when the person is not moving. */
  active: number | null;
  /** Where the person is at the cursor, drawn as a marker that follows a scrub. */
  position: TimelinePosition | null;
  /** One entry per handset that has a serving cell at the cursor. */
  serving?: ServingCell[];
  /** Bumped when the view should re-frame — never during a scrub. */
  fitToken: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const cursorLayerRef = useRef<L.LayerGroup | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;
    (async () => {
      const leaflet = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;
      map = leaflet.map(containerRef.current, { zoomControl: false });
      map.setView(HOME_VIEW, 13);
      leaflet.control.zoom({ position: "topright" }).addTo(map);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      routeLayerRef.current = leaflet.layerGroup().addTo(map);
      cursorLayerRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;
      readyRef.current = true;
    })();
    return () => { cancelled = true; readyRef.current = false; map?.remove(); };
  }, []);

  /** Run `draw` once the async Leaflet import has landed. */
  const whenReady = (draw: () => void) => {
    let cancelled = false;
    let frame = 0;
    const attempt = () => {
      if (cancelled) return;
      if (readyRef.current) { draw(); return; }
      frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  };

  // Routes. Redrawn when the active leg changes, which is cheap: a day is a
  // handful of polylines, and the tiles and the cursor marker are untouched.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = routeLayerRef.current!;
    layer.clearLayers();
    if (!legs.length) return;

    legs.forEach((leg, index) => {
      const path: [number, number][] = leg.path.length
        ? leg.path
        : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
      const lit = active === index;
      if (lit) leaflet.polyline(path, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(layer);
      leaflet.polyline(path, {
        color: MODE_COLOR[leg.mode] ?? MODE_COLOR.other,
        weight: lit ? 5.5 : 3.5,
        opacity: active === null ? 0.9 : (lit ? 0.95 : 0.3),
      })
        .bindTooltip(`${clock(leg.depart)} · ${leg.mode} · ${leg.from.label ?? "origin"} → ${leg.to.label ?? "destination"}`)
        .on("click", () => onSelect(index))
        .addTo(layer);
    });

    const first = legs[0];
    const last = legs[legs.length - 1];
    const marker = (point: [number, number], label: string, title: string) =>
      leaflet.circleMarker(point, {
        radius: 7, color: "#ffffff", weight: 2, fillColor: label === "S" ? "#2fa84f" : "#d0021b", fillOpacity: 1,
      }).bindTooltip(`${label} · ${title}`).addTo(layer);
    marker([first.from.lat, first.from.lon], "S", first.from.label ?? "Start");
    marker([last.to.lat, last.to.lon], "E", last.to.label ?? "End");
  }), [legs, active, onSelect]);

  // The scrubbing marker. Its own layer and its own effect, so dragging the
  // timeline moves one circle rather than rebuilding every route.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = cursorLayerRef.current!;
    layer.clearLayers();
    if (!position) return;
    const point: [number, number] = [position.lat, position.lon];

    // The serving cells first, so the person's own marker sits on top of the
    // lines rather than under them.
    for (const cell of serving) {
      const antenna: [number, number] = [cell.lat, cell.lon];
      leaflet.polyline([point, antenna], {
        color: cell.color, weight: 2, opacity: 0.85, dashArray: "5 4", interactive: false,
      }).addTo(layer);
      leaflet.circleMarker(antenna, {
        radius: 5, color: "#ffffff", weight: 2, fillColor: cell.color, fillOpacity: 1,
      }).bindTooltip(cell.label).addTo(layer);
    }

    leaflet.circleMarker(point, {
      radius: position.moving ? 13 : 11, color: "#ffffff", weight: 0,
      fillColor: "#ffffff", fillOpacity: 0.55, interactive: false,
    }).addTo(layer);
    leaflet.circleMarker(point, {
      radius: position.moving ? 7 : 6, color: "#ffffff", weight: 2.5,
      fillColor: position.moving ? "#f5691f" : "#1b2430", fillOpacity: 1, interactive: false,
    }).addTo(layer);
  }), [position, serving]);

  // Framing is a deliberate act — a click on a leg, or a newly loaded person —
  // so that scrubbing never yanks the viewport out from under the cursor.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const map = mapRef.current!;
    const focus = active !== null && legs[active]?.path.length
      ? legs[active].path
      : legs.flatMap((leg) => leg.path.length ? leg.path : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]] as [number, number][]);
    if (focus.length > 1) map.fitBounds(leaflet.latLngBounds(focus), { padding: [28, 28] });
    else if (focus.length === 1) map.setView(focus[0], 15);
    else map.setView(HOME_VIEW, 13);
    // `active` is read at fit time but must not itself trigger a fit: scrubbing
    // changes it constantly, and only fitToken says the view may move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fitToken, legs]);

  const modes = [...new Set(legs.map((leg) => leg.mode))];
  return (
    <div className="grid gap-2">
      <div ref={containerRef} className={cn("h-[28rem] min-h-[18rem] w-full overflow-hidden rounded-[var(--radius)] border border-border", className)} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
        {modes.map((mode) => (
          <span key={mode}><Swatch color={MODE_COLOR[mode] ?? MODE_COLOR.other} />{mode}</span>
        ))}
        {serving.length ? <span>Dashed · serving cell</span> : null}
        {legs.length ? null : <span>No movements</span>}
      </div>
    </div>
  );
}

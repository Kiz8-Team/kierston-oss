"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import { Swatch } from "@/components/Charts";
import { MODE_COLOR } from "@/lib/day-timeline";
import { PARKED_COLOR, clockOfSecond } from "@/lib/vehicle-day";
import type { VehicleDay } from "@/lib/server/vehicles";

const HOME_VIEW: [number, number] = [40.602989, -75.472188];

/**
 * Where a vehicle went, and where it stood.
 *
 * The person's map draws routes only, because a person is somewhere the whole
 * time whether or not they moved. A vehicle's day is mostly the standing: the
 * kerbs it waited at are half of what the file says about it, so they are
 * drawn as their own marks rather than left as the gaps between lines.
 */
export function VehicleMap({ day, active, position, fitToken, onSelect }: {
  day: VehicleDay;
  /** Movement the cursor is inside, or null while the vehicle is parked. */
  active: number | null;
  position: { lat: number; lon: number; moving: boolean } | null;
  fitToken: number;
  onSelect: (index: number) => void;
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

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = routeLayerRef.current!;
    layer.clearLayers();

    // Where it stood, under the routes: a kerb the car returns to three times
    // should not be drawn over the line that took it there.
    for (const span of day.spans) {
      if (span.moving) continue;
      leaflet.circleMarker([span.lat, span.lon], {
        radius: 4, color: "#ffffff", weight: 1.5, fillColor: PARKED_COLOR, fillOpacity: 0.95,
      })
        .bindTooltip(
          `Parked ${clockOfSecond(span.start)}–${clockOfSecond(span.end)}`,
        )
        .addTo(layer);
    }

    day.movements.forEach((movement, index) => {
      const path: [number, number][] = movement.path.length
        ? movement.path
        : [[movement.from.lat, movement.from.lon], [movement.to.lat, movement.to.lon]];
      const lit = active === index;
      if (lit) leaflet.polyline(path, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(layer);
      const aboard = movement.passengers.length;
      leaflet.polyline(path, {
        color: MODE_COLOR[movement.mode] ?? MODE_COLOR.other,
        weight: lit ? 5.5 : 3.5,
        opacity: active === null ? 0.9 : (lit ? 0.95 : 0.3),
      })
        .bindTooltip(
          `${clockOfSecond(movement.start)} · ${movement.mode} · `
          + `${movement.from.label ?? "origin"} → ${movement.to.label ?? "destination"}`
          + (movement.person === null ? "" : ` · driver ${movement.person}`)
          + (aboard ? ` · ${aboard} aboard` : ""),
        )
        .on("click", () => onSelect(index))
        .addTo(layer);
    });
  }), [day, active, onSelect]);

  // The scrubbing marker, on its own layer so dragging the timeline moves one
  // circle rather than rebuilding every route.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = cursorLayerRef.current!;
    layer.clearLayers();
    if (!position) return;
    const point: [number, number] = [position.lat, position.lon];
    leaflet.circleMarker(point, {
      radius: position.moving ? 13 : 11, color: "#ffffff", weight: 0,
      fillColor: "#ffffff", fillOpacity: 0.55, interactive: false,
    }).addTo(layer);
    leaflet.circleMarker(point, {
      radius: position.moving ? 7 : 6, color: "#ffffff", weight: 2.5,
      fillColor: position.moving ? "#f5691f" : "#1b2430", fillOpacity: 1, interactive: false,
    }).addTo(layer);
  }), [position]);

  // Framing is a deliberate act — a click on a movement, or a newly loaded
  // vehicle — so that scrubbing never yanks the viewport out from under it.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const map = mapRef.current!;
    const focus: [number, number][] = active !== null && day.movements[active]?.path.length
      ? day.movements[active]!.path
      : day.movements.flatMap((movement) => movement.path.length
        ? movement.path
        : [[movement.from.lat, movement.from.lon], [movement.to.lat, movement.to.lon]] as [number, number][]);
    const points = focus.length
      ? focus
      : day.spans.map((span) => [span.lat, span.lon] as [number, number]);
    if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [28, 28] });
    else if (points.length === 1) map.setView(points[0]!, 16);
    else map.setView(HOME_VIEW, 13);
    // `active` is read at fit time but must not itself trigger a fit: scrubbing
    // changes it constantly, and only fitToken says the view may move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fitToken, day]);

  const modes = [...new Set(day.movements.map((movement) => movement.mode))];
  return (
    <div className="grid gap-2">
      <div ref={containerRef} className="h-[28rem] min-h-[18rem] w-full overflow-hidden rounded-[var(--radius)] border border-border" />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
        {modes.map((mode) => (
          <span key={mode}><Swatch color={MODE_COLOR[mode] ?? MODE_COLOR.other} />{mode}</span>
        ))}
        <span><Swatch color={PARKED_COLOR} />parked</span>
      </div>
    </div>
  );
}

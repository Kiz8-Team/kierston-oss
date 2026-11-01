"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import {
  CALLER_COLOR, PRIORITY_COLOR, SERVICE_COLOR, dispatchClock, kindLabel, serviceLabel,
  trackPosition,
} from "@/lib/dispatch";
import type { IncidentRow, UnitTrack } from "@/lib/server/dispatch";

/**
 * Calls for service on a map, in two modes.
 *
 * Without a selection it is the day's calls as discs coloured by priority,
 * unserved ones hollow, each a way into its incident. With one it is that
 * incident: the scene, the drives out of the vehicle span table, the hospital
 * where there was one, and each vehicle where it is at the cursor.
 *
 * A drive inside the unit's run is drawn at full weight and everything else
 * the vehicle did in the window — the patrol leg it was pulled off, the drive
 * back to its beat — underneath and faint.
 */

const HOME_VIEW: [number, number] = [40.602989, -75.472188];

export function DispatchMap({
  incidents, selected = null, tracks = [], minute = 0, fitToken, onSelect, className,
}: {
  incidents: IncidentRow[];
  selected?: IncidentRow | null;
  tracks?: UnitTrack[];
  minute?: number;
  fitToken: number;
  onSelect?: (index: number) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const incidentLayerRef = useRef<L.LayerGroup | null>(null);
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
      incidentLayerRef.current = leaflet.layerGroup().addTo(map);
      cursorLayerRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;
      readyRef.current = true;
    })();
    return () => { cancelled = true; readyRef.current = false; map?.remove(); };
  }, []);

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
    const layer = incidentLayerRef.current!;
    layer.clearLayers();
    for (const incident of incidents) {
      const chosen = selected?.index === incident.index;
      const unserved = incident.disposition === "unserved";
      const color = PRIORITY_COLOR[incident.priority] ?? PRIORITY_COLOR[3]!;
      const marker = leaflet.circleMarker([incident.lat, incident.lon], {
        radius: chosen ? 9 : 6,
        color: chosen ? "#ffffff" : unserved ? color : "#111827",
        weight: chosen ? 3 : unserved ? 2.5 : 1,
        fillColor: color,
        fillOpacity: unserved && !chosen ? 0 : 0.9,
      })
        .bindTooltip(`${dispatchClock(incident.received)} · P${incident.priority} · ${kindLabel(incident.kind)} · ${incident.disposition}`)
        .addTo(layer);
      if (onSelect) marker.on("click", () => onSelect(incident.index));
    }
  }), [incidents, selected, onSelect]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = routeLayerRef.current!;
    layer.clearLayers();
    if (!selected) return;
    for (const track of tracks) {
      const unit = selected.units.find((one) => one.vin === track.vin);
      const color = SERVICE_COLOR[unit?.service ?? track.serviceClass] ?? "#616e7a";
      for (const movement of track.movements) {
        const run = unit !== undefined
          && movement.end > unit.dispatched * 60
          && movement.start < (unit.returned ?? unit.hospitalLeft ?? unit.cleared) * 60;
        const path: [number, number][] = movement.path.length
          ? movement.path
          : [[movement.from.lat, movement.from.lon], [movement.to.lat, movement.to.lon]];
        leaflet.polyline(path, { color, weight: run ? 4.5 : 2, opacity: run ? 0.95 : 0.3 })
          .bindTooltip(`${serviceLabel(unit?.service ?? track.serviceClass)} ${track.vin} · `
            + `${dispatchClock(movement.start / 60)}–${dispatchClock(movement.end / 60)} · ${movement.purpose} · `
            + `${movement.from.label ?? "origin"} → ${movement.to.label ?? "destination"}`)
          .addTo(layer);
      }
    }
    for (const unit of selected.units) {
      if (!unit.hospital) continue;
      leaflet.circleMarker([unit.hospital.lat, unit.hospital.lon], {
        radius: 8, color: SERVICE_COLOR.ems, weight: 3, fillColor: "#ffffff", fillOpacity: 1,
      }).bindTooltip(unit.hospital.label).addTo(layer);
    }
    leaflet.circleMarker([selected.lat, selected.lon], {
      radius: 16, color: CALLER_COLOR, weight: 2, dashArray: "4 4", fill: false, interactive: false,
    }).addTo(layer);
  }), [selected, tracks]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = cursorLayerRef.current!;
    layer.clearLayers();
    if (!selected) return;
    for (const track of tracks) {
      const position = trackPosition(track, minute);
      if (!position) continue;
      const unit = selected.units.find((one) => one.vin === track.vin);
      const color = SERVICE_COLOR[unit?.service ?? track.serviceClass] ?? "#616e7a";
      if (position.moving) {
        leaflet.circleMarker([position.lat, position.lon], {
          radius: 13, weight: 0, fillColor: color, fillOpacity: 0.28, interactive: false,
        }).addTo(layer);
      }
      leaflet.circleMarker([position.lat, position.lon], {
        radius: position.moving ? 7 : 6, color: "#ffffff", weight: 2.5, fillColor: color, fillOpacity: 1,
      })
        .bindTooltip(`${serviceLabel(unit?.service ?? track.serviceClass)} ${track.vin}${position.moving ? " · moving" : ""}`)
        .addTo(layer);
    }
  }), [selected, tracks, minute]);

  // Framing follows a load, never the cursor.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const map = mapRef.current!;
    if (!selected) {
      const points = incidents.map((incident) => [incident.lat, incident.lon] as [number, number]);
      if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [30, 30] });
      else if (points.length === 1) map.setView(points[0]!, 15);
      return;
    }
    const points: [number, number][] = [[selected.lat, selected.lon]];
    for (const unit of selected.units) {
      if (unit.hospital) points.push([unit.hospital.lat, unit.hospital.lon]);
    }
    for (const track of tracks) {
      const unit = selected.units.find((one) => one.vin === track.vin);
      for (const movement of track.movements) {
        if (unit && movement.end >= unit.dispatched * 60 && movement.start <= unit.cleared * 60) {
          points.push([movement.from.lat, movement.from.lon], [movement.to.lat, movement.to.lon]);
        }
      }
    }
    if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
    else map.setView(points[0]!, 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fitToken]);

  return (
    <div
      ref={containerRef}
      className={className ?? "h-[32rem] min-h-[18rem] w-full overflow-hidden rounded-[var(--radius)] border border-border"}
    />
  );
}

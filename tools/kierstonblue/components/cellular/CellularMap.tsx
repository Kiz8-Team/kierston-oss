"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import {
  gridPoint, metres, taGroundRadius, type CellularEstimate, type Estimate, type GridSpec,
  type LatLon, type PosteriorCells, type SiteCell,
} from "@/lib/cellular";
import { offset } from "@/lib/towers";

/**
 * The truth, the estimate, and the evidence between them.
 *
 * The resident's journeys are drawn faint and their position at the cursor
 * green. The estimate is the orange disc with its 50% and 95% radii, over the
 * credible region itself as a heat of grid cells — which is the honest shape
 * of the answer: a TA ring cut by a wedge is an arc, not a circle. A selected
 * record adds its serving sector, the TA ring it measured, and its secondary.
 */

export const TRUTH_COLOR = "#1baf7a";
export const ESTIMATE_COLOR = "#f97316";
export const SERVING_COLOR = "#3b82f6";
export const SECONDARY_COLOR = "#a855f7";

const HOME_VIEW: [number, number] = [40.602989, -75.472188];

export interface RecordOverlay {
  serving: SiteCell | null;
  ta: number | null;
  secondary: SiteCell | null;
  previous: SiteCell | null;
}

function wedge(cell: SiteCell, range: number): [number, number][] {
  const points: [number, number][] = [[cell.lat, cell.lon]];
  const half = cell.beamwidth / 2;
  for (let i = 0; i <= 16; i += 1) {
    points.push(offset(cell.lat, cell.lon, cell.azimuth - half + (cell.beamwidth * i) / 16, range));
  }
  points.push([cell.lat, cell.lon]);
  return points;
}

export function CellularMap({ legs, grid, truth, estimate, heat, overlay, fitToken }: {
  legs: CellularEstimate["legs"];
  grid: GridSpec | null;
  truth: LatLon | null;
  estimate: Estimate | null;
  heat: PosteriorCells | null;
  overlay: RecordOverlay | null;
  fitToken: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const layersRef = useRef<{ routes: L.LayerGroup; heat: L.LayerGroup; overlay: L.LayerGroup; cursor: L.LayerGroup; canvas: L.Canvas } | null>(null);
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
      layersRef.current = {
        routes: leaflet.layerGroup().addTo(map),
        heat: leaflet.layerGroup().addTo(map),
        overlay: leaflet.layerGroup().addTo(map),
        cursor: leaflet.layerGroup().addTo(map),
        canvas: leaflet.canvas({ padding: 0.3 }),
      };
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
    const layer = layersRef.current!.routes;
    layer.clearLayers();
    for (const leg of legs) {
      const path = leg.path.length ? leg.path : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]] as [number, number][];
      leaflet.polyline(path, { color: TRUTH_COLOR, weight: 2.5, opacity: 0.45, interactive: false }).addTo(layer);
    }
  }), [legs]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const { heat: layer, canvas } = layersRef.current!;
    layer.clearLayers();
    if (!heat || !grid) return;
    const dLat = grid.step / grid.mLat / 2;
    const dLon = grid.step / grid.mLon / 2;
    heat.cells.forEach((index, at) => {
      const centre = gridPoint(grid, index);
      const weight = heat.weights[at]! / 255;
      leaflet.rectangle(
        [[centre.lat - dLat, centre.lon - dLon], [centre.lat + dLat, centre.lon + dLon]],
        { renderer: canvas, stroke: false, fillColor: ESTIMATE_COLOR, fillOpacity: 0.1 + 0.55 * weight, interactive: false },
      ).addTo(layer);
    });
  }), [heat, grid]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = layersRef.current!.overlay;
    layer.clearLayers();
    if (!overlay) return;
    const { serving, ta, secondary, previous } = overlay;
    if (previous) {
      leaflet.circleMarker([previous.lat, previous.lon], { radius: 5, color: "#8b9298", weight: 2, fillOpacity: 0.6 })
        .bindTooltip(`Previous · ${previous.band} sector ${previous.sector + 1}`).addTo(layer);
    }
    if (secondary) {
      const shape = secondary.beamwidth >= 360
        ? leaflet.circle([secondary.lat, secondary.lon], { radius: secondary.rangeM, color: SECONDARY_COLOR, weight: 1.5, dashArray: "5 5", fillOpacity: 0.04 })
        : leaflet.polygon(wedge(secondary, secondary.rangeM), { color: SECONDARY_COLOR, weight: 1.5, dashArray: "5 5", fillOpacity: 0.04 });
      shape.addTo(layer);
      leaflet.circleMarker([secondary.lat, secondary.lon], { radius: 6, color: "#ffffff", weight: 2, fillColor: SECONDARY_COLOR, fillOpacity: 1 })
        .bindTooltip(`Secondary · ${secondary.band} · ${secondary.role} · range ${metres(secondary.rangeM)}`).addTo(layer);
    }
    if (serving) {
      const reach = ta !== null ? taGroundRadius(ta + 1, serving.heightM) + 150 : serving.rangeM;
      const shape = serving.beamwidth >= 360
        ? leaflet.circle([serving.lat, serving.lon], { radius: reach, color: SERVING_COLOR, weight: 1.5, fillOpacity: 0.04 })
        : leaflet.polygon(wedge(serving, reach), { color: SERVING_COLOR, weight: 1.5, fillOpacity: 0.04 });
      shape.addTo(layer);
      if (ta !== null) {
        for (const steps of [ta, ta + 1]) {
          const radius = taGroundRadius(steps, serving.heightM);
          if (radius > 0) leaflet.circle([serving.lat, serving.lon], { radius, color: SERVING_COLOR, weight: 2, fill: false, dashArray: "3 4" }).addTo(layer);
        }
      }
      leaflet.circleMarker([serving.lat, serving.lon], { radius: 7, color: "#ffffff", weight: 2.5, fillColor: SERVING_COLOR, fillOpacity: 1 })
        .bindTooltip(`Serving · ${serving.band} · ${serving.role} · sector ${serving.sector + 1}${ta !== null ? ` · TA ${ta}` : ""}`).addTo(layer);
    }
  }), [overlay]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const layer = layersRef.current!.cursor;
    layer.clearLayers();
    if (estimate) {
      leaflet.circle([estimate.lat, estimate.lon], { radius: estimate.r95, color: ESTIMATE_COLOR, weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(layer);
      leaflet.circle([estimate.lat, estimate.lon], { radius: estimate.r50, color: ESTIMATE_COLOR, weight: 2, fill: false, interactive: false }).addTo(layer);
      leaflet.circleMarker([estimate.lat, estimate.lon], { radius: 6, color: "#ffffff", weight: 2.5, fillColor: ESTIMATE_COLOR, fillOpacity: 1 })
        .bindTooltip(`Estimate · 50% ${metres(estimate.r50)} · 95% ${metres(estimate.r95)}`).addTo(layer);
    }
    if (truth) {
      leaflet.circleMarker([truth.lat, truth.lon], { radius: 7, color: "#ffffff", weight: 2.5, fillColor: TRUTH_COLOR, fillOpacity: 1 })
        .bindTooltip("Truth").addTo(layer);
    }
  }), [truth, estimate]);

  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const map = mapRef.current!;
    const points: [number, number][] = legs.flatMap((leg) => [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]] as [number, number][]);
    if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fitToken]);

  return <div ref={containerRef} className="h-[36rem] min-h-[18rem] w-full overflow-hidden rounded-[var(--radius)] border border-border" />;
}

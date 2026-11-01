"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { StatusText } from "@/components/browse/EmptyState";
import { metres } from "@/lib/format";
import { runWaypoints, type Run, type SchoolTravel } from "@/lib/school-travel";
import { Swatch } from "@/components/Charts";
import { ROUTE_PIN } from "@/components/map/panel";

/**
 * One bus run, drawn over the roads it actually uses.
 *
 * The stops in the manifest are corners, not a route: the file says where the
 * bus pauses and in what order, and everything between two of those points is
 * the road network's business. So the geometry is asked of the pathfinder
 * service, in the same waypoint order the simulation drove and measured — the
 * yard, every corner, the schools, and back to the yard.
 *
 * When that service is not running the corners are still worth seeing, so the
 * map falls back to dashed straight lines between them and says as much. That
 * is deliberately ugly: a straight line between two stops is not a route, and
 * it should not be possible to mistake one for the other.
 */

const ROUTE_LINE = "#e2a02f";
const DEADHEAD = "#5d6b78";
const STOP_FILL = "#1667d8";
const SCHOOL_FILL = "#c2417a";
const DEPOT_FILL = "#3d4b57";

interface Plan {
  geometry: [number, number][];
  readable: { distance: string; duration: string };
}

function pin(background: string, label: string): string {
  return `<div class="${ROUTE_PIN}" style="background:${background}">${label}</div>`;
}

export function BusRouteMap({ travel, run }: { travel: SchoolTravel; run: Run }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const [status, setStatus] = useState<string | null>(null);
  const [state, setState] = useState<"ok" | "busy" | "error">("busy");

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;

    (async () => {
      const leaflet = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;
      map = leaflet.map(containerRef.current, {
        zoomControl: false,
        // The panel is small and lives inside a scrolling column; a map that
        // grabbed the wheel would trap the reader halfway down the page.
        scrollWheelZoom: false,
      });
      leaflet.control.zoom({ position: "topright" }).addTo(map);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      layerRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Redrawn whenever a different run is selected, which is the common case:
  // the map is created once and the layer group is emptied and refilled.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // The map may still be importing leaflet on the first selection.
      for (let waited = 0; !leafletRef.current && waited < 40; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const leaflet = leafletRef.current;
      const map = mapRef.current;
      const layer = layerRef.current;
      if (cancelled || !leaflet || !map || !layer) return;

      layer.clearLayers();
      const depot = travel.operatorOf(run);
      const waypoints = runWaypoints(travel, run);
      if (!waypoints.length) {
        setStatus("No stop coordinates");
        setState("error");
        return;
      }

      const points: [number, number][] = [
        ...(depot ? [[depot.lat, depot.lon] as [number, number]] : []),
        ...waypoints.map((point) => [point.lat, point.lon] as [number, number]),
        ...(depot ? [[depot.lat, depot.lon] as [number, number]] : []),
      ];

      // Markers first, so the route drawn under them can arrive late without
      // the panel looking empty while it does.
      if (depot) {
        leaflet.marker([depot.lat, depot.lon], {
          icon: leaflet.divIcon({ className: "", html: pin(DEPOT_FILL, "Y"), iconSize: [0, 0] }),
          title: `${depot.name} — yard`,
        }).addTo(layer);
      }
      let stopNumber = 0;
      for (const point of waypoints) {
        const school = point.kind === "school";
        if (!school) stopNumber += 1;
        leaflet.marker([point.lat, point.lon], {
          icon: leaflet.divIcon({
            className: "",
            html: pin(school ? SCHOOL_FILL : STOP_FILL, school ? "S" : String(stopNumber)),
            iconSize: [0, 0],
          }),
          title: school
            ? point.label
            : `${point.label} — ${point.riders} ${point.riders === 1 ? "rider" : "riders"}`,
          zIndexOffset: school ? 500 : 0,
        }).addTo(layer);
      }
      map.fitBounds(leaflet.latLngBounds(points), { padding: [26, 26] });

      setStatus("Loading…");
      setState("busy");

      const [from, ...rest] = points;
      const to = rest.pop()!;
      const query = new URLSearchParams({ from: `${from[0]},${from[1]}`, to: `${to[0]},${to[1]}` });
      for (const via of rest) query.append("via", `${via[0]},${via[1]}`);

      try {
        const response = await fetch(`/api/pathfinder/route?${query}`);
        const data = await response.json();
        if (cancelled || !layerRef.current) return;
        if (!response.ok) throw new Error(data.hint ?? data.error ?? `HTTP ${response.status}`);

        const plan = data as Plan;
        leaflet.polyline(plan.geometry, { color: "#ffffff", weight: 8, opacity: 0.85 })
          .addTo(layerRef.current);
        leaflet.polyline(plan.geometry, { color: ROUTE_LINE, weight: 4.5, opacity: 0.95 })
          .addTo(layerRef.current);
        map.fitBounds(leaflet.latLngBounds(plan.geometry), { padding: [26, 26] });
        setStatus(`Road distance ${plan.readable.distance}`);
        setState("ok");
      } catch (error) {
        if (cancelled || !layerRef.current) return;
        // Straight lines between the corners, dashed, so nobody reads them as
        // a route. The empty legs to and from the yard are greyed apart from
        // the run itself, which is the part carrying children.
        const service = points.slice(depot ? 1 : 0, depot ? points.length - 1 : points.length);
        leaflet.polyline(service, {
          color: ROUTE_LINE, weight: 3, opacity: 0.9, dashArray: "5 5",
        }).addTo(layerRef.current);
        if (depot) {
          for (const leg of [[points[0], service[0]], [service[service.length - 1], to]]) {
            leaflet.polyline(leg as [number, number][], {
              color: DEADHEAD, weight: 1.5, opacity: 0.7, dashArray: "3 4",
            }).addTo(layerRef.current);
          }
        }
        setStatus(
          `${error instanceof Error ? error.message : String(error)} · Straight-line fallback`,
        );
        setState("error");
      }
    })();

    return () => { cancelled = true; };
  }, [travel, run]);

  const spread = spanOf(travel, run);

  return (
    <div className="grid gap-1.5">
      <div
        ref={containerRef}
        className="h-[16rem] w-full overflow-hidden rounded-[var(--radius)] border border-border"
      />
      <p className="text-[0.72rem] text-muted-foreground">
        <span className="mr-2">
          <Swatch color={STOP_FILL} />
          {run.direction === "am" ? "Pick-up" : "Set-down"}
        </span>
        <span className="mr-2">
          <Swatch color={SCHOOL_FILL} />
          School
        </span>
        <span>
          <Swatch color={DEPOT_FILL} />
          Yard
        </span>
      </p>
      {status ? <StatusText state={state}>{status}</StatusText> : null}
      {spread !== null ? (
        <p className="text-[0.72rem] text-muted-foreground">
          Stop spread {metres(spread)}
        </p>
      ) : null}
    </div>
  );
}

/** The widest gap between any two of a run's stops, as a sense of its reach. */
function spanOf(travel: SchoolTravel, run: Run): number | null {
  const points = runWaypoints(travel, run);
  if (points.length < 2) return null;
  let widest = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dLat = (points[j].lat - points[i].lat) * 111_320;
      const dLon = (points[j].lon - points[i].lon) * 111_320
        * Math.cos((points[i].lat * Math.PI) / 180);
      widest = Math.max(widest, Math.hypot(dLat, dLon));
    }
  }
  return widest;
}

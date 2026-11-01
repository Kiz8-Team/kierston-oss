"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { StatusText } from "@/components/browse/EmptyState";
import { standColor, type Driver, type Rider, type Stand, type TaxiFleet } from "@/lib/taxi";
import { Swatch } from "@/components/Charts";
import { ROUTE_PIN } from "@/components/map/panel";

/**
 * The taxi geography, drawn three ways from one map.
 *
 * A stand is shown as its catchment, because a rank on its own is a dot and
 * says nothing: what makes one worth waiting at is the work around it, so the
 * demand points that fall to it are drawn as spokes and the other seven stands
 * stay on the map, dimmed, to show where its territory stops. That partition
 * is the whole of what "standby area" means here — every point in the city
 * belongs to the nearest rank, and the simulation sends a car from whichever
 * one that is.
 *
 * A driver and a rider are journeys instead, so both are asked of the
 * pathfinder and drawn over the roads they use — the driver's dead run from
 * their door to the rank they keep, and the trip a rider would be calling a
 * cab for. Neither is a fare: a fare is a day's business, and no day has been
 * simulated to produce one. What is drawn is the trip the fare would be *for*.
 *
 * The straight-line fallback when the pathfinder is down is dashed and says so
 * — same rule as BusRouteMap, and for the same reason. A straight line between
 * two points is not a route and must not be mistakable for one.
 */

const HOME_FILL = "#1667d8";
const WORK_FILL = "#c2417a";
const DRIVER_FILL = "#3d4b57";

export type Focus =
  | { kind: "stand"; stand: Stand }
  | { kind: "driver"; driver: Driver }
  | { kind: "rider"; rider: Rider };

interface Plan {
  geometry: [number, number][];
  readable: { distance: string; duration: string };
}

function pin(background: string, label: string): string {
  return `<div class="${ROUTE_PIN}" style="background:${background}">${label}</div>`;
}

export function TaxiMap({ fleet, focus }: { fleet: TaxiFleet; focus: Focus }) {
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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      for (let waited = 0; !leafletRef.current && waited < 40; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const leaflet = leafletRef.current;
      const map = mapRef.current;
      const layer = layerRef.current;
      if (cancelled || !leaflet || !map || !layer) return;

      layer.clearLayers();
      setStatus(null);
      setState("ok");

      // Every rank, always, whichever thing is in focus. On a stand it is the
      // boundary of what is being looked at; on a driver or a rider it is the
      // answer to "and which one would a car come from".
      for (const stand of fleet.stands) {
        const lit = focus.kind === "stand" && focus.stand.index === stand.index;
        leaflet.circleMarker([stand.lat, stand.lon], {
          radius: lit ? 9 : 6,
          color: "#ffffff",
          weight: 2,
          fillColor: standColor(stand.index),
          fillOpacity: lit ? 1 : 0.45,
        })
          .bindTooltip(`${stand.id} · ${stand.mass} demand points · ${stand.drivers.length} drivers`)
          .addTo(layer);
      }

      if (focus.kind === "stand") {
        drawCatchment(leaflet, layer, fleet, focus.stand);
        const points = catchmentPoints(fleet, focus.stand);
        if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [26, 26] });
        else map.setView([focus.stand.lat, focus.stand.lon], 14);
        setStatus(
          `${focus.stand.drivers.length} drivers · `
          + `${focus.stand.homes.length} homes · ${focus.stand.works.length} workplaces`,
        );
        setState("ok");
        return;
      }

      const journey = focus.kind === "driver"
        ? driverJourney(fleet, focus.driver)
        : riderJourney(fleet, focus.rider);
      if (!journey) {
        setStatus("No route");
        setState("error");
        return;
      }

      leaflet.marker(journey.from, {
        icon: leaflet.divIcon({ className: "", html: pin(journey.fromFill, "A"), iconSize: [0, 0] }),
        title: journey.fromLabel,
      }).addTo(layer);
      leaflet.marker(journey.to, {
        icon: leaflet.divIcon({ className: "", html: pin(journey.toFill, "B"), iconSize: [0, 0] }),
        title: journey.toLabel,
      }).addTo(layer);
      map.fitBounds(leaflet.latLngBounds([journey.from, journey.to]), { padding: [40, 40] });

      setStatus("Routing…");
      setState("busy");

      const query = new URLSearchParams({
        from: `${journey.from[0]},${journey.from[1]}`,
        to: `${journey.to[0]},${journey.to[1]}`,
      });
      try {
        const response = await fetch(`/api/pathfinder/route?${query}`);
        const data = await response.json();
        if (cancelled || !layerRef.current) return;
        if (!response.ok) throw new Error(data.hint ?? data.error ?? `HTTP ${response.status}`);

        const plan = data as Plan;
        leaflet.polyline(plan.geometry, { color: "#ffffff", weight: 8, opacity: 0.85 })
          .addTo(layerRef.current);
        leaflet.polyline(plan.geometry, { color: journey.line, weight: 4.5, opacity: 0.95 })
          .addTo(layerRef.current);
        map.fitBounds(leaflet.latLngBounds(plan.geometry), { padding: [26, 26] });
        setStatus(`${plan.readable.distance} · ${plan.readable.duration}`);
        setState("ok");
      } catch (error) {
        if (cancelled || !layerRef.current) return;
        leaflet.polyline([journey.from, journey.to], {
          color: journey.line, weight: 3, opacity: 0.9, dashArray: "5 5",
        }).addTo(layerRef.current);
        setStatus(
          `${error instanceof Error ? error.message : String(error)} · straight line`,
        );
        setState("error");
      }
    })();

    return () => { cancelled = true; };
  }, [fleet, focus]);

  return (
    <div className="grid gap-1.5">
      <div
        ref={containerRef}
        className="h-[16rem] w-full overflow-hidden rounded-[var(--radius)] border border-border"
      />
      <p className="text-[0.72rem] text-muted-foreground">
        {focus.kind === "stand" ? (
          <>
            <span className="mr-2">
              <Swatch color={HOME_FILL} />
              Rider home
            </span>
            <span className="mr-2">
              <Swatch color={WORK_FILL} />
              Rider workplace
            </span>
            <span>
              <Swatch color={DRIVER_FILL} />
              Driver home
            </span>
          </>
        ) : (
          <span>
            <Swatch color={standColor(0)} />
            Stands
          </span>
        )}
      </p>
      {status ? <StatusText state={state}>{status}</StatusText> : null}
    </div>
  );
}

// ---- What each focus draws --------------------------------------------------

function catchmentPoints(fleet: TaxiFleet, stand: Stand): [number, number][] {
  const points: [number, number][] = [[stand.lat, stand.lon]];
  for (const index of stand.homes) {
    const rider = fleet.riders[index];
    if (Number.isFinite(rider.lat)) points.push([rider.lat, rider.lon]);
  }
  for (const index of stand.works) {
    const rider = fleet.riders[index];
    if (Number.isFinite(rider.workLat)) points.push([rider.workLat, rider.workLon]);
  }
  for (const index of stand.drivers) {
    const driver = fleet.drivers[index];
    points.push([driver.lat, driver.lon]);
  }
  return points;
}

function drawCatchment(
  leaflet: typeof L,
  layer: L.LayerGroup,
  fleet: TaxiFleet,
  stand: Stand,
): void {
  const colour = standColor(stand.index);
  const centre: [number, number] = [stand.lat, stand.lon];

  // Spokes under the dots, so a dense corner does not disappear under its own
  // lines. They are not journeys — they say "this point counted toward this
  // rank", which is what the clustering decided and nothing more.
  const spoke = (to: [number, number]) => {
    leaflet.polyline([centre, to], {
      color: colour, weight: 1, opacity: 0.28, interactive: false,
    }).addTo(layer);
  };

  for (const index of stand.homes) {
    const rider = fleet.riders[index];
    if (Number.isFinite(rider.lat)) spoke([rider.lat, rider.lon]);
  }
  for (const index of stand.works) {
    const rider = fleet.riders[index];
    if (Number.isFinite(rider.workLat)) spoke([rider.workLat, rider.workLon]);
  }
  for (const index of stand.drivers) {
    const driver = fleet.drivers[index];
    spoke([driver.lat, driver.lon]);
  }

  for (const index of stand.drivers) {
    const driver = fleet.drivers[index];
    leaflet.circleMarker([driver.lat, driver.lon], {
      radius: 3.4, color: DRIVER_FILL, weight: 1, fillColor: DRIVER_FILL, fillOpacity: 0.75,
    })
      .bindTooltip(`Driver ${driver.person} · ${driver.km.toFixed(1)} km from stand`)
      .addTo(layer);
  }
  for (const index of stand.homes) {
    const rider = fleet.riders[index];
    if (!Number.isFinite(rider.lat)) continue;
    leaflet.circleMarker([rider.lat, rider.lon], {
      radius: 3.4, color: "#ffffff", weight: 1, fillColor: HOME_FILL, fillOpacity: 0.9,
    })
      .bindTooltip(`Resident ${rider.person} · home`)
      .addTo(layer);
  }
  for (const index of stand.works) {
    const rider = fleet.riders[index];
    if (!Number.isFinite(rider.workLat)) continue;
    leaflet.circleMarker([rider.workLat, rider.workLon], {
      radius: 3.4, color: "#ffffff", weight: 1, fillColor: WORK_FILL, fillOpacity: 0.9,
    })
      .bindTooltip(`Resident ${rider.person} · ${fleet.workplace(rider)}`)
      .addTo(layer);
  }
}

interface Journey {
  from: [number, number];
  to: [number, number];
  fromLabel: string;
  toLabel: string;
  fromFill: string;
  toFill: string;
  line: string;
}

function driverJourney(fleet: TaxiFleet, driver: Driver): Journey | null {
  const stand = fleet.standOf(driver.stand);
  if (!stand) return null;
  return {
    from: [driver.lat, driver.lon],
    to: [stand.lat, stand.lon],
    fromLabel: `Resident ${driver.person} · home`,
    toLabel: stand.id,
    fromFill: DRIVER_FILL,
    toFill: standColor(stand.index),
    line: standColor(stand.index),
  };
}

function riderJourney(fleet: TaxiFleet, rider: Rider): Journey | null {
  if (!Number.isFinite(rider.lat) || !Number.isFinite(rider.workLat)) return null;
  return {
    from: [rider.lat, rider.lon],
    to: [rider.workLat, rider.workLon],
    fromLabel: `Resident ${rider.person} · home`,
    toLabel: fleet.workplace(rider),
    fromFill: HOME_FILL,
    toFill: WORK_FILL,
    line: WORK_FILL,
  };
}

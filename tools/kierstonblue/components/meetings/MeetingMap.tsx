"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import { clock } from "@/lib/day-timeline";
import { metresBetween } from "@/lib/meetings";
import type { DayMovementLeg } from "@/lib/server/day";

/**
 * Everybody's journey to one table, on one map.
 *
 * The day page draws a single person and can afford to colour their routes by
 * travel mode. Here colour has a more urgent job: six lines converging on one
 * point are unreadable unless each belongs visibly to somebody, so a route
 * takes its attendee's hue and the mode is left to the tooltip.
 *
 * Two coats of paint on the same lines. Trips in the window around the
 * gathering — the journeys to it and away from it — are drawn at full strength;
 * the rest of each person's day is drawn faint underneath, because the
 * commute that put somebody on the far side of town at six is the reason their
 * approach looks the way it does, and hiding it makes the map a lie by
 * omission.
 *
 * People who travel together defeat all of that. A household outing is seven
 * riders in one car over one identical polyline, so six of the seven colours
 * are painted over and the map claims a party of two. Both remedies below are
 * about that: a shared journey is drawn once, neutral, and says in its tooltip
 * who was in the car, and cursor markers that land on top of each other are
 * fanned onto a small ring so a crowd reads as a crowd.
 */

/** A leg shared by more than one person is nobody's colour. */
const SHARED = "#334155";

/** How near two people must be, in metres, before their markers are fanned. */
const TOGETHER_METRES = 30;

/** Radius of the fan, in screen pixels, so it holds at every zoom. */
const FAN_PIXELS = 11;

const HOME_VIEW: [number, number] = [40.602989, -75.472188];

/** One person's day, ready to draw. */
export interface MapParty {
  person: number;
  name: string;
  color: string;
  legs: DayMovementLeg[];
  /** Where they are at the cursor, or null when nothing places them. */
  position: { lat: number; lon: number; moving: boolean } | null;
  /** True while they are at the table at the cursor minute. */
  seated: boolean;
}

export function MeetingMap({ parties, venue, window: focus, fitToken, onSelect }: {
  parties: MapParty[];
  venue: { lat: number; lon: number; label: string };
  /** The minutes counted as "to and from" — everything else is drawn faint. */
  window: { start: number; end: number };
  fitToken: number;
  onSelect: (person: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const cursorLayerRef = useRef<L.LayerGroup | null>(null);
  const readyRef = useRef(false);
  const cleanupCursorsRef = useRef<(() => void) | null>(null);

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

    // One polyline per *journey*, not per person: riders in the same car carry
    // byte-identical geometry, and drawing it seven times only hides six of it.
    const journeys = new Map<string, { path: [number, number][]; leg: DayMovementLeg; riders: MapParty[] }>();
    for (const party of parties) {
      for (const leg of party.legs) {
        const path: [number, number][] = leg.path.length
          ? leg.path
          : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
        const key = `${leg.depart}:${leg.arrive}:${path.length}:`
          + path.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(";");
        const journey = journeys.get(key);
        if (journey) journey.riders.push(party);
        else journeys.set(key, { path, leg, riders: [party] });
      }
    }

    for (const { path, leg, riders } of journeys.values()) {
      const near = leg.arrive >= focus.start && leg.depart <= focus.end;
      const shared = riders.length > 1;
      const who = shared
        ? `${riders.length} shared · ${riders.map((one) => one.name).join(", ")}`
        : riders[0]!.name;
      const line = leaflet.polyline(path, {
        color: shared ? SHARED : riders[0]!.color,
        weight: near ? (shared ? 5.5 : 4.5) : 2,
        opacity: near ? 0.95 : 0.28,
      })
        .bindTooltip(`${who} · ${clock(leg.depart)}–${clock(leg.arrive)} · ${leg.mode} · `
          + `${leg.from.label ?? "origin"} → ${leg.to.label ?? "destination"}`)
        .addTo(layer);
      // A shared line belongs to nobody, so clicking it must not claim to
      // follow one of them.
      if (!shared) line.on("click", () => onSelect(riders[0]!.person));
    }

    // The venue last, so it sits above every line that runs into it.
    leaflet.circleMarker([venue.lat, venue.lon], {
      radius: 11, color: "#ffffff", weight: 3, fillColor: "#111827", fillOpacity: 0.9,
    }).bindTooltip(venue.label).addTo(layer);
  }), [parties, venue, focus, onSelect]);

  // The markers move every frame of a scrub, so they get their own layer and
  // their own effect — a drag redraws a dozen discs, not a dozen routes.
  useEffect(() => {
    const stop = whenReady(() => {
      const leaflet = leafletRef.current!;
      const map = mapRef.current!;
      const layer = cursorLayerRef.current!;

      const draw = () => {
        layer.clearLayers();

        // Gather everybody standing in the same spot, then fan the spot open.
        // Anything closer than a doorway apart is one disc on screen otherwise.
        const clusters: { lat: number; lon: number; members: MapParty[] }[] = [];
        for (const party of parties) {
          if (!party.position) continue;
          const near = clusters.find((cluster) => metresBetween(cluster, party.position!) < TOGETHER_METRES);
          if (near) near.members.push(party);
          else clusters.push({ lat: party.position.lat, lon: party.position.lon, members: [party] });
        }

        for (const cluster of clusters) {
          const fanned = cluster.members.length > 1;
          cluster.members.forEach((party, at) => {
            const position = party.position!;
            let point: L.LatLngExpression = [position.lat, position.lon];
            if (fanned) {
              // Offset in screen pixels, not degrees, so the ring keeps its size
              // as the map zooms — which is why this redraws on zoomend.
              const angle = (at / cluster.members.length) * 2 * Math.PI - Math.PI / 2;
              const centre = map.latLngToLayerPoint(point);
              point = map.layerPointToLatLng(centre.add(
                leaflet.point(Math.cos(angle) * FAN_PIXELS, Math.sin(angle) * FAN_PIXELS),
              ));
            }
            if (position.moving) {
              leaflet.circleMarker(point, {
                radius: 12, weight: 0, fillColor: party.color, fillOpacity: 0.28, interactive: false,
              }).addTo(layer);
            }
            leaflet.circleMarker(point, {
              radius: position.moving ? 7 : 5.5,
              color: party.seated ? "#111827" : "#ffffff",
              weight: 2.5,
              fillColor: party.color,
              fillOpacity: 1,
            })
              .bindTooltip(`${party.name}${party.seated ? " · present" : position.moving ? " · travelling" : ""}`
                + (fanned ? ` · +${cluster.members.length - 1}` : ""))
              .on("click", () => onSelect(party.person))
              .addTo(layer);
          });
        }
      };

      draw();
      map.on("zoomend", draw);
      cleanupCursorsRef.current = () => map.off("zoomend", draw);
    });
    // The zoom listener outlives the effect body it was registered in, so a
    // redraw or an unmount has to take it back off.
    return () => { stop(); cleanupCursorsRef.current?.(); cleanupCursorsRef.current = null; };
  }, [parties, onSelect]);

  // Framing is deliberate: scrubbing must never move the viewport, or the
  // markers everybody is watching slide out from under the pointer.
  useEffect(() => whenReady(() => {
    const leaflet = leafletRef.current!;
    const map = mapRef.current!;
    const points: [number, number][] = [[venue.lat, venue.lon]];
    for (const party of parties) {
      for (const leg of party.legs) {
        if (leg.arrive < focus.start || leg.depart > focus.end) continue;
        points.push([leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]);
      }
    }
    if (points.length > 1) map.fitBounds(leaflet.latLngBounds(points), { padding: [30, 30] });
    else map.setView([venue.lat, venue.lon], 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fitToken]);

  return (
    <div className="grid gap-2">
      <div ref={containerRef} className="h-[30rem] min-h-[18rem] w-full overflow-hidden rounded-[var(--radius)] border border-border" />
    </div>
  );
}

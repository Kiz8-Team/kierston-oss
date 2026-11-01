"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusText } from "@/components/browse/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCenter } from "@/lib/datasets";
import { metres, num } from "@/lib/format";
import {
  ENDPOINTS, MAP_PANEL, MAP_SHELL, MAP_SURFACE, PANEL_ACTIONS, PANEL_SCROLL, PANEL_STATS, ROUTE_FIELD, ROUTE_FIELD_PIN, ROUTE_PIN, STEPS,
  STEP_BUTTON, STEP_DISTANCE, STEP_GLYPH,
} from "@/components/map/panel";

/**
 * Car routes over the Kierston road graph.
 *
 * The search itself belongs to the Bun service in kierston/pathfinder, which
 * holds the graph and the address index; this page is its front end, talking
 * to it through /api/pathfinder so there is only ever one origin in play.
 */

/* Leaflet draws to canvas, so it cannot read the CSS custom properties. These
   mirror --primary, --muted-foreground and --pin-hover in globals.css. */
const ROUTE_LINE = "#1667d8";
const SNAP_LINE = "#5d6b78";
const PIN_HOVER = "#f5691f";

const GLYPH: Record<string, string> = {
  depart: "▲", arrive: "◉", straight: "↑",
  "slight left": "↖", "slight right": "↗",
  left: "←", right: "→",
  "sharp left": "↰", "sharp right": "↱",
  "u-turn": "↺",
};

interface Endpoint {
  lat: number;
  lon: number;
  label: string;
  source: string;
  snapped: { lat: number; lon: number; metersAway: number };
}

interface Step {
  instruction: string;
  maneuver: string;
  distanceMeters: number;
  lat: number;
  lon: number;
}

interface Plan {
  from: Endpoint;
  to: Endpoint;
  geometry: [number, number][];
  steps: Step[];
  readable: { distance: string; duration: string };
  stats: { searchMs: number; settledNodes: number; totalMs: number };
}

type Role = "from" | "to";

export function RouteWorkspace() {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const snapLayerRef = useRef<L.LayerGroup | null>(null);
  const hoverLayerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Partial<Record<Role, L.Marker>>>({});
  const coordsRef = useRef<Partial<Record<Role, { lat: number; lon: number }>>>({});
  const pickingRef = useRef<Role | null>(null);

  const [inputs, setInputs] = useState<Record<Role, string>>({ from: "", to: "" });
  const [picking, setPicking] = useState<Role | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(0);

  const say = (message: string, next: "idle" | "busy" | "error" = "idle") => {
    setStatus(message);
    setState(next);
  };

  // ---- Waypoints ------------------------------------------------------------

  const describe = useCallback(async (role: Role, lat: number, lon: number) => {
    setInputs((current) => ({ ...current, [role]: `${lat.toFixed(5)}, ${lon.toFixed(5)}` }));
    try {
      const response = await fetch(`/api/pathfinder/describe?lat=${lat}&lon=${lon}`);
      const data = await response.json();
      if (data.place) setInputs((current) => ({ ...current, [role]: data.place.label }));
    } catch {
      // The coordinates are already in the box, which is enough to route.
    }
  }, []);

  const placeMarker = useCallback((role: Role, lat: number, lon: number) => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    if (!leaflet || !map) return;
    coordsRef.current[role] = { lat, lon };
    const existing = markersRef.current[role];
    if (existing) {
      existing.setLatLng([lat, lon]);
      return;
    }
    const marker = leaflet.marker([lat, lon], {
      icon: leaflet.divIcon({
        className: "",
        html: `<div class="${ROUTE_PIN}" style="background:${role === "from" ? "var(--pin-a)" : "var(--pin-b)"}">`
          + `${role === "from" ? "A" : "B"}</div>`,
        iconSize: [0, 0],
      }),
      draggable: true,
      zIndexOffset: 1000,
    }).addTo(map);
    marker.on("dragend", async () => {
      const position = marker.getLatLng();
      coordsRef.current[role] = { lat: position.lat, lon: position.lng };
      await describe(role, position.lat, position.lng);
      void findRoute();
    });
    markersRef.current[role] = marker;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describe]);

  // ---- Routing --------------------------------------------------------------

  const clearResult = useCallback(() => {
    routeLayerRef.current?.clearLayers();
    snapLayerRef.current?.clearLayers();
    hoverLayerRef.current?.clearLayers();
    setPlan(null);
  }, []);

  const drawRoute = useCallback((data: Plan) => {
    const leaflet = leafletRef.current;
    const routeLayer = routeLayerRef.current;
    const snapLayer = snapLayerRef.current;
    if (!leaflet || !routeLayer || !snapLayer) return;
    routeLayer.clearLayers();
    snapLayer.clearLayers();
    leaflet.polyline(data.geometry, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(routeLayer);
    leaflet.polyline(data.geometry, { color: ROUTE_LINE, weight: 5, opacity: 0.95 }).addTo(routeLayer);

    // The dashed stubs show how far each end had to be pulled to the road.
    for (const end of [data.from, data.to]) {
      leaflet.polyline([[end.lat, end.lon], [end.snapped.lat, end.snapped.lon]], {
        color: SNAP_LINE, weight: 1.5, opacity: 0.8, dashArray: "3 4",
      }).addTo(snapLayer);
      leaflet.circleMarker([end.snapped.lat, end.snapped.lon], {
        radius: 3.5, color: ROUTE_LINE, weight: 1.5, fillColor: "#fff", fillOpacity: 1,
      }).addTo(snapLayer);
    }
  }, []);

  const findRoute = useCallback(async () => {
    // A pin is exact; a typed address is not, so the pin wins when both exist.
    const queryFor = (role: Role) => {
      const pin = coordsRef.current[role];
      if (pin) return `${pin.lat},${pin.lon}`;
      return (role === "from" ? inputsRef.current.from : inputsRef.current.to).trim();
    };
    const from = queryFor("from");
    const to = queryFor("to");
    if (!from || !to) {
      say("Missing waypoint");
      return;
    }

    const ticket = ++inFlight.current;
    say("Routing…", "busy");
    try {
      const url = `/api/pathfinder/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const response = await fetch(url);
      const data = await response.json();
      if (ticket !== inFlight.current) return;
      if (!response.ok) {
        clearResult();
        say(data.hint ? `${data.error} ${data.hint}` : data.error ?? `HTTP ${response.status}`, "error");
        return;
      }

      setPlan(data);
      drawRoute(data);
      say(`${data.steps.length - 1} steps · ${Math.round(data.stats.totalMs)} ms`);

      // Re-pin both ends where the service resolved them, so a typed address
      // shows up on the map too.
      placeMarker("from", data.from.lat, data.from.lon);
      placeMarker("to", data.to.lat, data.to.lon);
      const map = mapRef.current;
      const leaflet = leafletRef.current;
      if (map && leaflet) {
        map.fitBounds(leaflet.latLngBounds(data.geometry), {
          paddingTopLeft: [40, 40], paddingBottomRight: [360, 40],
        });
      }
    } catch (error) {
      if (ticket !== inFlight.current) return;
      say(`Routing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, [clearResult, drawRoute, placeMarker]);

  // The map's click handler is installed once, so it reads the current inputs
  // through a ref rather than closing over a stale render.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const routeRef = useRef(findRoute);
  routeRef.current = findRoute;
  const placeRef = useRef(placeMarker);
  placeRef.current = placeMarker;
  const describeRef = useRef(describe);
  describeRef.current = describe;

  // ---- The map --------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;

    (async () => {
      const [leaflet, center] = await Promise.all([
        import("leaflet").then((module) => module.default), getCenter(),
      ]);
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;
      map = leaflet.map(containerRef.current, { zoomControl: true }).setView(center, 14);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      routeLayerRef.current = leaflet.layerGroup().addTo(map);
      snapLayerRef.current = leaflet.layerGroup().addTo(map);
      hoverLayerRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;

      map.on("click", async (event: L.LeafletMouseEvent) => {
        const role: Role = pickingRef.current ?? (!coordsRef.current.from ? "from" : "to");
        placeRef.current(role, event.latlng.lat, event.latlng.lng);
        if (pickingRef.current) {
          pickingRef.current = null;
          setPicking(null);
          map?.getContainer().style.setProperty("cursor", "");
        }
        await describeRef.current(role, event.latlng.lat, event.latlng.lng);
        if (coordsRef.current.from && coordsRef.current.to) void routeRef.current();
      });

      try {
        const response = await fetch("/api/pathfinder/health");
        const health = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(health.hint ?? health.error);
        setReady(true);
        say(`${num(health.routableNodes)} routable nodes · ${num(health.addresses)} addresses`);
      } catch (error) {
        if (!cancelled) {
          say(error instanceof Error ? error.message
            : "No pathfinder service · kierston/pathfinder: bun run serve", "error");
        }
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  const highlight = (step: Step | null) => {
    const leaflet = leafletRef.current;
    const layer = hoverLayerRef.current;
    if (!leaflet || !layer) return;
    layer.clearLayers();
    if (!step) return;
    leaflet.circleMarker([step.lat, step.lon], {
      radius: 6, color: PIN_HOVER, weight: 2, fillColor: "#fff", fillOpacity: 1,
    }).addTo(layer);
  };

  const swap = () => {
    setInputs((current) => ({ from: current.to, to: current.from }));
    const { from, to } = coordsRef.current;
    coordsRef.current = { from: to, to: from };
    for (const role of ["from", "to"] as Role[]) {
      const coords = coordsRef.current[role];
      if (coords) placeMarker(role, coords.lat, coords.lon);
      else if (markersRef.current[role]) {
        mapRef.current?.removeLayer(markersRef.current[role] as L.Marker);
        delete markersRef.current[role];
      }
    }
    setTimeout(() => void findRoute(), 0);
  };

  const clearAll = () => {
    setInputs({ from: "", to: "" });
    coordsRef.current = {};
    for (const role of ["from", "to"] as Role[]) {
      const marker = markersRef.current[role];
      if (marker) mapRef.current?.removeLayer(marker);
      delete markersRef.current[role];
    }
    clearResult();
    say("Cleared");
  };

  const togglePicking = (role: Role) => {
    const next = pickingRef.current === role ? null : role;
    pickingRef.current = next;
    setPicking(next);
    mapRef.current?.getContainer().style.setProperty("cursor", next ? "crosshair" : "");
  };

  return (
    <div className={MAP_SHELL}>
      <div className={MAP_SURFACE} ref={containerRef} />
      <section className={MAP_PANEL}>
        <header>
          <h1>Route pathfinder</h1>
        </header>
        <div className={PANEL_SCROLL}>
          <fieldset>
            <legend>Waypoints</legend>
            {(["from", "to"] as Role[]).map((role) => (
              <div className={ROUTE_FIELD} key={role}>
                <span
                  className={ROUTE_FIELD_PIN}
                  style={{ background: role === "from" ? "var(--pin-a)" : "var(--pin-b)" }}
                >
                  {role === "from" ? "A" : "B"}
                </span>
                <Input
                  placeholder={role === "from" ? "Start address or lat, lon" : "Destination address or lat, lon"}
                  value={inputs[role]}
                  autoComplete="off"
                  onChange={(event) => {
                    // Typing replaces a pinned coordinate: the text is now the intent.
                    delete coordsRef.current[role];
                    setInputs((current) => ({ ...current, [role]: event.target.value }));
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") void findRoute(); }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="px-2"
                  data-active={picking === role}
                  onClick={() => togglePicking(role)}
                >
                  Pick
                </Button>
              </div>
            ))}
            <div className={PANEL_ACTIONS}>
              <Button type="button" size="xs" disabled={!ready} onClick={() => void findRoute()}>
                Find route
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={swap}>
                Swap
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={clearAll}>
                Clear
              </Button>
            </div>
            {/* Routing is asynchronous and the outcome is only ever text, so
                the line has to announce itself. */}
            <p role={state === "error" ? "alert" : "status"}>
              <StatusText state={state === "error" ? "error" : state === "busy" ? "busy" : undefined}>
                {status}
              </StatusText>
            </p>
          </fieldset>

          {plan ? (
            <fieldset>
              <legend>Result</legend>
              <dl className={PANEL_STATS}>
                <div><dt>Distance</dt><dd>{plan.readable.distance}</dd></div>
                <div><dt>Drive time</dt><dd>{plan.readable.duration}</dd></div>
                <div><dt>Search</dt><dd>{plan.stats.searchMs} ms</dd></div>
                <div><dt>Settled</dt><dd>{num(plan.stats.settledNodes)}</dd></div>
              </dl>
              <div className={ENDPOINTS}>
                {([["A", plan.from], ["B", plan.to]] as const).map(([label, end]) => (
                  <div key={label}>
                    <b>{label} {end.label}</b> — {end.source} · {Math.round(end.snapped.metersAway)} m
                    snap
                  </div>
                ))}
              </div>
              <ol className={STEPS}>
                {plan.steps.map((step, index) => (
                  <li key={index}>
                    {/* A real button, so the step can be reached by Tab and
                        fired by Enter, and so focus highlights it on the map
                        the same way hovering does. */}
                    <button
                      type="button"
                      className={STEP_BUTTON}
                      onMouseEnter={() => highlight(step)}
                      onMouseLeave={() => highlight(null)}
                      onFocus={() => highlight(step)}
                      onBlur={() => highlight(null)}
                      onClick={() => {
                        const map = mapRef.current;
                        map?.setView([step.lat, step.lon], Math.max(map.getZoom(), 17));
                      }}
                    >
                      <span className={STEP_GLYPH} aria-hidden>{GLYPH[step.maneuver] ?? "•"}</span>
                      <span>{step.instruction}</span>
                      <span className={STEP_DISTANCE}>
                        {step.distanceMeters ? metres(step.distanceMeters) : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </fieldset>
          ) : null}
        </div>
      </section>
    </div>
  );
}

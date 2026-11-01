"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import { MAP_SURFACE } from "@/components/map/panel";
import { AREA_LABEL } from "@/components/network/style";
import { metres, num } from "@/lib/format";
import {
  areaKey, cellColor, showsCell, type NetworkView, type Selection,
} from "@/lib/network-view";
import {
  SOURCE_COLOR, cellLabel, sectorWedge, structureLabel, type Network,
} from "@/lib/towers";

/**
 * The network on the map: structures, the wedge each sector claims, the reach
 * of each mast, and the tracking areas the whole thing is partitioned into.
 *
 * Four layers in four panes, because the drawing order is the reading order —
 * a tracking area is the ground the sectors sit on, a range ring belongs over
 * the sectors it bounds, and a structure has to stay clickable under whatever
 * is drawn across it. Panes rather than layer groups on one canvas: a group
 * that is cleared and refilled goes to the end of its renderer's draw list, so
 * a filter change would silently reorder the map.
 *
 * Everything is canvas. 2,694 wedges as SVG paths is a map that cannot be
 * panned, and each of them is a flat fill with no state of its own — which is
 * exactly the case canvas is for.
 */

const CENTRE_ZOOM = 13;

export interface Focus {
  lat: number;
  lon: number;
  zoom?: number;
  /** Bumped by the caller so that asking for the same place twice still moves. */
  nonce: number;
}

interface Panes {
  hulls: L.Canvas;
  sectors: L.Canvas;
  rings: L.Canvas;
  sites: L.Canvas;
}

export function TowerMap({
  network, view, selection, onSelect, focus,
}: {
  network: Network | null;
  view: NetworkView;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  focus: Focus | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const paneRef = useRef<Panes | null>(null);
  const layersRef = useRef<L.LayerGroup[]>([]);
  const highlightRef = useRef<L.LayerGroup | null>(null);
  const labelRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  // The callback changes on every parent render; the draw effect must not.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // ---- The map itself -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let map: L.Map | null = null;

    (async () => {
      const leaflet = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;

      map = leaflet.map(containerRef.current, {
        zoomControl: false,
        preferCanvas: true,
      }).setView([40.602989, -75.472188], CENTRE_ZOOM);
      leaflet.control.zoom({ position: "topleft" }).addTo(map);
      leaflet.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      const canvas = (name: string, z: number) => {
        map!.createPane(name).style.zIndex = String(z);
        return leaflet.canvas({ pane: name, padding: 0.3 });
      };
      paneRef.current = {
        hulls: canvas("towers-hulls", 401),
        sectors: canvas("towers-sectors", 402),
        rings: canvas("towers-rings", 403),
        sites: canvas("towers-sites", 404),
      };
      map.createPane("towers-labels").style.zIndex = "405";
      // Captions must not eat a click meant for the structure underneath them.
      map.getPane("towers-labels")!.style.pointerEvents = "none";

      layersRef.current = [
        leaflet.layerGroup().addTo(map),
        leaflet.layerGroup().addTo(map),
        leaflet.layerGroup().addTo(map),
        leaflet.layerGroup().addTo(map),
      ];
      labelRef.current = leaflet.layerGroup().addTo(map);
      highlightRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;

      // A click on the sea of tiles means "nothing", which is the only way to
      // put the panel back to the whole network without hunting for a button.
      map.on("click", () => selectRef.current(null));
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      paneRef.current = null;
      layersRef.current = [];
      highlightRef.current = null;
      labelRef.current = null;
    };
  }, []);

  // ---- The network ----------------------------------------------------------

  useEffect(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const panes = paneRef.current;
    const [hullLayer, sectorLayer, ringLayer, siteLayer] = layersRef.current;
    const labels = labelRef.current;
    if (!leaflet || !map || !panes || !siteLayer || !labels) return;

    for (const layer of layersRef.current) layer.clearLayers();
    labels.clearLayers();
    if (!network) return;

    // Tracking areas, under everything: they are the ground, not a feature.
    if (view.hulls) {
      for (const area of network.areas) {
        const key = areaKey(area.operator, area.tac);
        if (!view.areas.has(key) || area.hull.length < 3) continue;
        leaflet.polygon(area.hull, {
          renderer: panes.hulls,
          color: area.color,
          weight: 1.6,
          opacity: 0.9,
          dashArray: "6 4",
          fillColor: area.color,
          fillOpacity: 0.05,
        })
          .on("click", (event) => {
            leaflet.DomEvent.stop(event);
            selectRef.current({ kind: "area", key });
          })
          .bindTooltip(
            `${area.operatorLabel} · TAC ${area.tac}<br>${num(area.cells)} cells `
            + `on ${num(area.sites)} structures`,
            { sticky: true },
          )
          .addTo(hullLayer);

        if (view.labels) {
          leaflet.marker(area.centre, {
            pane: "towers-labels",
            interactive: false,
            icon: leaflet.divIcon({
              className: "",
              html: `<div class="${AREA_LABEL}">TAC ${area.tac}<br>${area.operatorLabel}</div>`,
              iconSize: [0, 0],
            }),
          }).addTo(labels);
        }
      }
    }

    // The sectors, and the reach of each mast that still has one.
    for (const site of network.sites) {
      if (!view.sources.has(site.source)) continue;
      let shown = 0;
      let reach = 0;
      const tenants = new Set<string>();

      for (const index of site.cells) {
        const cell = network.cells[index];
        if (!showsCell(view, cell, site)) continue;
        shown += 1;
        reach = Math.max(reach, cell.range_m);
        tenants.add(cell.operator_key);

        if (!view.sectors) continue;
        const color = cellColor(network, view, cell);
        leaflet.polygon(sectorWedge(cell), {
          renderer: panes.sectors,
          color,
          weight: 0.6,
          opacity: 0.55,
          fillColor: color,
          fillOpacity: view.opacity,
        })
          .on("click", (event) => {
            leaflet.DomEvent.stop(event);
            selectRef.current({ kind: "cell", index: cell.index });
          })
          .bindTooltip(
            `${cellLabel(cell)}<br>${cell.radio} · ${cell.frequency_mhz} MHz · `
            + `${Math.round(cell.azimuth)}° · ${metres(cell.range_m)}<br>${cell.cgi}`,
            { sticky: true },
          )
          .addTo(sectorLayer);
      }

      if (!shown) continue;

      if (view.rings && reach > 0) {
        leaflet.circle([site.lat, site.lon], {
          renderer: panes.rings,
          radius: reach,
          color: SOURCE_COLOR[site.source],
          weight: 1,
          opacity: 0.5,
          dashArray: "3 4",
          fill: false,
          interactive: false,
        }).addTo(ringLayer);
      }

      if (view.sites) {
        leaflet.circleMarker([site.lat, site.lon], {
          renderer: panes.sites,
          radius: Math.min(9, 3 + Math.sqrt(shown) * 0.9),
          color: "#ffffff",
          weight: 1.4,
          fillColor: SOURCE_COLOR[site.source],
          fillOpacity: 0.95,
        })
          .on("click", (event) => {
            leaflet.DomEvent.stop(event);
            selectRef.current({ kind: "site", index: site.index });
          })
          .bindTooltip(
            `${structureLabel(site)}${site.height_m ? ` · ${site.height_m} m` : ""}<br>`
            + `${num(shown)} cells · ${[...tenants]
              .map((key) => network.operator(key)?.label ?? key).join(", ")}`,
            { sticky: true },
          )
          .addTo(siteLayer);
      }
    }

    if (!fittedRef.current && network.sites.length) {
      fittedRef.current = true;
      map.fitBounds(
        leaflet.latLngBounds(network.sites.map((site) => [site.lat, site.lon])),
        { padding: [40, 40] },
      );
    }
  }, [network, view]);

  // ---- What is selected -----------------------------------------------------

  useEffect(() => {
    const leaflet = leafletRef.current;
    const highlight = highlightRef.current;
    if (!leaflet || !highlight) return;
    highlight.clearLayers();
    if (!network || !selection) return;

    if (selection.kind === "area") {
      const [operator, tac] = selection.key.split("/");
      const area = network.area(operator, Number(tac));
      if (!area || area.hull.length < 3) return;
      leaflet.polygon(area.hull, {
        color: area.color, weight: 3, opacity: 1, fill: false, interactive: false,
      }).addTo(highlight);
      return;
    }

    const cells = selection.kind === "site"
      ? network.sites[selection.index].cells.map((index) => network.cells[index])
      : [network.cells[selection.index]];
    const anchor = cells[0];
    if (!anchor) return;

    // The selected structure's own sectors, drawn whatever the filters say:
    // the point of picking a mast is to see everything on it, including the
    // carrier that was switched off two clicks ago.
    for (const cell of cells) {
      const color = cellColor(network, view, cell);
      leaflet.polygon(sectorWedge(cell), {
        color, weight: 1.4, opacity: 1, fillColor: color, fillOpacity: 0.18,
        interactive: false,
      }).addTo(highlight);
    }
    leaflet.circleMarker([anchor.lat, anchor.lon], {
      radius: 7, color: "#20303f", weight: 2.5, fillColor: "#ffffff", fillOpacity: 1,
      interactive: false,
    }).addTo(highlight);
  }, [network, selection, view]);

  // ---- Going somewhere ------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.setView([focus.lat, focus.lon], focus.zoom ?? Math.max(map.getZoom(), 15));
  }, [focus]);

  return <div className={MAP_SURFACE} ref={containerRef} />;
}

"use client";

import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useEffect, useRef } from "react";
import { MAP_SURFACE } from "@/components/map/panel";
import { CAMERA_LABEL } from "@/components/cameras/style";
import { num } from "@/lib/format";
import {
  busiest, cameraColor, showsCamera, type CameraView, type Selection,
} from "@/lib/camera-view";
import {
  MOUNT_LABEL, OWNER_COLOR, ROLE_LABEL, approachLine, cameraLabel, captureZone,
  type CameraFleet,
} from "@/lib/cameras";

const CENTRE_ZOOM = 13;

export interface Focus {
  lat: number;
  lon: number;
  zoom?: number;
  nonce: number;
}

interface Panes {
  approaches: L.Canvas;
  zones: L.Canvas;
  mounts: L.Canvas;
}

export function CameraMap({
  fleet, view, selection, onSelect, focus,
}: {
  fleet: CameraFleet | null;
  view: CameraView;
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
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

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
        approaches: canvas("cameras-approaches", 401),
        zones: canvas("cameras-zones", 402),
        mounts: canvas("cameras-mounts", 403),
      };
      map.createPane("cameras-labels").style.zIndex = "404";
      map.getPane("cameras-labels")!.style.pointerEvents = "none";

      layersRef.current = [
        leaflet.layerGroup().addTo(map),
        leaflet.layerGroup().addTo(map),
        leaflet.layerGroup().addTo(map),
      ];
      labelRef.current = leaflet.layerGroup().addTo(map);
      highlightRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;

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

  useEffect(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const panes = paneRef.current;
    const [approachLayer, zoneLayer, mountLayer] = layersRef.current;
    const labels = labelRef.current;
    if (!leaflet || !map || !panes || !mountLayer || !labels) return;

    for (const layer of layersRef.current) layer.clearLayers();
    labels.clearLayers();
    if (!fleet) return;

    const most = busiest(fleet);

    for (const mount of fleet.mounts) {
      let shown = 0;
      let passes = 0;

      for (const index of mount.cameras) {
        const camera = fleet.cameras[index];
        if (!showsCamera(view, camera)) continue;
        shown += 1;
        passes += camera.daily_passes;
        const color = cameraColor(fleet, view, camera, most);

        if (view.approaches) {
          leaflet.polyline(approachLine(camera), {
            renderer: panes.approaches,
            color,
            weight: 3,
            opacity: 0.5,
            interactive: false,
          }).addTo(approachLayer);
        }

        const optics = fleet.opticsOf(camera);
        if (view.zones && optics) {
          leaflet.polygon(captureZone(camera, optics, view.scale), {
            renderer: panes.zones,
            color,
            weight: 0.8,
            opacity: 0.75,
            fillColor: color,
            fillOpacity: view.opacity,
          })
            .on("click", (event) => {
              leaflet.DomEvent.stop(event);
              selectRef.current({ kind: "camera", index: camera.index });
            })
            .bindTooltip(
              `<b>${camera.id}</b> · ${ROLE_LABEL[camera.role]}<br>`
              + `${cameraLabel(camera)}<br>`
              + `${Math.round(camera.azimuth)}° · ${num(camera.daily_passes)} vehicles/day`
              + (camera.zone_seconds ? ` · ${camera.zone_seconds.toFixed(1)} s in zone` : ""),
              { sticky: true },
            )
            .addTo(zoneLayer);
        }
      }

      if (!shown) continue;

      if (view.mounts) {
        leaflet.circleMarker([mount.lat, mount.lon], {
          renderer: panes.mounts,
          radius: 3.2 + (shown - 1) * 1.6,
          color: "#ffffff",
          weight: 1.4,
          fillColor: OWNER_COLOR[mount.owner_kind],
          fillOpacity: 0.95,
        })
          .on("click", (event) => {
            leaflet.DomEvent.stop(event);
            selectRef.current({ kind: "mount", index: mount.index });
          })
          .bindTooltip(
            `<b>${mount.id}</b> · ${MOUNT_LABEL[mount.kind]} at ${mount.height_m} m<br>`
            + `${mount.owner}<br>`
            + `${shown} camera${shown === 1 ? "" : "s"} · ${num(passes)} vehicles/day`,
            { sticky: true },
          )
          .addTo(mountLayer);
      }

      if (view.labels) {
        const camera = fleet.cameras[mount.cameras[0]];
        leaflet.marker([mount.lat, mount.lon], {
          pane: "cameras-labels",
          interactive: false,
          icon: leaflet.divIcon({
            className: "",
            html: `<div class="${CAMERA_LABEL}">${mount.cameras.length > 1
              ? `${mount.id} · ${mount.cameras.length} lenses`
              : camera.id}</div>`,
            iconSize: [0, 0],
          }),
        }).addTo(labels);
      }
    }

    if (!fittedRef.current && fleet.mounts.length) {
      fittedRef.current = true;
      map.fitBounds(
        leaflet.latLngBounds(fleet.mounts.map((mount) => [mount.lat, mount.lon])),
        { padding: [40, 40] },
      );
    }
  }, [fleet, view]);

  useEffect(() => {
    const leaflet = leafletRef.current;
    const highlight = highlightRef.current;
    if (!leaflet || !highlight) return;
    highlight.clearLayers();
    if (!fleet || !selection) return;

    const most = busiest(fleet);
    const cameras = selection.kind === "mount"
      ? fleet.mounts[selection.index].cameras.map((index) => fleet.cameras[index])
      : [fleet.cameras[selection.index]];
    const anchor = cameras[0];
    if (!anchor) return;

    for (const camera of cameras) {
      const color = cameraColor(fleet, view, camera, most);
      const optics = fleet.opticsOf(camera);
      leaflet.polyline(approachLine(camera), {
        color, weight: 4, opacity: 0.7, interactive: false,
      }).addTo(highlight);
      if (optics) {
        leaflet.polygon(captureZone(camera, optics, view.scale), {
          color, weight: 1.6, opacity: 1, fillColor: color, fillOpacity: 0.4,
          interactive: false,
        }).addTo(highlight);
      }
    }
    leaflet.circleMarker([anchor.lat, anchor.lon], {
      radius: 7, color: "#20303f", weight: 2.5, fillColor: "#ffffff", fillOpacity: 1,
      interactive: false,
    }).addTo(highlight);
  }, [fleet, selection, view]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.setView([focus.lat, focus.lon], focus.zoom ?? Math.max(map.getZoom(), 16));
  }, [focus]);

  return <div className={MAP_SURFACE} ref={containerRef} />;
}

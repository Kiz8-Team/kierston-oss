"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusText } from "@/components/browse/EmptyState";
import { MAP_PANEL, MAP_SHELL, PANEL_NOTE, PANEL_SCROLL } from "@/components/map/panel";
import {
  CameraListSection, CoverageSection, DrawSection, FilterSection, SelectedSection,
  type SortBy,
} from "@/components/cameras/CameraPanel";
import { CameraMap, type Focus } from "@/components/cameras/CameraMap";
import { useCameras } from "@/components/useCameras";
import { num, percent } from "@/lib/format";
import { countView, fullView, type CameraView, type Selection } from "@/lib/camera-view";
import type { CameraFleet, OwnerKind, Role } from "@/lib/cameras";

export function CameraWorkspace() {
  const { fleet, error } = useCameras();
  const [view, setView] = useState<CameraView | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("order");

  const live: CameraView | null = useMemo(
    () => (fleet ? view ?? fullView(fleet) : null),
    [fleet, view],
  );

  const patch = useCallback((next: Partial<CameraView>) => {
    setView((current) => ({ ...(current ?? fullView(fleet!)), ...next }));
  }, [fleet]);

  const go = useCallback((lat: number, lon: number, zoom?: number) => {
    setFocus((current) => ({ lat, lon, zoom, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const counts = useMemo(
    () => (fleet && live ? countView(fleet, live) : { cameras: 0, mounts: 0, passes: 0 }),
    [fleet, live],
  );
  const facets = useMemo(
    () => (fleet && live ? facetCounts(fleet, live) : null),
    [fleet, live],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selection) scrollRef.current?.scrollTo({ top: 0 });
  }, [selection]);

  const select = useCallback((next: Selection | null) => {
    setSelection(next);
    if (!next || !fleet) return;
    const camera = next.kind === "camera"
      ? fleet.cameras[next.index]
      : fleet.cameras[fleet.mounts[next.index].cameras[0]];
    if (camera) go(camera.lat, camera.lon);
  }, [fleet, go]);

  return (
    <div className={MAP_SHELL}>
      <CameraMap
        fleet={fleet}
        view={live ?? EMPTY_VIEW}
        selection={selection}
        onSelect={setSelection}
        focus={focus}
      />

      <section className={MAP_PANEL}>
        <header>
          <h1>Plate readers</h1>
          <p>
            {error
              ? <StatusText state="error">{error}</StatusText>
              : fleet
                ? `${num(fleet.cameras.length)} cameras · ${num(fleet.mounts.length)} mounts · `
                  + `${percent(fleet.reach, 1)} driver coverage`
                : "Loading…"}
          </p>
        </header>
        <div className={PANEL_SCROLL} ref={scrollRef}>
          {!fleet || !live || !facets ? (
            <p className={PANEL_NOTE} data-state={error ? "error" : undefined}>
              {error
                ? <code>python kierston/init/surveillance/cameras.py</code>
                : "Loading cameras.json…"}
            </p>
          ) : (
            <>
              {selection ? (
                <SelectedSection
                  fleet={fleet}
                  view={live}
                  selection={selection}
                  onSelect={select}
                  onGo={go}
                />
              ) : null}
              <CameraListSection
                fleet={fleet}
                view={live}
                query={query}
                onQuery={setQuery}
                sortBy={sortBy}
                onSort={setSortBy}
                selection={selection}
                onSelect={select}
              />
              <DrawSection fleet={fleet} view={live} patch={patch} counts={counts} />
              <FilterSection fleet={fleet} view={live} patch={patch} facets={facets} />
              <CoverageSection fleet={fleet} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

const EMPTY_VIEW: CameraView = {
  roles: new Set(),
  owners: new Set(),
  classes: new Set(),
  mounts: false,
  zones: false,
  approaches: false,
  labels: false,
  scale: 8,
  colorBy: "role",
  opacity: 0.45,
};

interface Facets {
  roles: Map<Role, number>;
  owners: Map<OwnerKind, number>;
  classes: Map<string, number>;
}

function facetCounts(fleet: CameraFleet, view: CameraView): Facets {
  const facets: Facets = { roles: new Map(), owners: new Map(), classes: new Map() };
  const bump = <T,>(map: Map<T, number>, key: T) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const camera of fleet.cameras) {
    const role = view.roles.has(camera.role);
    const owner = view.owners.has(camera.owner_kind);
    const roadClass = view.classes.has(camera.class);

    if (owner && roadClass) bump(facets.roles, camera.role);
    if (role && roadClass) bump(facets.owners, camera.owner_kind);
    if (role && owner) bump(facets.classes, camera.class);
  }

  return facets;
}

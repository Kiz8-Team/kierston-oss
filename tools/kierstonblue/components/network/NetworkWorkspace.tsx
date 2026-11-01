"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusText } from "@/components/browse/EmptyState";
import { MAP_PANEL, MAP_SHELL, PANEL_NOTE, PANEL_SCROLL } from "@/components/map/panel";
import {
  AreaSection, BandSection, DrawSection, FindSection, OperatorSection, RoleSection,
  SelectedSection, StructureSection,
} from "@/components/network/NetworkPanel";
import { TowerMap, type Focus } from "@/components/network/TowerMap";
import { useTowers } from "@/components/useTowers";
import { num } from "@/lib/format";
import {
  areaKey, countView, fullView, type NetworkView, type Selection,
} from "@/lib/network-view";
import type { CellRole, Network } from "@/lib/towers";

/**
 * The cell network, on the map.
 *
 * Eighty-seven structures and 2,694 cells, which is few enough to hold in one
 * view and far too many to draw all of at once — so the page opens on the two
 * layers that survive being seen whole, the structures and the twelve tracking
 * areas, and the sector footprints come on after a filter has narrowed to a
 * carrier or a band. The panel's counts say what is currently selected against
 * what exists, so switching a layer off never quietly loses anything.
 *
 * Filters that dim rather than delete
 * -----------------------------------
 * Opening a structure lists and draws every cell on it whichever carriers are
 * filtered out, with the hidden ones dimmed. Colocation is the fact this file
 * exists to carry — three operators on one pole with unrelated identifiers —
 * and a filter that hid the other two at exactly the moment a reader clicked
 * the mast would hide the point of clicking it.
 */
export function NetworkWorkspace() {
  const { network, error } = useTowers();
  const [view, setView] = useState<NetworkView | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [query, setQuery] = useState("");

  // The view is built from the network — every band, area and carrier in the
  // file starts switched on — so it cannot exist before the file lands.
  const live: NetworkView | null = useMemo(
    () => (network ? view ?? fullView(network) : null),
    [network, view],
  );

  const patch = useCallback((next: Partial<NetworkView>) => {
    setView((current) => ({ ...(current ?? fullView(network!)), ...next }));
  }, [network]);

  const go = useCallback((lat: number, lon: number, zoom?: number) => {
    setFocus((current) => ({ lat, lon, zoom, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const counts = useMemo(
    () => (network && live ? countView(network, live) : { cells: 0, sites: 0, colocated: 0 }),
    [network, live],
  );
  const facets = useMemo(
    () => (network && live ? facetCounts(network, live) : null),
    [network, live],
  );

  // The selection is rendered at the top of the panel, and a reader who clicks
  // a mast has usually scrolled down to the filter that isolated it — so the
  // answer to their click would arrive off screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selection) scrollRef.current?.scrollTo({ top: 0 });
  }, [selection]);

  const select = useCallback((next: Selection | null) => {
    setSelection(next);
    if (!next || !network) return;
    if (next.kind === "cell") {
      const cell = network.cells[next.index];
      go(cell.lat, cell.lon);
    }
  }, [network, go]);

  return (
    <div className={MAP_SHELL}>
      <TowerMap
        network={network}
        view={live ?? EMPTY_VIEW}
        selection={selection}
        onSelect={setSelection}
        focus={focus}
      />

      <section className={MAP_PANEL}>
        <header>
          <h1>Cell network</h1>
          <p>
            {error
              ? <StatusText state="error">{error}</StatusText>
              : network
                ? `${num(network.cells.length)} cells on ${num(network.sites.length)} structures · `
                  + `${num(network.areas.length)} tracking areas`
                : "Loading…"}
          </p>
        </header>
        <div className={PANEL_SCROLL} ref={scrollRef}>
          {!network || !live || !facets ? (
            <p className={PANEL_NOTE} data-state={error ? "error" : undefined}>
              {error
                ? <code>python kierston/init/network/towers.py</code>
                : "Loading towers.json…"}
            </p>
          ) : (
            <>
              {selection ? (
                <SelectedSection
                  network={network}
                  view={live}
                  selection={selection}
                  onSelect={select}
                  onGo={go}
                />
              ) : null}
              <DrawSection view={live} patch={patch} counts={counts} network={network} />
              <StructureSection network={network} view={live} patch={patch} />
              <OperatorSection
                network={network} view={live} patch={patch} counts={facets.operators}
              />
              <BandSection network={network} view={live} patch={patch} counts={facets.bands} />
              <RoleSection view={live} patch={patch} counts={facets.roles} />
              <AreaSection
                network={network}
                view={live}
                patch={patch}
                counts={facets.areas}
                onGo={(key) => {
                  const [operator, tac] = key.split("/");
                  const area = network.area(operator, Number(tac));
                  if (!area) return;
                  setSelection({ kind: "area", key });
                  go(area.centre[0], area.centre[1], 13);
                }}
              />
              <FindSection
                network={network} query={query} onQuery={setQuery} onSelect={select}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** A view with nothing in it, for the frames before the file lands. */
const EMPTY_VIEW: NetworkView = {
  operators: new Set(),
  bands: new Set(),
  roles: new Set(),
  areas: new Set(),
  sources: new Set(),
  sites: false,
  sectors: false,
  rings: false,
  hulls: false,
  labels: false,
  colorBy: "operator",
  opacity: 0.22,
};

interface Facets {
  operators: Map<string, number>;
  bands: Map<string, number>;
  roles: Map<CellRole, number>;
  areas: Map<string, number>;
}

/**
 * How many cells each facet would contribute, given the *other* filters.
 *
 * Not a plain total: a count beside a checkbox that ignored the rest of the
 * panel would tell a reader T-Mobile has 840 cells while the map, filtered to
 * one tracking area, is showing eleven. Each facet is counted with its own
 * dimension left open, which is what makes the number an answer to "what
 * happens if I tick this".
 */
function facetCounts(network: Network, view: NetworkView): Facets {
  const facets: Facets = {
    operators: new Map(),
    bands: new Map(),
    roles: new Map(),
    areas: new Map(),
  };
  const bump = <T,>(map: Map<T, number>, key: T) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const cell of network.cells) {
    const site = network.sites[cell.site];
    if (site && !view.sources.has(site.source)) continue;
    const operator = view.operators.has(cell.operator_key);
    const band = view.bands.has(cell.band);
    const role = view.roles.has(cell.role);
    const key = areaKey(cell.operator_key, cell.tracking_area);
    const area = view.areas.has(key);

    if (band && role && area) bump(facets.operators, cell.operator_key);
    if (operator && role && area) bump(facets.bands, cell.band);
    if (operator && band && area) bump(facets.roles, cell.role);
    if (operator && band && role) bump(facets.areas, key);
  }

  return facets;
}

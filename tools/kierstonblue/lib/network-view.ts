/**
 * What the tower map is currently showing, and how to ask the network for it.
 *
 * Pure, and separate from the component that draws it, for the same reason
 * lib/map-render.ts keeps RenderState out of MapWorkspace: the panel counts
 * what the filters select and the map draws it, and both have to agree on what
 * "selected" means without one of them re-implementing the other's rules.
 */

import { ROLE_COLOR, type Cell, type CellRole, type Network, type Site } from "./towers";

export type ColorBy = "operator" | "band" | "role" | "area";

export const COLOR_BY: { id: ColorBy; label: string }[] = [
  { id: "operator", label: "Operator" },
  { id: "band", label: "Band" },
  { id: "role", label: "Layer" },
  { id: "area", label: "Tracking area" },
];

export interface NetworkView {
  /** Operator keys — an empty set means every operator is hidden, not all. */
  operators: Set<string>;
  bands: Set<string>;
  roles: Set<CellRole>;
  /** Tracking areas, keyed `${operator}/${tac}`. */
  areas: Set<string>;
  /** Structure provenance: "asr" or "modelled". */
  sources: Set<string>;
  sites: boolean;
  sectors: boolean;
  rings: boolean;
  hulls: boolean;
  labels: boolean;
  colorBy: ColorBy;
  opacity: number;
}

export type Selection =
  | { kind: "site"; index: number }
  | { kind: "cell"; index: number }
  | { kind: "area"; key: string };

export const areaKey = (operator: string, tac: number) => `${operator}/${tac}`;

/** Everything switched on, which is what the page opens as. */
export function fullView(network: Network): NetworkView {
  return {
    operators: new Set(network.operators.map((operator) => operator.key)),
    bands: new Set(network.bands.map((band) => band.label)),
    roles: new Set(network.bands.map((band) => band.role)),
    areas: new Set(network.areas.map((area) => areaKey(area.operator, area.tac))),
    sources: new Set(["asr", "modelled"]),
    sites: true,
    // Every sector at once is 2,694 wedges over one city, and four carriers
    // stacked on the same masts is close to a wash. It is still what the page
    // is for, so it opens drawn — at a fill light enough that the overlap
    // reads as density rather than as one colour, and with the filters right
    // there to cut it to one carrier or one band.
    sectors: true,
    rings: false,
    hulls: true,
    labels: true,
    colorBy: "operator",
    opacity: 0.12,
  };
}

/** Whether a cell survives every filter. */
export function showsCell(view: NetworkView, cell: Cell, site: Site | undefined): boolean {
  if (!view.operators.has(cell.operator_key)) return false;
  if (!view.bands.has(cell.band)) return false;
  if (!view.roles.has(cell.role)) return false;
  if (!view.areas.has(areaKey(cell.operator_key, cell.tracking_area))) return false;
  if (site && !view.sources.has(site.source)) return false;
  return true;
}

/** Whether a structure has anything left on it after the filters. */
export function showsSite(view: NetworkView, network: Network, site: Site): boolean {
  if (!view.sources.has(site.source)) return false;
  return site.cells.some((index) => showsCell(view, network.cells[index], site));
}

export interface ViewCounts {
  cells: number;
  sites: number;
  /** Sites carrying more than one of the operators still shown. */
  colocated: number;
}

/**
 * What the filters currently select.
 *
 * Counted in one pass over the cells rather than per section, because the
 * panel shows all three numbers at once and the sections would otherwise walk
 * the table three times on every checkbox.
 */
export function countView(network: Network, view: NetworkView): ViewCounts {
  let cells = 0;
  let sites = 0;
  let colocated = 0;

  for (const site of network.sites) {
    if (!view.sources.has(site.source)) continue;
    const tenants = new Set<string>();
    let here = 0;
    for (const index of site.cells) {
      const cell = network.cells[index];
      if (!showsCell(view, cell, site)) continue;
      here += 1;
      tenants.add(cell.operator_key);
    }
    if (!here) continue;
    cells += here;
    sites += 1;
    if (tenants.size > 1) colocated += 1;
  }

  return { cells, sites, colocated };
}

/** The colour a cell is drawn in under the current scheme. */
export function cellColor(network: Network, view: NetworkView, cell: Cell): string {
  if (view.colorBy === "operator") {
    return network.operator(cell.operator_key)?.color ?? "#8a97a3";
  }
  if (view.colorBy === "band") {
    return network.bands.find((band) => band.label === cell.band)?.color ?? "#8a97a3";
  }
  if (view.colorBy === "area") {
    return network.area(cell.operator_key, cell.tracking_area)?.color ?? "#8a97a3";
  }
  return ROLE_COLOR[cell.role];
}

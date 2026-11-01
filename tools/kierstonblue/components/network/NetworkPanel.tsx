"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  COUNT, LAYER_ROW, PANEL_FIELD, PANEL_NOTE, PANEL_STATS, POI_DOT, SWATCH,
} from "@/components/map/panel";
import {
  AREA_GO, AREA_ROW, CELL_DOT, CELL_META, CELL_ROW, SELECTED_FACTS, SELECTED_HEAD,
  SELECTED_KIND, SELECTED_TITLE,
} from "@/components/network/style";
import { coords, metres, num } from "@/lib/format";
import {
  COLOR_BY, areaKey, cellColor, showsCell,
  type ColorBy, type NetworkView, type Selection, type ViewCounts,
} from "@/lib/network-view";
import {
  ROLES, ROLE_COLOR, ROLE_LABEL, SOURCE_COLOR, SOURCE_LABEL, structureLabel,
  type Cell, type CellRole, type Network,
} from "@/lib/towers";

/**
 * The tower map's controls, in the order the questions get asked.
 *
 * What is selected comes first when there is something, because it is the
 * answer to the click that just happened. Then what is drawn, then the four
 * filters — carrier, band, layer, tracking area — each of which is also the
 * legend for the colour scheme it can be switched to. One list per facet
 * rather than a legend and a filter that have to be kept in agreement.
 */

type Patch = (next: Partial<NetworkView>) => void;

const toggle = <T,>(set: Set<T>, value: T, on: boolean): Set<T> => {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
};

// ---- What is drawn -----------------------------------------------------------

export function DrawSection({
  view, patch, counts, network,
}: {
  view: NetworkView;
  patch: Patch;
  counts: ViewCounts;
  network: Network;
}) {
  return (
    <fieldset>
      <legend>Draw</legend>
      <LayerToggle
        label="Structures"
        checked={view.sites}
        onChange={(on) => patch({ sites: on })}
      />
      <LayerToggle
        label="Sector footprints"
        checked={view.sectors}
        onChange={(on) => patch({ sectors: on })}
      />
      <LayerToggle
        label="Range"
        checked={view.rings}
        onChange={(on) => patch({ rings: on })}
      />
      <LayerToggle
        label="Tracking areas"
        checked={view.hulls}
        onChange={(on) => patch({ hulls: on })}
      />
      {view.hulls ? (
        <LayerToggle
          label="Labels"
          checked={view.labels}
          onChange={(on) => patch({ labels: on })}
        />
      ) : null}

      <label className={PANEL_FIELD}>
        <span>Sector colour</span>
        <NativeSelect
          value={view.colorBy}
          onChange={(event) => patch({ colorBy: event.target.value as ColorBy })}
        >
          {COLOR_BY.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </NativeSelect>
      </label>

      {view.sectors ? (
        <label className={PANEL_FIELD}>
          <span>Footprint fill — {Math.round(view.opacity * 100)}%</span>
          <input
            type="range"
            min={5}
            max={70}
            value={Math.round(view.opacity * 100)}
            onChange={(event) => patch({ opacity: Number(event.target.value) / 100 })}
          />
        </label>
      ) : null}

      <dl className={PANEL_STATS}>
        <div><dt>Cells</dt><dd>{num(counts.cells)} of {num(network.cells.length)}</dd></div>
        <div><dt>Structures</dt><dd>{num(counts.sites)} of {num(network.sites.length)}</dd></div>
        <div><dt>Colocated</dt><dd>{num(counts.colocated)}</dd></div>
      </dl>
    </fieldset>
  );
}

function LayerToggle({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
      style={{ margin: ".2rem 0" }}
    >
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span>{label}</span>
    </label>
  );
}

// ---- Structures --------------------------------------------------------------

export function StructureSection({
  network, view, patch,
}: {
  network: Network;
  view: NetworkView;
  patch: Patch;
}) {
  const counted = { asr: network.registered, modelled: network.sites.length - network.registered };

  return (
    <fieldset>
      <legend>Structures</legend>
      {(["asr", "modelled"] as const).map((source) => (
        <label className={LAYER_ROW} key={source}>
          <Checkbox
            checked={view.sources.has(source)}
            onCheckedChange={(v) => patch({ sources: toggle(view.sources, source, v === true) })}
          />
          <span className={POI_DOT} style={{ background: SOURCE_COLOR[source] }} />
          <span>{SOURCE_LABEL[source]}</span>
          <span className={COUNT}>{num(counted[source])}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---- Operators ---------------------------------------------------------------

export function OperatorSection({
  network, view, patch, counts,
}: {
  network: Network;
  view: NetworkView;
  patch: Patch;
  counts: Map<string, number>;
}) {
  return (
    <fieldset>
      <legend>Operators</legend>
      {network.operators.map((operator) => (
        <label className={LAYER_ROW} key={operator.key}>
          <Checkbox
            checked={view.operators.has(operator.key)}
            onCheckedChange={(v) =>
              patch({ operators: toggle(view.operators, operator.key, v === true) })}
          />
          <span className={SWATCH} style={{ background: operator.color }} />
          <span title={`MCC ${operator.mcc} · MNC ${operator.mnc}`}>
            {operator.label}
            <i className={CELL_META}> · {operator.sites} sites</i>
          </span>
          <span className={COUNT}>{num(counts.get(operator.key) ?? 0)}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---- Bands and layers --------------------------------------------------------

export function BandSection({
  network, view, patch, counts,
}: {
  network: Network;
  view: NetworkView;
  patch: Patch;
  counts: Map<string, number>;
}) {
  const all = view.bands.size === network.bands.length;

  return (
    <fieldset>
      <legend>Bands</legend>
      <div className="mt-[0.45rem] mb-[0.55rem] flex flex-wrap items-center gap-[0.4rem]">
        <span className="text-[0.68rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Select
        </span>
        <Button
          type="button" variant="outline" size="xs"
          onClick={() => patch({ bands: new Set(network.bands.map((band) => band.label)) })}
          disabled={all}
        >
          All
        </Button>
        <Button
          type="button" variant="outline" size="xs"
          onClick={() => patch({
            bands: new Set(network.bands
              .filter((band) => band.radio === "LTE").map((band) => band.label)),
          })}
        >
          LTE
        </Button>
        <Button
          type="button" variant="outline" size="xs"
          onClick={() => patch({
            bands: new Set(network.bands
              .filter((band) => band.radio === "NR").map((band) => band.label)),
          })}
        >
          5G NR
        </Button>
      </div>
      {network.bands.map((band) => (
        <label className={LAYER_ROW} key={band.label}>
          <Checkbox
            checked={view.bands.has(band.label)}
            onCheckedChange={(v) => patch({ bands: toggle(view.bands, band.label, v === true) })}
          />
          <span className={SWATCH} style={{ background: band.color }} />
          <span>
            {band.label}
            <i className={CELL_META}>
              {" "}· {band.radio} · {num(band.frequency)} MHz · {metres(band.reach)}
            </i>
          </span>
          <span className={COUNT}>{num(counts.get(band.label) ?? 0)}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function RoleSection({
  view, patch, counts,
}: {
  view: NetworkView;
  patch: Patch;
  counts: Map<CellRole, number>;
}) {
  return (
    <fieldset>
      <legend>Layers</legend>
      {ROLES.map((role) => (
        <label className={LAYER_ROW} key={role.id} title={role.hint}>
          <Checkbox
            checked={view.roles.has(role.id)}
            onCheckedChange={(v) => patch({ roles: toggle(view.roles, role.id, v === true) })}
          />
          <span className={SWATCH} style={{ background: ROLE_COLOR[role.id] }} />
          <span>{role.label}</span>
          <span className={COUNT}>{num(counts.get(role.id) ?? 0)}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---- Tracking areas ----------------------------------------------------------

export function AreaSection({
  network, view, patch, counts, onGo,
}: {
  network: Network;
  view: NetworkView;
  patch: Patch;
  counts: Map<string, number>;
  onGo: (key: string) => void;
}) {
  const all = view.areas.size === network.areas.length;

  return (
    <fieldset>
      <legend>Tracking areas</legend>
      <div className="mt-[0.45rem] mb-[0.55rem] flex flex-wrap items-center gap-[0.4rem]">
        <span className="text-[0.68rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Select
        </span>
        <Button
          type="button" variant="outline" size="xs"
          disabled={all}
          onClick={() => patch({
            areas: new Set(network.areas.map((area) => areaKey(area.operator, area.tac))),
          })}
        >
          All {network.areas.length}
        </Button>
        <Button
          type="button" variant="outline" size="xs"
          disabled={!view.areas.size}
          onClick={() => patch({ areas: new Set() })}
        >
          None
        </Button>
      </div>
      {network.areas.map((area) => {
        const key = areaKey(area.operator, area.tac);
        return (
          <div className={AREA_ROW} key={key}>
            <label>
              <Checkbox
                checked={view.areas.has(key)}
                onCheckedChange={(v) => patch({ areas: toggle(view.areas, key, v === true) })}
              />
              <span className={POI_DOT} style={{ background: area.color }} />
              <span>
                TAC {area.tac}
                <i className={CELL_META}> · {area.operatorLabel}</i>
              </span>
              <span className={COUNT}>{num(counts.get(key) ?? 0)}</span>
            </label>
            <button
              type="button"
              className={AREA_GO}
              onClick={() => onGo(key)}
              aria-label={`Centre on TAC ${area.tac}, ${area.operatorLabel}`}
              title="Centre"
            >
              <span aria-hidden>◎</span>
            </button>
          </div>
        );
      })}
    </fieldset>
  );
}

// ---- Find --------------------------------------------------------------------

export function FindSection({
  network, query, onQuery, onSelect,
}: {
  network: Network;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (selection: Selection) => void;
}) {
  const matches = findCells(network, query);

  return (
    <fieldset>
      <legend>Cell search</legend>
      <Input
        className="mt-[0.45rem]"
        value={query}
        placeholder="CGI, station, cell id, PCI, ASR"
        aria-label="Cell identifier"
        onChange={(event) => onQuery(event.target.value)}
      />
      {query.trim() ? (
        matches.length ? (
          <>
            {matches.map((cell) => (
              <button
                key={cell.id}
                type="button"
                className={CELL_ROW}
                onClick={() => onSelect({ kind: "cell", index: cell.index })}
              >
                <span
                  className={CELL_DOT}
                  style={{ background: network.operator(cell.operator_key)?.color }}
                />
                <span>
                  {cell.operator} {cell.band}
                  <i className={CELL_META}> · TAC {cell.tracking_area}</i>
                </span>
                <span className={CELL_META}>{cell.cgi}</span>
              </button>
            ))}
            <p className={PANEL_NOTE}>
              {matches.length === LIMIT ? `First ${LIMIT} matches` : `${matches.length} matches`}
            </p>
          </>
        ) : (
          <p className={PANEL_NOTE}>No matches</p>
        )
      ) : null}
    </fieldset>
  );
}

const LIMIT = 12;

function findCells(network: Network, query: string): Cell[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const numeric = Number(needle);
  const exact = Number.isFinite(numeric) && needle !== "";
  const out: Cell[] = [];

  for (const cell of network.cells) {
    const site = network.sites[cell.site];
    const hit = cell.cgi.toLowerCase().includes(needle)
      || cell.id.toLowerCase().includes(needle)
      || (site?.asr ?? "").includes(needle)
      || (exact && (
        cell.station_id === numeric
        || cell.identity === numeric
        || cell.pci === numeric
        || cell.tracking_area === numeric
        || cell.cell_id === numeric));
    if (!hit) continue;
    out.push(cell);
    if (out.length === LIMIT) break;
  }
  return out;
}

// ---- What is selected --------------------------------------------------------

export function SelectedSection({
  network, view, selection, onSelect, onGo,
}: {
  network: Network;
  view: NetworkView;
  selection: Selection;
  onSelect: (selection: Selection | null) => void;
  onGo: (lat: number, lon: number, zoom?: number) => void;
}) {
  if (selection.kind === "area") {
    const [operator, tac] = selection.key.split("/");
    const area = network.area(operator, Number(tac));
    if (!area) return null;
    return (
      <fieldset>
        <SelectedHead
          kind="Tracking area"
          title={`TAC ${area.tac}`}
          onClose={() => onSelect(null)}
        />
        <div className={SELECTED_FACTS}>
          <div><span>Operator</span><span>{area.operatorLabel}</span></div>
          <div><span>Cells</span><span>{num(area.cells)}</span></div>
          <div><span>Structures</span><span>{num(area.sites)}</span></div>
          <div><span>Centre</span><span>{coords(area.centre[0], area.centre[1])}</span></div>
        </div>
        <div className="mt-[0.5rem]">
          <Button
            type="button" variant="outline" size="xs"
            onClick={() => onGo(area.centre[0], area.centre[1], 13)}
          >
            Centre
          </Button>
        </div>
      </fieldset>
    );
  }

  if (selection.kind === "cell") {
    const cell = network.cells[selection.index];
    return (
      <fieldset>
        <SelectedHead
          kind="Cell"
          title={`${cell.operator} ${cell.band}`}
          onClose={() => onSelect(null)}
        />
        <div className={SELECTED_FACTS}>
          <div><span>Identity</span><span className={CELL_META}>{cell.cgi}</span></div>
          <div>
            <span>{cell.radio === "LTE" ? "eNodeB" : "gNodeB"}</span>
            <span className={CELL_META}>{cell.station_id}</span>
          </div>
          <div><span>Cell id</span><span className={CELL_META}>{cell.cell_id}</span></div>
          <div><span>Tracking area</span><span className={CELL_META}>{cell.tracking_area}</span></div>
          <div><span>PCI</span><span className={CELL_META}>{cell.pci}</span></div>
          <div><span>PLMN</span><span className={CELL_META}>{cell.mcc}-{cell.mnc}</span></div>
          <div><span>Radio</span><span>{cell.radio} · {num(cell.frequency_mhz)} MHz</span></div>
          <div><span>Layer</span><span>{ROLE_LABEL[cell.role]}</span></div>
          <div>
            <span>Sector</span>
            <span>
              {cell.sector + 1} · {Math.round(cell.azimuth)}° ± {cell.beamwidth / 2}°
            </span>
          </div>
          <div><span>Downtilt</span><span>{cell.downtilt}°</span></div>
          <div><span>Antenna</span><span>{cell.height_m} m above ground</span></div>
          <div><span>EIRP</span><span>{cell.eirp_dbm} dBm</span></div>
          <div><span>Indicative range</span><span>{metres(cell.range_m)}</span></div>
          <div><span>Morphology</span><span>{cell.morphology}</span></div>
        </div>
        <div className="mt-[0.5rem] flex flex-wrap gap-[0.4rem]">
          <Button
            type="button" variant="outline" size="xs"
            onClick={() => onSelect({ kind: "site", index: cell.site })}
          >
            Structure
          </Button>
          <Button
            type="button" variant="outline" size="xs"
            onClick={() => onGo(cell.lat, cell.lon, 16)}
          >
            Centre
          </Button>
        </div>
      </fieldset>
    );
  }

  const site = network.sites[selection.index];
  const tenants = site.tenants
    .map((key) => network.operator(key)?.label ?? key)
    .join(", ");

  return (
    <fieldset>
      <SelectedHead
        kind="Structure"
        title={structureLabel(site)}
        onClose={() => onSelect(null)}
      />
      <div className={SELECTED_FACTS}>
        <div>
          <span>Source</span>
          <span>{site.source === "asr" ? `FCC ASR ${site.asr}` : "Modelled rooftop"}</span>
        </div>
        <div><span>Height</span><span>{site.height_m} m</span></div>
        {site.building_levels ? (
          <div><span>Building</span><span>{site.building_levels} storeys</span></div>
        ) : null}
        <div><span>Owner</span><span>{site.owner ?? "—"}</span></div>
        <div><span>Location</span><span className={CELL_META}>{coords(site.lat, site.lon)}</span></div>
        <div><span>Operators</span><span>{tenants || "none"}</span></div>
        <div><span>Cells</span><span>{num(site.cells.length)}</span></div>
        <div><span>Furthest reach</span><span>{metres(site.reach)}</span></div>
      </div>
      <div className="mt-[0.5rem] flex flex-wrap gap-[0.4rem]">
        <Button
          type="button" variant="outline" size="xs"
          onClick={() => onGo(site.lat, site.lon, 16)}
        >
          Centre
        </Button>
      </div>

      <p
        className="mt-[0.7rem] text-[0.68rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
      >
        {num(site.cells.length)} cells
      </p>
      {site.cells.map((index) => {
        const cell = network.cells[index];
        const dimmed = !showsCell(view, cell, site);
        return (
          <button
            key={cell.id}
            type="button"
            className={CELL_ROW}
            style={dimmed ? { opacity: 0.5 } : undefined}
            title={dimmed ? "Filtered" : cell.cgi}
            onClick={() => onSelect({ kind: "cell", index })}
          >
            <span
              className={CELL_DOT}
              style={{ background: cellColor(network, view, cell) }}
            />
            <span>
              {cell.operator} {cell.band}
              <i className={CELL_META}> · S{cell.sector + 1} · {Math.round(cell.azimuth)}°</i>
            </span>
            <span className={CELL_META}>{metres(cell.range_m)}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

function SelectedHead({
  kind, title, onClose,
}: {
  kind: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <>
      <div className={SELECTED_HEAD} style={{ marginTop: ".35rem" }}>
        <span className={SELECTED_KIND}>{kind}</span>
        <Button type="button" variant="outline" size="xs" onClick={onClose}>Close</Button>
      </div>
      <p className={SELECTED_TITLE} style={{ marginTop: ".1rem" }}>{title}</p>
    </>
  );
}

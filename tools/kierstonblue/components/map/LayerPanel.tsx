"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BuildingData, PoiData, Topology } from "@/lib/datasets";
import type { Employment } from "@/lib/employment";
import type { Band, Enrollment } from "@/lib/enrollment";
import { num } from "@/lib/format";
import { ROAD_STYLES, type WorkplaceGroupId } from "@/lib/map-style";
import type { DrawStats, RoadState, SchoolState, WorkplaceState } from "@/lib/map-render";
import { cn } from "@/lib/utils";
import {
  CARET, COUNT, LAYER_ROW, MUTED_ROW, PANEL_ACTIONS, PANEL_NOTE, PANEL_STATS,
  POI_DOT, POI_GROUP, POI_TYPE, POI_TYPES, SWATCH,
} from "@/components/map/panel";

/** Roads: the class legend, doubling as its filter. */
export function RoadSection({
  topology, state, stats, onChange,
}: {
  topology: Topology | null;
  state: RoadState;
  stats: DrawStats | null;
  onChange: (next: RoadState) => void;
}) {
  const toggleRank = (rank: number, on: boolean) => {
    const ranks = new Set(state.ranks);
    if (on) ranks.add(rank);
    else ranks.delete(rank);
    onChange({ ...state, ranks });
  };

  return (
    <fieldset>
      <legend>Road network</legend>
      <label
        className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
        style={{ margin: ".5rem 0 .35rem" }}
      >
        <Checkbox
          checked={state.enabled}
          onCheckedChange={(v) => onChange({ ...state, enabled: v === true })}
        />
        <span>Show roads</span>
      </label>
      <label
        className="text-muted-foreground flex min-h-6 cursor-pointer items-center gap-2 text-[0.72rem]"
        style={{ marginBottom: ".45rem" }}
      >
        <Checkbox
          checked={state.autoDetail}
          onCheckedChange={(v) => onChange({ ...state, autoDetail: v === true })}
        />
        <span>Auto detail</span>
      </label>
      {ROAD_STYLES.map((style, rank) => (
        <label
          className={cn(LAYER_ROW, stats && rank > stats.detailRank && MUTED_ROW)}
          key={style.label}
        >
          <Checkbox
            checked={state.ranks.has(rank)}
            onCheckedChange={(v) => toggleRank(rank, v === true)}
          />
          <span className={SWATCH} style={{ background: style.color }} />
          <span>{style.label}</span>
          <span className={COUNT}>{num(topology?.rankCounts[rank] ?? 0)}</span>
        </label>
      ))}
      {stats ? (
        <dl className={PANEL_STATS}>
          <div><dt>Segments</dt><dd>{num(topology?.count ?? 0)}</dd></div>
          <div><dt>In view</dt><dd>{num(stats.visible)}</dd></div>
          <div><dt>Drawn</dt><dd>{num(stats.drawn)}</dd></div>
          <div>
            <dt>Detail</dt>
            <dd>
              {`z${stats.zoom} · ${state.autoDetail
                ? `to ${ROAD_STYLES[stats.detailRank].label.toLowerCase()}`
                : "all types"}${stats.step > 1 ? ` · 1/${stats.step}` : ""}`}
            </dd>
          </div>
        </dl>
      ) : null}
    </fieldset>
  );
}

/** Points of interest: groups, expandable to the OSM types beneath them. */
export function PoiSection({
  pois, active, onChange, error,
}: {
  pois: PoiData | null;
  active: Set<number>;
  onChange: (next: Set<number>) => void;
  error: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const preset = (which: "signal" | "all" | "none") => {
    const next = new Set<number>();
    for (const group of pois?.groups ?? []) {
      // "signal" is the classifier's own verdict: everything except parking,
      // street furniture, interior fixtures and back-yard features.
      if (which === "none" || (which === "signal" && !group.default)) continue;
      for (const type of group.types) next.add(type.i);
    }
    onChange(next);
  };

  const setTypes = (types: number[], on: boolean) => {
    const next = new Set(active);
    for (const type of types) {
      if (on) next.add(type);
      else next.delete(type);
    }
    onChange(next);
  };

  const shown = pois ? pois.points.reduce((sum, poi) => sum + (active.has(poi[3]) ? 1 : 0), 0) : 0;

  return (
    <fieldset>
      <legend>Points of interest</legend>
      <p className={PANEL_NOTE} data-state={error ? "error" : undefined}>
        {error ?? (pois
          ? `${num(shown)} of ${num(pois.points.length)} shown`
          : "Loading…")}
      </p>
      {/* Three bare words next to a checkbox list read as filters rather than
          as the actions they are, so the group says what they set. */}
      <div className={PANEL_ACTIONS} role="group" aria-label="Select point types">
        <span className="text-[0.68rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Select</span>
        <Button type="button" variant="outline" size="xs" onClick={() => preset("signal")}>
          Useful
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => preset("all")}>
          All
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => preset("none")}>
          None
        </Button>
      </div>
      {(pois?.groups ?? []).map((group) => {
        const on = group.types.filter((type) => active.has(type.i)).length;
        const expanded = open.has(group.label);
        return (
          <div key={group.label}>
            {/* The caret is a sibling of the label, not inside it: a button
                nested in a label lands in the checkbox's own hit area and its
                glyph ends up in the checkbox's accessible name. */}
            <div className={POI_GROUP}>
              <label>
                <Checkbox
                  checked={on === group.types.length ? true : on > 0 ? "indeterminate" : false}
                  onCheckedChange={(v) =>
                    setTypes(group.types.map((type) => type.i), v === true)}
                />
                <span className={POI_DOT} style={{ background: group.color }} />
                <span>{group.label}</span>
                <span className={COUNT}>{num(group.count)}</span>
              </label>
              <button
                type="button"
                className={CARET}
                aria-expanded={expanded}
                aria-label={`${group.label}: ${group.types.length} types`}
                onClick={() => {
                  const next = new Set(open);
                  if (expanded) next.delete(group.label);
                  else next.add(group.label);
                  setOpen(next);
                }}
              >
                <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              </button>
            </div>
            {expanded ? (
              <div className={POI_TYPES}>
                {group.types.map((type) => (
                  <label className={POI_TYPE} key={type.i} title={type.id}>
                    <Checkbox
                      checked={active.has(type.i)}
                      onCheckedChange={(v) => setTypes([type.i], v === true)}
                    />
                    <span>{type.label}</span>
                    <span className={COUNT}>{num(type.count)}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Workplaces: the site catalogue, grouped by what kind of work happens there. */
export function WorkSection({
  employment, state, onChange, onToggleAll, status,
}: {
  employment: Employment | null;
  state: WorkplaceState;
  onChange: (next: WorkplaceState) => void;
  onToggleAll: (on: boolean) => void;
  status: string;
}) {
  const all = employment ? state.groups.size === employment.groups.length : false;
  const setGroup = (id: WorkplaceGroupId, on: boolean) => {
    const groups = new Set(state.groups);
    if (on) groups.add(id);
    else groups.delete(id);
    onChange({ ...state, groups });
  };

  const shown = employment
    ? employment.sites.reduce((sum, site) => sum
        + (state.groups.has(site.group) && (!state.staffedOnly || site.staff.length) ? 1 : 0), 0)
    : 0;
  const staff = employment
    ? employment.sites.reduce((sum, site) => sum
        + (state.groups.has(site.group) ? site.staff.length : 0), 0)
    : 0;

  return (
    <fieldset>
      <legend>Workplaces</legend>
      <label
        className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
        style={{ margin: ".5rem 0 .35rem" }}
      >
        <Checkbox
          checked={all ? true : state.groups.size > 0 ? "indeterminate" : false}
          onCheckedChange={(v) => onToggleAll(v === true)}
        />
        <span>Show workplaces</span>
      </label>
      {employment ? (
        <label
          className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
          style={{ marginBottom: ".35rem" }}
        >
          <Checkbox
            checked={state.staffedOnly}
            onCheckedChange={(v) => onChange({ ...state, staffedOnly: v === true })}
          />
          <span>Staffed only</span>
        </label>
      ) : null}
      <p className={PANEL_NOTE}>
        {employment
          ? `${num(shown)} of ${num(employment.sites.length)} sites · ${num(staff)} workers`
          : status}
      </p>
      {employment && state.groups.size
        ? employment.groups.map((group) => (
            <label className={LAYER_ROW} key={group.id}>
              <Checkbox
                checked={state.groups.has(group.id)}
                onCheckedChange={(v) => setGroup(group.id, v === true)}
              />
              <span className={SWATCH} style={{ background: group.color }} />
              <span>{group.label}</span>
              <span className={COUNT}>{num(group.staff)}</span>
            </label>
          ))
        : null}
    </fieldset>
  );
}

/** Schools: the catalogue, grouped by the grades taught, plus the catchment lines. */
export function SchoolSection({
  enrollment, state, onChange, onToggleAll, status,
}: {
  enrollment: Enrollment | null;
  state: SchoolState;
  onChange: (next: SchoolState) => void;
  onToggleAll: (on: boolean) => void;
  status: string;
}) {
  const all = enrollment ? state.bands.size === enrollment.bands.length : false;
  const setBand = (id: Band, on: boolean) => {
    const bands = new Set(state.bands);
    if (on) bands.add(id);
    else bands.delete(id);
    onChange({ ...state, bands });
  };

  const shown = enrollment
    ? enrollment.schools.reduce((sum, school) => sum
        + (school.bands.some((band) => state.bands.has(band))
          && (!state.usedOnly || school.students.length) ? 1 : 0), 0)
    : 0;
  const students = enrollment
    ? enrollment.schools.reduce((sum, school) => sum
        + (school.bands.some((band) => state.bands.has(band)) ? school.students.length : 0), 0)
    : 0;

  return (
    <fieldset>
      <legend>Schools</legend>
      <label
        className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
        style={{ margin: ".5rem 0 .35rem" }}
      >
        <Checkbox
          checked={all ? true : state.bands.size > 0 ? "indeterminate" : false}
          onCheckedChange={(v) => onToggleAll(v === true)}
        />
        <span>Show schools</span>
      </label>
      {enrollment ? (
        <>
          <label
            className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
            style={{ marginBottom: ".35rem" }}
          >
            <Checkbox
              checked={state.usedOnly}
              onCheckedChange={(v) => onChange({ ...state, usedOnly: v === true })}
            />
            <span>With students only</span>
          </label>
          <label
            className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
            style={{ marginBottom: ".35rem" }}
          >
            <Checkbox
              checked={state.catchments}
              onCheckedChange={(v) => onChange({ ...state, catchments: v === true })}
            />
            <span>Catchments</span>
          </label>
        </>
      ) : null}
      <p className={PANEL_NOTE}>
        {enrollment
          ? `${num(shown)} of ${num(enrollment.schools.length)} schools · ${num(students)} students`
          : status}
      </p>
      {enrollment && state.bands.size
        ? enrollment.bands.map((band) => (
            <label className={LAYER_ROW} key={band.id}>
              <Checkbox
                checked={state.bands.has(band.id)}
                onCheckedChange={(v) => setBand(band.id, v === true)}
              />
              <span className={SWATCH} style={{ background: band.color }} />
              <span>{band.label}</span>
              <span className={COUNT}>{num(band.students)}</span>
            </label>
          ))
        : null}
    </fieldset>
  );
}

/** Buildings, the dwellings-only filter, and the residents join. */
export function BuildingSection({
  buildings, active, onChange, onToggleAll, dwellingsOnly, onDwellingsOnly,
  residents, onResidents, status, residentStatus, shown, units,
}: {
  buildings: BuildingData | null;
  active: Set<number>;
  onChange: (next: Set<number>) => void;
  onToggleAll: (on: boolean) => void;
  dwellingsOnly: boolean;
  onDwellingsOnly: (on: boolean) => void;
  residents: boolean;
  onResidents: (on: boolean) => void;
  status: string;
  residentStatus: string | null;
  shown: number;
  units: number;
}) {
  const all = buildings ? active.size === buildings.categories.length : false;
  return (
    <fieldset>
      <legend>Buildings</legend>
      <label
        className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
        style={{ margin: ".5rem 0 .35rem" }}
      >
        <Checkbox
          checked={all ? true : active.size > 0 ? "indeterminate" : false}
          // The categories are not known until the dataset is in memory, so
          // switching the layer on is a request, not a set of indices.
          onCheckedChange={(v) => onToggleAll(v === true)}
        />
        <span>Show buildings</span>
      </label>
      {buildings ? (
        <>
          <label
            className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
            style={{ marginBottom: ".35rem" }}
          >
            <Checkbox
              checked={dwellingsOnly}
              onCheckedChange={(v) => onDwellingsOnly(v === true)}
            />
            <span>Dwellings only</span>
          </label>
          <label
            className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
            style={{ marginBottom: ".35rem" }}
          >
            <Checkbox
              checked={residents}
              onCheckedChange={(v) => onResidents(v === true)}
            />
            <span>Residents</span>
          </label>
        </>
      ) : null}
      <p className={PANEL_NOTE}>
        {buildings
          ? `${num(shown)} of ${dwellingsOnly
              ? `${num(buildings.dwellings)} dwellings`
              : num(buildings.points.length)} shown${
              units ? ` · ${num(units)} dwelling unit${units === 1 ? "" : "s"}` : ""}`
          : status}
      </p>
      {residentStatus ? <p className={PANEL_NOTE}>{residentStatus}</p> : null}
      {buildings && active.size
        ? buildings.categories.map((category, index) => (
            <label className={LAYER_ROW} key={category.label}>
              <Checkbox
                checked={active.has(index)}
                onCheckedChange={(v) => {
                  const next = new Set(active);
                  if (v === true) next.add(index);
                  else next.delete(index);
                  onChange(next);
                }}
              />
              <span className={SWATCH} style={{ background: category.color }} />
              <span>{category.label}</span>
              <span className={COUNT}>{num(category.count)}</span>
            </label>
          ))
        : null}
    </fieldset>
  );
}

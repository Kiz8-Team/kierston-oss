"use client";

import Link from "next/link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  COUNT, LAYER_ROW, PANEL_FIELD, PANEL_NOTE, PANEL_STATS, POI_DOT, SWATCH,
} from "@/components/map/panel";
import {
  CAMERA_DOT, CAMERA_META, CAMERA_ROW, CURVE, CURVE_CAPTION, LIST_NAME, LIST_ROW,
  LIST_SCROLL, LIST_SUB, LIST_VALUE, READS_LINK, ROLE_ROW, SELECTED_FACTS,
  SELECTED_HEAD, SELECTED_KIND, SELECTED_NAV, SELECTED_TITLE, STEP_LINK,
} from "@/components/cameras/style";
import { cameraHref } from "@/lib/alpr";
import { coords, metres, num, percent } from "@/lib/format";
import {
  COLOR_BY, busiest, cameraColor, showsCamera,
  type ColorBy, type CameraView, type Selection, type ViewCounts,
} from "@/lib/camera-view";
import {
  MOUNT_LABEL, OWNER_COLOR, OWNER_LABEL, ROLES, ROLE_COLOR, ROLE_LABEL,
  classLabel, compass, depression,
  type Camera, type CameraFleet, type OwnerKind, type Role,
} from "@/lib/cameras";

type Patch = (next: Partial<CameraView>) => void;

const toggle = <T,>(set: Set<T>, value: T, on: boolean): Set<T> => {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
};

export type SortBy = "order" | "busiest" | "gain" | "street" | "dwell";

export const SORTS: { id: SortBy; label: string }[] = [
  { id: "order", label: "Installation order" },
  { id: "busiest", label: "Daily traffic" },
  { id: "gain", label: "Additional drivers" },
  { id: "dwell", label: "Capture duration" },
  { id: "street", label: "Street" },
];

export function sortCameras(cameras: Camera[], by: SortBy): Camera[] {
  const out = cameras.slice();
  if (by === "busiest") out.sort((a, b) => b.daily_passes - a.daily_passes);
  else if (by === "gain") out.sort((a, b) => b.new_drivers - a.new_drivers);
  else if (by === "dwell") out.sort((a, b) => (b.zone_seconds ?? 0) - (a.zone_seconds ?? 0));
  else if (by === "street") {
    out.sort((a, b) => {
      if (!a.street !== !b.street) return a.street ? -1 : 1;
      return (a.street ?? "").localeCompare(b.street ?? "") || a.azimuth - b.azimuth;
    });
  }
  return out;
}

export function CameraListSection({
  fleet, view, query, onQuery, sortBy, onSort, selection, onSelect,
}: {
  fleet: CameraFleet;
  view: CameraView;
  query: string;
  onQuery: (value: string) => void;
  sortBy: SortBy;
  onSort: (by: SortBy) => void;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const most = busiest(fleet);
  const needle = query.trim().toLowerCase();
  const rows = sortCameras(
    fleet.cameras.filter((camera) => {
      if (!showsCamera(view, camera)) return false;
      if (!needle) return true;
      return camera.id.toLowerCase().includes(needle)
        || (camera.street ?? "").toLowerCase().includes(needle)
        || camera.mount.toLowerCase().includes(needle)
        || camera.class.toLowerCase().includes(needle)
        || (camera.site ?? "").toLowerCase().includes(needle);
    }),
    sortBy,
  );

  const value = (camera: Camera) => {
    if (sortBy === "gain") return `+${num(camera.new_drivers)}`;
    if (sortBy === "dwell") return camera.zone_seconds ? `${camera.zone_seconds.toFixed(1)}s` : "—";
    return `${num(camera.daily_passes)}/day`;
  };

  return (
    <fieldset>
      <legend>Cameras</legend>
      <Input
        value={query}
        placeholder="ALPR-023, Tilghman, MNT-022…"
        onChange={(event) => onQuery(event.target.value)}
      />
      <label className={PANEL_FIELD}>
        <span>Sort by</span>
        <NativeSelect value={sortBy} onChange={(event) => onSort(event.target.value as SortBy)}>
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </NativeSelect>
      </label>

      <div className={LIST_SCROLL}>
        {rows.map((camera) => (
          <button
            key={camera.id}
            type="button"
            className={LIST_ROW}
            aria-current={selection?.kind === "camera" && selection.index === camera.index}
            onClick={() => onSelect({ kind: "camera", index: camera.index })}
          >
            <span
              className={CAMERA_DOT}
              style={{ background: cameraColor(fleet, view, camera, most) }}
            />
            <span className={LIST_NAME}>
              {camera.street ?? camera.site ?? "Unnamed road"}
            </span>
            <span className={LIST_VALUE}>{value(camera)}</span>
            <span className={LIST_SUB}>
              {camera.id} · {compass(camera.azimuth)} · {classLabel(camera.class)}
            </span>
          </button>
        ))}
        {!rows.length ? <p className={PANEL_NOTE}>No matches</p> : null}
      </div>
      <p className={PANEL_NOTE}>{num(rows.length)} of {num(fleet.cameras.length)} shown</p>
    </fieldset>
  );
}

export function SelectedSection({
  fleet, view, selection, onSelect, onGo,
}: {
  fleet: CameraFleet;
  view: CameraView;
  selection: Selection;
  onSelect: (selection: Selection | null) => void;
  onGo: (lat: number, lon: number, zoom?: number) => void;
}) {
  const most = busiest(fleet);

  if (selection.kind === "mount") {
    const mount = fleet.mounts[selection.index];
    const optics = Object.values(fleet.optics)[0];
    return (
      <fieldset>
        <div className={SELECTED_HEAD}>
          <span className={SELECTED_TITLE}>{mount.id}</span>
          <button type="button" className={CAMERA_META} onClick={() => onSelect(null)}>
            clear
          </button>
        </div>
        <div className={SELECTED_KIND}>{MOUNT_LABEL[mount.kind]}</div>
        <div className={SELECTED_FACTS}>
          <div><span>Owner</span><span>{mount.owner}</span></div>
          <div><span>Height</span><span>{mount.height_m} m</span></div>
          {optics ? (
            <div>
              <span>Capture angle</span>
              <span>{depression(mount, optics).toFixed(0)}° below horizontal</span>
            </div>
          ) : null}
          <div><span>Cameras</span><span>{mount.cameras.length}</span></div>
          <div><span>Daily traffic</span><span>{num(mount.passes)}</span></div>
          <div><span>Position</span><span>{coords(mount.lat, mount.lon)}</span></div>
        </div>
        <div style={{ marginTop: ".45rem" }}>
          {mount.cameras.map((index) => {
            const camera = fleet.cameras[index];
            return (
              <button
                key={camera.id}
                type="button"
                className={CAMERA_ROW}
                style={{ opacity: showsCamera(view, camera) ? 1 : 0.5 }}
                onClick={() => onSelect({ kind: "camera", index })}
              >
                <span
                  className={CAMERA_DOT}
                  style={{ background: cameraColor(fleet, view, camera, most) }}
                />
                <span>
                  {camera.id}
                  <i className={CAMERA_META}> · {compass(camera.azimuth)}</i>
                </span>
                <span className={CAMERA_META}>{num(camera.daily_passes)}/day</span>
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  const camera = fleet.cameras[selection.index];
  const mount = fleet.mountOf(camera);
  const optics = fleet.opticsOf(camera);
  const step = (delta: number) => {
    const next = camera.index + delta;
    if (next < 0 || next >= fleet.cameras.length) return;
    const target = fleet.cameras[next];
    onSelect({ kind: "camera", index: next });
    onGo(target.lat, target.lon);
  };

  return (
    <fieldset>
      <div className={SELECTED_HEAD}>
        <span className={SELECTED_TITLE}>{camera.id}</span>
        <button type="button" className={CAMERA_META} onClick={() => onSelect(null)}>
          clear
        </button>
      </div>
      <div className={SELECTED_KIND}>
        {ROLE_LABEL[camera.role]} · {camera.reads} plate
      </div>
      <Link className={READS_LINK} href={cameraHref(camera.id)}>
        <span>Detection records</span>
        <span className={CAMERA_META}>›</span>
      </Link>
      <div className={SELECTED_FACTS}>
        <div>
          <span>Street</span>
          <span>{camera.street ?? "Unnamed road"}</span>
        </div>
        <div><span>Direction</span><span>{compass(camera.azimuth)}</span></div>
        <div><span>Azimuth</span><span>{camera.azimuth.toFixed(1)}°</span></div>
        <div><span>Road class</span><span>{classLabel(camera.class)}</span></div>
        <div><span>Approach</span><span>{metres(camera.length_m)}</span></div>
        <div><span>Daily traffic</span><span>{num(camera.daily_passes)}</span></div>
        <div><span>Distinct drivers</span><span>{num(camera.distinct_drivers)}</span></div>
        <div>
          <span>Additional drivers</span>
          <span>+{num(camera.new_drivers)}</span>
        </div>
        <div>
          <span>Free flow</span>
          <span>{(camera.free_flow_mps * 3.6).toFixed(0)} km/h</span>
        </div>
        {camera.zone_seconds ? (
          <div>
            <span>Capture duration</span>
            <span>{camera.zone_seconds.toFixed(1)} s · ~{Math.round(camera.zone_seconds * 30)} frames</span>
          </div>
        ) : null}
        {optics ? (
          <div>
            <span>Capture zone</span>
            <span>{optics.capture_width_m} m at {optics.capture_distance_m} m · {optics.capture_fov_deg}°</span>
          </div>
        ) : null}
        {mount && optics ? (
          <div>
            <span>Depression</span>
            <span>{depression(mount, optics).toFixed(0)}° below horizontal</span>
          </div>
        ) : null}
        {mount ? (
          <div>
            <span>Mount</span>
            <span>{mount.id} · {MOUNT_LABEL[mount.kind]} at {mount.height_m} m</span>
          </div>
        ) : null}
        <div><span>Owner</span><span>{mount?.owner ?? OWNER_LABEL[camera.owner_kind]}</span></div>
        {camera.site ? (
          <div><span>Site</span><span>{camera.site}</span></div>
        ) : null}
        {camera.site_distance_m !== undefined ? (
          <div><span>From entrance</span><span>{metres(camera.site_distance_m)}</span></div>
        ) : null}
        {camera.network ? (
          <div><span>Network</span><span>{camera.network}</span></div>
        ) : null}
        <div><span>Position</span><span>{coords(camera.lat, camera.lon)}</span></div>
        <div><span>Graph edge</span><span>{camera.from_node} → {camera.to_node}</span></div>
      </div>

      <div className={SELECTED_NAV}>
        <button
          type="button"
          className={STEP_LINK}
          disabled={camera.index === 0}
          onClick={() => step(-1)}
        >
          ← previous
        </button>
        <span className={CAMERA_META}>
          {camera.index + 1} of {fleet.cameras.length}
        </span>
        <button
          type="button"
          className={STEP_LINK}
          disabled={camera.index === fleet.cameras.length - 1}
          onClick={() => step(1)}
        >
          next →
        </button>
      </div>

      {mount && mount.cameras.length > 1 ? (
        <button
          type="button"
          className={CAMERA_ROW}
          style={{ marginTop: ".4rem" }}
          onClick={() => {
            onSelect({ kind: "mount", index: mount.index });
            onGo(mount.lat, mount.lon, 18);
          }}
        >
          <span className={CAMERA_DOT} style={{ background: OWNER_COLOR[mount.owner_kind] }} />
          <span>{mount.id} · {mount.cameras.length} lenses</span>
          <span className={CAMERA_META}>›</span>
        </button>
      ) : null}
    </fieldset>
  );
}

export function DrawSection({
  fleet, view, patch, counts,
}: {
  fleet: CameraFleet;
  view: CameraView;
  patch: Patch;
  counts: ViewCounts;
}) {
  return (
    <fieldset>
      <legend>Draw</legend>
      <LayerToggle label="Mounts" checked={view.mounts} onChange={(on) => patch({ mounts: on })} />
      <LayerToggle
        label="Capture zones"
        checked={view.zones}
        onChange={(on) => patch({ zones: on })}
      />
      <LayerToggle
        label="Approaches"
        checked={view.approaches}
        onChange={(on) => patch({ approaches: on })}
      />
      <LayerToggle
        label="Labels"
        checked={view.labels}
        onChange={(on) => patch({ labels: on })}
      />

      <label className={PANEL_FIELD}>
        <span>Colour by</span>
        <NativeSelect
          value={view.colorBy}
          onChange={(event) => patch({ colorBy: event.target.value as ColorBy })}
        >
          {COLOR_BY.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </NativeSelect>
      </label>

      {view.zones ? (
        <label className={PANEL_FIELD}>
          <span>Zone scale ×{view.scale}</span>
          <input
            type="range"
            min={1}
            max={30}
            value={view.scale}
            onChange={(event) => patch({ scale: Number(event.target.value) })}
          />
        </label>
      ) : null}

      <dl className={PANEL_STATS}>
        <div><dt>Shown</dt><dd>{num(counts.cameras)} of {num(fleet.cameras.length)}</dd></div>
        <div><dt>Mounts</dt><dd>{num(counts.mounts)} of {num(fleet.mounts.length)}</dd></div>
        <div><dt>Daily traffic</dt><dd>{num(counts.passes)}</dd></div>
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

export function FilterSection({
  fleet, view, patch, facets,
}: {
  fleet: CameraFleet;
  view: CameraView;
  patch: Patch;
  facets: {
    roles: Map<Role, number>;
    owners: Map<OwnerKind, number>;
    classes: Map<string, number>;
  };
}) {
  return (
    <fieldset>
      <legend>Filter</legend>
      {ROLES.map((role) => (
        <div className={ROLE_ROW} key={role.id}>
          <label>
            <Checkbox
              checked={view.roles.has(role.id)}
              onCheckedChange={(v) => patch({ roles: toggle(view.roles, role.id, v === true) })}
            />
            <span className={POI_DOT} style={{ background: ROLE_COLOR[role.id] }} />
            <span>{role.label}</span>
            <span className={COUNT}>{num(facets.roles.get(role.id) ?? 0)}</span>
          </label>
        </div>
      ))}

      {(["police", "private"] as const).map((owner) => (
        <label className={LAYER_ROW} key={owner}>
          <Checkbox
            checked={view.owners.has(owner)}
            onCheckedChange={(v) => patch({ owners: toggle(view.owners, owner, v === true) })}
          />
          <span className={SWATCH} style={{ background: OWNER_COLOR[owner] }} />
          <span>{OWNER_LABEL[owner]}</span>
          <span className={COUNT}>{num(facets.owners.get(owner) ?? 0)}</span>
        </label>
      ))}

      {fleet.classes.map((entry) => (
        <label className={LAYER_ROW} key={entry.id}>
          <Checkbox
            checked={view.classes.has(entry.id)}
            onCheckedChange={(v) => patch({ classes: toggle(view.classes, entry.id, v === true) })}
          />
          <span className={SWATCH} style={{ background: fleet.classColor(entry.id) }} />
          <span>{entry.label}</span>
          <span className={COUNT}>{num(facets.classes.get(entry.id) ?? 0)}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function CoverageSection({ fleet }: { fleet: CameraFleet }) {
  const width = 244;
  const height = 72;
  const total = fleet.sitedFrom.distinct_drivers;
  const n = fleet.curve.length;
  const x = (index: number) => (index / Math.max(1, n - 1)) * width;
  const y = (value: number) => height - (value / total) * height;
  const path = fleet.curve
    .map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`)
    .join(" ");

  const bands = ROLES.map((role) => ({
    role: role.id,
    first: fleet.cameras.findIndex((camera) => camera.role === role.id),
    last: fleet.cameras.map((camera) => camera.role).lastIndexOf(role.id),
  })).filter((band) => band.first >= 0);

  return (
    <fieldset>
      <legend>Coverage</legend>
      <svg
        className={CURVE}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Coverage curve"
      >
        {bands.map((band) => (
          <rect
            key={band.role}
            x={x(band.first)}
            y={0}
            width={Math.max(1, x(band.last) - x(band.first))}
            height={height}
            fill={ROLE_COLOR[band.role]}
            opacity={0.09}
          />
        ))}
        <line x1={0} y1={height} x2={width} y2={height} stroke="currentColor" opacity={0.25} />
        <path d={path} fill="none" stroke="var(--primary)" strokeWidth={1.8}
          strokeLinejoin="round" />
      </svg>
      <div className={CURVE_CAPTION}>
        <span>1</span>
        <span>{num(fleet.driversReached)} of {num(total)} drivers · {percent(fleet.reach, 1)}</span>
        <span>{n}</span>
      </div>
      <p className={PANEL_NOTE}>Sited from {fleet.sitedFrom.day}</p>
    </fieldset>
  );
}

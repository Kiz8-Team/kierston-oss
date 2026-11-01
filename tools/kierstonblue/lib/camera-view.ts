import {
  CLASS_COLOR, OWNER_COLOR, ROLE_COLOR,
  type Camera, type CameraFleet, type OwnerKind, type Role,
} from "./cameras";

export type ColorBy = "role" | "owner" | "class" | "volume";

export const COLOR_BY: { id: ColorBy; label: string }[] = [
  { id: "role", label: "Tranche" },
  { id: "owner", label: "Owner" },
  { id: "class", label: "Road class" },
  { id: "volume", label: "Daily traffic" },
];

export interface CameraView {
  roles: Set<Role>;
  owners: Set<OwnerKind>;
  classes: Set<string>;
  mounts: boolean;
  zones: boolean;
  approaches: boolean;
  labels: boolean;
  scale: number;
  colorBy: ColorBy;
  opacity: number;
}

export type Selection =
  | { kind: "camera"; index: number }
  | { kind: "mount"; index: number };

export function fullView(fleet: CameraFleet): CameraView {
  return {
    roles: new Set<Role>(["cordon", "arterial", "commercial"]),
    owners: new Set<OwnerKind>(["police", "private"]),
    classes: new Set(fleet.classes.map((entry) => entry.id)),
    mounts: true,
    zones: true,
    approaches: false,
    labels: false,
    scale: 8,
    colorBy: "role",
    opacity: 0.45,
  };
}

export function showsCamera(view: CameraView, camera: Camera): boolean {
  if (!view.roles.has(camera.role)) return false;
  if (!view.owners.has(camera.owner_kind)) return false;
  if (!view.classes.has(camera.class)) return false;
  return true;
}

export interface ViewCounts {
  cameras: number;
  mounts: number;
  passes: number;
}

export function countView(fleet: CameraFleet, view: CameraView): ViewCounts {
  let cameras = 0;
  let mounts = 0;
  let passes = 0;

  for (const mount of fleet.mounts) {
    let here = 0;
    for (const index of mount.cameras) {
      const camera = fleet.cameras[index];
      if (!showsCamera(view, camera)) continue;
      here += 1;
      passes += camera.daily_passes;
    }
    if (!here) continue;
    cameras += here;
    mounts += 1;
  }

  return { cameras, mounts, passes };
}

export function busiest(fleet: CameraFleet): number {
  return fleet.cameras.reduce((most, camera) => Math.max(most, camera.daily_passes), 1);
}

const VOLUME_RAMP: [number, number, number][] = [
  [222, 232, 238],
  [96, 160, 214],
  [40, 84, 168],
  [176, 32, 96],
];

export function volumeColor(passes: number, most: number): string {
  const t = Math.log1p(Math.max(0, passes)) / Math.log1p(most);
  const scaled = Math.max(0, Math.min(1, t)) * (VOLUME_RAMP.length - 1);
  const index = Math.min(VOLUME_RAMP.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const mix = (i: number) => Math.round(
    VOLUME_RAMP[index][i] + (VOLUME_RAMP[index + 1][i] - VOLUME_RAMP[index][i]) * frac,
  );
  return `#${((mix(0) << 16) | (mix(1) << 8) | mix(2)).toString(16).padStart(6, "0")}`;
}

export function cameraColor(
  fleet: CameraFleet, view: CameraView, camera: Camera, most: number,
): string {
  if (view.colorBy === "role") return ROLE_COLOR[camera.role];
  if (view.colorBy === "owner") return OWNER_COLOR[camera.owner_kind];
  if (view.colorBy === "class") return CLASS_COLOR[camera.class] ?? "#8a97a3";
  return volumeColor(camera.daily_passes, most);
}

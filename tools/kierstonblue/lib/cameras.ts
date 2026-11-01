export type Role = "cordon" | "arterial" | "commercial";
export type OwnerKind = "police" | "private";
export type MountKind = "pole" | "mast_arm" | "storefront";

export interface Optics {
  id: string;
  label: string;
  capture_width_m: number;
  capture_distance_m: number;
  capture_fov_deg: number;
  body_mm: [number, number, number];
  mass_kg: number;
  mount: string;
  power: string;
  backhaul: string;
  note: string;
}

export interface MountRecord {
  id: string;
  node: number;
  lat: number;
  lon: number;
  kind: MountKind;
  height_m: number;
  owner: string;
  owner_kind: OwnerKind;
}

export interface CameraRecord {
  id: string;
  mount: string;
  role: Role;
  owner_kind: OwnerKind;
  reads: "rear" | "front";
  optics: string;
  edge: number;
  from_node: number;
  to_node: number;
  to_lat: number;
  to_lon: number;
  street: string | null;
  class: string;
  length_m: number;
  azimuth: number;
  daily_passes: number;
  distinct_drivers: number;
  free_flow_mps: number;
  zone_seconds: number | null;
  network?: string;
  site?: string;
  site_type?: string;
  site_distance_m?: number;
}

export interface SitedFrom {
  day: string;
  graph: string;
  vehicle_legs: number;
  edge_traversals: number;
  unresolved_traversals: number;
  distinct_drivers: number;
  note: string;
}

export interface CameraFile {
  city: string;
  centre: [number, number];
  budget: number;
  tranches: Record<Role, number>;
  sited_from: SitedFrom;
  modelled: string[];
  measured: string[];
  published: string[];
  optics: Record<string, Optics>;
  drivers_reached: number;
  drivers_by_role: Record<Role, number>;
  coverage_curve: number[];
  mounts: number;
  cameras: number;
  mount_records: MountRecord[];
  camera_records: CameraRecord[];
}

export interface Mount extends MountRecord {
  index: number;
  cameras: number[];
  roles: Role[];
  passes: number;
}

export interface Camera extends CameraRecord {
  index: number;
  mount_index: number;
  lat: number;
  lon: number;
  cumulative_drivers: number;
  new_drivers: number;
}

export interface RoadClass {
  id: string;
  label: string;
  cameras: number;
  passes: number;
}

export const ROLES: { id: Role; label: string }[] = [
  { id: "cordon", label: "Cordon" },
  { id: "arterial", label: "Arterial" },
  { id: "commercial", label: "Commercial" },
];

export const ROLE_LABEL: Record<Role, string> = {
  cordon: "Cordon", arterial: "Arterial", commercial: "Commercial",
};

export const ROLE_COLOR: Record<Role, string> = {
  cordon: "#d0021b",
  arterial: "#2a78d6",
  commercial: "#f0a800",
};

export const OWNER_LABEL: Record<OwnerKind, string> = {
  police: "Municipal", private: "Privately owned",
};

export const OWNER_COLOR: Record<OwnerKind, string> = {
  police: "#20303f", private: "#c26a00",
};

export const MOUNT_LABEL: Record<MountKind, string> = {
  pole: "Pole", mast_arm: "Mast arm", storefront: "Storefront bracket",
};

export const CLASS_ORDER = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential",
  "service",
];

export const CLASS_COLOR: Record<string, string> = {
  motorway: "#b02020", motorway_link: "#c85030",
  trunk: "#e06820", trunk_link: "#e88a3c",
  primary: "#f0a800", primary_link: "#e8bc50",
  secondary: "#2fa84f", secondary_link: "#5cb878",
  tertiary: "#1667d8", tertiary_link: "#5090e0",
  unclassified: "#8a4fd0", residential: "#8a97a3", service: "#b8c2cc",
};

const FALLBACK_COLOR = "#8a97a3";

export function classLabel(id: string): string {
  const words = id.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const EARTH_M = 6_371_000;

export function offset(
  lat: number, lon: number, bearing: number, metres: number,
): [number, number] {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / EARTH_M;
  const dLon = (metres * Math.sin(rad)) / (EARTH_M * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
}

export function captureZone(
  camera: Camera, optics: Optics, scale = 1, steps = 4,
): [number, number][] {
  const half = optics.capture_fov_deg / 2;
  const reach = optics.capture_distance_m * scale;
  const points: [number, number][] = [[camera.lat, camera.lon]];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = camera.azimuth - half + (optics.capture_fov_deg * i) / steps;
    points.push(offset(camera.lat, camera.lon, bearing, reach));
  }
  return points;
}

export function approachLine(camera: Camera): [number, number][] {
  return [[camera.lat, camera.lon], [camera.to_lat, camera.to_lon]];
}

export function depression(mount: Mount, optics: Optics): number {
  return (Math.atan(mount.height_m / optics.capture_distance_m) * 180) / Math.PI;
}

export function cameraLabel(camera: Camera): string {
  const where = camera.street ?? `${classLabel(camera.class)} slip road`;
  return `${where}, ${compass(camera.azimuth)}`;
}

const POINTS = [
  "northbound", "northeastbound", "eastbound", "southeastbound",
  "southbound", "southwestbound", "westbound", "northwestbound",
];

export function compass(azimuth: number): string {
  return POINTS[Math.round(((azimuth % 360) + 360) % 360 / 45) % 8];
}

export class CameraFleet {
  readonly city: string;
  readonly centre: [number, number];
  readonly budget: number;
  readonly tranches: Record<Role, number>;
  readonly sitedFrom: SitedFrom;
  readonly optics: Record<string, Optics>;
  readonly modelled: string[];
  readonly measured: string[];
  readonly published: string[];

  readonly mounts: Mount[] = [];
  readonly cameras: Camera[] = [];
  readonly classes: RoadClass[] = [];
  readonly curve: number[];
  readonly driversReached: number;
  readonly driversByRole: Record<Role, number>;

  private readonly mountById = new Map<string, number>();

  constructor(file: CameraFile) {
    this.city = file.city;
    this.centre = file.centre;
    this.budget = file.budget;
    this.tranches = file.tranches;
    this.sitedFrom = file.sited_from;
    this.optics = file.optics;
    this.modelled = file.modelled;
    this.measured = file.measured;
    this.published = file.published;
    this.curve = file.coverage_curve;
    this.driversReached = file.drivers_reached;
    this.driversByRole = file.drivers_by_role;

    for (const record of file.mount_records) {
      const index = this.mounts.length;
      this.mountById.set(record.id, index);
      this.mounts.push({ ...record, index, cameras: [], roles: [], passes: 0 });
    }

    file.camera_records.forEach((record, index) => {
      const mountIndex = this.mountById.get(record.mount) ?? -1;
      const host = mountIndex < 0 ? null : this.mounts[mountIndex];
      const before = index > 0 ? this.curve[index - 1] : 0;
      this.cameras.push({
        ...record,
        index,
        mount_index: mountIndex,
        lat: host?.lat ?? 0,
        lon: host?.lon ?? 0,
        cumulative_drivers: this.curve[index] ?? 0,
        new_drivers: (this.curve[index] ?? 0) - before,
      });
      if (!host) return;
      host.cameras.push(index);
      host.passes += record.daily_passes;
      if (!host.roles.includes(record.role)) host.roles.push(record.role);
    });

    this.classes = this.rollUpClasses();
  }

  private rollUpClasses(): RoadClass[] {
    const found = new Map<string, RoadClass>();
    for (const camera of this.cameras) {
      let entry = found.get(camera.class);
      if (!entry) {
        entry = { id: camera.class, label: classLabel(camera.class), cameras: 0, passes: 0 };
        found.set(camera.class, entry);
      }
      entry.cameras += 1;
      entry.passes += camera.daily_passes;
    }
    return [...found.values()].sort(
      (a, b) => CLASS_ORDER.indexOf(a.id) - CLASS_ORDER.indexOf(b.id),
    );
  }

  mountOf(camera: Camera): Mount | null {
    return camera.mount_index < 0 ? null : this.mounts[camera.mount_index];
  }

  opticsOf(camera: Camera): Optics | null {
    return this.optics[camera.optics] ?? null;
  }

  classColor(id: string): string {
    return CLASS_COLOR[id] ?? FALLBACK_COLOR;
  }

  inRole(role: Role): Camera[] {
    return this.cameras.filter((camera) => camera.role === role);
  }

  get shared(): number {
    return this.mounts.reduce((sum, mount) => sum + (mount.cameras.length > 1 ? 1 : 0), 0);
  }

  get passes(): number {
    return this.cameras.reduce((sum, camera) => sum + camera.daily_passes, 0);
  }

  get reach(): number {
    return this.driversReached / (this.sitedFrom.distinct_drivers || 1);
  }
}

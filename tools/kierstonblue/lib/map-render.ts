"use client";

import type * as L from "leaflet";
import type { AreaCell, AreaGrid, Metric, Scale } from "./analysis";
import { rampColor } from "./analysis";
import type { Building, BuildingData, Poi, PoiData, Topology } from "./datasets";
import type { Employment, Site } from "./employment";
import { BANDS, BAND_COLOR, type Band, type Enrollment, type School } from "./enrollment";
import type { Box } from "./grid";

import {
  DRAW_BUDGET, POI_HIT_RADIUS, ROAD_STYLES, WORKPLACE_GROUPS, buildingSize,
  maxRankForZoom, poiRadius, workplaceSize, type WorkplaceGroupId,
} from "./map-style";

/**
 * The canvas layers over the Leaflet map.
 *
 * Leaflet vector layers create a DOM node per feature, which a hundred
 * thousand road segments and seventy thousand buildings would not survive.
 * Everything here is drawn onto four canvases instead, batched into one
 * Path2D per colour, and clipped to the viewport through the spatial grids in
 * lib/grid.ts. React owns the controls and the popup; this class owns pixels.
 */

export interface RoadState {
  enabled: boolean;
  autoDetail: boolean;
  ranks: Set<number>;
}

export interface AnalysisState {
  enabled: boolean;
  grid: AreaGrid | null;
  metric: Metric | null;
  scale: Scale | null;
  opacity: number;
}

export interface WorkplaceState {
  groups: Set<WorkplaceGroupId>;
  /** Hide the sites nobody was assigned to. */
  staffedOnly: boolean;
}

export interface SchoolState {
  bands: Set<Band>;
  /** Hide the schools nobody was assigned to. */
  usedOnly: boolean;
  /**
   * Draw a line from every student's home to their school.
   *
   * The catchments assign_school.py produces are emergent rather than drawn, so
   * there is no polygon to show. The lines are the catchment: where they fan
   * out evenly a school is serving its neighbourhood, and where they reach
   * across other schools' territory one of them ran out of room.
   */
  catchments: boolean;
}

export interface RenderState {
  roads: RoadState;
  poiTypes: Set<number>;
  buildingCategories: Set<number>;
  dwellingsOnly: boolean;
  workplaces: WorkplaceState;
  schools: SchoolState;
  analysis: AnalysisState;
}

export interface DrawStats {
  zoom: number;
  visible: number;
  drawn: number;
  step: number;
  detailRank: number;
}

export type Selection =
  | { kind: "poi"; lat: number; lon: number; poi: Poi }
  | { kind: "building"; lat: number; lon: number; building: Building }
  | { kind: "site"; lat: number; lon: number; site: Site }
  | { kind: "school"; lat: number; lon: number; school: School }
  | { kind: "cell"; lat: number; lon: number; cell: AreaCell };

// Schools sit above workplaces: a school building is in both catalogues, and
// the education layer is the more specific claim about it. The catchment lines
// go under everything they connect, on the analysis canvas' neighbour.
const LAYER_ORDER = [
  "analysis", "catchments", "buildings", "topology", "workplaces", "schools", "pois",
] as const;
type LayerName = (typeof LAYER_ORDER)[number];

export class MapRenderer {
  readonly map: L.Map;
  private leaflet: typeof L;
  private canvases = {} as Record<LayerName, HTMLCanvasElement>;
  private contexts = {} as Record<LayerName, CanvasRenderingContext2D>;

  private topology: Topology | null = null;
  private pois: PoiData | null = null;
  private buildings: BuildingData | null = null;
  private employment: Employment | null = null;
  private enrollment: Enrollment | null = null;

  private state: RenderState;
  private queued = false;
  private zooming = false;

  onStats: (stats: DrawStats) => void = () => {};
  onSelect: (selection: Selection | null) => void = () => {};
  onFrame: () => void = () => {};

  constructor(leaflet: typeof L, container: HTMLElement, center: [number, number], state: RenderState) {
    this.leaflet = leaflet;
    this.state = state;

    this.map = leaflet.map(container, { zoomControl: true, preferCanvas: true }).setView(center, 13);
    leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(this.map);

    LAYER_ORDER.forEach((name, index) => {
      const canvas = document.createElement("canvas");
      // Stacked over the tiles and transparent to the pointer, so clicks reach
      // Leaflet underneath. Set here rather than in a stylesheet because the
      // canvases are created imperatively, one per layer.
      canvas.className = "pointer-events-none absolute inset-0";
      canvas.style.zIndex = String(440 + index * 5);
      container.appendChild(canvas);
      this.canvases[name] = canvas;
      this.contexts[name] = canvas.getContext("2d") as CanvasRenderingContext2D;
    });

    this.map.on("move resize", this.schedule);
    this.map.on("zoomstart", this.onZoomStart);
    this.map.on("zoomend", this.onZoomEnd);
    this.map.on("click", this.onClick);
    this.schedule();
  }

  destroy(): void {
    this.map.off();
    this.map.remove();
  }

  setState(state: RenderState): void {
    this.state = state;
    this.schedule();
  }

  setTopology(topology: Topology, fit = true): void {
    this.topology = topology;
    if (fit) {
      const { minLat, minLon, maxLat, maxLon } = topology.bounds;
      this.map.fitBounds(this.leaflet.latLngBounds([minLat, minLon], [maxLat, maxLon]),
        { padding: [20, 20] });
    }
    this.schedule();
  }

  setPois(pois: PoiData): void { this.pois = pois; this.schedule(); }
  setBuildings(buildings: BuildingData): void { this.buildings = buildings; this.schedule(); }
  setEmployment(employment: Employment): void { this.employment = employment; this.schedule(); }

  setEnrollment(enrollment: Enrollment): void {
    this.enrollment = enrollment;
    this.schedule();
  }

  schedule = (): void => {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(this.draw);
  };

  private onZoomStart = (): void => {
    this.zooming = true;
    // The canvases are painted in container space, so a zoom animation would
    // otherwise smear them across the frame.
    for (const name of LAYER_ORDER) this.canvases[name].style.visibility = "hidden";
    this.onFrame();
  };

  private onZoomEnd = (): void => {
    this.zooming = false;
    for (const name of LAYER_ORDER) this.canvases[name].style.visibility = "visible";
    this.schedule();
  };

  private box(): Box {
    const bounds = this.map.getBounds();
    return {
      south: bounds.getSouth(), north: bounds.getNorth(),
      west: bounds.getWest(), east: bounds.getEast(),
    };
  }

  rankLimit(): number {
    return this.state.roads.autoDetail
      ? maxRankForZoom(this.map.getZoom())
      : ROAD_STYLES.length - 1;
  }

  private resize(): void {
    const size = this.map.getSize();
    const ratio = window.devicePixelRatio || 1;
    for (const name of LAYER_ORDER) {
      const canvas = this.canvases[name];
      canvas.width = Math.round(size.x * ratio);
      canvas.height = Math.round(size.y * ratio);
      // A canvas is a replaced element: without an explicit CSS size it lays
      // out at its bitmap size, which is `ratio` times too large.
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      this.contexts[name].setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  }

  private draw = (): void => {
    this.queued = false;
    if (this.zooming) return;
    this.resize();
    const size = this.map.getSize();
    for (const name of LAYER_ORDER) this.contexts[name].clearRect(0, 0, size.x, size.y);

    this.drawAnalysis();
    this.drawBuildings();
    this.drawWorkplaces();
    this.drawCatchments();
    this.drawSchools();
    this.drawPois();
    this.drawRoads();
    this.onFrame();
  };

  // ---- Roads ---------------------------------------------------------------

  private visibleRoads(): number[] {
    const topology = this.topology;
    if (!topology || !this.state.roads.enabled) return [];
    const box = this.box();
    const limit = this.rankLimit();
    const ranks = this.state.roads.ranks;
    const found: number[] = [];
    topology.grid.query(box, (i) => {
      const rank = topology.ranks[i];
      if (rank > limit || !ranks.has(rank)) return;
      const o = i * 4;
      const aLat = topology.coords[o], aLon = topology.coords[o + 1];
      const bLat = topology.coords[o + 2], bLon = topology.coords[o + 3];
      if (Math.max(aLat, bLat) < box.south || Math.min(aLat, bLat) > box.north) return;
      if (Math.max(aLon, bLon) < box.west || Math.min(aLon, bLon) > box.east) return;
      found.push(i);
    });
    return found;
  }

  private drawRoads(): void {
    const topology = this.topology;
    const ctx = this.contexts.topology;
    const zoom = this.map.getZoom();
    if (!topology || !this.state.roads.enabled) {
      this.onStats({ zoom, visible: 0, drawn: 0, step: 1, detailRank: this.rankLimit() });
      return;
    }

    const visible = this.visibleRoads();

    // Keep every arterial, then sample the minor classes evenly so a dense
    // view stays within budget instead of stalling the frame.
    const perRank = ROAD_STYLES.map(() => 0);
    for (const i of visible) perRank[topology.ranks[i]] += 1;
    let kept = 0;
    let firstThinned: number = ROAD_STYLES.length;
    for (let rank = 0; rank < ROAD_STYLES.length; rank += 1) {
      if (kept + perRank[rank] > DRAW_BUDGET) { firstThinned = rank; break; }
      kept += perRank[rank];
    }
    let tail = 0;
    for (let rank = firstThinned; rank < ROAD_STYLES.length; rank += 1) tail += perRank[rank];
    const tailBudget = Math.max(DRAW_BUDGET - kept, 2000);
    const step = tail > tailBudget ? Math.ceil(tail / tailBudget) : 1;
    const sampled = ROAD_STYLES.map(() => 0);

    const paths = new Map<number, Path2D>();
    let drawn = 0;
    for (const i of visible) {
      const rank = topology.ranks[i];
      if (step > 1 && rank >= firstThinned && sampled[rank]++ % step !== 0) continue;
      let path = paths.get(rank);
      if (!path) paths.set(rank, (path = new Path2D()));
      const o = i * 4;
      const a = this.map.latLngToContainerPoint([topology.coords[o], topology.coords[o + 1]]);
      const b = this.map.latLngToContainerPoint([topology.coords[o + 2], topology.coords[o + 3]]);
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
      drawn += 1;
    }

    const scale = zoom >= 17 ? 1.5 : zoom >= 15 ? 1.2 : 1;
    ctx.lineCap = "round";
    // Minor classes first so arterials stay on top where they overlap.
    for (const rank of [...paths.keys()].sort((a, b) => b - a)) {
      const style = ROAD_STYLES[rank];
      const path = paths.get(rank) as Path2D;
      const width = style.width * scale;

      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = width + 2;
      ctx.stroke(path);

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = width;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;

    this.onStats({
      zoom, visible: visible.length, drawn, step, detailRank: this.rankLimit(),
    });
  }

  // ---- Points of interest --------------------------------------------------

  private visiblePois(): number[] {
    const pois = this.pois;
    if (!pois) return [];
    const box = this.box();
    const found: number[] = [];
    pois.grid.query(box, (i) => {
      const poi = pois.points[i];
      if (!this.state.poiTypes.has(poi[3])) return;
      if (poi[0] < box.south || poi[0] > box.north) return;
      if (poi[1] < box.west || poi[1] > box.east) return;
      found.push(i);
    });
    return found;
  }

  private drawPois(): void {
    const pois = this.pois;
    const ctx = this.contexts.pois;
    if (!pois) return;

    const radius = poiRadius(this.map.getZoom());
    // One path per colour keeps the fill/stroke state changes to a handful.
    const paths = new Map<number, Path2D>();
    for (const i of this.visiblePois()) {
      const poi = pois.points[i];
      const point = this.map.latLngToContainerPoint([poi[0], poi[1]]);
      let path = paths.get(poi[2]);
      if (!path) paths.set(poi[2], (path = new Path2D()));
      path.moveTo(point.x + radius, point.y);
      path.arc(point.x, point.y, radius, 0, Math.PI * 2);
    }

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    for (const [group, path] of paths) {
      ctx.fillStyle = pois.groups[group].color;
      ctx.fill(path);
      ctx.stroke(path);
    }
  }

  // ---- Buildings -----------------------------------------------------------

  buildingMatches(building: Building): boolean {
    if (!this.state.buildingCategories.has(building[2])) return false;
    if (this.state.dwellingsOnly && !building[11]) return false;
    return true;
  }

  private visibleBuildings(): number[] {
    const buildings = this.buildings;
    if (!buildings || !this.state.buildingCategories.size) return [];
    const box = this.box();
    const found: number[] = [];
    buildings.grid.query(box, (i) => {
      const building = buildings.points[i];
      if (!this.buildingMatches(building)) return;
      if (building[0] < box.south || building[0] > box.north) return;
      if (building[1] < box.west || building[1] > box.east) return;
      found.push(i);
    });
    return found;
  }

  private drawBuildings(): void {
    const buildings = this.buildings;
    const ctx = this.contexts.buildings;
    if (!buildings || !this.state.buildingCategories.size) return;

    const side = buildingSize(this.map.getZoom());
    const half = side / 2;
    // Squares distinguish a building centroid from a POI's circle at a glance.
    const paths = new Map<number, Path2D>();
    for (const i of this.visibleBuildings()) {
      const building = buildings.points[i];
      const point = this.map.latLngToContainerPoint([building[0], building[1]]);
      let path = paths.get(building[2]);
      if (!path) paths.set(building[2], (path = new Path2D()));
      path.rect(point.x - half, point.y - half, side, side);
    }

    ctx.globalAlpha = 0.75;
    for (const [category, path] of paths) {
      ctx.fillStyle = buildings.categories[category].color;
      ctx.fill(path);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Workplaces ----------------------------------------------------------

  siteMatches(site: Site): boolean {
    if (!this.state.workplaces.groups.has(site.group)) return false;
    if (this.state.workplaces.staffedOnly && !site.staff.length) return false;
    return true;
  }

  private visibleSites(): number[] {
    const employment = this.employment;
    if (!employment || !this.state.workplaces.groups.size) return [];
    const box = this.box();
    const found: number[] = [];
    employment.grid.query(box, (i) => {
      const site = employment.sites[i];
      if (!this.siteMatches(site)) return;
      if (site.lat < box.south || site.lat > box.north) return;
      if (site.lon < box.west || site.lon > box.east) return;
      found.push(i);
    });
    return found;
  }

  /**
   * Diamonds, sized by how many people were sent there.
   *
   * The shape has to differ from both a POI's circle and a building's square,
   * because a workplace is frequently the same coordinate as one of each. The
   * area carries the staff count so a district's employment centres stand out
   * without a second layer to read.
   */
  private drawWorkplaces(): void {
    const employment = this.employment;
    const ctx = this.contexts.workplaces;
    if (!employment || !this.state.workplaces.groups.size) return;

    const base = workplaceSize(this.map.getZoom());
    const paths = new Map<WorkplaceGroupId, Path2D>();
    for (const i of this.visibleSites()) {
      const site = employment.sites[i];
      const point = this.map.latLngToContainerPoint([site.lat, site.lon]);
      let path = paths.get(site.group);
      if (!path) paths.set(site.group, (path = new Path2D()));
      const half = base * (0.6 + Math.min(1.4, Math.sqrt(site.staff.length) / 6));
      path.moveTo(point.x, point.y - half);
      path.lineTo(point.x + half, point.y);
      path.lineTo(point.x, point.y + half);
      path.lineTo(point.x - half, point.y);
      path.closePath();
    }

    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.globalAlpha = 0.9;
    for (const group of WORKPLACE_GROUPS) {
      const path = paths.get(group.id);
      if (!path) continue;
      ctx.fillStyle = group.color;
      ctx.fill(path);
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Schools -------------------------------------------------------------

  schoolMatches(school: School): boolean {
    if (!school.bands.some((band) => this.state.schools.bands.has(band))) return false;
    if (this.state.schools.usedOnly && !school.students.length) return false;
    return true;
  }

  private visibleSchools(): number[] {
    const enrollment = this.enrollment;
    if (!enrollment || !this.state.schools.bands.size) return [];
    const box = this.box();
    const found: number[] = [];
    enrollment.grid.query(box, (i) => {
      const school = enrollment.schools[i];
      if (!this.schoolMatches(school)) return;
      if (school.lat < box.south || school.lat > box.north) return;
      if (school.lon < box.west || school.lon > box.east) return;
      found.push(i);
    });
    return found;
  }

  /**
   * Squares with a notch, sized by roll.
   *
   * A school is usually the same coordinate as a workplace diamond, a building
   * square and often a POI circle, so it needs a fifth shape. A rounded square
   * reads as distinct at four pixels, which is the size that matters — the
   * zoom where somebody is looking at a district rather than a street.
   */
  private drawSchools(): void {
    const enrollment = this.enrollment;
    const ctx = this.contexts.schools;
    if (!enrollment || !this.state.schools.bands.size) return;

    const base = workplaceSize(this.map.getZoom());
    const paths = new Map<Band, Path2D>();
    for (const i of this.visibleSchools()) {
      const school = enrollment.schools[i];
      const point = this.map.latLngToContainerPoint([school.lat, school.lon]);
      // A school teaching several bands is drawn in the first one it teaches,
      // which for the unbanded fallback is elementary — the band it will hold
      // most of, and the legend says the colour is the band it was named for.
      const band = school.bands.find((entry) => this.state.schools.bands.has(entry))
        ?? school.bands[0];
      let path = paths.get(band);
      if (!path) paths.set(band, (path = new Path2D()));
      const half = base * (0.7 + Math.min(1.5, Math.sqrt(school.students.length) / 14));
      path.roundRect(point.x - half, point.y - half, half * 2, half * 2, half * 0.35);
    }

    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.globalAlpha = 0.92;
    for (const band of BANDS) {
      const path = paths.get(band);
      if (!path) continue;
      ctx.fillStyle = BAND_COLOR[band];
      ctx.fill(path);
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A hairline from every visible student's home to their school.
   *
   * Only for the schools currently in view, and only when the layer asks for
   * it: 24,575 lines drawn unconditionally would cost more than the rest of
   * the map together. Coloured by the school's band so overlapping catchments
   * stay legible where two schools of different levels share a neighbourhood.
   */
  private drawCatchments(): void {
    const enrollment = this.enrollment;
    const ctx = this.contexts.catchments;
    if (!enrollment || !this.state.schools.catchments) return;
    if (!this.state.schools.bands.size) return;

    const paths = new Map<Band, Path2D>();
    let drawn = 0;
    for (const i of this.visibleSchools()) {
      const school = enrollment.schools[i];
      const band = school.bands.find((entry) => this.state.schools.bands.has(entry))
        ?? school.bands[0];
      let path = paths.get(band);
      if (!path) paths.set(band, (path = new Path2D()));
      const to = this.map.latLngToContainerPoint([school.lat, school.lon]);
      for (const index of school.students) {
        if (drawn >= DRAW_BUDGET) break;
        const from = this.map.latLngToContainerPoint(
          [enrollment.homeLat[index], enrollment.homeLon[index]]);
        path.moveTo(from.x, from.y);
        path.lineTo(to.x, to.y);
        drawn += 1;
      }
      if (drawn >= DRAW_BUDGET) break;
    }

    ctx.lineWidth = 0.6;
    // Faint enough that a thousand overlapping lines read as a density rather
    // than a solid block of colour.
    ctx.globalAlpha = 0.16;
    for (const band of BANDS) {
      const path = paths.get(band);
      if (!path) continue;
      ctx.strokeStyle = BAND_COLOR[band];
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Area analysis -------------------------------------------------------

  private drawAnalysis(): void {
    const { enabled, grid, metric, scale, opacity } = this.state.analysis;
    const ctx = this.contexts.analysis;
    if (!enabled || !grid || !metric || !scale) return;

    const box = this.box();
    ctx.globalAlpha = opacity;
    for (const cell of grid.cells) {
      if (cell.north < box.south || cell.south > box.north) continue;
      if (cell.east < box.west || cell.west > box.east) continue;
      const value = metric.value(cell);
      if (!Number.isFinite(value)) continue;
      const topLeft = this.map.latLngToContainerPoint([cell.north, cell.west]);
      const bottomRight = this.map.latLngToContainerPoint([cell.south, cell.east]);
      ctx.fillStyle = rampColor(scale.normalise(value));
      // A hairline overlap hides the seam between neighbouring cells that
      // rounding to device pixels would otherwise open up.
      ctx.fillRect(
        topLeft.x, topLeft.y,
        bottomRight.x - topLeft.x + 0.5, bottomRight.y - topLeft.y + 0.5,
      );
    }
    ctx.globalAlpha = 1;
  }

  private cellAt(lat: number, lon: number): AreaCell | null {
    const { grid } = this.state.analysis;
    if (!grid) return null;
    for (const cell of grid.cells) {
      if (lat >= cell.south && lat < cell.north && lon >= cell.west && lon < cell.east) return cell;
    }
    return null;
  }

  // ---- Selection -----------------------------------------------------------

  private onClick = (event: L.LeafletMouseEvent): void => {
    const origin = event.containerPoint;
    let best = POI_HIT_RADIUS;
    let hit: Selection | null = null;

    if (this.pois) {
      for (const i of this.visiblePois()) {
        const poi = this.pois.points[i];
        const point = this.map.latLngToContainerPoint([poi[0], poi[1]]);
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance < best) {
          best = distance;
          hit = { kind: "poi", lat: poi[0], lon: poi[1], poi };
        }
      }
    }
    // A school outranks the workplace at the same address: both catalogues
    // hold the building, and "1,300 children study here" is the more specific
    // claim than "40 people work here".
    if (!hit && this.enrollment) {
      best = workplaceSize(this.map.getZoom()) + 3;
      for (const i of this.visibleSchools()) {
        const school = this.enrollment.schools[i];
        const point = this.map.latLngToContainerPoint([school.lat, school.lon]);
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance < best) {
          best = distance;
          hit = { kind: "school", lat: school.lat, lon: school.lon, school };
        }
      }
    }
    // A workplace is a claim about a specific address, so it outranks the
    // building underneath it but not a POI, which is more specific still.
    if (!hit && this.employment) {
      best = workplaceSize(this.map.getZoom()) + 3;
      for (const i of this.visibleSites()) {
        const site = this.employment.sites[i];
        const point = this.map.latLngToContainerPoint([site.lat, site.lon]);
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance < best) {
          best = distance;
          hit = { kind: "site", lat: site.lat, lon: site.lon, site };
        }
      }
    }
    // Points of interest win ties: a building is the larger, vaguer target.
    if (!hit && this.buildings) {
      best = buildingSize(this.map.getZoom()) / 2 + 3;
      for (const i of this.visibleBuildings()) {
        const building = this.buildings.points[i];
        const point = this.map.latLngToContainerPoint([building[0], building[1]]);
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance < best) {
          best = distance;
          hit = { kind: "building", lat: building[0], lon: building[1], building };
        }
      }
    }
    // Nothing specific under the cursor: if an area layer is on, the click is
    // a question about the area itself.
    if (!hit && this.state.analysis.enabled) {
      const cell = this.cellAt(event.latlng.lat, event.latlng.lng);
      if (cell) {
        hit = {
          kind: "cell",
          lat: (cell.north + cell.south) / 2,
          lon: (cell.east + cell.west) / 2,
          cell,
        };
      }
    }

    this.onSelect(hit);
  };

  /** Where a selection sits on screen right now, for positioning the popup. */
  containerPoint(lat: number, lon: number): { x: number; y: number } {
    const point = this.map.latLngToContainerPoint([lat, lon]);
    return { x: point.x, y: point.y };
  }

  stillVisible(selection: Selection): boolean {
    if (selection.kind === "poi") return this.state.poiTypes.has(selection.poi[3]);
    if (selection.kind === "building") return this.buildingMatches(selection.building);
    if (selection.kind === "site") return this.siteMatches(selection.site);
    if (selection.kind === "school") return this.schoolMatches(selection.school);
    return this.state.analysis.enabled;
  }

}

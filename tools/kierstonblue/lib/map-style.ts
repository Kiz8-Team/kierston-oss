/** Road classes, drawn largest-first and revealed by zoom. */
export const ROAD_STYLES = [
  { label: "Motorway & trunk", color: "#d0021b", width: 4.2 },
  { label: "Primary", color: "#f5691f", width: 3.6 },
  { label: "Secondary", color: "#f0b400", width: 3.1 },
  { label: "Tertiary", color: "#2fa84f", width: 2.7 },
  { label: "Residential", color: "#1667d8", width: 2.2 },
  { label: "Service", color: "#8a4fd0", width: 1.7 },
  { label: "Paths & tracks", color: "#00a0a8", width: 1.4 },
] as const;

export const DRAW_BUDGET = 25_000;
export const POI_HIT_RADIUS = 9;

export function maxRankForZoom(zoom: number): number {
  if (zoom <= 10) return 0;
  if (zoom <= 11) return 1;
  if (zoom <= 12) return 2;
  if (zoom <= 13) return 3;
  if (zoom <= 14) return 4;
  if (zoom <= 15) return 5;
  return 6;
}

export function poiRadius(zoom: number): number {
  if (zoom <= 12) return 2.4;
  if (zoom <= 14) return 3.4;
  if (zoom <= 16) return 4.4;
  return 5.6;
}

export function buildingSize(zoom: number): number {
  if (zoom <= 13) return 2;
  if (zoom <= 15) return 3;
  if (zoom <= 17) return 4.5;
  return 6;
}

export function workplaceSize(zoom: number): number {
  if (zoom <= 12) return 3.2;
  if (zoom <= 14) return 4.4;
  if (zoom <= 16) return 5.8;
  return 7.4;
}

/**
 * Workplaces, grouped for the map legend and the site browser's filter.
 *
 * workplaces.py keeps the building's own OSM class, which runs to 46 values
 * with a long tail of one grandstand and one riding hall. What a reader wants
 * to separate is the kind of work: a warehouse from a surgery from a school.
 * `building=yes` and `building=commercial` are 76% of the stock and genuinely
 * say nothing, so they keep a group of their own rather than being guessed
 * into one of the others — the industries inside them were allocated, not
 * observed, and the legend should not hide that.
 */
export const WORKPLACE_GROUPS = [
  { id: "retail", label: "Retail and hospitality", color: "#eb6834" },
  { id: "office", label: "Offices and services", color: "#2a78d6" },
  { id: "industry", label: "Industry and storage", color: "#6b5b95" },
  { id: "health", label: "Health and care", color: "#d0021b" },
  { id: "education", label: "Education", color: "#eda100" },
  { id: "civic", label: "Civic and worship", color: "#1baf7a" },
  { id: "unclassified", label: "Unclassified buildings", color: "#8a97a3" },
  { id: "emergency", label: "Emergency services", color: "#00a0a8" },
  { id: "home", label: "Home-based", color: "#c26fa8" },
] as const;

export type WorkplaceGroupId = (typeof WORKPLACE_GROUPS)[number]["id"];

const GROUP_BY_CLASS: Record<string, WorkplaceGroupId> = {
  retail: "retail", supermarket: "retail", hotel: "retail", cinema: "retail",
  commercial: "unclassified", yes: "unclassified", container: "unclassified",
  grandstand: "unclassified", pavilion: "unclassified", cabin: "unclassified",
  ger: "unclassified", ruins: "unclassified", riding_hall: "unclassified",
  toilets: "unclassified", greenhouse: "unclassified", boathouse: "unclassified",
  office: "office", bank: "office", service: "office",
  funeral_home: "office", funeral_hall: "office",
  industrial: "industry", warehouse: "industry", manufacture: "industry",
  construction: "industry", hangar: "industry",
  hospital: "health", nursing_home: "health", shelter: "health",
  school: "education", college: "education", kindergarten: "education",
  library: "education", museum: "education",
  church: "civic", chapel: "civic", cathedral: "civic", synagogue: "civic",
  religious: "civic", rectory: "civic", government: "civic", public: "civic",
  civic: "civic", prison: "civic", train_station: "civic",
  fire_station: "emergency", police: "emergency", fire: "emergency",
};

/** The legend slot a site's OSM class falls in. */
export function workplaceGroup(klass: string): WorkplaceGroupId {
  return GROUP_BY_CLASS[klass] ?? "unclassified";
}

/**
 * How each dwelling-unit count was arrived at, worst-supported last. Shown in
 * the popup so an estimate is never mistaken for something OSM recorded.
 */
export const UNIT_SOURCES: Record<string, string> = {
  single: "single household, building type",
  tagged: "building:flats tag",
  area: "estimate, footprint × floors",
  levels: "estimate, floor count",
  "levels-tall": "rough, floor count above calibration",
  default: "rough, no floors or footprint",
};

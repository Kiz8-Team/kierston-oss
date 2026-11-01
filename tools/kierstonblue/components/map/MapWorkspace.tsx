"use client";

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  METRIC_BY_ID, METRICS, areaGrid, metricScale,
  type AreaGrid, type MetricId, type Scale,
} from "@/lib/analysis";
import {
  getBuildings, getCenter, getEmployment, getEnrollment, getLabels, getPois, getPopulation, getRents,
  getTopology, type BuildingData, type PoiData, type Topology,
} from "@/lib/datasets";
import type { Employment } from "@/lib/employment";
import type { Band, Enrollment } from "@/lib/enrollment";
import { num } from "@/lib/format";
import type { Labels } from "@/lib/labels";
import { ROAD_STYLES, type WorkplaceGroupId } from "@/lib/map-style";
import {
  MapRenderer, type DrawStats, type RenderState, type RoadState, type SchoolState,
  type Selection, type WorkplaceState,
} from "@/lib/map-render";
import type { Population } from "@/lib/population";
import { StatusText } from "@/components/browse/EmptyState";
import { AnalysisSection } from "./AnalysisSection";
import {
  BuildingSection, PoiSection, RoadSection, SchoolSection, WorkSection,
} from "./LayerPanel";
import { MapPopup, popupClass } from "./MapPopup";
import { MAP_PANEL, MAP_SHELL, MAP_SURFACE, PANEL_SCROLL } from "@/components/map/panel";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The map, its layer controls, and the popup.
 *
 * React owns every control and the popup contents; MapRenderer owns the
 * canvases. The two meet at exactly two places — a RenderState pushed down on
 * every change, and a selection pushed up on every click — which is what keeps
 * a 60 fps pan from touching the React tree at all.
 */
export function MapWorkspace() {
  const params = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const [topology, setTopology] = useState<Topology | null>(null);
  const [pois, setPois] = useState<PoiData | null>(null);
  const [buildings, setBuildings] = useState<BuildingData | null>(null);
  const [population, setPopulation] = useState<Population | null>(null);
  const [rents, setRents] = useState<(number | null)[] | null>(null);
  const [employment, setEmployment] = useState<Employment | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [labels, setLabels] = useState<Labels | null>(null);

  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [poiError, setPoiError] = useState<string | null>(null);
  const [buildingStatus, setBuildingStatus] = useState("Off");
  const [populationStatus, setPopulationStatus] = useState<string | null>(null);
  const [rentStatus, setRentStatus] = useState<string | null>(null);
  const [workStatus, setWorkStatus] = useState("Off");
  const [schoolStatus, setSchoolStatus] = useState("Off");

  const [roads, setRoads] = useState<RoadState>({
    enabled: true,
    autoDetail: true,
    ranks: new Set(ROAD_STYLES.map((_, rank) => rank)),
  });
  const [poiTypes, setPoiTypes] = useState<Set<number>>(new Set());
  const [buildingCategories, setBuildingCategories] = useState<Set<number>>(new Set());
  const [dwellingsOnly, setDwellingsOnly] = useState(false);
  const [residents, setResidents] = useState(false);
  const [workplaces, setWorkplaces] = useState<WorkplaceState>({
    groups: new Set<WorkplaceGroupId>(), staffedOnly: true,
  });
  const [schools, setSchools] = useState<SchoolState>({
    bands: new Set<Band>(), usedOnly: true, catchments: false,
  });

  const [analysisOn, setAnalysisOn] = useState(params.get("panel") === "analysis");
  const [metricId, setMetricId] = useState<MetricId>("density");
  const [cellSize, setCellSize] = useState(250);
  const [opacity, setOpacity] = useState(0.7);

  const [stats, setStats] = useState<DrawStats | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  const metric = METRIC_BY_ID.get(metricId) ?? METRICS[0];

  const grid: AreaGrid | null = useMemo(
    () => (population ? areaGrid(population, cellSize, rents) : null),
    [population, cellSize, rents],
  );
  const scale: Scale | null = useMemo(
    () => (grid ? metricScale(grid, metric) : null),
    [grid, metric],
  );

  const renderState: RenderState = useMemo(() => ({
    roads,
    poiTypes,
    buildingCategories,
    dwellingsOnly,
    workplaces,
    schools,
    analysis: { enabled: analysisOn, grid, metric, scale, opacity },
  }), [roads, poiTypes, buildingCategories, dwellingsOnly, workplaces, schools, analysisOn, grid,
    metric, scale, opacity]);

  // ---- The map itself -------------------------------------------------------

  useEffect(() => {
    let renderer: MapRenderer | null = null;
    let cancelled = false;

    // A deep link from a household or person row names the place to look at,
    // so the network's own bounds must not override it once it loads.
    const lat = Number(params.get("lat"));
    const lon = Number(params.get("lon"));
    const deepLink = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;

    (async () => {
      const [leaflet, center] = await Promise.all([
        import("leaflet").then((module) => module.default), getCenter(),
      ]);
      if (cancelled || !containerRef.current) return;
      renderer = new MapRenderer(leaflet, containerRef.current, center, renderState);
      renderer.onStats = setStats;
      renderer.onSelect = setSelection;
      rendererRef.current = renderer;
      if (deepLink) {
        renderer.map.setView([lat, lon], Number(params.get("zoom")) || 18);
        // Arriving from a household or a person means the buildings and their
        // residents are the point of the visit, so turn both on.
        void Promise.all([getBuildings(), getPopulation()]).then(([data, people]) => {
          if (cancelled) return;
          setBuildings(data);
          renderer?.setBuildings(data);
          setBuildingCategories(new Set(data.categories.map((_, index) => index)));
          setDwellingsOnly(true);
          setPopulation(people);
          setResidents(true);
        }).catch((error) => !cancelled && setBuildingStatus(message(error)));
      }
      // A link from the jobs or workplace browser is about work, so the layer
      // that answers "who works here" comes on with it.
      if (params.get("work")) {
        void Promise.all([getEmployment(), getLabels()]).then(([data, book]) => {
          if (cancelled) return;
          setEmployment(data);
          setLabels(book);
          renderer?.setEmployment(data);
          setWorkplaces((current) => ({
            ...current,
            groups: new Set(data.groups.map((group) => group.id)),
          }));
          setWorkStatus(`${num(data.workers)} workers · ${num(data.sites.length)} sites`);
        }).catch((error) => !cancelled && setWorkStatus(message(error)));
      }
      // A link from the students or schools browser is about school, so the
      // layer that answers "who studies here" comes on with it.
      if (params.get("school")) {
        void Promise.all([getEnrollment(), getPopulation(), getLabels()])
          .then(([data, people, book]) => {
            if (cancelled) return;
            setEnrollment(data);
            setPopulation(people);
            setLabels(book);
            renderer?.setEnrollment(data);
            setSchools((current) => ({
              ...current,
              bands: new Set(data.bands.map((band) => band.id)),
            }));
            setSchoolStatus(
              `${num(data.students)} students · ${num(data.schools.length)} schools`);
          }).catch((error) => !cancelled && setSchoolStatus(message(error)));
      }

      getTopology()
        .then((data) => {
          if (cancelled) return;
          setTopology(data);
          renderer?.setTopology(data, !deepLink);
        })
        .catch((error) => !cancelled && setTopologyError(message(error)));
      getPois()
        .then((data) => {
          if (cancelled) return;
          setPois(data);
          renderer?.setPois(data);
          // Open on the classifier's own "useful" set rather than every bench
          // and bin in the county.
          const useful = new Set<number>();
          for (const group of data.groups) {
            if (!group.default) continue;
            for (const type of group.types) useful.add(type.i);
          }
          setPoiTypes(useful);
        })
        .catch((error) => !cancelled && setPoiError(`POIs unavailable: ${message(error)}`));
    })();

    return () => {
      cancelled = true;
      renderer?.destroy();
      rendererRef.current = null;
    };
    // The map is created once; state reaches it through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(renderState);
  }, [renderState]);

  // ---- Popup placement ------------------------------------------------------

  const place = useCallback(() => {
    const renderer = rendererRef.current;
    const node = popupRef.current;
    if (!renderer || !node) return;
    if (!selection || !renderer.stillVisible(selection)) {
      node.style.display = "none";
      return;
    }
    const point = renderer.containerPoint(selection.lat, selection.lon);
    node.style.display = "block";
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y - 10}px`;
  }, [selection]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.onFrame = place;
    place();
    return () => { renderer.onFrame = () => {}; };
  }, [place]);

  // ---- On-demand datasets ---------------------------------------------------

  const loadBuildings = useCallback(async () => {
    if (buildings) return buildings;
    setBuildingStatus("Loading buildings…");
    try {
      const data = await getBuildings();
      setBuildings(data);
      rendererRef.current?.setBuildings(data);
      return data;
    } catch (error) {
      setBuildingStatus(`Buildings unavailable: ${message(error)}`);
      return null;
    }
  }, [buildings]);

  const loadPopulation = useCallback(async () => {
    if (population) return population;
    setPopulationStatus("Loading population…");
    try {
      const started = performance.now();
      const data = await getPopulation();
      setPopulation(data);
      setPopulationStatus(
        `${num(data.counts.persons)} people · ${num(data.counts.households)} households · `
        + `${Math.round(performance.now() - started)} ms`);
      return data;
    } catch (error) {
      setPopulationStatus(`Population unavailable: ${message(error)}`);
      return null;
    }
  }, [population]);

  // The area layer is only meaningful once the population is in memory, and
  // the deep link from the rail can turn it on before anything has loaded.
  useEffect(() => {
    if (analysisOn && !population) void loadPopulation();
  }, [analysisOn, population, loadPopulation]);

  useEffect(() => {
    if (!analysisOn || metricId !== "rent" || rents) return;
    setRentStatus("Loading rents…");
    void getRents().then((data) => {
      setRents(data);
      setRentStatus(null);
    }).catch((error) => setRentStatus(`Rents unavailable: ${message(error)}`));
  }, [analysisOn, metricId, rents]);

  const toggleBuildings = useCallback(async (on: boolean) => {
    if (!on) {
      setBuildingCategories(new Set());
      setDwellingsOnly(false);
      return;
    }
    // 17 MB, fetched the first time the layer is asked for rather than at boot.
    const data = buildings ?? await loadBuildings();
    if (!data) return;
    setBuildingCategories(new Set(data.categories.map((_, index) => index)));
  }, [buildings, loadBuildings]);

  const onResidents = useCallback(async (on: boolean) => {
    setResidents(on);
    if (on) await loadPopulation();
  }, [loadPopulation]);

  const loadEmployment = useCallback(async () => {
    if (employment) return employment;
    setWorkStatus("Loading employment…");
    try {
      const [data, book] = await Promise.all([getEmployment(), getLabels()]);
      setEmployment(data);
      setLabels(book);
      rendererRef.current?.setEmployment(data);
      setWorkStatus(`${num(data.workers)} workers · ${num(data.sites.length)} sites`);
      return data;
    } catch (error) {
      setWorkStatus(`Employment unavailable: ${message(error)}`);
      return null;
    }
  }, [employment]);

  const loadEnrollment = useCallback(async () => {
    if (enrollment) return enrollment;
    setSchoolStatus("Loading enrollment…");
    try {
      // The population comes along because a catchment line starts at a
      // student's home, which only the population can resolve.
      const [data, people, book] = await Promise.all([
        getEnrollment(), getPopulation(), getLabels(),
      ]);
      setEnrollment(data);
      setPopulation(people);
      setLabels(book);
      rendererRef.current?.setEnrollment(data);
      setSchoolStatus(
        `${num(data.students)} students · ${num(data.schools.length)} schools`);
      return data;
    } catch (error) {
      setSchoolStatus(`Enrollment unavailable: ${message(error)}`);
      return null;
    }
  }, [enrollment]);

  const toggleSchools = useCallback(async (on: boolean) => {
    if (!on) {
      setSchools((current) => ({ ...current, bands: new Set() }));
      return;
    }
    const data = enrollment ?? await loadEnrollment();
    if (!data) return;
    setSchools((current) => ({
      ...current,
      bands: new Set(data.bands.map((band) => band.id)),
    }));
  }, [enrollment, loadEnrollment]);

  const toggleWorkplaces = useCallback(async (on: boolean) => {
    if (!on) {
      setWorkplaces((current) => ({ ...current, groups: new Set() }));
      return;
    }
    // 10 MB of assignments, and it needs the population to resolve a
    // home-based worker's site, so it waits until the layer is asked for.
    const data = employment ?? await loadEmployment();
    if (!data) return;
    // Every group but the dwellings of people who work from home: there are
    // 4,500 of those and they would bury the actual workplaces.
    setWorkplaces((current) => ({
      ...current,
      groups: new Set(data.groups.map((group) => group.id).filter((id) => id !== "home")),
    }));
  }, [employment, loadEmployment]);

  const flyTo = useCallback((lat: number, lon: number) => {
    const map = rendererRef.current?.map;
    map?.setView([lat, lon], Math.max(map.getZoom(), 16));
  }, []);

  // Counted here rather than asked of the renderer, so that dragging the
  // opacity slider does not walk seventy thousand buildings on every frame.
  const buildingCounts = useMemo(() => {
    if (!buildings) return { shown: 0, units: 0 };
    let shown = 0;
    let units = 0;
    for (const building of buildings.points) {
      if (!buildingCategories.has(building[2])) continue;
      if (dwellingsOnly && !building[11]) continue;
      shown += 1;
      units += building[11];
    }
    return { shown, units };
  }, [buildings, buildingCategories, dwellingsOnly]);

  return (
    <div className={MAP_SHELL}>
      <div className={MAP_SURFACE} ref={containerRef} />

      <div ref={popupRef} className={popupClass(selection)}
           style={{ display: "none" }}>
        {selection ? (
          <MapPopup
            selection={selection}
            pois={pois}
            buildings={buildings}
            population={population}
            employment={workplaces.groups.size ? employment : null}
            enrollment={schools.bands.size ? enrollment : null}
            labels={labels}
            showResidents={residents}
            metric={metric}
          />
        ) : null}
      </div>

      <section className={MAP_PANEL}>
        <header>
          <h1>Map explorer</h1>
          <p>
            {topologyError
              ? <StatusText state="error">{topologyError}</StatusText>
              : topology
                ? `${num(topology.count)} road segments`
                : "Loading roads…"}
          </p>
        </header>
        <div className={PANEL_SCROLL}>
          <RoadSection topology={topology} state={roads} stats={stats} onChange={setRoads} />
          <PoiSection pois={pois} active={poiTypes} onChange={setPoiTypes} error={poiError} />
          <BuildingSection
            buildings={buildings}
            active={buildingCategories}
            onChange={setBuildingCategories}
            onToggleAll={toggleBuildings}
            dwellingsOnly={dwellingsOnly}
            onDwellingsOnly={setDwellingsOnly}
            residents={residents}
            onResidents={onResidents}
            status={buildingStatus}
            residentStatus={residents ? populationStatus : null}
            shown={buildingCounts.shown}
            units={buildingCounts.units}
          />
          <WorkSection
            employment={employment}
            state={workplaces}
            onChange={setWorkplaces}
            onToggleAll={toggleWorkplaces}
            status={workStatus}
          />
          <SchoolSection
            enrollment={enrollment}
            state={schools}
            onChange={setSchools}
            onToggleAll={toggleSchools}
            status={schoolStatus}
          />
          <AnalysisSection
            enabled={analysisOn}
            onEnabled={setAnalysisOn}
            metric={metric}
            onMetric={setMetricId}
            size={cellSize}
            onSize={setCellSize}
            opacity={opacity}
            onOpacity={setOpacity}
            grid={analysisOn ? grid : null}
            scale={analysisOn ? scale : null}
            status={analysisOn
              ? (!population ? populationStatus ?? "Loading population…"
                : metricId === "rent" ? rentStatus : null)
              : null}
            onFly={flyTo}
          />
        </div>
      </section>
    </div>
  );
}

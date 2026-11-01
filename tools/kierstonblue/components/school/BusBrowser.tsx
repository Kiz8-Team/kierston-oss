"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PERSON_LINK, PID, PersonLink } from "@/components/PersonLink";
import { Chip, CopyChip, VehicleChip, mapHref } from "@/components/console/Chip";
import { DataBrowser } from "@/components/browse/DataBrowser";
import {
  type BrowseColumn,
} from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { BusRouteMap } from "@/components/school/BusRouteMap";
import { useNames } from "@/components/useNames";
import { useSchoolTravel } from "@/components/useSchoolTravel";
import { clock } from "@/lib/employment";
import { BAND_LABEL, schoolLabel, type Band } from "@/lib/enrollment";
import { num, percent } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import {
  DIRECTION_LABEL, MODES, MODE_COLOR, MODE_LABEL, MODE_SHORT,
  type Bus, type Driver, type Rider, type Run, type SchoolMode, type SchoolTravel,
} from "@/lib/school-travel";
import { Swatch } from "@/components/Charts";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members,
} from "@/components/browse/detail";
import { cn } from "@/lib/utils";

/**
 * The school bus layer: the runs, the buses that cover them, the drivers who
 * take them out, and every student's answer to how they get to school.
 *
 * Four tables rather than one because they are four different objects with
 * four different keys, and the interesting questions are the joins between
 * them — which bus does the 7:12 elementary run and what else does it do that
 * morning, which driver has two buses in a day, which run is over its seats.
 * Each table's detail panel is where those joins are followed, so a row is
 * never a dead end.
 *
 * The run detail carries a map because a manifest is a list of corners and a
 * route is a shape, and no column of numbers makes a bad route look wrong the
 * way a drawn one does.
 */

type Tab = "runs" | "buses" | "drivers" | "riders";

type RunSort = "clock" | "riders-desc" | "minutes-desc" | "load-desc" | "drift-desc";
type BusSort = "runs-desc" | "riders-desc" | "occupied-desc" | "load-desc" | "vin";
type DriverSort = "runs-desc" | "occupied-desc" | "span-desc" | "person";
type RiderSort = "km-desc" | "km" | "person";

interface Filters {
  query: string;
  operator: string;
  band: "any" | Band;
  direction: "any" | "am" | "pm";
  staffing: "any" | "staffed" | "unstaffed";
  mode: "any" | SchoolMode;
  runSort: RunSort;
  busSort: BusSort;
  driverSort: DriverSort;
  riderSort: RiderSort;
}

const EMPTY: Filters = {
  query: "",
  operator: "any",
  band: "any",
  direction: "any",
  staffing: "any",
  mode: "any",
  runSort: "clock",
  busSort: "runs-desc",
  driverSort: "runs-desc",
  riderSort: "km-desc",
};

const RUN_BANDS: Band[] = ["elem", "middle", "high"];

export function BusBrowser() {
  const { travel, error } = useSchoolTravel();
  const names = useNames();
  const params = useSearchParams();

  const [tab, setTab] = useState<Tab>(() => {
    const wanted = params.get("tab");
    return wanted === "buses" || wanted === "drivers" || wanted === "riders" ? wanted : "runs";
  });
  const [filters, setFilters] = useState<Filters>(() => ({
    ...EMPTY, query: params.get("q") ?? "",
  }));
  const [selected, setSelected] = useState<Record<Tab, number | null>>({
    runs: null, buses: null, drivers: null, riders: null,
  });

  const select = (which: Tab, index: number | null) =>
    setSelected((current) => ({ ...current, [which]: index }));

  /** Follow a join out of one table and into the row it points at. */
  const open = (which: Tab, index: number) => {
    setTab(which);
    select(which, index);
    // The target row has to survive the filters that are on, or the table
    // would jump to a tab showing everything except the row just asked for.
    setFilters((current) => ({ ...current, query: "", operator: "any", staffing: "any" }));
  };

  const indices = useMemo(
    () => (travel ? filterRows(travel, tab, filters) : new Int32Array()),
    [travel, tab, filters],
  );

  const fields: FilterField[] = useMemo(() => {
    if (!travel) return [];
    const operators: FilterField = {
      type: "select",
      key: "operator",
      label: "Operator",
      options: [
        { value: "any", label: "Any operator" },
        ...travel.operators.map((operator) => ({
          value: String(operator.id), label: operator.name,
        })),
      ],
    };
    const search: FilterField = {
      type: "search",
      key: "query",
      label: "Search",
      placeholder: tab === "riders"
        ? "resident id, school OSM id"
        : "trip id, VIN, driver id, school id",
      grow: true,
    };

    if (tab === "runs") {
      return [
        search, operators,
        {
          type: "select", key: "band", advanced: true, label: "Band",
          options: [
            { value: "any", label: "Any band" },
            ...RUN_BANDS.map((band) => ({ value: band, label: BAND_LABEL[band] })),
          ],
        },
        {
          type: "select", key: "direction", label: "Direction",
          options: [
            { value: "any", label: "Both" },
            { value: "am", label: "Morning" },
            { value: "pm", label: "Afternoon" },
          ],
        },
        {
          type: "select", key: "staffing", advanced: true, label: "Staffing",
          options: [
            { value: "any", label: "Any" },
            { value: "staffed", label: "Staffed" },
            { value: "unstaffed", label: "Unstaffed" },
          ],
        },
        {
          type: "select", key: "runSort", label: "Sort",
          options: [
            { value: "clock", label: "Time of day" },
            { value: "riders-desc", label: "Most riders" },
            { value: "minutes-desc", label: "Longest" },
            { value: "load-desc", label: "Fullest" },
            { value: "drift-desc", label: "Estimate drift" },
          ],
        },
      ];
    }

    if (tab === "buses") {
      return [
        search, operators,
        {
          type: "select", key: "busSort", label: "Sort",
          options: [
            { value: "runs-desc", label: "Most trips" },
            { value: "riders-desc", label: "Most riders" },
            { value: "occupied-desc", label: "Longest out" },
            { value: "load-desc", label: "Fullest trip" },
            { value: "vin", label: "VIN" },
          ],
        },
      ];
    }

    if (tab === "drivers") {
      return [
        search, operators,
        {
          type: "select", key: "driverSort", label: "Sort",
          options: [
            { value: "runs-desc", label: "Most trips" },
            { value: "occupied-desc", label: "Longest driving" },
            { value: "span-desc", label: "Longest day" },
            { value: "person", label: "Resident id" },
          ],
        },
      ];
    }

    return [
      search,
      {
        type: "select", key: "band", label: "Band",
        options: [
          { value: "any", label: "Any band" },
          ...(["prek", ...RUN_BANDS, "college"] as Band[]).map((band) => ({
            value: band, label: BAND_LABEL[band],
          })),
        ],
      },
      {
        type: "select", key: "mode", label: "Mode",
        options: [
          { value: "any", label: "Any mode" },
          ...MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode] })),
        ],
      },
      {
        type: "select", key: "riderSort", label: "Sort",
        options: [
          { value: "km-desc", label: "Furthest" },
          { value: "km", label: "Nearest" },
          { value: "person", label: "Resident id" },
        ],
      },
    ];
  }, [travel, tab]);

  const columns = useMemo(
    () => (travel ? columnsFor(travel, tab, names) : []),
    [travel, tab, names],
  );

  const tabs = travel ? [
    { id: "runs", label: "Trips", count: travel.runs.length },
    { id: "buses", label: "Buses", count: travel.buses.length },
    { id: "drivers", label: "Drivers", count: travel.drivers.length },
    { id: "riders", label: "Students", count: travel.riders.length },
  ] : undefined;

  const chosen = selected[tab];
  const detail = travel && chosen !== null ? (
    tab === "runs" ? (
      <RunDetail
        travel={travel} run={travel.runs[chosen]} names={names}
        onOpen={open} onClose={() => select("runs", null)}
      />
    ) : tab === "buses" ? (
      <BusDetail
        travel={travel} bus={travel.buses[chosen]} names={names}
        onOpen={open} onClose={() => select("buses", null)}
      />
    ) : tab === "drivers" ? (
      <DriverDetail
        travel={travel} driver={travel.drivers[chosen]} names={names}
        onOpen={open} onClose={() => select("drivers", null)}
      />
    ) : (
      <RiderDetail
        travel={travel} rider={travel.riders[chosen]} names={names}
        onOpen={open} onClose={() => select("riders", null)}
      />
    )
  ) : null;

  return (
    <DataBrowser
      title="School buses"
      lead={travel ? lead(travel, tab) : error
        ? <StatusText state="error">{error}</StatusText>
        : "Loading…"}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      filters={fields}
      filterValues={filters as unknown as Record<string, string | boolean>}
      onFilterChange={(key, value) =>
        setFilters((current) => ({ ...current, [key]: value as string }))}
      table={travel ? {
        indices,
        columns,
        selected: chosen,
        onSelect: (index) => select(tab, index),
        empty: {
          title: "No matches",
          body: null,
          onClear: () => setFilters({ ...EMPTY, runSort: filters.runSort }),
        },
      } : null}
      detail={detail}
      loading={
        <EmptyState title={error ? "No school travel layer" : undefined}>
          {error ? (
            <p>
              <span className="font-sans text-[max(0.75rem,0.8em)]">python kierston/init/education/school_travel.py</span>
              <br />
              <span className="font-sans text-[max(0.75rem,0.8em)]">python kierston/init/init_sim.py</span>
            </p>
          ) : "Loading…"}
        </EmptyState>
      }
    />
  );
}

// ---- Header copy ------------------------------------------------------------

function lead(travel: SchoolTravel, tab: Tab): React.ReactNode {
  if (tab === "runs") {
    const timed = travel.runs.length - travel.untimed;
    return `${num(travel.runs.length)} trips · ${num(travel.seatedRiders)} boardings · `
      + `${num(travel.busesInService)} buses in service · ${num(timed)} timed`
      + `${travel.untimed ? ` · ${num(travel.untimed)} estimated` : ""}`
      + `${travel.unstaffed ? ` · ${num(travel.unstaffed)} unstaffed` : ""}`;
  }
  if (tab === "buses") {
    return `${num(travel.buses.length)} buses in service`;
  }
  if (tab === "drivers") {
    return `${num(travel.drivers.length)} drivers`;
  }
  const am = travel.modes.am;
  const total = travel.riders.length || 1;
  return [
    `${num(travel.riders.length)} students`,
    ...MODES
      .filter((mode) => am[mode])
      .map((mode) => `${MODE_SHORT[mode]} ${percent(am[mode] / total, 0)}`),
  ].join(" · ");
}

// ---- Columns ----------------------------------------------------------------

function load(run: Run): number | null {
  return run.seats ? run.riders / run.seats : null;
}

function columnsFor(travel: SchoolTravel, tab: Tab, names: Identity | null): BrowseColumn[] {
  if (tab === "runs") {
    return [
      {
        id: "run", header: "Trip", cell: (index) => {
          const run = travel.runs[index];
          return (
            <span title={run.id}>
              <Swatch color={MODE_COLOR.bus} />
              {BAND_LABEL[run.band]} · {run.direction === "am" ? "morning" : "afternoon"}
            </span>
          );
        },
      },
      {
        id: "operator", header: "Operator", width: "14rem",
        cell: (index) => travel.operatorOf(travel.runs[index])?.name ?? "—",
      },
      {
        id: "out", header: "Leaves yard", width: "7rem", align: "right",
        cell: (index) => clock(travel.runs[index].depotOut),
      },
      {
        id: "bell", header: "Bell", width: "6rem", align: "right",
        cell: (index) => clock(travel.runs[index].bell),
      },
      {
        id: "stops", header: "Stops", width: "5rem", align: "right",
        cell: (index) => num(travel.runs[index].stops.length),
      },
      {
        id: "riders", header: "Riders", width: "5.5rem", align: "right",
        cell: (index) => {
          const run = travel.runs[index];
          const share = load(run);
          return (
            <span title={run.seats ? `${run.riders} of ${run.seats} seats` : undefined}>
              {num(run.riders)}
              {share !== null ? (
                <i className={PID}> · {percent(share, 0)}</i>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "minutes", header: "In service", width: "6.5rem", align: "right",
        cell: (index) => {
          const run = travel.runs[index];
          return (
            <span title={run.timed
              ? `Estimate ${run.estimatedMinutes} min`
              : "Straight-line estimate"}>
              {num(run.minutes)} min{run.timed ? "" : " ~"}
            </span>
          );
        },
      },
      {
        id: "driver", header: "Driver", width: "12rem",
        cell: (index) => {
          const run = travel.runs[index];
          return run.driver !== null
            ? <PersonLink names={names} person={run.driver} />
            : <span className="text-destructive">none rostered</span>;
        },
      },
    ];
  }

  if (tab === "buses") {
    return [
      { id: "vin", header: "VIN", cell: (index) => <CopyChip kind="vehicle" value={travel.buses[index].vin} /> },
      {
        id: "operator", header: "Operator", width: "14rem",
        cell: (index) => travel.operatorById.get(travel.buses[index].operator)?.name ?? "—",
      },
      { id: "seats", header: "Seats", width: "5rem", align: "right", cell: (index) => num(travel.buses[index].seats) },
      { id: "runs", header: "Trips", width: "5rem", align: "right", cell: (index) => num(travel.buses[index].runs.length) },
      { id: "riders", header: "Boardings", width: "6.5rem", align: "right", cell: (index) => num(travel.buses[index].riders) },
      {
        id: "load", header: "Fullest", width: "6rem", align: "right",
        cell: (index) => {
          const bus = travel.buses[index];
          return bus.seats ? percent(bus.peakLoad, 0) : "—";
        },
      },
      {
        id: "occupied", header: "Out of yard", width: "7rem", align: "right",
        cell: (index) => `${num(travel.buses[index].occupied)} min`,
      },
      {
        id: "drivers", header: "Drivers", width: "6rem", align: "right",
        cell: (index) => num(travel.buses[index].drivers.length),
      },
    ];
  }

  if (tab === "drivers") {
    return [
      {
        id: "driver", header: "Driver",
        cell: (index) => <PersonLink names={names} person={travel.drivers[index].person} />,
      },
      {
        id: "operator", header: "Operator", width: "14rem",
        cell: (index) => travel.operatorById.get(travel.drivers[index].operator)?.name ?? "—",
      },
      { id: "runs", header: "Trips", width: "5rem", align: "right", cell: (index) => num(travel.drivers[index].runs.length) },
      { id: "buses", header: "Buses", width: "5rem", align: "right", cell: (index) => num(travel.drivers[index].buses.length) },
      { id: "riders", header: "Boardings", width: "6.5rem", align: "right", cell: (index) => num(travel.drivers[index].riders) },
      {
        id: "first", header: "First out", width: "6.5rem", align: "right",
        cell: (index) => clock(travel.drivers[index].firstOut),
      },
      {
        id: "last", header: "Last in", width: "6.5rem", align: "right",
        cell: (index) => clock(travel.drivers[index].lastIn),
      },
      {
        id: "driving", header: "Driving", width: "6rem", align: "right",
        cell: (index) => `${num(travel.drivers[index].occupied)} min`,
      },
    ];
  }

  return [
    {
      id: "student", header: "Student",
      cell: (index) => <PersonLink names={names} person={travel.riders[index].person} />,
    },
    {
      id: "band", header: "Band", width: "9rem",
      cell: (index) => BAND_LABEL[travel.riders[index].band],
    },
    {
      id: "school", header: "School", width: "16rem",
      cell: (index) => {
        const rider = travel.riders[index];
        const school = travel.schoolOf(rider.school);
        return school
          ? <Chip kind="place" href={mapHref(school.lat, school.lon)} title={rider.school ?? undefined}>{schoolLabel(school)}</Chip>
          : <span className="text-muted-foreground">outside the region</span>;
      },
    },
    {
      id: "km", header: "Distance", width: "6rem", align: "right",
      hint: "Straight-line distance",
      cell: (index) => `${travel.riders[index].km.toFixed(1)} km`,
    },
    {
      id: "am", header: "Morning", width: "7.5rem",
      cell: (index) => <ModeCell mode={travel.riders[index].am} />,
    },
    {
      id: "pm", header: "Afternoon", width: "7.5rem",
      cell: (index) => <ModeCell mode={travel.riders[index].pm} />,
    },
    {
      id: "fallback", header: "Fallback", width: "7.5rem",
      cell: (index) => {
        const fallback = travel.riders[index].fallbackAm;
        return fallback
          ? <span className="text-muted-foreground">{MODE_SHORT[fallback]}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
  ];
}

function ModeCell({ mode }: { mode: SchoolMode }) {
  return (
    <span title={MODE_LABEL[mode]}>
      <Swatch color={MODE_COLOR[mode]} />
      {MODE_SHORT[mode]}
    </span>
  );
}

// ---- Filtering --------------------------------------------------------------

function filterRows(travel: SchoolTravel, tab: Tab, filters: Filters): Int32Array {
  const needle = filters.query.trim().toLowerCase();
  const operator = filters.operator === "any" ? null : Number(filters.operator);

  if (tab === "runs") {
    const matches: number[] = [];
    for (const run of travel.runs) {
      if (operator !== null && run.operator !== operator) continue;
      if (filters.band !== "any" && run.band !== filters.band) continue;
      if (filters.direction !== "any" && run.direction !== filters.direction) continue;
      if (filters.staffing === "staffed" && run.driver === null) continue;
      if (filters.staffing === "unstaffed" && run.driver !== null) continue;
      if (needle
        && !run.id.toLowerCase().includes(needle)
        && !run.fingerprint.includes(needle)
        && !(run.vin ?? "").toLowerCase().includes(needle)
        && String(run.driver ?? "") !== needle
        && !run.schools.some((id) => id.toLowerCase().includes(needle))) continue;
      matches.push(run.index);
    }
    const runs = travel.runs;
    const drift = (i: number) => Math.abs(runs[i].estimatedMinutes - runs[i].minutes);
    const comparators: Record<RunSort, (x: number, y: number) => number> = {
      clock: (x, y) => runs[x].depotOut - runs[y].depotOut,
      "riders-desc": (x, y) => runs[y].riders - runs[x].riders,
      "minutes-desc": (x, y) => runs[y].minutes - runs[x].minutes,
      "load-desc": (x, y) => (load(runs[y]) ?? 0) - (load(runs[x]) ?? 0),
      "drift-desc": (x, y) => drift(y) - drift(x),
    };
    return Int32Array.from(matches.sort(comparators[filters.runSort]));
  }

  if (tab === "buses") {
    const matches: number[] = [];
    travel.buses.forEach((bus, index) => {
      if (operator !== null && bus.operator !== operator) return;
      if (needle
        && !bus.vin.toLowerCase().includes(needle)
        && !bus.drivers.some((person) => String(person) === needle)) return;
      matches.push(index);
    });
    const buses = travel.buses;
    const comparators: Record<BusSort, (x: number, y: number) => number> = {
      "runs-desc": (x, y) => buses[y].runs.length - buses[x].runs.length,
      "riders-desc": (x, y) => buses[y].riders - buses[x].riders,
      "occupied-desc": (x, y) => buses[y].occupied - buses[x].occupied,
      "load-desc": (x, y) => buses[y].peakLoad - buses[x].peakLoad,
      vin: (x, y) => buses[x].vin.localeCompare(buses[y].vin),
    };
    return Int32Array.from(matches.sort(comparators[filters.busSort]));
  }

  if (tab === "drivers") {
    const matches: number[] = [];
    travel.drivers.forEach((driver, index) => {
      if (operator !== null && driver.operator !== operator) return;
      if (needle
        && String(driver.person) !== needle
        && !driver.buses.some((vin) => vin.toLowerCase().includes(needle))) return;
      matches.push(index);
    });
    const drivers = travel.drivers;
    const comparators: Record<DriverSort, (x: number, y: number) => number> = {
      "runs-desc": (x, y) => drivers[y].runs.length - drivers[x].runs.length,
      "occupied-desc": (x, y) => drivers[y].occupied - drivers[x].occupied,
      "span-desc": (x, y) =>
        (drivers[y].lastIn - drivers[y].firstOut) - (drivers[x].lastIn - drivers[x].firstOut),
      person: (x, y) => drivers[x].person - drivers[y].person,
    };
    return Int32Array.from(matches.sort(comparators[filters.driverSort]));
  }

  const matches: number[] = [];
  for (const rider of travel.riders) {
    if (filters.band !== "any" && rider.band !== filters.band) continue;
    // Either direction counts: a student bussed one way and driven the other
    // belongs in both answers, and dropping them from one would understate it.
    if (filters.mode !== "any" && rider.am !== filters.mode && rider.pm !== filters.mode) continue;
    if (needle
      && String(rider.person) !== needle
      && !(rider.school ?? "").toLowerCase().includes(needle)) continue;
    matches.push(rider.index);
  }
  const riders = travel.riders;
  const comparators: Record<RiderSort, (x: number, y: number) => number> = {
    "km-desc": (x, y) => riders[y].km - riders[x].km,
    km: (x, y) => riders[x].km - riders[y].km,
    person: (x, y) => riders[x].person - riders[y].person,
  };
  return Int32Array.from(matches.sort(comparators[filters.riderSort]));
}

// ---- Detail panels ----------------------------------------------------------

type Opener = (tab: Tab, index: number) => void;

function RunDetail({ travel, run, names, onOpen, onClose }: {
  travel: SchoolTravel; run: Run; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const operator = travel.operatorOf(run);
  const bus = run.vin ? travel.buses.findIndex((entry) => entry.vin === run.vin) : -1;
  const driver = run.driver !== null
    ? travel.drivers.findIndex((entry) => entry.person === run.driver)
    : -1;
  const share = load(run);
  const drift = run.minutes - run.estimatedMinutes;

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={`${BAND_LABEL[run.band]} · ${operator?.name ?? "Unknown operator"}`}>
        {DIRECTION_LABEL[run.direction]} trip
      </DetailLead>

      <BusRouteMap travel={travel} run={run} />

      <DetailHeading>Clock</DetailHeading>
      <Facts cols={3}>
        <Fact label="Departure">{clock(run.depotOut)}</Fact>
        <Fact label={run.direction === "am" ? "Last bell" : "First release"}>{clock(run.bell)}</Fact>
        <Fact label="Return">{clock(run.depotOut + run.occupied)}</Fact>
        <Fact label="In service">{num(run.minutes)} min{run.timed ? "" : " (estimated)"}</Fact>
        <Fact label="Yard to yard">{num(run.occupied)} min</Fact>
        {run.timed ? (
          <Fact label="Estimated">
            {num(run.estimatedMinutes)} min
            <i className={PID}> · {drift >= 0 ? "+" : "−"}{num(Math.abs(drift))}</i>
          </Fact>
        ) : null}
      </Facts>

      <DetailHeading>Vehicle and crew</DetailHeading>
      <Facts>
        <Fact label="Bus">
          {run.vin ? (
            bus >= 0
              ? <button type="button" className={PERSON_LINK} onClick={() => onOpen("buses", bus)}>{run.vin}</button>
              : run.vin
          ) : <span className="text-destructive">None assigned</span>}
        </Fact>
        <Fact label="Driver">
          {run.driver !== null ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <PersonLink names={names} person={run.driver} />
              {driver >= 0 ? (
                <button type="button" className={PERSON_LINK} onClick={() => onOpen("drivers", driver)}>
                  Day
                </button>
              ) : null}
            </span>
          ) : <span className="text-destructive">None rostered</span>}
        </Fact>
        <Fact label="Seats">{run.seats ? num(run.seats) : "—"}</Fact>
        <Fact label="Riders">
          {num(run.riders)}
          {share !== null ? <i className={PID}> · {percent(share, 0)} full</i> : null}
        </Fact>
        <Fact label="Trip id"><CopyChip value={run.id} /></Fact>
        <Fact label="Fingerprint"><CopyChip value={run.fingerprint} /></Fact>
      </Facts>

      <DetailHeading>
        {run.schools.length === 1 ? "School" : "Schools"}
        {run.schools.length > 1 ? <small className="text-muted-foreground tabular-nums">{run.schools.length}</small> : null}
      </DetailHeading>
      <div className="flex flex-wrap gap-1.5">
        {run.schools.map((id) => {
          const school = travel.schoolOf(id);
          return (
            <Chip key={id} kind="place" href={`/schools?school=${encodeURIComponent(id)}`}>
              {school ? schoolLabel(school) : id}
            </Chip>
          );
        })}
      </div>

      <DetailHeading>
        Route
        <small className="text-muted-foreground tabular-nums">{num(run.stops.length)} stops</small>
      </DetailHeading>
      <Members>
        {run.stops.map((stop, index) => (
          <Member key={`${stop.lat},${stop.lon},${index}`}>
            <Facts cols={3}>
              <Fact label="Stop">{run.direction === "am" ? index + 1 : run.stops.length - index}</Fact>
              <Fact label="Riders">{stop.riders.length}</Fact>
              <Fact label="Position">{stop.lat.toFixed(4)}, {stop.lon.toFixed(4)}</Fact>
            </Facts>
            <div className="flex flex-wrap items-center gap-1.5">
              {stop.riders.slice(0, 4).map((person) => (
                <PersonLink key={person} names={names} person={person} />
              ))}
              {stop.riders.length > 4 ? (
                <span className="text-[0.76rem] text-muted-foreground">+{stop.riders.length - 4}</span>
              ) : null}
            </div>
          </Member>
        ))}
      </Members>
    </Drawer>
  );
}

function BusDetail({ travel, bus, names, onOpen, onClose }: {
  travel: SchoolTravel; bus: Bus; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const operator = travel.operatorById.get(bus.operator);
  const runs = bus.runs.map((index) => travel.runs[index]);
  const firstOut = Math.min(...runs.map((run) => run.depotOut));
  const lastIn = Math.max(...runs.map((run) => run.depotOut + run.occupied));

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={`School bus · ${operator?.name ?? "Unknown operator"}`}>
        <VehicleChip vin={bus.vin} />
      </DetailLead>

      <Facts cols={3}>
        <Fact label="Seats">{num(bus.seats)}</Fact>
        <Fact label="Trips">{num(bus.runs.length)}</Fact>
        <Fact label="Boardings">{num(bus.riders)}</Fact>
        <Fact label="Fullest trip">{bus.seats ? percent(bus.peakLoad, 0) : "—"}</Fact>
        <Fact label="Out of yard">{num(bus.occupied)} min</Fact>
        <Fact label="First out">{clock(firstOut)}</Fact>
        <Fact label="Last back">{clock(lastIn)}</Fact>
      </Facts>

      <DetailHeading>
        Trips
        <small className="text-muted-foreground tabular-nums">{runs.length}</small>
      </DetailHeading>
      <Members>
        {runs.map((run) => (
          <Member key={run.id}>
            <button type="button" className={cn(PERSON_LINK, "justify-self-start")} onClick={() => onOpen("runs", run.index)}>
              {BAND_LABEL[run.band]} · {run.direction === "am" ? "Morning" : "Afternoon"}
            </button>
            <Facts cols={3}>
              <Fact label="Out">{clock(run.depotOut)}</Fact>
              <Fact label="Back">{clock(run.depotOut + run.occupied)}</Fact>
              <Fact label="Riders">{num(run.riders)}</Fact>
              <Fact label="Driver">
                {run.driver !== null ? <PersonLink names={names} person={run.driver} /> : "None"}
              </Fact>
            </Facts>
          </Member>
        ))}
      </Members>
    </Drawer>
  );
}

function DriverDetail({ travel, driver, names, onOpen, onClose }: {
  travel: SchoolTravel; driver: Driver; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const operator = travel.operatorById.get(driver.operator);
  const runs = driver.runs.map((index) => travel.runs[index]);
  const span = driver.lastIn - driver.firstOut;

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={`School bus driver · ${operator?.name ?? "Unknown operator"}`}>
        <PersonLink names={names} person={driver.person} />
      </DetailLead>

      <Facts cols={3}>
        <Fact label="Trips">{num(driver.runs.length)}</Fact>
        <Fact label="Buses">{num(driver.buses.length)}</Fact>
        <Fact label="Boardings">{num(driver.riders)}</Fact>
        <Fact label="First out">{clock(driver.firstOut)}</Fact>
        <Fact label="Last in">{clock(driver.lastIn)}</Fact>
        <Fact label="Driving">{num(driver.occupied)} min</Fact>
        <Fact label="Day span">{num(span)} min</Fact>
        <Fact label="Midday gap">{num(Math.max(0, span - driver.occupied))} min</Fact>
      </Facts>

      <DetailHeading>
        Trips
        <small className="text-muted-foreground tabular-nums">{runs.length}</small>
      </DetailHeading>
      <Members>
        {runs.map((run) => (
          <Member key={run.id}>
            <button type="button" className={cn(PERSON_LINK, "justify-self-start")} onClick={() => onOpen("runs", run.index)}>
              {BAND_LABEL[run.band]} · {run.direction === "am" ? "Morning" : "Afternoon"}
            </button>
            <Facts cols={3}>
              <Fact label="Out">{clock(run.depotOut)}</Fact>
              <Fact label="Back">{clock(run.depotOut + run.occupied)}</Fact>
              <Fact label="Bus">{run.vin ? <VehicleChip vin={run.vin} /> : "None"}</Fact>
            </Facts>
          </Member>
        ))}
      </Members>
    </Drawer>
  );
}

function RiderDetail({ travel, rider, names, onOpen, onClose }: {
  travel: SchoolTravel; rider: Rider; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const school = travel.schoolOf(rider.school);
  const legs: { label: string; mode: SchoolMode; escort: number | null; fallback: SchoolMode | null; run: number }[] = [
    { label: "Morning", mode: rider.am, escort: rider.escortAm, fallback: rider.fallbackAm, run: rider.runAm },
    { label: "Afternoon", mode: rider.pm, escort: rider.escortPm, fallback: rider.fallbackPm, run: rider.runPm },
  ];

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={`Student · ${BAND_LABEL[rider.band]}`}>
        <PersonLink names={names} person={rider.person} />
      </DetailLead>

      <Facts>
        <Fact label="School" wide>
          {rider.school ? (
            <Chip kind="place" href={`/schools?school=${encodeURIComponent(rider.school)}`}>
              {schoolLabel(school)}
            </Chip>
          ) : "Outside the region"}
        </Fact>
        <Fact label="Distance">{rider.km.toFixed(2)} km</Fact>
        {travel.escorting.has(rider.person) ? <Fact label="Escort">Yes</Fact> : null}
      </Facts>

      {legs.map((leg) => (
        <div key={leg.label}>
          <DetailHeading>{leg.label}</DetailHeading>
          <Facts>
            <Fact label="Mode">
              <Swatch color={MODE_COLOR[leg.mode]} />
              {MODE_LABEL[leg.mode]}
            </Fact>
            {leg.fallback ? <Fact label="Fallback">{MODE_LABEL[leg.fallback]}</Fact> : null}
            {leg.escort !== null ? (
              <Fact label="Driver"><PersonLink names={names} person={leg.escort} /></Fact>
            ) : null}
            {leg.run >= 0 ? (
              <Fact label="Bus trip">
                <button
                  type="button"
                  className={PERSON_LINK}
                  onClick={() => onOpen("runs", leg.run)}
                >
                  {BAND_LABEL[travel.runs[leg.run].band]} · {clock(travel.runs[leg.run].depotOut)}
                </button>
              </Fact>
            ) : null}
          </Facts>
        </div>
      ))}
    </Drawer>
  );
}

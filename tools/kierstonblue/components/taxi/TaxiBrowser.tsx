"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PERSON_LINK, PID, PersonLink } from "@/components/PersonLink";
import { DataBrowser } from "@/components/browse/DataBrowser";
import {
  type BrowseColumn,
} from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { TaxiMap } from "@/components/taxi/TaxiMap";
import { useNames } from "@/components/useNames";
import { useTaxi } from "@/components/useTaxi";
import { clock, siteLabel } from "@/lib/employment";
import { coords, num, percent } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import {
  WATCHES, WATCH_COLOR, WATCH_LABEL, shiftSpan, standColor,
  type Driver, type Rider, type Stand, type TaxiFleet, type Watch,
} from "@/lib/taxi";
import { Swatch } from "@/components/Charts";
import { Chip, VehicleChip, mapHref } from "@/components/console/Chip";
import { cn } from "@/lib/utils";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members,
} from "@/components/browse/detail";

/**
 * The taxi trade in this city: eight ranks, the drivers who keep them, and the
 * people whose commute is a cab.
 *
 * Three tables because they are three objects with three keys, and the joins
 * between them are the interesting part — which rank a driver waits at, which
 * rank would answer a given rider's morning, and how far each of them is from
 * the other. Every row leads into another table rather than ending.
 *
 * What is deliberately not here
 * -----------------------------
 * Fares. Not one of the numbers on this page is a journey anybody took: a fare
 * exists because a simulated day put somebody somewhere at a minute, and the
 * dispatcher matched a car to it, and that happens in kierston/sim against a
 * date. Until this app can ask for a date, what it can honestly show is the
 * standing arrangement the dispatcher works within — where the cars wait, when
 * they are staffed, and where the demand they are waiting for lives.
 *
 * The page says so in as many words rather than letting a reader assume the
 * rider table is a list of taxi trips. It is a list of census answers.
 */

type Tab = "stands" | "drivers" | "riders";

type StandSort = "mass-desc" | "drivers-desc" | "cover-desc" | "id";
type DriverSort = "person" | "km" | "km-desc" | "start";
type RiderSort = "km-desc" | "km" | "person" | "depart";

interface Filters {
  query: string;
  stand: string;
  watch: "any" | Watch;
  standSort: StandSort;
  driverSort: DriverSort;
  riderSort: RiderSort;
}

const EMPTY: Filters = {
  query: "",
  stand: "any",
  watch: "any",
  standSort: "mass-desc",
  driverSort: "person",
  riderSort: "km-desc",
};

export function TaxiBrowser() {
  const { fleet, error } = useTaxi();
  const names = useNames();
  const params = useSearchParams();

  const [tab, setTab] = useState<Tab>(() => {
    const wanted = params.get("tab");
    return wanted === "drivers" || wanted === "riders" ? wanted : "stands";
  });
  const [filters, setFilters] = useState<Filters>(() => ({
    ...EMPTY, query: params.get("q") ?? "",
  }));
  const [selected, setSelected] = useState<Record<Tab, number | null>>({
    stands: null, drivers: null, riders: null,
  });

  const select = (which: Tab, index: number | null) =>
    setSelected((current) => ({ ...current, [which]: index }));

  /** Follow a join out of one table and into the row it points at. */
  const open = (which: Tab, index: number) => {
    setTab(which);
    select(which, index);
    // The target row has to survive whatever is filtered, or the table jumps
    // to a tab showing everything except the row just asked for.
    setFilters((current) => ({ ...current, query: "", stand: "any", watch: "any" }));
  };

  const indices = useMemo(
    () => (fleet ? filterRows(fleet, tab, filters) : new Int32Array()),
    [fleet, tab, filters],
  );

  const fields: FilterField[] = useMemo(() => {
    if (!fleet) return [];
    const search: FilterField = {
      type: "search",
      key: "query",
      label: "Search",
      placeholder: tab === "stands" ? "stand id" : "resident id or workplace OSM id",
      grow: true,
    };
    const stand: FilterField = {
      type: "select",
      key: "stand",
      label: "Stand",
      options: [
        { value: "any", label: "Any stand" },
        ...fleet.stands.map((row) => ({
          value: String(row.index),
          label: `${row.id} · ${num(row.mass)} demand`,
        })),
      ],
    };

    if (tab === "stands") {
      return [
        search,
        {
          type: "select", key: "standSort", label: "Sort",
          options: [
            { value: "mass-desc", label: "Busiest catchment" },
            { value: "drivers-desc", label: "Most drivers" },
            { value: "cover-desc", label: "Most demand per driver" },
            { value: "id", label: "Stand id" },
          ],
        },
      ];
    }

    if (tab === "drivers") {
      return [
        search, stand,
        {
          type: "select", key: "watch", label: "Watch",
          options: [
            { value: "any", label: "Any watch" },
            ...WATCHES.map((watch) => ({ value: watch, label: WATCH_LABEL[watch] })),
          ],
        },
        {
          type: "select", key: "driverSort", label: "Sort",
          options: [
            { value: "person", label: "Resident id" },
            { value: "km-desc", label: "Furthest from stand" },
            { value: "km", label: "Nearest to stand" },
            { value: "start", label: "Shift start" },
          ],
        },
      ];
    }

    return [
      search, stand,
      {
        type: "select", key: "riderSort", label: "Sort",
        options: [
          { value: "km-desc", label: "Longest commute" },
          { value: "km", label: "Shortest commute" },
          { value: "depart", label: "Departure" },
          { value: "person", label: "Resident id" },
        ],
      },
    ];
  }, [fleet, tab]);

  const columns = useMemo(
    () => (fleet ? columnsFor(fleet, tab, names) : []),
    [fleet, tab, names],
  );

  const tabs = fleet ? [
    { id: "stands", label: "Stands", count: fleet.stands.length },
    { id: "drivers", label: "Drivers", count: fleet.drivers.length },
    { id: "riders", label: "Riders", count: fleet.riders.length },
  ] : undefined;

  const chosen = selected[tab];
  const detail = fleet && chosen !== null ? (
    tab === "stands" ? (
      <StandDetail
        fleet={fleet} stand={fleet.stands[chosen]} names={names}
        onOpen={open} onClose={() => select("stands", null)}
      />
    ) : tab === "drivers" ? (
      <DriverDetail
        fleet={fleet} driver={fleet.drivers[chosen]} names={names}
        onOpen={open} onClose={() => select("drivers", null)}
      />
    ) : (
      <RiderDetail
        fleet={fleet} rider={fleet.riders[chosen]} names={names}
        onOpen={open} onClose={() => select("riders", null)}
      />
    )
  ) : null;

  return (
    <DataBrowser
      title="Taxis"
      lead={fleet ? lead(fleet, tab) : error
        ? <StatusText state="error">{error}</StatusText>
        : "Loading…"}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      beforeFilters={fleet && tab === "drivers" ? <WatchProfile fleet={fleet} /> : undefined}
      filters={fields}
      filterValues={filters as unknown as Record<string, string | boolean>}
      onFilterChange={(key, value) =>
        setFilters((current) => ({ ...current, [key]: value as string }))}
      table={fleet ? {
        indices,
        columns,
        selected: chosen,
        onSelect: (index) => select(tab, index),
        empty: {
          title: "No matches",
          body: null,
          onClear: () => setFilters({ ...EMPTY }),
        },
      } : null}
      detail={detail}
      loading={
        <EmptyState title={error ? "No taxi layer" : undefined}>
          {error ? (
            <code>cd kierston/sim && bun run day --export-taxi</code>
          ) : "Loading…"}
        </EmptyState>
      }
    />
  );
}

// ---- Header copy ------------------------------------------------------------

function lead(fleet: TaxiFleet, tab: Tab): React.ReactNode {
  if (tab === "stands") {
    return `${fleet.stands.length} stands · ${num(fleet.standbyMass)} demand points`;
  }
  if (tab === "drivers") {
    const peak = fleet.peak;
    return `${num(fleet.drivers.length)} drivers · peak ${num(peak.cars)} at ${clock(peak.minute)}`
      + (fleet.unwatched > 0 ? ` · ${num(fleet.unwatched)} without shift` : "");
  }
  return `${num(fleet.riders.length)} riders`;
}

/**
 * Cars inside their shift, across the day.
 *
 * A staffing envelope rather than a fleet on the road — see `onWatch`. It is
 * here because the shape is the one fact about the drivers table that no
 * column can carry: three watches, overlapping at the shoulders, with the
 * small hours held by a handful of cars.
 */
function WatchProfile({ fleet }: { fleet: TaxiFleet }) {
  const points = useMemo(() => {
    const step = 15;
    const values: { minute: number; cars: number }[] = [];
    for (let minute = 0; minute < 1440; minute += step) {
      values.push({ minute, cars: fleet.onWatch(minute) });
    }
    return values;
  }, [fleet]);

  const peak = Math.max(1, ...points.map((point) => point.cars));

  return (
    <div className="mt-3 max-w-[62rem]">
      <div className="flex h-14 items-end gap-px" aria-hidden>
        {points.map((point) => (
          <i
            key={point.minute}
            className="block flex-1 rounded-t-[1px] bg-primary/70"
            style={{ height: `${Math.max(2, (point.cars / peak) * 100)}%` }}
            title={`${clock(point.minute)} · ${num(point.cars)} on watch`}
          />
        ))}
      </div>
      <p className="mt-1 flex justify-between text-[0.68rem] text-muted-foreground tabular-nums">
        <span>midnight</span><span>6 am</span><span>noon</span><span>6 pm</span><span>midnight</span>
      </p>
      <p className="sr-only">Peak · {num(peak)} drivers</p>
    </div>
  );
}

// ---- Columns ----------------------------------------------------------------

function standDot(index: number) {
  return <Swatch color={standColor(index)} />;
}

function columnsFor(fleet: TaxiFleet, tab: Tab, names: Identity | null): BrowseColumn[] {
  if (tab === "stands") {
    return [
      {
        id: "stand", header: "Stand", cell: (index) => {
          const stand = fleet.stands[index];
          return <span className="font-sans text-[max(0.75rem,0.8em)]">{standDot(stand.index)}{stand.id}</span>;
        },
      },
      {
        id: "where", header: "Centre", width: "13rem",
        cell: (index) => (
          <span className="font-sans text-[max(0.75rem,0.8em)]">{coords(fleet.stands[index].lat, fleet.stands[index].lon)}</span>
        ),
      },
      {
        id: "mass", header: "Demand", width: "7rem", align: "right",
        cell: (index) => {
          const stand = fleet.stands[index];
          return (
            <span>
              {num(stand.mass)}
              <i className={PID}> · {percent(stand.mass / (fleet.standbyMass || 1), 0)}</i>
            </span>
          );
        },
      },
      {
        id: "homes", header: "Homes", width: "6rem", align: "right",
        cell: (index) => num(fleet.stands[index].homes.length),
      },
      {
        id: "works", header: "Workplaces", width: "7rem", align: "right",
        cell: (index) => num(fleet.stands[index].works.length),
      },
      {
        id: "drivers", header: "Drivers", width: "6.5rem", align: "right",
        cell: (index) => num(fleet.stands[index].drivers.length),
      },
      {
        id: "cover", header: "Demand per car", width: "8.5rem", align: "right",
        cell: (index) => {
          const stand = fleet.stands[index];
          return stand.drivers.length
            ? (stand.mass / stand.drivers.length).toFixed(1)
            : <span className="text-destructive">no drivers</span>;
        },
      },
    ];
  }

  if (tab === "drivers") {
    return [
      {
        id: "driver", header: "Driver",
        cell: (index) => <PersonLink names={names} person={fleet.drivers[index].person} />,
      },
      {
        id: "watch", header: "Watch", width: "7rem",
        cell: (index) => {
          const watch = fleet.drivers[index].watch;
          return watch ? (
            <span>
              <Swatch color={WATCH_COLOR[watch]} />
              {WATCH_LABEL[watch]}
            </span>
          ) : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "shift", header: "Shift", width: "11rem",
        cell: (index) => {
          const driver = fleet.drivers[index];
          return <span className="font-sans text-[max(0.75rem,0.8em)]">{shiftSpan(driver.start, driver.end)}</span>;
        },
      },
      {
        id: "stand", header: "Stand", width: "8rem",
        cell: (index) => {
          const stand = fleet.standOf(fleet.drivers[index].stand);
          return stand
            ? <span className="font-sans text-[max(0.75rem,0.8em)]">{standDot(stand.index)}{stand.id}</span>
            : "—";
        },
      },
      {
        id: "km", header: "From stand", width: "8rem", align: "right",
        cell: (index) => `${fleet.drivers[index].km.toFixed(1)} km`,
      },
    ];
  }

  return [
    {
      id: "rider", header: "Person",
      cell: (index) => <PersonLink names={names} person={fleet.riders[index].person} />,
    },
    {
      id: "home", header: "Home stand", width: "8rem",
      cell: (index) => {
        const stand = fleet.standOf(fleet.riders[index].homeStand);
        return stand
          ? <span className="font-sans text-[max(0.75rem,0.8em)]">{standDot(stand.index)}{stand.id}</span>
          : <span className="text-muted-foreground">no dwelling</span>;
      },
    },
    {
      id: "work", header: "Workplace", cell: (index) => fleet.workplace(fleet.riders[index]),
    },
    {
      id: "workStand", header: "Work stand", width: "8.5rem",
      cell: (index) => {
        const stand = fleet.standOf(fleet.riders[index].workStand);
        return stand
          ? <span className="font-sans text-[max(0.75rem,0.8em)]">{standDot(stand.index)}{stand.id}</span>
          : <span className="text-muted-foreground">outside the region</span>;
      },
    },
    {
      id: "km", header: "Commute", width: "7rem", align: "right",
      cell: (index) => {
        const km = fleet.riders[index].km;
        return Number.isFinite(km) ? `${km.toFixed(1)} km` : "—";
      },
    },
    {
      id: "depart", header: "Leaves", width: "7rem", align: "right",
      cell: (index) => clock(fleet.riders[index].assignment?.depart ?? null),
    },
  ];
}

// ---- Filtering and sorting --------------------------------------------------

function filterRows(fleet: TaxiFleet, tab: Tab, filters: Filters): Int32Array {
  const query = filters.query.trim().toLowerCase();
  const stand = filters.stand === "any" ? -1 : Number(filters.stand);
  const keep: number[] = [];

  if (tab === "stands") {
    fleet.stands.forEach((row, index) => {
      if (query && !row.id.toLowerCase().includes(query)) return;
      keep.push(index);
    });
    const order = filters.standSort;
    keep.sort((a, b) => {
      const x = fleet.stands[a];
      const y = fleet.stands[b];
      if (order === "drivers-desc") return y.drivers.length - x.drivers.length;
      if (order === "cover-desc") {
        return y.mass / Math.max(1, y.drivers.length) - x.mass / Math.max(1, x.drivers.length);
      }
      if (order === "id") return x.id.localeCompare(y.id);
      return y.mass - x.mass;
    });
    return Int32Array.from(keep);
  }

  if (tab === "drivers") {
    fleet.drivers.forEach((row, index) => {
      if (stand >= 0 && row.stand !== stand) return;
      if (filters.watch !== "any" && row.watch !== filters.watch) return;
      if (query && !String(row.person).includes(query)) return;
      keep.push(index);
    });
    const order = filters.driverSort;
    keep.sort((a, b) => {
      const x = fleet.drivers[a];
      const y = fleet.drivers[b];
      if (order === "km") return x.km - y.km;
      if (order === "km-desc") return y.km - x.km;
      // A driver with no shift has no place on a clock, so they sort last
      // rather than sorting as midnight.
      if (order === "start") return (x.start ?? Infinity) - (y.start ?? Infinity);
      return x.person - y.person;
    });
    return Int32Array.from(keep);
  }

  fleet.riders.forEach((row, index) => {
    if (stand >= 0 && row.homeStand !== stand && row.workStand !== stand) return;
    if (query
      && !String(row.person).includes(query)
      && !(row.site ?? "").toLowerCase().includes(query)) return;
    keep.push(index);
  });
  const order = filters.riderSort;
  keep.sort((a, b) => {
    const x = fleet.riders[a];
    const y = fleet.riders[b];
    // NaN is a rider with an end missing, which no comparison orders, so the
    // distance sorts are given a value that puts them at the bottom either way.
    const xKm = Number.isFinite(x.km) ? x.km : -1;
    const yKm = Number.isFinite(y.km) ? y.km : -1;
    if (order === "km") return (xKm < 0 ? Infinity : xKm) - (yKm < 0 ? Infinity : yKm);
    if (order === "km-desc") return yKm - xKm;
    if (order === "depart") {
      return (x.assignment?.depart ?? Infinity) - (y.assignment?.depart ?? Infinity);
    }
    return x.person - y.person;
  });
  return Int32Array.from(keep);
}

// ---- Detail panels ----------------------------------------------------------

type Opener = (tab: Tab, index: number) => void;

function StandDetail({ fleet, stand, names, onOpen, onClose }: {
  fleet: TaxiFleet; stand: Stand; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const share = stand.mass / (fleet.standbyMass || 1);
  const watches = { day: 0, evening: 0, night: 0 } as Record<Watch, number>;
  for (const index of stand.drivers) {
    const watch = fleet.drivers[index].watch;
    if (watch) watches[watch] += 1;
  }

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub="Taxi stand">
        <Chip kind="place" href={mapHref(stand.lat, stand.lon, 15)}>
          {standDot(stand.index)}{stand.id}
        </Chip>
      </DetailLead>

      <TaxiMap fleet={fleet} focus={{ kind: "stand", stand }} />

      <Facts cols={3} className="mt-4">
        <Fact label="Demand">{num(stand.mass)}</Fact>
        <Fact label="Share of city">{percent(share, 0)}</Fact>
        <Fact label="Drivers">{num(stand.drivers.length)}</Fact>
        <Fact label="Per driver">
          {stand.drivers.length ? (stand.mass / stand.drivers.length).toFixed(1) : "—"}
        </Fact>
        <Fact label="Rider homes">{num(stand.homes.length)}</Fact>
        <Fact label="Rider workplaces">{num(stand.works.length)}</Fact>
        {WATCHES.map((watch) => (
          <Fact key={watch} label={`${WATCH_LABEL[watch]} watch`}>{num(watches[watch])}</Fact>
        ))}
        <Fact label="Centre">{coords(stand.lat, stand.lon)}</Fact>
      </Facts>

      <DetailHeading>
        Drivers
        <small className="text-muted-foreground tabular-nums">{num(stand.drivers.length)}</small>
      </DetailHeading>
      <Members>
        {stand.drivers.slice(0, 40).map((index) => {
          const driver = fleet.drivers[index];
          return (
            <Member key={driver.person}>
              <button
                type="button"
                className={cn(PERSON_LINK, "justify-self-start")}
                onClick={() => onOpen("drivers", index)}
              >
                {names?.knows(driver.person) ? names.shortName(driver.person) : `Resident ${driver.person}`}
              </button>
              <Facts cols={3}>
                <Fact label="Watch">{driver.watch ? WATCH_LABEL[driver.watch] : "None"}</Fact>
                <Fact label="Shift">{shiftSpan(driver.start, driver.end)}</Fact>
                <Fact label="From stand">{driver.km.toFixed(1)} km</Fact>
              </Facts>
            </Member>
          );
        })}
      </Members>
    </Drawer>
  );
}

function StandButton({ stand, onOpen }: { stand: Stand; onOpen: Opener }) {
  return (
    <button type="button" className={PERSON_LINK} onClick={() => onOpen("stands", stand.index)}>
      {standDot(stand.index)}{stand.id}
    </button>
  );
}

function DriverDetail({ fleet, driver, names, onOpen, onClose }: {
  fleet: TaxiFleet; driver: Driver; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const stand = fleet.standOf(driver.stand);

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={`Taxi driver · ${driver.operatorName ?? "Owner-driver"}`}>
        <PersonLink names={names} person={driver.person} />
      </DetailLead>

      <TaxiMap fleet={fleet} focus={{ kind: "driver", driver }} />

      <Facts className="mt-4">
        <Fact label="Stand">{stand ? <StandButton stand={stand} onOpen={onOpen} /> : "—"}</Fact>
        <Fact label="From home">{driver.km.toFixed(1)} km</Fact>
        <Fact label="Watch">{driver.watch ? WATCH_LABEL[driver.watch] : "None"}</Fact>
        <Fact label="Shift">{shiftSpan(driver.start, driver.end)}</Fact>
        <Fact label="Cab">
          {driver.vehicle ? <VehicleChip vin={driver.vehicle} /> : "Pooled"}
        </Fact>
        {driver.assignment ? (
          <Fact label="Hours a week">{driver.assignment.hours ?? "—"}</Fact>
        ) : null}
        {driver.assignment ? (
          <Fact label="Depot">{driver.depot ? siteLabel(driver.depot) : "Home"}</Fact>
        ) : null}
        <Fact label="Home">
          <Chip kind="place" href={mapHref(driver.lat, driver.lon)}>{coords(driver.lat, driver.lon)}</Chip>
        </Fact>
      </Facts>
    </Drawer>
  );
}

function RiderDetail({ fleet, rider, names, onOpen, onClose }: {
  fleet: TaxiFleet; rider: Rider; names: Identity | null;
  onOpen: Opener; onClose: () => void;
}) {
  const homeStand = fleet.standOf(rider.homeStand);
  const workStand = fleet.standOf(rider.workStand);
  const assignment = rider.assignment;

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub="Rider">
        <PersonLink names={names} person={rider.person} />
      </DetailLead>

      <TaxiMap fleet={fleet} focus={{ kind: "rider", rider }} />

      <Facts className="mt-4">
        <Fact label="Workplace" wide>{fleet.workplace(rider)}</Fact>
        <Fact label="Distance">{Number.isFinite(rider.km) ? `${rider.km.toFixed(1)} km` : "—"}</Fact>
        <Fact label="Travel time">{assignment?.travel != null ? `${assignment.travel} min` : "—"}</Fact>
        <Fact label="Leaves">{clock(assignment?.depart ?? null)}</Fact>
        <Fact label="Arrives">{clock(assignment?.arrive ?? null)}</Fact>
        <Fact label="Home stand">{homeStand ? <StandButton stand={homeStand} onOpen={onOpen} /> : "—"}</Fact>
        <Fact label="Work stand">{workStand ? <StandButton stand={workStand} onOpen={onOpen} /> : "—"}</Fact>
      </Facts>
    </Drawer>
  );
}

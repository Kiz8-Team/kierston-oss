"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { AddressChip, Chip, CopyChip, HouseholdChip, mapHref } from "@/components/console/Chip";
import { useEmployment } from "@/components/useEmployment";
import { useNames } from "@/components/useNames";
import { Badge } from "@/components/ui/badge";
import {
  MATCH_LABEL, MODE_LABEL, clock, siteLabel,
  type Assignment, type Employment, type WorkMode,
} from "@/lib/employment";
import { metres, num, title, usd } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";
import { DetailHeading, DetailLead, Drawer, Facts } from "@/components/browse/detail";

type Sort = "person" | "travel-desc" | "travel-asc" | "hours-desc" | "depart-asc";

const MODES: WorkMode[] = ["sited", "itinerant", "home", "external"];

interface Filters {
  query: string;
  mode: "any" | WorkMode;
  klass: "any" | "primary" | "filler";
  role: string;
  group: string;
  sector: string;
  transport: string;
  maxTravel: string;
  sort: Sort;
}

const EMPTY: Filters = {
  query: "", mode: "any", klass: "any", role: "any", group: "any",
  sector: "any", transport: "any", maxTravel: "", sort: "person",
};

/**
 * Every job in the city, one row per working person.
 *
 * Same machinery as the households and people browsers — filter to an index
 * array, render only the visible rows — because the working population is
 * 54,664 strong and a job is worth as much detail as a person is.
 */
export function JobsBrowser() {
  const { population, employment, labels, error } = useEmployment();
  // A roster in the workplace browser links here to see the rest of it, and
  // the site id is already something the search box matches on.
  const params = useSearchParams();
  const names = useNames();

  const [filters, setFilters] = useState<Filters>(
    () => ({ ...EMPTY, query: params.get("site") ?? "" }));
  const [selected, setSelected] = useState<number | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const sectors = useMemo(() => {
    if (!employment || !labels) return [];
    const seen = new Map<string, number>();
    for (const assignment of employment.assignments) {
      const sector = labels.industrySector(assignment.industry);
      if (sector) seen.set(sector, (seen.get(sector) ?? 0) + 1);
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, label: labels.sectorLabel(code), count }));
  }, [employment, labels]);

  const transports = useMemo(() => {
    if (!employment || !labels) return [];
    const seen = new Map<string, number>();
    for (const assignment of employment.assignments) {
      if (assignment.transport) {
        seen.set(assignment.transport, (seen.get(assignment.transport) ?? 0) + 1);
      }
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, label: labels.transportLabel(code), count }));
  }, [employment, labels]);

  const indices = useMemo(
    () => (employment && labels ? filter(employment, labels, filters) : new Int32Array()),
    [employment, labels, filters],
  );

  const filterFields: FilterField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "Occupation, industry, workplace or address",
      grow: true,
    },
    {
      type: "select",
      key: "mode",
      label: "Working day",
      options: [
        { value: "any", label: "Any" },
        ...MODES.map((mode) => ({ value: mode, label: title(MODE_LABEL[mode]) })),
      ],
    },
    {
      type: "select",
      key: "klass", advanced: true,
      label: "Class",
      options: [
        { value: "any", label: "Any" },
        { value: "primary", label: "Primary" },
        { value: "filler", label: "Filler" },
      ],
    },
    {
      type: "select",
      key: "role",
      label: "Role",
      options: [
        { value: "any", label: "Any" },
        ...(employment?.roles ?? []).map((role) => ({
          value: role.key,
          label: `${role.label} (${num(role.count)})`,
        })),
      ],
    },
    {
      type: "select",
      key: "group", advanced: true,
      label: "Occupation group",
      options: [
        { value: "any", label: "Any" },
        ...(labels?.occupationGroups ?? []).map((group) => ({
          value: group.code,
          label: group.label,
        })),
      ],
    },
    {
      type: "select",
      key: "sector", advanced: true,
      label: "Industry sector",
      options: [
        { value: "any", label: "Any" },
        ...sectors.map((sector) => ({
          value: sector.code,
          label: `${sector.label} (${num(sector.count)})`,
        })),
      ],
    },
    {
      type: "select",
      key: "transport", advanced: true,
      label: "Commute mode",
      options: [
        { value: "any", label: "Any" },
        ...transports.map((transport) => ({
          value: transport.code,
          label: `${transport.label} (${num(transport.count)})`,
        })),
      ],
    },
    {
      type: "text",
      key: "maxTravel", advanced: true,
      label: "Commute under",
      width: "5.5rem",
      inputMode: "numeric",
      placeholder: "min",
    },
    {
      type: "select",
      key: "sort",
      label: "Sort",
      options: [
        { value: "person", label: "By person" },
        { value: "travel-desc", label: "Longest commute" },
        { value: "travel-asc", label: "Shortest commute" },
        { value: "hours-desc", label: "Longest week" },
        { value: "depart-asc", label: "Earliest start" },
      ],
    },
  ], [employment, labels, sectors, transports]);

  const onFilterChange = (key: string, value: string | boolean) => {
    set(key as keyof Filters, value as Filters[keyof Filters]);
  };

  const columns: BrowseColumn[] = useMemo(() => {
    if (!employment || !labels) return [];
    return [
      {
        id: "person",
        header: "Person",
        width: "12rem",
        cell: (index) => {
          const row = employment.assignments[index];
          return <PersonLink names={names} person={row.person} />;
        },
      },
      {
        id: "occupation",
        header: "Occupation",
        cell: (index) => {
          const row = employment.assignments[index];
          return (
            <span title={labels.occupationLabel(row.occupation)}>
              {labels.occupationLabel(row.occupation)}
              {row.role ? (
                <Badge variant="secondary" className="ml-1">
                  {row.role.replace(/_/g, " ")}
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "industry",
        header: "Industry",
        width: "12rem",
        cell: (index) => {
          const row = employment.assignments[index];
          return (
            <span title={labels.industryLabel(row.industry)}>
              {labels.industryLabel(row.industry) || <span className="text-muted-foreground">—</span>}
            </span>
          );
        },
      },
      {
        id: "workplace",
        header: "Workplace",
        width: "13rem",
        cell: (index) => {
          const row = employment.assignments[index];
          const site = employment.siteOf(row);
          return site
            ? <Chip kind="place" href={mapHref(site.lat, site.lon)} title={siteLabel(site)}>{siteLabel(site)}</Chip>
            : <span className="text-muted-foreground">No site</span>;
        },
      },
      {
        id: "day",
        header: "Day",
        width: "8rem",
        cell: (index) => MODE_LABEL[employment.assignments[index].mode],
      },
      {
        id: "commute",
        header: "Commute",
        width: "5rem",
        align: "right",
        cell: (index) => {
          const row = employment.assignments[index];
          return row.travel
            ? `${row.travel} min`
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "hours",
        header: "Hours",
        width: "4.5rem",
        align: "right",
        cell: (index) => {
          const row = employment.assignments[index];
          return row.hours ?? <span className="text-muted-foreground">—</span>;
        },
      },
    ];
  }, [employment, labels, names]);

  const ready = Boolean(employment && labels && population);
  const assignment = employment && selected !== null ? employment.assignments[selected] : null;

  return (
    <DataBrowser
      title="Jobs"
      lead={
        employment
          ? `${num(employment.workers)} employed · `
            + `${num(employment.modes.sited)} on site · `
            + `${num(employment.modes.itinerant)} itinerant · `
            + `${num(employment.modes.home)} home · `
            + `${num(employment.modes.external)} outside Kierston`
          : error
            ? <StatusText state="error">{error}</StatusText>
            : "Loading…"
      }
      filters={filterFields}
      filterValues={filters as unknown as Record<string, string | boolean>}
      onFilterChange={onFilterChange}
      table={ready ? {
        indices,
        columns,
        selected,
        onSelect: setSelected,
        empty: {
          title: "No matches",
          body: null,
          onClear: () => setFilters({ ...EMPTY, sort: filters.sort }),
        },
      } : null}
      loading={
        <EmptyState title={error ? "No employment table" : undefined}>
          {error ? (
            <p>
              <span className="font-sans text-[max(0.75rem,0.8em)]">python kierston/init/work/init_work.py</span>
              <br />
              <span className="font-sans text-[max(0.75rem,0.8em)]">assign_work.py</span>
            </p>
          ) : (
            "Loading…"
          )}
        </EmptyState>
      }
      detail={
        assignment && ready ? (
          <JobDetail
            assignment={assignment}
            employment={employment!}
            labels={labels!}
            population={population!}
            names={names}
            onClose={() => setSelected(null)}
          />
        ) : null
      }
    />
  );
}

function JobDetail({
  assignment, employment, labels, population, names, onClose,
}: {
  assignment: Assignment;
  employment: Employment;
  labels: Labels;
  population: Population;
  names: Identity | null;
  onClose: () => void;
}) {
  const site = employment.siteOf(assignment);
  const person = population.resident(assignment.person);
  const home = population.building(population.residentBuilding(assignment.person));
  const household = population.residentHousehold(assignment.person);
  const colleagues = site ? site.staff.length - 1 : 0;

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={labels.occupationLabel(assignment.occupation)}>
        <PersonLink names={names} person={assignment.person} />
      </DetailLead>

      <Facts>
        <div><span>Age</span><span>{person.age}</span></div>
        <div><span>Sex</span><span>{person.sex}</span></div>
        <div><span>Education</span><span>{person.education}</span></div>
        <div><span>Personal income</span><span>{usd(person.income)}</span></div>
        <div>
          <span>Occupation group</span>
          <span>{labels.occupationGroupLabel(assignment.occupation) || "—"}</span>
        </div>
        <div><span>OCCP · SOC</span><span>
          {assignment.occupation}{person.soc ? ` · ${person.soc}` : ""}
        </span></div>
        {assignment.industry ? (
          <>
            <div><span>Industry</span><span>{labels.industryLabel(assignment.industry)}</span></div>
            <div>
              <span>Sector</span>
              <span>{labels.sectorLabel(labels.industrySector(assignment.industry))}</span>
            </div>
          </>
        ) : null}
      </Facts>

      <DetailHeading>Working day</DetailHeading>
      <Facts>
        <div className="col-span-full">
          <span>Workplace</span>
          <span>
            {site ? (
              <Chip kind="place" href={`/workplaces?site=${encodeURIComponent(site.id)}`}>
                {siteLabel(site)}
              </Chip>
            ) : siteLabel(site)}
          </span>
        </div>
        {site?.address ? (
          <div>
            <span>Address</span>
            <span><AddressChip address={site.address} lat={site.lat} lon={site.lon} /></span>
          </div>
        ) : null}
        {site ? <div><span>Site id</span><span><CopyChip value={site.id} /></span></div> : null}
        {colleagues > 0 ? (
          <div><span>Colleagues</span><span>{num(colleagues)}</span></div>
        ) : null}
        <div><span>Hours a week</span><span>{assignment.hours ?? "—"}</span></div>
        <div><span>Departure</span><span>{clock(assignment.depart)}</span></div>
        <div><span>Arrival</span><span>{clock(assignment.arrive)}</span></div>
        <div>
          <span>Commute</span>
          <span>{assignment.travel !== null ? `${assignment.travel} min` : "—"}</span>
        </div>
        {assignment.transport ? (
          <div><span>Mode</span><span>{labels.transportLabel(assignment.transport)}</span></div>
        ) : null}
        {site && assignment.mode !== "home" ? (
          <div>
            <span>Distance home to work</span>
            <span>{metres(haversine(home.lat, home.lon, site.lat, site.lon))}</span>
          </div>
        ) : null}
        {assignment.match ? (
          <div>
            <span>Seat match</span>
            <span>{MATCH_LABEL[assignment.match] ?? assignment.match}</span>
          </div>
        ) : null}
      </Facts>

      {assignment.klass === "primary" ? (
        <>
          <DetailHeading>Roster</DetailHeading>
          <Facts>
            <div><span>Role</span><span>{title((assignment.role ?? "").replace(/_/g, " "))}</span></div>
            {assignment.platoon ? (
              <div><span>Platoon</span><span>{title(assignment.platoon)}</span></div>
            ) : null}
            {assignment.duty ? (
              <div><span>Duty</span><span>{title(assignment.duty)}</span></div>
            ) : null}
            {assignment.crew ? (
              <div><span>Crew</span><span><CopyChip value={assignment.crew} /></span></div>
            ) : null}
          </Facts>
        </>
      ) : null}

      <DetailHeading>Home</DetailHeading>
      <Facts>
        <div>
          <span>Address</span>
          <span>{home.address ? <AddressChip address={home.address} lat={home.lat} lon={home.lon} /> : "—"}</span>
        </div>
        <div>
          <span>Household</span>
          <span>{household >= 0 ? <HouseholdChip household={household} /> : "Group quarters"}</span>
        </div>
        {household >= 0 ? (
          <div>
            <span>Household income</span>
            <span>{usd(population.household(household).income)}</span>
          </div>
        ) : null}
      </Facts>
    </Drawer>
  );
}

const EARTH_M = 6_371_000;

/** Straight-line metres, which is what the site chooser itself scored on. */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function filter(employment: Employment, labels: Labels, filters: Filters): Int32Array {
  const needle = filters.query.trim().toLowerCase();
  const maxTravel = filters.maxTravel.trim() ? Number(filters.maxTravel) : null;
  const matches = new Int32Array(employment.assignments.length);
  let found = 0;

  for (const assignment of employment.assignments) {
    if (filters.mode !== "any" && assignment.mode !== filters.mode) continue;
    if (filters.klass !== "any" && assignment.klass !== filters.klass) continue;
    if (filters.role !== "any" && assignment.role !== filters.role) continue;
    if (filters.group !== "any"
        && labels.occupationGroup(assignment.occupation) !== filters.group) continue;
    if (filters.sector !== "any"
        && labels.industrySector(assignment.industry) !== filters.sector) continue;
    if (filters.transport !== "any" && assignment.transport !== filters.transport) continue;
    if (maxTravel !== null && Number.isFinite(maxTravel)
        && (assignment.travel === null || assignment.travel > maxTravel)) continue;
    if (needle) {
      const site = employment.siteOf(assignment);
      const hit = labels.occupationLabel(assignment.occupation).toLowerCase().includes(needle)
        || labels.industryLabel(assignment.industry).toLowerCase().includes(needle)
        || (site
          ? site.name.toLowerCase().includes(needle)
            || site.address.toLowerCase().includes(needle)
            || site.id.toLowerCase().includes(needle)
          : false);
      if (!hit) continue;
    }
    matches[found++] = assignment.index;
  }

  const result = matches.subarray(0, found);
  const rows = employment.assignments;
  // Missing values sort last whichever way the column runs: a job with no
  // reported commute is not a zero-minute one.
  const last = (value: number | null, descending: boolean) =>
    value ?? (descending ? -Infinity : Infinity);
  const comparators: Record<Sort, (x: number, y: number) => number> = {
    // The table is written primary roster first, so even the default order has
    // to be asked for: a reader scanning it expects resident ids to ascend.
    person: (x, y) => rows[x].person - rows[y].person,
    "travel-desc": (x, y) => last(rows[y].travel, true) - last(rows[x].travel, true),
    "travel-asc": (x, y) => last(rows[x].travel, false) - last(rows[y].travel, false),
    "hours-desc": (x, y) => last(rows[y].hours, true) - last(rows[x].hours, true),
    "depart-asc": (x, y) => last(rows[x].depart, false) - last(rows[y].depart, false),
  };
  result.sort(comparators[filters.sort]);
  return result;
}

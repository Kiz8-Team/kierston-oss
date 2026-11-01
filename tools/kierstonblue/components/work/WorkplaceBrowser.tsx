"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { AddressChip, Chip, CopyChip, mapHref } from "@/components/console/Chip";
import { useEmployment } from "@/components/useEmployment";
import { useNames } from "@/components/useNames";
import { clock, siteLabel, type Employment, type Site } from "@/lib/employment";
import { coords, num, percent, title } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Labels } from "@/lib/labels";
import { WORKPLACE_GROUPS } from "@/lib/map-style";
import type { Population } from "@/lib/population";
import { Swatch } from "@/components/Charts";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members, Tally,
} from "@/components/browse/detail";

type Sort = "staff-desc" | "capacity-desc" | "fill-desc" | "floor-desc" | "name";

const EVIDENCE: Record<string, string> = {
  tag: "OSM tag",
  poi: "Point of interest",
  inferred: "Deduced",
  establishment: "Declared establishment",
  dwelling: "Dwelling",
  "": "Deduced",
};

interface Filters {
  query: string;
  group: string;
  evidence: string;
  minStaff: string;
  staffedOnly: boolean;
  sort: Sort;
}

/** The widest state, for the way out of a search that matched nothing. */
const WIDEST: Omit<Filters, "sort"> = {
  query: "", group: "any", evidence: "any", minStaff: "", staffedOnly: false,
};

/**
 * The catalogue of places people work, and who was sent to each.
 *
 * The rows are the supply side — floor area and the seats it implies — and the
 * staff count is the demand side that landed on them, so the interesting column
 * is the ratio between the two: a site at 100% is one whose industry ran out of
 * room elsewhere.
 */
export function WorkplaceBrowser() {
  const { population, employment, labels, error } = useEmployment();
  // The map popup links here with the site it was showing.
  const params = useSearchParams();
  // Only the roster needs these, and only once a site is open.
  const names = useNames();

  const [filters, setFilters] = useState<Filters>(() => ({
    query: params.get("site") ?? "", group: "any", evidence: "any", minStaff: "",
    staffedOnly: true, sort: "staff-desc",
  }));
  const [selected, setSelected] = useState<number | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const totals = useMemo(() => {
    if (!employment) return null;
    let capacity = 0;
    let staffed = 0;
    let staff = 0;
    for (const site of employment.sites) {
      capacity += site.capacity;
      staff += site.staff.length;
      if (site.staff.length) staffed += 1;
    }
    return { capacity, staffed, staff };
  }, [employment]);

  const indices = useMemo(
    () => (employment ? filter(employment, filters) : new Int32Array()),
    [employment, filters],
  );

  const filterFields: FilterField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "Name, address or OSM id",
      grow: true,
    },
    {
      type: "select",
      key: "group",
      label: "Kind",
      options: [
        { value: "any", label: "Any" },
        ...WORKPLACE_GROUPS.map((group) => ({ value: group.id, label: group.label })),
      ],
    },
    {
      type: "select",
      key: "evidence", advanced: true,
      label: "Industry source",
      options: [
        { value: "any", label: "Any" },
        { value: "tag", label: "OSM tag" },
        { value: "poi", label: "Point of interest" },
        { value: "inferred", label: "Deduced" },
        { value: "establishment", label: "Declared establishment" },
        { value: "dwelling", label: "Dwelling" },
      ],
    },
    {
      type: "text",
      key: "minStaff", advanced: true,
      label: "Min staff",
      width: "5rem",
      inputMode: "numeric",
    },
    {
      type: "select",
      key: "sort",
      label: "Sort",
      options: [
        { value: "staff-desc", label: "Most staff" },
        { value: "capacity-desc", label: "Most seats" },
        { value: "fill-desc", label: "Fullest" },
        { value: "floor-desc", label: "Most floor area" },
        { value: "name", label: "Name" },
      ],
    },
    { type: "checkbox", key: "staffedOnly", label: "Staffed only" },
  ], []);

  const onFilterChange = (key: string, value: string | boolean) => {
    set(key as keyof Filters, value as Filters[keyof Filters]);
  };

  const columns: BrowseColumn[] = useMemo(() => {
    if (!employment) return [];
    return [
      {
        id: "workplace",
        header: "Workplace",
        cell: (index) => {
          const row = employment.sites[index];
          return <Chip kind="place" href={mapHref(row.lat, row.lon)} title={siteLabel(row)}>{siteLabel(row)}</Chip>;
        },
      },
      {
        id: "kind",
        header: "Kind",
        width: "11rem",
        cell: (index) => {
          const row = employment.sites[index];
          const group = WORKPLACE_GROUPS.find((entry) => entry.id === row.group);
          return (
            <span title={row.klass}>
              <Swatch color={group?.color} />
              {title(row.klass.replace(/_/g, " ")) || <span className="text-muted-foreground">—</span>}
            </span>
          );
        },
      },
      {
        id: "address",
        header: "Address",
        width: "13rem",
        cell: (index) => {
          const row = employment.sites[index];
          return (
            row.address
              ? <AddressChip address={row.address} lat={row.lat} lon={row.lon} />
              : <span className="text-muted-foreground">no address</span>
          );
        },
      },
      {
        id: "staff",
        header: "Staff",
        width: "4.5rem",
        align: "right",
        cell: (index) => num(employment.sites[index].staff.length),
      },
      {
        id: "seats",
        header: "Seats",
        width: "4.5rem",
        align: "right",
        cell: (index) => {
          const row = employment.sites[index];
          return row.capacity
            ? num(row.capacity)
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "full",
        header: "Full",
        width: "4.5rem",
        align: "right",
        cell: (index) => {
          const row = employment.sites[index];
          return row.capacity
            ? percent(Math.min(1, row.staff.length / row.capacity), 0)
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "floor",
        header: "Floor",
        width: "6rem",
        align: "right",
        cell: (index) => {
          const row = employment.sites[index];
          return row.floor
            ? `${num(row.floor)} m²`
            : <span className="text-muted-foreground">—</span>;
        },
      },
    ];
  }, [employment]);

  const ready = Boolean(employment && labels && population);
  const site = employment && selected !== null ? employment.sites[selected] : null;

  return (
    <DataBrowser
      title="Workplaces"
      lead={
        employment && totals
          ? `${num(employment.sites.length)} sites · ${num(totals.capacity)} seats · `
            + `${num(totals.staffed)} staffed · `
            + `${num(employment.modes.external)} outside Kierston · `
            + `${employment.portals.length} boundary portals`
          : error
            ? <StatusText state="error">{error}</StatusText>
            : "Loading…"
      }
      filters={filterFields}
      filterValues={filters as unknown as Record<string, string | boolean>}
      onFilterChange={onFilterChange}
      table={employment ? {
        indices,
        columns,
        selected,
        onSelect: setSelected,
        empty: {
          title: "No matches",
          body: null,
          onClear: () => setFilters({ ...WIDEST, sort: filters.sort }),
        },
      } : null}
      loading={
        <EmptyState title={error ? "No workplace catalogue" : undefined}>
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
        site && ready ? (
          <SiteDetail
            site={site}
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

const ROSTER_LIMIT = 40;

function SiteDetail({
  site, employment, labels, population, names, onClose,
}: {
  site: Site;
  employment: Employment;
  labels: Labels;
  population: Population;
  names: Identity | null;
  onClose: () => void;
}) {
  const staff = useMemo(
    () => site.staff.map((index) => employment.assignments[index]),
    [site, employment],
  );

  const occupations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const assignment of staff) {
      const label = labels.occupationLabel(assignment.occupation);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [staff, labels]);

  const commute = useMemo(() => {
    const times = staff.map((assignment) => assignment.travel)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    return times.length ? times[times.length >> 1] : null;
  }, [staff]);

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={site.category === "facility" ? "Facility" : "Workplace"}>
        <Chip kind="place" href={`/map?lat=${site.lat}&lon=${site.lon}&zoom=18&work=1`}>
          {siteLabel(site)}
        </Chip>
      </DetailLead>

      <Facts>
        <div><span>Address</span><span>{site.address ? <AddressChip address={site.address} lat={site.lat} lon={site.lon} /> : "—"}</span></div>
        <div><span>Kind</span><span>{title(site.klass.replace(/_/g, " ")) || "—"}</span></div>
        {site.role ? <div><span>Role</span><span>{title(site.role)}</span></div> : null}
        <div><span>Staff</span><span>{num(site.staff.length)}</span></div>
        {site.capacity ? (
          <>
            <div><span>Seats</span><span>{num(site.capacity)}</span></div>
            <div>
              <span>Filled</span>
              <span>{percent(Math.min(1, site.staff.length / site.capacity), 0)}</span>
            </div>
          </>
        ) : null}
        {site.floor ? <div><span>Floor area</span><span>{num(site.floor)} m²</span></div> : null}
        {commute !== null ? (
          <div><span>Median commute</span><span>{commute} min</span></div>
        ) : null}
        <div><span>Industry source</span><span>{EVIDENCE[site.evidence] ?? site.evidence}</span></div>
        {site.estimated ? (
          <div><span>Position</span><span>Estimated</span></div>
        ) : null}
        <div><span>OSM id</span><span><CopyChip value={site.id} /></span></div>
        <div><span>Coordinates</span><span>{coords(site.lat, site.lon)}</span></div>
      </Facts>

      {site.industries.length ? (
        <>
          <DetailHeading>Industries</DetailHeading>
          <Tally
            items={site.industries.map((code) => ({
              key: code, label: labels.industryLabel(code), value: code,
            }))}
          />
        </>
      ) : null}

      {occupations.length ? (
        <>
          <DetailHeading>Occupations</DetailHeading>
          <Tally
            items={occupations.slice(0, 12).map(([label, count]) => ({
              key: label, label, value: num(count),
            }))}
          />
        </>
      ) : null}

      {staff.length ? (
        <>
          <DetailHeading>
            Staff
            <small className="text-muted-foreground tabular-nums">{num(staff.length)}</small>
          </DetailHeading>
          <Members>
            {staff.slice(0, ROSTER_LIMIT).map((assignment) => {
              const person = population.resident(assignment.person);
              return (
                <Member key={assignment.index}>
                  <div><PersonLink names={names} person={assignment.person} /></div>
                  <Facts cols={3}>
                    <Fact label="Age">{person.age}</Fact>
                    <Fact label="Sex">{person.sex}</Fact>
                    {assignment.platoon ? <Fact label="Platoon">{assignment.platoon}</Fact> : null}
                    <Fact label="Occupation">{labels.occupationLabel(assignment.occupation)}</Fact>
                    {assignment.hours ? <Fact label="Hours a week">{assignment.hours}</Fact> : null}
                    {assignment.depart !== null ? <Fact label="Departure">{clock(assignment.depart)}</Fact> : null}
                    {assignment.travel !== null ? <Fact label="Commute">{assignment.travel} min</Fact> : null}
                  </Facts>
                </Member>
              );
            })}
          </Members>
        </>
      ) : null}
    </Drawer>
  );
}

function filter(employment: Employment, filters: Filters): Int32Array {
  const needle = filters.query.trim().toLowerCase();
  const minStaff = filters.minStaff.trim() ? Number(filters.minStaff) : null;
  const matches = new Int32Array(employment.sites.length);
  let found = 0;

  for (const site of employment.sites) {
    if (filters.staffedOnly && !site.staff.length) continue;
    if (filters.group !== "any" && site.group !== filters.group) continue;
    if (filters.evidence !== "any") {
      const evidence = site.evidence || "inferred";
      if (evidence !== filters.evidence) continue;
    }
    if (minStaff !== null && Number.isFinite(minStaff) && site.staff.length < minStaff) continue;
    if (needle
        && !site.name.toLowerCase().includes(needle)
        && !site.address.toLowerCase().includes(needle)
        && !site.id.toLowerCase().includes(needle)
        && !site.klass.toLowerCase().includes(needle)) continue;
    matches[found++] = site.index;
  }

  const result = matches.subarray(0, found);
  const sites = employment.sites;
  const fill = (i: number) =>
    (sites[i].capacity ? sites[i].staff.length / sites[i].capacity : 0);
  const comparators: Record<Sort, (x: number, y: number) => number> = {
    "staff-desc": (x, y) => sites[y].staff.length - sites[x].staff.length,
    "capacity-desc": (x, y) => sites[y].capacity - sites[x].capacity,
    "fill-desc": (x, y) => fill(y) - fill(x),
    "floor-desc": (x, y) => sites[y].floor - sites[x].floor,
    name: (x, y) => siteLabel(sites[x]).localeCompare(siteLabel(sites[y])),
  };
  result.sort(comparators[filters.sort]);
  return result;
}

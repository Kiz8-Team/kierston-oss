"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { Chip, CopyChip, mapHref } from "@/components/console/Chip";
import { useEnrollment } from "@/components/useEnrollment";
import { useNames } from "@/components/useNames";
import { clock } from "@/lib/employment";
import {
  BANDS, BAND_COLOR, BAND_LABEL, SECTOR_LABEL, haversine, schoolLabel,
  type Band, type Enrollment, type School, type Sector,
} from "@/lib/enrollment";
import { coords, metres, num, percent } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";
import { Swatch } from "@/components/Charts";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members, Tally,
} from "@/components/browse/detail";

type Sort = "students-desc" | "capacity-desc" | "fill-desc" | "trip-desc" | "name";

const SECTORS: Sector[] = ["public", "charter", "private", "unknown"];

interface Filters {
  query: string;
  band: "any" | Band;
  sector: "any" | Sector;
  kind: "any" | "school" | "college";
  usedOnly: boolean;
  sort: Sort;
}

/** The widest state, for the way out of a search that matched nothing. */
const WIDEST: Omit<Filters, "sort"> = {
  query: "", band: "any", sector: "any", kind: "any", usedOnly: false,
};

/**
 * The catalogue of places people study, and who was sent to each.
 *
 * The column that matters most here is not the roll but the trip distribution
 * underneath it. Public K-12 assignment is a catchment, so a school whose
 * students travel much further than its neighbours' is one whose catchment had
 * to stretch — the visible symptom of a capacity shortfall two stages upstream.
 */
export function SchoolBrowser() {
  const { population, enrollment, labels, error } = useEnrollment();
  // The map popup links here with the school it was showing.
  const params = useSearchParams();
  // Only the roll needs these, and only once a school is open.
  const names = useNames();

  const [filters, setFilters] = useState<Filters>(() => ({
    query: params.get("school") ?? "", band: "any", sector: "any", kind: "any",
    usedOnly: true, sort: "students-desc",
  }));
  const [selected, setSelected] = useState<number | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const totals = useMemo(() => {
    if (!enrollment) return null;
    let capacity = 0;
    let used = 0;
    let students = 0;
    for (const school of enrollment.schools) {
      capacity += school.capacity;
      students += school.students.length;
      if (school.students.length) used += 1;
    }
    return { capacity, used, students };
  }, [enrollment]);

  const indices = useMemo(
    () => (enrollment ? filter(enrollment, filters) : new Int32Array()),
    [enrollment, filters],
  );

  const filterFields: FilterField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "Name or OSM id",
      grow: true,
    },
    {
      type: "select",
      key: "band",
      label: "Band",
      options: [
        { value: "any", label: "Any band" },
        ...BANDS.map((band) => ({ value: band, label: BAND_LABEL[band] })),
      ],
    },
    {
      type: "select",
      key: "sector", advanced: true,
      label: "Sector",
      options: [
        { value: "any", label: "Any" },
        ...SECTORS.map((sector) => ({ value: sector, label: SECTOR_LABEL[sector] })),
      ],
    },
    {
      type: "select",
      key: "kind", advanced: true,
      label: "Kind",
      options: [
        { value: "any", label: "Any" },
        { value: "school", label: "School" },
        { value: "college", label: "College campus" },
      ],
    },
    {
      type: "select",
      key: "sort",
      label: "Sort",
      options: [
        { value: "students-desc", label: "Largest roll" },
        { value: "capacity-desc", label: "Most places" },
        { value: "fill-desc", label: "Fullest" },
        { value: "trip-desc", label: "Longest median trip" },
        { value: "name", label: "Name" },
      ],
    },
    { type: "checkbox", key: "usedOnly", label: "With students only" },
  ], []);

  const onFilterChange = (key: string, value: string | boolean) => {
    set(key as keyof Filters, value as Filters[keyof Filters]);
  };

  const columns: BrowseColumn[] = useMemo(() => {
    if (!enrollment) return [];
    return [
      {
        id: "school",
        header: "School",
        cell: (index) => {
          const row = enrollment.schools[index];
          return <Chip kind="place" href={mapHref(row.lat, row.lon)} title={schoolLabel(row)}>{schoolLabel(row)}</Chip>;
        },
      },
      {
        id: "teaches",
        header: "Bands",
        width: "12rem",
        cell: (index) => {
          const row = enrollment.schools[index];
          return (
            <>
              {row.bands.map((band) => (
                <span key={band} title={BAND_LABEL[band]}>
                  <Swatch color={BAND_COLOR[band]} />
                </span>
              ))}
              {row.banded
                ? row.bands.map((band) => BAND_LABEL[band]).join(", ")
                : <span className="text-muted-foreground">Any grade</span>}
            </>
          );
        },
      },
      {
        id: "sector",
        header: "Sector",
        width: "7rem",
        cell: (index) => SECTOR_LABEL[enrollment.schools[index].sector],
      },
      {
        id: "roll",
        header: "Roll",
        width: "5rem",
        align: "right",
        cell: (index) => num(enrollment.schools[index].students.length),
      },
      {
        id: "places",
        header: "Places",
        width: "5rem",
        align: "right",
        cell: (index) => num(enrollment.schools[index].capacity),
      },
      {
        id: "full",
        header: "Full",
        width: "4.5rem",
        align: "right",
        cell: (index) => {
          const row = enrollment.schools[index];
          return row.capacity
            ? percent(row.students.length / row.capacity, 0)
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "trip",
        header: "Median trip",
        width: "6rem",
        align: "right",
        cell: (index) => {
          const row = enrollment.schools[index];
          const trip = medianTrip(row, enrollment);
          return trip !== null
            ? `${trip} min`
            : <span className="text-muted-foreground">—</span>;
        },
      },
    ];
  }, [enrollment]);

  const ready = Boolean(enrollment && labels && population);
  const school = enrollment && selected !== null ? enrollment.schools[selected] : null;

  return (
    <DataBrowser
      title="Schools"
      lead={
        enrollment && totals
          ? `${num(enrollment.schools.length)} institutions · `
            + `${num(totals.capacity)} places · ${num(totals.used)} in use · `
            + `${num(enrollment.modes.external)} enrolled outside Kierston`
          : error
            ? <StatusText state="error">{error}</StatusText>
            : "Loading…"
      }
      filters={filterFields}
      filterValues={filters as unknown as Record<string, string | boolean>}
      onFilterChange={onFilterChange}
      table={enrollment ? {
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
        <EmptyState title={error ? "No school catalogue" : undefined}>
          {error ? (
            <p>
              <span className="font-sans text-[max(0.75rem,0.8em)]">python kierston/init/education/schools.py</span>
              <br />
              <span className="font-sans text-[max(0.75rem,0.8em)]">assign_school.py</span>
            </p>
          ) : (
            "Loading…"
          )}
        </EmptyState>
      }
      detail={
        school && ready ? (
          <SchoolDetail
            school={school}
            enrollment={enrollment!}
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

const ROLL_LIMIT = 30;

function SchoolDetail({
  school, enrollment, labels, population, names, onClose,
}: {
  school: School;
  enrollment: Enrollment;
  labels: Labels;
  population: Population;
  names: Identity | null;
  onClose: () => void;
}) {
  const roll = useMemo(
    () => school.students.map((index) => enrollment.assignments[index]),
    [school, enrollment],
  );

  const grades = useMemo(() => {
    const counts = new Map<string, number>();
    for (const student of roll) {
      const label = labels.gradeLabel(student.grade) || BAND_LABEL[student.band];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // Grade order, not frequency: a school's roll reads as a ladder.
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, {
      numeric: true,
    }));
  }, [roll, labels]);

  /**
   * How far the catchment reaches. The p90 and the maximum matter more than the
   * median: a stretched catchment shows up in its tail, because the students a
   * full school sheds are always its most distant ones.
   */
  const catchment = useMemo(() => {
    const distances: number[] = [];
    for (const student of roll) {
      distances.push(haversine(
        enrollment.homeLat[student.index], enrollment.homeLon[student.index],
        school.lat, school.lon));
    }
    distances.sort((a, b) => a - b);
    if (!distances.length) return null;
    return {
      median: distances[distances.length >> 1],
      p90: distances[Math.floor(distances.length * 0.9)],
      max: distances[distances.length - 1],
    };
  }, [roll, enrollment, school]);

  const trip = medianTrip(school, enrollment);
  const departures = roll
    .map((student) => student.depart)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={school.kind === "college" ? "College campus" : "School"}>
        <Chip kind="place" href={`/map?lat=${school.lat}&lon=${school.lon}&zoom=17&school=1`}>
          {schoolLabel(school)}
        </Chip>
      </DetailLead>

      <Facts>
        <div>
          <span>Bands</span>
          <span>
            {school.bands.map((band) => BAND_LABEL[band]).join(", ")}
            {school.banded ? "" : " (inferred)"}
          </span>
        </div>
        <div><span>Sector</span><span>{SECTOR_LABEL[school.sector]}</span></div>
        <div><span>Roll</span><span>{num(school.students.length)}</span></div>
        <div><span>Places</span><span>{num(school.capacity)}</span></div>
        {school.capacity ? (
          <div>
            <span>Filled</span>
            <span>{percent(school.students.length / school.capacity, 0)}</span>
          </div>
        ) : null}
        {school.floor ? (
          <div><span>Floor area</span><span>{num(school.floor)} m²</span></div>
        ) : null}
        {trip !== null ? <div><span>Median trip</span><span>{trip} min</span></div> : null}
        <div><span>OSM id</span><span><CopyChip value={school.id} /></span></div>
        <div><span>Coordinates</span><span>{coords(school.lat, school.lon)}</span></div>
      </Facts>

      {school.buildings.length > 1 ? (
        <>
          <DetailHeading>
            Buildings
            <small className="text-muted-foreground tabular-nums">{school.buildings.length}</small>
          </DetailHeading>
          <div className="flex flex-wrap gap-1.5">
            {school.buildings.map((id) => <CopyChip key={id} value={id} />)}
          </div>
        </>
      ) : null}

      {catchment ? (
        <>
          <DetailHeading>Catchment</DetailHeading>
          <Facts cols={3}>
            <div><span>Median</span><span>{metres(catchment.median)}</span></div>
            <div><span>p90</span><span>{metres(catchment.p90)}</span></div>
            <div><span>Farthest</span><span>{metres(catchment.max)}</span></div>
          </Facts>
        </>
      ) : null}

      {departures.length ? (
        <>
          <DetailHeading>Departures</DetailHeading>
          <Facts>
            <div><span>First departure</span><span>{clock(departures[0])}</span></div>
            <div>
              <span>Last departure</span>
              <span>{clock(departures[departures.length - 1])}</span>
            </div>
          </Facts>
        </>
      ) : null}

      {grades.length ? (
        <>
          <DetailHeading>Roll by grade</DetailHeading>
          <Tally items={grades.map(([label, count]) => ({ key: label, label, value: num(count) }))} />
        </>
      ) : null}

      {roll.length ? (
        <>
          <DetailHeading>
            Students
            <small className="text-muted-foreground tabular-nums">{num(roll.length)}</small>
          </DetailHeading>
          <Members>
            {roll.slice(0, ROLL_LIMIT).map((student) => {
              const person = population.resident(student.person);
              return (
                <Member key={student.index}>
                  <div><PersonLink names={names} person={student.person} /></div>
                  <Facts cols={3}>
                    <Fact label="Grade">{labels.gradeLabel(student.grade) || BAND_LABEL[student.band]}</Fact>
                    <Fact label="Age">{person.age}</Fact>
                    <Fact label="Sex">{person.sex}</Fact>
                    {student.depart !== null ? <Fact label="Departure">{clock(student.depart)}</Fact> : null}
                    {student.travel !== null ? <Fact label="Trip">{student.travel} min</Fact> : null}
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

/** The median assigned trip into a school, or null if it has no roll. */
function medianTrip(school: School, enrollment: Enrollment): number | null {
  const times = school.students
    .map((index) => enrollment.assignments[index].travel)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  return times.length ? times[times.length >> 1] : null;
}

function filter(enrollment: Enrollment, filters: Filters): Int32Array {
  const needle = filters.query.trim().toLowerCase();
  const matches = new Int32Array(enrollment.schools.length);
  let found = 0;

  for (const school of enrollment.schools) {
    if (filters.usedOnly && !school.students.length) continue;
    if (filters.band !== "any" && !school.bands.includes(filters.band)) continue;
    if (filters.sector !== "any" && school.sector !== filters.sector) continue;
    if (filters.kind !== "any" && school.kind !== filters.kind) continue;
    if (needle
        && !school.name.toLowerCase().includes(needle)
        && !school.id.toLowerCase().includes(needle)
        && !school.buildings.some((id) => id.toLowerCase().includes(needle))) continue;
    matches[found++] = school.index;
  }

  const result = matches.subarray(0, found);
  const schools = enrollment.schools;
  const fill = (i: number) =>
    (schools[i].capacity ? schools[i].students.length / schools[i].capacity : 0);
  const trip = (i: number) => medianTrip(schools[i], enrollment) ?? -1;
  const comparators: Record<Sort, (x: number, y: number) => number> = {
    "students-desc": (x, y) => schools[y].students.length - schools[x].students.length,
    "capacity-desc": (x, y) => schools[y].capacity - schools[x].capacity,
    "fill-desc": (x, y) => fill(y) - fill(x),
    "trip-desc": (x, y) => trip(y) - trip(x),
    name: (x, y) => schoolLabel(schools[x]).localeCompare(schoolLabel(schools[y])),
  };
  result.sort(comparators[filters.sort]);
  return result;
}

"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { AddressChip, Chip, CopyChip, HouseholdChip, mapHref } from "@/components/console/Chip";
import { useEnrollment } from "@/components/useEnrollment";
import { useNames } from "@/components/useNames";
import { clock } from "@/lib/employment";
import {
  BANDS, BAND_COLOR, BAND_LABEL, MODE_LABEL, SECTOR_LABEL,
  haversine, schoolLabel,
  type Band, type Enrollment, type Enrollment_, type Sector, type StudyMode,
} from "@/lib/enrollment";
import { metres, num, title, usd } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";
import { Swatch } from "@/components/Charts";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members,
} from "@/components/browse/detail";

type Sort = "person" | "trip-desc" | "trip-asc" | "grade-asc" | "depart-asc";

const MODES: StudyMode[] = ["enrolled", "external"];
const SECTORS: Sector[] = ["public", "charter", "private"];

interface Filters {
  query: string;
  band: "any" | Band;
  mode: "any" | StudyMode;
  sector: "any" | Sector;
  maxTrip: string;
  sort: Sort;
}

const EMPTY: Filters = {
  query: "", band: "any", mode: "any", sector: "any", maxTrip: "", sort: "person",
};

/**
 * Every student in the city, one row per enrolled person.
 *
 * The same machinery as the jobs browser — filter to an index array, render
 * only the visible rows — over a quarter of the population that until now had
 * no daytime location at all.
 */
export function StudentsBrowser() {
  const { population, enrollment, labels, error } = useEnrollment();
  // A roster in the schools browser links here to see the rest of it.
  const params = useSearchParams();
  const names = useNames();

  const [filters, setFilters] = useState<Filters>(
    () => ({ ...EMPTY, query: params.get("school") ?? "" }));
  const [selected, setSelected] = useState<number | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const indices = useMemo(
    () => (enrollment ? filter(enrollment, filters) : new Int32Array()),
    [enrollment, filters],
  );

  const filterFields: FilterField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "School name, address or OSM id",
      grow: true,
    },
    {
      type: "select",
      key: "band",
      label: "Band",
      options: [
        { value: "any", label: "Any" },
        ...BANDS.map((band) => ({ value: band, label: BAND_LABEL[band] })),
      ],
    },
    {
      type: "select",
      key: "mode", advanced: true,
      label: "Placed",
      options: [
        { value: "any", label: "Any" },
        ...MODES.map((mode) => ({ value: mode, label: title(MODE_LABEL[mode]) })),
      ],
    },
    {
      type: "select",
      key: "sector", advanced: true,
      label: "Reported sector",
      options: [
        { value: "any", label: "Any" },
        ...SECTORS.map((sector) => ({ value: sector, label: SECTOR_LABEL[sector] })),
      ],
    },
    {
      type: "text",
      key: "maxTrip", advanced: true,
      label: "Trip under",
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
        { value: "trip-desc", label: "Longest trip" },
        { value: "trip-asc", label: "Shortest trip" },
        { value: "grade-asc", label: "By grade" },
        { value: "depart-asc", label: "Earliest start" },
      ],
    },
  ], []);

  const onFilterChange = (key: string, value: string | boolean) => {
    set(key as keyof Filters, value as Filters[keyof Filters]);
  };

  const columns: BrowseColumn[] = useMemo(() => {
    if (!enrollment || !labels || !population) return [];
    return [
      {
        id: "person",
        header: "Person",
        width: "12rem",
        cell: (index) => {
          const row = enrollment.assignments[index];
          return <PersonLink names={names} person={row.person} />;
        },
      },
      {
        id: "age",
        header: "Age",
        width: "4rem",
        align: "right",
        cell: (index) => population.resident(enrollment.assignments[index].person).age,
      },
      {
        id: "grade",
        header: "Grade",
        width: "9rem",
        cell: (index) => {
          const row = enrollment.assignments[index];
          return labels.gradeLabel(row.grade) || <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "band",
        header: "Band",
        width: "9rem",
        cell: (index) => {
          const row = enrollment.assignments[index];
          return (
            <>
              <Swatch color={BAND_COLOR[row.band]} />
              {BAND_LABEL[row.band]}
            </>
          );
        },
      },
      {
        id: "school",
        header: "School",
        cell: (index) => {
          const row = enrollment.assignments[index];
          const school = enrollment.schoolOf(row);
          return (
            <span title={schoolLabel(school)}>
              {school
                ? <Chip kind="place" href={mapHref(school.lat, school.lon)}>{schoolLabel(school)}</Chip>
                : <span className="text-muted-foreground">outside the region</span>}
            </span>
          );
        },
      },
      {
        id: "sector",
        header: "Sector",
        width: "7rem",
        cell: (index) => {
          const row = enrollment.assignments[index];
          const school = enrollment.schoolOf(row);
          return school
            ? SECTOR_LABEL[school.sector]
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "trip",
        header: "Trip",
        width: "5rem",
        align: "right",
        cell: (index) => {
          const row = enrollment.assignments[index];
          return row.travel !== null
            ? `${row.travel} min`
            : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "leaves",
        header: "Departure",
        width: "6rem",
        align: "right",
        cell: (index) => {
          const row = enrollment.assignments[index];
          return row.depart !== null
            ? clock(row.depart)
            : <span className="text-muted-foreground">—</span>;
        },
      },
    ];
  }, [enrollment, labels, population, names]);

  const ready = Boolean(enrollment && labels && population);
  const assignment = enrollment && selected !== null ? enrollment.assignments[selected] : null;

  return (
    <DataBrowser
      title="Students"
      lead={
        enrollment
          ? `${num(enrollment.students)} enrolled · `
            + `${num(enrollment.placed)} in Kierston · `
            + `${num(enrollment.modes.external)} enrolled outside Kierston`
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
        <EmptyState title={error ? "No enrollment table" : undefined}>
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
        assignment && ready ? (
          <StudentDetail
            assignment={assignment}
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

function StudentDetail({
  assignment, enrollment, labels, population, names, onClose,
}: {
  assignment: Enrollment_;
  enrollment: Enrollment;
  labels: Labels;
  population: Population;
  names: Identity | null;
  onClose: () => void;
}) {
  const school = enrollment.schoolOf(assignment);
  const person = population.resident(assignment.person);
  const home = population.building(population.residentBuilding(assignment.person));
  const household = population.residentHousehold(assignment.person);

  /**
   * Siblings at the same school, which assign_school.py guarantees for anyone
   * in the same band and is free to check for the others. This is the edge the
   * social graph will lean on hardest, so it is worth being able to see one.
   */
  const siblings = useMemo(() => {
    if (household < 0 || !school) return [];
    return population.household(household).members
      .map((member) => enrollment.forPerson(member.index))
      .filter((other): other is Enrollment_ =>
        other !== null
        && other.person !== assignment.person
        && other.school === assignment.school);
  }, [household, school, population, enrollment, assignment]);

  return (
    <Drawer onClose={onClose}>
      <DetailLead sub={labels.gradeLabel(assignment.grade) || BAND_LABEL[assignment.band]}>
        <PersonLink names={names} person={assignment.person} />
      </DetailLead>

      <Facts>
        <div><span>Age</span><span>{person.age}</span></div>
        <div><span>Sex</span><span>{person.sex}</span></div>
        <div><span>Race and ethnicity</span><span>{person.race}</span></div>
        <div><span>Attainment</span><span>{person.education}</span></div>
        <div><span>Band</span><span>{BAND_LABEL[assignment.band]}</span></div>
        <div><span>Grade · SCHG</span><span>
          {labels.gradeLabel(assignment.grade) || "—"}
          {assignment.grade ? <> · {assignment.grade}</> : null}
        </span></div>
        <div><span>Reported sector</span><span>{SECTOR_LABEL[assignment.sector]}</span></div>
      </Facts>

      <DetailHeading>School day</DetailHeading>
      <Facts>
        <div className="col-span-full">
          <span>School</span>
          <span>
            {school ? (
              <Chip kind="place" href={`/schools?school=${encodeURIComponent(school.id)}`}>
                {schoolLabel(school)}
              </Chip>
            ) : schoolLabel(school)}
          </span>
        </div>
        {school ? (
          <>
            <div><span>Sector</span><span>{SECTOR_LABEL[school.sector]}</span></div>
            <div><span>Site id</span><span><CopyChip value={school.id} /></span></div>
            <div><span>Schoolmates</span><span>{num(school.students.length - 1)}</span></div>
            <div>
              <span>Distance home to school</span>
              <span>{metres(haversine(home.lat, home.lon, school.lat, school.lon))}</span>
            </div>
          </>
        ) : null}
        <div><span>Departure</span><span>{clock(assignment.depart)}</span></div>
        <div><span>Return</span><span>{clock(assignment.arrive)}</span></div>
        <div>
          <span>Trip</span>
          <span>{assignment.travel !== null ? `${assignment.travel} min` : "—"}</span>
        </div>
      </Facts>

      {siblings.length ? (
        <>
          <DetailHeading>Siblings</DetailHeading>
          <Members>
            {siblings.map((sibling) => {
              const other = population.resident(sibling.person);
              return (
                <Member key={sibling.index}>
                  <div><PersonLink names={names} person={sibling.person} /></div>
                  <Facts cols={3}>
                    <Fact label="Age">{other.age}</Fact>
                    <Fact label="Sex">{other.sex}</Fact>
                    <Fact label="Grade">{labels.gradeLabel(sibling.grade) || BAND_LABEL[sibling.band]}</Fact>
                    {sibling.travel !== null ? <Fact label="Trip">{sibling.travel} min</Fact> : null}
                  </Facts>
                </Member>
              );
            })}
          </Members>
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

function filter(enrollment: Enrollment, filters: Filters): Int32Array {
  const needle = filters.query.trim().toLowerCase();
  const maxTrip = filters.maxTrip.trim() ? Number(filters.maxTrip) : null;
  const matches = new Int32Array(enrollment.assignments.length);
  let found = 0;

  for (const assignment of enrollment.assignments) {
    if (filters.band !== "any" && assignment.band !== filters.band) continue;
    if (filters.mode !== "any" && assignment.mode !== filters.mode) continue;
    if (filters.sector !== "any" && assignment.sector !== filters.sector) continue;
    if (maxTrip !== null && Number.isFinite(maxTrip)
        && (assignment.travel === null || assignment.travel > maxTrip)) continue;
    if (needle) {
      const school = enrollment.schoolOf(assignment);
      const hit = school
        ? school.name.toLowerCase().includes(needle)
          || school.id.toLowerCase().includes(needle)
        : false;
      if (!hit) continue;
    }
    matches[found++] = assignment.index;
  }

  const result = matches.subarray(0, found);
  const rows = enrollment.assignments;
  // Missing values sort last whichever way the column runs: a student with no
  // place here has no trip, not a zero-minute one.
  const last = (value: number | null, descending: boolean) =>
    value ?? (descending ? -Infinity : Infinity);
  const comparators: Record<Sort, (x: number, y: number) => number> = {
    person: (x, y) => rows[x].person - rows[y].person,
    "trip-desc": (x, y) => last(rows[y].travel, true) - last(rows[x].travel, true),
    "trip-asc": (x, y) => last(rows[x].travel, false) - last(rows[y].travel, false),
    // SCHG is zero-padded and ordinal, so the codes sort into grade order.
    "grade-asc": (x, y) => (rows[x].grade ?? "99").localeCompare(rows[y].grade ?? "99"),
    "depart-asc": (x, y) => last(rows[x].depart, false) - last(rows[y].depart, false),
  };
  result.sort(comparators[filters.sort]);
  return result;
}

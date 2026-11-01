"use client";

import { useMemo, useState } from "react";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { AddressChip, Chip, HouseholdChip } from "@/components/console/Chip";
import { useEmployment } from "@/components/useEmployment";
import { useNames } from "@/components/useNames";
import { usePopulation } from "@/components/usePopulation";
import { clock, siteLabel } from "@/lib/employment";
import { title, usd } from "@/lib/format";
import type { Labels } from "@/lib/labels";
import { EMPLOYMENT, RACE_LABEL, RELATIONSHIP, type Population } from "@/lib/population";
import {
  DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members, PersonFacts,
} from "@/components/browse/detail";

type Sort = "age-desc" | "age-asc" | "income-desc" | "household";

interface Filters {
  query: string;
  minAge: string;
  maxAge: string;
  sex: "any" | "1" | "2";
  employment: string;
  race: string;
  sort: Sort;
}

/**
 * Every person in the simulation, household members and group-quarters
 * residents alike, over the same index-array machinery as the households
 * browser.
 */
export default function PeoplePage() {
  const { population, error } = usePopulation();
  // Occupation and industry are stored as PUMS codes, and the job itself lives
  // in a separate table; both fill in behind the population rather than
  // holding the table up.
  const { employment, labels } = useEmployment();
  // Names are a records-layer file, so the table renders numbered until it
  // arrives and then re-renders with people in it.
  const names = useNames();

  const [filters, setFilters] = useState<Filters>({
    query: "", minAge: "", maxAge: "", sex: "any", employment: "any", race: "any",
    sort: "household",
  });
  const [selected, setSelected] = useState<number | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const races = useMemo(
    () => (population ? population.strings.race.filter(Boolean) : []),
    [population],
  );

  const indices = useMemo(
    () => (population ? filterPeople(population, filters, labels) : new Int32Array()),
    [population, filters, labels],
  );

  // Until the code books arrive, the code is the best name available.
  const name = (code: string) => (labels ? labels.occupationLabel(code) : code);

  const person = population && selected !== null ? population.person(selected) : null;
  const job = employment && selected !== null ? employment.forPerson(selected) : null;
  const workplace = employment ? employment.siteOf(job) : null;
  const householdIndex = population && selected !== null
    ? population.householdOfPerson(selected) : -1;
  const household = population && householdIndex >= 0
    ? population.household(householdIndex) : null;

  const filterFields: FilterField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "Occupation, industry or address",
      grow: true,
    },
    { type: "text", key: "minAge", label: "Age from", width: "4.5rem", inputMode: "numeric" },
    { type: "text", key: "maxAge", label: "to", width: "4.5rem", inputMode: "numeric" },
    {
      type: "select",
      key: "sex",
      label: "Sex",
      options: [
        { value: "any", label: "Any" },
        { value: "1", label: "Male" },
        { value: "2", label: "Female" },
      ],
    },
    {
      type: "select",
      key: "employment", advanced: true,
      label: "Employment",
      options: [
        { value: "any", label: "Any" },
        ...Object.entries(EMPLOYMENT).map(([code, label]) => ({
          value: code,
          label: title(label),
        })),
      ],
    },
    {
      type: "select",
      key: "race", advanced: true,
      label: "Race",
      options: [
        { value: "any", label: "Any" },
        ...races.map((race) => ({
          value: race,
          label: RACE_LABEL[race] ?? race,
        })),
      ],
    },
    {
      type: "select",
      key: "sort",
      label: "Sort",
      options: [
        { value: "household", label: "By household" },
        { value: "age-desc", label: "Oldest first" },
        { value: "age-asc", label: "Youngest first" },
        { value: "income-desc", label: "Highest earners" },
      ],
    },
  ], [races]);

  const filterValues: Record<string, string | boolean> = { ...filters };

  const onFilterChange = (key: string, value: string | boolean) => {
    set(key as keyof Filters, value as Filters[keyof Filters]);
  };

  const columns: BrowseColumn[] = useMemo(() => {
    if (!population) return [];
    const a = population.a;
    return [
      {
        id: "person",
        header: "Person",
        width: "12rem",
        cell: (index) => <PersonLink names={names} person={index} />,
      },
      {
        id: "age",
        header: "Age",
        width: "3.5rem",
        align: "right",
        cell: (index) => a.person_age[index],
      },
      {
        id: "sex",
        header: "Sex",
        width: "5rem",
        cell: (index) => (a.person_sex[index] === 1 ? "male" : "female"),
      },
      {
        id: "relationship",
        header: "Relationship",
        width: "8rem",
        cell: (index) => RELATIONSHIP[a.person_relationship[index]] ?? "—",
      },
      {
        id: "status",
        header: "Status",
        width: "9rem",
        cell: (index) => (a.person_age[index] >= 16
          ? EMPLOYMENT[a.person_employment[index]] ?? "—"
          : <span className="text-muted-foreground">under 16</span>),
      },
      {
        id: "occupation",
        header: "Occupation",
        cell: (index) => name(population.strings.occupation[a.person_occupation[index]])
          || <span className="text-muted-foreground">—</span>,
      },
      {
        id: "income",
        header: "Income",
        width: "7rem",
        align: "right",
        cell: (index) => (a.person_income[index]
          ? usd(a.person_income[index])
          : <span className="text-muted-foreground">—</span>),
      },
    ];
  }, [population, names, labels]);

  return (
    <DataBrowser
      title="People"
      filters={filterFields}
      filterValues={filterValues}
      onFilterChange={onFilterChange}
      table={population ? {
        indices,
        columns,
        selected,
        onSelect: setSelected,
        empty: {
          title: "No matches",
          onClear: () => setFilters({
            query: "", minAge: "", maxAge: "", sex: "any",
            employment: "any", race: "any", sort: filters.sort,
          }),
        },
      } : null}
      loading={
        <EmptyState title={error ? "No population" : undefined}>
          {error ? (
            <>
              <StatusText state="error">{error}</StatusText>
              <p>
                <code className="text-[max(0.75rem,0.8em)]">python kierston/init/population/pack_population.py</code>
              </p>
            </>
          ) : (
            "Loading…"
          )}
        </EmptyState>
      }
      detail={
        person && household ? (
          <Drawer onClose={() => setSelected(null)}>
            <DetailLead sub={`${title(person.relationship)} · Resident ${person.index}`}>
              <PersonLink names={names} person={person.index} />
            </DetailLead>
            <Facts>
              <Fact label="Age">{person.age}</Fact>
              <Fact label="Sex">{person.sex}</Fact>
              <Fact label="Race and ethnicity">{RACE_LABEL[person.race] ?? person.race}</Fact>
              <Fact label="Education">{person.education}</Fact>
              <Fact label="Employment">{person.age >= 16 ? person.employment : "Under 16"}</Fact>
              <Fact label="Personal income">{usd(person.income)}</Fact>
              {person.occupation ? <Fact label="Occupation">{name(person.occupation)}</Fact> : null}
              {person.industry ? (
                <Fact label="Industry">
                  {labels ? labels.industryLabel(person.industry) : person.industry}
                </Fact>
              ) : null}
              {person.soc ? <Fact label="SOC code">{person.soc}</Fact> : null}
            </Facts>
            {job ? (
              <>
                <DetailHeading>Work</DetailHeading>
                <Facts>
                  <Fact label="Workplace" wide>
                    {workplace ? (
                      <Chip
                        kind="place"
                        href={`/workplaces?site=${encodeURIComponent(workplace.id)}`}
                      >
                        {siteLabel(workplace)}
                      </Chip>
                    ) : siteLabel(workplace)}
                  </Fact>
                  {workplace?.address ? (
                    <Fact label="Address">
                      <AddressChip address={workplace.address} lat={workplace.lat} lon={workplace.lon} />
                    </Fact>
                  ) : null}
                  <Fact label="Hours a week">{job.hours ?? "—"}</Fact>
                  <Fact label="Departure">{clock(job.depart)}</Fact>
                  <Fact label="Commute">{job.travel !== null ? `${job.travel} min` : "—"}</Fact>
                </Facts>
              </>
            ) : null}
            <DetailHeading>Household</DetailHeading>
            <Facts>
              <Fact label="Household"><HouseholdChip household={household.index} /></Fact>
              <Fact label="Address">
                {household.building.address
                  ? <AddressChip address={household.building.address} lat={household.building.lat} lon={household.building.lon} />
                  : "—"}
              </Fact>
              <Fact label="Household income">{usd(household.income)}</Fact>
              <Fact label="Unit area">{Math.round(household.area)} m²</Fact>
            </Facts>
            <DetailHeading>
              Residents
              <small className="text-muted-foreground tabular-nums">{household.members.length}</small>
            </DetailHeading>
            <Members>
              {household.members.map((member) => (
                <Member key={member.index}>
                  <div className="flex items-center gap-2">
                    <PersonLink names={names} person={member.index} />
                    {member.index === person.index ? (
                      <span className="text-[0.72rem] text-muted-foreground">Selected</span>
                    ) : null}
                  </div>
                  <PersonFacts
                    age={member.age}
                    sex={member.sex}
                    relationship={member.relationship}
                    education={member.education}
                  />
                </Member>
              ))}
            </Members>
          </Drawer>
        ) : null
      }
    />
  );
}

function filterPeople(
  population: Population,
  filters: Filters,
  labels: Labels | null,
): Int32Array {
  const a = population.a;
  const count = a.person_age.length;
  const needle = filters.query.trim().toLowerCase();
  const minAge = filters.minAge.trim() ? Number(filters.minAge) : null;
  const maxAge = filters.maxAge.trim() ? Number(filters.maxAge) : null;
  const sex = filters.sex === "any" ? null : Number(filters.sex);
  const employment = filters.employment === "any" ? null : Number(filters.employment);
  const race = filters.race === "any"
    ? null
    : population.strings.race.indexOf(filters.race);

  const matches = new Int32Array(count);
  let found = 0;
  for (let p = 0; p < count; p += 1) {
    const age = a.person_age[p];
    if (minAge !== null && Number.isFinite(minAge) && age < minAge) continue;
    if (maxAge !== null && Number.isFinite(maxAge) && age > maxAge) continue;
    if (sex !== null && a.person_sex[p] !== sex) continue;
    if (employment !== null && a.person_employment[p] !== employment) continue;
    if (race !== null && a.person_race[p] !== race) continue;
    if (needle) {
      const occupation = population.strings.occupation[a.person_occupation[p]];
      const industry = population.strings.industry[a.person_industry[p]];
      // Both the code and its name: "3870" and "police" find the same people.
      let hit = occupation.toLowerCase().includes(needle)
        || industry.toLowerCase().includes(needle)
        || (labels !== null
          && (labels.occupationLabel(occupation).toLowerCase().includes(needle)
            || labels.industryLabel(industry).toLowerCase().includes(needle)));
      if (!hit) {
        // Addresses are a household attribute, so this is the one filter that
        // has to walk back to the person's household.
        const household = population.householdOfPerson(p);
        const building = a.household_building[household];
        hit = population.strings.address[a.building_address[building]]
          .toLowerCase().includes(needle);
      }
      if (!hit) continue;
    }
    matches[found++] = p;
  }

  const result = matches.subarray(0, found);
  const comparators: Record<Sort, ((x: number, y: number) => number) | null> = {
    household: null,
    "age-desc": (x, y) => a.person_age[y] - a.person_age[x],
    "age-asc": (x, y) => a.person_age[x] - a.person_age[y],
    "income-desc": (x, y) => a.person_income[y] - a.person_income[x],
  };
  const comparator = comparators[filters.sort];
  // People are already stored in household order, so "by household" is the
  // order they come out of the filter in.
  if (comparator) result.sort(comparator);
  return result;
}

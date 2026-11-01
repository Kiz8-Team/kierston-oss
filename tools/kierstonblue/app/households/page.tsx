"use client";

import { useEffect, useMemo, useState } from "react";
import { Home, SearchX } from "lucide-react";

import { ConsoleTable, type ConsoleColumn } from "@/components/console/ConsoleTable";
import { ConsoleFilters, type ConsoleField } from "@/components/console/Filters";
import { Panel } from "@/components/console/Panel";
import { ConsoleButton, Placeholder } from "@/components/console/Record";
import {
  DRAWER_GRID, DetailHeading, DetailLead, Drawer, Fact, Facts, Member, Members, PersonFacts,
} from "@/components/browse/detail";
import { PersonLink } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import { usePopulation } from "@/components/usePopulation";
import { humanise, num, usd } from "@/lib/format";
import { RACE_LABEL, type Population } from "@/lib/population";
import { cn } from "@/lib/utils";
import { AddressChip, CopyChip } from "@/components/console/Chip";

type SortKey = "income" | "size" | "area" | "address";

const SIZES = ["any", "1", "2", "3", "4", "5+"] as const;

/** A type alias rather than an interface: the filter row takes a plain
 *  string map, and only an alias is assignable to an index signature. */
type Filters = {
  query: string;
  size: (typeof SIZES)[number];
  minIncome: string;
  maxIncome: string;
};

const CLEAR: Filters = { query: "", size: "any", minIncome: "", maxIncome: "" };

/**
 * Every household, filtered and sorted over the packed columns.
 *
 * The filter produces an index array rather than a list of objects, so a
 * 38,000-row result costs one Int32Array and the table only ever builds the
 * thirty rows on screen.
 */
export default function HouseholdsPage() {
  const { population, error } = usePopulation();
  // Names fill in behind the table rather than holding it up: a household is
  // browsable without identity.bin, its members are just numbered.
  const names = useNames();

  const [filters, setFilters] = useState<Filters>(CLEAR);
  const [sort, setSort] = useState<{ id: SortKey; dir: 1 | -1 }>({ id: "income", dir: -1 });
  const [selected, setSelected] = useState<number | null>(null);

  // Entity chips elsewhere in the console deep-link to a household. Keep the
  // browser usable without coupling this client page to a Suspense boundary.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("household");
    if (value === null) return;
    const household = Number(value);
    if (Number.isSafeInteger(household) && household >= 0) setSelected(household);
  }, []);

  const indices = useMemo(
    () => (population ? filter(population, filters, sort) : new Int32Array()),
    [population, filters, sort],
  );

  const household = population && selected !== null
    && selected < population.counts.households
    ? population.household(selected)
    : null;

  const fields: ConsoleField[] = useMemo(() => [
    {
      type: "search",
      key: "query",
      label: "Address or OSM id",
    },
    {
      type: "segment",
      key: "size",
      label: "People",
      options: SIZES.map((size) => ({
        value: size,
        label: size === "any" ? "Any" : size,
      })),
    },
    { type: "range", minKey: "minIncome", maxKey: "maxIncome", label: "Income", prefix: "$" },
  ], []);

  const columns: ConsoleColumn[] = useMemo(() => {
    if (!population) return [];
    const a = population.a;
    return [
      {
        id: "household",
        header: "ID",
        width: "5.5rem",
        cell: (index) => <span className="tabular-nums text-muted-foreground">{index}</span>,
      },
      {
        id: "address",
        header: "Address",
        sortable: true,
        cell: (index) => {
          const building = a.household_building[index];
          const address = population.strings.address[a.building_address[building]];
          return address
            ? <AddressChip address={address} lat={a.building_lat[building]} lon={a.building_lon[building]} />
            : <span className="text-muted-foreground/60">no address</span>;
        },
      },
      {
        id: "kind",
        header: "Building",
        width: "8rem",
        cell: (index) => (
          <span className="text-muted-foreground">
            {population.strings.kind[a.building_kind[a.household_building[index]]] || "—"}
          </span>
        ),
      },
      {
        id: "unit",
        header: "Unit",
        width: "4.5rem",
        align: "right",
        cell: (index) => a.household_unit[index] + 1,
      },
      {
        id: "size",
        header: "People",
        width: "5rem",
        align: "right",
        sortable: true,
        cell: (index) => a.household_size[index],
      },
      {
        id: "income",
        header: "Income",
        width: "7.5rem",
        align: "right",
        sortable: true,
        cell: (index) => usd(a.household_income[index]),
      },
      {
        id: "area",
        header: "Floor area",
        width: "6.5rem",
        align: "right",
        sortable: true,
        cell: (index) => `${Math.round(a.household_area[index])} m²`,
      },
    ];
  }, [population]);

  const onSort = (id: string) => {
    const key = id as SortKey;
    setSort((current) => current.id === key
      // A second click on the same column turns it around; a first click on a
      // new one starts where that column is most useful — biggest first for a
      // quantity, A to Z for a name.
      ? { id: key, dir: current.dir === 1 ? -1 : 1 }
      : { id: key, dir: key === "address" ? 1 : -1 });
  };

  return (
    <main
      id="content"
      className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden p-3"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pt-1">
        <h1 className="text-[1.35rem] font-semibold tracking-tight">Households</h1>
        <p className="m-0 text-[0.78rem] text-pretty text-muted-foreground">
          {error
            ? <span className="text-destructive">{error}</span>
            : population
              ? `${num(population.counts.households)} households`
              : "Loading…"}
        </p>
      </header>

      <ConsoleFilters
        fields={fields}
        values={filters}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />

      <div
        className={cn(
          "grid min-h-0 gap-3",
          household
            ? DRAWER_GRID
            : "grid-cols-1",
        )}
      >
        <Panel flush>
          <div className="min-h-0 flex-1">
            {population ? (
              <ConsoleTable
                indices={indices}
                columns={columns}
                selected={selected}
                onSelect={setSelected}
                sort={sort}
                onSort={onSort}
                empty={
                  <Placeholder
                    icon={SearchX}
                    title="No matches"
                    action={
                      <ConsoleButton className="mt-1" onClick={() => setFilters(CLEAR)}>
                        Clear filters
                      </ConsoleButton>
                    }
                  />
                }
              />
            ) : (
              <Placeholder
                icon={Home}
                title={error ? "No population" : "Loading…"}
              >
                {error ? (
                  <code>python kierston/init/population/pack_population.py</code>
                ) : null}
              </Placeholder>
            )}
          </div>
        </Panel>

        {household ? (
          <Drawer onClose={() => setSelected(null)}>
            <DetailLead
              sub={
                <>
                  {household.building.units > 1
                    ? `Unit ${household.unit + 1} of ${household.building.units}`
                    : "Single dwelling"}
                  {household.building.kind ? ` · ${humanise(household.building.kind)}` : ""}
                </>
              }
            >
              {household.building.address
                ? <AddressChip address={household.building.address} lat={household.building.lat} lon={household.building.lon} />
                : "No address"}
            </DetailLead>

            <DetailHeading>Dwelling</DetailHeading>
            <Facts cols={3}>
              <Fact label="Floor area">{Math.round(household.area)} m²</Fact>
              <Fact label="Residents">{household.size}</Fact>
              <Fact label="Area per resident">
                {Math.round(household.area / Math.max(1, household.size))} m²
              </Fact>
            </Facts>

            <DetailHeading>Income</DetailHeading>
            <Facts cols={3}>
              <Fact label="Household">{usd(household.income)}</Fact>
              <Fact label="Earners">
                {household.members.filter((member) => member.income > 0).length} of{" "}
                {household.size}
              </Fact>
              <Fact label="Personal incomes">
                {usd(household.members.reduce((total, member) => total + member.income, 0))}
              </Fact>
            </Facts>

            <DetailHeading>
              Residents
              <small className="text-muted-foreground tabular-nums">{household.size}</small>
            </DetailHeading>
            <Members>
              {household.members.map((member) => (
                <Member key={member.index}>
                  <div><PersonLink names={names} person={member.index} /></div>
                  {/* Work only for the people who can have any: an eight-year-old
                      marked "not in labour force" is noise in a household of four. */}
                  <PersonFacts
                    age={member.age}
                    sex={member.sex}
                    relationship={member.relationship}
                    race={RACE_LABEL[member.race] ?? member.race}
                    education={member.education}
                    work={member.age >= 16 ? member.occupation ?? member.employment : null}
                    income={member.income ? usd(member.income) : null}
                  />
                </Member>
              ))}
            </Members>

            <DetailHeading>Source</DetailHeading>
            <Facts>
              <Fact label="PUMS"><CopyChip value={household.source} /></Fact>
              <Fact label="OSM"><CopyChip value={household.building.id} /></Fact>
            </Facts>
          </Drawer>
        ) : null}
      </div>
    </main>
  );
}

function filter(
  population: Population,
  options: Filters,
  sort: { id: SortKey; dir: 1 | -1 },
): Int32Array {
  const a = population.a;
  const count = a.household_size.length;
  const needle = options.query.trim().toLowerCase();
  const min = options.minIncome.trim() ? Number(options.minIncome.replace(/[^\d.-]/g, "")) : null;
  const max = options.maxIncome.trim() ? Number(options.maxIncome.replace(/[^\d.-]/g, "")) : null;
  const wanted = options.size === "any" ? null : Number.parseInt(options.size, 10);
  const openEnded = options.size.endsWith("+");

  const matches = new Int32Array(count);
  let found = 0;
  for (let h = 0; h < count; h += 1) {
    const size = a.household_size[h];
    if (wanted !== null && (openEnded ? size < wanted : size !== wanted)) continue;
    const income = a.household_income[h];
    if (min !== null && Number.isFinite(min) && income < min) continue;
    if (max !== null && Number.isFinite(max) && income > max) continue;
    if (needle) {
      const building = a.household_building[h];
      const address = population.strings.address[a.building_address[building]];
      const id = population.strings.id[a.building_id[building]];
      if (!address.toLowerCase().includes(needle) && !id.toLowerCase().includes(needle)) continue;
    }
    matches[found++] = h;
  }

  const result = matches.subarray(0, found);
  const addressOf = (h: number) =>
    population.strings.address[a.building_address[a.household_building[h]]];
  const by: Record<SortKey, (x: number, y: number) => number> = {
    income: (x, y) => a.household_income[x] - a.household_income[y],
    size: (x, y) => a.household_size[x] - a.household_size[y],
    area: (x, y) => a.household_area[x] - a.household_area[y],
    address: (x, y) => addressOf(x).localeCompare(addressOf(y)),
  };
  const compare = by[sort.id];
  // Int32Array.sort takes a comparator, and sorting indices never touches the
  // records themselves.
  result.sort(sort.dir === 1 ? compare : (x, y) => compare(y, x));
  return result;
}

"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DataBrowser } from "@/components/browse/DataBrowser";
import { type BrowseColumn } from "@/components/browse/BrowseTable";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { PersonLink } from "@/components/PersonLink";
import { GROUP_COLOR } from "@/components/social/EgoGraph";
import { SocialCircle } from "@/components/social/SocialCircle";
import { useTies } from "@/components/useTies";
import { num } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Population } from "@/lib/population";
import { GROUP_LABEL, type TieGraph } from "@/lib/ties";
import { DetailLead, Drawer, Fact, Facts } from "@/components/browse/detail";
import { AddressChip } from "@/components/console/Chip";

/**
 * The social graph, browsed one person at a time.
 *
 * ties.py prints a report about the whole city — degree distribution, tiers,
 * mean affinity per provenance — and that report is how you tell whether the
 * generator is calibrated. It is not how you tell whether it is *right*. That
 * question is always about one person: does this barman's circle look like a
 * barman's circle, does the shift worker know his neighbours, is the woman
 * with four hundred acquaintances close to any of them. So the unit here is
 * the ego network, and the table on the left exists to find interesting ones —
 * the isolated, the hubs, the people with ties and no friends.
 *
 * Every alter is a link to their own ego network, which makes the page a way
 * to walk the city by who knows whom rather than by resident id. That walk is
 * the fastest check there is on the closure pass: two people who are friends
 * should have friends in common, and three clicks will tell you whether they
 * do.
 */

type Sort = "ties-desc" | "ties-asc" | "friends-desc" | "age-desc";

interface Filters {
  query: string;
  minTies: string;
  sort: Sort;
  isolated: boolean;
}

/** A dot of the provenance colour, inline with the text it qualifies. */
const TIE_SOURCE = "inline-flex items-center gap-[0.35rem] "
  + "[&>i]:size-[0.5rem] [&>i]:flex-none [&>i]:rounded-full";

export function SocialBrowser() {
  const { population, identity, ties, error } = useTies();
  const params = useSearchParams();
  const router = useRouter();

  const [filters, setFilters] = useState<Filters>({
    query: "", minTies: "", sort: "ties-desc", isolated: false,
  });

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const requested = Number(params.get("person"));
  const selected = params.get("person") !== null
    && Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : null;

  const open = (next: number | null) => {
    router.replace(next === null ? "/social" : `/social?person=${next}`,
      { scroll: false });
  };

  const indices = useMemo(
    () => (ties && population && identity
      ? filterPeople(ties, population, identity, filters)
      : new Int32Array()),
    [ties, population, identity, filters],
  );

  const list = useMemo(
    () => (ties && selected !== null ? ties.tiesOf(selected) : []),
    [ties, selected],
  );
  const stats = useMemo(
    () => (ties && selected !== null ? ties.statsOf(selected, list) : null),
    [ties, selected, list],
  );

  const ready = Boolean(ties && population && identity);

  const filterValues: Record<string, string | boolean> = {
    query: filters.query,
    minTies: filters.minTies,
    sort: filters.sort,
    isolated: filters.isolated,
  };

  const filterFields: FilterField[] = [
    {
      type: "search",
      key: "query",
      label: "Search",
      placeholder: "name or resident id",
      grow: true,
    },
    {
      type: "text",
      key: "minTies",
      label: "Min ties",
      width: "5rem",
      inputMode: "numeric",
    },
    {
      type: "select",
      key: "sort",
      label: "Sort",
      options: [
        { value: "ties-desc", label: "Most ties" },
        { value: "ties-asc", label: "Fewest ties" },
        { value: "friends-desc", label: "Most friends" },
        { value: "age-desc", label: "Oldest" },
      ],
    },
    {
      type: "checkbox",
      key: "isolated",
      label: "No ties",
    },
  ];

  const onFilterChange = (key: string, value: string | boolean) => {
    if (key === "query") set("query", String(value));
    else if (key === "minTies") set("minTies", String(value));
    else if (key === "sort") set("sort", value as Sort);
    else if (key === "isolated") set("isolated", Boolean(value));
  };


  const columns: BrowseColumn[] = ready
    ? [
        {
          id: "person",
          header: "Person",
          width: "14rem",
          cell: (index) => <PersonLink names={identity} person={index} />,
        },
        {
          id: "age",
          header: "Age",
          width: "4rem",
          align: "right",
          cell: (index) => population!.resident(index).age,
        },
        {
          id: "ties",
          header: "Ties",
          width: "5rem",
          align: "right",
          cell: (index) => <span className="tabular-nums">{num(ties!.degreeOf(index))}</span>,
        },
        {
          id: "friends",
          header: "Friends",
          width: "5.5rem",
          align: "right",
          cell: (index) => <span className="tabular-nums">{num(ties!.closeDegrees[index])}</span>,
        },
        {
          id: "provenance",
          header: "Top group",
          cell: (index) => <Provenance ties={ties!} person={index} />,
        },
      ]
    : [];

  return (
    <DataBrowser
      layout="social"
      title="Social graph"
      lead={
        ready
          ? `${num(ties!.edges)} ties`
          : error
            ? <StatusText state="error">{error}</StatusText>
            : "Loading…"
      }
      filters={filterFields}
      filterValues={filterValues}
      onFilterChange={onFilterChange}
      table={ready ? {
        indices,
        columns,
        selected,
        onSelect: open,
        empty: { title: "No matches" },
      } : null}
      loading={
        error ? (
          <EmptyState title="No social graph">
            <code>python kierston/init/init_sim.py --only ties</code>
          </EmptyState>
        ) : <EmptyState title="Loading…" />
      }
      detail={
        ready && selected !== null && stats ? (
          <Drawer onClose={() => open(null)}>
            <DetailLead sub={`Resident ${selected}`}>
              <PersonLink names={identity} person={selected} />
            </DetailLead>
            <Facts cols={3} className="mb-5">
              <Fact label="Age">{population!.resident(selected).age}</Fact>
              <Fact label="Sex">{population!.resident(selected).sex}</Fact>
              <Fact label="Home">
                <AddressChip
                  address={population!.building(population!.residentBuilding(selected)).address}
                  lat={population!.building(population!.residentBuilding(selected)).lat}
                  lon={population!.building(population!.residentBuilding(selected)).lon}
                />
              </Fact>
            </Facts>

            <SocialCircle
              key={selected}
              ties={ties!}
              identity={identity!}
              population={population!}
              person={selected}
              onOpen={open}
            />
          </Drawer>
        ) : null
      }
    />
  );
}

/**
 * Which of the six groups supplies most of somebody's circle.
 *
 * The one column in the table that says what a person's social life is *like*
 * rather than how big it is, and the reason the sort by fewest ties is worth
 * running: the people at that end are nearly all "neighbours" and nothing
 * else, which is what a resident with no job and no school looks like.
 */
function Provenance({ ties, person }: { ties: TieGraph; person: number }) {
  const top = ties.topGroup(person);
  if (!top) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={TIE_SOURCE}>
      <i style={{ background: GROUP_COLOR[top.group] }} />
      {GROUP_LABEL[top.group]}
      <span className="text-muted-foreground tabular-nums"> · {top.count}</span>
    </span>
  );
}

function filterPeople(
  ties: TieGraph,
  population: Population,
  identity: Identity,
  filters: Filters,
): Int32Array {
  const count = ties.persons;
  const degrees = ties.degrees;
  const friends = ties.closeDegrees;
  const needle = filters.query.trim().toLowerCase();
  const asId = Number(needle);
  const byId = Number.isInteger(asId) && String(asId) === needle ? asId : null;
  const minTies = filters.minTies.trim() ? Number(filters.minTies) : null;
  const names = needle && byId === null ? identity.searchNames : null;

  const matches = new Int32Array(count);
  let found = 0;
  for (let p = 0; p < count; p += 1) {
    if (filters.isolated && degrees[p] !== 0) continue;
    if (minTies !== null && Number.isFinite(minTies) && degrees[p] < minTies) continue;
    if (byId !== null && p !== byId) continue;
    if (names && !names[p]?.includes(needle)) continue;
    matches[found++] = p;
  }

  const result = matches.subarray(0, found);
  const comparators: Record<Sort, (x: number, y: number) => number> = {
    "ties-desc": (x, y) => degrees[y] - degrees[x],
    "ties-asc": (x, y) => degrees[x] - degrees[y],
    "friends-desc": (x, y) => friends[y] - friends[x],
    "age-desc": (x, y) => population.resident(y).age - population.resident(x).age,
  };
  result.sort(comparators[filters.sort]);
  return result;
}

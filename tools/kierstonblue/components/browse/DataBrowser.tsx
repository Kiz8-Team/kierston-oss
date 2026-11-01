"use client";

import { BrowseTable, type BrowseTableProps } from "@/components/browse/BrowseTable";
import { DRAWER_GRID, DRAWER_GRID_WIDE } from "@/components/browse/detail";
import { EmptyState } from "@/components/browse/EmptyState";
import { FilterBar, type FilterField } from "@/components/browse/FilterBar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Panel } from "@/components/console/Panel";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DataBrowserTab = {
  id: string;
  label: string;
  count?: number;
};

export type DataBrowserProps = {
  /** A node rather than a string: a detail page puts its way back in here. */
  title: React.ReactNode;
  lead?: React.ReactNode;
  note?: React.ReactNode;
  tabs?: DataBrowserTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  filters?: FilterField[];
  filterValues?: Record<string, string | boolean>;
  onFilterChange?: (key: string, value: string | boolean) => void;
  /** What is being counted — "people", "records". */
  table?: BrowseTableProps | null;
  /** A `Drawer`. */
  detail?: React.ReactNode;
  loading?: React.ReactNode;
  layout?: "default" | "social";
  /** Extra content between note and filters (rare). */
  beforeFilters?: React.ReactNode;
};

export function DataBrowser({
  title,
  tabs,
  activeTab,
  onTabChange,
  filters,
  filterValues,
  onFilterChange,
  table,
  detail,
  loading,
  layout = "default",
  beforeFilters,
}: DataBrowserProps) {
  const hasDetail = detail != null;

  return (
    <main id="content" className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden p-3">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pt-1">
          <h1 className="text-[1.35rem] font-semibold tracking-tight">{title}</h1>
        </header>

        <div className="grid gap-2">
          {tabs && tabs.length > 1 && activeTab && onTabChange ? (
            <Tabs value={activeTab} onValueChange={onTabChange} className="gap-0">
              <TabsList
                variant="line"
                className="h-8 w-full justify-start gap-5 overflow-x-auto px-1 py-0"
              >
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="group shrink-0"
                  >
                    {tab.label}
                    {tab.count !== undefined ? (
                      <small
                        className={cn(
                          "ml-1.5 text-[0.72rem] font-normal tabular-nums",
                          "text-muted-foreground",
                        )}
                      >
                        {num(tab.count)}
                      </small>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}

          {beforeFilters}

          {filters && filterValues && onFilterChange ? (
            <FilterBar
              fields={filters}
              values={filterValues}
              onChange={onFilterChange}
            />
          ) : null}
        </div>

        <div
          className={cn(
            "grid min-h-0 gap-3",
            hasDetail
              ? layout === "social" ? DRAWER_GRID_WIDE : DRAWER_GRID
              : "grid-cols-1",
          )}
        >
          {table ? (
            <Panel flush><BrowseTable {...table} /></Panel>
          ) : (
            <Panel flush>{loading ?? <EmptyState>Loading…</EmptyState>}</Panel>
          )}
          {detail}
        </div>
    </main>
  );
}

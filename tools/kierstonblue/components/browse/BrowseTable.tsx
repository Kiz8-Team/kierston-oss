"use client";

import { ConsoleTable, type ConsoleColumn } from "@/components/console/ConsoleTable";
import { ConsoleButton, Placeholder } from "@/components/console/Record";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Compatibility surface for dataset browsers. The implementation is the same
 * console table used by /households; callers can migrate independently without
 * leaving half the application on the old virtual-table furniture.
 */
export type BrowseColumn = ConsoleColumn;

export type BrowseTableProps = {
  indices: Int32Array;
  columns: BrowseColumn[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  sort?: { id: string; dir: 1 | -1 } | null;
  onSort?: (id: string) => void;
  empty: { title: string; body?: React.ReactNode; onClear?: () => void };
  height?: string;
};

export function BrowseTable({
  indices, columns, selected, onSelect, sort, onSort, empty,
}: BrowseTableProps) {
  return (
    <ConsoleTable
      indices={indices}
      columns={columns}
      selected={selected}
      onSelect={onSelect}
      sort={sort}
      onSort={onSort}
      empty={
        <Placeholder
          title={empty.title}
          action={empty.onClear ? (
            <ConsoleButton className="mt-1" onClick={empty.onClear}>Clear filters</ConsoleButton>
          ) : undefined}
        >
          {empty.body}
        </Placeholder>
      }
    />
  );
}

export { DetailActions } from "@/components/browse/detail";

/** A control under a drawer section: the console's button, with the drawer's hairline. */
export function OutlineButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn("h-7 border-border px-2.5 text-[0.8rem] hover:bg-accent hover:text-foreground", className)}
      {...props}
    />
  );
}

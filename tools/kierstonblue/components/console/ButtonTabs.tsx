"use client";

import { cn } from "@/lib/utils";

/**
 * Tabs drawn as a row of joined buttons: the chosen one solid, the rest
 * outlined. For a panel that shows one list of several, where an underline
 * strip read as page furniture rather than something to press.
 */
export function ButtonTabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="flex shrink-0" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={cn(
              "-ml-px flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 border px-3",
              "text-[0.8rem] font-medium transition-colors first:ml-0",
              on
                ? "z-10 border-foreground bg-foreground text-background"
                : "border-border bg-background text-foreground hover:bg-accent",
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className={cn("text-[0.72rem] tabular-nums", on ? "opacity-70" : "text-muted-foreground")}>
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

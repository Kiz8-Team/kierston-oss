"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { useScope } from "@/components/Scope";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The header's two cells: which city build, and which day of it.
 *
 * The build list is every folder the server knows to be one — the default
 * sim_data, any build under kierston/, and any added here by path. Typing a
 * path that is not in the list and pressing Enter adds it, so the search box
 * doubles as the place a build outside the repository is opened from.
 */
export function CityPicker() {
  const { cities, city, selectCity } = useScope();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(dir: string) {
    setBusy(true);
    setError(null);
    const failure = await selectCity(dir);
    setBusy(false);
    if (failure) setError(failure);
  }

  const looksLikePath = /^[~/]/.test(query.trim());

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setQuery(""); setError(null); } }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hud-cell max-w-[16rem] cursor-pointer bg-transparent text-inherit normal-case hover:text-foreground"
          aria-label="City build"
        >
          <span className="micro text-[0.64rem]">City</span>
          <span className="truncate text-[0.78rem] tracking-normal text-foreground">{city?.label ?? "…"}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[16rem] p-0">
        <Command>
          <CommandInput
            placeholder="Build or path"
            value={query}
            onValueChange={(value) => { setQuery(value); setError(null); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && looksLikePath) {
                event.preventDefault();
                void choose(query.trim());
              }
            }}
          />
          <CommandList>
            <CommandEmpty>{looksLikePath ? (busy ? "Opening…" : error ?? "Enter · open path") : "No builds"}</CommandEmpty>
            <CommandGroup>
              {cities?.map((item) => (
                <CommandItem
                  key={item.dir}
                  value={`${item.label} ${item.dir}`}
                  onSelect={() => { if (item.dir !== city?.dir) void choose(item.dir); else setOpen(false); }}
                  title={item.dir}
                  className="h-7 gap-2 py-0"
                >
                  <Check className={cn("size-3.5 shrink-0", item.dir === city?.dir ? "opacity-100" : "opacity-0")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="shrink-0 text-[0.72rem] text-muted-foreground tabular-nums">
                    {item.seed ?? item.populationSeed ?? ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {error && !looksLikePath ? (
            <div className="border-t border-border px-3 py-2 text-[0.78rem] text-destructive">{error}</div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function DayPicker() {
  const { days, day, setDay } = useScope();
  return (
    <label className="hud-cell normal-case">
      <span className="micro text-[0.64rem]">Day</span>
      <select
        className="h-6 cursor-pointer border-0 bg-transparent pr-1 text-[0.78rem] tracking-normal text-foreground tabular-nums outline-none focus-visible:outline-1 focus-visible:outline-primary disabled:cursor-default disabled:text-muted-foreground"
        value={day}
        onChange={(event) => setDay(event.target.value)}
        disabled={!days?.length}
        aria-label="Day"
      >
        {days === null ? <option value="">…</option> : null}
        {days?.length === 0 ? <option value="">None</option> : null}
        {days?.map((item) => <option key={item.date} value={item.date}>{item.date}</option>)}
      </select>
    </label>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDay } from "@/components/Scope";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { personName } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { VehicleHit } from "@/lib/server/vehicles";
import { SERVICE_LABEL, vehicleHref } from "@/lib/vehicle-day";

/**
 * The way in from the rail, when the reader has no VIN in hand.
 *
 * Everywhere else a vehicle's day is reached from the vehicle itself — a
 * registration, a camera read, a leg of somebody's day. This is the one place
 * that has to answer "which car", so it is a search and a list of what it
 * found, and nothing else.
 */
export function VehicleFinder() {
  const params = useSearchParams();
  const names = useNames();
  const { day: date, error: dayError } = useDay();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [hits, setHits] = useState<VehicleHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Typing is throttled rather than fired per keystroke: the search runs over
  // the whole register, and a VIN is seventeen characters long.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/vehicles/search?date=${encodeURIComponent(date)}&q=${encodeURIComponent(query)}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
          if (!cancelled) { setHits(payload.vehicles as VehicleHit[]); setError(null); }
        })
        .catch((reason) => {
          if (cancelled) return;
          setHits([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [date, query]);

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[64rem] p-6 pb-16">
        <header>
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
            Vehicle movement
          </h1>
        </header>

        <div className="mt-6 flex flex-wrap items-end gap-3">
          <label className="grid min-w-[22rem] flex-1 gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">
              VIN, driver, owner or household
            </span>
            <Input
              value={query}
              placeholder="VIN or resident id"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ?? dayError ? <div className="mt-6"><StatusText state="error">{error ?? dayError}</StatusText></div> : null}

        {hits === null && !error && !dayError ? (
          <EmptyState>Loading…</EmptyState>
        ) : null}

        {hits?.length === 0 ? (
          <EmptyState title="No matches" />
        ) : null}

        {hits?.length ? (
          <ol className="mt-8 grid list-none gap-0 p-0">
            {hits.map((hit) => (
              <li key={hit.vin} className="border-t border-border">
                <Link
                  className="grid grid-cols-[1fr_auto] items-baseline gap-3 rounded-sm px-1.5 py-1.5 leading-tight no-underline hover:bg-accent"
                  href={vehicleHref(hit.vin, date)}
                >
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-1.5">
                      <strong className="truncate font-sans text-[0.9rem]">{hit.vin}</strong>
                      {hit.serviceClass === "none" ? null : (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[0.7rem]">
                          {SERVICE_LABEL[hit.serviceClass] ?? hit.serviceClass}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-px block truncate text-[0.85rem] text-muted-foreground">
                      {hit.driver === null
                        ? "no driver"
                        : `${personName(names, hit.driver)}${hit.drivers > 1 ? ` +${hit.drivers - 1}` : ""}`}
                      {hit.household === null ? "" : ` · household ${hit.household}`}
                    </span>
                  </span>
                  <span className="text-right text-[0.85rem] text-muted-foreground tabular-nums">
                    {hit.moves ? `${hit.moves} movements` : "parked"}
                    <span className="mt-px block">{hit.moves ? `${hit.kilometres.toFixed(1)} km` : "—"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Users } from "lucide-react";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Block } from "@/components/console/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useDay } from "@/components/Scope";
import { useNames } from "@/components/useNames";
import { clock } from "@/lib/day-timeline";
import { meetingHref, meetingSpan, meetingTitle, nameOf } from "@/lib/meetings";
import { num } from "@/lib/format";
import type { MeetingRow } from "@/lib/server/meetings";

/**
 * Every gathering in a generated day, as a list you choose from.
 *
 * Deliberately only the list. A gathering opens on its own page rather than in
 * a panel beside this one, because what it opens into is not a detail view —
 * it is a dozen tracks, a map of half the city and a clock that plays. That
 * wants the full measure of the window, and it wants a URL somebody can send
 * to somebody else.
 */

interface Filters {
  query: string;
  kind: string;
  purpose: string;
  least: number;
  sort: "start" | "party-desc" | "length-desc";
}

const EMPTY: Filters = { query: "", kind: "any", purpose: "any", least: 2, sort: "start" };

interface Listing {
  date: string;
  total: number;
  matched: number;
  meetings: MeetingRow[];
  kinds: string[];
  purposes: string[];
}

export function MeetingsBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const names = useNames();

  const { day: date, days, error: dayError } = useDay();
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, query: params.get("q") ?? "" });
  const [draft, setDraft] = useState(params.get("q") ?? "");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetched whenever the date or a filter moves, which is cheap: the server
  // holds the whole index for the file and only sorts and slices it.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setListing(null);
    const query = new URLSearchParams({
      q: filters.query, kind: filters.kind, purpose: filters.purpose,
      least: String(filters.least), sort: filters.sort,
    });
    fetch(`/api/meetings/${encodeURIComponent(date)}?${query}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!cancelled) { setListing(payload as Listing); setError(null); }
      })
      .catch((reason) => { if (!cancelled) { setListing(null); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => { cancelled = true; };
  }, [date, filters]);

  useEffect(() => {
    if (!date) return;
    const query = new URLSearchParams({ date });
    if (filters.query) query.set("q", filters.query);
    router.replace(`/meetings?${query}`, { scroll: false });
  }, [date, filters.query, router]);

  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  const counted = useMemo(() => {
    if (!listing) return null;
    const people = new Set(listing.meetings.flatMap((row) => row.party.map((party) => party.person)));
    return { people: people.size };
  }, [listing]);

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[76rem] p-6 pb-16">
        <header className="max-w-[56rem]">
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">Gatherings</h1>
        </header>

        <form
          className="mt-6 flex flex-wrap items-end gap-3"
          onSubmit={(event) => { event.preventDefault(); set({ query: draft.trim() }); }}
        >
          <label className="grid min-w-[14rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Search</span>
            <Input
              placeholder="resident id, venue or purpose"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <label className="grid min-w-[9rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Purpose</span>
            <NativeSelect value={filters.purpose} onChange={(event) => set({ purpose: event.target.value })}>
              <option value="any">Any purpose</option>
              {listing?.purposes.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}
            </NativeSelect>
          </label>
          <label className="grid min-w-[9rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Kind</span>
            <NativeSelect value={filters.kind} onChange={(event) => set({ kind: event.target.value })}>
              <option value="any">Any kind</option>
              {listing?.kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </NativeSelect>
          </label>
          <label className="grid min-w-[9rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Min party</span>
            <NativeSelect value={String(filters.least)} onChange={(event) => set({ least: Number(event.target.value) })}>
              {[2, 3, 4, 5, 6].map((least) => <option key={least} value={least}>{least} people</option>)}
            </NativeSelect>
          </label>
          <label className="grid min-w-[10rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Sort</span>
            <NativeSelect value={filters.sort} onChange={(event) => set({ sort: event.target.value as Filters["sort"] })}>
              <option value="start">Start</option>
              <option value="party-desc">Party size</option>
              <option value="length-desc">Length</option>
            </NativeSelect>
          </label>
          <Button type="submit">Search</Button>
        </form>

        {error ?? dayError ? <div className="mt-4"><StatusText state="error">{error ?? dayError}</StatusText></div> : null}
        {days?.length === 0 ? (
          <EmptyState title="No generated days">
            <code>cd kierston/sim && bun run day --export-day --date YYYY-MM-DD</code>
          </EmptyState>
        ) : null}

        <Block
          className="mt-9"
          title={<span className="flex items-center gap-2"><Users className="size-4" />Gatherings</span>}
          meta={listing
            ? `${listing.matched > listing.meetings.length ? `first ${num(listing.meetings.length)} of ` : ""}`
              + `${num(listing.matched)} of ${num(listing.total)}`
              + `${counted ? ` · ${num(counted.people)} people` : ""}`
            : undefined}
        >
          {listing && listing.meetings.length ? (
              <ol className="grid list-none gap-0 p-0">
                {listing.meetings.map((row) => (
                  <li key={row.index} className="border-t border-border first:border-0">
                    <Link
                      href={meetingHref(date, row.index)}
                      className="grid grid-cols-[3.4rem_1fr_auto] items-baseline gap-3 rounded-sm px-1.5 py-1.5 leading-tight no-underline hover:bg-accent"
                    >
                      <span className="text-[0.85rem] font-semibold tabular-nums">{clock(row.start)}</span>
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-1.5">
                          <strong className="truncate text-[0.88rem]">{meetingTitle(row)}</strong>
                          <Badge variant="secondary" className="px-1.5 py-0 text-[0.7rem]">{row.kind}</Badge>
                        </span>
                        <span className="mt-px block truncate text-[0.78rem] text-muted-foreground">
                          {row.party.map((party) => nameOf(names, party.person)).join(", ")}
                        </span>
                      </span>
                      <span className="text-right text-[0.78rem] text-muted-foreground tabular-nums">
                        {row.party.length} people
                        <span className="mt-px block">{meetingSpan(row).split(" · ")[1]}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
          ) : listing ? (
            <StatusText>No matches</StatusText>
          ) : (
            <StatusText state="busy">Loading…</StatusText>
          )}
        </Block>
      </div>
    </main>
  );
}

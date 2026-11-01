"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Swatch, Track } from "@/components/Charts";
import { Block, Grid } from "@/components/console/Section";
import { DispatchMap } from "@/components/dispatch/DispatchMap";
import { personName } from "@/components/PersonLink";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useDay } from "@/components/Scope";
import { useNames } from "@/components/useNames";
import {
  DISPOSITION_COLOR, PRIORITY_COLOR, SERVICE_COLOR, dispatchClock, incidentHref, kindLabel,
  quantile, responseMinutes,
} from "@/lib/dispatch";
import type { DispatchIndex, IncidentRow } from "@/lib/server/dispatch";
import { cn } from "@/lib/utils";

/**
 * One day's 911 calls: how they break down, where they were, and the list.
 *
 * Deliberately only the overview. A call opens on its own page, because what
 * it opens into — a clock that plays, a map of the units' drives — wants the
 * full measure and a URL that can be sent to somebody.
 */

interface Filters {
  query: string;
  priority: string;
  service: string;
  disposition: string;
  kind: string;
}

const EMPTY: Filters = { query: "", priority: "any", service: "any", disposition: "any", kind: "any" };

function matches(incident: IncidentRow, filters: Filters): boolean {
  if (filters.priority !== "any" && String(incident.priority) !== filters.priority) return false;
  if (filters.disposition !== "any" && incident.disposition !== filters.disposition) return false;
  if (filters.kind !== "any" && incident.kind !== filters.kind) return false;
  if (filters.service !== "any" && incident.requested[filters.service as "police" | "ems"] === 0) return false;
  const query = filters.query.trim().toUpperCase();
  if (!query) return true;
  if (/^\d+$/.test(query)) {
    const person = Number(query);
    return incident.caller === person
      || incident.units.some((unit) => unit.person === person || unit.partner === person);
  }
  return incident.units.some((unit) => unit.vin.includes(query))
    || kindLabel(incident.kind).toUpperCase().includes(query)
    || (incident.placeLabel?.toUpperCase().includes(query) ?? false);
}

interface CountRow {
  label: string;
  value: number;
  color?: string;
  note?: string;
}

/** Label, bar, count and an optional note — sized to be read, not glanced at. */
function Counts({ rows }: { rows: CountRow[] }) {
  const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0) || 1;
  return (
    <div className="grid gap-[0.35rem]">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[minmax(7rem,11rem)_1fr_2.5rem_minmax(0,7rem)] items-center gap-2 text-[0.85rem]">
          <span className="truncate">{row.color ? <Swatch color={row.color} /> : null}{row.label}</span>
          <Track share={row.value / max} color={row.color} />
          <span className="text-right tabular-nums">{row.value}</span>
          <span className="truncate text-muted-foreground tabular-nums">{row.note ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

const minutesNote = (values: number[]) => {
  const median = quantile(values, 0.5);
  return median === null ? "" : `median ${median} min`;
};

export function DispatchBrowser() {
  const router = useRouter();
  const names = useNames();

  const { day: date, days, error: dayError } = useDay();
  const [index, setIndex] = useState<DispatchIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [fitToken, setFitToken] = useState(0);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setIndex(null);
    fetch(`/api/dispatch/${encodeURIComponent(date)}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setIndex(payload as DispatchIndex);
        setError(null);
        setFitToken((token) => token + 1);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [date]);

  useEffect(() => {
    if (date) router.replace(`/dispatch?date=${encodeURIComponent(date)}`, { scroll: false });
  }, [date, router]);

  const visible = useMemo(
    () => index?.incidents.filter((incident) => matches(incident, filters)) ?? [],
    [index, filters],
  );

  const kinds = useMemo(
    () => [...new Set(index?.incidents.map((incident) => incident.kind) ?? [])].sort(),
    [index],
  );

  const summary = useMemo(() => {
    const served = (list: IncidentRow[]) =>
      list.map(responseMinutes).filter((value): value is number => value !== null);
    const priority: CountRow[] = [1, 2, 3].map((level) => {
      const list = visible.filter((incident) => incident.priority === level);
      return { label: `P${level}`, value: list.length, color: PRIORITY_COLOR[level], note: minutesNote(served(list)) };
    });
    const disposition: CountRow[] = ["cleared", "partial", "unserved"].map((state) => ({
      label: state.charAt(0).toUpperCase() + state.slice(1),
      value: visible.filter((incident) => incident.disposition === state).length,
      color: DISPOSITION_COLOR[state],
    }));
    const runs = visible.flatMap((incident) => incident.units);
    const units: CountRow[] = [
      { label: "Police runs", value: runs.filter((unit) => unit.service === "police").length, color: SERVICE_COLOR.police },
      { label: "EMS runs", value: runs.filter((unit) => unit.service === "ems").length, color: SERVICE_COLOR.ems },
      { label: "Hospital transports", value: runs.filter((unit) => unit.hospital).length, color: SERVICE_COLOR.ems },
      { label: "No call record", value: visible.filter((incident) => !incident.call).length },
    ];
    const byKind = new Map<string, IncidentRow[]>();
    for (const incident of visible) byKind.set(incident.kind, [...(byKind.get(incident.kind) ?? []), incident]);
    const kind: CountRow[] = [...byKind.entries()]
      .map(([id, list]) => ({ label: kindLabel(id), value: list.length, note: minutesNote(served(list)) }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const all = served(visible);
    return { priority, disposition, units, kind, median: quantile(all, 0.5), p90: quantile(all, 0.9) };
  }, [visible]);

  const open = useCallback((incident: number) => {
    router.push(incidentHref(date, incident));
  }, [router, date]);

  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <header>
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">911 calls</h1>
        </header>

        <div className="mt-6 flex flex-wrap items-end gap-3">
          <label className="grid min-w-[14rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Search</span>
            <Input
              placeholder="resident id, VIN, kind or place"
              value={filters.query}
              onChange={(event) => set({ query: event.target.value })}
            />
          </label>
          <label className="grid min-w-[8rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Priority</span>
            <NativeSelect value={filters.priority} onChange={(event) => set({ priority: event.target.value })}>
              <option value="any">Any</option>
              {[1, 2, 3].map((priority) => <option key={priority} value={priority}>P{priority}</option>)}
            </NativeSelect>
          </label>
          <label className="grid min-w-[8rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Service</span>
            <NativeSelect value={filters.service} onChange={(event) => set({ service: event.target.value })}>
              <option value="any">Any</option>
              <option value="police">Police</option>
              <option value="ems">EMS</option>
            </NativeSelect>
          </label>
          <label className="grid min-w-[9rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Disposition</span>
            <NativeSelect value={filters.disposition} onChange={(event) => set({ disposition: event.target.value })}>
              <option value="any">Any</option>
              <option value="cleared">Cleared</option>
              <option value="partial">Partial</option>
              <option value="unserved">Unserved</option>
            </NativeSelect>
          </label>
          <label className="grid min-w-[12rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Kind</span>
            <NativeSelect value={filters.kind} onChange={(event) => set({ kind: event.target.value })}>
              <option value="any">Any</option>
              {kinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
            </NativeSelect>
          </label>
        </div>

        {error ?? dayError ? <div className="mt-4"><StatusText state="error">{error ?? dayError}</StatusText></div> : null}
        {days?.length === 0 ? (
          <EmptyState title="No generated days">
            <code>cd kierston/sim &amp;&amp; bun run day --export-day --date YYYY-MM-DD</code>
          </EmptyState>
        ) : null}
        {index && !index.dispatched ? <EmptyState title="No dispatch layer" /> : null}
        {index === null && !error && date ? <div className="mt-6"><StatusText state="busy">Loading…</StatusText></div> : null}

        {index?.dispatched ? (
          <>
            <Grid min="24rem" className="mt-9">
              <Block
                title="Priority"
                meta={`${visible.length} calls${summary.median !== null ? ` · first unit median ${summary.median} min, p90 ${summary.p90} min` : ""}`}
              >
                <Counts rows={summary.priority} />
              </Block>
              <Block title="Disposition">
                <Counts rows={summary.disposition} />
              </Block>
              <Block title="Units">
                <Counts rows={summary.units} />
              </Block>
            </Grid>

            <div className="mt-9 grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-x-10 gap-y-9 max-[76rem]:grid-cols-1">
              <Block title="Map">
                <DispatchMap incidents={visible} fitToken={fitToken} onSelect={open} />
              </Block>

              <Block title="Kind" meta={`${summary.kind.length}`}>
                <div className="max-h-[32rem] overflow-auto">
                  <Counts rows={summary.kind} />
                </div>
              </Block>
            </div>

            <Block className="mt-9" title="Calls" meta={`${visible.length} of ${index.incidents.length}`}>
              <ol className="grid list-none gap-0 p-0">
                {visible.map((incident) => {
                  const minutes = responseMinutes(incident);
                  const police = incident.units.filter((unit) => unit.service === "police").length;
                  const ems = incident.units.length - police;
                  return (
                    <li key={incident.index} className="border-t border-border first:border-0">
                      <Link
                        href={incidentHref(index.date, incident.index)}
                        className="grid grid-cols-[4.6rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_6rem] items-baseline gap-3 rounded-sm px-1.5 py-1.5 leading-tight no-underline hover:bg-accent max-[60rem]:grid-cols-[4.6rem_minmax(0,1fr)_6rem]"
                      >
                        <span className="text-[0.85rem] font-semibold tabular-nums">{dispatchClock(incident.received)}</span>
                        <span className="min-w-0 truncate text-[0.88rem]">
                          <Swatch color={PRIORITY_COLOR[incident.priority]} />
                          <strong>{kindLabel(incident.kind)}</strong>
                          <span className="text-muted-foreground"> · P{incident.priority} · {incident.placeLabel ?? incident.placeClass}</span>
                        </span>
                        <span className="min-w-0 truncate text-[0.85rem] text-muted-foreground max-[60rem]:hidden">
                          {personName(names, incident.caller)}
                        </span>
                        <span className="min-w-0 truncate text-[0.85rem] text-muted-foreground max-[60rem]:hidden">
                          {[police ? `${police} police` : "", ems ? `${ems} EMS` : ""].filter(Boolean).join(" · ") || "no units"}
                        </span>
                        <span className={cn(
                          "text-right text-[0.85rem] tabular-nums",
                          incident.disposition === "cleared" ? "text-muted-foreground" : "text-destructive",
                        )}>
                          {minutes === null ? "unserved" : `${minutes} min`}
                          {incident.disposition === "partial" ? " · partial" : ""}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
              {!visible.length ? <StatusText>No matches</StatusText> : null}
            </Block>
          </>
        ) : null}
      </div>
    </main>
  );
}

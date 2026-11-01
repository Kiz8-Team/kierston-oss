"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Pause, Play, Shuffle } from "lucide-react";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Swatch } from "@/components/Charts";
import { Block } from "@/components/console/Section";
import {
  CellularMap, ESTIMATE_COLOR, SECONDARY_COLOR, SERVING_COLOR, TRUTH_COLOR, type RecordOverlay,
} from "@/components/cellular/CellularMap";
import { ErrorChart } from "@/components/cellular/ErrorChart";
import { PersonLink } from "@/components/PersonLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNames } from "@/components/useNames";
import {
  KIND_COLOR, STAT_LABEL, TA_UNIT_M, clockSeconds, metres,
  type CellularEstimate, type ErrorStats, type PosteriorCells, type SampleResult, type SiteCell,
} from "@/lib/cellular";
import { useDay } from "@/components/Scope";
import { cn } from "@/lib/utils";

/**
 * How well a handset can be located from carrier records alone.
 *
 * The truth is the resident's own day; the estimate uses only the rows an
 * agent under evaluation can query and the public cell-site table. The
 * accuracy table is the answer to "how coarse is this evidence", per kind of
 * row and for the fused track; the chart, map and record list are how to see
 * why for one person; the sample repeats the table over many.
 */

const RATE = 30;

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function StatsTable({ stats }: { stats: ErrorStats[] }) {
  return (
    <Table className="text-[0.85rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Rows</TableHead>
          <TableHead className="text-right">Median error</TableHead>
          <TableHead className="text-right">P90 error</TableHead>
          <TableHead className="text-right">Median 95% radius</TableHead>
          <TableHead className="text-right">Truth inside 95%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.map((row) => (
          <TableRow key={row.key} className={cn(row.key.startsWith("fused") && "font-semibold")}>
            <TableCell>
              <Swatch color={KIND_COLOR[row.key] ?? (row.key.startsWith("fused") ? ESTIMATE_COLOR : SERVING_COLOR)} />
              {STAT_LABEL[row.key] ?? row.key}
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.count}</TableCell>
            <TableCell className="text-right tabular-nums">{metres(row.median)}</TableCell>
            <TableCell className="text-right tabular-nums">{metres(row.p90)}</TableCell>
            <TableCell className="text-right tabular-nums">{metres(row.r95)}</TableCell>
            <TableCell className="text-right tabular-nums">{percent(row.coverage)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const cellName = (cell: SiteCell | undefined, cgi: string | null) =>
  cell ? `${cell.band} ${cell.role} · s${cell.sector + 1}` : (cgi ?? "—");

export function CellularWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const names = useNames();

  const initial = Number(params.get("person"));
  const { day: date, error: daysError } = useDay();
  const [person, setPerson] = useState<number | null>(Number.isSafeInteger(initial) && params.get("person") ? initial : null);
  const [draft, setDraft] = useState(params.get("person") ?? "");
  const [estimate, setEstimate] = useState<CellularEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [handset, setHandset] = useState(0);
  const [cursor, setCursor] = useState(720);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<"track" | "record">("track");
  const [heat, setHeat] = useState<PosteriorCells | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [sampleSize, setSampleSize] = useState(10);
  const [sample, setSample] = useState<SampleResult | null>(null);
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  useEffect(() => {
    if (!date || person === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setSelected(null);
    setMode("track");
    setHeat(null);
    router.replace(`/cell-location?date=${encodeURIComponent(date)}&person=${person}`, { scroll: false });
    fetch(`/api/cellular/${encodeURIComponent(date)}/${person}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        const loaded = payload as CellularEstimate;
        setEstimate(loaded);
        const busiest = loaded.handsets.reduce((best, one, at) =>
          one.observations.length > (loaded.handsets[best]?.observations.length ?? -1) ? at : best, 0);
        setHandset(busiest);
        setFitToken((token) => token + 1);
      })
      .catch((reason) => { if (!cancelled) { setEstimate(null); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, person, router]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const advanced = ((now - last) / 1000) * RATE;
      last = now;
      let done = false;
      setCursor((current) => { const next = Math.min(1439, current + advanced); done = next >= 1439; return next; });
      if (done) { setPlaying(false); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const current = estimate?.handsets[handset] ?? null;

  const point = useMemo(() => {
    if (!current?.track.length) return null;
    let best = current.track[0]!;
    for (const one of current.track) if (Math.abs(one.minute - cursor) < Math.abs(best.minute - cursor)) best = one;
    return best;
  }, [current, cursor]);

  const record = useMemo(
    () => current?.observations.find((one) => one.id === selected) ?? null,
    [current, selected],
  );

  const heatKey = !current ? null
    : mode === "record" && record ? `record=${record.id}`
      : point ? `minute=${point.minute}` : null;

  useEffect(() => {
    if (!heatKey || !estimate) { setHeat(null); return; }
    const controller = new AbortController();
    fetch(`/api/cellular/${encodeURIComponent(estimate.date)}/${estimate.person}/posterior?handset=${handset}&${heatKey}`, { signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload) => setHeat(payload as PosteriorCells | null))
      .catch(() => { /* superseded */ });
    return () => controller.abort();
  }, [heatKey, estimate, handset]);

  const overlay = useMemo<RecordOverlay | null>(() => {
    if (!record || !estimate) return null;
    const cell = (cgi: string | null) => (cgi ? estimate.cells[cgi] ?? null : null);
    return { serving: cell(record.cell), ta: record.ta, secondary: cell(record.secondary), previous: cell(record.previous) };
  }, [record, estimate]);

  const choose = useCallback((id: number) => {
    const found = current?.observations.find((one) => one.id === id);
    setPlaying(false);
    setSelected(id);
    setMode("record");
    if (found) setCursor(found.second / 60);
  }, [current]);

  const scrub = useCallback((minute: number) => {
    setPlaying(false);
    setCursor(minute);
    setMode("track");
  }, []);

  const random = async () => {
    if (!date) return;
    const response = await fetch(`/api/cellular/${encodeURIComponent(date)}/random`);
    const payload = await response.json();
    if (response.ok) { setPerson(payload.person); setDraft(String(payload.person)); }
    else setError(payload.error ?? `HTTP ${response.status}`);
  };

  const runSample = () => {
    if (!date) return;
    setSampling(true);
    setSampleError(null);
    fetch(`/api/cellular/${encodeURIComponent(date)}/sample?n=${sampleSize}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setSample(payload as SampleResult);
      })
      .catch((reason) => setSampleError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSampling(false));
  };

  const mapEstimate = mode === "record" && record?.single ? record.single : point;
  const mapTruth = mode === "record" && record ? record.truth : point?.truth ?? null;

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <header>
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">Cell location estimator</h1>
        </header>

        <form
          className="mt-6 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const next = Number(draft);
            if (Number.isSafeInteger(next) && next >= 0) setPerson(next);
          }}
        >
          <label className="grid min-w-[10rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Resident id</span>
            <Input inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <Button type="submit">Estimate</Button>
          <Button type="button" variant="outline" onClick={random} disabled={!date}>
            <Shuffle className="size-3.5" />Random
          </Button>
          {estimate && estimate.handsets.length > 1 ? (
            <label className="grid min-w-[14rem] gap-1.5">
              <span className="text-[0.8rem] font-medium text-muted-foreground">Handset</span>
              <NativeSelect value={String(handset)} onChange={(event) => { setHandset(Number(event.target.value)); setSelected(null); setMode("track"); }}>
                {estimate.handsets.map((one, at) => (
                  <option key={one.subscriber} value={at}>
                    {one.carrier ?? one.operator} · {one.msisdn ?? one.imsi} · {one.observations.length} rows
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
        </form>

        {error ?? daysError ? <div className="mt-4"><StatusText state="error">{error ?? daysError}</StatusText></div> : null}
        {loading ? <div className="mt-4"><StatusText state="busy">Estimating…</StatusText></div> : null}
        {estimate && !estimate.handsets.length ? <EmptyState title="No handset" /> : null}

        {estimate && current ? (
          <>
            <p className="mt-6 mb-0 text-[0.85rem] text-muted-foreground tabular-nums">
              <PersonLink names={names} person={estimate.person} /> · {estimate.date} · {current.carrier ?? current.operator}
              {" "}· {current.observations.length} rows · grid {estimate.grid.step} m
              {estimate.legs.length ? "" : " · no truth"}
            </p>

            <Block className="mt-6" title="Accuracy">
              <StatsTable stats={current.stats} />
            </Block>

            <div className="mt-8 flex flex-wrap items-center gap-x-[0.85rem] gap-y-2">
              <Button
                type="button" size="sm" variant="outline" className="w-[5.4rem]"
                onClick={() => { if (!playing && cursor >= 1439) setCursor(0); setMode("track"); setPlaying(!playing); }}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {playing ? "Pause" : "Play"}
              </Button>
              <strong className="min-w-[4.2rem] text-[1.4rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
                {clockSeconds(Math.round(cursor) * 60).slice(0, 5)}
              </strong>
              {point ? (
                <span className="text-[0.85rem] text-muted-foreground tabular-nums">
                  {mode === "record" && record
                    ? `${record.kind} · ${clockSeconds(record.second)} · error ${metres(record.single?.error ?? null)} · 95% ${metres(record.single?.r95 ?? null)}`
                    : `whole-day estimate · error ${metres(point.error)} · 50% ${metres(point.r50)} · 95% ${metres(point.r95)}${point.covered === false ? " · truth outside 95%" : ""}`}
                </span>
              ) : null}
              <span className="ml-auto flex flex-wrap gap-x-[0.85rem] text-[0.85rem] text-muted-foreground">
                <span><Swatch color={TRUTH_COLOR} />Truth</span>
                <span><Swatch color={ESTIMATE_COLOR} />Estimate</span>
                <span><Swatch color={SERVING_COLOR} />Serving</span>
                <span><Swatch color={SECONDARY_COLOR} />Secondary</span>
              </span>
            </div>

            <Block className="mt-4" title="Error">
              <ErrorChart
                track={current.track}
                observations={current.observations}
                minute={cursor}
                selected={selected}
                onScrub={scrub}
                onSelect={choose}
              />
            </Block>

            <div className="mt-9 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-x-10 gap-y-9 max-[80rem]:grid-cols-1">
              <Block
                title="Map"
                meta={mode === "record" && record ? "Single record" : "Whole day"}
              >
                <div className="mb-3 flex gap-2">
                  <Button type="button" size="sm" variant={mode === "track" ? "default" : "outline"} onClick={() => setMode("track")}>
                    Whole-day estimate
                  </Button>
                  <Button type="button" size="sm" variant={mode === "record" ? "default" : "outline"} disabled={!record} onClick={() => setMode("record")}>
                    Single record
                  </Button>
                </div>
                <CellularMap
                  legs={estimate.legs}
                  grid={estimate.grid}
                  truth={mapTruth}
                  estimate={mapEstimate}
                  heat={heat}
                  overlay={overlay}
                  fitToken={fitToken}
                />
              </Block>

              <Block title="Records" meta={`${current.observations.length}`}>
                <div className="max-h-[40rem] overflow-auto">
                  <Table className="text-[0.85rem]">
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Row</TableHead>
                        <TableHead>Cell</TableHead>
                        <TableHead className="text-right">TA</TableHead>
                        <TableHead>Secondary</TableHead>
                        <TableHead className="text-right">Error</TableHead>
                        <TableHead className="text-right">95%</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {current.observations.map((one) => (
                        <TableRow
                          key={one.id}
                          className={cn("cursor-pointer", selected === one.id && "bg-accent")}
                          onClick={() => choose(one.id)}
                        >
                          <TableCell className="tabular-nums">{clockSeconds(one.second)}</TableCell>
                          <TableCell><Swatch color={KIND_COLOR[one.kind]} />{one.kind}</TableCell>
                          <TableCell className="max-w-[10rem] truncate" title={one.cell ?? undefined}>
                            {one.cell ? cellName(estimate.cells[one.cell], one.cell) : one.trackingArea !== null ? `TAC ${one.trackingArea}` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" title={one.ta !== null ? `${Math.round(one.ta * TA_UNIT_M)}–${Math.round((one.ta + 1) * TA_UNIT_M)} m slant` : undefined}>
                            {one.ta ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[9rem] truncate">
                            {one.secondary ? cellName(estimate.cells[one.secondary], one.secondary) : "—"}
                          </TableCell>
                          <TableCell className={cn("text-right tabular-nums", one.single?.covered === false && "text-destructive")}>
                            {metres(one.single?.error ?? null)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{metres(one.single?.r95 ?? null)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Block>
            </div>
          </>
        ) : null}

        <Block
          className="mt-9"
          title="City sample"
          meta={sample ? `${sample.date} · ${sample.people} residents · ${sample.handsets} handsets · ${sample.records} rows · grid 150 m` : undefined}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <NativeSelect className="w-[9rem]" value={String(sampleSize)} onChange={(event) => setSampleSize(Number(event.target.value))} aria-label="Sample size">
              {[5, 10, 20, 40].map((n) => <option key={n} value={n}>{n} residents</option>)}
            </NativeSelect>
            <Button type="button" variant="outline" onClick={runSample} disabled={sampling || !date}>
              {sampling ? "Running…" : "Run sample"}
            </Button>
            {sampleError ? <StatusText state="error">{sampleError}</StatusText> : null}
          </div>
          {sample ? <StatsTable stats={sample.stats} /> : null}
        </Block>
      </div>
    </main>
  );
}

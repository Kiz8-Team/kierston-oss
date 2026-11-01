"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Swatch } from "@/components/Charts";
import { VehicleChip } from "@/components/console/Chip";
import { ButtonTabs } from "@/components/console/ButtonTabs";
import { Fact, Facts } from "@/components/browse/detail";
import { DayList, DayRow } from "@/components/day/DayRow";
import { DispatchMap } from "@/components/dispatch/DispatchMap";
import { DispatchTimeline, type TrackRow } from "@/components/dispatch/DispatchTimeline";
import { PersonLink, personName } from "@/components/PersonLink";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useNames } from "@/components/useNames";
import {
  CALLER_COLOR, PRIORITY_COLOR, SERVICE_COLOR, dispatchClock, incidentHref, incidentLast,
  incidentMoments, kindLabel, seconds, serviceLabel, unitPhases,
} from "@/lib/dispatch";
import type { IncidentDetail } from "@/lib/server/dispatch";
import { cn } from "@/lib/utils";

/**
 * One 911 call, on its own page: its clock, its map and who was involved.
 *
 * The caller and each unit get a row on a shared clock, and the map follows
 * the cursor — so the gap between a unit being dispatched and it moving, or a
 * drive that takes longer than its minutes say, is something you watch rather
 * than something you work out.
 */

/** Minutes either side of the call on its clock. */
const AROUND = 15;

const RATES = [1, 5, 15] as const;

export function IncidentView({ date, index }: { date: string; index: number }) {
  const names = useNames();
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<number>(5);
  const [fitToken, setFitToken] = useState(0);
  const [panel, setPanel] = useState<"people" | "times">("people");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlaying(false);
    fetch(`/api/dispatch/${encodeURIComponent(date)}/${index}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        const loaded = payload as IncidentDetail;
        setDetail(loaded);
        setError(null);
        setCursor(loaded.incident.received);
        setFitToken((token) => token + 1);
      })
      .catch((reason) => { if (!cancelled) { setDetail(null); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, index]);

  const incident = detail?.incident ?? null;

  const window = useMemo(() => incident
    ? { start: incident.received - AROUND, end: incidentLast(incident) + AROUND }
    : { start: 0, end: 1 }, [incident]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const advanced = ((now - last) / 1000) * rate;
      last = now;
      let done = false;
      setCursor((current) => {
        const next = Math.min(window.end, current + advanced);
        done = next >= window.end;
        return next;
      });
      if (done) { setPlaying(false); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate, window]);

  const seek = useCallback((minute: number) => {
    setPlaying(false);
    setCursor(Math.min(window.end, Math.max(window.start, minute)));
  }, [window]);

  const rows = useMemo<TrackRow[]>(() => {
    if (!incident) return [];
    const caller: TrackRow = {
      id: "caller",
      label: <span><Swatch color={CALLER_COLOR} />Caller · {personName(names, incident.caller)}</span>,
      segments: [{
        start: incident.received, end: incident.callerUntil, color: CALLER_COLOR, style: "faint",
        title: `On scene · ${dispatchClock(incident.received)}–${dispatchClock(incident.callerUntil)}`,
      }],
      marks: incident.call ? [{
        minute: incident.call.at / 60, color: CALLER_COLOR,
        title: `911 call ${dispatchClock(incident.call.at / 60, true)} · ${incident.call.outcome} · ${seconds(incident.call.duration)}`,
      }] : [],
    };
    return [caller, ...incident.units.map((unit): TrackRow => {
      const color = SERVICE_COLOR[unit.service] ?? "#616e7a";
      return {
        id: `unit-${unit.row}`,
        label: <span title={unit.vin}><Swatch color={color} />{serviceLabel(unit.service)} · {personName(names, unit.person)}</span>,
        segments: unitPhases(unit).map((phase) => ({
          start: phase.start, end: phase.end, color, style: phase.style,
          title: `${phase.label} · ${dispatchClock(phase.start)}–${dispatchClock(phase.end)}`,
        })),
      };
    })];
  }, [incident, names]);

  const moments = useMemo(() => (incident ? incidentMoments(incident) : []), [incident]);
  const incidents = useMemo(() => (incident ? [incident] : []), [incident]);

  const status = !incident ? ""
    : cursor < incident.received
      ? `−${Math.round(incident.received - cursor)} min`
      : incident.firstOnScene !== null && cursor < incident.firstOnScene
        ? `+${Math.round(cursor - incident.received)} min · waiting`
        : `+${Math.round(cursor - incident.received)} min`;

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="ghost" className="-ml-2">
            <Link href={`/dispatch?date=${encodeURIComponent(date)}`}>
              <ArrowLeft className="size-3.5" />All calls
            </Link>
          </Button>
          {detail ? (
            <span className="ml-auto flex gap-1.5">
              {index > 0 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={incidentHref(date, index - 1)}><ChevronLeft className="size-3.5" />Previous</Link>
                </Button>
              ) : null}
              {index < detail.total - 1 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={incidentHref(date, index + 1)}>Next<ChevronRight className="size-3.5" /></Link>
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>

        {error ? <div className="mt-4"><StatusText state="error">{error}</StatusText></div> : null}
        {loading && !detail ? <div className="mt-4"><StatusText state="busy">Loading…</StatusText></div> : null}
        {!detail && !loading && !error ? <EmptyState title="No such call" /> : null}

        {incident && detail ? (
          <>
            <header className="mt-3">
              <h1 className="m-0 flex items-center gap-2 text-[1.15rem] leading-none font-semibold tracking-tight">
                <Swatch color={PRIORITY_COLOR[incident.priority]} className="mr-0" />
                {kindLabel(incident.kind)}
              </h1>
              <p className="mt-2 mb-0 text-[0.8rem] text-muted-foreground tabular-nums">
                {dispatchClock(incident.received)} · {detail.date} · P{incident.priority} ·{" "}
                {incident.placeLabel ?? incident.placeClass} ·{" "}
                <span className={cn(incident.disposition !== "cleared" && "text-destructive")}>{incident.disposition}</span>
                {" "}· {incident.requested.police} police, {incident.requested.ems} EMS requested
              </p>
            </header>

            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button" size="sm" variant="outline" className="w-[4.6rem]"
                onClick={() => {
                  if (!playing && cursor >= window.end) setCursor(window.start);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {playing ? "Pause" : "Play"}
              </Button>
              <NativeSelect className="w-[8rem]" value={String(rate)} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback speed">
                {RATES.map((one) => <option key={one} value={one}>{one} min / s</option>)}
              </NativeSelect>
              <strong className="min-w-[3.4rem] text-[1.05rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
                {dispatchClock(cursor)}
              </strong>
              <span className="text-[0.8rem] text-muted-foreground tabular-nums">{status}</span>
            </div>

            <div className="mt-3">
              <DispatchTimeline
                rows={rows}
                from={window.start}
                to={window.end}
                minute={cursor}
                band={incident.firstOnScene !== null ? { start: incident.received, end: incident.firstOnScene } : null}
                onScrub={seek}
              />
            </div>

            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_24rem] gap-4 max-[62rem]:grid-cols-1">
              <DispatchMap
                incidents={incidents}
                selected={incident}
                tracks={detail.tracks}
                minute={cursor}
                fitToken={fitToken}
                className="h-[34rem] w-full overflow-hidden rounded-[var(--radius)] border border-border"
              />

              <div className="flex h-[34rem] min-h-0 flex-col">
                <ButtonTabs
                  label="Call lists"
                  value={panel}
                  onChange={setPanel}
                  tabs={[
                    { id: "people", label: "People", count: incident.units.length + 1 },
                    { id: "times", label: "Times", count: moments.length },
                  ]}
                />
                <div role="tabpanel" className="mt-2 min-h-0 flex-1 overflow-y-auto">
                  {panel === "people" ? (
                    <DayList>
                      <DayRow
                        time={dispatchClock(incident.call ? incident.call.at / 60 : incident.received)}
                        title={`Caller · ${personName(names, incident.caller)}`}
                        figure={incident.call ? seconds(incident.call.duration) : undefined}
                        swatch={CALLER_COLOR}
                        onSeek={() => seek(incident.call ? incident.call.at / 60 : incident.received)}
                      >
                        <Facts>
                          <Fact label="Caller" wide><PersonLink names={names} person={incident.caller} /></Fact>
                          {incident.call ? (
                            <>
                              <Fact label="Outcome">{incident.call.outcome}</Fact>
                              <Fact label="Ring">{seconds(incident.call.ring)}</Fact>
                              <Fact label="Length">{seconds(incident.call.duration)}</Fact>
                            </>
                          ) : <Fact label="Call">No record</Fact>}
                          <Fact label="Day">
                            <Link href={`/days?date=${encodeURIComponent(detail.date)}&person=${incident.caller}`}>
                              Day
                            </Link>
                          </Fact>
                        </Facts>
                      </DayRow>
                      {incident.units.map((unit) => (
                        <DayRow
                          key={unit.row}
                          time={dispatchClock(unit.dispatched)}
                          title={`${serviceLabel(unit.service)} · ${personName(names, unit.person)}`}
                          figure={`${unit.arrived - unit.dispatched} min`}
                          swatch={SERVICE_COLOR[unit.service]}
                          onSeek={() => seek(unit.dispatched)}
                        >
                          <Facts>
                            <Fact label={unit.partner === null ? "Officer" : "Driver"}>
                              <PersonLink names={names} person={unit.person} />
                            </Fact>
                            {unit.partner !== null ? (
                              <Fact label="Crew"><PersonLink names={names} person={unit.partner} /></Fact>
                            ) : null}
                            <Fact label="Drive">{unit.arrived - unit.dispatched} min</Fact>
                            <Fact label="On scene">{unit.cleared - unit.arrived} min</Fact>
                            {unit.hospital ? <Fact label="Hospital" wide>{unit.hospital.label}</Fact> : null}
                            <Fact label="Vehicle" wide><VehicleChip vin={unit.vin} date={detail.date} /></Fact>
                          </Facts>
                        </DayRow>
                      ))}
                    </DayList>
                  ) : (
                    <DayList>
                      {moments.map((moment, at) => (
                        <DayRow
                          key={`${moment.minute}-${at}`}
                          time={dispatchClock(moment.minute)}
                          title={moment.label}
                          swatch={moment.color}
                          active={Math.round(cursor) === Math.round(moment.minute)}
                          onSeek={() => seek(moment.minute)}
                        >
                          {moment.detail ? <p className="m-0 text-[0.78rem] text-muted-foreground first-letter:uppercase">{moment.detail}</p> : null}
                        </DayRow>
                      ))}
                    </DayList>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}

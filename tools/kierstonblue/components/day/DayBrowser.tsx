"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RadioTower } from "lucide-react";
import { DayLedger } from "@/components/day/DayLedger";
import { DayMap, type ServingCell } from "@/components/day/DayMap";
import { DayRadio } from "@/components/day/DayRadio";
import { DayTimeline, type TimelineMark } from "@/components/day/DayTimeline";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { vehicleHref } from "@/lib/vehicle-day";
import { useNames } from "@/components/useNames";
import { useDay } from "@/components/Scope";
import { Button } from "@/components/ui/button";
import { Fact, Facts } from "@/components/browse/detail";
import { Chip } from "@/components/console/Chip";
import { DayList, DayRow } from "@/components/day/DayRow";
import { ButtonTabs } from "@/components/console/ButtonTabs";
import { Input } from "@/components/ui/input";
import {
  DAY_END, DAY_START, MODE_COLOR, buildTimeline, clock, duration, positionAt, segmentAt,
} from "@/lib/day-timeline";
import { humanise, usdExact } from "@/lib/format";
import type { PersonDay } from "@/lib/server/day";
import { buildRadioDay, layerColor, signalLabel, spanAt } from "@/lib/radio";
import { reasonLabel, transactionColor } from "@/lib/spending";

/**
 * Times in the day file are minutes from midnight and can fall outside the day
 * they are filed under: the sleep a resident is already in at 00:00 started
 * the evening before, so it is stored as a negative. Rendering that literally
 * gave rows reading "-1d 23:55". The lists show the part of the entry that
 * falls inside this day, the way the timeline does, and name the spill.
 */
function dayWindow(start: number, end: number) {
  const from = Math.min(DAY_END, Math.max(DAY_START, start));
  const to = Math.min(DAY_END, Math.max(DAY_START, end));
  return {
    time: clock(from),
    length: duration(to - from),
    note: start < DAY_START ? "from previous day" : end > DAY_END ? "into next day" : null,
  };
}

type Panel = "schedule" | "money" | "legs";

export function DayBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const names = useNames();
  const requested = Number(params.get("person"));
  const initialPerson = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  const { day: date, days, error: daysError } = useDay();
  const [person, setPerson] = useState(initialPerson);
  const [draft, setDraft] = useState(String(initialPerson));
  const [day, setDay] = useState<PersonDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // One cursor drives everything: the timeline, the highlighted rows and the
  // marker on the map are all just readings taken at this minute of the day.
  const [cursor, setCursor] = useState(DAY_START);
  // Playback lives here rather than in the timeline because the timeline is no
  // longer the only scrubber: the cellular block has one bar per handset, and
  // all of them move this same cursor. Any of them taking hold of the minute
  // has to stop the clock, or the play loop overwrites the choice next frame.
  const [playing, setPlaying] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [panel, setPanel] = useState<Panel>("schedule");

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCursor(DAY_START);
    setPlaying(false);
    setFitToken((token) => token + 1);
    fetch(`/api/days/${encodeURIComponent(date)}/${person}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!cancelled) setDay(payload as PersonDay);
      })
      .catch((reason) => { if (!cancelled) { setDay(null); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    router.replace(`/days?date=${encodeURIComponent(date)}&person=${person}`, { scroll: false });
    return () => { cancelled = true; };
  }, [date, person, router]);

  const open = (next: number) => {
    const clean = Math.max(0, Math.floor(next));
    setPerson(clean);
    setDraft(String(clean));
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = Number(draft);
    if (Number.isSafeInteger(next) && next >= 0) open(next);
  };

  const segments = useMemo(() => day ? buildTimeline(day) : [], [day]);
  // Payments are instants and get marks under the bar rather than segments in
  // it — a purchase drawn as a span would be half a pixel wide and would read
  // as a gap in whatever it interrupted.
  const marks = useMemo<TimelineMark[]>(
    () => (day?.transactions ?? []).map((transaction) => ({
      minute: transaction.minute,
      color: transactionColor(transaction),
      label: !transaction.approved
        ? "declined"
        : transaction.kind === "withdrawal" ? "cash out" : "payments",
      title: `${clock(transaction.minute)} · ${usdExact(transaction.amount)} · `
        + `${transaction.merchant ?? "unnamed merchant"} · ${reasonLabel(transaction.reason)}`
        + (transaction.approved ? "" : ` · declined: ${transaction.decline ?? "unknown"}`),
    })),
    [day],
  );
  const radio = useMemo(
    () => day ? buildRadioDay(day.radio) : { handsets: [], cells: new Map() },
    [day],
  );
  // What is serving each handset right now, for the map. One entry per phone,
  // which is usually one line and occasionally two — a person can carry a work
  // handset and a personal one on different networks, attached to different
  // masts from the same seat.
  const serving = useMemo<ServingCell[]>(() => radio.handsets.flatMap((handset) => {
    const span = spanAt(handset.spans, cursor);
    const cell = span && span.cell !== null ? radio.cells.get(span.cell) : undefined;
    if (!span || !cell) return [];
    return [{
      lat: cell.lat,
      lon: cell.lon,
      color: layerColor(cell.layer),
      label: `${cell.band ?? cell.layer} · ${cell.cgi ?? "unknown CGI"} · `
        + `${signalLabel(span.rsrp)} · ${handset.subscriber.operator}`,
    }];
  }), [radio, cursor]);
  const activeIndex = segments.length ? segmentAt(segments, cursor) : -1;
  const activeSegment = activeIndex >= 0 ? segments[activeIndex] : null;
  const activeLeg = activeSegment?.legIndex ?? null;
  const position = useMemo(
    () => day && segments.length ? positionAt(segments, day.legs, cursor) : null,
    [day, segments, cursor],
  );

  // Every scrubber and every clickable row goes through this. The timeline's
  // own drag does not — its play loop calls `setCursor` directly, and routing
  // that through here would pause playback on its first frame.
  const seek = useCallback((minute: number) => {
    setPlaying(false);
    setCursor(Math.min(DAY_END, Math.max(DAY_START, minute)));
  }, []);

  // Picking a leg from the list is a jump in time, not a separate selection:
  // it parks the cursor at the departure and lets the map re-frame once.
  const selectLeg = useCallback((index: number) => {
    seek(day?.legs[index]?.depart ?? DAY_START);
    setFitToken((token) => token + 1);
  }, [day, seek]);

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <header className="max-w-[56rem]">
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">Daily movement</h1>
        </header>

        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={submit}>
              <label className="grid min-w-[12rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Resident id</span>
                <Input inputMode="numeric" min={0} type="number" value={draft} onChange={(event) => setDraft(event.target.value)} />
              </label>
              <div className="inline-flex overflow-hidden rounded-md border">
                <Button type="button" variant="ghost" className="rounded-none border-r" disabled={person === 0} onClick={() => open(person - 1)}>←</Button>
                <Button type="button" variant="ghost" className="rounded-none" onClick={() => open(person + 1)}>→</Button>
              </div>
              <Button asChild variant="outline">
                <Link href={`/comms?date=${encodeURIComponent(date)}&person=${person}`}>Communications</Link>
              </Button>
              <Button asChild variant="outline"><Link href={`/record?person=${person}`}>Full record</Link></Button>
              <Button asChild variant="outline"><Link href={`/spending?date=${encodeURIComponent(date)}`}>City spending</Link></Button>
        </form>

        {!days && !(error ?? daysError) ? <EmptyState title="Loading…" /> : null}
        {days?.length === 0 ? (
          <EmptyState title="No generated days">
            <code>cd kierston/sim && bun run day --export-day --date YYYY-MM-DD</code>
          </EmptyState>
        ) : null}
        {error ?? daysError ? <div className="mt-4"><StatusText state="error">{error ?? daysError}</StatusText></div> : null}

        {day ? (
          <>
            <div className="mt-7 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-5">
              <h2 className="m-0 text-[1.05rem] leading-none font-semibold tracking-[-0.015em]">
                {names?.knows(person) ? names.name(person) : `Resident ${person}`}
              </h2>
              <span className="text-[0.8rem] text-muted-foreground tabular-nums">
                {person} · {date}
              </span>
              {loading ? <StatusText state="busy">Loading…</StatusText> : null}
            </div>

            <div className="mt-4">
              <DayTimeline
                segments={segments}
                marks={marks}
                minute={cursor}
                playing={playing}
                onPlayingChange={setPlaying}
                onScrub={setCursor}
              />
            </div>

            {/* The map and the three readings of the day beside it, one at a
                time: each list is long, and side by side under the map none
                of their labels fitted. */}
            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_24rem] gap-4 max-[62rem]:grid-cols-1">
              <DayMap
                legs={day.legs}
                active={activeLeg}
                position={position}
                serving={serving}
                fitToken={fitToken}
                onSelect={selectLeg}
                className="h-[34rem]"
              />
              <div className="flex h-[34rem] min-h-0 flex-col">
                <ButtonTabs
                  label="Day lists"
                  value={panel}
                  onChange={setPanel}
                  tabs={[
                    { id: "schedule", label: "Schedule", count: day.schedule.length },
                    ...(day.banked ? [{ id: "money" as const, label: "Money", count: day.transactions.length }] : []),
                    { id: "legs", label: "Movements", count: day.legs.length },
                  ]}
                />
                <div role="tabpanel" className="mt-2 min-h-0 flex-1 overflow-y-auto">
                  {panel === "money" && day.banked ? (
                    <DayLedger transactions={day.transactions} cursor={cursor} onSeek={seek} />
                  ) : panel === "legs" ? (
                    <MovementList day={day} date={date} active={activeLeg} onSelect={selectLeg} />
                  ) : (
                    <ScheduleList day={day} cursor={cursor} onSeek={seek} />
                  )}
                </div>
              </div>
            </div>

            <div className="mt-9 border-t border-border pt-7">
              <h2 className="m-0 mb-5 flex items-center gap-2 text-[1.15rem] leading-none font-semibold tracking-[-0.015em]">
                <RadioTower className="size-4" />Cellular network
              </h2>
              {day.radio.networked ? (
                <DayRadio radio={radio} cursor={cursor} onSeek={seek} />
              ) : <EmptyState title="No network records" />}
            </div>
          </>
        ) : loading && days?.length ? <EmptyState title="Loading…" /> : null}
      </div>
    </main>
  );
}

function ScheduleList({ day, cursor, onSeek }: { day: PersonDay; cursor: number; onSeek: (minute: number) => void }) {
  if (!day.schedule.length) return <p className="m-0 py-2 text-[0.78rem] text-muted-foreground">No commitments</p>;
  return (
    <DayList>
      {day.schedule.map((entry, index) => {
        const shown = dayWindow(entry.start, entry.end);
        return (
          <DayRow
            key={`${entry.start}-${entry.kind}-${index}`}
            time={shown.time}
            title={entry.label ?? humanise(entry.kind)}
            figure={shown.length}
            active={cursor >= entry.start && cursor < entry.end}
            onSeek={() => onSeek(Math.min(DAY_END, Math.max(DAY_START, entry.start)))}
          >
            <Facts cols={3}>
              <Fact label="Kind">{humanise(entry.kind)}</Fact>
              <Fact label="Until">{clock(Math.min(DAY_END, entry.end))}</Fact>
              {shown.note ? <Fact label="Note">{shown.note}</Fact> : null}
              {entry.where ? <Fact label="Location" wide>{entry.where}</Fact> : null}
            </Facts>
          </DayRow>
        );
      })}
    </DayList>
  );
}

function MovementList({ day, date, active, onSelect }: { day: PersonDay; date: string; active: number | null; onSelect: (index: number) => void }) {
  if (!day.legs.length) return <p className="m-0 py-2 text-[0.78rem] text-muted-foreground">No movements</p>;
  return (
    <DayList>
      {day.legs.map((leg, index) => {
        const shown = dayWindow(leg.depart, leg.arrive);
        return (
          <DayRow
            key={`${leg.depart}-${index}`}
            time={shown.time}
            title={leg.to.label ?? "Destination"}
            figure={humanise(leg.mode)}
            swatch={MODE_COLOR[leg.mode] ?? MODE_COLOR.other}
            active={active === index}
            onSeek={() => onSelect(index)}
          >
            <Facts cols={3}>
              <Fact label="From" wide>{leg.from.label ?? "Origin"}</Fact>
              <Fact label="Purpose">{leg.purpose}</Fact>
              <Fact label="Distance">{leg.kilometres.toFixed(1)} km</Fact>
              <Fact label="Duration">{shown.length}</Fact>
              {leg.wait ? <Fact label="Wait">{Math.round(leg.wait)} min</Fact> : null}
              {leg.estimated ? <Fact label="Path">Estimated</Fact> : null}
              {shown.note ? <Fact label="Note">{shown.note}</Fact> : null}
              {leg.vehicle ? (
                <Fact label="Vehicle" wide>
                  <Chip kind="vehicle" href={vehicleHref(leg.vehicle, date)}>{leg.vehicle}</Chip>
                </Fact>
              ) : null}
            </Facts>
          </DayRow>
        );
      })}
    </DayList>
  );
}

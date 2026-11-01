"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, MapPin } from "lucide-react";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { MeetingMap, type MapParty } from "@/components/meetings/MeetingMap";
import { MeetingTimeline, type TimelineRow } from "@/components/meetings/MeetingTimeline";
import { PersonLink } from "@/components/PersonLink";
import { Block } from "@/components/console/Section";
import { Button } from "@/components/ui/button";
import { Tile, Tiles } from "@/components/Tiles";
import { useNames } from "@/components/useNames";
import { DAY_END, DAY_START, buildTimeline, clock, positionAt } from "@/lib/day-timeline";
import {
  meetingMoments, meetingSpan, meetingTitle, momentsFor, movementOf, nameOf,
  partyColor, stayOf,
} from "@/lib/meetings";
import type { MeetingDetail } from "@/lib/server/meetings";
import { cn } from "@/lib/utils";

/**
 * One gathering, on its own page.
 *
 * Every other page built on a day file is entered through a person. This one
 * is entered through an event, because the thing worth looking at — several
 * people converging on one place from wherever their day had put them — is not
 * visible from inside any single person's record.
 *
 * What a reader can check here
 * ----------------------------
 * That the party is plausible, that people arrive from the places their day
 * actually left them, that a lift shows up as a detour on the driver's line
 * and a shorter journey on the passenger's, and that nobody is at a table they
 * had no time to reach. Those are the failures a co-presence layer produces,
 * and none of them survives being drawn.
 */

/** How much of the day to show either side, when zoomed to the gathering. */
const AROUND = 150;

export function MeetingView({ date, index }: { date: string; index: number }) {
  const names = useNames();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(DAY_START);
  const [playing, setPlaying] = useState(false);
  const [zoomed, setZoomed] = useState(true);
  const [focused, setFocused] = useState<number | null>(null);
  const [fitToken, setFitToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlaying(false);
    fetch(`/api/meetings/${encodeURIComponent(date)}/${index}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        const detail = payload as MeetingDetail;
        setMeeting(detail);
        setError(null);
        // Park the clock a little before the first arrival rather than at
        // midnight: the evening is what was asked for.
        setCursor(Math.max(DAY_START, detail.start - 45));
        setFocused(null);
        setFitToken((token) => token + 1);
      })
      .catch((reason) => { if (!cancelled) { setMeeting(null); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, index]);

  const rows = useMemo<TimelineRow[]>(() => {
    if (!meeting) return [];
    return meeting.attendees.map((attendee, at) => ({
      person: attendee.person,
      name: nameOf(names, attendee.person),
      color: partyColor(at),
      role: attendee.role,
      segments: buildTimeline(movementOf(attendee)),
      moments: momentsFor(meeting, attendee, at),
      stay: stayOf(meeting, attendee),
    }));
  }, [meeting, names]);

  const moments = useMemo(() => meeting ? meetingMoments(meeting) : [], [meeting]);

  const parties = useMemo<MapParty[]>(() => {
    if (!meeting) return [];
    return meeting.attendees.map((attendee, at) => {
      const row = rows[at];
      return {
        person: attendee.person,
        name: row?.name ?? `Resident ${attendee.person}`,
        color: partyColor(at),
        legs: attendee.legs,
        position: row ? positionAt(row.segments, attendee.legs, cursor) : null,
        seated: row?.stay ? cursor >= row.stay.start && cursor < row.stay.end : false,
      };
    });
  }, [meeting, rows, cursor]);

  const window = useMemo(() => {
    if (!meeting || !zoomed) return { start: DAY_START, end: DAY_END };
    return {
      start: Math.max(DAY_START, meeting.start - AROUND),
      end: Math.min(DAY_END, meeting.end + AROUND),
    };
  }, [meeting, zoomed]);

  // Scrubbing must stay inside whatever window is showing, or the playhead
  // leaves the bar the moment somebody zooms in.
  useEffect(() => {
    setCursor((current) => Math.min(window.end, Math.max(window.start, current)));
  }, [window]);

  const seek = useCallback((minute: number) => {
    setPlaying(false);
    setCursor(minute);
  }, []);

  const toggle = useCallback(
    (person: number) => setFocused((current) => current === person ? null : person),
    [],
  );

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <Button asChild size="sm" variant="ghost" className="-ml-2">
          <Link href={`/meetings?date=${encodeURIComponent(date)}`}>
            <ArrowLeft className="size-3.5" />All gatherings
          </Link>
        </Button>

        {error ? <div className="mt-4"><StatusText state="error">{error}</StatusText></div> : null}
        {loading ? <div className="mt-4"><StatusText state="busy">Loading…</StatusText></div> : null}
        {!meeting && !loading && !error
          ? <EmptyState title="No such gathering" />
          : null}

        {meeting ? (
          <>
            <header className="mt-3">
              <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
                {meetingTitle(meeting)}
              </h1>
              <p className="mt-3 mb-0 text-[0.85rem] text-muted-foreground tabular-nums">
                {meetingSpan(meeting)} · {meeting.date} ·{" "}
                <span className="font-sans text-[max(0.8rem,0.85em)]">{meeting.key}</span>
                {meeting.host !== null ? ` · host ${nameOf(names, meeting.host)}` : ""}
                {meeting.payer !== null ? ` · payer ${nameOf(names, meeting.payer)}` : ""}
              </p>
              <Tiles className="mt-6">
                <Tile value={meeting.attendees.length}>attendees</Tile>
                <Tile value={meeting.attendees.filter((one) => one.role !== "attendee").length}>
                  carpooled
                </Tile>
                <Tile value={moments.filter((one) => one.kind === "arrives").length}>
                  arrivals
                </Tile>
                <Tile value={meeting.kind}>kind</Tile>
              </Tiles>
            </header>

            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><CalendarDays className="size-4" />Timelines</span>}
              meta={`${clock(window.start)}–${clock(window.end)}`}
            >
              <div className="mb-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant={zoomed ? "default" : "outline"} onClick={() => setZoomed(true)}>
                  Gathering
                </Button>
                <Button type="button" size="sm" variant={zoomed ? "outline" : "default"} onClick={() => setZoomed(false)}>
                  Whole day
                </Button>
              </div>
              <MeetingTimeline
                rows={rows}
                meeting={meeting}
                from={window.start}
                to={window.end}
                minute={cursor}
                playing={playing}
                selected={focused}
                onPlayingChange={setPlaying}
                onScrub={setCursor}
                onSelect={toggle}
              />
            </Block>

            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><MapPin className="size-4" />Map</span>}
            >
              <MeetingMap
                parties={focused === null ? parties : parties.filter((party) => party.person === focused)}
                venue={{
                  lat: meeting.lat,
                  lon: meeting.lon,
                  label: `${meetingTitle(meeting)} · ${meetingSpan(meeting)}`,
                }}
                window={{ start: meeting.start - AROUND, end: meeting.end + AROUND }}
                fitToken={fitToken}
                onSelect={toggle}
              />
            </Block>

            <div className="mt-9 grid grid-cols-2 gap-x-12 gap-y-9 max-[76rem]:grid-cols-1">
              <Block title="Attendees" meta={focused === null ? undefined : "1 on map"}>
                <ul className="grid list-none gap-0 p-0">
                  {meeting.attendees.map((attendee, at) => {
                    const row = rows[at];
                    return (
                      <li key={attendee.person} className="grid grid-cols-[1fr_auto] items-baseline gap-2 border-t border-border py-1.5 first:border-0">
                        <span className="min-w-0">
                          <PersonLink names={names} person={attendee.person} />
                          <span className="mt-px block truncate text-[0.78rem] text-muted-foreground">
                            {attendee.role}
                            {row?.stay
                              ? ` · ${clock(row.stay.start)}–${clock(row.stay.end)}`
                              : " · no stay"}
                          </span>
                        </span>
                        <span className="flex gap-1.5">
                          <Button
                            type="button" size="sm"
                            variant={focused === attendee.person ? "default" : "outline"}
                            onClick={() => toggle(attendee.person)}
                          >
                            {focused === attendee.person ? "Show all" : "Follow"}
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/days?date=${encodeURIComponent(meeting.date)}&person=${attendee.person}`}>Day</Link>
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Block>

              <Block title="Events" meta={`${moments.length}`}>
                <ol className="grid max-h-[26rem] list-none gap-0 overflow-auto p-0">
                  {moments.map((moment, at) => (
                    <li key={`${moment.person}-${moment.minute}-${at}`} className="border-t border-border first:border-0">
                      <button
                        type="button"
                        className={cn(
                          "grid w-full grid-cols-[3.4rem_1fr] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left leading-tight hover:bg-accent",
                          cursor >= moment.minute && cursor < moment.minute + 5 && "bg-accent",
                        )}
                        onClick={() => seek(moment.minute)}
                      >
                        <span className="text-[0.85rem] font-semibold tabular-nums">{clock(moment.minute)}</span>
                        <span className="min-w-0">
                          <strong className="truncate text-[0.88rem]">
                            {nameOf(names, moment.person)} · {moment.label}
                          </strong>
                          <span className="mt-px block truncate text-[0.78rem] text-muted-foreground">{moment.detail}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </Block>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}

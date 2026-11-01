"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Swatch } from "@/components/Charts";
import { clock, duration, type TimelineSegment } from "@/lib/day-timeline";
import { momentLegend, type MeetingMoment } from "@/lib/meetings";
import { cn } from "@/lib/utils";

/**
 * Several days, one clock.
 *
 * The day page's bar answers "what was she doing at seven". This one answers a
 * question that needs every line at once — who was already on their way when
 * the first guest arrived, who came straight from a shift, who left early —
 * and none of that survives being read one person at a time. So the rows share
 * a scale, a playhead and a shaded band over the gathering itself, and the
 * whole thing scrubs as a single instrument.
 *
 * The window is adjustable because a dinner is two hours inside a day of
 * twenty-four: at full width the part everybody came for is sixty pixels of a
 * nine-hundred-pixel bar. Zooming to the evening is not a convenience, it is
 * the difference between seeing the arrivals stagger and not.
 */

/** Simulated minutes advanced per real second while playing. */
const PLAY_RATE = 60;

const SEGMENT = "absolute top-0 bottom-0 bg-[var(--segment-color)] "
  + "shadow-[inset_1px_0_0_rgb(255_255_255/40%)]";

// One literal, because Tailwind never sees a class split across a `+`.
// prettier-ignore
const TRAVEL = "bg-[image:repeating-linear-gradient(115deg,var(--segment-color)_0_5px,color-mix(in_srgb,var(--segment-color)_62%,white)_5px_10px)]";

const MARK = "pointer-events-none absolute bottom-[-0.3rem] -ml-[0.18rem] size-[0.36rem] "
  + "rotate-45 rounded-[1px] bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--card)]";

const PLAYHEAD = "pointer-events-none absolute top-0 bottom-0 -ml-px w-0.5 bg-foreground "
  + "shadow-[0_0_0_1px_color-mix(in_srgb,var(--card)_80%,transparent)]";

const BAND = "pointer-events-none absolute top-0 bottom-0 bg-foreground/[0.07] "
  + "border-x border-dashed border-foreground/40";

const AXIS = "relative h-[0.95rem] text-[0.66rem] text-muted-foreground tabular-nums "
  + "[&>span]:absolute [&>span]:-translate-x-1/2 "
  + "[&>span:first-child]:translate-x-0 [&>span:last-child]:-translate-x-full";

/** The two block shapes the legend names, drawn the same way the bars draw them. */
const SEAT_KEY = "mr-[0.4rem] inline-block h-[0.5rem] w-[0.9rem] rounded-[2px] "
  + "bg-foreground/70 align-baseline";

const BAND_KEY = "mr-[0.4rem] inline-block h-[0.5rem] w-[0.9rem] rounded-[2px] "
  + "border border-dashed border-foreground/50 bg-foreground/[0.07] align-baseline";

export interface TimelineRow {
  person: number;
  name: string;
  color: string;
  role: string;
  segments: TimelineSegment[];
  moments: MeetingMoment[];
  /** The part of the gathering this person was actually present for. */
  stay: { start: number; end: number } | null;
}

export function MeetingTimeline({
  rows, meeting, from, to, minute, playing, selected,
  onPlayingChange, onScrub, onSelect,
}: {
  rows: TimelineRow[];
  meeting: { start: number; end: number };
  /** The visible window, in minutes from midnight. */
  from: number;
  to: number;
  minute: number;
  playing: boolean;
  selected: number | null;
  onPlayingChange: (playing: boolean) => void;
  onScrub: (minute: number) => void;
  onSelect: (person: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  /**
   * The bars, not the whole instrument.
   *
   * Pointer events are caught on the outer element so a drag anywhere across
   * the rows works, but that element also spans the column of names on the
   * left. Measuring the scrub against it put every minute a name-column's
   * width out of step with the playhead, which is drawn inside the bars. The
   * rail below is in the same grid column as the bars and is therefore exactly
   * as wide, so it is what a click is converted against.
   */
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const minuteRef = useRef(minute);
  minuteRef.current = minute;

  const span = Math.max(1, to - from);
  const share = (value: number) => ((value - from) / span) * 100;
  const clamp = (value: number) => Math.min(to, Math.max(from, value));

  const scrubTo = useCallback((clientX: number) => {
    const box = (railRef.current ?? trackRef.current)?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const part = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onScrub(Math.round(from + part * span));
  }, [onScrub, from, span]);

  // Playback walks the clock in real time, so an hour at the table takes as
  // long to pass as an hour on the road.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const advanced = ((now - last) / 1000) * PLAY_RATE;
      last = now;
      onScrub(Math.min(to, minuteRef.current + advanced));
      if (minuteRef.current >= to) { onPlayingChange(false); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, onScrub, onPlayingChange, to]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 60 : 1;
    const moves: Record<string, number> = {
      ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      PageDown: -60, PageUp: 60,
    };
    if (event.key in moves) {
      event.preventDefault();
      onPlayingChange(false);
      onScrub(clamp(Math.round(minute) + moves[event.key]));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onPlayingChange(false);
      onScrub(event.key === "Home" ? from : to);
    }
  };

  const ticks = tickMinutes(from, to);

  return (
    <div className="grid gap-[0.55rem]">
      <div className="flex items-center gap-[0.85rem]">
        <Button
          type="button" size="sm" variant="outline" className="w-[5.4rem]"
          onClick={() => {
            if (!playing && minute >= to) onScrub(from);
            onPlayingChange(!playing);
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <strong className="min-w-[4.2rem] text-[1.4rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {clock(minute)}
        </strong>
        <span className="text-[0.85rem] text-muted-foreground">
          {minute < meeting.start
            ? `−${duration(meeting.start - minute)}`
            : minute >= meeting.end
              ? `end +${duration(minute - meeting.end)}`
              : `+${duration(minute - meeting.start)} · ${rows.filter((row) => seated(row, minute)).length} of ${rows.length} present`}
        </span>
      </div>

      <div
        ref={trackRef}
        className={cn("relative touch-none select-none", dragging && "cursor-grabbing")}
        role="slider"
        tabIndex={0}
        aria-label="Time of day"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={Math.round(minute)}
        aria-valuetext={clock(minute)}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          onPlayingChange(false);
          setDragging(true);
          scrubTo(event.clientX);
        }}
        onPointerMove={(event) => { if (dragging) scrubTo(event.clientX); }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <div className="grid gap-[0.42rem]">
          {rows.map((row) => (
            <div key={row.person} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3">
              <button
                type="button"
                className={cn(
                  "min-w-0 truncate rounded-sm px-1 py-0.5 text-left text-[0.85rem] hover:bg-accent",
                  selected === row.person && "bg-accent ring-1 ring-primary/30",
                )}
                onClick={() => onSelect(row.person)}
                title={`${row.name} · ${row.role}`}
              >
                <Swatch color={row.color} />{row.name}
              </button>
              <div className="relative h-7 cursor-pointer overflow-visible">
                <div className="absolute inset-0 overflow-hidden rounded-[3px] border border-border bg-muted">
                  {row.segments.map((segment, index) => (
                    <div
                      key={`${segment.start}-${index}`}
                      className={cn(SEGMENT, segment.travel && TRAVEL)}
                      style={{
                        left: `${share(segment.start)}%`,
                        width: `${Math.max(share(segment.end) - share(segment.start), 0.12)}%`,
                        "--segment-color": segment.color,
                      } as React.CSSProperties}
                      title={`${clock(segment.start)}–${clock(segment.end)} · ${segment.title}`}
                    />
                  ))}
                  {row.stay ? (
                    <div
                      className="absolute inset-y-0 bg-[var(--seat-color)] opacity-90 shadow-[inset_0_0_0_1.5px_rgb(255_255_255/55%)]"
                      style={{
                        left: `${share(row.stay.start)}%`,
                        width: `${Math.max(share(row.stay.end) - share(row.stay.start), 0.2)}%`,
                        "--seat-color": row.color,
                      } as React.CSSProperties}
                      title={`Stay · ${clock(row.stay.start)}–${clock(row.stay.end)}`}
                    />
                  ) : null}
                </div>
                <div
                  className={BAND}
                  style={{
                    left: `${share(meeting.start)}%`,
                    width: `${Math.max(share(meeting.end) - share(meeting.start), 0.2)}%`,
                  }}
                />
                {row.moments.map((moment, index) => (
                  <div
                    key={`${moment.minute}-${moment.kind}-${index}`}
                    className={MARK}
                    style={{
                      left: `${share(clamp(moment.minute))}%`,
                      "--mark-color": moment.color,
                    } as React.CSSProperties}
                    title={`${clock(moment.minute)} · ${row.name} · ${moment.label} · ${moment.detail}`}
                  />
                ))}
                <div className={PLAYHEAD} style={{ left: `${share(minute)}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-[0.35rem] grid grid-cols-[minmax(6rem,10rem)_1fr] gap-3">
          <span />
          <div ref={railRef} className={AXIS}>
            {ticks.map((tick) => (
              <span key={tick} style={{ left: `${share(tick)}%` }}>{clock(tick)}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-[0.85rem] gap-y-[0.15rem] text-[0.7rem] text-muted-foreground">
        {momentLegend(rows.flatMap((row) => row.moments)).map((entry) => (
          <span key={entry.kind}>
            <Swatch color={entry.color} style={{ transform: "rotate(45deg)" }} />
            {entry.count} {entry.label}
          </span>
        ))}
        <span><span className={SEAT_KEY} />stay</span>
        <span><span className={BAND_KEY} />gathering</span>
      </div>
    </div>
  );
}

const seated = (row: TimelineRow, minute: number) =>
  row.stay !== null && minute >= row.stay.start && minute < row.stay.end;

/**
 * Six or so labelled ticks across whatever window is showing, on a round
 * number of minutes: a whole day gets three-hour marks, an evening gets
 * half-hours, and neither ends up with 18:37 written under it.
 */
function tickMinutes(from: number, to: number): number[] {
  const steps = [15, 30, 60, 120, 180, 360];
  const span = Math.max(1, to - from);
  const step = steps.find((candidate) => span / candidate <= 8) ?? 180;
  const first = Math.ceil(from / step) * step;
  const out: number[] = [];
  for (let minute = first; minute <= to; minute += step) out.push(minute);
  return out;
}

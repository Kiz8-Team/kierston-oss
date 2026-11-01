"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DAY_END, DAY_START, clock, duration,
  type TimelineSegment,
} from "@/lib/day-timeline";
import { cn } from "@/lib/utils";
import { Swatch } from "@/components/Charts";

/** Simulated minutes advanced per real second while playing. */
const PLAY_RATE = 90;

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

/**
 * A whole day is 1440 minutes across maybe 900 pixels, so a minute is well
 * under a pixel: the bar is read by shape and colour, and the clock beside it
 * carries the precision.
 *
 * Every segment sits at full strength. A day is mostly the parts nobody is
 * scrubbing at, and fading those to wash out the one under the cursor left the
 * bar looking empty; the cursor is marked by a ring instead, which reads
 * against a solid block without having to dim eleven others.
 */
const SEGMENT = "absolute top-0 bottom-0 bg-[var(--segment-color)] "
  + "shadow-[inset_1px_0_0_rgb(255_255_255/40%)]";

/**
 * Trips are hatched as well as coloured: they are often only a few pixels wide.
 *
 * On one line because Tailwind scans raw source text — a class split across two
 * string literals is never seen, and the hatch silently does not render.
 */
// prettier-ignore
const TRAVEL = "bg-[image:repeating-linear-gradient(115deg,var(--segment-color)_0_5px,color-mix(in_srgb,var(--segment-color)_62%,white)_5px_10px)]";

const ACTIVE = "shadow-[inset_0_0_0_2px_var(--foreground),inset_0_0_0_4px_rgb(255_255_255/55%)]";

/**
 * A payment is an instant, not a span. Given a segment it would be half a pixel
 * wide and would read as a gap in whatever it interrupted, so it gets a mark
 * under the bar instead. Not clickable: the track under it is the scrubber, and
 * the ledger beside it is where a row is picked.
 */
const MARK = "pointer-events-none absolute bottom-[-0.34rem] -ml-[0.2rem] size-[0.4rem] "
  + "rotate-45 rounded-[1px] bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--card)]";

const PLAYHEAD = "absolute top-[-0.3rem] bottom-[-0.3rem] -ml-px w-0.5 bg-foreground "
  + "shadow-[0_0_0_1px_color-mix(in_srgb,var(--card)_80%,transparent)] "
  + "after:absolute after:top-[-0.28rem] after:left-1/2 after:size-[0.7rem] "
  + "after:-translate-x-1/2 after:rounded-full after:border-2 after:border-card "
  + "after:bg-foreground after:content-['']";

/** The end labels align to their edges rather than centring off the bar. */
const HOURS_AXIS = "relative h-[0.95rem] text-[0.66rem] text-muted-foreground tabular-nums "
  + "[&>span]:absolute [&>span]:-translate-x-1/2 "
  + "[&>span:first-child]:translate-x-0 [&>span:last-child]:-translate-x-full";

const NOW = "grid min-w-0 [&>strong]:truncate [&>strong]:text-[0.85rem] "
  + "[&>small]:text-[0.7rem] [&>small]:text-muted-foreground";

/** A moment worth marking under the bar — a payment, at the minute it cleared. */
export interface TimelineMark {
  minute: number;
  color: string;
  title: string;
  /** What to call this kind of mark in the legend, where it groups by colour. */
  label: string;
}

/**
 * Playback is owned by the page rather than by this bar.
 *
 * There is more than one scrubber on the day now — this one and a bar per
 * handset in the cellular block — and they all drive the same cursor. If the
 * clock kept running while somebody dragged one of the others, the play loop
 * would overwrite the minute they had just chosen a frame later. Hoisting the
 * flag is what lets any of them stop it.
 */
export function DayTimeline({ segments, marks = [], minute, playing, onPlayingChange, onScrub }: {
  segments: TimelineSegment[];
  marks?: TimelineMark[];
  minute: number;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onScrub: (minute: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // The playback loop reads the live cursor without restarting on every tick.
  const minuteRef = useRef(minute);
  minuteRef.current = minute;

  const scrubTo = useCallback((clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const share = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onScrub(Math.round(DAY_START + share * (DAY_END - DAY_START)));
  }, [onScrub]);

  // Playback walks the clock in real time rather than by segment, so an hour
  // at a desk takes as long to pass as an hour on the road.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const advanced = ((now - last) / 1000) * PLAY_RATE;
      last = now;
      onScrub(Math.min(DAY_END, minuteRef.current + advanced));
      if (minuteRef.current >= DAY_END) { onPlayingChange(false); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, onScrub, onPlayingChange]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 60 : 1;
    const moves: Record<string, number> = {
      ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      PageDown: -60, PageUp: 60,
    };
    if (event.key in moves) {
      event.preventDefault();
      onPlayingChange(false);
      onScrub(Math.min(DAY_END, Math.max(DAY_START, Math.round(minute) + moves[event.key])));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onPlayingChange(false);
      onScrub(event.key === "Home" ? DAY_START : DAY_END);
    }
  };

  const share = (value: number) => ((value - DAY_START) / (DAY_END - DAY_START)) * 100;
  const activeIndex = segments.findIndex((segment) => minute >= segment.start && minute < segment.end);
  const active = segments[activeIndex] ?? segments[segments.length - 1] ?? null;

  return (
    <div className="grid gap-[0.4rem]">
      <div className="flex items-center gap-[0.85rem]">
        <Button
          type="button" size="sm" variant="outline" className="w-[4.6rem]"
          onClick={() => {
            if (!playing && minute >= DAY_END) onScrub(DAY_START);
            onPlayingChange(!playing);
          }}
          aria-label={playing ? "Pause the day" : "Play the day"}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <strong className="min-w-[3.4rem] text-[1.05rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {clock(minute)}
        </strong>
        {active ? (
          <span className={NOW}>
            <Swatch color={active.color} />
            <strong>{active.title}</strong>
            <small>
              {active.travel ? "travelling · " : ""}
              {clock(active.start)}–{clock(active.end)} · {duration(active.end - active.start)}
              {active.detail ? ` · ${active.detail}` : ""}
            </small>
          </span>
        ) : <span className={NOW}><small>No record</small></span>}
      </div>

      <div
        ref={trackRef}
        className={cn(
          "relative h-7 cursor-pointer touch-none select-none",
          dragging && "cursor-grabbing",
        )}
        role="slider"
        tabIndex={0}
        aria-label="Time of day"
        aria-valuemin={DAY_START}
        aria-valuemax={DAY_END}
        aria-valuenow={Math.round(minute)}
        aria-valuetext={active ? `${clock(minute)}, ${active.title}` : clock(minute)}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
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
        <div className="absolute inset-0 overflow-hidden rounded-[var(--radius)] border border-border bg-muted">
          {segments.map((segment, index) => (
            <div
              key={`${segment.start}-${index}`}
              className={cn(
                SEGMENT,
                segment.travel && TRAVEL,
                index === activeIndex && ACTIVE,
              )}
              style={{
                left: `${share(segment.start)}%`,
                width: `${Math.max(share(segment.end) - share(segment.start), 0.15)}%`,
                "--segment-color": segment.color,
              } as React.CSSProperties}
              title={`${clock(segment.start)}–${clock(segment.end)} · ${segment.title}`}
            />
          ))}
          {HOURS.slice(1, -1).map((hour) => (
            <div
              key={hour}
              className="absolute top-0 bottom-0 w-px bg-background/60"
              style={{ left: `${share(hour * 60)}%` }}
            />
          ))}
        </div>
        {marks.map((mark, index) => (
          <div
            key={`${mark.minute}-${index}`}
            className={MARK}
            style={{
              left: `${share(Math.min(DAY_END, Math.max(DAY_START, mark.minute)))}%`,
              "--mark-color": mark.color,
            } as React.CSSProperties}
            title={mark.title}
          />
        ))}
        <div className={PLAYHEAD} style={{ left: `${share(minute)}%` }} />
      </div>

      <div className={HOURS_AXIS}>
        {HOURS.map((hour) => (
          <span key={hour} style={{ left: `${share(hour * 60)}%` }}>
            {String(hour).padStart(2, "0")}:00
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-[0.85rem] gap-y-[0.15rem] text-[0.7rem] text-muted-foreground">
        {legend(segments).map((entry) => (
          <span key={entry.kind}>
            <Swatch color={entry.color} />{entry.kind}
          </span>
        ))}
        {markLegend(marks).map((entry) => (
          <span key={entry.label}>
            <Swatch color={entry.color} style={{ transform: "rotate(45deg)" }} />
            {entry.count} {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * One swatch per kind of mark present, with how many there were.
 *
 * Counted rather than merely listed because the marks are the only thing on the
 * bar too small to tally by eye, and because "6 payments · 1 declined" is the
 * whole of what a reader wants from a day's money before they read the ledger.
 */
function markLegend(marks: TimelineMark[]): { label: string; color: string; count: number }[] {
  const seen = new Map<string, { label: string; color: string; count: number }>();
  for (const mark of marks) {
    const known = seen.get(mark.label);
    if (known) known.count += 1;
    else seen.set(mark.label, { label: mark.label, color: mark.color, count: 1 });
  }
  return [...seen.values()];
}

/** One swatch per kind of segment actually present, trips first. */
function legend(segments: TimelineSegment[]): { kind: string; color: string }[] {
  const seen = new Map<string, { kind: string; color: string; travel: boolean }>();
  for (const segment of segments) {
    if (!seen.has(segment.kind)) seen.set(segment.kind, { kind: segment.kind, color: segment.color, travel: segment.travel });
  }
  return [...seen.values()].sort((a, b) => Number(b.travel) - Number(a.travel));
}

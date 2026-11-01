"use client";

import { useCallback, useRef, useState } from "react";
import { dispatchClock, type PhaseStyle } from "@/lib/dispatch";
import { cn } from "@/lib/utils";

/**
 * One incident on one clock: the caller on a row, each unit on a row.
 *
 * The rows share a scale and a playhead, so "the second car was still driving
 * when the first had cleared" is visible without reading minutes. Dragging
 * anywhere across the rows scrubs; the play control lives on the page, which
 * also owns the map the cursor drives.
 */

const SEGMENT = "absolute top-0 bottom-0 rounded-[2px] bg-[var(--segment-color)]";

// One literal, because Tailwind never sees a class split across a `+`.
// prettier-ignore
const HATCH = "bg-[image:repeating-linear-gradient(115deg,var(--segment-color)_0_5px,color-mix(in_srgb,var(--segment-color)_62%,white)_5px_10px)]";

const STYLE: Record<PhaseStyle, string> = {
  solid: "",
  hatch: HATCH,
  faint: "opacity-45",
  outline: "bg-transparent border border-[var(--segment-color)]",
};

const MARK = "pointer-events-none absolute bottom-[-0.3rem] -ml-[0.18rem] size-[0.36rem] "
  + "rotate-45 rounded-[1px] bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--card)]";

const PLAYHEAD = "pointer-events-none absolute top-0 bottom-0 -ml-px w-0.5 bg-foreground "
  + "shadow-[0_0_0_1px_color-mix(in_srgb,var(--card)_80%,transparent)]";

const BAND = "pointer-events-none absolute top-0 bottom-0 bg-foreground/[0.06] "
  + "border-x border-dashed border-foreground/35";

const AXIS = "relative h-[0.95rem] text-[0.75rem] text-muted-foreground tabular-nums "
  + "[&>span]:absolute [&>span]:-translate-x-1/2 [&>span]:whitespace-nowrap "
  + "[&>span:first-child]:translate-x-0 [&>span:last-child]:-translate-x-full";

export interface TrackSegment {
  start: number;
  end: number;
  color: string;
  style: PhaseStyle;
  title: string;
}

export interface TrackRow {
  id: string;
  label: React.ReactNode;
  segments: TrackSegment[];
  marks?: { minute: number; color: string; title: string }[];
}

export function DispatchTimeline({ rows, from, to, minute, band, onScrub }: {
  rows: TrackRow[];
  from: number;
  to: number;
  minute: number;
  /** A shaded stretch across every row: the wait for the first unit. */
  band?: { start: number; end: number } | null;
  onScrub: (minute: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const span = Math.max(1, to - from);
  const share = (value: number) => ((Math.min(to, Math.max(from, value)) - from) / span) * 100;

  const scrubTo = useCallback((clientX: number) => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const part = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onScrub(Math.round(from + part * span));
  }, [onScrub, from, span]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step };
    if (event.key in moves) {
      event.preventDefault();
      onScrub(Math.min(to, Math.max(from, Math.round(minute) + moves[event.key]!)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onScrub(event.key === "Home" ? from : to);
    }
  };

  return (
    <div
      className={cn("relative touch-none select-none", dragging && "cursor-grabbing")}
      role="slider"
      tabIndex={0}
      aria-label="Time"
      aria-valuemin={from}
      aria-valuemax={to}
      aria-valuenow={Math.round(minute)}
      aria-valuetext={dispatchClock(minute)}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
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
      <div className="grid gap-[0.3rem]">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[minmax(7rem,14rem)_1fr] items-center gap-3">
            <div className="min-w-0 truncate text-[0.78rem]">{row.label}</div>
            <div className="relative h-4 cursor-pointer">
              <div className="absolute inset-0 rounded-[3px] border border-border bg-muted" />
              {band ? (
                <div
                  className={BAND}
                  style={{ left: `${share(band.start)}%`, width: `${Math.max(share(band.end) - share(band.start), 0.2)}%` }}
                />
              ) : null}
              {row.segments.map((segment, index) => (
                <div
                  key={`${segment.start}-${index}`}
                  className={cn(SEGMENT, STYLE[segment.style])}
                  style={{
                    left: `${share(segment.start)}%`,
                    width: `${Math.max(share(segment.end) - share(segment.start), 0.15)}%`,
                    "--segment-color": segment.color,
                  } as React.CSSProperties}
                  title={segment.title}
                />
              ))}
              {row.marks?.map((mark, index) => (
                <div
                  key={`${mark.minute}-${index}`}
                  className={MARK}
                  style={{ left: `${share(mark.minute)}%`, "--mark-color": mark.color } as React.CSSProperties}
                  title={mark.title}
                />
              ))}
              <div className={PLAYHEAD} style={{ left: `${share(minute)}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-[0.35rem] grid grid-cols-[minmax(7rem,14rem)_1fr] gap-3">
        <span />
        <div ref={railRef} className={AXIS}>
          {tickMinutes(from, to).map((tick) => (
            <span key={tick} style={{ left: `${share(tick)}%` }}>{dispatchClock(tick)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Round-number ticks, eight or fewer across whatever window is showing. */
function tickMinutes(from: number, to: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120];
  const span = Math.max(1, to - from);
  const step = steps.find((candidate) => span / candidate <= 8) ?? 120;
  const out: number[] = [];
  for (let minute = Math.ceil(from / step) * step; minute <= to; minute += step) out.push(minute);
  return out;
}

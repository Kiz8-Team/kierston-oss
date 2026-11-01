"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Swatch } from "@/components/Charts";
import {
  attentionBand, channelColor, channelLabel, elapsed, stamp, runAt,
  type Glance,
} from "@/lib/comms";
import type { AttentionRun } from "@/lib/server/comms";
import { percent } from "@/lib/format";
import { cn } from "@/lib/utils";

const MINUTES = 1440;
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

/**
 * The curve is drawn in minute space and stretched to whatever width the column
 * has, which is what `preserveAspectRatio="none"` is for. Strokes would stretch
 * with it, so the one stroked line in here carries `vector-effect` and the rest
 * is fill.
 */
const PLOT = "block h-[9rem] w-full";

/**
 * A glance sits under the plot rather than on it.
 *
 * It is one second wide against a day, so on the plot it would be a hairline
 * indistinguishable from the grid. Under it, as a mark of its own, it can be
 * pointed at — and the row of them is the day's traffic read as a rhythm, which
 * is the comparison the curve above is there to support.
 *
 * On one line: Tailwind scans raw source text, so a class split across two
 * string literals is never emitted and the mark renders with no colour at all.
 */
// prettier-ignore
const MARK = "absolute bottom-0 -ml-[0.19rem] size-[0.38rem] rotate-45 rounded-[1px] bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--canvas)]";

// prettier-ignore
const CALL_MARK = "absolute bottom-0 -ml-[0.22rem] size-[0.44rem] rounded-full bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--canvas)]";

const HEAD = "pointer-events-none absolute top-0 bottom-0 -ml-px w-0.5 bg-foreground";

/** The end labels align to their edges rather than centring off the plot. */
const AXIS = "relative h-[0.95rem] text-[0.7rem] text-muted-foreground tabular-nums "
  + "[&>span]:absolute [&>span]:-translate-x-1/2 "
  + "[&>span:first-child]:translate-x-0 [&>span:last-child]:-translate-x-full";

/**
 * The chance of a glance, minute by minute, with the day's actual traffic under it.
 *
 * Two things are on this figure and they are not the same kind of thing. The
 * filled shape is a model: the probability, derived from the day the scheduler
 * planned, that this person looks at their handset in any given minute. The
 * marks along the bottom are observations: the moments the records show them
 * sending something or dialling somebody. The second is a sample of the first,
 * which is exactly why they belong on one pair of axes — a line of marks in a
 * trough is the interesting case, and it is invisible on either figure alone.
 */
export function AttentionCurve({ runs, glances, minute, onScrub }: {
  runs: AttentionRun[];
  glances: Glance[];
  minute: number;
  onScrub: (minute: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const scrubTo = useCallback((clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const share = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onScrub(Math.min(MINUTES - 1, Math.round(share * MINUTES)));
  }, [onScrub]);

  // A step path, because the curve is piecewise constant by construction: it is
  // a table of how attentive each state is, painted onto the states the planned
  // day already has. Drawing it as a smooth line would imply a gradient between
  // being at a desk and being on a motorway.
  const path = useMemo(() => {
    if (!runs.length) return "";
    const y = (level: number) => (100 - level * 100).toFixed(2);
    const parts = [`M 0 100`, `L 0 ${y(runs[0]!.level)}`];
    for (const run of runs) {
      parts.push(`L ${run.start} ${y(run.level)}`, `L ${run.end} ${y(run.level)}`);
    }
    parts.push(`L ${MINUTES} 100`, "Z");
    return parts.join(" ");
  }, [runs]);

  const asleep = useMemo(() => runs.filter((run) => run.asleep), [runs]);
  const here = runAt(runs, minute);
  const share = (value: number) => (value / MINUTES) * 100;

  return (
    <div className="grid gap-[0.55rem]">
      <div className="flex flex-wrap items-baseline gap-x-[0.85rem] gap-y-1">
        <strong className="min-w-[4.2rem] text-[1.4rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {String(Math.floor(minute / 60)).padStart(2, "0")}:{String(minute % 60).padStart(2, "0")}
        </strong>
        {here ? (
          <span className="text-[0.85rem]">
            <strong className="font-semibold">{attentionBand(here.level, here.asleep)}</strong>
            <span className="text-muted-foreground">
              {" "}· {percent(here.level, 0)} · {elapsed((here.end - here.start) * 60)}
            </span>
          </span>
        ) : (
          <span className="text-[0.85rem] text-muted-foreground">—</span>
        )}
      </div>

      <div
        ref={trackRef}
        className={cn("relative cursor-pointer touch-none select-none", dragging && "cursor-grabbing")}
        role="slider"
        tabIndex={0}
        aria-label="Minute of the day"
        aria-valuemin={0}
        aria-valuemax={MINUTES - 1}
        aria-valuenow={minute}
        aria-valuetext={here
          ? `${stamp(minute * 60)}, ${attentionBand(here.level, here.asleep)}`
          : stamp(minute * 60)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 60 : 1;
          const moves: Record<string, number> = {
            ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
            PageDown: -60, PageUp: 60,
          };
          if (event.key in moves) {
            event.preventDefault();
            onScrub(Math.min(MINUTES - 1, Math.max(0, minute + moves[event.key]!)));
          }
        }}
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
        <svg className={PLOT} viewBox="0 0 1440 100" preserveAspectRatio="none" aria-hidden>
          <rect x="0" y="0" width={MINUTES} height="100" fill="var(--surface-sunken)" />
          {/* Sleep behind the curve, because during it the curve is exactly zero
              and there would otherwise be nothing on the figure to say why. */}
          {asleep.map((run) => (
            <rect
              key={`asleep-${run.start}`}
              x={run.start} y="0" width={Math.max(run.end - run.start, 1)} height="100"
              fill="var(--muted)"
            />
          ))}
          {[0.25, 0.5, 0.75].map((level) => (
            <line
              key={level}
              x1="0" x2={MINUTES} y1={100 - level * 100} y2={100 - level * 100}
              stroke="var(--grid-line)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          ))}
          {HOURS.slice(1, -1).map((hour) => (
            <line
              key={hour}
              x1={hour * 60} x2={hour * 60} y1="0" y2="100"
              stroke="var(--grid-line)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={path} fill="color-mix(in srgb, var(--chart-1) 34%, transparent)" />
          <path
            d={path} fill="none" stroke="var(--chart-1)" strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className={HEAD} style={{ left: `${share(minute)}%` }} />
      </div>

      <div className="relative h-[0.5rem]">
        {glances.map((glance, index) => (
          <button
            key={`${glance.at}-${index}`}
            type="button"
            className={glance.kind === "call" ? CALL_MARK : MARK}
            style={{
              left: `${share(Math.min(MINUTES, glance.at / 60))}%`,
              "--mark-color": channelColor(glance.channel),
            } as React.CSSProperties}
            title={`${stamp(glance.at)} · ${glance.label}`}
            aria-label={`${stamp(glance.at)}, ${glance.label}`}
            onClick={() => onScrub(Math.min(MINUTES - 1, Math.floor(glance.at / 60)))}
          />
        ))}
      </div>

      <div className={AXIS}>
        {HOURS.map((hour) => (
          <span key={hour} style={{ left: `${share(hour * 60)}%` }}>
            {String(hour).padStart(2, "0")}:00
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-[0.85rem] gap-y-[0.15rem] text-[0.8rem] text-muted-foreground">
        <span><Swatch color="var(--chart-1)" />glance probability</span>
        <span><Swatch color="var(--muted)" />asleep</span>
        <span>
          <Swatch color="var(--foreground)" style={{ transform: "rotate(45deg)" }} />
          message sent
        </span>
        <span>
          <Swatch color="var(--foreground)" className="rounded-full" />call placed
        </span>
      </div>
    </div>
  );
}

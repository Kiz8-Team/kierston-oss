"use client";

import { useCallback, useRef, useState } from "react";
import { KIND_COLOR, clockSeconds, metres, type ObservationResult, type TrackPoint } from "@/lib/cellular";
import { cn } from "@/lib/utils";

/**
 * Error over the day, on one scrubbable clock.
 *
 * The line is the fused track's distance from the truth and the band under it
 * the fused 95% radius, so the gap between them reads as calibration: a line
 * above its band is a confident miss. Each dot is one record read on its own,
 * coloured by what kind of row it is. The vertical scale is square-root, so a
 * 150 m fix and a 4 km anchor-cell guess both stay legible.
 */

const HEIGHT = 220;
const TICKS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function ErrorChart({ track, observations, minute, selected, onScrub, onSelect }: {
  track: TrackPoint[];
  observations: ObservationResult[];
  minute: number;
  selected: number | null;
  onScrub: (minute: number) => void;
  onSelect: (id: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const values = [
    ...track.flatMap((point) => [point.error ?? 0, point.r95]),
    ...observations.map((one) => one.single?.error ?? 0),
  ].sort((a, b) => a - b);
  const high = values[Math.floor(values.length * 0.97)] ?? 1000;
  const top = TICKS.find((tick) => tick >= high) ?? TICKS[TICKS.length - 1]!;
  const y = (value: number) => HEIGHT - Math.sqrt(Math.min(value, top) / top) * HEIGHT;
  const x = (m: number) => (m / 1440) * 1000;

  const line = track.filter((point) => point.error !== null)
    .map((point, i) => `${i ? "L" : "M"}${x(point.minute).toFixed(1)},${y(point.error!).toFixed(1)}`).join("");
  const band = track.length
    ? `M${x(track[0]!.minute)},${HEIGHT}`
      + track.map((point) => `L${x(point.minute).toFixed(1)},${y(point.r95).toFixed(1)}`).join("")
      + `L${x(track[track.length - 1]!.minute)},${HEIGHT}Z`
    : "";

  const scrubTo = useCallback((clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    onScrub(Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * 1439));
  }, [onScrub]);

  return (
    <div className="grid grid-cols-[3.5rem_1fr] gap-2">
      <div className="relative h-[220px] text-right text-[0.75rem] text-muted-foreground tabular-nums">
        {TICKS.filter((tick) => tick <= top).map((tick) => (
          <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: y(tick) }}>{metres(tick)}</span>
        ))}
      </div>
      <div>
        <div
          ref={boxRef}
          className={cn("relative h-[220px] touch-none select-none border-b border-l border-border", dragging ? "cursor-grabbing" : "cursor-crosshair")}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            scrubTo(event.clientX);
          }}
          onPointerMove={(event) => { if (dragging) scrubTo(event.clientX); }}
          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
          onPointerCancel={() => setDragging(false)}
        >
          <svg className="absolute inset-0 size-full" viewBox={`0 0 1000 ${HEIGHT}`} preserveAspectRatio="none" aria-hidden>
            {TICKS.filter((tick) => tick <= top).map((tick) => (
              <line key={tick} x1={0} x2={1000} y1={y(tick)} y2={y(tick)} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
            ))}
            <path d={band} fill="#f97316" fillOpacity={0.14} />
            <path d={line} fill="none" stroke="#f97316" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <line x1={x(minute)} x2={x(minute)} y1={0} y2={HEIGHT} stroke="var(--foreground)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
          {observations.map((one) => one.single?.error !== null && one.single ? (
            <button
              key={one.id}
              type="button"
              className={cn(
                "absolute size-[7px] -translate-1/2 rounded-full p-0 opacity-80 hover:opacity-100",
                selected === one.id && "size-[11px] opacity-100 ring-2 ring-foreground",
              )}
              style={{ left: `${(one.second / 86400) * 100}%`, top: y(one.single.error!), background: KIND_COLOR[one.kind] ?? "#8b9298" }}
              title={`${clockSeconds(one.second)} · ${one.kind} · error ${metres(one.single.error)} · 95% ${metres(one.single.r95)}`}
              aria-label={`${one.kind} at ${clockSeconds(one.second)}`}
              onClick={() => onSelect(one.id)}
            />
          ) : null)}
        </div>
        <div className="relative mt-1 h-4 text-[0.75rem] text-muted-foreground tabular-nums">
          {[0, 180, 360, 540, 720, 900, 1080, 1260, 1440].map((m) => (
            <span
              key={m}
              className={cn("absolute -translate-x-1/2", m === 0 && "translate-x-0", m === 1440 && "-translate-x-full")}
              style={{ left: `${(m / 1440) * 100}%` }}
            >
              {String(Math.floor(m / 60)).padStart(2, "0")}:00
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

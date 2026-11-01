"use client";

import { useCallback, useRef, useState } from "react";
import { RadioTower, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Block } from "@/components/console/Section";
import { Swatch } from "@/components/Charts";
import { DAY_END, DAY_START, clock, duration } from "@/lib/day-timeline";
import {
  CAUSE_LABEL, EVENT_COLOR, EVENT_LABEL, EXPOSURE_LABEL, REPORTED, SIGNALLING,
  carrierLine, cellDetail, layerColor, signalLabel, spanAt,
  type HandsetDay, type RadioDay,
} from "@/lib/radio";
import type { DayCell } from "@/lib/server/day";
import { cn } from "@/lib/utils";

/**
 * A bar segment. Written whole on one line: Tailwind scans raw source text, so
 * a class split across two string literals is never emitted and the segment
 * silently renders with no colour at all.
 */
// prettier-ignore
const SEGMENT = "absolute top-0 bottom-0 bg-[var(--segment-color)] shadow-[inset_1px_0_0_rgb(255_255_255/40%)]";

/** Connected minutes are hatched over the layer colour, not coloured apart. */
// prettier-ignore
const BEARER = "bg-[image:repeating-linear-gradient(115deg,var(--segment-color)_0_4px,color-mix(in_srgb,var(--segment-color)_58%,white)_4px_8px)]";

/**
 * An event mark under the bar. Unlike the timeline's payment marks these keep
 * their pointer events, so the tooltip naming the handover is reachable; a
 * press on one still bubbles to the track and starts a scrub.
 */
// prettier-ignore
const TICK = "absolute bottom-[-0.3rem] -ml-[0.17rem] size-[0.34rem] rotate-45 rounded-[1px] bg-[var(--mark-color)] shadow-[0_0_0_1.5px_var(--card)]";

// prettier-ignore
const HEAD = "pointer-events-none absolute top-[-0.25rem] bottom-[-0.25rem] -ml-px w-0.5 bg-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--card)_80%,transparent)]";

const ROW = "grid w-full grid-cols-[3.5rem_1fr_auto] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left leading-tight hover:bg-accent";

const LIST = "max-h-[17rem] overflow-auto grid list-none gap-0 p-0";

const share = (value: number) =>
  ((Math.min(DAY_END, Math.max(DAY_START, value)) - DAY_START) / (DAY_END - DAY_START)) * 100;

/**
 * Every handset this resident carries, and where each was on the network.
 *
 * Beside the schedule and the ledger rather than on a page of its own, because
 * the claim the cellular layer makes is that the three line up: the phone
 * hands over while the map says the car is moving, it sits on one cell for the
 * eight hours the schedule calls sleep, and it goes quiet at the minute the
 * battery dies. Clicking any row parks the day cursor on it.
 */
export function DayRadio({ radio, cursor, onSeek }: {
  radio: RadioDay;
  cursor: number;
  onSeek: (minute: number) => void;
}) {
  if (!radio.handsets.length) {
    return (
      <Block title={<span className="flex items-center gap-2"><RadioTower className="size-4" />Cellular</span>}>
        <p className="text-[0.85rem] text-muted-foreground">No subscription</p>
      </Block>
    );
  }

  return (
    <div className="grid gap-9">
      {radio.handsets.map((handset) => (
        <Handset
          key={handset.subscriber.index}
          handset={handset}
          cells={radio.cells}
          cursor={cursor}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}

function Handset({ handset, cells, cursor, onSeek }: {
  handset: HandsetDay;
  cells: Map<number, DayCell>;
  cursor: number;
  onSeek: (minute: number) => void;
}) {
  const { subscriber, spans, events } = handset;
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const now = spanAt(spans, cursor);
  const nowCell = now && now.cell !== null ? cells.get(now.cell) : undefined;
  // Bearer up and bearer down are true and are also fifty rows of "the phone
  // synced something". They are counted here and listed nowhere.
  const logged = events.filter((event) => SIGNALLING.has(event.kind));
  const reported = logged.filter((event) => REPORTED.has(event.kind)).length;

  const scrubTo = useCallback((clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const part = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onSeek(Math.round(DAY_START + part * (DAY_END - DAY_START)));
  }, [onSeek]);

  // Same keys as the timeline above, so a reader who learned the bar there does
  // not have to learn it again here.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 60 : 1;
    const moves: Record<string, number> = {
      ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      PageDown: -60, PageUp: 60,
    };
    if (event.key in moves) {
      event.preventDefault();
      onSeek(Math.min(DAY_END, Math.max(DAY_START, Math.round(cursor) + moves[event.key])));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onSeek(event.key === "Home" ? DAY_START : DAY_END);
    }
  };

  return (
    <Block
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Smartphone className="size-4" />
          {carrierLine(subscriber)}
          <Badge variant="secondary" className="px-1.5 py-0 text-[0.7rem]">{subscriber.operator}</Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-[0.7rem]">{subscriber.tier}</Badge>
        </span>
      }
      meta={`${handset.changes} serving-cell change${handset.changes === 1 ? "" : "s"} · `
        + `${handset.cells} cell${handset.cells === 1 ? "" : "s"} · `
        + `${handset.areas} tracking area${handset.areas === 1 ? "" : "s"} · `
        + `${duration(handset.connected)} connected`}
    >
      <p className="mt-0 mb-3 text-[0.78rem] text-muted-foreground tabular-nums">
        {[subscriber.msisdn, subscriber.imsi ? `IMSI ${subscriber.imsi}` : null,
          subscriber.imei ? `IMEI ${subscriber.imei}` : null]
          .filter(Boolean).join(" · ")}
      </p>

      {/* The day on one bar, on the same 00:00–24:00 scale as the timeline
          above it, so a handover can be read against the leg it happened on.
          Draggable in its own right: one cursor drives the whole page, so
          scrubbing here moves the schedule, the ledger and the map marker
          exactly as scrubbing up there moves this. */}
      <div
        ref={trackRef}
        className={cn(
          "relative mb-1 h-7 cursor-pointer touch-none select-none",
          dragging && "cursor-grabbing",
        )}
        role="slider"
        tabIndex={0}
        aria-label={`Time of day · ${subscriber.msisdn ?? "handset"}`}
        aria-valuemin={DAY_START}
        aria-valuemax={DAY_END}
        aria-valuenow={Math.round(cursor)}
        aria-valuetext={`${clock(cursor)}, ${nowCell?.band ?? "off the network"}`}
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
        <div className="absolute inset-0 overflow-hidden rounded-[var(--radius)] border border-border bg-muted">
          {spans.map((span, index) => {
            const cell = span.cell === null ? undefined : cells.get(span.cell);
            const color = layerColor(cell?.layer ?? null);
            return (
              <div
                key={`${span.start}-${index}`}
                className={cn(SEGMENT, span.connected > 0 && BEARER)}
                style={{
                  left: `${share(span.start)}%`,
                  width: `${Math.max(share(span.end) - share(span.start), 0.15)}%`,
                  "--segment-color": color,
                } as React.CSSProperties}
                title={`${clock(span.start)}–${clock(span.end)} · ${cell?.band ?? "unattached"} · ${signalLabel(span.rsrp)}`}
              />
            );
          })}
        </div>
        {logged.map((event, index) => (
          <div
            key={`${event.minute}-${index}`}
            className={TICK}
            style={{
              left: `${share(event.minute)}%`,
              "--mark-color": EVENT_COLOR[event.kind] ?? "#8a97a3",
            } as React.CSSProperties}
            title={`${clock(event.minute)} · ${EVENT_LABEL[event.kind] ?? event.kind} · ${CAUSE_LABEL[event.cause] ?? event.cause}`}
          />
        ))}
        <div className={HEAD} style={{ left: `${share(cursor)}%` }} />
      </div>

      <p className="mt-3 mb-4 text-[0.85rem] leading-[1.5] text-muted-foreground">
        <span className="font-semibold text-foreground tabular-nums">{clock(cursor)}</span>
        {" · "}
        {now === null ? "no record" : now.cell === null ? (
          <>off the network · {EXPOSURE_LABEL[now.exposure] ?? now.exposure}</>
        ) : (
          <>
            <Swatch color={layerColor(nowCell?.layer ?? null)} />
            {nowCell?.band ?? "unknown band"} · {signalLabel(now.rsrp)} ·{" "}
            {EXPOSURE_LABEL[now.exposure] ?? now.exposure}
            {now.connected > 0 ? ` · ${now.connected} min connected` : " · idle"}
            <span className="block tabular-nums">{cellDetail(nowCell)}</span>
          </>
        )}
      </p>

      <div className="grid grid-cols-2 gap-x-8 max-[60rem]:grid-cols-1">
        <div>
          <h4 className="m-0 mb-1.5 text-[0.8rem] font-semibold">Serving cells</h4>
          <ol className={LIST}>
            {spans.map((span, index) => {
              const cell = span.cell === null ? undefined : cells.get(span.cell);
              const active = cursor >= span.start && cursor < span.end;
              return (
                <li key={`${span.start}-${index}`} className="border-t border-border first:border-0">
                  <button
                    type="button"
                    className={cn(ROW, active && "bg-accent ring-1 ring-primary/30")}
                    onClick={() => onSeek(Math.min(DAY_END, Math.max(DAY_START, span.start)))}
                  >
                    <span className="text-[0.85rem] font-semibold tabular-nums">{clock(span.start)}</span>
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-1.5">
                        <Swatch className="shrink-0" color={layerColor(cell?.layer ?? null)} />
                        <strong className="truncate text-[0.88rem]">
                          {cell?.band ?? "Off the network"}
                        </strong>
                        {cell ? (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[0.7rem]">
                            TAC {cell.trackingArea}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-px block truncate text-[0.78rem] text-muted-foreground tabular-nums">
                        {cell?.cgi ?? "no serving cell"}
                        {" · "}
                        {EXPOSURE_LABEL[span.exposure] ?? span.exposure}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-[0.85rem] font-semibold tabular-nums">
                        {signalLabel(span.rsrp)}
                      </span>
                      <span className="mt-px block text-[0.78rem] text-muted-foreground tabular-nums">
                        {duration(span.end - span.start)}
                        {span.connected > 0 ? ` · ${span.connected} min up` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div>
          <h4 className="m-0 mb-1.5 text-[0.8rem] font-semibold">
            Signalling
            <span className="ml-2 font-normal text-muted-foreground tabular-nums">
              {reported} of {logged.length} reported
            </span>
          </h4>
          {logged.length ? (
            <ol className={LIST}>
              {logged.map((event, index) => {
                const cell = event.cell === null ? undefined : cells.get(event.cell);
                const previous = event.previous === null ? undefined : cells.get(event.previous);
                const active = Math.abs(cursor - event.minute) < 8;
                // An idle reselection happened and was reported to nobody. It
                // is listed because it is true and dimmed because it is not
                // evidence — the handset retuned on its own and the network
                // still holds only a tracking area for it.
                const seen = REPORTED.has(event.kind);
                return (
                  <li key={`${event.minute}-${index}`} className="border-t border-border first:border-0">
                    <button
                      type="button"
                      className={cn(ROW, !seen && "opacity-60", active && "bg-accent ring-1 ring-primary/30")}
                      onClick={() => onSeek(Math.min(DAY_END, Math.max(DAY_START, event.minute)))}
                    >
                      <span className="text-[0.85rem] font-semibold tabular-nums">{clock(event.minute)}</span>
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-1.5">
                          <Swatch
                            className="shrink-0"
                            color={EVENT_COLOR[event.kind] ?? "#8a97a3"}
                            style={{ transform: "rotate(45deg)" }}
                          />
                          <strong className="truncate text-[0.88rem]">
                            {EVENT_LABEL[event.kind] ?? event.kind}
                          </strong>
                          <Badge variant="outline" className="px-1.5 py-0 text-[0.7rem]">
                            {CAUSE_LABEL[event.cause] ?? event.cause}
                          </Badge>
                        </span>
                        <span className="mt-px block truncate text-[0.78rem] text-muted-foreground tabular-nums">
                          {previous ? `${previous.band} → ` : ""}
                          {cell?.band ?? "no cell"}
                          {cell ? ` · ${cell.cgi}` : ""}
                        </span>
                      </span>
                      <span className="text-right text-[0.78rem] text-muted-foreground tabular-nums">
                        {cell ? `TAC ${cell.trackingArea}` : ""}
                        {seen ? null : <span className="mt-px block">not reported</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-[0.85rem] text-muted-foreground">No signalling</p>
          )}
        </div>
      </div>
    </Block>
  );
}

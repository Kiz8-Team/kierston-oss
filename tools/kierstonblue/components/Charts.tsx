"use client";

import { num, percent } from "@/lib/format";
import type { Band } from "@/lib/summary";
import { cn } from "@/lib/utils";

/**
 * The three chart forms this app needs, in plain HTML.
 *
 * All are magnitude comparisons, so all are bars: one series in the sequential
 * hue for a plain distribution, two mirrored series for the age pyramid, where
 * the comparison between them is the point, and columns where the categories
 * are hours and their order is the reading.
 *
 * `BarList` and `Pyramid` carry their own values and need no hover layer.
 * `Columns` cannot — twenty-four labels do not fit across a card — so it puts
 * the value on the bar's title and names the peak in the caption beside it.
 */

/**
 * The legend dot, shared by every chart, map and timeline that names a colour.
 *
 * Sits on the baseline rather than centred on the line box, so a dot in a
 * sentence lines up with the text beside it.
 */
export function Swatch({
  color,
  className,
  style,
}: {
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "mr-[0.4rem] inline-block size-[0.5rem] rounded-[2px] align-baseline",
        className,
      )}
      style={{ background: color, ...style }}
    />
  );
}

/**
 * A single bar in its groove.
 *
 * Shared by the distribution charts and by the tie list, where two of them
 * stacked say how often a pair meet and how close they are. The groove is
 * drawn even at zero, so an absent value reads as a measured nothing rather
 * than as a missing row.
 */
export function Track({
  share,
  color,
  className,
}: {
  /** 0–1 of the groove to fill. */
  share: number;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block h-[0.62rem] overflow-hidden rounded-[4px] bg-[var(--grid-line)]",
        className,
      )}
      aria-hidden
    >
      <i
        className="block h-full rounded-[4px] bg-chart-1"
        style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%`, background: color }}
      />
    </span>
  );
}

export function BarList({ bands, total }: { bands: Band[]; total?: number }) {
  const sum = total ?? bands.reduce((acc, band) => acc + band.value, 0);
  const max = bands.reduce((acc, band) => Math.max(acc, band.value), 0) || 1;
  return (
    <div>
      {bands.map((band) => (
        <div
          className="mt-[0.3rem] grid grid-cols-[8.5rem_1fr_4rem] items-center gap-2 first-of-type:mt-0"
          key={band.label}
          title={`${num(band.value)} — ${percent(band.value / sum)}`}
        >
          <span className="text-[0.74rem] text-muted-foreground">{band.label}</span>
          <Track share={band.value / max} />
          <span className="text-right text-[0.72rem] tabular-nums">
            {percent(band.value / sum)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * One series across ordered buckets — the day's hours, so far.
 *
 * Ordinal and not categorical: the columns are in the only order they can be
 * in, and that order is what the reader is looking at. Ticks are labelled every
 * `every` columns rather than on all of them, because twenty-four legible
 * labels do not fit and a chart of the day only needs the quarters to orient.
 */
export function Columns({ bars, every = 6, label }: {
  bars: { label: string; value: number; title: string }[];
  every?: number;
  label?: (index: number) => string;
}) {
  const max = bars.reduce((acc, bar) => Math.max(acc, bar.value), 0) || 1;
  return (
    <div className="grid gap-[0.3rem]">
      {/* The 2px gap is the surface showing through rather than a border, so
          adjacent hours never read as one block. */}
      <div className="flex h-[5.5rem] items-end gap-[2px] border-b border-border">
        {bars.map((bar) => (
          <span
            key={bar.label}
            className="flex h-full min-w-0 flex-1 items-end"
            title={bar.title}
          >
            <i
              className="min-h-px w-full rounded-t-[4px] bg-chart-1"
              style={{ height: `${(bar.value / max) * 100}%` }}
            />
          </span>
        ))}
      </div>
      <div className="flex gap-[2px] text-[0.64rem] text-muted-foreground tabular-nums">
        {bars.map((bar, index) => (
          <span key={bar.label} className="min-w-0 flex-1">
            {index % every === 0 ? (label?.(index) ?? bar.label) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Pyramid({ rows }: { rows: { band: string; male: number; female: number }[] }) {
  const max = rows.reduce((acc, row) => Math.max(acc, row.male, row.female), 0) || 1;
  return (
    <>
      <div className="grid grid-cols-[1fr_3.4rem_1fr] items-center gap-x-[0.4rem] gap-y-[0.18rem]">
        {rows.map((row) => (
          <div key={row.band} className="contents">
            <span
              className="flex h-[0.68rem] justify-end"
              title={`${num(row.male)} male, ${row.band}`}
            >
              <i
                className="block h-full rounded-[3px] bg-chart-1"
                style={{ width: `${(row.male / max) * 100}%` }}
              />
            </span>
            <span className="text-center text-[0.7rem] text-muted-foreground tabular-nums">
              {row.band}
            </span>
            <span
              className="flex h-[0.68rem]"
              title={`${num(row.female)} female, ${row.band}`}
            >
              <i
                className="block h-full rounded-[3px] bg-chart-2"
                style={{ width: `${(row.female / max) * 100}%` }}
              />
            </span>
          </div>
        ))}
      </div>
      <ChartLegend>
        <span className="flex items-center gap-[0.3rem]">
          <i className="block size-[0.55rem] rounded-[2px] bg-chart-1" /> male
        </span>
        <span className="flex items-center gap-[0.3rem]">
          <i className="block size-[0.55rem] rounded-[2px] bg-chart-2" /> female
        </span>
      </ChartLegend>
    </>
  );
}

/** The row of colour keys under a chart. */
export function ChartLegend({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-[0.55rem] flex justify-center gap-4 text-[0.7rem] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

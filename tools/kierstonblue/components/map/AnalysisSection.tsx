"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import {
  CELL_SIZES, METRICS, SEQUENTIAL, type AreaGrid, type Metric, type MetricId, type Scale,
} from "@/lib/analysis";
import { num } from "@/lib/format";
import { PANEL_FIELD, PANEL_NOTE, RAMP, RAMP_LABELS } from "@/components/map/panel";

/**
 * The area layer's controls and legend.
 *
 * One metric is on screen at a time, so the encoding is sequential — a single
 * hue, light to dark — and the legend is the ramp itself with its end values.
 * Nothing here is coloured by identity, so there is no categorical legend to
 * keep in sync.
 */
export function AnalysisSection({
  enabled, onEnabled, metric, onMetric, size, onSize, opacity, onOpacity,
  grid, scale, status, onFly,
}: {
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  metric: Metric;
  onMetric: (id: MetricId) => void;
  size: number;
  onSize: (size: number) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  grid: AreaGrid | null;
  scale: Scale | null;
  status: string | null;
  onFly: (lat: number, lon: number) => void;
}) {
  const top = grid
    ? grid.cells
        .filter((cell) => Number.isFinite(metric.value(cell)))
        .sort((a, b) => metric.value(b) - metric.value(a))
        .slice(0, 5)
    : [];

  return (
    <fieldset>
      <legend>Area analysis</legend>
      <label
        className="flex min-h-6 cursor-pointer items-center gap-2 text-[0.78rem]"
        style={{ margin: ".5rem 0 .1rem" }}
      >
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => onEnabled(v === true)}
        />
        <span>Show area layer</span>
      </label>
      {status ? <p className={PANEL_NOTE}>{status}</p> : null}

      <label className={PANEL_FIELD}>
        <span>Measure</span>
        <NativeSelect
          value={metric.id}
          onChange={(event) => onMetric(event.target.value as MetricId)}
        >
          {METRICS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </NativeSelect>
      </label>

      <label className={PANEL_FIELD}>
        <span>Cell size</span>
        <NativeSelect
          value={size}
          onChange={(event) => onSize(Number(event.target.value))}
        >
          {CELL_SIZES.map((option) => (
            <option key={option} value={option}>{option} m</option>
          ))}
        </NativeSelect>
      </label>

      <label className={PANEL_FIELD}>
        <span>Opacity — {Math.round(opacity * 100)}%</span>
        <input
          type="range"
          min={20}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(event) => onOpacity(Number(event.target.value) / 100)}
        />
      </label>

      {scale ? (
        <>
          <div className={RAMP} aria-hidden>
            {SEQUENTIAL.map((color) => <i key={color} style={{ background: color }} />)}
          </div>
          <div className={RAMP_LABELS}>
            <span>{metric.tick(scale.min)}</span>
            <span className="text-muted-foreground">{metric.unit}</span>
            <span>{metric.tick(scale.max)}</span>
          </div>
        </>
      ) : null}

      {top.length ? (
        <>
          <p className="text-[0.68rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase" style={{ marginTop: ".7rem" }}>Highest cells</p>
          {top.map((cell) => (
            <Button
              key={cell.key}
              type="button"
              variant="outline"
              size="xs"
              className="mt-[0.22rem] flex w-full justify-between"
              onClick={() => onFly((cell.south + cell.north) / 2, (cell.west + cell.east) / 2)}
            >
              <span>{metric.format(metric.value(cell))}</span>
              <span className="text-muted-foreground">{num(cell.people)} people</span>
            </Button>
          ))}
        </>
      ) : null}
    </fieldset>
  );
}

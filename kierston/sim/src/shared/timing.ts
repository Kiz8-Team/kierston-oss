/**
 * Where a run's wall clock went.
 *
 * A stage is a name and a running total, nothing more. The point is not to
 * profile the engine — Bun's own profiler does that better and per function —
 * but to answer the one question a stage table answers and a profiler does
 * not: of the minutes an export takes, how many are spent in work that is per
 * person, and therefore how much of the run is worth handing to more than one
 * core.
 *
 * So the stages are cut along that seam rather than along the call graph. The
 * per-person loop is several stages because they parallelise differently — the
 * planner is pure, the settlement moves live balances, the comms layer
 * accumulates — while everything after it is a handful of stages because it
 * happens once and none of it is a candidate for anything.
 *
 * `add` is called a few hundred thousand times in a full export, so it does
 * the least it can: a map lookup and two additions. Timing at this resolution
 * costs well under a second of a run measured in minutes, which is the trade
 * being made — the numbers are for comparing stages against each other, not
 * for microbenchmarking any one of them.
 */
export class Timings {
  private readonly stages = new Map<string, { ms: number; calls: number }>();
  private readonly opened = performance.now();

  /** Record `ms` against a stage, creating it in first-seen order. */
  add(stage: string, ms: number): void {
    const held = this.stages.get(stage);
    if (held) {
      held.ms += ms;
      held.calls += 1;
      return;
    }
    this.stages.set(stage, { ms, calls: 1 });
  }

  /** The same, for a caller that already has the mark in hand. */
  since(stage: string, mark: number): number {
    const now = performance.now();
    this.add(stage, now - mark);
    return now;
  }

  /** Run `work`, charge it to `stage`, and hand back what it returned. */
  time<T>(stage: string, work: () => T): T {
    const mark = performance.now();
    try {
      return work();
    } finally {
      this.since(stage, mark);
    }
  }

  /** The same, awaited. */
  async timeAsync<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const mark = performance.now();
    try {
      return await work();
    } finally {
      this.since(stage, mark);
    }
  }

  /**
   * The table as plain data, so a worker can hand its own back.
   *
   * A parallel run has one of these per process, and the shares in the ones
   * from the workers are of that worker's CPU rather than of the run's wall
   * clock. `absorb` sums them into a table of their own for exactly that
   * reason — mixing them into the wall-clock table would produce a column of
   * percentages adding to three hundred.
   */
  snapshot(): Record<string, { ms: number; calls: number }> {
    const rows: Record<string, { ms: number; calls: number }> = {};
    for (const [stage, held] of this.stages) rows[stage] = { ms: held.ms, calls: held.calls };
    return rows;
  }

  /** Add another process's table to this one. */
  absorb(rows: Record<string, { ms: number; calls: number }>): void {
    for (const [stage, row] of Object.entries(rows)) {
      const held = this.stages.get(stage);
      if (held) {
        held.ms += row.ms;
        held.calls += row.calls;
      } else {
        this.stages.set(stage, { ms: row.ms, calls: row.calls });
      }
    }
  }

  /** Whether anything has been charged to this table at all. */
  get empty(): boolean {
    return this.stages.size === 0;
  }

  /** Everything charged so far, which for a summed table is not a wall clock. */
  get claimed(): number {
    let total = 0;
    for (const held of this.stages.values()) total += held.ms;
    return total;
  }

  /** Milliseconds since this table was opened. */
  get elapsed(): number {
    return performance.now() - this.opened;
  }

  /**
   * The table, longest stage first, with what nobody claimed.
   *
   * The remainder is reported rather than dropped because it is the figure
   * that says whether the stages are cut where the time actually is. A run
   * whose stages account for two thirds of its wall clock has a third of
   * itself somewhere nobody is looking.
   */
  format(total = this.elapsed, remainder = "unmeasured"): string {
    const rows = [...this.stages].map(([stage, held]) => ({
      stage, ms: held.ms, calls: held.calls,
    })).sort((a, b) => b.ms - a.ms);
    const claimed = rows.reduce((sum, row) => sum + row.ms, 0);
    if (remainder) rows.push({ stage: remainder, ms: Math.max(0, total - claimed), calls: 0 });

    const width = Math.max(...rows.map((row) => row.stage.length));
    const lines = rows.map((row) => {
      const share = total > 0 ? (row.ms / total) * 100 : 0;
      const per = row.calls > 1 ? `  ${(row.ms * 1000 / row.calls).toFixed(1)} µs × ${row.calls.toLocaleString()}` : "";
      return `  ${row.stage.padEnd(width)}  ${(row.ms / 1000).toFixed(1).padStart(7)} s  `
        + `${share.toFixed(1).padStart(5)}%  ${bar(share)}${per}`;
    });
    lines.push(`  ${"total".padEnd(width)}  ${(total / 1000).toFixed(1).padStart(7)} s`);
    return lines.join("\n");
  }
}

/** Twenty cells of proportion, so the table reads without arithmetic. */
function bar(share: number): string {
  const filled = Math.round((share / 100) * 20);
  return `${"█".repeat(filled)}${"·".repeat(20 - filled)}`;
}

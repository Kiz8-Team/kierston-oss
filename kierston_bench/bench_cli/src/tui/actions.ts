/**
 * The actions bound to letters: abort or rerun a task, stop or resume a run,
 * delete a run or a series.
 * Each asks first, does the thing, and says what happened — the same way from
 * whichever page it was pressed on.
 */

import { hostname } from "node:os";
import { abortTask } from "../abort-task.ts";
import { control, rerunTaskBackground, savedSpec } from "../background.ts";
import { deleteRun } from "../delete-run.ts";
import { deleteSeries } from "../delete-series.ts";
import type { RunSummary, SeriesSummary, TaskRow } from "../inventory.ts";
import { requireKdiService } from "../preflight.ts";
import type { Ctx } from "./page.ts";

const ACTIVE = new Set(["running", "pending"]);

export function abortSelectedTask(ctx: Ctx, runDir: string, task: TaskRow | null): void {
  if (!task) return;
  if (task.status !== "running") {
    ctx.say(`${task.id} is not running`, "info");
    return;
  }
  ctx.confirm(`Abort ${task.id}? Other tasks in the run will continue.`, async () => {
    try {
      await abortTask(runDir, task.id);
      ctx.say(`Aborted ${task.id}; other tasks continue`);
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

export function rerunSelectedTask(ctx: Ctx, run: RunSummary, task: TaskRow | null, after?: () => Promise<void>): void {
  if (!task) return;
  if (ACTIVE.has(task.status)) {
    ctx.say(`${task.id} is still ${task.status}; abort it before rerunning`, "info");
    return;
  }
  ctx.confirm(`Rerun ${task.id} in ${run.runId}? The previous attempt is kept and the run is rescored.`, async () => {
    try {
      await requireKdiService((await savedSpec(run.dir)).kdiServiceUrl);
      await rerunTaskBackground(run.dir, task.id);
      await after?.();
      ctx.say(`Rerunning ${task.id}; the run score updates when it finishes`);
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

/** Stop a run whoever started it: the runner this TUI spawned, or a managed worker. */
export function stopRun(ctx: Ctx, run: RunSummary): void {
  const live = ctx.liveFor(run.dir);
  if (live?.running()) {
    ctx.confirm(`Stop ${run.runId} and its containers?`, async () => {
      live.stop();
      ctx.say("stopping the run and its containers…", "busy");
    });
    return;
  }
  if (!run.manager) {
    ctx.say(run.state === "running" ? "this run was started elsewhere and has no local worker to stop" : `${run.runId} is not running`, "info");
    return;
  }
  if (run.manager.host !== hostname()) {
    ctx.say(`${run.runId} runs on ${run.manager.host}; stop it there`, "error");
    return;
  }
  ctx.confirm(`Stop ${run.runId} and its containers?`, async () => {
    try {
      await control(run.dir, "stop");
      ctx.say("Stop requested; the worker is cleaning up its containers");
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

export function resumeRun(ctx: Ctx, run: RunSummary): void {
  if (run.state === "running") {
    ctx.say(`${run.runId} is still running`, "info");
    return;
  }
  if (run.state === "complete" && !run.manager) {
    ctx.say(`${run.runId} finished; nothing to resume`, "info");
    return;
  }
  if (ctx.liveFor(run.dir)?.running()) {
    ctx.say(`${run.runId} is still running`, "info");
    return;
  }
  ctx.confirm(`Resume ${run.runId}, skipping tasks it already finished?`, async () => {
    try {
      await ctx.resumeRun(run);
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

/**
 * A run is deleted on its own; one still running has to be stopped first.
 * Its id and its name go with it, so the next run can take either.
 */
export function deleteSelectedRun(ctx: Ctx, run: RunSummary | null): void {
  if (!run) return;
  if (run.state === "running" || ctx.liveFor(run.dir)?.running()) {
    ctx.say(`${run.runId} is still running; stop it first`, "info");
    return;
  }
  const label = run.name ? `${run.name} (${run.runId})` : run.runId;
  ctx.confirm(`Delete run ${label} and its ${run.done + run.inFlight} task directory(s)? This cannot be undone; the series is kept.`, async () => {
    try {
      const deleted = await deleteRun(run);
      await ctx.reload();
      const logs = deleted.kdiLogs ? `, ${deleted.kdiLogs} KDI service log(s)` : "";
      ctx.say(`Deleted ${label}: ${deleted.tasks} task directory(s)${logs}`);
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

/** A series goes with its runs; one still running has to be stopped first. */
export function deleteSelectedSeries(ctx: Ctx, series: SeriesSummary | undefined): void {
  if (!series) return;
  const running = ctx.runs.filter((run) => run.series === series.id && (run.state === "running" || ctx.liveFor(run.dir)?.running()));
  if (running.length) {
    ctx.say(`${running.map((run) => run.runId).join(", ")} is still running from ${series.id}; stop it first`, "info");
    return;
  }
  const runs = series.runs ? `, its ${series.runs} run(s),` : "";
  ctx.confirm(`Delete series ${series.id}${runs} and the kdiffs only it staged? This cannot be undone.`, async () => {
    try {
      const deleted = await deleteSeries(series, ctx.series);
      await ctx.reload();
      const kept = deleted.shared ? `; kept ${deleted.shared} kdiff(s) another series uses` : "";
      const config = deleted.config ? ", its config" : "";
      ctx.say(`Deleted ${series.id}: ${deleted.runs} run(s), ${deleted.deltas} kdiff(s)${config}${kept}`);
    } catch (error) {
      ctx.say((error as Error).message, "error");
    }
  });
}

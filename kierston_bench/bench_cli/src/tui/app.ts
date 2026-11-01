/**
 * The interactive side of the bench CLI.
 *
 * Four home tabs — Runs, Series, New run, New series — and a stack of pages
 * opened from them. ←→ switch tabs while nothing is stacked, ⏎ opens, esc
 * goes back one level, and the letters are actions. A one-second heartbeat
 * re-reads the run directories, so a run started anywhere shows its progress,
 * and a run that finishes is scored where it stands.
 */

import { scoreRun } from "../../../scoring/src/score.ts";
import { assertSeriesUnchanged } from "../../../eval_runner/src/series-digest.ts";
import { resumeSpec, saveLaunch, startBackground } from "../background.ts";
import { requireKdiService } from "../preflight.ts";
import { dispatch, runDirFor, type Dispatch, type DispatchSpec } from "../dispatch.ts";
import { fit, paint } from "../format.ts";
import { findRun, listRuns, listSeries, type RunSummary, type SeriesSummary } from "../inventory.ts";
import { PATHS } from "../paths.ts";
import { shutdown } from "../shutdown.ts";
import { HelpPage } from "./pages/help.ts";
import { NewRunPage } from "./pages/new-run.ts";
import { NewSeriesPage } from "./pages/new-series.ts";
import { RunPage } from "./pages/run.ts";
import { RunsPage } from "./pages/runs.ts";
import { SeriesPage } from "./pages/series.ts";
import { NewSweepPage } from "./pages/new-sweep.ts";
import { SweepPage } from "./pages/sweep.ts";
import { SweepsPage } from "./pages/sweeps.ts";
import { pool, saveSweep, type Sweep } from "../sweep.ts";
import type { AppOptions, Ctx, HomeTab, NoteKind, Page } from "./page.ts";
import { SPINNER } from "./render.ts";
import { Screen, type Key } from "./screen.ts";
import { keyBar, message, tabs, titleBar } from "./widgets.ts";

export type { AppOptions } from "./page.ts";

const TABS: { id: HomeTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "series", label: "Series" },
  { id: "new-run", label: "New run" },
  { id: "new-series", label: "New series" },
  { id: "sweeps", label: "Sweeps" },
];

export async function runApp(options: AppOptions = {}): Promise<number> {
  return new App(options).start();
}

class App implements Ctx {
  private readonly screen = new Screen();
  runs: RunSummary[] = [];
  series: SeriesSummary[] = [];
  spin = 0;
  private readonly pages: Record<HomeTab, Page>;
  private readonly newRunPage: NewRunPage;
  private tab: HomeTab = "runs";
  private readonly stack: Page[] = [];
  private note: { text: string; kind: NoteKind } | null = null;
  private question: { text: string; act: () => Promise<void> } | null = null;
  /** Runners this TUI spawned, by run directory. */
  private readonly live = new Map<string, Dispatch>();
  /** Runs already scored, or attempted, this session: `dir@lastActivity`. */
  private readonly scoreAttempts = new Set<string>();
  private readonly scoreCounts = new Map<string, number>();
  private scoringNow: string | null = null;
  private ticking = false;
  private quitting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settle: ((code: number) => void) | null = null;
  private readonly onSignal = (name: NodeJS.Signals) => {
    void this.quit(name === "SIGHUP" ? 129 : name === "SIGTERM" ? 143 : 130, name === "SIGHUP");
  };

  constructor(readonly options: AppOptions) {
    this.newRunPage = new NewRunPage(this);
    this.pages = {
      runs: new RunsPage(this),
      series: new SeriesPage(this),
      "new-run": this.newRunPage,
      "new-series": new NewSeriesPage(this),
      sweeps: new SweepsPage(this),
    };
  }

  async start(): Promise<number> {
    await this.reload();
    this.screen.start();
    // A closed terminal or a kill still goes through quit, so nothing it
    // started is left behind.
    for (const name of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(name, this.onSignal);
    this.screen.onKey((key) => this.onKey(key));
    this.screen.onResizeTo(() => this.draw());
    if (this.options.run) await this.openRunByName(this.options.run);
    if (this.options.series) await this.newRun(this.options.series);
    await this.top.activate?.();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.draw();
    return new Promise<number>((settle) => {
      this.settle = settle;
    });
  }

  /** Stops everything this session started before the process exits; see shutdown.ts. */
  private async quit(code = 0, hungUp = false): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    if (this.timer) clearInterval(this.timer);
    const runners = [...this.live.values()].filter((run) => run.running());
    try {
      this.screen.stop();
      if (!hungUp && runners.length > 0) process.stderr.write(`stopping ${runners.map((run) => run.spec.runId).join(", ")} and its containers…\n`);
    } catch {
      // The terminal is gone; clean up regardless.
    }
    await this.reload().catch(() => {});
    const keepKdiService = this.runs.some((run) => run.manager !== undefined && run.state === "running");
    await shutdown({ runners, keepKdiService }).catch(() => {});
    this.settle?.(code);
  }

  private requestQuit(code = 0): void {
    const running = [...this.live.values()].filter((run) => run.running());
    if (running.length === 0) {
      void this.quit(code);
      return;
    }
    const names = running.map((run) => run.spec.runId).join(", ");
    this.confirm(`Quit and stop ${names}?`, async () => this.quit(code));
  }

  // -------------------------------------------------------------------------
  // Ctx
  // -------------------------------------------------------------------------

  private get top(): Page {
    return this.stack.at(-1) ?? this.pages[this.tab];
  }

  async reload(): Promise<void> {
    this.runs = await listRuns();
    this.series = await listSeries();
  }

  async push(page: Page): Promise<void> {
    this.stack.push(page);
    this.note = null;
    await page.activate?.();
    this.draw();
  }

  async pop(): Promise<void> {
    if (this.stack.length === 0) return;
    this.stack.pop();
    this.note = null;
    await this.top.activate?.();
    this.draw();
  }

  async home(tab: HomeTab): Promise<void> {
    this.stack.length = 0;
    this.tab = tab;
    this.note = null;
    await this.top.activate?.();
    this.draw();
  }

  say(text: string, kind: NoteKind = "info"): void {
    this.note = { text, kind };
    this.draw();
  }

  clear(): void {
    this.note = null;
  }

  confirm(text: string, act: () => Promise<void>): void {
    this.question = { text, act };
    this.draw();
  }

  scoring(dir: string): boolean {
    return this.scoringNow === dir;
  }

  liveFor(dir: string): Dispatch | null {
    return this.live.get(dir) ?? null;
  }

  async openRun(run: RunSummary, selection?: string[]): Promise<void> {
    await this.push(new RunPage(this, run, selection));
  }

  private async openRunByName(reference: string): Promise<void> {
    const run = await findRun(reference).catch((error: Error) => {
      this.say(error.message, "error");
      return null;
    });
    if (run) await this.openRun(run);
    else this.say(`no run called ${reference}`, "error");
  }

  async newRun(seriesId?: string): Promise<void> {
    await this.newRunPage.use(seriesId);
    await this.home("new-run");
  }

  async newSeries(): Promise<void> {
    await this.home("new-series");
  }

  async newSweep(preset?: { seriesId?: string; taskId?: string }): Promise<void> {
    await this.home("sweeps");
    await this.push(new NewSweepPage(this, preset));
  }

  async openSweep(sweep: Sweep): Promise<void> {
    await this.push(new SweepPage(this, sweep));
  }

  /**
   * Each run of the sweep is saved and dispatched as a normal run, `parallel`
   * at a time. Background runs all start at once.
   */
  async startSweep(sweep: Sweep, specs: DispatchSpec[], parallel: number, background: boolean): Promise<void> {
    await saveSweep(sweep);
    await this.home("sweeps");
    await this.openSweep(sweep);
    if (background) {
      let failed = 0;
      for (const spec of specs) {
        const record = await startBackground(spec);
        if (record.state === "failed") failed += 1;
      }
      await this.reload();
      this.say(failed ? `${failed} of ${specs.length} background runs failed to start` : `${specs.length} runs started in the background`, failed ? "error" : "info");
      return;
    }
    void pool(specs, parallel, async (spec) => {
      await saveLaunch(spec);
      const run = this.runHere(spec, true);
      await run.exited;
    }, () => this.quitting).then(() => {
      if (!this.quitting) this.say(`sweep ${sweep.id} finished`, "info");
    });
  }

  async startRun(spec: DispatchSpec, taskIds: string[], background: boolean): Promise<void> {
    const dir = runDirFor(spec);
    const summary: RunSummary = {
      series: spec.seriesId,
      runId: spec.runId,
      name: spec.name,
      dir,
      total: taskIds.length,
      done: 0,
      inFlight: 0,
      counts: {},
      state: "running",
      lastActivity: Date.now(),
    };
    if (background) {
      const record = await startBackground(spec);
      await this.reload();
      await this.home("runs");
      await this.openRun(summary, taskIds);
      this.say(record.state === "failed" ? `background run failed to start: ${record.error ?? "see worker.log"}` : `${spec.runId} started in the background (${record.backend})`, record.state === "failed" ? "error" : "info");
      return;
    }
    // Saved so the run can be resumed after an interrupt, or after this TUI exits.
    await saveLaunch(spec);
    this.runHere(spec);
    await this.home("runs");
    await this.openRun(summary, taskIds);
  }

  /** Pick up a stopped run in this TUI, skipping the tasks it already finished. */
  async resumeRun(run: RunSummary): Promise<void> {
    const spec = await resumeSpec(run.dir);
    await requireKdiService(spec.kdiServiceUrl);
    this.runHere(spec);
    await this.reload();
    this.say(`Resumed ${run.runId}`, "info");
  }

  private runHere(spec: DispatchSpec, quiet = false): Dispatch {
    const run = dispatch(spec, (event) => {
      if (event.kind === "exit") {
        if (this.quitting) return;
        if (event.code === 0) { if (!quiet) this.say(`${spec.runId} finished`, "info"); }
        else if (event.code === 130) this.say(`${spec.runId} stopped`, "info");
        else this.say(`${spec.runId}: runner exited with ${event.code}`, "error");
        // The next thing anyone wants from a run that just ended is its number.
        void this.reload().then(() => this.scoreWhatIsFinished());
      }
    });
    this.live.set(runDirFor(spec), run);
    return run;
  }

  /**
   * Score one run and fold the result back into what is on screen. Quiet
   * scoring is the heartbeat's: it never leaves an error on a screen the
   * user was not looking at.
   */
  async score(run: RunSummary, quiet: boolean): Promise<boolean> {
    if (this.scoringNow) {
      if (!quiet) this.say("another run is being scored", "busy");
      return false;
    }
    const seriesFile = this.series.find((entry) => entry.id === run.series)?.file;
    if (!seriesFile) {
      this.scoreAttempts.add(scoreKey(run));
      if (!quiet) this.say(`series ${run.series} is not in ${PATHS.runSeries}; nothing to score against`, "error");
      return false;
    }
    this.scoringNow = run.dir;
    this.scoreAttempts.add(scoreKey(run));
    this.scoreCounts.set(run.dir, (this.scoreCounts.get(run.dir) ?? 0) + 1);
    if (!quiet) this.say(`scoring ${run.series}/${run.runId}…`, "busy");
    this.draw();
    try {
      await assertSeriesUnchanged(run.dir, seriesFile);
      await scoreRun({ seriesFile, runDir: run.dir, simDataDir: this.options.simDataDir ?? PATHS.simData, writeInto: true });
      if (!quiet) this.note = null;
      await this.reload();
      return true;
    } catch (error) {
      if (!quiet) this.say(`scoring ${run.series}/${run.runId} failed: ${(error as Error).message}`, "error");
      return false;
    } finally {
      this.scoringNow = null;
      // The page showing this run picks the score up where it stands.
      await this.top.tick?.();
      this.draw();
    }
  }

  /**
   * A finished run scores itself, whoever started it; a run whose directory
   * has moved on since score.json was written is scored again. One at a time,
   * never twice for the same state, never more than a few times in a session.
   */
  private async scoreWhatIsFinished(): Promise<void> {
    if (this.scoringNow || this.options.autoScore === false) return;
    const stale = (run: RunSummary) => run.score === undefined || Date.parse(run.score.scoredAt) < run.lastActivity - 1000;
    const next = this.runs.find(
      (run) => run.state === "complete" && stale(run) && !this.scoreAttempts.has(scoreKey(run)) && (this.scoreCounts.get(run.dir) ?? 0) < 3,
    );
    if (next) await this.score(next, true);
  }

  // -------------------------------------------------------------------------
  // Heartbeat and keys
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.quitting || this.ticking) return;
    this.ticking = true;
    this.spin += 1;
    try {
      const page: Page = this.top;
      // Forms do not need the disk re-read under them every second.
      const liveList = page instanceof RunsPage || page instanceof SeriesPage || page instanceof RunPage || page instanceof SweepPage || page instanceof SweepsPage;
      if (liveList) await this.reload();
      await (this.top as Page).tick?.();
      void this.scoreWhatIsFinished();
    } finally {
      this.ticking = false;
      this.draw();
    }
  }

  private async onKey(key: Key): Promise<void> {
    if (this.quitting) return;
    if (key.ctrl && key.name === "c") {
      this.requestQuit(130);
      return;
    }
    if (this.question) {
      const question = this.question;
      const yes = key.name === "enter" || (key.name === "char" && (key.ch === "y" || key.ch === "Y"));
      this.question = null;
      if (yes) await question.act();
      else this.say("cancelled");
      this.draw();
      return;
    }
    const page = this.top;
    if (page.capturing?.()) {
      await page.onKey(key);
      this.draw();
      return;
    }
    if (await page.onKey(key)) {
      this.draw();
      return;
    }
    switch (key.name) {
      case "escape":
        if (this.stack.length > 0) await this.pop();
        else this.note = null;
        break;
      case "left":
      case "right":
        if (this.stack.length === 0) {
          const index = TABS.findIndex((entry) => entry.id === this.tab);
          const next = TABS[(index + (key.name === "left" ? -1 : 1) + TABS.length) % TABS.length]!;
          await this.home(next.id);
        }
        break;
      case "char":
        if (key.ch === "?") await this.push(new HelpPage(this));
        else if (key.ch === "q") {
          if (this.stack.length > 0) await this.pop();
          else this.requestQuit(0);
        }
        break;
      default:
        break;
    }
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  draw(): void {
    if (this.quitting) return;
    const columns = this.screen.columns;
    const rows = this.screen.rows;
    const page = this.top;
    const crumbs = ["Kierston Bench", TABS.find((entry) => entry.id === this.tab)!.label, ...this.stack.map((entry) => entry.title())];
    const body = page.body(columns, rows - 4);
    const lines = [
      titleBar(crumbs.join(" › "), `${page.right?.() ?? ""} `, columns),
      this.navLine(columns),
      ...body.map((line) => fit(line, columns)),
      ...Array.from({ length: Math.max(0, rows - 4 - body.length) }, () => ""),
      this.messageLine(columns),
      keyBar(page.hints(), columns),
    ];
    this.screen.render(lines);
  }

  private navLine(columns: number): string {
    if (this.stack.length === 0) return tabs(TABS, TABS.findIndex((entry) => entry.id === this.tab), columns);
    const path = ["Kierston Bench", TABS.find((entry) => entry.id === this.tab)!.label, ...this.stack.map((entry) => entry.title())];
    const back = path.at(-2)!;
    return fit(` ${paint("esc", "bold")} ${paint(`back to ${back}`, "grey")}`, columns);
  }

  private messageLine(columns: number): string {
    if (this.question) return message(`${this.question.text}  [y/n]`, "error", columns);
    if (!this.note) return fit("", columns);
    const text = this.note.kind === "busy" ? `${SPINNER[this.spin % SPINNER.length]} ${this.note.text}` : this.note.text;
    return message(text, this.note.kind, columns);
  }
}

/** One run in one state: scoring the same state twice would be wasted work. */
function scoreKey(run: RunSummary): string {
  return `${run.dir}@${run.lastActivity}`;
}

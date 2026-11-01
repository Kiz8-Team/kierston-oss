/**
 * What a screen is, and what it may ask of the app around it.
 *
 * The TUI is a stack of pages over four home tabs. Arrows move within a page,
 * ⏎ opens, esc goes back one level, ←→ switch tabs while no page is stacked.
 * Letters are reserved for actions — abort, rerun, score, stop — never for
 * getting somewhere.
 */

import type { Key } from "./screen.ts";
import type { RunSummary, SeriesSummary } from "../inventory.ts";
import type { Dispatch, DispatchSpec } from "../dispatch.ts";
import type { Sweep } from "../sweep.ts";

export type Hint = [string, string];
export type NoteKind = "info" | "error" | "busy";
export type HomeTab = "runs" | "series" | "new-run" | "new-series" | "sweeps";

export interface Page {
  /** The crumb this page adds to the title bar. */
  title(): string;
  /** The right-hand corner of the title bar. */
  right?(): string;
  hints(): Hint[];
  body(columns: number, height: number): string[];
  /** Handle a key; return true when it was consumed. */
  onKey(key: Key): Promise<boolean> | boolean;
  /** Called whenever the page becomes the one on screen. */
  activate?(): Promise<void> | void;
  /** Called once a second while the page is on screen. */
  tick?(): Promise<void> | void;
  /** True while the page owns every key, such as while a field is being typed into. */
  capturing?(): boolean;
}

export interface AppOptions {
  simDataDir?: string;
  /** Score finished runs without being asked. On by default. */
  autoScore?: boolean;
  /** Open straight into this run. */
  run?: string;
  /** Open the new-run form for this series id or file. */
  series?: string;
  /** Run settings given as flags; the new-run form starts from these instead of the defaults. */
  launch?: Partial<DispatchSpec>;
  /** Let preflight pass databases that take a login without a password. */
  allowOpenDb?: boolean;
}

/** What every page can see and do. */
export interface Ctx {
  readonly options: AppOptions;
  readonly runs: RunSummary[];
  readonly series: SeriesSummary[];
  /** Advances once a second; drives spinners. */
  readonly spin: number;
  /** Re-list runs and series from disk. */
  reload(): Promise<void>;
  push(page: Page): Promise<void>;
  pop(): Promise<void>;
  /** Drop the stack and show a home tab. */
  home(tab: HomeTab): Promise<void>;
  say(text: string, kind?: NoteKind): void;
  clear(): void;
  confirm(text: string, act: () => Promise<void>): void;
  draw(): void;
  /** Score one run and fold the result into what is on screen. */
  score(run: RunSummary, quiet: boolean): Promise<boolean>;
  scoring(dir: string): boolean;
  /** The runner this TUI started for a run directory, if any. */
  liveFor(dir: string): Dispatch | null;
  /** Start a run and open its screen; the stack collapses to Runs › run. */
  startRun(spec: DispatchSpec, taskIds: string[], background: boolean): Promise<void>;
  /** Resume a stopped run in this TUI, skipping the tasks it already finished. */
  resumeRun(run: RunSummary): Promise<void>;
  openRun(run: RunSummary, selection?: string[]): Promise<void>;
  /** Show the new-run tab, preset to a series. */
  newRun(seriesId?: string): Promise<void>;
  newSeries(): Promise<void>;
  /** Start every run of a sweep, `parallel` at a time, and open its screen. */
  startSweep(sweep: Sweep, specs: DispatchSpec[], parallel: number, background: boolean): Promise<void>;
  openSweep(sweep: Sweep): Promise<void>;
  /** Show the new-sweep form, preset to a series task where one is given. */
  newSweep(preset?: { seriesId?: string; taskId?: string }): Promise<void>;
}

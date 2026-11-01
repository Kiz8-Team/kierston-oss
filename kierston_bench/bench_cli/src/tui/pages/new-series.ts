/**
 * The series builder: a fixed task set with hidden ground truth, drawn from
 * every exported day by default. RTI and DT families bring the scenarios that
 * stage them into the config. Generating it writes the prep config, runs
 * the series builder, and moves on to the new-run form for the result.
 */

import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { TASK_GROUPS, taskGroupOf } from "../../../../task_generators/src/index.ts";
import { fit, paint } from "../../format.ts";
import { generateSeries, type SeriesProgress } from "../../dispatch.ts";
import { PATHS } from "../../paths.ts";
import { SERIES_FAMILIES as FAMILIES, scenariosFor, seriesToml } from "../../series-config.ts";
import { familyLabel } from "../../task-selection.ts";
import { Form, type FormRow } from "../form.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { PickPage } from "./pick.ts";

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How many of the newest log lines the progress panel keeps; it shows as many as fit. */
const LOG_TAIL = 60;

function dayLabel(file: string): string {
  return basename(file).replace(/^day_|\.bin$/g, "");
}

export class NewSeriesPage implements Page {
  private id = "";
  private seed = 42;
  private availableDays: string[] = [];
  private readonly days = new Set<string>();
  private readonly families = new Set<string>(FAMILIES);
  private copies = 3;
  private attempts = 8;
  private generating = false;
  private progress: SeriesProgress | null = null;
  private started = 0;
  /** When the current phase began; the time left is estimated from it. */
  private phaseStarted = 0;
  /** When the runner's current step began, and the step it was (its text before any ` · n/m done` counter). */
  private stepStarted = 0;
  private stepKey = "";
  /** The newest lines the series prep logged. */
  private log: string[] = [];
  private loaded = false;
  private readonly form = new Form(() => this.rows());

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "New series";
  }

  right(): string {
    return `${this.days.size} day(s) · ${this.families.size} families`;
  }

  hints(): Hint[] {
    return [["↑↓", "field"], ["⏎", "edit / open / press"], ["←→", "tabs"], ["?", "keys"]];
  }

  capturing(): boolean {
    return this.form.capturing();
  }

  async activate(): Promise<void> {
    const entries = await readdir(PATHS.simOutputs).catch(() => []);
    this.availableDays = entries.filter((name) => /^day_.+\.bin$/.test(name)).sort().map((name) => `kierston/sim_outputs/${name}`);
    if (!this.loaded) {
      // Every exported day, unless told otherwise: a series is meant to span
      // the city's whole record, not one day of it.
      for (const day of this.availableDays) this.days.add(day);
      this.id = this.freshId();
      this.loaded = true;
    }
  }

  private freshId(): string {
    const stem = `series-${new Date().toISOString().slice(0, 10)}`;
    const taken = new Set(this.ctx.series.map((series) => series.id));
    if (!taken.has(stem)) return stem;
    for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  }

  private rows(): FormRow[] {
    const number = (label: string, get: () => number, set: (value: number) => void, minimum: number): FormRow => ({
      label,
      kind: "number",
      value: () => String(get()),
      set: (text) => {
        const parsed = Number(text.trim());
        if (Number.isInteger(parsed) && parsed >= minimum) set(parsed);
      },
    });
    return [
      {
        label: "Series id",
        kind: "text",
        value: () => this.id,
        set: (text) => {
          this.id = text.trim();
        },
      },
      number("Seed", () => this.seed, (value) => (this.seed = value), 0),
      {
        label: "Days",
        kind: "choose",
        value: () => {
          const chosen = this.availableDays.filter((day) => this.days.has(day));
          if (chosen.length === 0) return paint("none", "yellow");
          if (chosen.length === this.availableDays.length) return `all ${chosen.length}  ${paint(chosen.map(dayLabel).join(", "), "grey")}`;
          return `${chosen.length} of ${this.availableDays.length}  ${paint(chosen.map(dayLabel).join(", "), "grey")}`;
        },
        act: () =>
          this.ctx.push(
            new PickPage(
              this.ctx,
              "Days",
              this.availableDays.map((day) => ({ value: day, label: dayLabel(day), detail: day })),
              ["day", "export file"],
              { multi: true, selected: this.days },
            ),
          ),
      },
      {
        label: "Families",
        kind: "choose",
        value: () => {
          const head = this.families.size === FAMILIES.length ? `all ${FAMILIES.length}` : `${this.families.size} of ${FAMILIES.length}`;
          const byGroup = TASK_GROUPS.map((group) => {
            const chosen = group.generators.filter((generator) => this.families.has(generator.family)).length;
            return `${group.abbreviation} ${chosen}`;
          });
          return `${head}  ${paint(byGroup.join(" · "), "grey")}`;
        },
        act: () =>
          this.ctx.push(
            new PickPage(
              this.ctx,
              "Families",
              FAMILIES.map((family) => ({
                value: family,
                label: familyLabel(family),
                detail: `${(taskGroupOf(family)?.abbreviation ?? "").padEnd(4)}${family}`,
              })),
              ["task family", "group · generator id"],
              { multi: true, selected: this.families },
            ),
          ),
      },
      {
        label: "Copies",
        kind: "number",
        value: () => String(this.copies),
        detail: () => {
          const scenarios = scenariosFor(this.families).length;
          if (scenarios === 0) return "";
          return `× ${scenarios} scenario(s) × ${this.days.size} day(s) = ${this.copies * scenarios * this.days.size} kdiffs`;
        },
        set: (text) => {
          const parsed = Number(text.trim());
          if (Number.isInteger(parsed) && parsed >= 1) this.copies = parsed;
        },
      },
      number("Attempts", () => this.attempts, (value) => (this.attempts = value), 1),
      { label: "Generate series", kind: "button", act: () => this.generate() },
    ];
  }

  private async generate(): Promise<void> {
    if (this.generating) return;
    if (!/^[A-Za-z0-9._-]+$/.test(this.id)) {
      this.ctx.say("series id may contain only letters, digits, '.', '_' and '-'", "error");
      return;
    }
    if (this.days.size === 0 || this.families.size === 0) {
      this.ctx.say("choose at least one day and one task family", "error");
      return;
    }
    const configFile = join(PATHS.seriesConfigs, `${this.id}.toml`);
    const seriesFile = join(PATHS.runSeries, `run_series_${this.id}_tasks_data.json`);
    if ((await Bun.file(configFile).exists()) || (await Bun.file(seriesFile).exists())) {
      this.ctx.say(`series ${this.id} already exists; choose another id`, "error");
      return;
    }
    const days = this.availableDays.filter((day) => this.days.has(day));
    const toml = seriesToml({
      id: this.id, seed: this.seed, days, families: this.families,
      copies: this.copies, attempts: this.attempts,
    });
    this.generating = true;
    this.progress = null;
    this.log = [];
    this.started = Date.now();
    this.phaseStarted = Date.now();
    this.stepStarted = Date.now();
    this.stepKey = "";
    try {
      await Bun.write(configFile, toml);
      this.showProgress();
      const result = await generateSeries(configFile, false, (progress) => {
        if (progress.phase !== this.progress?.phase) this.phaseStarted = Date.now();
        const stepKey = `${progress.current}|${(progress.step ?? "").split(" · ")[0]}`;
        if (stepKey !== this.stepKey) {
          this.stepKey = stepKey;
          this.stepStarted = Date.now();
        }
        this.progress = progress;
        this.showProgress();
      }, (line) => {
        this.log = [...this.log, line.trim()].slice(-LOG_TAIL);
        this.ctx.draw();
      });
      if (!result.ok) {
        await unlink(configFile).catch(() => {});
        this.ctx.say(result.output.split("\n").filter(Boolean).at(-1) || `could not generate ${this.id}`, "error");
        return;
      }
      await this.ctx.reload();
      const made = this.id;
      this.loaded = false;
      this.ctx.clear();
      await this.ctx.newRun(made);
      this.ctx.say(`series ${made} generated`);
    } finally {
      this.generating = false;
      this.progress = null;
    }
  }

  /** The heartbeat keeps the elapsed time moving through a step that takes minutes. */
  tick(): void {
    if (this.generating) this.showProgress();
  }

  /** The message line stays short; the body carries the detail while generating. */
  private showProgress(): void {
    const elapsed = duration(Date.now() - this.started);
    const progress = this.progress;
    const where = !progress ? "starting"
      : progress.phase === "days" ? `reading day ${progress.done + 1}/${progress.total}`
      : `kdiff ${Math.min(progress.done + progress.short + 1, progress.total)}/${progress.total}`;
    this.ctx.say(`generating ${this.id} · ${where} · ${elapsed}`, "busy");
  }

  /**
   * One line per fact, so nothing is clipped: which phase, which kdiff, what
   * the runner is doing right now and for how long, then the newest log lines
   * so a refused seed shows its reason as it happens.
   */
  private progressLines(columns: number, height: number): string[] {
    const now = Date.now();
    const progress = this.progress;
    const row = (label: string, text: string, dim = false) =>
      fit(` ${fit(paint(label, "bold"), 12)}  ${dim ? paint(text, "grey") : text}`, columns);
    const lines: string[] = [row("Series", `${this.id} · running ${duration(now - this.started)}`)];
    if (!progress) {
      lines.push(row("Phase", "starting the series prep…"));
    } else if (progress.phase === "days") {
      lines.push(row("Phase", `base days · ${progress.done + 1} of ${progress.total}`));
      lines.push(row("Reading", progress.current));
      lines.push(row("Step", `generating plain families · ${duration(now - this.stepStarted)} elapsed`));
    } else {
      const settled = progress.done + progress.short;
      const phaseElapsed = now - this.phaseStarted;
      const left = settled > 0 ? `about ${duration((phaseElapsed / settled) * (progress.total - settled))} left` : "no estimate before the first kdiff";
      const counts = [`${progress.done} staged`,
        progress.refused ? `${progress.refused} seed${progress.refused === 1 ? "" : "s"} refused` : "",
        progress.short ? `${progress.short} short` : ""].filter(Boolean).join(", ");
      lines.push(row("Phase", `scenario kdiffs · ${Math.min(settled + 1, progress.total)} of ${progress.total} · ${left}`));
      lines.push(row("So far", counts));
      lines.push(row("Staging", progress.current));
      const step = progress.step ?? "waiting for the scenario runner to start";
      lines.push(row("Step", `${step} · ${duration(now - this.stepStarted)} elapsed`));
    }
    if (this.log.length) {
      lines.push(fit("", columns));
      lines.push(row("Log", "newest last", true));
      for (const line of this.log.slice(-(height - lines.length))) lines.push(fit(`               ${paint(line, "grey")}`, columns));
    }
    return lines.slice(0, height);
  }

  async onKey(key: Key): Promise<boolean> {
    // The form is frozen while its series is being built.
    if (this.generating) return true;
    return this.form.onKey(key);
  }

  body(columns: number, height: number): string[] {
    if (this.generating) return this.progressLines(columns, height);
    return this.form.lines(columns, height);
  }
}

/**
 * The new-sweep form: one task and a list of models. Task from a series, or
 * generated from family, day and seed. Models typed comma-separated or ticked
 * from models earlier runs used. Start makes one run per model.
 */

import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { RunSeriesData } from "../../../../run_series_prep/src/series.ts";
import { fit, paint } from "../../format.ts";
import { commandLine, defaultSpec, type DispatchSpec } from "../../dispatch.ts";
import { DEFAULTS, PATHS } from "../../paths.ts";
import { preflight, kdiServiceProbeUrl, type Check } from "../../preflight.ts";
import { SERIES_FAMILIES, isStagedFamily } from "../../series-config.ts";
import { generateTask, ignoresModel, knownModels, newSweep, parseModels, sweepSpecs, SWEEP_ID, defaultSweepId } from "../../sweep.ts";
import { familyLabel } from "../../task-selection.ts";
import { Form, type FormRow } from "../form.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { checkLine, spinner } from "../render.ts";
import type { Key } from "../screen.ts";
import { wrap } from "../widgets.ts";
import { PickPage } from "./pick.ts";

type Source = "series" | "generate";

function dayLabel(file: string): string {
  return basename(file).replace(/^day_|\.bin$/g, "");
}

export class NewSweepPage implements Page {
  private source: Source = "series";
  private seriesId = "";
  private taskId = "";
  private family = SERIES_FAMILIES.find((family) => !isStagedFamily(family)) ?? "";
  private day = "";
  private days: string[] = [];
  private seed = 1;
  /** Insertion-ordered; the checklist edits it in place, the text row rewrites it. */
  private readonly models = new Set<string>();
  private known: string[] = [];
  private parallel = 1;
  private sweepId = defaultSweepId();
  private readonly spec: DispatchSpec;
  private checks: Check[] = [];
  private checking = false;
  private starting = false;
  private log: string[] = [];
  private readonly form = new Form(() => this.rows());

  constructor(private readonly ctx: Ctx, preset?: { seriesId?: string; taskId?: string }) {
    this.spec = defaultSpec("", "");
    // Flags preset the runs; per-run fields (model, run id, name, task selection) are left out.
    const { model: _model, runId: _runId, name: _name, taskIds: _tasks, families: _families, ...launch } = ctx.options.launch ?? {};
    Object.assign(this.spec, launch);
    if (preset?.seriesId) this.seriesId = preset.seriesId;
    if (preset?.taskId) this.taskId = preset.taskId;
  }

  title(): string {
    return "New sweep";
  }

  right(): string {
    return `${this.models.size} model(s)`;
  }

  hints(): Hint[] {
    return [["↑↓", "field"], ["⏎", "edit / open / press"], ["r", "recheck"], ["esc", "back"]];
  }

  capturing(): boolean {
    return this.form.capturing();
  }

  async activate(): Promise<void> {
    if (!this.seriesId && this.ctx.series[0]) this.seriesId = this.ctx.series[0].id;
    const entries = await readdir(PATHS.simOutputs).catch(() => []);
    this.days = entries.filter((name) => /^day_.+\.bin$/.test(name)).sort().map((name) => `kierston/sim_outputs/${name}`);
    if (!this.day && this.days[0]) this.day = this.days[0];
    if (this.known.length === 0) this.known = await knownModels();
    if (this.checks.length === 0 && !this.checking) void this.prepare();
  }

  private get series() {
    return this.ctx.series.find((entry) => entry.id === this.seriesId) ?? null;
  }

  private rows(): FormRow[] {
    const spec = this.spec;
    const text = (label: string, name: keyof DispatchSpec, changed?: () => void): FormRow => ({
      label,
      kind: "text",
      value: () => (spec[name] === undefined ? "" : String(spec[name])),
      set: (value) => {
        const trimmed = value.trim();
        (spec as unknown as Record<string, unknown>)[name] = trimmed === "" ? undefined : trimmed;
      },
      changed,
    });
    const recheck = () => void this.prepare();
    const task: FormRow[] = this.source === "series"
      ? [
          {
            label: "Series",
            kind: "choose",
            value: () => this.seriesId || paint("none", "yellow"),
            detail: () => (this.series ? `${this.series.taskCount} tasks · ${this.series.days.map((day) => day.date).join(", ")}` : ""),
            act: () =>
              this.ctx.push(
                new PickPage(
                  this.ctx,
                  "Series",
                  this.ctx.series.map((series) => ({ value: series.id, label: series.id, detail: `${series.taskCount} tasks · ${series.families.length} families` })),
                  ["series", "contents"],
                  { multi: false, current: this.seriesId, onPick: (id) => { if (id !== this.seriesId) this.taskId = ""; this.seriesId = id; } },
                ),
              ),
          },
          {
            label: "Task",
            kind: "choose",
            value: () => this.taskId || paint("choose one", "yellow"),
            act: () => this.pickTask(),
          },
        ]
      : [
          {
            label: "Family",
            kind: "choose",
            value: () => `${familyLabel(this.family)}  ${paint(this.family, "grey")}`,
            act: () =>
              this.ctx.push(
                new PickPage(
                  this.ctx,
                  "Family",
                  SERIES_FAMILIES.filter((family) => !isStagedFamily(family)).map((family) => ({ value: family, label: familyLabel(family), detail: family })),
                  ["task family", "generator id"],
                  { multi: false, current: this.family, onPick: (family) => { this.family = family; } },
                ),
              ),
          },
          {
            label: "Day",
            kind: "choose",
            value: () => (this.day ? dayLabel(this.day) : paint("none", "yellow")),
            detail: () => this.day,
            act: () =>
              this.ctx.push(
                new PickPage(
                  this.ctx,
                  "Day",
                  this.days.map((day) => ({ value: day, label: dayLabel(day), detail: day })),
                  ["day", "export file"],
                  { multi: false, current: this.day, onPick: (day) => { this.day = day; } },
                ),
              ),
          },
          {
            label: "Seed",
            kind: "number",
            value: () => String(this.seed),
            detail: () => "same family, day and seed = same task",
            set: (value) => {
              const parsed = Number(value.trim());
              if (Number.isInteger(parsed) && parsed >= 0) this.seed = parsed;
            },
          },
        ];
    return [
      {
        label: "Task from",
        kind: "toggle",
        value: () => (this.source === "series" ? "a series" : "a generator"),
        detail: () => (this.source === "series" ? "⏎ to generate one instead" : "⏎ to pick one from a series"),
        toggle: () => {
          this.source = this.source === "series" ? "generate" : "series";
        },
      },
      ...task,
      {
        label: "Models",
        kind: "text",
        value: () => [...this.models].join(", "),
        detail: () => (this.models.size ? "" : "comma-separated, as pi names them"),
        set: (value) => {
          this.models.clear();
          for (const model of parseModels([value])) this.models.add(model);
        },
      },
      {
        label: "Known models",
        kind: "choose",
        value: () => (this.known.length ? `${this.known.length} from earlier runs` : paint("none yet", "grey")),
        act: () =>
          this.ctx.push(
            new PickPage(
              this.ctx,
              "Models",
              [...new Set([...this.known, ...this.models])].map((model) => ({ value: model, label: model })),
              ["model", ""],
              { multi: true, selected: this.models },
            ),
          ),
      },
      {
        label: "Parallel",
        kind: "number",
        value: () => String(this.parallel),
        detail: () => "models running at once",
        set: (value) => {
          this.parallel = Math.max(1, Number(value.trim()) || 1);
        },
      },
      text("Image", "image", () => {
        if (!spec.image) spec.image = DEFAULTS.image;
        recheck();
      }),
      {
        label: "Deadline",
        kind: "number",
        value: () => (spec.deadlineMinutes > 0 ? String(spec.deadlineMinutes) : "none"),
        detail: () => (spec.deadlineMinutes > 0 ? "minutes per task" : "0 = no deadline"),
        set: (value) => {
          const minutes = Number(value.trim());
          spec.deadlineMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
        },
      },
      {
        label: "Env",
        kind: "list",
        value: () => spec.env.join(", "),
        detail: () => (spec.env.length ? "" : "NAME or NAME=VALUE, comma-separated"),
        set: (value) => {
          spec.env = parseModels([value]);
        },
        changed: recheck,
      },
      {
        label: "Sweep id",
        kind: "text",
        value: () => this.sweepId,
        set: (value) => {
          this.sweepId = value.trim() || defaultSweepId();
        },
      },
      { label: "Start sweep", kind: "button", act: () => this.start(false) },
      { label: "Start in background", kind: "button", act: () => this.start(true) },
    ];
  }

  private async pickTask(): Promise<void> {
    const series = this.series;
    if (!series) {
      this.ctx.say("choose a series first", "error");
      return;
    }
    const data = await Bun.file(series.file).json().catch(() => null) as RunSeriesData | null;
    if (!data?.tasks?.length) {
      this.ctx.say(`cannot read tasks from ${series.file}`, "error");
      return;
    }
    await this.ctx.push(
      new PickPage(
        this.ctx,
        "Task",
        data.tasks.map((task) => ({ value: task.id, label: task.id, detail: `${familyLabel(task.family)} · ${task.date}` })),
        ["task", "family · day"],
        { multi: false, current: this.taskId, onPick: (id) => { this.taskId = id; } },
      ),
    );
  }

  private async prepare(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.checks = await preflight({
        image: this.spec.image,
        kdiServiceProbeUrl: kdiServiceProbeUrl(this.spec.kdiServiceUrl),
        startKdiService: true,
        env: this.spec.env,
        agentDir: this.spec.agentDir,
        allowOpenDb: this.ctx.options.allowOpenDb,
        onCheck: (_check, soFar) => {
          this.checks = [...soFar];
          this.ctx.draw();
        },
      });
    } finally {
      this.checking = false;
      this.ctx.draw();
    }
  }

  private async start(background: boolean, force = false): Promise<void> {
    if (this.starting) return;
    const models = [...this.models];
    if (models.length === 0) {
      this.ctx.say("name at least one model", "error");
      return;
    }
    if (!SWEEP_ID.test(this.sweepId)) {
      this.ctx.say("sweep id may contain only letters, digits, '.', '_' and '-'", "error");
      return;
    }
    if (this.source === "series" && (!this.series || !this.taskId)) {
      this.ctx.say("choose a series and one task of it", "error");
      return;
    }
    if (this.source === "generate" && (!this.family || !this.day)) {
      this.ctx.say("choose a family and a day", "error");
      return;
    }
    this.starting = true;
    try {
      if (!force) {
        this.ctx.say("running preflight checks…", "busy");
        await this.prepare();
        const blocking = this.checks.filter((check) => !check.ok && !check.advisory);
        if (blocking.length > 0) {
          this.ctx.clear();
          this.ctx.confirm(`${blocking.map((check) => check.name).join(", ")} not ready. Start anyway?`, () => this.start(background, true));
          return;
        }
      }
      let seriesId: string;
      let seriesFile: string;
      let taskId: string;
      if (this.source === "series") {
        seriesId = this.series!.id;
        seriesFile = this.series!.file;
        taskId = this.taskId;
      } else {
        this.log = [];
        this.ctx.say(`generating one ${this.family} task from ${dayLabel(this.day)}…`, "busy");
        const made = await generateTask(this.family, this.day, this.seed, (line) => {
          this.log = [...this.log, line.trim()].slice(-20);
          this.ctx.draw();
        });
        ({ seriesId, seriesFile, taskId } = made);
        await this.ctx.reload();
      }
      const base: DispatchSpec = { ...this.spec, seriesFile, seriesId };
      const series = this.ctx.series.find((entry) => entry.id === seriesId);
      if (series?.startupCommand && !base.startupCommand) base.startupCommand = series.startupCommand;
      if (ignoresModel(base.startupCommand)) {
        this.ctx.say("the startup command hard-codes a model; remove it so $EM sets the model per run", "error");
        return;
      }
      const sweep = newSweep(seriesId, seriesFile, taskId, models, this.sweepId);
      this.ctx.clear();
      await this.ctx.startSweep(sweep, sweepSpecs(base, sweep), this.parallel, background);
      this.sweepId = defaultSweepId();
    } catch (error) {
      this.ctx.say((error as Error).message, "error");
    } finally {
      this.starting = false;
    }
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.starting) return true;
    if (await this.form.onKey(key)) return true;
    if (key.name === "char" && key.ch === "r") {
      void this.prepare();
      return true;
    }
    return false;
  }

  body(columns: number, height: number): string[] {
    const panel = this.panel(columns);
    const formHeight = Math.max(6, height - panel.length);
    const form = this.form.lines(columns, formHeight);
    const pad = Math.max(0, formHeight - form.length);
    return [...form, ...Array.from({ length: pad }, () => ""), ...panel].slice(0, height);
  }

  private panel(columns: number): string[] {
    const lines = ["", paint(" preflight", "bold")];
    if (this.checks.length === 0) lines.push(`  ${spinner(this.ctx.spin)} ${paint("checking…", "grey")}`);
    for (const check of this.checks) lines.push(checkLine(check, columns));
    if (this.log.length) {
      lines.push("", paint(" generating", "bold"), ...this.log.slice(-4).map((line) => fit(`  ${paint(line, "grey")}`, columns)));
    }
    const models = [...this.models];
    const preview = { ...this.spec, seriesFile: this.series?.file ?? "<series>", seriesId: this.seriesId || "<series>", model: models[0] ?? "<model>", runId: `${this.sweepId}-<model>`, name: models[0] ?? "<model>", concurrency: 1, taskIds: [this.taskId || "<task>"], families: [] };
    lines.push("", paint(` command, × ${models.length || 1} model(s)`, "bold"), ...wrap(commandLine(preview), columns - 3).slice(0, 3).map((line) => fit(`  ${paint(line, "grey")}`, columns)));
    return lines;
  }
}

/**
 * The new-run form: which series, which tasks of it, what image and model,
 * and whether the machine is ready. Preflight runs by itself when the form
 * opens and again when something it depends on changes; the local KDI service is
 * brought up rather than reported missing, because opening this form is the
 * intent to run.
 */

import { basename } from "node:path";
import { fit, paint } from "../../format.ts";
import type { SeriesSummary } from "../../inventory.ts";
import { commandLine, defaultRunId, defaultSpec, type DispatchSpec } from "../../dispatch.ts";
import { DEFAULTS, PATHS } from "../../paths.ts";
import { preflight, runningContainers, kdiServiceProbeUrl, type Check } from "../../preflight.ts";
import { loadFamilyChoices, selectedTaskCount, selectedTaskIds, selectionSummary, type FamilyChoice } from "../../task-selection.ts";
import { Form, type FormRow } from "../form.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { checkLine, spinner } from "../render.ts";
import type { Key } from "../screen.ts";
import { wrap } from "../widgets.ts";
import { FamiliesPage } from "./families.ts";
import { PickPage } from "./pick.ts";

export class NewRunPage implements Page {
  private spec: DispatchSpec | null = null;
  private series: SeriesSummary | null = null;
  private choices: FamilyChoice[] = [];
  private checks: Check[] = [];
  private containers: string[] = [];
  private checking = false;
  private startingKdiService = false;
  private starting = false;
  private launched = false;
  private readonly form = new Form(() => this.rows());

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "New run";
  }

  right(): string {
    return this.spec ? `${this.spec.seriesId} · ${selectionSummary(this.choices)}` : "";
  }

  hints(): Hint[] {
    return [["↑↓", "field"], ["⏎", "edit / open / press"], ["←→", "tabs"], ["r", "recheck"], ["?", "keys"]];
  }

  capturing(): boolean {
    return this.form.capturing();
  }

  /** Preset the form to a series; a missing id means the newest one. */
  async use(seriesId?: string): Promise<void> {
    const series = (seriesId ? this.ctx.series.find((entry) => entry.id === seriesId || entry.file === seriesId || basename(entry.file) === basename(seriesId)) : undefined) ?? this.ctx.series[0];
    if (!series) {
      this.spec = null;
      this.series = null;
      return;
    }
    if (this.series?.id === series.id && this.spec) return;
    this.series = series;
    this.spec = defaultSpec(series.file, series.id);
    if (series.startupCommand) this.spec.startupCommand = series.startupCommand;
    if (series.deadlineMinutes !== undefined) this.spec.deadlineMinutes = series.deadlineMinutes;
    // Flags win over the series' own settings, as they do for `bench dispatch`.
    // A run id names one run, so it presets only the first form.
    const { families, taskIds: _taskIds, runId, ...launch } = this.ctx.options.launch ?? {};
    Object.assign(this.spec, launch);
    if (runId && !this.launched) this.spec.runId = runId;
    else if (launch.image) this.spec.runId = defaultRunId(launch.image);
    try {
      this.choices = await loadFamilyChoices(series.file);
      if (families?.length) for (const choice of this.choices) if (!families.includes(choice.family)) choice.copies = 0;
    } catch (error) {
      this.choices = [];
      this.ctx.say(`cannot read tasks from ${series.file}: ${(error as Error).message}`, "error");
    }
    this.form.list.reset();
    void this.prepare();
  }

  /** After a run starts, the next visit gets a fresh run id for the same series. */
  reset(): void {
    this.series = null;
    this.spec = null;
  }

  async activate(): Promise<void> {
    // A series deleted on the Series tab takes the form's preset with it.
    if (this.series && !this.ctx.series.some((entry) => entry.id === this.series!.id)) this.reset();
    if (!this.spec) await this.use(this.series?.id);
    else if (this.checks.length === 0 && !this.checking) void this.prepare();
    this.sync();
  }

  private sync(): void {
    if (!this.spec) return;
    const selected = selectedTaskIds(this.choices);
    const available = this.choices.reduce((total, choice) => total + choice.taskIds.length, 0);
    // No --task flags means all tasks, keeping the default command compact.
    this.spec.taskIds = selected.length === available ? [] : selected;
    this.spec.families = [];
  }

  private rows(): FormRow[] {
    const spec = this.spec;
    if (!spec) return [{ label: "Series", kind: "choose", value: () => paint("none", "grey"), act: () => this.ctx.newSeries() }];
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
    return [
      {
        label: "Series",
        kind: "choose",
        value: () => `${spec.seriesId}  ${paint(`${this.series?.taskCount ?? "?"} tasks · ${this.series?.days.map((day) => day.date).join(", ") ?? ""}`, "grey")}`,
        act: () =>
          this.ctx.push(
            new PickPage(
              this.ctx,
              "Series",
              this.ctx.series.map((series) => ({
                value: series.id,
                label: series.id,
                detail: `${series.taskCount} tasks · ${series.families.length} families · ${series.days.map((day) => day.date).join(", ")}`,
              })),
              ["series", "contents"],
              { multi: false, current: spec.seriesId, onPick: (id) => this.use(id) },
            ),
          ),
      },
      {
        label: "Tasks",
        kind: "choose",
        value: () => selectionSummary(this.choices),
        act: () => this.ctx.push(new FamiliesPage(this.ctx, this.choices)),
      },
      {
        ...text("Image", "image", () => {
          if (!spec.image) spec.image = defaultSpec(spec.seriesFile, spec.seriesId).image;
          spec.runId = defaultRunId(spec.image);
          recheck();
        }),
      },
      text("Model", "model"),
      {
        label: "Concurrency",
        kind: "number",
        value: () => String(spec.concurrency),
        set: (value) => {
          spec.concurrency = Math.max(1, Number(value.trim()) || 1);
        },
      },
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
      ...(spec.deadlineMinutes > 0 ? [{
        label: "Kill grace",
        kind: "number" as const,
        value: () => String(spec.deadlineGraceMinutes),
        detail: () => "minutes past the deadline before the container is killed",
        set: (value: string) => {
          const minutes = Number(value.trim());
          spec.deadlineGraceMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULTS.deadlineGraceMinutes;
        },
      }] : []),
      text("Name", "name"),
      text("Run id", "runId", () => {
        if (!spec.runId) spec.runId = defaultRunId(spec.image);
      }),
      {
        label: "Resume",
        kind: "toggle",
        value: () => (spec.resume ? "yes" : "no"),
        toggle: () => {
          spec.resume = !spec.resume;
        },
      },
      text("KDI service URL", "kdiServiceUrl", () => {
        if (!spec.kdiServiceUrl) spec.kdiServiceUrl = defaultSpec(spec.seriesFile, spec.seriesId).kdiServiceUrl;
        recheck();
      }),
      { label: "Start run", kind: "button", act: () => this.start(false) },
      { label: "Start in background", kind: "button", act: () => this.start(true) },
    ];
  }

  private async prepare(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.runChecks(false);
      const service = this.checks.find((check) => check.name === "KDI service");
      if (service && !service.ok) {
        this.startingKdiService = true;
        this.ctx.draw();
        try {
          await this.runChecks(true);
        } finally {
          this.startingKdiService = false;
        }
      }
    } finally {
      this.checking = false;
      this.ctx.draw();
    }
  }

  private async runChecks(startKdiService: boolean): Promise<void> {
    const spec = this.spec;
    this.checks = [];
    this.checks = await preflight({
      image: spec?.image,
      kdiServiceProbeUrl: spec ? kdiServiceProbeUrl(spec.kdiServiceUrl) : undefined,
      startKdiService,
      env: spec?.env,
      agentDir: spec?.agentDir,
      allowOpenDb: this.ctx.options.allowOpenDb,
      onCheck: (_check, soFar) => {
        this.checks = [...soFar];
        this.ctx.draw();
      },
    });
    this.containers = await runningContainers();
    this.ctx.draw();
  }

  private async start(background: boolean, force = false): Promise<void> {
    const spec = this.spec;
    if (!spec || this.starting) return;
    this.sync();
    if (selectedTaskCount(this.choices) === 0) {
      this.ctx.say("choose at least one task family before starting", "error");
      return;
    }
    this.starting = true;
    try {
      if (!force) {
        this.ctx.say("running preflight checks…", "busy");
        this.checking = true;
        try {
          await this.runChecks(true);
        } finally {
          this.checking = false;
        }
        const blocking = this.checks.filter((check) => !check.ok && !check.advisory);
        if (blocking.length > 0) {
          this.ctx.clear();
          this.ctx.confirm(`${blocking.map((check) => check.name).join(", ")} not ready. Start anyway?`, () => this.start(background, true));
          return;
        }
      }
      this.ctx.clear();
      const taskIds = selectedTaskIds(this.choices);
      await this.ctx.startRun({ ...spec }, taskIds, background);
      this.launched = true;
      this.reset();
    } catch (error) {
      this.ctx.say((error as Error).message, "error");
    } finally {
      this.starting = false;
    }
  }

  async onKey(key: Key): Promise<boolean> {
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
    const spec = this.spec;
    if (!spec) return ["", ` no series under ${PATHS.runSeries}`];
    const lines = ["", paint(" preflight", "bold")];
    if (this.checks.length === 0) lines.push(`  ${spinner(this.ctx.spin)} ${paint("checking…", "grey")}`);
    for (const check of this.checks) {
      const busy = this.startingKdiService && check.name === "KDI service" ? spinner(this.ctx.spin) : undefined;
      lines.push(checkLine(busy ? { ...check, detail: "starting…" } : check, columns, busy));
    }
    if (this.checking && this.checks.length > 0 && !this.checks.some((check) => check.name === "KDI service")) {
      lines.push(`  ${spinner(this.ctx.spin)} ${fit("KDI service", 22)} ${paint("running kdi health…", "grey")}`);
    }
    if (this.containers.length > 0) {
      lines.push(fit(`  ${paint("!", "yellow")} ${fit("containers running", 22)} ${paint(this.containers.join(", "), "grey")}`, columns));
    }
    lines.push("", paint(" command", "bold"), ...wrap(commandLine(spec), columns - 3).slice(0, 3).map((line) => fit(`  ${paint(line, "grey")}`, columns)));
    return lines;
  }
}

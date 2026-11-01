/**
 * One run, whatever state it is in: the screen a run opens into from the list
 * and the screen a run lands on when it is started. It re-reads the run
 * directory once a second, so tasks fill in as they finish and the score
 * appears where it stands the moment the run is scored.
 *
 * ←→ switch between the task list, the tasks that went wrong, and the family
 * breakdown; ⏎ on a family narrows the task list to it.
 */

import { join } from "node:path";
import { readActivity } from "../../activity.ts";
import { taskDirName } from "../../../../eval_runner/src/runner.ts";
import type { FamilyAggregate } from "../../../../scoring/src/aggregate.ts";
import { familyHeadline } from "../../../../scoring/src/report.ts";
import { bar, fit, paint, percent, since, stamp, status as statusColour, duration } from "../../format.ts";
import { loadRun, readJson, type RunDetail, type RunSummary, type TaskRow } from "../../inventory.ts";
import { familyLabel } from "../../task-selection.ts";
import { abortSelectedTask, rerunSelectedTask, resumeRun, stopRun } from "../actions.ts";
import type { Ctx, Hint, Page } from "../page.ts";
import { isProblem, remaining, spinner, taskNote } from "../render.ts";
import type { Key } from "../screen.ts";
import { Filter, ListState } from "../state.ts";
import { fields, tableLines, tabs, type Column } from "../widgets.ts";
import { TaskPage } from "./task.ts";

const MODES = ["tasks", "problems", "families"] as const;
type Mode = (typeof MODES)[number];

const TASK_COLUMNS: Column[] = [
  { header: "task", flex: 4 },
  { header: "status", width: 14 },
  { header: "score", width: 6, align: "right" },
  { header: "KDI", width: 4, align: "right" },
  { header: "time", width: 7, align: "right" },
  { header: "note", flex: 4 },
];

const FAMILY_COLUMNS: Column[] = [
  { header: "family", flex: 3 },
  { header: "run", width: 6, align: "right" },
  { header: "scored", width: 6, align: "right" },
  { header: "score", width: 20 },
  { header: "metric", flex: 2 },
];

export class RunPage implements Page {
  private detail: RunDetail | null = null;
  private mode: Mode = "tasks";
  private readonly lists: Record<Mode, ListState> = { tasks: new ListState(), problems: new ListState(), families: new ListState() };
  private readonly filter = new Filter();
  private familyFilter: string | null = null;
  private pageSize = 10;
  private runnerLine: string | undefined;

  constructor(
    private readonly ctx: Ctx,
    private run: RunSummary,
    /** The exact tasks dispatched, for the seconds before the runner records them itself. */
    private readonly selection?: readonly string[],
  ) {}

  title(): string {
    const id = `${this.run.series}/${this.run.runId}`;
    return this.run.name ? `${this.run.name} · ${id}` : id;
  }

  right(): string {
    const run = this.detail ?? this.run;
    const total = run.total ?? this.selection?.length ?? "?";
    const score = run.score?.meanScore;
    return `${run.done}/${total} done${score === undefined || score === null ? "" : `  ${percent(score, 1)}`}`;
  }

  hints(): Hint[] {
    // Stop leads while the run goes, so a narrow key bar never clips it.
    const running = this.run.state === "running" || this.ctx.liveFor(this.run.dir)?.running();
    const control: Hint[] = running ? [["X", "stop run"]] : [["R", "resume"], ["s", "rescore"]];
    const rest: Hint[] = running ? [["s", "rescore"], ["esc", "back"]] : [["X", "stop"], ["esc", "back"]];
    if (this.mode === "families") return [...control, ["↑↓", "family"], ["⏎", "its tasks"], ["←→", "view"], ...rest];
    return [...control, ["↑↓", "select"], ["⏎", "open task"], ["←→", "view"], ["/", "filter"], ["A", "abort"], ["T", "rerun"], ...rest];
  }

  capturing(): boolean {
    return this.filter.typing;
  }

  async activate(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    const fresh = await loadRun(this.run.dir, this.run.series, this.run.runId);
    const live = this.ctx.liveFor(this.run.dir);
    const rerun = await readJson<{ taskId: string; taskDir: string; workerDir?: string }>(join(this.run.dir, "rerun-active.json"));
    if (!live) {
      // A task rerun runs in its own worker directory, and its scenario apply
      // logs there; the run's own runner.log is the previous attempt's.
      const log = Bun.file(join(rerun?.workerDir ?? this.run.dir, "runner.log"));
      if (await log.exists()) {
        // Only the tail is needed, even for a long-running managed run.
        const tail = await log.slice(Math.max(0, log.size - 16_384)).text();
        this.runnerLine = tail.trim().split("\n").at(-1);
      }
    }
    if (live?.running()) {
      // The runner has the directory but may not have written anything yet;
      // this TUI knows better than a directory with nothing in it.
      fresh.state = "running";
      for (const task of fresh.tasks) if (task.status === "not-run") task.status = "pending";
    }
    if (this.selection && !(await Bun.file(join(this.run.dir, "selection.json")).exists())) {
      const wanted = new Set(this.selection);
      fresh.tasks = fresh.tasks.filter((task) => wanted.has(task.id));
      fresh.total = this.selection.length;
    }
    for (const task of fresh.tasks) {
      if (task.status !== "running") continue;
      const dir = rerun?.taskId === task.id ? rerun.taskDir : join(this.run.dir, taskDirName(task.id));
      const activity = await readActivity(dir);
      if (activity.tool !== undefined || activity.header !== undefined) task.activity = activity;
    }
    this.detail = fresh;
    this.run = fresh;
  }

  private get tasks(): TaskRow[] {
    const all = this.detail?.tasks ?? [];
    return all.filter((task) => {
      if (this.familyFilter && task.family !== this.familyFilter) return false;
      if (this.mode === "problems" && !isProblem(task)) return false;
      return this.filter.matches(task.id);
    });
  }

  private get families(): FamilyAggregate[] {
    const families = this.detail?.scoreReport?.aggregate.families ?? [];
    // Worst first: the reason to open a breakdown is to find what is failing.
    return [...families].sort((a, b) => (a.meanScore ?? 2) - (b.meanScore ?? 2));
  }

  private get selectedTask(): TaskRow | null {
    return this.mode === "families" ? null : (this.tasks[this.lists[this.mode].cursor] ?? null);
  }

  async onKey(key: Key): Promise<boolean> {
    if (this.mode !== "families" && this.filter.onKey(key)) {
      this.lists[this.mode].reset();
      return true;
    }
    if (key.name === "left" || key.name === "right") {
      const index = (MODES.indexOf(this.mode) + (key.name === "left" ? -1 : 1) + MODES.length) % MODES.length;
      this.mode = MODES[index]!;
      return true;
    }
    const count = this.mode === "families" ? this.families.length : this.tasks.length;
    if (this.lists[this.mode].onKey(key, count, this.pageSize)) return true;
    if (key.name === "escape" && this.familyFilter) {
      this.familyFilter = null;
      return true;
    }
    if (key.name === "enter") {
      if (this.mode === "families") {
        const family = this.families[this.lists.families.cursor];
        if (family) {
          this.familyFilter = family.family;
          this.mode = "tasks";
          this.lists.tasks.reset();
        }
        return true;
      }
      const task = this.selectedTask;
      if (task && this.detail) await this.ctx.push(new TaskPage(this.ctx, this.detail, task));
      return true;
    }
    if (key.name !== "char") return false;
    switch (key.ch) {
      case "s":
        await this.ctx.score(this.run, false);
        await this.tick();
        return true;
      case "A":
        abortSelectedTask(this.ctx, this.run.dir, this.selectedTask);
        return true;
      case "T":
        rerunSelectedTask(this.ctx, this.run, this.selectedTask, () => this.tick());
        return true;
      case "X":
        stopRun(this.ctx, this.run);
        return true;
      case "R":
        resumeRun(this.ctx, this.run);
        return true;
      default:
        return false;
    }
  }

  body(columns: number, height: number): string[] {
    const run = this.detail;
    if (!run) return ["", ` ${spinner(this.ctx.spin)} reading ${this.run.dir}…`];
    const head = [...this.header(run, columns), ""];
    const problems = run.tasks.filter(isProblem).length;
    const strip = tabs(
      [
        { label: "Tasks", count: run.tasks.length },
        { label: "Problems", count: problems },
        { label: "Families", count: this.families.length },
      ],
      MODES.indexOf(this.mode),
      columns,
    );
    const listHeight = Math.max(3, height - head.length - 2);
    const body = this.mode === "families" ? this.familyLines(columns, listHeight) : this.taskLines(columns, listHeight);
    return [...head, strip, "", ...body];
  }

  private header(run: RunDetail, columns: number): string[] {
    const live = this.ctx.liveFor(run.dir);
    const total = run.total ?? run.tasks.length;
    const finished = run.tasks.filter((task) => task.status !== "pending" && task.status !== "running" && task.status !== "not-run");
    const left = run.state === "running" ? remaining(finished, total - run.done, run.concurrency ?? live?.spec.concurrency ?? 1) : "";
    const aggregate = run.scoreReport?.aggregate;
    const score = aggregate
      ? `${bar(aggregate.meanScore ?? 0, 12)} ${percent(aggregate.meanScore)} over ${aggregate.attempted} run   ${percent(aggregate.meanScoreAnswered)} over ${aggregate.scored} scored   ${paint(since(run.score?.scoredAt), "grey")}`
      : this.ctx.scoring(run.dir)
        ? `${spinner(this.ctx.spin)} scoring…`
        : paint(run.state === "running" ? "scored at finish" : "not scored", "grey");
    const counts = Object.entries(run.counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${statusColour(name)} ${count}`)
      .join("   ");
    const state = [
      statusColour(run.state),
      `${bar(total === 0 ? 0 : run.done / total, 20)} ${run.done}/${total}`,
      run.inFlight > 0 ? `${run.inFlight} in flight` : "",
      paint(left, "grey"),
      run.manager ? paint(`${run.manager.backend} worker on ${run.manager.host}`, "grey") : "",
    ].filter(Boolean).join("   ");
    const lines = fields([
      ["state", state],
      ["score", score],
      ["counts", counts || paint("—", "grey")],
      ["image", `${run.image ?? live?.spec.image ?? "—"}${live?.spec.model ? `   model ${live.spec.model}` : ""}`],
      ["started", `${stamp(run.startedAt) || "—"}${run.finishedAt ? ` → ${stamp(run.finishedAt)}` : ""}`],
      ["directory", run.dir],
    ]);
    const lastLog = live?.lines.at(-1) ?? this.runnerLine;
    if (lastLog) lines.push(fields([["runner", paint(lastLog, "grey")]])[0]!);
    return lines.map((line) => fit(line, columns));
  }

  private taskLines(columns: number, height: number): string[] {
    const head: string[] = [];
    const parts: string[] = [];
    if (this.familyFilter) parts.push(paint(`family ${familyLabel(this.familyFilter)}`, "cyan"));
    if (this.filter.active) parts.push(this.filter.render());
    const visible = this.tasks;
    if (parts.length > 0) head.push(fit(` ${parts.join("   ")}   ${paint(`${visible.length} of ${this.detail?.tasks.length ?? 0}`, "grey")}`, columns));
    if (visible.length === 0) {
      const why = this.mode === "problems" && !this.filter.active && !this.familyFilter ? "no problem tasks" : "no matching tasks";
      return [...head, "", ` ${paint(why, "grey")}`];
    }
    const rows = visible.map((task) => [
      task.id,
      task.status === "running" ? `${spinner(this.ctx.spin)} ${statusColour("running")}` : statusColour(task.status),
      task.score === null || task.score === undefined ? paint("—", "grey") : percent(task.score, 0),
      task.kdiCalls === undefined ? "" : String(task.kdiCalls),
      duration(task.durationMs),
      taskNote(task),
    ]);
    const listHeight = Math.max(1, height - head.length - 1);
    this.pageSize = listHeight;
    const list = this.lists[this.mode];
    const offset = list.window(rows.length, listHeight);
    return [...head, ...tableLines(TASK_COLUMNS, rows, { total: columns, selected: list.cursor, offset, height: listHeight })];
  }

  private familyLines(columns: number, height: number): string[] {
    const families = this.families;
    if (families.length === 0) return ["", ` ${paint(this.ctx.scoring(this.run.dir) ? "scoring…" : "not scored", "grey")}`];
    const rows = families.map((family) => {
      const headline = familyHeadline(family);
      return [
        familyLabel(family.family),
        `${family.attempted}/${family.tasks}`,
        String(family.scored),
        family.meanScore === null ? paint("not run", "grey") : `${bar(family.meanScore, 10)} ${percent(family.meanScore, 0)}`,
        headline ? `${paint(headline.label, "grey")} ${headline.value}` : paint("—", "grey"),
      ];
    });
    const listHeight = Math.max(1, height - 1);
    this.pageSize = listHeight;
    const offset = this.lists.families.window(rows.length, listHeight);
    return tableLines(FAMILY_COLUMNS, rows, { total: columns, selected: this.lists.families.cursor, offset, height: listHeight });
  }
}

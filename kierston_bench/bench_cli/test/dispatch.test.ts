import { expect, test } from "bun:test";
import { buildArgs, commandLine, defaultRunId, defaultSpec, runDirFor } from "../src/dispatch.ts";

const spec = () => ({ ...defaultSpec("/series/run_series_unit_tasks_data.json", "unit"), env: [] });

test("the runner is called with what the form holds", () => {
  const args = buildArgs({ ...spec(), runId: "r1", concurrency: 4, timeout: "45m", model: "anthropic/claude-sonnet-5" });
  expect(args).toContain("--concurrency");
  expect(args[args.indexOf("--concurrency") + 1]).toBe("4");
  expect(args).not.toContain("--timeout");
  expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-5");
  expect(args).not.toContain("--resume");
});

test("host API keys are never forwarded implicitly", () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-cross-into-container";
  try {
    const defaults = defaultSpec("/series/run_series_unit_tasks_data.json", "unit");
    expect(defaults.env).toEqual([]);
    expect(buildArgs(defaults)).not.toContain("ANTHROPIC_API_KEY");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("filters and environment repeat as separate flags", () => {
  const args = buildArgs({
    ...spec(),
    families: ["colocation", "trip-mode"],
    taskIds: ["colocation:2026-09-01:1"],
    env: ["ANTHROPIC_API_KEY", "FOO=bar"],
    resume: true,
  });
  expect(args.filter((arg) => arg === "--family")).toHaveLength(2);
  expect(args.filter((arg) => arg === "--env")).toHaveLength(2);
  expect(args).toContain("--resume");
  expect(args).toContain("colocation:2026-09-01:1");
});

test("a startup command with spaces survives the printed command line", () => {
  const line = commandLine({ ...spec(), startupCommand: 'pi -p @"$ETF" "do the task"' });
  expect(line).toContain('--startup-command "pi -p');
});

test("the run directory is series and run id under the out directory", () => {
  expect(runDirFor({ ...spec(), outDir: "/runs", runId: "r1" })).toBe("/runs/unit/r1");
});

test("a default run id names the image and the minute", () => {
  expect(defaultRunId("kierston-eval-env")).toMatch(/^kierston-eval-env-\d{8}T\d{6}Z$/);
});

test("a run carries its deadline, and 0 turns the series' own off", () => {
  const timed = buildArgs(spec());
  expect(timed.slice(timed.indexOf("--deadline"), timed.indexOf("--deadline") + 2)).toEqual(["--deadline", "20m"]);
  expect(timed.slice(timed.indexOf("--deadline-grace"), timed.indexOf("--deadline-grace") + 2)).toEqual(["--deadline-grace", "3m"]);
  const open = buildArgs({ ...spec(), deadlineMinutes: 0 });
  expect(open).toContain("0m");
  expect(open).not.toContain("--deadline-grace");
});

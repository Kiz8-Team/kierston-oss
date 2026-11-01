import { expect, test } from "bun:test";
import { defaultSpec } from "../src/dispatch.ts";
import { dayFile, generatedSeriesId, ignoresModel, newSweep, parseModels, pool, sweepSpecs } from "../src/sweep.ts";

test("models come from commas, lines and files, without comments or repeats", () => {
  expect(parseModels(["a/x, b/y", "# comment\nc/z\na/x\n"])).toEqual(["a/x", "b/y", "c/z"]);
  expect(parseModels([""])).toEqual([]);
});

test("a sweep is one run per model, each on the one task, named after its model", () => {
  const sweep = newSweep("s3", "/series/run_series_s3_tasks_data.json", "device-to-person:2026-08-31:7", ["anthropic/claude-sonnet-5", "openai/gpt-5"], "sw1");
  const specs = sweepSpecs({ ...defaultSpec("", ""), concurrency: 4, env: ["ANTHROPIC_API_KEY"] }, sweep);
  expect(specs.map((spec) => spec.runId)).toEqual(["sw1-anthropic_claude-sonnet-5", "sw1-openai_gpt-5"]);
  expect(specs.map((spec) => spec.model)).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-5"]);
  expect(specs.every((spec) => spec.taskIds.length === 1 && spec.concurrency === 1 && spec.name === spec.model && spec.seriesId === "s3")).toBe(true);
  expect(specs[0]!.env).toEqual(["ANTHROPIC_API_KEY"]);
});

test("two spellings that slug alike still get distinct run ids", () => {
  const sweep = newSweep("s", "/s.json", "t", ["a/b", "a_b"], "sw");
  expect(new Set(sweep.runs.map((run) => run.runId)).size).toBe(2);
});

test("a startup command that fixes its model cannot carry a sweep", () => {
  expect(ignoresModel(undefined)).toBe(false);
  expect(ignoresModel('pi --model "$EM" @"$ETF"')).toBe(false);
  expect(ignoresModel('pi ${EM:+--model "$EM"}')).toBe(false);
  expect(ignoresModel("pi --model anthropic/claude-sonnet-5")).toBe(true);
});

test("a generated task names its series by family, day and seed", () => {
  expect(dayFile("2026-08-31")).toBe("kierston/sim_outputs/day_2026-08-31.bin");
  expect(generatedSeriesId("trip-mode-classif", "kierston/sim_outputs/day_2026-08-31.bin", 3)).toBe("task-trip-mode-classif-2026-08-31-s3");
});

test("the pool runs at most `limit` at once and stops early when asked", async () => {
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  await pool([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    done.push(n);
    active -= 1;
  });
  expect(peak).toBe(2);
  expect(done.sort()).toEqual([1, 2, 3, 4, 5]);

  const ran: number[] = [];
  await pool([1, 2, 3], 1, async (n) => { ran.push(n); }, () => ran.length >= 1);
  expect(ran).toEqual([1]);
});

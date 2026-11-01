import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreRun } from "../src/score.ts";
import { taskDirName } from "../../eval_runner/src/runner.ts";
import { writeSimData } from "./fixtures/world.ts";

let simData: string;
let root: string;
let seriesFile: string;
let runDir: string;

const TASKS = [
  { id: "person-reid:2026-09-01:1", family: "person-reid", truth: { person: 1 } },
  { id: "person-reid:2026-09-01:2", family: "person-reid", truth: { person: 2 } },
  { id: "person-reid:2026-09-01:3", family: "person-reid", truth: { person: 3 } },
  { id: "vehicle-occupancy:2026-09-01:4", family: "vehicle-occupancy", truth: { occupants: [1, 2] } },
  // A retired family the series still holds, answered by the run.
  { id: "financial-routine:2026-09-01:5", family: "financial-routine", truth: { transactions: {} } },
];

beforeAll(async () => {
  simData = await writeSimData();
  root = await mkdtemp(join(tmpdir(), "kbench-run-"));
  seriesFile = join(root, "series.json");
  await writeFile(
    seriesFile,
    JSON.stringify({
      series: { id: "unit", createdAt: "2026-09-01T00:00:00Z", seed: 1, days: [], families: [], taskCount: TASKS.length },
      outcomes: [],
      tasks: TASKS.map((task) => ({
        id: task.id,
        family: task.family,
        date: "2026-09-01",
        seed: 1,
        prompt: "",
        evidence: {},
        answer:
          task.family === "vehicle-occupancy"
            ? { kind: "id-set", description: "Occupants." }
            : { kind: "ranked-ids", description: "Person ids." },
        groundTruth: task.truth,
        scoring: { method: task.family === "vehicle-occupancy" ? "set-f1" : "rank", aggregate: "mrr" },
      })),
    }),
  );

  runDir = join(root, "runs", "unit", "r1");
  // One right answer, one answer that is not the shape asked for, one task that
  // timed out, and one that the run never reached.
  await task(TASKS[0]!.id, "answered", { taskId: TASKS[0]!.id, answer: ["111-22-3333"] });
  await task(TASKS[1]!.id, "answered", { taskId: TASKS[1]!.id, answer: { person: "222-33-4444" } });
  await task(TASKS[2]!.id, "timeout", null);
  // A current run: the container saw an opaque case id, and meta.json maps it back.
  await task(TASKS[3]!.id, "answered", { caseId: "case-0123456789ab", answer: ["111-22-3333", "222-33-4444"] }, "case-0123456789ab");
  await task(TASKS[4]!.id, "answered", { taskId: TASKS[4]!.id, answer: {} });
});

async function task(id: string, status: string, answer: unknown, caseId?: string): Promise<void> {
  const dir = join(runDir, taskDirName(id));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, ...(caseId ? { caseId } : {}), family: id.split(":")[0], date: "2026-09-01", status, durationMs: 1000, kdiCalls: 3 }),
  );
  if (answer !== null) await writeFile(join(dir, "answer.json"), JSON.stringify(answer));
}

test("a run scores task by task and aggregates by family", async () => {
  const result = await scoreRun({ seriesFile, runDir, simDataDir: simData });
  const byId = new Map(result.tasks.map((score) => [score.id, score]));

  expect(byId.get(TASKS[0]!.id)!.score).toBe(1);
  expect(byId.get(TASKS[0]!.id)!.scoring.summary).toContain("rank 1 of 1");
  expect(byId.get(TASKS[1]!.id)!.status).toBe("invalid-answer");
  expect(byId.get(TASKS[2]!.id)!.status).toBe("timeout");
  expect(byId.get(TASKS[3]!.id)!.score).toBe(1);

  expect(result.aggregate.tasks).toBe(4);
  expect(result.aggregate.attempted).toBe(4);
  expect(result.aggregate.scored).toBe(2);
  // Two of the three reidentification tasks produced nothing to score.
  const family = result.aggregate.families.find((entry) => entry.family === "person-reid")!;
  expect(family.meanScore).toBeCloseTo(1 / 3);
  expect(family.meanScoreAnswered).toBe(1);
  expect(family.metrics.reciprocalRank!.mean).toBe(1);
});

test("a task the run never reached is not counted as wrong", async () => {
  const result = await scoreRun({
    seriesFile,
    runDir: join(root, "runs", "unit", "empty"),
    simDataDir: simData,
  });
  expect(result.aggregate.attempted).toBe(0);
  expect(result.aggregate.meanScore).toBeNull();
  expect(result.tasks.every((task) => task.status === "not-run")).toBe(true);
});

test("a retired family is left out of the score, not counted as an error", async () => {
  const result = await scoreRun({ seriesFile, runDir, simDataDir: simData });
  expect(result.tasks.map((task) => task.family)).not.toContain("financial-routine");
  expect(result.aggregate.statuses.error ?? 0).toBe(0);
});

test("filters narrow the scoring to one family", async () => {
  const result = await scoreRun({ seriesFile, runDir, simDataDir: simData, families: new Set(["vehicle-occupancy"]) });
  expect(result.tasks).toHaveLength(1);
  expect(result.aggregate.families).toHaveLength(1);
});

test("--write leaves score.json in the run", async () => {
  await scoreRun({ seriesFile, runDir, simDataDir: simData, writeInto: true });
  const written = await Bun.file(join(runDir, "score.json")).json();
  expect(written.aggregate.scored).toBe(2);
  expect(written.identityPolicy).toBe("identity-credit-30-60-100-signed-v2");
});

test("the resolution trail is kept when asked for", async () => {
  const result = await scoreRun({ seriesFile, runDir, simDataDir: simData, keepResolutions: true, taskIds: new Set([TASKS[0]!.id]) });
  expect(result.tasks[0]!.resolutions).toEqual([{ given: "111-22-3333", ids: ["1"], via: "ssn", identityCredit: 1, candidateCount: 1 }]);
});

test("explicit abstention is valid without truth access and remains in the headline denominator", async () => {
  const { scoreTask } = await import("../src/score.ts");
  const { TruthIndex } = await import("../src/truth.ts");
  const { DEFAULT_SCORE_OPTIONS } = await import("../src/families.ts");
  const { aggregate } = await import("../src/aggregate.ts");
  const { renderRunScore, toCsv } = await import("../src/report.ts");
  const series = await Bun.file(seriesFile).json();
  const target = series.tasks[0];
  const abstention = await scoreTask(target, { taskId: target.id,
    answer: { status: "undetermined", reason: "  Cannot distinguish the candidates.  " } },
    new TruthIndex("/nonexistent-abstention-test"), DEFAULT_SCORE_OPTIONS);
  expect(abstention.status).toBe("abstained");
  expect(abstention.score).toBeNull();
  expect(abstention.abstentionReason).toBe("Cannot distinguish the candidates.");
  const summary = aggregate([abstention]);
  expect(summary.attempted).toBe(1);
  expect(summary.statuses.abstained).toBe(1);
  expect(summary.meanScore).toBe(0);
  expect(summary.meanScoreAnswered).toBeNull();
  const result = { series: "unit", runId: "abstention", runDir: "", scoredAt: "", truth: "",
    options: DEFAULT_SCORE_OPTIONS, tasks: [abstention], aggregate: summary };
  expect(renderRunScore(result, { tasks: true })).toContain("Cannot distinguish the candidates.");
  expect(toCsv(result)).toContain("Cannot distinguish the candidates.");
});

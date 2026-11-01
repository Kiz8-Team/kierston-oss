import { beforeAll, expect, test } from "bun:test";
import type { KierstonBenchTask, AnswerSpec } from "../../task_generators/src/task.ts";
import { DEFAULT_SCORE_OPTIONS } from "../src/families.ts";
import { scoreTask } from "../src/score.ts";
import { TruthIndex } from "../src/truth.ts";
import { aggregate } from "../src/aggregate.ts";
import { writeSimData } from "./fixtures/world.ts";
import { parseIdentity } from "../../task_generators/src/identity.ts";
import { publicTask } from "../../eval_runner/src/bundle.ts";

let truth: TruthIndex;
beforeAll(async () => { truth = new TruthIndex(await writeSimData()); });
const personSpec: AnswerSpec = { kind: "id", identifier: "person", description: "Person" };
function task(family = "device-to-person", groundTruth: unknown = { person: 2 }, answer: AnswerSpec = { ...personSpec, kind: "ranked-ids" }): KierstonBenchTask {
  return { id: "identity-test", family, date: "2026-09-01", seed: 1, prompt: "Identify the resident.", evidence: {},
    answer, groundTruth, scoring: { method: "rank", aggregate: "identity net" } };
}
const score = (answer: unknown, target = task()) => scoreTask(target, { taskId: target.id, answer }, truth, DEFAULT_SCORE_OPTIONS, undefined, true);

test("correct identities earn 30/60/100 and all supplied fields must agree", async () => {
  for (const [answer, expected] of [
    ["Grace Hopper", 0.3], [{ name: "Grace Hopper" }, 0.3],
    [{ name: "Grace Hopper", dob: "1985-05-05" }, 0.6], ["222-33-4444", 1],
    [{ name: "Grace Hopper", dob: "1985-05-05", ssn: "222334444" }, 1],
    [{ name: "Grace Hopper", dob: "1990-01-01" }, -0.6],
    [{ name: "Ada Byron", dob: "1985-05-05" }, -0.6],
    [{ name: "Ada Byron", ssn: "222-33-4444" }, -1],
    [{ name: "Grace Hopper", ssn: "111-22-3333" }, -1],
    [{ ssn: "222-33-4444", dob: "1990-01-01" }, -1],
  ] as const) {
    const result = await score([answer]);
    expect(result.status).toBe("scored");
    expect(result.score).toBeCloseTo(expected);
  }
});

test("wrong specificity is penalized symmetrically, with abstention at zero in the headline", async () => {
  const wrong = await score([{ name: "Ada Byron" }]);
  expect(wrong.score).toBe(-0.3);
  expect((await score([{ name: "Ada Byron", dob: "1990-01-01" }])).score).toBe(-0.6);
  expect((await score(["111-22-3333"])).score).toBe(-1);
  const abstained = await score({ status: "undetermined", reason: "Insufficient evidence" });
  expect(abstained.status).toBe("abstained");
  expect(aggregate([abstained]).meanScore).toBe(0);
  expect(aggregate([wrong, abstained]).meanScore).toBe(-0.15);
});

test("ranking combines maximum correct credit with all discounted penalties, keeping ordinary MRR", async () => {
  const result = await score(["111-22-3333", { name: "Grace Hopper", dob: "1985-05-05" }]);
  expect(result.metrics.identityReward).toBe(0.3);
  expect(result.metrics.identityPenalty).toBe(1);
  expect(result.score).toBeCloseTo(-0.7);
  expect(result.metrics.reciprocalRank).toBe(0.5);
  expect((await score([{ name: "Grace Hopper" }, "222-33-4444"])).score).toBe(0.5);
  expect((await score(["222-33-4444", "111-22-3333"])).score).toBe(0.5);
  // Repeating a correct claim must not push a false claim to a cheaper rank.
  expect((await score(["222-33-4444", { ssn: "222334444" }, "111-22-3333"])).score).toBe(0.5);
  expect((await score(["111-22-3333", "333-44-5555", "444-55-6666"])).score).toBe(-1);
});

test("shared names earn partial credit but do not inflate unique-identity MRR", async () => {
  const result = await score([{ name: "Alan Turing" }], task("device-to-person", { person: 3 }));
  expect(result.score).toBe(0.3);
  expect(result.metrics.reciprocalRank).toBe(0);
  expect(result.metrics.ambiguousClaims).toBe(1);
  expect(result.resolutions![0]!.candidateCount).toBe(2);
  expect((await score([{ name: "Alan Turing", dob: "1999-09-09" }], task("device-to-person", { person: 3 }))).score).toBe(-0.6);
});

test("identity set matching does not reuse a true person and is independent of answer order", async () => {
  const target = task("household-recon", { cohabitants: [3, 4] }, { ...personSpec, kind: "id-set" });
  const answers = [{ name: "Alan Turing" }, "333-44-5555"];
  for (const list of [answers, [...answers].reverse()]) {
    const result = await score(list, target);
    expect(result.metrics.weightedTruePositives).toBeCloseTo(1.3);
    expect(result.score).toBeCloseTo(0.65);
  }
  const duplicate = await score(["333-44-5555", { ssn: "333445555" }], target);
  expect(duplicate.metrics.truePositives).toBe(1);
  expect(duplicate.metrics.uniqueClaims).toBe(1);
  const wrong = await score(["111-22-3333", "222-33-4444"], target);
  expect(wrong.score).toBe(-1);
  expect((await score([], target)).score).toBe(0);
  expect((await score([], task("colocation", { near: [] }, { ...personSpec, kind: "id-set" }))).score).toBe(1);
});

test("single identities and mixed record fields use identity credit and penalties", async () => {
  const target = task("school-escort", { school: "way/300", escortAm: 2 }, {
    kind: "record", description: "School and escort", fields: {
      school: { kind: "id", description: "School" }, escort: { ...personSpec, nullable: true },
    },
  });
  expect((await score({ school: "way/300", escort: { name: "Grace Hopper" } }, target)).score).toBe(0.65);
  expect((await score({ school: "way/300", escort: "111-22-3333" }, target)).score).toBe(0);
  const occupants = task("vehicle-occupancy", { occupants: [1, 2] }, {
    kind: "record", independentFields: true, description: "Occupancy", fields: {
      count: { kind: "integer", description: "Count" }, occupants: { ...personSpec, kind: "id-set" },
    },
  });
  const result = await score({ count: 2, occupants: [{ name: "Ada Byron" }, { name: "Grace Hopper", dob: "1985-05-05" }] }, occupants);
  expect(result.metrics["occupants.identityReward"]).toBeCloseTo(0.45);
  expect(result.score).toBeCloseTo(0.725);
});

test("malformed identity assertions remain penalized candidates instead of being dropped", async () => {
  for (const answer of [{ name: "Grace Hopper", dob: "1985-02-30" },
    { ssn: "222-33-4444", name: null }, { ssn: "222-33-4444", extra: "Ada Byron" },
    { dob: "1985-05-05" }, "6100000002", 2]) {
    const result = await score([answer]);
    expect(result.status).toBe("scored");
    expect(result.score!).toBeLessThan(0);
  }
});

test("legacy SSN-only task specs publish and validate the upgraded contract", async () => {
  const legacy = task("device-to-person", { person: 2 }, { ...personSpec, kind: "ranked-ids", identifier: "ssn" });
  legacy.prompt = "Answer with a ranked list of SSNs (taxpayer_id strings).";
  const bundle = publicTask(legacy);
  expect(bundle.answer.identifier).toBe("person");
  expect(bundle.prompt).not.toContain("SSNs (taxpayer_id strings)");
  expect(bundle.instructions).not.toMatch(/\d+ ?%/);
  expect(bundle.instructions).not.toMatch(/penal/i);
  expect((await score([{ name: "Grace Hopper" }], legacy)).score).toBe(0.3);
});

test("leading-zero SSNs are preserved; Unicode names normalize without losing letters", () => {
  expect(parseIdentity("001-02-0003").claim.ssn).toBe("001020003");
  expect(parseIdentity({ name: "José Núñez" }).claim.name).toBe("josé núñez");
  expect(parseIdentity({ name: "Grace Hopper", dob: "1985-02-30" }).valid).toBe(false);
});

test("people without SSNs earn full name and DOB credit, including Unicode and middle names", async () => {
  const dir = await writeSimData();
  const file = Bun.file(`${dir}/identity.json`);
  const data = await file.json();
  data.identities["7"] = { first_name: "José", middle_name: "Luis", surname: "Núñez", birth_date: "2001-01-02", taxpayer_id: null };
  await Bun.write(file, JSON.stringify(data));
  const localTruth = new TruthIndex(dir);
  const target = task("device-to-person", { person: 7 });
  for (const name of ["José Núñez", "JOSÉ LUIS NÚÑEZ"]) {
    const result = await scoreTask(target, { answer: [{ name, dob: "2001-01-02" }] }, localTruth, DEFAULT_SCORE_OPTIONS);
    expect(result.score).toBe(1);
  }
  expect((await localTruth.resolveIdentity({ name: "Jose Nunez", dob: "2001-01-02" })).ids).toEqual([]);
});

test("name and DOB is the full identity of anyone without an SSN, and only of them", async () => {
  // An ITIN is not an SSN; a person holding one, or nothing, cannot be named more precisely.
  expect((await score([{ name: "Mary Somerville", dob: "1978-12-26" }], task("device-to-person", { person: 5 }))).score).toBe(1);
  expect((await score([{ name: "Sofia Kovalevskaya", dob: "1988-01-15" }], task("device-to-person", { person: 6 }))).score).toBe(1);
  // A name alone is still the weak claim, and a wrong claim costs its own tier whoever it names.
  expect((await score([{ name: "Mary Somerville" }], task("device-to-person", { person: 5 }))).score).toBe(0.3);
  expect((await score([{ name: "Mary Somerville", dob: "1978-12-26" }], task("device-to-person", { person: 2 }))).score).toBe(-0.6);
  expect((await score([{ name: "Mary Somerville", dob: "1900-01-01" }], task("device-to-person", { person: 5 }))).score).toBe(-0.6);
  // Someone who does hold an SSN is still capped at 0.6 without it.
  expect((await score([{ name: "Grace Hopper", dob: "1985-05-05" }])).score).toBe(0.6);
  // The resolution trail records the credit paid.
  const result = await score([{ name: "Sofia Kovalevskaya", dob: "1988-01-15" }], task("device-to-person", { person: 6 }));
  expect(result.resolutions?.[0]?.identityCredit).toBe(1);
});

test("signed policy leaves non-person answers unchanged", async () => {
  const plate = task("plate-reconciliation", { plate: "LAV-1459" }, { kind: "ranked-ids", description: "Plate" });
  expect((await score(["WRONG", "LAV-1459"], plate)).score).toBe(0);
  const location = task("point-in-time-location", { lat: 40.6, lon: -75.47 }, { kind: "point", description: "Location" });
  expect((await score({ lat: 0, lon: 0 }, location)).score).toBe(0);
});

test("missing truth data is a scorer error rather than a false-identification penalty", async () => {
  const target = task();
  const result = await scoreTask(target, { answer: ["222-33-4444"] }, new TruthIndex("/nonexistent-identity-data"), DEFAULT_SCORE_OPTIONS);
  expect(result.status).toBe("error");
  expect(result.score).toBeNull();
  expect(result.issues.join(" ")).toContain("identity.json is unavailable");
});

test("a field is abstained when it is null or missing, and the answered fields still score", async () => {
  const occupancy = (truthOccupants: number[]) => task("vehicle-occupancy", { occupants: truthOccupants }, {
    kind: "record", independentFields: true, description: "Occupancy", fields: {
      count: { kind: "integer", description: "Count" }, occupants: { ...personSpec, kind: "id-set" },
    },
  });
  const target = occupancy([1, 2, 3]);
  // Three occupants claimed, one named, one nulled, one left out entirely.
  const result = await score({ count: 3, occupants: ["222-33-4444", null] }, target);
  expect(result.status).toBe("scored");
  expect(result.metrics["occupants.abstainedSlots"]).toBe(1);
  expect(result.metrics["occupants.wrongIdentities"]).toBe(0);
  expect(result.metrics["occupants.identityPenalty"]).toBe(0);
  // One of three found: precision 1, recall 1/3, and the count field still right.
  expect(result.metrics["occupants.precision"]).toBe(1);
  expect(result.metrics["occupants.recall"]).toBeCloseTo(1 / 3);
  expect(result.score).toBeCloseTo(0.75);

  // An abstained count costs its own field and nothing else.
  const noCount = await score({ occupants: ["222-33-4444", "111-22-3333", "333-44-5555"] }, target);
  expect(noCount.status).toBe("scored");
  expect(noCount.metrics["count.abstained"]).toBe(1);
  expect(noCount.score).toBeCloseTo(0.5);
  expect(noCount.issues.some((issue) => issue.includes("abstained"))).toBe(true);

  // Abstaining on every occupant is not the substantive "nobody" answer.
  expect((await score({ count: 0, occupants: [null, null] }, occupancy([]))).score).toBe(0.5);
  expect((await score({ count: 0, occupants: [] }, occupancy([]))).score).toBe(1);
});

test("an abstained entry keeps its rank and never counts as a wrong identity", async () => {
  const ranked = await score([null, "222-33-4444"]);
  expect(ranked.metrics.abstainedClaims).toBe(1);
  expect(ranked.metrics.wrongIdentities).toBe(0);
  // Abstaining first does not buy the claim behind it a better rank.
  expect(ranked.score).toBe(0.5);
  expect((await score(["222-33-4444", null])).score).toBe(1);
});

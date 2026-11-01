/**
 * The family scorers families.test.ts does not reach: one block per family,
 * each built from the groundTruth and answer shapes its generator writes, and
 * each scored through scoreTask so validation runs first.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { AnswerSpec, KierstonBenchTask, ScoringSpec } from "../../task_generators/src/task.ts";
import { TASK_GROUPS } from "../../task_generators/src/groups.ts";
import { DEFAULT_SCORE_OPTIONS, FAMILY_SCORERS } from "../src/families.ts";
import { scoreTask } from "../src/score.ts";
import { TruthIndex } from "../src/truth.ts";
import { writeSimData } from "./fixtures/world.ts";

let truth: TruthIndex;
beforeAll(async () => {
  truth = new TruthIndex(await writeSimData());
});

function task(family: string, answer: AnswerSpec, groundTruth: unknown, scoring: ScoringSpec): KierstonBenchTask {
  return { id: `${family}:2026-09-01:1`, family, date: "2026-09-01", seed: 1, prompt: "", evidence: {}, answer, groundTruth, scoring };
}

const score = (subject: KierstonBenchTask, answer: unknown) =>
  scoreTask(subject, { taskId: subject.id, answer }, truth, DEFAULT_SCORE_OPTIONS);

// The fixture's people, by SSN.
const ADA = "111-22-3333"; // 1, household 9
const GRACE = "222-33-4444"; // 2, household 9
const ALAN = "333-44-5555"; // 3
const ALAN_TOO = "444-55-6666"; // 4, same name as 3

const rankedPeople: AnswerSpec = { kind: "ranked-ids", identifier: "person", description: "Person identities, best first." };
const personSet: AnswerSpec = { kind: "id-set", identifier: "person", description: "Person identities." };
const rank: ScoringSpec = { method: "rank", aggregate: "mrr" };
const setF1: ScoringSpec = { method: "set-f1", aggregate: "f1" };

test("every live family has a scorer of its own", () => {
  const live = TASK_GROUPS.flatMap((group) => group.generators.map((generator) => generator.family));
  expect(live.length).toBeGreaterThan(0);
  expect(live.filter((family) => !(family in FAMILY_SCORERS))).toEqual([]);
});

describe("single-target ranked person families", () => {
  // Each of these generators writes { person } and a ranked person answer.
  const families: { family: string; extra?: Record<string, unknown> }[] = [
    { family: "device-to-person" },
    { family: "account-resolution" },
    { family: "counterparty-recon" },
    { family: "shots-fired", extra: { scenario: "shots-fired", scenarioSeed: 3 } },
    { family: "explosion", extra: { scenario: "explosion", scenarioSeed: 4 } },
    { family: "school-shooting", extra: { scenario: "school-shooting", scenarioSeed: 5 } },
    { family: "stabbing", extra: { scenario: "stabbing-alibi", scenarioSeed: 6 } },
    { family: "swatting", extra: { scenario: "swatting", scenarioSeed: 7 } },
  ];

  for (const { family, extra } of families) {
    describe(family, () => {
      const subject = task(family, rankedPeople, { person: 2, ...extra }, rank);

      test("the target first scores in full", async () => {
        const result = await score(subject, [GRACE]);
        expect(result.status).toBe("scored");
        expect(result.score).toBe(1);
        expect(result.metrics.top1).toBe(1);
        expect(result.metrics.correctRank).toBe(1);
      });

      test("a wrong identity alone is a full penalty", async () => {
        const result = await score(subject, [ADA]);
        expect(result.score).toBe(-1);
        expect(result.metrics.top1).toBe(0);
        expect(result.metrics.wrongIdentities).toBe(1);
      });

      test("the target second earns half, less the wrong first claim", async () => {
        const result = await score(subject, [ADA, GRACE]);
        expect(result.score).toBeCloseTo(-0.5);
        expect(result.metrics.correctRank).toBe(2);
      });

      test("an explicit abstention is not scored", async () => {
        const result = await score(subject, { status: "undetermined", reason: "not enough on the day" });
        expect(result.status).toBe("abstained");
        expect(result.score).toBeNull();
      });
    });
  }

  test("a weaker claim for the right person earns its tier", async () => {
    const subject = task("device-to-person", rankedPeople, { person: 2 }, rank);
    expect((await score(subject, [{ name: "Grace Hopper", dob: "1985-05-05" }])).score).toBeCloseTo(0.6);
    expect((await score(subject, ["Grace Hopper"])).score).toBeCloseTo(0.3);
  });

  test("the handset's own number is not an identity", async () => {
    // A bare string that is not an SSN reads as a name claim; one word is a
    // malformed name, which resolves to nobody and costs the name tier.
    const subject = task("device-to-person", rankedPeople, { person: 2 }, rank);
    const result = await score(subject, ["6100000022"]);
    expect(result.score).toBeCloseTo(-0.3);
    expect(result.metrics.top1).toBe(0);
    expect(result.metrics.wrongIdentities).toBe(1);
    expect(result.issues.join(" ")).toContain("malformed identity claim");
  });

  test("an ambiguous name for the right person earns its tier but no unique rank", async () => {
    const subject = task("account-resolution", rankedPeople, { person: 3 },
      { method: "rank", params: { variant: "handle-only" }, aggregate: "mrr" });
    const result = await score(subject, ["Alan Turing"]);
    expect(result.score).toBeCloseTo(0.3);
    expect(result.metrics.reciprocalRank).toBe(0);
    expect(result.metrics.ambiguousClaims).toBe(1);
  });
});

describe("payer-infer", () => {
  const subject = task("payer-infer", rankedPeople, { payer: 1 }, { method: "rank", aggregate: "top-1 accuracy" });

  test("the payer scores in full", async () => {
    const result = await score(subject, [ADA]);
    expect(result.score).toBe(1);
    expect(result.metrics.top1).toBe(1);
  });

  test("the other diner is a wrong identity", async () => {
    expect((await score(subject, [GRACE])).score).toBe(-1);
  });
});

describe("kinship-infer", () => {
  const subject = task("kinship-infer", rankedPeople, { relation: "sibling", answers: [1, 2] },
    { method: "rank", params: { anyOf: true }, aggregate: "mrr" });

  test("any one of the relatives is a right answer", async () => {
    for (const answer of [[ADA], [GRACE], [ADA, GRACE]]) {
      const result = await score(subject, answer);
      expect(result.score).toBe(1);
      expect(result.metrics.relations).toBe(2);
    }
  });

  test("someone outside the relation is a wrong identity", async () => {
    const result = await score(subject, [ALAN]);
    expect(result.score).toBe(-1);
    expect(result.metrics.relations).toBe(2);
  });
});

describe("abduction", () => {
  const subject = task("abduction", rankedPeople, {
    people: [1, 2], driver: 1, vehicle: { vin: "1HGCM82633A004352", plate: "LAV-1459" }, victim: 3,
    scenario: "abduction", scenarioSeed: 9,
  }, rank);

  test("any member of the crew first scores in full, the driver no more than the rest", async () => {
    expect((await score(subject, [GRACE])).score).toBe(1);
    expect((await score(subject, [ADA])).score).toBe(1);
  });

  test("naming the victim first costs the full wrong-identity penalty", async () => {
    const result = await score(subject, [ALAN, GRACE]);
    expect(result.score).toBeCloseTo(-0.5);
    expect(result.metrics.correctRank).toBe(2);
  });
});

describe("household-recon", () => {
  const subject = task("household-recon", personSet, { cohabitants: [1, 2], household: 9 }, setF1);

  test("the whole household scores in full", async () => {
    const result = await score(subject, [ADA, GRACE]);
    expect(result.score).toBe(1);
    expect(result.metrics.f1).toBe(1);
  });

  test("half the household is recall one half", async () => {
    const result = await score(subject, [ADA]);
    expect(result.metrics.precision).toBe(1);
    expect(result.metrics.recall).toBe(0.5);
    expect(result.score).toBeCloseTo(2 / 3);
  });

  test("an outsider costs both precision and a penalty", async () => {
    const result = await score(subject, [ADA, ALAN]);
    expect(result.metrics.f1).toBeCloseTo(0.5);
    expect(result.metrics.identityPenalty).toBeCloseTo(0.5);
    expect(result.score).toBeCloseTo(0);
  });

  test("an empty set is right for someone who lives alone, a list of holes is not", async () => {
    const alone = task("household-recon", personSet, { cohabitants: [], household: 10 }, setF1);
    expect((await score(alone, [])).score).toBe(1);
    const holes = await score(alone, [null]);
    expect(holes.status).toBe("scored");
    expect(holes.score).toBe(0);
    expect(holes.metrics.abstainedSlots).toBe(1);
  });
});

describe("colocation", () => {
  const subject = task("colocation", personSet, { near: [3, 4] },
    { method: "set-f1", params: { radiusMetres: 50, minOverlapMinutes: 10 }, aggregate: "f1" });

  test("both people by SSN score in full, though they share a name", async () => {
    expect((await score(subject, [ALAN, ALAN_TOO])).score).toBe(1);
  });

  test("the shared name alone is one ambiguous weak claim", async () => {
    const result = await score(subject, ["Alan Turing"]);
    expect(result.metrics.ambiguousClaims).toBe(1);
    expect(result.score).toBeLessThan(1);
    expect(result.score).toBeGreaterThan(0);
  });

  test("people who were not there score below zero", async () => {
    expect((await score(subject, [ADA, GRACE])).score).toBe(-1);
  });
});

describe("relationship-type", () => {
  const spec: AnswerSpec = {
    kind: "label-set",
    description: "Every kind of tie.",
    labels: ["parent", "child", "household", "sibling", "partner", "grandparent", "colleague", "classmate", "neighbour"],
  };
  const subject = task("relationship-type", spec, { kinds: ["household", "parent"] }, { method: "set-f1", aggregate: "macro-F1" });

  test("every kind, in any order and case, scores in full", async () => {
    const result = await score(subject, ["Parent", "household"]);
    expect(result.score).toBe(1);
    const parent = result.labels?.find((label) => label.field === "kind:parent");
    expect(parent).toEqual({ field: "kind:parent", predicted: "yes", truth: "yes" });
    // One binary observation per vocabulary kind.
    expect(result.labels).toHaveLength(9);
  });

  test("one of two kinds is F1 two thirds", async () => {
    const result = await score(subject, ["parent"]);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.metrics.precision).toBe(1);
    expect(result.metrics.recall).toBe(0.5);
  });

  test("a wrong kind scores nothing, and nothing answered says so", async () => {
    expect((await score(subject, ["colleague"])).score).toBe(0);
    const none = await score(subject, []);
    expect(none.score).toBe(0);
    expect(none.issues).toContain("no tie kinds answered");
  });

  test("a kind outside the vocabulary is an invalid answer", async () => {
    expect((await score(subject, ["cousin"])).status).toBe("invalid-answer");
  });
});

describe("trip-purpose (retired)", () => {
  const subject = task("trip-purpose", { kind: "label", description: "Purpose.", labels: ["work", "shop", "home"] },
    { purpose: "work" }, { method: "top1", aggregate: "macro-F1" });

  test("the right purpose scores in full and is pooled as a label", async () => {
    const result = await score(subject, "Work");
    expect(result.score).toBe(1);
    expect(result.labels).toEqual([{ field: "purpose", predicted: "work", truth: "work" }]);
  });

  test("a wrong purpose scores nothing", async () => {
    const result = await score(subject, "shop");
    expect(result.score).toBe(0);
    expect(result.labels).toEqual([{ field: "purpose", predicted: "shop", truth: "work" }]);
  });

  test("no purpose at all is reported, not silently wrong", async () => {
    const result = await score(subject, null);
    expect(result.score).toBe(0);
    expect(result.issues).toContain("no label answered");
  });
});

describe("meeting-recon", () => {
  const spec: AnswerSpec = {
    kind: "record",
    description: "Attendance and interval.",
    fields: {
      participants: { kind: "id-set", identifier: "person", description: "Attendees." },
      interval: { kind: "interval", description: "HH:MM-HH:MM." },
    },
  };
  const subject = task("meeting-recon", spec, { participants: [1, 2], startMinute: 600, endMinute: 660 },
    { method: "record", params: { fields: { participants: "set-f1", interval: "interval-iou" } }, aggregate: "F1 and IoU" });

  test("everyone and the exact interval score in full", async () => {
    const result = await score(subject, { participants: [ADA, GRACE], interval: "10:00-11:00" });
    expect(result.score).toBe(1);
    expect(result.metrics["interval.iou"]).toBe(1);
    expect(result.metrics["participants.f1"]).toBe(1);
  });

  test("half the interval is IoU one half", async () => {
    const result = await score(subject, { participants: [ADA, GRACE], interval: "10:30-11:00" });
    expect(result.metrics["interval.iou"]).toBeCloseTo(0.5);
    expect(result.score).toBeCloseTo(0.75);
  });

  test("an interval past midnight uses hours 24 and over", async () => {
    const late = task("meeting-recon", spec, { participants: [1], startMinute: 1380, endMinute: 1500 },
      { method: "record", aggregate: "F1 and IoU" });
    expect((await score(late, { participants: [ADA], interval: "23:00-25:00" })).score).toBe(1);
  });

  test("a missing interval is an abstention on that field only", async () => {
    const result = await score(subject, { participants: [ADA, GRACE] });
    expect(result.status).toBe("scored");
    expect(result.metrics["interval.abstained"]).toBe(1);
    expect(result.score).toBeCloseTo(0.5);
  });

  test("the wrong people at the right time keep only the interval half, less their penalty", async () => {
    const result = await score(subject, { participants: [ALAN, ALAN_TOO], interval: "10:00-11:00" });
    expect(result.metrics["participants.identityNet"]).toBe(-1);
    expect(result.score).toBeCloseTo(0);
  });
});

describe("shared-travel", () => {
  const spec: AnswerSpec = {
    kind: "record",
    description: "Party and driver.",
    fields: {
      travellers: { kind: "id-set", identifier: "person", description: "Everyone on the journey." },
      driver: { kind: "id", identifier: "person", description: "The driver." },
    },
  };
  const subject = task("shared-travel", spec, { travellers: [1, 2], driver: 1 },
    { method: "record", params: { fields: { travellers: "set-f1", driver: "top1" } }, aggregate: "F1 and driver accuracy" });

  test("the party and its driver score in full", async () => {
    const result = await score(subject, { travellers: [ADA, GRACE], driver: ADA });
    expect(result.score).toBe(1);
    expect(result.metrics["driver.top1"]).toBe(1);
  });

  test("the passenger named as driver is a wrong identity for that field", async () => {
    const result = await score(subject, { travellers: [ADA, GRACE], driver: GRACE });
    expect(result.metrics["driver.identityNet"]).toBe(-1);
    expect(result.score).toBeCloseTo(0);
  });

  test("a missing driver is an abstention, not a wrong claim", async () => {
    const result = await score(subject, { travellers: [ADA, GRACE] });
    expect(result.status).toBe("scored");
    expect(result.metrics["driver.abstained"]).toBe(1);
    expect(result.score).toBeCloseTo(0.5);
  });
});

describe("conversation-classif", () => {
  const spec: AnswerSpec = {
    kind: "record",
    description: "The thread's classification.",
    fields: {
      kind: { kind: "label", description: "Kind.", labels: ["family", "friends", "work"] },
      focus: { kind: "label", description: "Focus.", labels: ["errand", "plans", "gossip"] },
    },
  };
  const subject = task("conversation-classif", spec, { kind: "family", focus: "plans" },
    { method: "record", params: { fields: { kind: "top1", focus: "top1" } }, aggregate: "macro-F1 per field" });

  test("both labels right scores in full, each pooled under its own field", async () => {
    const result = await score(subject, { kind: "family", focus: "plans" });
    expect(result.score).toBe(1);
    expect(result.labels).toEqual([
      { field: "kind", predicted: "family", truth: "family" },
      { field: "focus", predicted: "plans", truth: "plans" },
    ]);
  });

  test("one label right is half", async () => {
    const result = await score(subject, { kind: "work", focus: "plans" });
    expect(result.score).toBe(0.5);
    expect(result.metrics["kind.top1"]).toBe(0);
  });

  test("a missing focus is an abstention on that field", async () => {
    const result = await score(subject, { kind: "family" });
    expect(result.status).toBe("scored");
    expect(result.score).toBe(0.5);
    expect(result.metrics["focus.abstained"]).toBe(1);
    expect(result.labels?.[1]).toEqual({ field: "focus", predicted: null, truth: "plans" });
  });
});

describe("mass-gathering with nothing to find", () => {
  const spec: AnswerSpec = {
    kind: "record", description: "Gathering.",
    fields: {
      gathering: { kind: "label", labels: ["yes", "no"], description: "yes or no." },
      location: { kind: "point", nullable: true, description: "Where." },
    },
  };
  const subject = task("mass-gathering", spec, { gathering: "no", lat: 40.6, lon: -75.47 },
    { method: "record", params: { fields: { gathering: "top1", location: "distance" } }, aggregate: "accuracy" });

  test("no with a null location scores in full", async () => {
    expect((await score(subject, { gathering: "no", location: null })).score).toBe(1);
  });

  test("a false alarm with a place scores nothing", async () => {
    expect((await score(subject, { gathering: "yes", location: { lat: 40.6, lon: -75.47 } })).score).toBe(0);
  });

  test("no with a place anyway loses the location half", async () => {
    expect((await score(subject, { gathering: "no", location: { lat: 40.6, lon: -75.47 } })).score).toBe(0.5);
  });
});

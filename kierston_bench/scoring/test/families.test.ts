import { beforeAll, describe, expect, test } from "bun:test";
import type { AnswerSpec, KierstonBenchTask, ScoringSpec } from "../../task_generators/src/task.ts";
import { DEFAULT_SCORE_OPTIONS, parseInterval } from "../src/families.ts";
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

describe("ranked families", () => {
  const subject = task(
    "person-reid",
    { kind: "ranked-ids", description: "Person ids." },
    { person: 2 },
    { method: "rank", aggregate: "mrr" },
  );

  test("a top-1 hit keeps MRR but loses credit for a wrong second identity", async () => {
    const result = await score(subject, ["222-33-4444", "111-22-3333"]);
    expect(result.status).toBe("scored");
    expect(result.score).toBe(0.5);
    expect(result.metrics.top1).toBe(1);
    expect(result.metrics.correctRank).toBe(1);
    expect(result.scoring).toEqual({
      method: "rank",
      aggregate: "mrr",
      summary: "Identity credit 1.000 minus penalty 0.500 = 0.500. Unique correct identity at rank 1 of 2; reciprocal rank = 1.000.",
    });
  });

  test("the true person second earns half credit less the first wrong claim", async () => {
    const result = await score(subject, ["111-22-3333", "222-33-4444"]);
    expect(result.score).toBeCloseTo(-0.5);
    expect(result.metrics.top1).toBe(0);
    expect(result.metrics.recallAt5).toBe(1);
    expect(result.metrics.correctRank).toBe(2);
    expect(result.scoring.summary).toContain("rank 2 of 2");
  });

  test("an unresolved guess still occupies its submitted rank", async () => {
    const result = await score(subject, ["999-99-9999", "222-33-4444"]);
    expect(result.score).toBeCloseTo(-0.5);
    expect(result.metrics.correctRank).toBe(2);
    expect(result.metrics.answersSubmitted).toBe(2);
  });

  test("an identifier that resolves to nobody is reported, not silently wrong", async () => {
    const result = await score(subject, ["999-99-9999"]);
    expect(result.score).toBe(-1);
    expect(result.issues.join(" ")).toContain("resolves to no person");
  });
});

test("a ranked plate is compared in canonical form", async () => {
  const subject = task(
    "plate-reconciliation",
    { kind: "ranked-ids", description: "Plates." },
    { plate: "LAV-1459" },
    { method: "rank", aggregate: "top-1" },
  );
  const result = await score(subject, ["lav1459"]);
  expect(result.score).toBe(1);
  expect(result.metrics.top1Similarity).toBe(1);
});

describe("vehicle-to-owner", () => {
  const subject = task(
    "vehicle-to-owner",
    { kind: "id", description: "Whoever controls it." },
    { registeredOwner: 1, regularDriver: 1, household: 9, ownerType: "person" },
    { method: "hierarchical", aggregate: "hierarchical accuracy" },
  );

  test("the keeper scores in full", async () => {
    expect((await score(subject, "111-22-3333")).score).toBe(1);
  });

  test("someone else in the owning household scores half", async () => {
    const result = await score(subject, "222-33-4444");
    expect(result.score).toBe(0.5);
    expect(result.metrics.household).toBe(1);
  });

  test("an unrelated person scores nothing", async () => {
    expect((await score(subject, "333-44-5555")).score).toBe(0);
  });
});

describe("school-escort", () => {
  const spec: AnswerSpec = {
    kind: "record",
    description: "School and escort.",
    fields: { school: { kind: "id", description: "School." }, escort: { kind: "id", nullable: true, description: "Escort or null." } },
  };

  test("naming the school by name and the escort by SSN scores both", async () => {
    const subject = task("school-escort", spec, { school: "way/300", escortAm: 2, morningMode: "lift" }, {
      method: "record",
      aggregate: "school and escort accuracy",
    });
    const result = await score(subject, { school: "Jefferson Elementary School", escort: "222-33-4444" });
    expect(result.score).toBe(1);
  });

  test("no escort is the right answer when there is none", async () => {
    const subject = task("school-escort", spec, { school: "way/300", escortAm: null, morningMode: "walk" }, {
      method: "record",
      aggregate: "school and escort accuracy",
    });
    const result = await score(subject, { school: "way/300", escort: null });
    expect(result.score).toBe(1);
    expect((await score(subject, { school: "way/300", escort: "111-22-3333" })).score).toBe(0);
  });
});

test("the employer and the address split the workplace score in half", async () => {
  const spec = {
    kind: "record" as const,
    independentFields: true,
    description: "Employer and address.",
    fields: {
      employer: { kind: "text" as const, description: "Employer." },
      address: { kind: "text" as const, description: "Address." },
    },
  };
  const subject = task(
    "workplace-id",
    spec,
    { site: "way/400", employer: "Sacred Heart Hospital", address: "North 10th Street, Allentown, PA 18102", addressable: true },
    { method: "record", aggregate: "employer and address accuracy" },
  );

  const both = await score(subject, { employer: "Sacred Heart Hospital", address: "North 10th Street, Allentown, PA 18102" });
  expect(both.score).toBe(1);

  // A name shared with another building still answers the question: the
  // employer is compared to the truth site's own name, not resolved to an id.
  const nameOnly = await score(subject, { employer: "sacred heart hospital", address: null });
  expect(nameOnly.metrics["employer.top1"]).toBe(1);
  expect(nameOnly.score).toBe(0.5);

  const wrong = await score(subject, { employer: "Allentown Police Department", address: "425 Hamilton Street" });
  expect(wrong.score).toBe(0);

  // "North 10th Street" names both way/400 and way/401. Under the old scorer
  // that ambiguity was a zero; the site it resolves to is what matters now.
  const shared = await score(subject, { employer: "Sacred Heart Hospital", address: "north 10th street, allentown, pa 18102" });
  expect(shared.metrics["address.top1"]).toBe(1);

  // An OSM reference names the building without saying where it is.
  for (const reference of ["way/400", "v:way/400", "WAY/400"]) {
    const osm = await score(subject, { employer: "Sacred Heart Hospital", address: reference });
    expect(osm.metrics["address.top1"]).toBe(0);
    expect(osm.score).toBe(0.5);
  }
});

test("abstention scores zero, including on an old task whose truth has no address", async () => {
  const spec = {
    kind: "record" as const,
    independentFields: true,
    description: "Employer and address.",
    fields: {
      employer: { kind: "text" as const, description: "Employer." },
      address: { kind: "text" as const, description: "Address." },
    },
  };
  const subject = task(
    "workplace-id",
    spec,
    { site: "way/400", employer: "Sacred Heart Hospital", address: null, addressable: false },
    { method: "record", aggregate: "employer and address accuracy" },
  );

  const abstained = await score(subject, { employer: "Sacred Heart Hospital", address: { status: "undetermined", reason: "the day is the city" } });
  expect(abstained.metrics["address.abstained"]).toBe(1);
  expect(abstained.metrics["address.correctAbstention"]).toBeUndefined();
  expect(abstained.score).toBe(0.5);

  const omitted = await score(subject, { employer: "Sacred Heart Hospital" });
  expect(omitted.score).toBe(0.5);

  const guessed = await score(subject, { employer: "Sacred Heart Hospital", address: "North 10th Street, Allentown, PA 18102" });
  expect(guessed.metrics["address.top1"]).toBe(0);
  expect(guessed.score).toBe(0.5);

  const nameMissing = await score(subject, { employer: null, address: { status: "undetermined", reason: "no fixed site" } });
  expect(nameMissing.score).toBe(0);
});

describe("candidate answers", () => {
  const credit = [1, 0.8, 0.6];
  const recordTask = (family: string, fields: AnswerSpec["fields"], groundTruth: unknown) =>
    task(family, { kind: "record", description: "", fields }, groundTruth, { method: "record", aggregate: "" });
  const origin = { lat: 40.6, lon: -75.47 };
  const destination = { lat: 40.61, lon: -75.48 };
  const journey = recordTask("origin-destination", {
    origin: { kind: "point", candidateCredit: credit, description: "" },
    destination: { kind: "point", candidateCredit: credit, description: "" },
  }, { origin, destination });

  test("two candidates with the right one earn 80%, not reciprocal rank's 50%, whatever the order", async () => {
    const far = { lat: 40.7, lon: -75.3 };
    for (const pair of [[far, origin], [origin, far]]) {
      const result = await score(journey, { origin: pair, destination });
      expect(result.metrics["origin.candidates"]).toBe(2);
      expect(result.metrics["origin.metres"]).toBeLessThan(1);
      expect(result.score).toBeCloseTo(0.9);
    }
    const three = await score(journey, { origin: [far, { lat: 40.8, lon: -75.3 }, origin], destination });
    expect(three.metrics["origin.candidateCredit"]).toBeCloseTo(0.6);
    expect((await score(journey, { origin: [far, far], destination })).score).toBeCloseTo(0.5);
  });

  test("a bare [lat, lon] is still one point, and extra candidates are not scored", async () => {
    expect((await score(journey, { origin: [40.6, -75.47], destination })).score).toBe(1);
    const four = await score(journey, { origin: [{ lat: 40.7, lon: -75.3 }, { lat: 40.71, lon: -75.3 }, { lat: 40.72, lon: -75.3 }, origin], destination });
    expect(four.metrics["origin.withinCredit"]).toBe(0);
    expect(four.issues.join(" ")).toContain("only the first 3");
  });

  test("a spec without candidates keeps rejecting lists", async () => {
    const legacy = recordTask("home-id", {
      dwelling: { kind: "id", description: "" },
      location: { kind: "point", description: "" },
    }, { dwelling: "way/100", lat: 40.6, lon: -75.47 });
    const result = await score(legacy, { dwelling: ["way/100", "way/200"], location: origin });
    expect(result.status).toBe("invalid-answer");
  });

  test("dwelling, school, employer and address candidates each scale their own field", async () => {
    const home = recordTask("home-id", {
      dwelling: { kind: "id", candidateCredit: credit, description: "" },
      location: { kind: "point", candidateCredit: credit, description: "" },
    }, { dwelling: "way/100", lat: 40.6, lon: -75.47 });
    const dwelling = await score(home, { dwelling: ["Hop Po", "1 Bridge Street, Allentown, PA 18103"], location: origin });
    expect(dwelling.score).toBeCloseTo((2 * 0.8 + 1) / 3);

    const work = task("workplace-id", {
      kind: "record", independentFields: true, description: "", fields: {
        employer: { kind: "text", candidateCredit: credit, description: "" },
        address: { kind: "text", candidateCredit: credit, description: "" },
      },
    }, { site: "way/400", employer: "Sacred Heart Hospital", address: "North 10th Street, Allentown, PA 18102", addressable: true },
    { method: "record", aggregate: "" });
    const employer = await score(work, { employer: ["Milano Furniture", "Sacred Heart Hospital"], address: "North 10th Street, Allentown, PA 18102" });
    expect(employer.score).toBeCloseTo(0.9);
    // An OSM reference among the candidates is still no address, and costs only the scaling.
    const address = await score(work, { employer: "Sacred Heart Hospital", address: ["way/400", "North 10th Street, Allentown, PA 18102"] });
    expect(address.score).toBeCloseTo(0.9);
  });

  test("escort candidates: a wrong identity beside the right one is not penalized, a list of wrong ones is", async () => {
    const escort = (escortAm: number | null) => recordTask("school-escort", {
      school: { kind: "id", candidateCredit: credit, description: "" },
      escort: { kind: "id", identifier: "person", nullable: true, candidateCredit: credit, description: "" },
    }, { school: "way/300", escortAm, morningMode: "lift" });
    const hedged = await score(escort(2), { school: "Jefferson Elementary School", escort: ["111-22-3333", "222-33-4444"] });
    expect(hedged.metrics["escort.identityNet"]).toBeCloseTo(0.8);
    expect(hedged.score).toBeCloseTo(0.9);
    const wrong = await score(escort(2), { school: "way/300", escort: ["111-22-3333", "333-44-5555"] });
    expect(wrong.metrics["escort.identityNet"]).toBe(-1);
    // null stands for "nobody" inside a list too.
    const unescorted = await score(escort(null), { school: ["Hop Po", "way/300"], escort: [null, "222-33-4444"] });
    expect(unescorted.score).toBeCloseTo(0.8);
  });
});

test("an interval reads from every shape an agent might write", () => {
  expect(parseInterval("07:00-15:00")).toEqual({ start: 420, end: 900 });
  expect(parseInterval({ start: "07:00", end: "15:00" })).toEqual({ start: 420, end: 900 });
  expect(parseInterval(["07:00", "15:00"])).toEqual({ start: 420, end: 900 });
  expect(parseInterval("23:00 to 07:00")).toEqual({ start: 1380, end: 1860 });
});

test("a point within the credit radius is right, and the metres are kept", async () => {
  const subject = task(
    "point-in-time-location",
    { kind: "point", description: "Where." },
    { lat: 40.6, lon: -75.47, during: "stay", place: "home" },
    { method: "distance", aggregate: "median distance" },
  );
  const near = await score(subject, { lat: 40.6005, lon: -75.47 });
  expect(near.score).toBe(1);
  expect(near.metrics.metres).toBeLessThan(100);
  const far = await score(subject, { lat: 40.65, lon: -75.47 });
  expect(far.score).toBe(0);
  expect(far.metrics.metres).toBeGreaterThan(1000);
});

test("a set family scores precision and recall over resolved people", async () => {
  const subject = task(
    "vehicle-occupancy",
    { kind: "id-set", description: "Occupants." },
    { occupants: [1, 2] },
    { method: "set-f1", aggregate: "mean F1" },
  );
  const result = await score(subject, ["111-22-3333", "333-44-5555"]);
  expect(result.metrics.precision).toBeCloseTo(0.5);
  expect(result.metrics.recall).toBeCloseTo(0.5);
});

test("an organization set ignores the v: prefix on either side", async () => {
  const subject = task(
    "organization-membership",
    { kind: "id-set", description: "Orgs." },
    { organizations: ["v:way/200"] },
    { method: "set-f1", aggregate: "mean F1" },
  );
  expect((await score(subject, ["way/200"])).score).toBe(1);
});

test("a mode answered in the wider vocabulary still matches", async () => {
  const subject = task(
    "trip-mode",
    { kind: "label", description: "Mode.", labels: ["car", "transit", "bus", "walk"] },
    { mode: "transit" },
    { method: "top1", aggregate: "macro-F1" },
  );
  expect((await score(subject, "bus")).score).toBe(1);
  expect((await score(subject, "walk")).score).toBe(0);
});

test("an historical other trip is classified as car", async () => {
  const subject = task(
    "trip-mode",
    { kind: "label", description: "Mode.", labels: ["car", "other"] },
    { mode: "other" },
    { method: "top1", aggregate: "macro-F1" },
  );
  const result = await score(subject, "car");
  expect(result.score).toBe(1);
  expect(result.labels).toEqual([{ field: "mode", predicted: "car", truth: "car" }]);
});

test("occupation gives half credit for the right major group", async () => {
  const subject = task(
    "occupation-inference",
    {
      kind: "record",
      description: "Occupation.",
      fields: { occupation: { kind: "label", description: "OCCP." }, soc: { kind: "label", description: "SOC." } },
    },
    { occupation: "4840", soc: "413091" },
    { method: "hierarchical", aggregate: "hierarchical macro-F1" },
  );
  expect((await score(subject, { occupation: "4840", soc: "413091" })).score).toBe(1);
  expect((await score(subject, { occupation: "4830", soc: "412031" })).score).toBe(0.5);
  expect((await score(subject, { occupation: "1010", soc: "151252" })).score).toBe(0);
});

test("transaction-to-visit weights the venue above the arrival minute", async () => {
  const subject = task(
    "transaction-to-visit",
    {
      kind: "record",
      description: "The visit.",
      fields: { venue: { kind: "id", description: "Venue." }, arrival: { kind: "label", description: "HH:MM." } },
    },
    { venue: "v:way/200", visitStartMinute: 825, visitEndMinute: 856 },
    { method: "record", aggregate: "venue accuracy; arrival MAE" },
  );
  const result = await score(subject, { venue: "Hop Po", arrival: "13:50" });
  expect(result.metrics["arrival.minutesError"]).toBe(5);
  expect(result.score).toBe(1);
  const late = await score(subject, { venue: "Hop Po", arrival: "16:00" });
  expect(late.score).toBeCloseTo(2 / 3);
});

test("a family with no scorer of its own is a scoring error, never a guessed score", async () => {
  const subject = task(
    "some-new-family",
    { kind: "ranked-ids", description: "Person ids." },
    { person: 1 },
    { method: "rank", aggregate: "mrr" },
  );
  const result = await score(subject, ["111-22-3333"]);
  expect(result.status).toBe("error");
  expect(result.score).toBeNull();
  expect(result.issues.join(" ")).toContain("no scorer for family some-new-family");
});

describe("vehicle occupancy count and identities", () => {
  const subject = task("vehicle-occupancy", {
    kind: "record", independentFields: true, description: "Count and identities.",
    fields: {
      count: { kind: "integer", description: "Including the driver." },
      occupants: { kind: "id-set", identifier: "ssn", description: "SSNs." },
    },
  }, { occupants: [1, 2] }, { method: "record", aggregate: "count accuracy and identity F1" });

  test("correct count with entirely wrong identities keeps count credit", async () => {
    const result = await score(subject, { count: 2, occupants: ["333-44-5555", "444-55-6666"] });
    expect(result.score).toBe(0);
    expect(result.metrics["count.accuracy"]).toBe(1);
    expect(result.metrics["occupants.f1"]).toBe(0);
  });
  test("wrong count with correct identities keeps identity credit", async () => {
    const result = await score(subject, { count: 9, occupants: ["111-22-3333", "222-33-4444"] });
    expect(result.score).toBe(0.5);
    expect(result.metrics["count.accuracy"]).toBe(0);
    expect(result.metrics["occupants.f1"]).toBe(1);
  });
  test("malformed or absent fields do not suppress the other field", async () => {
    for (const answer of [{ count: "two", occupants: ["111-22-3333", "222-33-4444"] },
      { occupants: ["111-22-3333", "222-33-4444"] }, { count: 2 }]) {
      const result = await score(subject, answer);
      expect(result.status).toBe("scored");
      expect(result.score).toBe(0.5);
    }
  });
  test("unresolved guesses are false positives, not dropped", async () => {
    const result = await score(subject, { count: 2, occupants: ["111-22-3333", "222-33-4444", "999-99-9999"] });
    expect(result.metrics["occupants.precision"]).toBeCloseTo(2 / 3);
    expect(result.metrics["occupants.recall"]).toBe(1);
  });
  test("a supplied phone or private index cannot stand in for an SSN", async () => {
    const result = await score(subject, { count: 2, occupants: ["6100000001", 2] });
    expect(result.metrics["occupants.f1"]).toBe(0);
    expect(result.metrics["count.accuracy"]).toBe(1);
  });
});

test("a private venue name and an observable answer resolve to the same place", async () => {
  const subject = task("transaction-to-visit", {
    kind: "record", description: "Visit.", fields: {
      venue: { kind: "id", description: "Venue name." },
      arrival: { kind: "time", description: "HH:MM." },
    },
  }, { venue: "Hop Po", visitStartMinute: 1200 }, { method: "record", aggregate: "venue and time" });
  expect((await score(subject, { venue: "Hop Po", arrival: "20:00" })).score).toBe(1);
});

test("a shop on no register is answered by the strings its task recorded", async () => {
  const subject = task("transaction-to-visit", {
    kind: "record", description: "Visit.", fields: {
      venue: { kind: "id", description: "Venue name." },
      arrival: { kind: "time", description: "HH:MM." },
    },
  }, {
    venue: "v:node/900", venueName: "Ecua-Atlantic Seafood", venueAddress: "621 North 7th Street, Allentown, PA 18102",
    venueAccepted: ["Ecua-Atlantic Seafood", "Ecua-Atlantic Seafood, 621 North 7th Street, Allentown, PA 18102"],
    visitStartMinute: 887,
  }, { method: "record", aggregate: "venue and time" });
  expect((await score(subject, { venue: "ecua atlantic seafood", arrival: "14:47" })).score).toBe(1);
  expect((await score(subject, { venue: "node/900", arrival: "14:47" })).score).toBe(1);
  // The address alone was not recorded as unique, so it is not an answer.
  expect((await score(subject, { venue: "621 North 7th Street, Allentown, PA 18102", arrival: "14:47" })).metrics["venue.top1"]).toBe(0);
});

test("the merchant name quoted in the prompt is not the venue answer", async () => {
  const spec: AnswerSpec = {
    kind: "record", description: "Visit.", fields: {
      venue: { kind: "id", description: "Venue address." },
      arrival: { kind: "time", description: "HH:MM." },
    },
  };
  const truth = {
    venue: "v:node/900", venueAccepted: ["621 North 7th Street, Allentown, PA 18102"],
    quotedMerchant: "Ecua-Atlantic Seafood", visitStartMinute: 887,
  };
  const subject = task("transaction-to-visit", spec, truth, { method: "record", aggregate: "venue and time" });
  expect((await score(subject, { venue: "ecua atlantic seafood", arrival: "14:47" })).metrics["venue.top1"]).toBe(0);
  expect((await score(subject, { venue: "621 North 7th Street, Allentown, PA 18102", arrival: "14:47" })).score).toBe(1);

  // A series written before the truth recorded the quoted name: the evidence holds it.
  const old = { ...task("transaction-to-visit", spec, { ...truth, quotedMerchant: undefined, venueAccepted: ["Ecua-Atlantic Seafood"] },
    { method: "record", aggregate: "venue and time" }), evidence: { charge: { merchant: "Ecua-Atlantic Seafood" } } };
  expect((await score(old, { venue: "Ecua-Atlantic Seafood", arrival: "14:47" })).metrics["venue.top1"]).toBe(0);
});

test("mode aliases normalize the expected label as well as the answer", async () => {
  const subject = task("trip-mode", { kind: "label", description: "Mode.", labels: ["cab", "taxi"] },
    { mode: "cab" }, { method: "top1", aggregate: "accuracy" });
  expect((await score(subject, "cab")).score).toBe(1);
  expect((await score(subject, "taxi")).score).toBe(1);
});

describe("scenario families", () => {
  test("a suspect ranking scores by the rank of the perpetrator", async () => {
    const subject = task("mass-shooting", { kind: "ranked-ids", identifier: "person", description: "Suspects." },
      { person: 2, scenario: "mass-shooting", scenarioSeed: 11 }, { method: "rank", aggregate: "mrr" });
    const result = await score(subject, ["111-22-3333", "222-33-4444"]);
    expect(result.status).toBe("scored");
    expect(result.metrics.correctRank).toBe(2);
  });

  test("protest membership is a person set with the decoy count carried as a metric", async () => {
    const subject = task("protest-members", { kind: "id-set", identifier: "person", description: "Marchers." },
      { members: [1, 2], bystanders: 7 }, { method: "set-f1", aggregate: "f1" });
    const result = await score(subject, ["111-22-3333", "222-33-4444"]);
    expect(result.score).toBe(1);
    expect(result.metrics.bystanders).toBe(7);
    expect(result.metrics.participants).toBe(2);
  });

  describe("disappearance", () => {
    const spec: AnswerSpec = {
      kind: "record", independentFields: true, description: "Where she is, or who is responsible.",
      fields: {
        location: { kind: "point", optional: true, description: "Where she is now." },
        suspects: { kind: "ranked-ids", identifier: "person", optional: true, description: "Who is responsible." },
      },
    };
    const subject = task("disappearance", spec, { person: 2, missing: 1 },
      { method: "record", params: { fields: { suspects: "rank" }, ungraded: ["location"] }, aggregate: "mrr" });

    test("suspects alone score as a ranked answer", async () => {
      const result = await score(subject, { suspects: ["222-33-4444"] });
      expect(result.status).toBe("scored");
      expect(result.score).toBe(1);
      expect(result.metrics.locationGiven).toBe(0);
    });

    test("a location is accepted but never scored, right or wrong", async () => {
      const both = await score(subject, { location: { lat: 40.6, lon: -75.47 }, suspects: ["222-33-4444"] });
      expect(both.score).toBe(1);
      expect(both.metrics.locationGiven).toBe(1);
      const only = await score(subject, { location: { lat: 40.6, lon: -75.47 } });
      expect(only.status).toBe("scored");
      expect(only.score).toBe(0);
      expect(only.metrics.abstained).toBe(1);
      expect(only.metrics.locationGiven).toBe(1);
    });

    test("a bare list is not the record answer: validation refuses it before the scorer", async () => {
      const result = await score(subject, ["222-33-4444"]);
      expect(result.status).toBe("invalid-answer");
    });
  });

  describe("mass-gathering", () => {
    const spec: AnswerSpec = {
      kind: "record", description: "Gathering.",
      fields: {
        gathering: { kind: "label", labels: ["yes", "no"], description: "yes or no." },
        location: { kind: "point", nullable: true, description: "Where." },
      },
    };
    const subject = task("mass-gathering", spec, { gathering: "yes", lat: 40.6, lon: -75.47 },
      { method: "record", params: { fields: { gathering: "top1", location: "distance" }, placeCreditMetres: 250 }, aggregate: "accuracy" });

    test("yes at the right place scores in full, using the task's own credit radius", async () => {
      const result = await score(subject, { gathering: "yes", location: { lat: 40.6015, lon: -75.47 } });
      expect(result.score).toBe(1);
      expect(result.metrics["location.metres"]).toBeGreaterThan(100);
    });

    test("yes at the wrong place earns only the detection half", async () => {
      const result = await score(subject, { gathering: "yes", location: { lat: 40.65, lon: -75.40 } });
      expect(result.score).toBe(0.5);
      expect(result.labels?.[0]).toEqual({ field: "gathering", predicted: "yes", truth: "yes" });
    });

    test("no with a null location scores nothing when there is a gathering", async () => {
      const result = await score(subject, { gathering: "no", location: null });
      expect(result.score).toBe(0);
    });

    const pointSubject = task("mass-gathering", { kind: "point", description: "Where." }, { lat: 40.6, lon: -75.47 },
      { method: "distance", params: { placeCreditMetres: 250 }, aggregate: "distance" });

    test("a point answer is scored by distance alone", async () => {
      expect((await score(pointSubject, { lat: 40.6015, lon: -75.47 })).score).toBe(1);
      expect((await score(pointSubject, { lat: 40.65, lon: -75.40 })).score).toBe(0);
    });
  });
});

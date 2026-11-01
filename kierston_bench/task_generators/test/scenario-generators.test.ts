/**
 * The RTI families against a hand-made merged-day header. No KDAY is
 * opened: the generators read the header, the world's name and identity
 * files, and nothing else, so a fake context with those three is enough to
 * pin the prompt, the cutoff and the truth each family records.
 */

import { describe, expect, test } from "bun:test";
import type { TaskContext } from "../src/context.ts";
import type { ScenarioHeader } from "../src/kday.ts";
import { Rng } from "../src/rng.ts";
import { cityInstant, nowAfter } from "../src/generators/rti/scenario.ts";
import { generatorByFamily, RTI_GENERATORS, DT_GENERATORS, STAGED_GENERATORS } from "../src/index.ts";

function context(scenario: ScenarioHeader | undefined, names: Record<string, string> = {}): TaskContext {
  return {
    date: "2026-09-04",
    day: { meta: { date: "2026-09-04", scenario } },
    world: {
      timeZone: async () => "America/New_York",
      placeName: async (reference: string) => {
        const name = names[reference];
        if (!name) throw new Error(`no name for ${reference}`);
        return name;
      },
      callerIdentity: async (person: number) => ({ name: `Caller ${person} Test`, dob: "1990-01-02", phone: `(610) 555-0${person}` }),
      vehicles: async () => ({ vehicles: { "1HGCM82633A004352": { vin: "1HGCM82633A004352", plate: "KRS 4471" } } }),
    },
  } as unknown as TaskContext;
}

const shooting: ScenarioHeader = {
  format: "KIERSTON_SCENARIO", version: 1, name: "mass-shooting", seed: 11,
  actors: { decoy: 77 }, places: { hall: "node/1" }, groups: { shooter: [42], attendees: [1, 2, 3] },
  choices: { aftermath: "blend" },
  events: [{ id: "shots", kind: "shooting", lat: 40.6, lon: -75.47, place: "node/1", radiusMetres: 200, start: 1270, end: 1274 }],
};

describe("cityInstant", () => {
  test("late RTI and DT cutoffs stay in the same day", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(nowAfter(new Rng(seed), 1438, { min: 25, max: 40 })).toBe(1439);
      expect(nowAfter(new Rng(seed), 1439, { min: 6, max: 14 })).toBe(1439);
    }
    expect(() => nowAfter(new Rng(1), 1440, { min: 6, max: 14 })).toThrow("before midnight");
  });
  test("renders a sim minute in the city's zone, with its offset", () => {
    expect(cityInstant("2026-09-04", 1285, "America/New_York")).toBe("2026-09-04T21:25:00-04:00");
    expect(cityInstant("2026-01-15", 600, "America/New_York")).toBe("2026-01-15T10:00:00-05:00");
    expect(cityInstant("2026-09-04", 1500, "UTC")).toBe("2026-09-05T01:00:00+00:00");
  });
});

describe("suspect families", () => {
  test("read the shooter and the event from the header and cut the records off minutes after", async () => {
    const generator = generatorByFamily.get("mass-shooting")!;
    const task = await generator.generate(context(shooting, { "node/1": "The Brass Rail" }), new Rng(1), 5);
    expect(task.groundTruth).toEqual({ person: 42, scenario: "mass-shooting", scenarioSeed: 11, choices: { aftermath: "blend" }, decoy: 77 });
    expect(task.answer.kind).toBe("ranked-ids");
    expect(task.prompt).toContain("The Brass Rail (40.6, -75.47)");
    expect(task.prompt).toContain("between 21:10 and 21:14");
    expect(task.evidence).toMatchObject({ incident: "shooting", venue: "The Brass Rail", window: { from: "21:10", to: "21:14" } });
    const now = String(task.evidence.now);
    const minute = Number(now.slice(0, 2)) * 60 + Number(now.slice(3));
    expect(minute).toBeGreaterThanOrEqual(1284);
    expect(minute).toBeLessThanOrEqual(1294);
    expect(task.kdiPolicy?.cutoff).toBe(cityInstant("2026-09-04", minute, "America/New_York"));
    expect(task.prompt).toContain(`It is now ${now}`);
    expect(JSON.stringify(task.evidence)).not.toContain("42");
  });

  test("a kerb-point incident is quoted by coordinates alone and takes a single-actor role", async () => {
    const header: ScenarioHeader = { ...shooting, name: "shots-fired", actors: { shooter: 9 }, groups: {}, choices: undefined,
      events: [{ id: "shots", kind: "shots-fired", lat: 40.61, lon: -75.48, place: null, radiusMetres: 250, start: 845, end: 847 }] };
    const task = await generatorByFamily.get("shots-fired")!.generate(context(header), new Rng(2), 6);
    expect(task.prompt).toContain("near (40.61, -75.48) between 14:05 and 14:07");
    expect(task.groundTruth).toEqual({ person: 9, scenario: "shots-fired", scenarioSeed: 11 });
    expect(task.evidence).not.toHaveProperty("venue");
  });

  test("every staged family refuses a plain base day and the wrong kind of event", async () => {
    expect(STAGED_GENERATORS).toEqual([...RTI_GENERATORS, ...DT_GENERATORS]);
    for (const generator of STAGED_GENERATORS) {
      await expect(generator.generate(context(undefined), new Rng(1), 1)).rejects.toThrow("no scenario");
    }
    await expect(generatorByFamily.get("explosion")!.generate(context(shooting), new Rng(1), 1)).rejects.toThrow("0 explosion events");
  });
});

describe("protest and gathering", () => {
  const protest: ScenarioHeader = {
    format: "KIERSTON_SCENARIO", version: 1, name: "protest", seed: 3, actors: {}, places: { square: "way/5" },
    groups: { marchers: Array.from({ length: 30 }, (_, i) => 100 + i), bystanders: [1, 2, 3, 4] },
    events: [{ id: "protest", kind: "protest", lat: 40.6, lon: -75.47, place: "way/5", radiusMetres: 200, start: 1050, end: 1215 }],
  };

  test("protest members are the surviving marchers, mid-event", async () => {
    const task = await generatorByFamily.get("protest-members")!.generate(context(protest, { "way/5": "Cedar Beach Park" }), new Rng(3), 8);
    expect(task.answer.kind).toBe("id-set");
    expect((task.groundTruth as { members: number[] }).members).toHaveLength(30);
    expect((task.groundTruth as { bystanders: number }).bystanders).toBe(4);
    const now = String(task.evidence.now);
    const minute = Number(now.slice(0, 2)) * 60 + Number(now.slice(3));
    expect(minute).toBeGreaterThanOrEqual(1110);
    expect(minute).toBeLessThanOrEqual(1145);
    expect(task.prompt).toContain("since about 17:30");
  });

  test("a gathering task quotes nothing but the time and records the crowd's centre", async () => {
    const header: ScenarioHeader = { ...protest, name: "mass-gathering", groups: { crowd: Array.from({ length: 90 }, (_, i) => i) },
      events: [{ id: "g", kind: "gathering", lat: 40.62, lon: -75.45, place: null, radiusMetres: 150, start: 900, end: 1000 }] };
    const task = await generatorByFamily.get("mass-gathering")!.generate(context(header), new Rng(4), 9);
    expect(Object.keys(task.evidence)).toEqual(["now"]);
    expect(task.groundTruth).toMatchObject({ lat: 40.62, lon: -75.45, size: 90 });
    expect(task.answer.kind).toBe("point");
    expect(task.scoring).toMatchObject({ method: "distance", params: { placeCreditMetres: 250 } });
    expect(task.prompt).toContain("50 or more people");
  });

  test("a crowd too small to be a mass gathering does not make a task", async () => {
    const header: ScenarioHeader = { ...protest, groups: { crowd: Array.from({ length: 49 }, (_, i) => i) },
      events: [{ id: "g", kind: "gathering", lat: 40.62, lon: -75.45, place: null, radiusMetres: 150, start: 900, end: 1000 }] };
    await expect(generatorByFamily.get("mass-gathering")!.generate(context(header), new Rng(4), 9)).rejects.toThrow("too small");
  });
});

describe("abduction", () => {
  const abduction: ScenarioHeader = {
    format: "KIERSTON_SCENARIO", version: 1, name: "abduction", seed: 23,
    actors: { victim: 300, driver: 301 }, places: { venue: "node/9", kerb: null }, groups: { accomplices: [302, 303], witness: [310], police: [900] },
    vehicles: { car: "1HGCM82633A004352" }, choices: { venue: "bar", crew: "three" },
    events: [{ id: "taken", kind: "abduction", lat: 40.61, lon: -75.48, place: null, radiusMetres: 150, start: 1158, end: 1162 }],
    handsetsLeft: [{ person: 300, from: 1160, at: { lat: 40.61, lon: -75.48 }, outdoors: true }],
  };

  test("the whole crew is the answer, the car and the victim ride along in the truth, and the prompt names the victim", async () => {
    const task = await generatorByFamily.get("abduction")!.generate(context(abduction), new Rng(2), 5);
    expect(task.answer).toEqual({ kind: "ranked-ids", identifier: "person", description: expect.stringContaining("took the victim") });
    expect(task.groundTruth).toEqual({ people: [301, 302, 303], driver: 301, vehicle: { vin: "1HGCM82633A004352", plate: "KRS 4471" },
      victim: 300, witness: 310, scenario: "abduction", scenarioSeed: 23, choices: { venue: "bar", crew: "three" } });
    expect(task.prompt).toContain("saw a person forced into a car near the street at (40.61, -75.48)");
    expect(task.prompt).toContain("between 19:18 and 19:22");
    expect(task.prompt).toContain("identified as Caller 300 Test, date of birth 1990-01-02, phone (610) 555-0300.");
    expect(task.prompt).not.toMatch(/\bperson\s+\d+\b/i);
    expect(task.evidence.victim).toEqual({ name: "Caller 300 Test", dob: "1990-01-02", phone: "(610) 555-0300" });
    expect(task.prompt).not.toContain("KRS 4471");
    const now = String(task.evidence.now);
    const minute = Number(now.slice(0, 2)) * 60 + Number(now.slice(3));
    expect(minute).toBeGreaterThanOrEqual(1170);
    expect(minute).toBeLessThanOrEqual(1177);
    expect(task.kdiPolicy?.cutoff).toBe(cityInstant("2026-09-04", minute, "America/New_York"));
  });

  test("a relative on the line is reported as such, and a day without the car does not make a task", async () => {
    const kin: ScenarioHeader = { ...abduction, actors: { ...abduction.actors, kin: 320 }, groups: { accomplices: [302], police: [900] } };
    const task = await generatorByFamily.get("abduction")!.generate(context(kin), new Rng(2), 5);
    expect(task.prompt).toContain("the line went dead");
    expect((task.groundTruth as { people: number[]; kin: number }).people).toEqual([301, 302]);
    expect((task.groundTruth as { kin: number }).kin).toBe(320);
    await expect(generatorByFamily.get("abduction")!.generate(context({ ...abduction, vehicles: {} }), new Rng(2), 5)).rejects.toThrow("binds no car");
  });
});

describe("deception tasks", () => {
  const stabbing: ScenarioHeader = {
    format: "KIERSTON_SCENARIO", version: 1, name: "stabbing-alibi", seed: 21,
    actors: { boyfriend: 501, girlfriend: 502 }, places: { lunch: "node/7", shops: "node/8" }, groups: { police: [900, 901] },
    events: [{ id: "stabbing", kind: "stabbing", lat: 40.6, lon: -75.47, place: null, radiusMetres: 100, start: 1220, end: 1238 }],
  };

  test("the reporting boyfriend is the answer, and the prompt tells his story without comment", async () => {
    const task = await generatorByFamily.get("stabbing")!.generate(context(stabbing), new Rng(5), 12);
    expect(task.groundTruth).toEqual({ person: 501, victim: 502, scenario: "stabbing-alibi", scenarioSeed: 21 });
    expect(task.prompt).toContain("At 20:38 today a man called 911 from the residence at (40.6, -75.47). He said");
    expect(task.prompt).toContain("- caller: Caller 501 Test, date of birth 1990-01-02, phone (610) 555-0501");
    expect(task.prompt).toContain("- deceased: Caller 502 Test, date of birth 1990-01-02, phone (610) 555-0502");
    expect(task.prompt).not.toMatch(/lie|deception|alibi|stabbing/i);
    expect(task.answer.kind).toBe("ranked-ids");
    expect(task.evidence).toMatchObject({ reportedAt: "20:38" });
    expect(task.evidence).not.toHaveProperty("incident");
    expect((task.evidence.people as { role: string }[]).map((person) => person.role).sort()).toEqual(["caller", "deceased"]);
    expect(task.evidence).not.toHaveProperty("window");
    const now = String(task.evidence.now);
    const minute = Number(now.slice(0, 2)) * 60 + Number(now.slice(3));
    expect(minute).toBeGreaterThanOrEqual(1263);
    expect(minute).toBeLessThanOrEqual(1278);
    expect(task.kdiPolicy?.cutoff).toBe(cityInstant("2026-09-04", minute, "America/New_York"));
    expect(JSON.stringify({ ...task.evidence, people: undefined })).not.toContain("501");
  });

  const neverArrived: ScenarioHeader = {
    format: "KIERSTON_SCENARIO", version: 1, name: "never-arrived", seed: 24,
    actors: { partner: 701, missing: 702, relative: 703 }, places: {}, groups: { police: [900] }, vehicles: { car: "VIN701" },
    events: [{ id: "missing", kind: "disappearance", lat: 40.62, lon: -75.49, place: null, radiusMetres: 100, start: 1085, end: 1260 }],
  };

  test("the reporting partner is the answer, and the missing woman is identified the way he is", async () => {
    const task = await generatorByFamily.get("disappearance")!.generate(context(neverArrived), new Rng(7), 14);
    expect(task.groundTruth).toEqual({ person: 701, missing: 702, relative: 703, scenario: "never-arrived", scenarioSeed: 24 });
    expect(task.prompt).toContain("At 21:00 today a man called 911 from the residence at (40.62, -75.49) to report his girlfriend missing.");
    expect(task.prompt).toContain("- caller: Caller 701 Test");
    expect(task.prompt).toContain("- missing woman: Caller 702 Test");
    expect(task.prompt).toContain("- person she set off to visit: Caller 703 Test");
    expect(task.prompt).toContain("left home alone at about 18:05");
    expect(task.prompt).not.toMatch(/lie|deception|alibi|car|handset|incident/i);
    expect(task.prompt).toContain("Either give where she is now or, if you conclude that a crime is involved, rank the people most likely responsible");
    expect(task.answer.kind).toBe("record");
    expect(Object.keys(task.answer.fields!)).toEqual(["location", "suspects"]);
    expect(Object.values(task.answer.fields!).every((field) => field.optional)).toBe(true);
    expect(task.scoring).toMatchObject({ method: "record", params: { fields: { suspects: "rank" } } });
    expect(task.evidence).toMatchObject({ reportedAt: "21:00" });
    expect(task.evidence).not.toHaveProperty("incident");
    expect((task.evidence.people as { name: string }[]).map((person) => person.name).sort())
      .toEqual(["Caller 701 Test", "Caller 702 Test", "Caller 703 Test"]);
  });

  const swatting: ScenarioHeader = {
    format: "KIERSTON_SCENARIO", version: 1, name: "swatting", seed: 22,
    actors: { caller: 610 }, places: {}, groups: { occupant: [600], police: [900] },
    events: [{ id: "report", kind: "swatting", lat: 40.61, lon: -75.48, place: null, radiusMetres: 100, start: 1230, end: 1231 }],
  };

  test("the caller is the answer", async () => {
    const task = await generatorByFamily.get("swatting")!.generate(context(swatting), new Rng(6), 13);
    expect(task.groundTruth).toEqual({ person: 610, occupant: 600, scenario: "swatting", scenarioSeed: 22 });
    expect(task.prompt).toContain("At 20:30 today a caller told 911 that a man with a handgun had just forced his way into the residence at (40.61, -75.48)");
    expect(task.prompt).toContain("- caller: Caller 610 Test, date of birth 1990-01-02, phone (610) 555-0610");
    expect(task.prompt).toContain("- occupant of the residence: Caller 600 Test");
    expect(task.prompt).not.toMatch(/swatting/i);
    expect(task.evidence).not.toHaveProperty("incident");
    const minute = Number(String(task.evidence.now).slice(0, 2)) * 60 + Number(String(task.evidence.now).slice(3));
    expect(minute).toBeGreaterThanOrEqual(1237);
    expect(minute).toBeLessThanOrEqual(1245);
  });

  test("the caller's place in the list of people varies with the seed", async () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 16; seed += 1) {
      const task = await generatorByFamily.get("swatting")!.generate(context(swatting), new Rng(seed), seed);
      firsts.add((task.evidence.people as { role: string }[])[0]!.role);
    }
    expect([...firsts].sort()).toEqual(["caller", "occupant of the residence"]);
  });

  test("a staged day that binds no caller does not make a deception task", async () => {
    await expect(generatorByFamily.get("swatting")!.generate(context({ ...swatting, actors: {} }), new Rng(6), 13)).rejects.toThrow();
  });
});

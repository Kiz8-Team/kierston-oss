import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDayContext, SimulationState, checkpointFromKday, dispatchFor, products, network, comms, economy, shared, transport, world,
  type DayContext } from "../../kierston/sim/src/index.ts";
import { scenario, applyScenario, materializeScenario, readDelta, ScenarioBuilder, sitePlace, type ApplyOptions, type PersonFilter, type Place } from "../src/index.ts";
import { PersonRecords } from "../src/authoring/records.ts";
import { Baseline } from "../src/replay/baseline.ts";
import { personColumns } from "../src/storage/columns.ts";
import { replayJointActions } from "../src/replay/joint.ts";
import type { Realized } from "../src/replay/movement.ts";

let directory: string, input: string, context: DayContext, ids: number[], cohort: number[], cafe: string;
let sharedDrivers: [number, number];
/** A cohabiting couple with a partner tie and carrier voice on both sides, for the deception primitives. */
let couple: [number, number];
const date = shared.parseDate("2026-08-23");
/** Skipped, not failed, on a checkout without a built city. */
const CITY = world.simDataPresent("towers.json", "devices.json", "accounts.json", "holdings.bin", "vehicles.json");
async function applyAndMaterialize(options: ApplyOptions & { input: string; output: string }) {
  const delta = `${options.output}.kdiff`;
  const report = await applyScenario({ ...options, output: delta });
  expect(report.format).toBe("KDIF");
  await materializeScenario({ input: options.input, delta, output: options.output });
  return report;
}
beforeAll(async () => {
  if (!CITY) return;
  directory = await mkdtemp(join(tmpdir(), "kierston-scenarios-test-"));
  input = join(directory, "base.bin");
  context = await loadDayContext();
  context.network = await network.Network.open();
  context.comms = await comms.Comms.open(context.network.subscribers, context.ties);
  context.bank = economy.Bank.load();
  ids = [...context.world.persons.values()].filter((person) => person.age >= 25 && person.age <= 55
    && transport.modeOf(person) === "car" && context.comms!.accounts.on(person.id, comms.channelOf("whatsapp"))
    && context.bank!.position(person.id).cards.some((card) => card.kind === "debit")
    && context.world.households.get(person.household)?.dwelling).slice(0, 8).map((person) => person.id);
  expect(ids).toHaveLength(8);
  const households = new Map<number, typeof context.world.persons extends Map<number, infer P> ? P[] : never>();
  for (const person of context.world.persons.values()) {
    const mine = households.get(person.household) ?? [];
    mine.push(person); households.set(person.household, mine);
  }
  const pair = [...households.values()].find((members) => members.length === 2
    && members.every((person) => transport.modeOf(person) === "car")
    && (context.world.householdVehicles.get(members[0]!.household)?.length ?? 0) > 0
    && context.world.households.get(members[0]!.household)?.dwelling);
  expect(pair).toBeDefined();
  sharedDrivers = [pair![0]!.id, pair![1]!.id];
  cafe = context.venues.all("cafe")[0]!.id;
  const drivers = transport.onDuty(context.world, date, shared.dayNumber(date), context.stands ?? []).cabs.map((cab) => cab.person);
  const passengers = [...context.world.persons.values()].filter((person) => person.transport === "7").map((person) => person.id);
  // A crowd for the group tests: residents living near the cafe, and every
  // patrol officer so a unit is on the road to respond.
  const cafePoint = context.venues.get(cafe)!;
  const locals = [...context.world.persons.values()].filter((person) => person.age >= 18 && person.age <= 60
    && !ids.includes(person.id) && context.world.households.get(person.household)?.dwelling
    && transport.haversineKm(cafePoint, world.homeOf(context.world, person)!) <= 3).slice(0, 90).map((person) => person.id);
  const officers = [...context.world.assignments.values()].filter((row) => row.role === "police_officer" || row.occupation === "police_officer")
    .map((row) => row.person);
  const partnerKind = context.ties.header.kinds.indexOf("partner");
  const voice = comms.channelOf("voice");
  const partnered = [...context.world.persons.values()].find((person) => person.sex === 1 && person.age >= 21 && person.age <= 55
    && !ids.includes(person.id) && !sharedDrivers.includes(person.id) && context.comms!.accounts.on(person.id, voice)
    && context.world.households.get(person.household)?.dwelling
    && context.ties.forPerson(person.id).some((contact) => contact.kind === partnerKind && !context.ties.external(contact.other)
      && context.world.persons.get(contact.other)?.household === person.household && context.world.persons.get(contact.other)?.sex === 2
      && context.comms!.accounts.on(contact.other, voice)));
  expect(partnered).toBeDefined();
  const partner = context.ties.forPerson(partnered!.id).find((contact) => contact.kind === partnerKind
    && context.world.persons.get(contact.other)?.household === partnered!.household && context.world.persons.get(contact.other)?.sex === 2)!;
  couple = [partnered!.id, partner.other];
  cohort = [...new Set([...ids, ...sharedDrivers, ...couple, ...drivers, ...passengers, ...locals, ...officers])];
  const people = new Map(cohort.map((id) => [id, context.world.persons.get(id)!]));
  const exporting = { ...context, world: { ...context.world, persons: people } };
  exporting.state = SimulationState.cold(date, exporting.bank);
  exporting.fleet = dispatchFor(exporting, date, shared.dayNumber(date));
  await products.exportDay(exporting, date, input);
}, 180_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function cafePointOf(ctx: DayContext, id: string) { const venue = ctx.venues.get(id)!; return { lat: venue.lat, lon: venue.lon }; }

describe.skipIf(!CITY)("scenario replay against a real engine export", () => {
  test("adaptive timing includes restored car bookings before a gathering resumes", async () => {
    const file = await products.KdayFile.open(input);
    try {
      const baseline = await Baseline.open(file, context);
      await baseline.preload();
      const scene = new ScenarioBuilder("adaptive-resume", 12, context, new Set(baseline.people.keys()), baseline.vehicles, baseline);
      const hall = scene.selectPlace("hall", { id: cafe });
      const crowd = scene.selectPeople("crowd", { age: { min: 18, max: 60 }, homeNear: hall, withinKm: 3 }, { count: 12 });
      const gathered = crowd.gather("arrival", { at: hall, departAt: 600 });
      const schedule = await crowd.resumeAfter("leave", gathered.start, { for: "75m", spread: { for: "25m" } });
      const realized = new Map<string, Realized>();
      await replayJointActions(context, baseline, new Map(crowd.members.map((actor) => [actor.id, actor.windows])),
        scene.actions, date, realized);
      const arrivals = [...realized].filter(([id]) => /^arrival\/\d+$/.test(id)).map(([, result]) => result.arrival);
      expect(arrivals.length).toBeGreaterThan(0);
      expect(Math.max(...arrivals)).toBeLessThanOrEqual(schedule.start);
      expect(schedule.end).toBeGreaterThanOrEqual(schedule.start + 75);
      expect(schedule.end).toBeLessThan(1440);
    } finally { await file.close(); }
  });

  test("adaptive timing resolves routed group arrivals without mutating windows", async () => {
    const file = await products.KdayFile.open(input);
    try {
      const baseline = await Baseline.open(file, context);
      await baseline.preload();
      const scene = new ScenarioBuilder("adaptive", 12, context, new Set(baseline.people.keys()), baseline.vehicles, baseline);
      const hall = scene.selectPlace("hall", { id: cafe });
      const crowd = scene.selectPeople("crowd", { age: { min: 18, max: 60 }, homeNear: hall, withinKm: 3 }, { count: 4 });
      const gathered = crowd.gather("arrival", { at: hall, departAt: 0, mode: "walk", onInfeasible: "fail" });
      const before = JSON.stringify(crowd.members.map((actor) => actor.windows));
      const arrived = await scene.after(gathered.start);
      expect(arrived).toBeGreaterThan(0);
      expect(arrived).toBeLessThan(1440);
      expect(JSON.stringify(crowd.members.map((actor) => actor.windows))).toBe(before);
      const hold = crowd.wait("hold", { at: arrived, for: "15m" });
      expect(await scene.after(hold.end)).toBe(arrived + 15);
      expect(await scene.after(hold.end)).toBe(arrived + 15);
      scene.event("incident", { kind: "test", at: hall, start: arrived, end: arrived + 15 });
      expect(scene.events[0]!.start).toBe(arrived);
    } finally { await file.close(); }
  });

  test("adaptive timing refuses a physical action crossing midnight", async () => {
    const file = await products.KdayFile.open(input);
    try {
      const baseline = await Baseline.open(file, context);
      await baseline.preload();
      const scene = new ScenarioBuilder("adaptive-boundary", 1, context, new Set(baseline.people.keys()), baseline.vehicles, baseline);
      const actor = scene.selectPerson("actor", { id: ids[0]! });
      actor.ensureWindow(0, 1440);
      const hold = scene.wait("past-midnight", { people: [actor], atCurrent: true, startAt: 1439, for: "2m" });
      await expect(scene.after(hold.end)).rejects.toThrow("crosses midnight");
    } finally { await file.close(); }
  }, 60_000);

  test("adaptive timing rebuilds an async schedule earlier when it crosses midnight", async () => {
    const starts: boolean[] = [];
    const output = join(directory, "adaptive-retry.kdiff");
    const definition = scenario("adaptive-retry", async (scene) => {
      await Promise.resolve();
      starts.push(scene.earlyStart);
      const at = scene.earlyStart ? 0 : 1439;
      scene.event("incident", { kind: "test", at: scene.selectPlace("hall", { id: cafe }), start: at, end: at + 2 });
    });
    const report = await applyScenario({ scenario: definition, input, output, seed: 12, context });
    expect(starts).toEqual([false, true]);
    expect(report.seed).toBe(12);
    expect((await readDelta(output)).date).toBe("2026-08-23");
  }, 60_000);

  test("the export carries independently authenticated opening and closing checkpoints", async () => {
    const file = await products.KdayFile.open(input);
    try {
      expect(file.header.version).toBe(16);
      const opening = await checkpointFromKday(input, "opening"), closing = await checkpointFromKday(input);
      expect(opening.nextDate).toBe("2026-08-23");
      expect(closing.nextDate).toBe("2026-08-24");
      expect(opening.completedDays).toBe(0);
      expect(closing.completedDays).toBe(1);
      expect(opening.bank).toHaveLength(cohort.length);
      expect(closing.persons).toHaveLength(cohort.length);
    } finally { await file.close(); }
  });

  test("empty scenario preserves every column and both checkpoints", async () => {
    const output = join(directory, "empty.bin");
    const before = await products.fileDigest(input);
    const definition = scenario({ name: "empty", input, output: `${output}.kdiff`, seed: 1 }, () => {});
    const report = await applyScenario({ scenario: definition, context });
    await materializeScenario({ input, delta: report.output, output });
    expect(report.affected).toEqual([]);
    const delta = await readDelta(`${output}.kdiff`);
    expect(delta.columns).toEqual([]);
    expect(delta.opening).toBeUndefined();
    expect(delta.closing).toBeUndefined();
    expect(delta.baseHash).toBe(before);
    expect(await products.fileDigest(input)).toBe(before);
    expect(Bun.file(`${output}.kdiff`).size).toBeLessThan(Bun.file(input).size / 20);
    const a = await products.KdayFile.open(input), b = await products.KdayFile.open(output);
    try { for (const name of a.names()) {
      const left = await a.column(name), right = await b.column(name);
      expect(Buffer.from(right.buffer, right.byteOffset, right.byteLength).equals(Buffer.from(left.buffer, left.byteOffset, left.byteLength))).toBe(true);
    } }
    finally { await a.close(); await b.close(); }
    expect(await checkpointFromKday(output, "opening")).toEqual(await checkpointFromKday(input, "opening"));
    expect(await checkpointFromKday(output)).toEqual(await checkpointFromKday(input));
  }, 120_000);

  test("explicit run options override script defaults in the output metadata", async () => {
    const output = join(directory, "overrides.kdiff");
    const definition = scenario({ name: "override", input: "missing.bin", output: "unused.kdiff", seed: 42, maxAffected: 8 }, () => {});
    const report = await applyScenario({ scenario: definition, input, output, seed: 0, maxAffected: 1, context });
    expect(report.output).toBe(output);
    expect(report.seed).toBe(0);
    const day = join(directory, "overrides.bin");
    await materializeScenario({ input, delta: output, output: day });
    const file = await products.KdayFile.open(day);
    try { expect(file.header.scenario).toMatchObject({ name: "override", seed: 0, maxAffected: 1 }); }
    finally { await file.close(); }
    expect(definition.seed).toBe(42);
  }, 120_000);

  test("movement, messaging, calls and purchases share the engine and preserve outsiders", async () => {
    const definition = scenario("coffee", (s) => {
      const actor = s.selectPerson("actor", { id: ids[0] });
      const contact = s.selectPerson("contact", { id: ids[1] });
      actor.replaceWindow("00:00", "24:00");
      const place = s.place(cafe);
      const visit = actor.goto("visit", place, { departAt: "12:00", stayFor: "60m", mode: "car" });
      actor.text("hello", contact, { at: visit.arrival.plus("2m"), platform: "whatsapp", replies: true });
      actor.text("sms", contact, { at: visit.arrival.plus("3m"), platform: "sms", bytes: 200, replies: false });
      actor.call("call", contact, { at: visit.arrival.plus("4m"), outcome: "answered", duration: "2m", replies: false });
      actor.purchase("coffee", { at: visit.arrival.plus("10m"), venue: place, channel: "in_person", amount: 4.25, instrument: "debit" });
      actor.purchase("online", { at: visit.arrival.plus("20m"), channel: "online", merchant: { name: "Scenario Online Store", mcc: 5942 }, amount: 12.34, instrument: "debit" });
      actor.goto("home", actor.home, { departAt: visit.departure, mode: "car" });
    });
    const output = join(directory, "coffee.bin"), repeat = join(directory, "repeat.bin");
    const before = await products.fileDigest(input);
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 42, context });
    expect(await products.fileDigest(input)).toBe(before);
    expect(Bun.file(report.output).size).toBeLessThan(Bun.file(output).size / 10);
    console.log(`Scenario storage: base=${Bun.file(input).size}, coffee delta=${Bun.file(report.output).size}, materialized=${Bun.file(output).size} bytes`);
    expect(report.actions).toHaveLength(7);
    expect(report.affected.map((row) => row.person)).toEqual([ids[0]!, ids[1]!].sort((a, b) => a - b));
    expect(report.actions.find((a) => a.id === "coffee")!.result.approved).toBe(true);
    const a = await products.KdayFile.open(input), b = await products.KdayFile.open(output);
    try {
      const person = Array.from(await a.column("person.id"));
      for (const id of ids.slice(2)) {
        expect(await personColumns(b, person.indexOf(id))).toEqual(await personColumns(a, person.indexOf(id)));
      }
      const baseState = await checkpointFromKday(input), state = await checkpointFromKday(output);
      for (const id of ids.slice(2)) {
        expect(state.persons.find((row) => row.person === id)).toEqual(baseState.persons.find((row) => row.person === id));
        expect(state.bank.find((row) => row.person === id)).toEqual(baseState.bank.find((row) => row.person === id));
      }
      const sms = await b.table("sms"), cdr = await b.table("cdr");
      const messageIds = report.actions.find((a) => a.id === "hello")!.result.messages as number[];
      expect(Array.from(sms.message!).some((id) => messageIds.includes(id))).toBe(false);
      const smsIds = report.actions.find((a) => a.id === "sms")!.result.messages as number[];
      expect(Array.from(sms.message!).filter((id) => smsIds.includes(id))).toHaveLength(2);
      const callIds = report.actions.find((a) => a.id === "call")!.result.calls as number[];
      expect(Array.from(cdr.call!).filter((id) => callIds.includes(id))).toHaveLength(1);
      const calls = await b.table("call"), spans = await b.table("span");
      const cdrRow = Array.from(cdr.call!).findIndex((id) => callIds.includes(id));
      const callMinute = Math.floor(calls.at![cdr.call![cdrRow]!]! / 60);
      const serving = Array.from(spans.start!).findIndex((start, i) => spans.subscriber![i] === cdr.from![cdrRow]
        && start <= callMinute && callMinute < spans.end![i]!);
      expect(serving).toBeGreaterThanOrEqual(0);
      expect(cdr.originCell![cdrRow]).toBe(spans.cell![serving]);
      const oldTruth = await a.table("alprTruth"), truth = await b.table("alprTruth");
      const resultLegs = await b.table("leg");
      const basePeople = await a.table("person");
      const actorRow = person.indexOf(ids[0]!);
      const firstLeg = basePeople.legOffset![actorRow]!, lastLeg = firstLeg + basePeople.legCount![actorRow]!;
      const retained = new Set(Array.from(truth.correlationId!));
      for (let i = 0; i < oldTruth.leg!.length; i++) {
        const replaced = oldTruth.source![i] === 0 && oldTruth.leg![i]! >= firstLeg && oldTruth.leg![i]! < lastLeg;
        expect(retained.has(oldTruth.correlationId![i]!)).toBe(!replaced);
      }
      const oldPasses = new Set(Array.from(oldTruth.correlationId!));
      for (let i = 0; i < truth.leg!.length; i++) if (!oldPasses.has(truth.correlationId![i]!)) {
        expect(truth.source![i]).toBe(0);
        expect(b.string(resultLegs.journey![truth.leg![i]!]!)).toMatch(/^scenario\//);
      }
      expect(Array.from(await b.column("leg.journey"), (id) => b.string(id)).some((id) => id?.startsWith("scenario/visit"))).toBe(true);
      expect(b.header.scenario).toBeDefined();
      expect(await checkpointFromKday(output, "opening")).toEqual(await checkpointFromKday(input, "opening"));
    } finally { await a.close(); await b.close(); }
    await applyAndMaterialize({ input, output: repeat, scenario: definition, seed: 42, context });
    expect(await products.fileDigest(output)).toBe(await products.fileDigest(repeat));
    expect(await products.fileDigest(`${output}.kdiff`)).toBe(await products.fileDigest(`${repeat}.kdiff`));
  }, 120_000);

  test("selection streams are stable and constraints never silently widen", () => {
    const first = new ScenarioBuilder("selection", 9, context, new Set(ids));
    const a = first.selectPerson("actor", { age: { min: 25, max: 55 } });
    const second = new ScenarioBuilder("selection", 9, context, new Set(ids));
    second.selectPlace("unrelated-place", { type: "cafe" });
    expect(second.selectPerson("actor", { age: { min: 25, max: 55 } }).id).toBe(a.id);
    expect(() => first.selectPerson("impossible", { age: 200 })).toThrow("no residents");
    expect(() => first.selectPlace("nowhere", { type: "cafe", near: a.home, withinKm: 0.000001 })).toThrow("no places");
    expect(() => first.selectPerson("actor", {})).toThrow("duplicate role");
    expect(first.selectPlace("lot", { type: "parking_lot" }).id).toMatch(/^poi\//);
    first.wait("nearby-wait", { people: [a], near: a.home, minDistance: "50m", within: "200m",
      kinds: ["street"], startAt: "12:00", for: "10m" });
    const waiting = first.actions.find((action) => action.id === "nearby-wait")!;
    expect(waiting.kind).toBe("wait");
    if (waiting.kind === "wait") {
      const metres = transport.haversineKm(a.home, waiting.place) * 1000;
      expect(metres).toBeGreaterThanOrEqual(49); expect(metres).toBeLessThanOrEqual(201);
    }
  });

  test("person selection reads firearms, criminal history and prescriptions", () => {
    const everyone = new Set(context.world.persons.keys());
    const scene = new ScenarioBuilder("records", 3, context, everyone);
    const records = PersonRecords.shared();
    const pick = (role: string, filter: PersonFilter) => {
      const actor = scene.selectPerson(role, filter);
      expect(records.matcher(role, filter)!(actor.id)).toBe(true);
      return actor;
    };
    const owner = pick("owner", { firearms: { owns: true, type: "handgun", prohibited: false } });
    expect(records.matcher("check", { firearms: { owns: false } })!(owner.id)).toBe(false);
    pick("barred", { firearms: { prohibited: true }, criminal: { felonyConvicted: true } });
    const dui = pick("dui", { criminal: { convictedOf: "3802" } });
    expect(records.matcher("check", { criminal: { charged: "mv_other", cases: { min: 1, max: 999 } } })!(dui.id)).toBe(true);
    pick("clean", { criminal: { cases: 0 }, prescriptions: { holds: false } });
    pick("opioid", { prescriptions: { drugClass: "opioid", schedule: "II" }, criminal: { supervision: false } });

    expect(() => scene.selectPerson("typo", { prescriptions: { drug: "oxycodon" } })).toThrow("unknown prescriptions.drug");
    expect(() => scene.selectPerson("typo", { criminal: { charged: "arson-ish" } })).toThrow("unknown criminal.charged");
    expect(() => scene.selectPerson("typo", { firearms: { owns: false, type: "long_gun" } })).toThrow("contradicts");
    expect(() => scene.selectPerson("typo", { criminal: { supervision: [] } })).toThrow("must not be empty");
  });

  test("sites, seeded picks, staff filters and presence filters select deterministically", async () => {
    const everyone = new Set(context.world.persons.keys());
    const scene = new ScenarioBuilder("sites", 2, context, everyone);
    const hospital = scene.selectSite("target", { class: "hospital", minCapacity: 60 });
    expect(hospital.kind).toBe("venue");
    expect(hospital.id).toMatch(/^(way|node|relation)\//);
    expect(scene.sites({ class: "hospital", minCapacity: 60 }).some((site) => site.id === hospital.id)).toBe(true);
    expect(scene.sites({ class: "school" }).length).toBeGreaterThan(10);
    expect(scene.sites({ class: "school", near: hospital, withinKm: 1.5 }).every((site) => transport.haversineKm(site, hospital) <= 1.5)).toBe(true);
    expect(() => scene.selectSite("none", { class: "hospital", minCapacity: 1_000_000 })).toThrow("no sites");
    expect(() => scene.selectSite("target", { class: "school" })).toThrow("duplicate place role");
    expect(new ScenarioBuilder("sites", 2, context, everyone).selectSite("target", { class: "hospital", minCapacity: 60 }).id).toBe(hospital.id);

    const branch = scene.pick("aftermath", ["flee", "blend", "perish"]);
    expect(["flee", "blend", "perish"]).toContain(branch);
    expect(new ScenarioBuilder("sites", 2, context, everyone).pick("aftermath", ["flee", "blend", "perish"])).toBe(branch);
    expect(scene.choices.get("aftermath")).toBe(branch);
    expect(() => scene.pick("aftermath", ["x"])).toThrow("duplicate choice");
    expect(() => scene.pick("empty", [])).toThrow("distinct options");

    // A site with staff: everyone the register posts there, and nobody else.
    const staffed = [...context.world.assignments.values()].find((row) => row.site && everyone.has(row.person)
      && [...context.world.assignments.values()].filter((other) => other.site === row.site).length >= 3)!;
    expect(staffed).toBeDefined();
    const site = scene.sites({ id: staffed.site! })[0];
    const staffFilter = { worksAt: staffed.site! };
    const total = scene.matching({});
    const staff = scene.matching(staffFilter), others = scene.matching({ notWorksAt: staffed.site! });
    expect(staff).toBeGreaterThanOrEqual(3);
    expect(staff + others).toBe(total);
    const worker = scene.selectPerson("worker", staffFilter);
    expect(context.world.assignments.get(worker.id)?.site).toBe(staffed.site);
    expect(context.world.assignments.get(scene.selectPerson("visitor", { notWorksAt: site ? sitePlace(site) : staffed.site! }).id)?.site).not.toBe(staffed.site);
    expect(() => scene.selectPerson("kerb", { worksAt: scene.near("kerb-point", { near: worker.home, within: "100m", kinds: ["street"] }) })).toThrow("needs a place with an id");
    expect(() => scene.selectPerson("unseen", { presentNear: { near: worker.home, at: "09:00" } })).toThrow("needs the base day");

    // Presence as a filter reads the recorded day, like `present` does.
    const file = await products.KdayFile.open(input);
    try {
      const baseline = await Baseline.open(file, context);
      await baseline.preload();
      const live = new ScenarioBuilder("presence", 4, context, new Set(baseline.people.keys()), undefined, baseline);
      await live.ready();
      const someone = context.world.persons.get(cohort[0]!)!;
      const home: Place = { ...world.homeOf(context.world, someone)!, id: null, kind: "home", label: "home" };
      const asleep = live.matching({ presentNear: { near: home, at: "03:00", within: "50m", atHome: true, asleep: true } });
      expect(asleep).toBeGreaterThanOrEqual(1);
      expect(live.matching({ presentNear: { near: home, during: ["03:00", "03:05"], within: "50m", atHome: true, asleep: true }, age: { min: 0, max: 200 } })).toBe(asleep);
      expect(live.selectPerson("sleeper", { presentNear: { near: home, at: "03:00", within: "50m", atHome: true, asleep: true }, id: someone.id }).id).toBe(someone.id);
      // `present` reaches bound people too; a filter never selects one twice.
      const there = live.present("there", { near: home, at: "03:00", within: "50m", atHome: true, asleep: true });
      expect(there.has(someone.id)).toBe(true);
      expect(there.size).toBe(asleep);
      // `requires` keeps only the people holding every named account.
      const reachable = live.present("reachable", { near: home, at: "03:00", within: "50m", atHome: true, asleep: true, requires: { platforms: ["voice"] } });
      expect(reachable.members.map((member) => member.id)).toEqual(there.members.map((member) => member.id)
        .filter((id) => context.comms!.accounts.on(id, comms.channelOf("voice"))));
      expect(live.matching({ presentNear: { near: home, at: "03:00", within: "50m", atHome: true, asleep: true } })).toBe(0);
      expect(() => live.selectPerson("bad", { presentNear: { near: home } })).toThrow("specify at or during");
    } finally { await file.close(); }
  }, 120_000);

  test("one VIN carries several people and can be handed to another driver", async () => {
    const definition = scenario("shared-private-car", (s) => {
      const alice = s.selectPerson("alice", { id: sharedDrivers[0] });
      const bob = s.selectPerson("bob", { id: sharedDrivers[1] });
      alice.replaceWindow("00:00", "24:00"); bob.replaceWindow("00:00", "24:00");
      const car = s.selectVehicle("car", { householdOf: alice });
      const parked = s.vehicles({ parkedNear: alice.home, at: "00:00", within: "100m" });
      if (!parked.some((candidate) => candidate.vin === car.vin)) throw new Error("household car missing from nearby lookup");
      const venue = s.place(cafe);
      const outbound = s.trip("outbound", {
        mode: "car", vehicle: car, driver: alice, passengers: [bob], to: venue, departAt: "12:00",
      });
      const visit = s.stay("visit", { people: [alice, bob], at: venue,
        startAt: outbound.arrival, for: "30m", purpose: "cafe" });
      const returned = s.trip("return", { mode: "car", vehicle: car, driver: bob, passengers: [alice],
        to: alice.home, departAt: visit.end });
      s.trip("walk", { mode: "walk", people: [alice, bob], to: venue,
        departAt: returned.arrival.plus("5m") });
    });
    const output = join(directory, "shared-car.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 17, context });
    expect(report.affected.map((row) => row.person).sort((a, b) => a - b)).toEqual([...sharedDrivers].sort((a, b) => a - b));
    const file = await products.KdayFile.open(output);
    try {
      const truth = file.header.scenario as { vehicles: { car: string } };
      const vin = truth.vehicles.car;
      const [people, legs, vehicles, spans] = await Promise.all([
        file.table("person"), file.table("leg"), file.table("vehicle"), file.table("vehicleSpan"),
      ]);
      const scenarioLegs: { person: number; row: number; mode: string; vehicle: string | null }[] = [];
      for (let person = 0; person < people.id!.length; person += 1) {
        for (let leg = people.legOffset![person]!; leg < people.legOffset![person]! + people.legCount![person]!; leg += 1) {
          const journey = file.string(legs.journey![leg]!);
          if (!journey?.startsWith("scenario/outbound") && !journey?.startsWith("scenario/return")) continue;
          scenarioLegs.push({ person: people.id![person]!, row: leg,
            mode: file.header.enums.mode![legs.mode![leg]!]!, vehicle: file.string(legs.vehicle![leg]!) });
        }
      }
      expect(scenarioLegs.filter((row) => row.mode === "car" && row.vehicle === vin)).toHaveLength(2);
      expect(scenarioLegs.filter((row) => row.mode === "passenger" && row.vehicle === null)).toHaveLength(2);
      expect(new Set(scenarioLegs.filter((row) => row.mode === "car").map((row) => row.person)))
        .toEqual(new Set(sharedDrivers));
      const walked = Array.from(legs.journey!, (id, row) => ({ row, journey: file.string(id), mode: file.header.enums.mode![legs.mode![row]!] }))
        .filter((row) => row.journey === "scenario/walk" && row.mode === "walk");
      expect(walked).toHaveLength(2);
      const vehicle = Array.from(vehicles.vin!).findIndex((id) => file.string(id) === vin);
      expect(vehicle).toBeGreaterThanOrEqual(0);
      const offset = vehicles.spanOffset![vehicle]!, count = vehicles.spanCount![vehicle]!;
      const moving = file.header.enums.vehicleSpanKind!.indexOf("moving");
      expect(Array.from(spans.kind!.subarray(offset, offset + count)).filter((kind) => kind === moving)).toHaveLength(2);
      const closing = await checkpointFromKday(output);
      const car = closing.vehicles.find((row) => row.id === vin)!;
      expect(transport.haversineKm(car.location!, context.world.places.get(context.world.households.get(
        context.world.persons.get(sharedDrivers[0])!.household)!.dwelling!)!)).toBeLessThan(0.1);
    } finally { await file.close(); }
  }, 120_000);

  test("one taxi trip carries several declared riders", async () => {
    const definition = scenario("shared-taxi", (s) => {
      const alice = s.selectPerson("alice", { id: sharedDrivers[0] });
      const bob = s.selectPerson("bob", { id: sharedDrivers[1] });
      alice.replaceWindow("00:00", "24:00"); bob.replaceWindow("00:00", "24:00");
      s.trip("ride", { mode: "taxi", riders: [alice, bob], requestedBy: alice,
        to: s.place(cafe), departAt: "12:00" });
    });
    const output = join(directory, "shared-taxi.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 21, context });
    expect(report.affected.some((row) => !sharedDrivers.includes(row.person))).toBe(true);
    const file = await products.KdayFile.open(output);
    try {
      const baseline = await Baseline.open(file, context);
      for (const person of sharedDrivers) {
        const day = await baseline.person(person);
        expect(day.day.legs.some((leg) => leg.journeyId === "scenario/ride" && leg.mode === "taxi")).toBe(true);
      }
    } finally { await file.close(); }
  }, 120_000);

  test("a priority taxi displaces an existing fare and includes its driver and passenger", async () => {
    const source = await products.KdayFile.open(input);
    let candidate: { driver: number; passenger: number; at: number; lat: number; lon: number } | undefined;
    try {
      const baseline = await Baseline.open(source, context);
      const [p, legs] = await Promise.all([source.table("person"), source.table("leg")]);
      const riders = new Map<string, number>();
      for (let row = 0; row < p.id!.length; row++) for (let i = p.legOffset![row]!; i < p.legOffset![row]! + p.legCount![row]!; i++) {
        if (source.header.enums.mode![legs.mode![i]!] === "taxi") riders.set(source.string(legs.journey![i]!)!, p.id![row]!);
      }
      for (const driver of transport.onDuty(context.world, date, shared.dayNumber(date), context.stands ?? []).cabs) {
        if (!baseline.people.has(driver.person)) continue;
        const recorded = await baseline.person(driver.person);
        for (const leg of recorded.day.legs) {
          const passenger = riders.get(leg.journeyId!);
          if (leg.mode === "cab" && leg.purpose === "fare" && passenger !== undefined && passenger !== ids[0]
              && leg.depart > 600 && leg.depart < 900) {
            candidate = { driver: driver.person, passenger, at: leg.depart, lat: leg.from.lat, lon: leg.from.lon };
            break;
          }
        }
        if (candidate) break;
      }
    } finally { await source.close(); }
    expect(candidate).toBeDefined();
    const selected = candidate!;
    const definition = scenario("taxi-preemption", (s) => {
      const actor = s.selectPerson("actor", { id: ids[0] });
      actor.replaceWindow("00:00", "24:00");
      const pickup = { id: null, kind: "kerb" as const, label: "rendezvous", lat: selected.lat, lon: selected.lon };
      // A minute before the fare starts the cab is still on its approach and
      // can be taken; from the fare's first minute it is carrying the
      // passenger, and a priority request never cuts a ride in progress.
      actor.goto("reach-pickup", pickup, { arriveAt: selected.at - 2, stayFor: 1, mode: "car" });
      actor.goto("priority-ride", s.place(cafe), { departAt: selected.at - 1, stayFor: "30m", mode: "taxi" });
    });
    const output = join(directory, "taxi.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 3, context });
    expect(report.affected.some((row) => row.person === selected.driver)).toBe(true);
    expect(report.affected.some((row) => row.person === selected.passenger)).toBe(true);
    const result = await products.KdayFile.open(output);
    try {
      const meta = result.header.scenario as { taxiCancellations: { driver: number; passenger: number }[] };
      expect(meta.taxiCancellations.some((row) => row.driver === selected.driver && row.passenger === selected.passenger)).toBe(true);
      const baseline = await Baseline.open(result, context);
      const actor = await baseline.person(ids[0]!), driver = await baseline.person(selected.driver);
      const passengerLeg = actor.day.legs.find((leg) => leg.journeyId === "scenario/priority-ride")!;
      const driverLeg = driver.day.legs.find((leg) => leg.journeyId === "scenario/priority-ride")!;
      expect(passengerLeg.mode).toBe("taxi"); expect(driverLeg.mode).toBe("cab");
      expect(passengerLeg.arrive).toBe(driverLeg.arrive);
      expect(passengerLeg.depart + passengerLeg.wait!).toBe(driverLeg.depart);
    } finally { await result.close(); }
  }, 120_000);

  test("a crowd gathers, some die, the rest run, phones are left behind, 911 is called and a unit responds", async () => {
    const definition = scenario("crowd", (s) => {
      const venue = s.place(cafe);
      const crowd = s.selectPeople("crowd", { age: { min: 18, max: 60 }, homeNear: venue, withinKm: 4 }, { count: 24 });
      expect(crowd.size).toBe(24);
      crowd.gather("meet", { at: venue, arriveAt: "18:30", spread: { for: "20m" }, purpose: "cafe", minCount: 8 });
      s.event("shots", { kind: "shooting", at: venue, start: "19:00", end: "19:03", radius: "150m" });
      const { dead, fleeing } = crowd.partition("fate", { dead: 0.2, fleeing: 0.8 });
      expect(dead.size + fleeing.size).toBe(24);
      dead.perish("killed", { at: "19:00", spread: { for: "2m", shape: "burst" } });
      const flight = fleeing.disperse("flight", { at: "19:00", spread: { for: "3m", shape: "burst" }, within: "400m",
        hideFor: "5m", then: "home", phoneLeft: 0.5 });
      fleeing.call("call-911", "911", { at: flight.start.plus("1m"), spread: { for: "3m" } });
      fleeing.call("call-family", "family", { at: "19:05", spread: { for: "5m" }, retries: 1 });
      const units = s.respond("police", { to: venue, at: "19:04", units: 1, holdFor: "40m", minUnits: 1 });
      expect(units.size).toBe(1);
    });
    const output = join(directory, "crowd.bin"), repeat = join(directory, "crowd-repeat.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 8, maxAffected: 400, context });
    expect(report.groups.crowd!.length).toBeGreaterThanOrEqual(8);
    expect(report.groups["fate/dead"]!.length).toBeGreaterThanOrEqual(1);
    expect(report.groups.police).toHaveLength(1);
    const dead = report.groups["fate/dead"]!, officer = report.groups.police![0]!;
    // A member who left their phone behind cannot place the call; replay skips it.
    const attempts911 = report.actions.filter((action) => action.id.startsWith("call-911/") && action.kind === "call");
    const calls911 = attempts911.filter((action) => action.result.skipped === undefined);
    expect(calls911.length).toBeGreaterThanOrEqual(1);
    const file = await products.KdayFile.open(output);
    try {
      const meta = file.header.scenario as { events: { id: string; kind: string }[]; deaths: { person: number; minute: number }[];
        handsetsLeft: { person: number; from: number; at: { lat: number; lon: number } }[]; mortality: { messagesRemoved: number; callsRemoved: number } };
      expect(meta.events).toEqual([expect.objectContaining({ id: "shots", kind: "shooting" })]);
      expect(meta.deaths.map((row) => row.person).sort((a, b) => a - b)).toEqual([...dead].sort((a, b) => a - b));
      expect(meta.handsetsLeft.length).toBeGreaterThanOrEqual(1);
      const [account, participant, conversation, call, cdr, message, people, legs, spans, cells, subscribers] = await Promise.all([
        file.table("account"), file.table("participant"), file.table("conversation"), file.table("call"), file.table("cdr"),
        file.table("message"), file.table("person"), file.table("leg"), file.table("span"), file.table("cell"), file.table("subscriber"),
      ]);
      // 911 is an account with no person behind it, and every call to it is answered and off-net in the CDR.
      const emergency = Array.from(account.person!).findIndex((person) => person === comms.EMERGENCY_PERSON);
      expect(emergency).toBeGreaterThanOrEqual(0);
      expect(file.string(account.handle![emergency]!)).toBe("911");
      for (const action of calls911) {
        const [index] = action.result.calls as number[];
        const thread = call.conversation![index!]!;
        const members = Array.from(participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + conversation.count![thread]!));
        expect(members).toContain(emergency);
        const record = Array.from(cdr.call!).indexOf(index!);
        expect(record).toBeGreaterThanOrEqual(0);
        expect(cdr.to![record]).toBe(-1);
        // Always answered, unless the caller's handset had no cell at that minute: then the network never set it up.
        const outcome = file.header.enums.callOutcome![call.outcome![index!]!];
        expect(outcome === "answered" || (outcome === "failed" && cdr.originCell![record] === -1)).toBe(true);
      }
      // The dead send nothing after they die, answer nothing, and do not move.
      const personRow = new Map(Array.from(people.id!, (id, row) => [id, row]));
      const deadAccounts = new Map<number, number>();
      for (const { person, minute } of meta.deaths) for (let i = 0; i < account.person!.length; i++) if (account.person![i] === person) deadAccounts.set(i, minute * 60);
      for (let i = 0; i < message.at!.length; i++) {
        const since = deadAccounts.get(message.from![i]!);
        if (since !== undefined) expect(message.at![i]!).toBeLessThan(since);
      }
      for (let i = 0; i < call.at!.length; i++) {
        const since = deadAccounts.get(call.from![i]!);
        if (since !== undefined) expect(call.at![i]!).toBeLessThan(since);
        const thread = call.conversation![i]!;
        const others = Array.from(participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + conversation.count![thread]!))
          .filter((member) => member !== call.from![i]);
        if (others.some((member) => (deadAccounts.get(member) ?? Infinity) <= call.at![i]!)) {
          expect(file.header.enums.callOutcome![call.outcome![i]!]).not.toBe("answered");
        }
      }
      for (const { person, minute } of meta.deaths) {
        const row = personRow.get(person)!;
        for (let i = people.legOffset![row]!; i < people.legOffset![row]! + people.legCount![row]!; i++) expect(legs.depart![i]!).toBeLessThan(minute);
      }
      // A handset left behind stays on a cell near the cafe while its owner's legs go home.
      const cellPoint = (index: number) => ({ lat: cells.latE6![index]! / 1e6, lon: cells.lonE6![index]! / 1e6 });
      for (const left of meta.handsetsLeft) {
        const subscriber = Array.from(subscribers.person!).findIndex((person) => person === left.person);
        if (subscriber < 0) continue;
        const late = Array.from(spans.start!).findIndex((start, i) => spans.subscriber![i] === subscriber && start <= 1400 && 1400 < spans.end![i]! && spans.cell![i]! >= 0);
        if (late < 0) continue;
        expect(transport.haversineKm(cellPoint(spans.cell![late]!), cafePointOf(context, cafe))).toBeLessThan(4);
      }
      // The responding unit drove its own patrol car to the scene and back to the yard for the recorded return.
      const officerRow = personRow.get(officer)!;
      const officerLegs = [] as { journey: string | null; mode: string; arrive: number }[];
      for (let i = people.legOffset![officerRow]!; i < people.legOffset![officerRow]! + people.legCount![officerRow]!; i++) {
        officerLegs.push({ journey: file.string(legs.journey![i]!), mode: file.header.enums.mode![legs.mode![i]!]!, arrive: legs.arrive![i]! });
      }
      expect(officerLegs.some((leg) => leg.journey?.startsWith("scenario/police/") && leg.mode === "patrol")).toBe(true);
      expect(officerLegs.some((leg) => leg.journey?.startsWith("scenario/rejoin/") && leg.mode === "patrol")).toBe(true);
    } finally { await file.close(); }
    await applyAndMaterialize({ input, output: repeat, scenario: definition, seed: 8, maxAffected: 400, context });
    expect(await products.fileDigest(output)).toBe(await products.fileDigest(repeat));
  }, 300_000);

  test("a couple is selected through the tie graph, never rings each other, one dies at home and the other calls 911", async () => {
    const definition = scenario("alibi", (s) => {
      const him = s.selectPerson("boyfriend", { id: couple[0], hasTie: { kind: "partner", household: true, sex: "female" }, requires: { platforms: ["voice"] } });
      const her = s.selectPerson("girlfriend", { tiedTo: { actor: him, kind: "partner" }, householdOf: him, sex: "female" });
      expect(her.id).toBe(couple[1]);
      expect(s.matching({ tiedTo: { actor: him, kind: "partner" } })).toBe(0);
      expect(s.matching({ householdOf: him, tiedTo: { actor: him, kind: "sibling" } })).toBe(0);
      expect(() => s.selectPerson("typo", { tiedTo: { actor: him, kind: "nemesis" } })).toThrow("unknown tie kind");
      expect(() => s.selectPerson("typo", { homeNear: him.home, withinKm: 1, minKm: 2 })).toThrow("minKm exceeds withinKm");
      expect(() => him.call("text-911", "911", { at: "20:00", outcome: "rejected" })).toThrow("911 calls take no outcome or replies");
      expect(() => her.perish("early", { at: "20:20" })).toThrow("replacement window");
      him.replaceWindow("04:00", "24:00");
      her.replaceWindow("04:00", "24:00");
      const walk = s.trip("out", { mode: "walk", people: [him, her], to: s.place(cafe), arriveAt: "12:40" });
      const stay = s.stay("meal", { people: [him, her], at: s.place(cafe), startAt: walk.arrival, for: "60m", purpose: "cafe" });
      s.trip("back", { mode: "walk", people: [him, her], to: him.home, departAt: stay.end });
      s.mute("never-apart", { between: [him, her] });
      expect(() => s.mute("twice", { between: [him, him] })).toThrow("two different people");
      her.perish("stabbed", { at: "20:20" });
      him.call("call-911", "911", { at: "20:38", duration: "3m" });
      s.event("stabbing", { kind: "stabbing", at: him.home, start: "20:20", end: "20:38", radius: "100m" });
    });
    const output = join(directory, "alibi.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 3, maxAffected: 64, context });
    const mute = report.actions.find((action) => action.id === "never-apart")!;
    expect(mute.kind).toBe("mute");
    expect(mute.result.people).toEqual(couple);
    const call = report.actions.find((action) => action.id === "call-911")!;
    expect(call.result.recipient).toBe(comms.EMERGENCY_PERSON);
    const file = await products.KdayFile.open(output);
    try {
      const meta = file.header.scenario as { actors: Record<string, number>; deaths: { person: number; minute: number }[];
        muted: { people: number[]; from: number; until: number; messagesRemoved: number; callsRemoved: number }[]; events: { kind: string }[] };
      expect(meta.actors).toEqual({ boyfriend: couple[0], girlfriend: couple[1] });
      expect(meta.deaths).toEqual([{ person: couple[1], minute: 1220 }]);
      expect(meta.muted).toEqual([expect.objectContaining({ people: couple, from: 0, until: 1440 })]);
      expect(meta.events).toEqual([expect.objectContaining({ kind: "stabbing" })]);
      const [account, participant, conversation, calls, message] = await Promise.all([
        file.table("account"), file.table("participant"), file.table("conversation"), file.table("call"), file.table("message"),
      ]);
      // Not one row is left in a thread whose two accounts are theirs.
      const pair = new Set(couple);
      const theirs = new Set<number>();
      for (let thread = 0; thread < conversation.at!.length; thread++) {
        if (conversation.count![thread] !== 2) continue;
        const members = Array.from(participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + 2)).map((index) => account.person![index]!);
        if (members.every((person) => pair.has(person)) && new Set(members).size === 2) theirs.add(thread);
      }
      for (let i = 0; i < message.at!.length; i++) expect(theirs.has(message.conversation![i]!)).toBe(false);
      for (let i = 0; i < calls.at!.length; i++) expect(theirs.has(calls.conversation![i]!)).toBe(false);
      // The 911 call is on the record, from him, to the emergency account.
      const emergency = Array.from(account.person!).findIndex((person) => person === comms.EMERGENCY_PERSON);
      const [index] = call.result.calls as number[];
      const thread = calls.conversation![index!]!;
      const members = Array.from(participant.account!.subarray(conversation.at![thread]!, conversation.at![thread]! + conversation.count![thread]!));
      expect(members).toContain(emergency);
      expect(account.person![calls.from![index!]!]).toBe(couple[0]);
    } finally { await file.close(); }
  }, 300_000);

  test("a body is driven on after the death, and its phone is thrown out before it gets there", async () => {
    let stop!: Place, toss!: Place, grave!: Place, home!: Place;
    const definition = scenario("carried", (s) => {
      const him = s.selectPerson("him", { id: sharedDrivers[0] }), her = s.selectPerson("her", { id: sharedDrivers[1] });
      him.replaceWindow("00:00", "24:00"); her.replaceWindow("00:00", "24:00");
      const car = s.selectVehicle("car", { householdOf: him });
      home = him.home;
      const north = s.streetPoint("north", home, 5000, 5000, 0);
      stop = s.near("stop", { near: home, minDistance: "500m", within: "4km", kinds: ["park_lot", "parking_lot", "street"], inOrder: true });
      grave = s.near("grave", { near: home, awayFrom: north, minDistance: "2km", within: "6km", kinds: ["parking_lot", "street"], inOrder: true });
      toss = s.streetPoint("toss", { ...home, lat: (stop.lat + grave.lat) / 2, lon: (stop.lon + grave.lon) / 2 }, 0, 200);
      // A lie-in, then the day at home until they leave.
      for (const [key, person, wake] of [["him", him, "09:12"], ["her", her, "08:47"]] as const) {
        const slept = s.sleep(`${key}-sleeps`, { person, startAt: "00:00", until: wake });
        s.wait(`${key}-day`, { people: [person], at: home, startAt: slept.end, until: "next" });
      }
      him.leaveHandset("his-stays", { at: "17:59", place: home, outdoors: false });
      const out = s.trip("out", { mode: "car", vehicle: car, driver: him, passengers: [her], to: stop, departAt: "18:00" });
      s.wait("parked", { people: [him, her], at: stop, startAt: out.arrival, until: "18:50" });
      her.perish("killed", { at: "18:40", moved: true });
      const across = s.trip("across", { mode: "car", vehicle: car, driver: him, passengers: [her], to: toss, departAt: "18:50" });
      const thrown = s.wait("kerb", { people: [him, her], at: toss, startAt: across.arrival, for: "2m" });
      her.leaveHandset("hers-thrown", { at: across.arrival.plus("1m"), place: toss, outdoors: true });
      const onward = s.trip("onward", { mode: "car", vehicle: car, driver: him, passengers: [her], to: grave, departAt: thrown.end });
      s.wait("left-there", { people: [her], at: grave, startAt: onward.arrival, until: "24:00" });
      const hidden = s.wait("hides", { people: [him], at: grave, startAt: onward.arrival, for: "20m" });
      s.trip("back", { mode: "car", vehicle: car, driver: him, to: home, departAt: hidden.end });
    });
    const output = join(directory, "carried.bin");
    const report = await applyAndMaterialize({ input, output, scenario: definition, seed: 9, maxAffected: 64, context });
    // The far side of home from a point due north of it is the southern sector.
    expect(grave.lat).toBeLessThan(home.lat);
    const at = (id: string) => report.actions.find((action) => action.id === id)!.result;
    expect(at("killed").start).toBe(1120);
    expect(at("across").start).toBeGreaterThanOrEqual(1130);
    expect(at("hers-thrown").start).toBeGreaterThan(at("across").start);
    expect(at("onward").arrival).toBeGreaterThan(at("hers-thrown").start);
    const file = await products.KdayFile.open(output);
    try {
      const meta = file.header.scenario as { deaths: { person: number; minute: number }[];
        handsetsLeft: { person: number; from: number; at: { lat: number; lon: number } }[] };
      expect(meta.deaths).toEqual([{ person: sharedDrivers[1], minute: 1120 }]);
      const hers = meta.handsetsLeft.find((row) => row.person === sharedDrivers[1])!;
      // Her phone is where he threw it, not where she died and not where she lies.
      expect(transport.haversineKm(hers.at, toss)).toBeLessThan(0.05);
      expect(transport.haversineKm(hers.at, grave)).toBeGreaterThan(0.5);
      const closing = await checkpointFromKday(output);
      const car = closing.vehicles.find((row) => row.id === (file.header.scenario as { vehicles: { car: string } }).vehicles.car)!;
      expect(transport.haversineKm(car.location!, home)).toBeLessThan(0.1);
      // The night is sleep on his schedule, to the minute the script woke him.
      const [people, schedule] = await Promise.all([file.table("person"), file.table("schedule")]);
      const row = Array.from(people.id!).indexOf(sharedDrivers[0]);
      const sleepKind = products.KINDS.indexOf("sleep");
      const nights: [number, number][] = [];
      for (let i = people.scheduleOffset![row]!; i < people.scheduleOffset![row]! + people.scheduleCount![row]!; i++) {
        if (schedule.kind![i] === sleepKind) nights.push([schedule.start![i]!, schedule.end![i]!]);
      }
      expect(nights).toEqual([[0, 552]]);
    } finally { await file.close(); }
  }, 300_000);

  test("invalid scope or schedule fails without writing output", async () => {
    const output = join(directory, "invalid.bin");
    const definition = scenario("too-many", (s) => {
      const a = s.selectPerson("a", { id: ids[0] }), b = s.selectPerson("b", { id: ids[1] });
      a.text("hello", b, { at: "12:00", platform: "sms" });
    });
    await expect(applyScenario({ input, output, scenario: definition, seed: 1, maxAffected: 1, context })).rejects.toThrow("maxAffected");
    expect(await Bun.file(output).exists()).toBe(false);
    await expect(applyScenario({ input, output: input, scenario: definition, seed: 1, context })).rejects.toThrow("must differ");
  }, 120_000);

  test("merge rejects wrong bases, damaged deltas, and aliases of either source", async () => {
    const delta = join(directory, "guards.kdiff"), output = join(directory, "guard-result.bin");
    await applyScenario({ input, output: delta, scenario: scenario("guards", () => {}), seed: 5, context });
    const baseHash = await products.fileDigest(input), deltaHash = await products.fileDigest(delta);
    // An altered byte must fail even if the KDAY header/date still match.
    const wrong = join(directory, "wrong.bin"), changed = new Uint8Array(await Bun.file(input).arrayBuffer());
    changed[changed.length - 1] ^= 1;
    await Bun.write(wrong, changed);
    await expect(materializeScenario({ input: wrong, delta, output })).rejects.toThrow("base hash mismatch");
    const corrupt = join(directory, "corrupt.kdiff"), truncated = new Uint8Array(await Bun.file(delta).arrayBuffer());
    await Bun.write(corrupt, truncated.subarray(0, truncated.length - 5));
    await expect(materializeScenario({ input, delta: corrupt, output })).rejects.toThrow("corrupt");
    for (const source of [input, delta]) {
      await expect(materializeScenario({ input, delta, output: source })).rejects.toThrow("must differ");
      const alias = `${source}.symlink`, hard = `${source}.hardlink`;
      await symlink(source, alias); await link(source, hard);
      for (const path of [alias, hard]) await expect(materializeScenario({ input, delta, output: path })).rejects.toThrow("must differ");
    }
    await expect(applyScenario({ input, output: `${input}.symlink`, scenario: scenario("guard", () => {}), seed: 1, context })).rejects.toThrow("must differ");
    expect(await Bun.file(output).exists()).toBe(false);
    expect(await products.fileDigest(input)).toBe(baseHash);
    expect(await products.fileDigest(delta)).toBe(deltaHash);
  }, 120_000);
});

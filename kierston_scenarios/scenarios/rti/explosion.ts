import { scenario } from "../../src/index.ts";

/**
 * An outsider visits a workplace, waits, then walks to a lookout.
 * Two other visitors come and leave. The blast follows their actual travel;
 * the recorded occupants react and patrol units respond to that event.
 */
export default scenario({
  name: "explosion",
  seed: 4,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_explosion_4.kdiff",
  maxAffected: 2500,
}, async (s) => {
  const site = s.selectSite("target", { class: ["hospital", "warehouse", "government", "church", "industrial", "office"], minCapacity: 60 });
  // Working hours, when the site has its recorded occupants inside.
  const start = s.start(["08:30", "16:00"]);
  const withRecord = s.pick("profile", ["record", "clean"]) === "record";
  // On foot from a few kilometres away: a car left at the site while the
  // bomber watches from a street away strands whoever's recorded day still
  // needs it, and that fails the run.
  const bomber = s.selectPerson("bomber", {
    age: { min: 20, max: 50 }, homeNear: site, withinKm: 5, notWorksAt: site, excludeOccupations: ["police_officer", "paramedic"],
    ...(withRecord ? { criminal: { cases: { min: 1, max: 99 }, incarcerated: false } } : { criminal: { cases: 0, incarcerated: false } }),
  });
  bomber.ensureWindow(start, 1440);
  const visit = s.trip("bomber-visits", { mode: "walk", people: [bomber], to: site, departAt: start, flexibleDepart: true });
  const inside = s.wait("bomber-inside", { people: [bomber], at: site, startAt: visit.arrival, for: "15m" });
  const lookout = s.near("lookout", { near: site, minDistance: "250m", within: "500m", kinds: ["street"] });
  const walk = s.trip("bomber-walks-off", { mode: "walk", people: [bomber], to: lookout, departAt: inside.end });
  const visitors = s.selectPeople("visitors", { age: { min: 18, max: 70 }, homeNear: site, withinKm: 12, notWorksAt: site, exclude: [bomber] }, { count: 2 });
  const calls = visitors.gather("visitors-call", { at: site, departAt: start, spread: { for: "30m" } });
  const visited = await s.after(walk.arrival, calls.start);
  const leaving = visitors.goHome("visitors-leave", { at: visited + 15, spread: { for: "15m" } });
  const blast = await s.after(leaving.end);
  s.wait("bomber-watches", { people: [bomber], at: lookout, startAt: walk.arrival, until: blast + 5 });
  s.trip("bomber-leaves", { mode: "walk", people: [bomber], to: bomber.home, departAt: blast + 5 });

  s.event("blast", { kind: "explosion", at: site, start: blast, end: blast + 1, radius: "300m" });
  const inside_ = s.present("inside", { near: site, at: blast, within: "150m", exclude: [bomber, visitors] });
  const { dead, hurt, fleeing } = inside_.partition("fate", { dead: 0.02, hurt: 0.15, fleeing: 0.83 });
  dead.perish("killed", { at: blast, spread: { for: "1m", shape: "burst" }, onInfeasible: "drop" });
  // The injured stay down until they are taken away, then go home rather
  // than lie at the site until midnight.
  const down = hurt.wait("down", { at: blast, for: "90m", then: "stay" });
  hurt.goHome("hurt-leave", { at: down.end, spread: { for: "30m" } });
  const flight = fleeing.disperse("flight", { at: blast, spread: { for: "5m", shape: "burst" }, from: site,
    within: "600m", pace: 1.8, hideFor: "10m", then: "home", phoneLeft: 0.04, minCount: 20 });
  const alive = inside_.minus("alive", dead);
  fleeing.sample("callers-911", 0.2).call("call-911", "911", { at: flight.start.plus("1m"), spread: { for: "6m", shape: "burst" } });
  alive.sample("callers-family", 0.5).call("call-family", "family", { at: blast + 3, spread: { for: "15m", shape: "burst" }, retries: 2 });
  s.respond("police", { flexible: true, to: site, at: blast + 6, units: 3, holdFor: "3h", minUnits: 1 });
});

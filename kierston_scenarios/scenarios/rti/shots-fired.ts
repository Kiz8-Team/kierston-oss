import { scenario } from "../../src/index.ts";

/**
 * A handgun owner walks to a street corner, fires for two minutes and
 * leaves. The incident time is the routed arrival. Witnesses and an optional
 * armed decoy are selected from the recorded day around that actual time.
 */
export default scenario({
  name: "shots-fired",
  seed: 5,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_shots-fired_5.kdiff",
  maxAffected: 256,
}, async (s) => {
  // Afternoon into late evening, when the corner has awake people to call it in.
  const start = s.start(["12:00", "23:00"]);
  const strip = s.selectPlace("strip", { type: "food-quick" });
  const corner = s.near("corner", { near: strip, minDistance: "60m", within: "200m", kinds: ["street"] });
  const shooter = s.selectPerson("shooter", {
    age: { min: 18, max: 50 }, homeNear: strip, withinKm: 2, excludeOccupations: ["police_officer"],
    firearms: { owns: true, type: "handgun" }, criminal: { cases: { min: 1, max: 99 }, incarcerated: false },
  });
  shooter.ensureWindow(start, 1440);
  const there = s.trip("approach", { mode: "walk", people: [shooter], to: corner, departAt: start, flexibleDepart: true });
  const at = await s.after(there.arrival);
  const shots = s.wait("shots", { people: [shooter], at: corner, startAt: there.arrival, for: "2m" });
  s.event("shots", { kind: "shots-fired", at: corner, start: at, end: at + 2, radius: "250m" });
  s.trip("leave", { mode: "walk", people: [shooter], to: shooter.home, departAt: shots.end, pace: 1.6 });
  // Witnesses are whoever was there at the shot minute, awake through the
  // calls and holding a carrier voice account. At least one calls, and that
  // call is not droppable; a corner with nobody to call fails the seed.
  const witnesses = s.present("witnesses", { near: corner, at, within: "250m", exclude: [shooter],
    requires: { platforms: ["voice"] }, awake: [at, at + 8] });
  if (witnesses.size === 0) throw new Error("shots-fired: nobody awake with a voice account was near the corner at the shot minute");
  witnesses.sample("callers", { count: Math.max(1, Math.ceil(witnesses.size * 0.25)) })
    .call("call-911", "911", { at: at + 1, spread: { for: "4m", shape: "burst" }, onInfeasible: "fail" });
  s.respond("police", { flexible: true, to: corner, at: at + 4, units: 1, holdFor: "45m" });

  const lookalike = { presentNear: { near: corner, during: [Math.max(0, at - 10), at + 10] as const, within: "400m" },
    firearms: { owns: true as const, type: "handgun" as const }, excludeOccupations: ["police_officer"], exclude: [shooter, witnesses] };
  if (s.matching(lookalike) > 0) s.selectPerson("decoy", lookalike);
});

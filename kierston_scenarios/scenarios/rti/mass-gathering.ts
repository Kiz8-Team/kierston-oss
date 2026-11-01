import { scenario } from "../../src/index.ts";

/**
 * An unannounced crowd gathers at a seeded place. Members depart when
 * available, assemble after their actual journeys, stay for 75 minutes,
 * then resume their recorded day. The event header uses this schedule.
 */
export default scenario({
  name: "mass-gathering",
  seed: 8,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_mass-gathering_8.kdiff",
  maxAffected: 1200,
}, async (s) => {
  const kind = s.pick("place-kind", ["park", "parking_lot", "street"]);
  const spot = kind === "park" ? s.selectPlace("spot", { type: "park" })
    : kind === "parking_lot" ? s.selectPlace("spot", { type: "parking_lot" })
    : s.near("spot", { near: s.selectPlace("anchor", { type: "retail" }), minDistance: "40m", within: "150m", kinds: ["street"] });
  // Daytime into the evening, so the crowd is out and the gathering ends before midnight.
  const depart = s.start(["10:00", "19:00"]);
  const crowd = s.selectPeople("crowd", { age: { min: 16, max: 75 }, homeNear: spot, withinKm: 10 }, { count: { min: 80, max: 220 } });
  const gathering = crowd.gather("gathering", { at: spot, departAt: depart, spread: { for: "25m" }, minCount: 50, maxWalkKm: 3 });
  const schedule = await crowd.resumeAfter("leave-gathering", gathering.start, { for: "75m", spread: { for: "25m" } });
  const start = schedule.start;
  crowd.sample("texters", 0.25).text("where-are-you", "friends", { at: start + 5, spread: { for: "30m" }, count: 1 });
  s.event("gathering", { kind: "gathering", at: spot, start, end: schedule.end, radius: "150m" });
});

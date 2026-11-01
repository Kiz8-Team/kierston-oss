import { scenario } from "../../src/index.ts";

/**
 * Marchers converge on a park or civic building, remain together for
 * two hours after the last feasible arrival, then resume their recorded day.
 * Messages and the bystander query follow the routed gathering schedule.
 */
export default scenario({
  name: "protest",
  seed: 3,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_protest_3.kdiff",
  maxAffected: 2000,
}, async (s) => {
  // Daytime, so the march assembles and disperses before midnight.
  const start = s.start(["09:00", "17:00"]);
  const square = s.pick("venue-kind", ["park", "civic"]) === "park"
    ? s.selectPlace("square", { type: "park" })
    : s.selectSite("square", { class: ["government", "civic"] });
  const marchers = s.selectPeople("marchers", { age: { min: 16, max: 70 }, homeNear: square, withinKm: 15 }, { count: { min: 150, max: 350 } });
  marchers.sample("organisers", 0.35).text("rally-call", "friends", { at: start, spread: { for: "35m" }, count: 1 });
  const rally = marchers.gather("rally", { at: square, departAt: start + 35, spread: { for: "40m" }, minCount: 100, maxWalkKm: 4 });
  const schedule = await marchers.resumeAfter("leave-rally", rally.start, { for: "2h", spread: { for: "30m" } });
  const assembled = schedule.start;
  marchers.sample("posters", 0.2).text("from-the-crowd", "friends", { at: rally.start.plus("15m"), spread: { for: "40m" }, count: 1 });
  s.event("protest", { kind: "protest", at: square, start: assembled, end: schedule.end, radius: "200m" });
  s.present("bystanders", { near: square, during: [assembled, assembled + 120], within: "200m", exclude: [marchers] });
});

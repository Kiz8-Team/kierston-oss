import { scenario } from "../../src/index.ts";

export default scenario({
  name: "priority-taxi",
  seed: 42,
  input: "../../../kierston/sim_outputs/day_2026-08-23.bin",
  output: "../../../kierston/sim_outputs/scenario_taxi_42.kdiff",
  maxAffected: 64,
}, (s) => {
  const actor = s.selectPerson("passenger", { age: { min: 25, max: 65 } });
  const cafe = s.selectPlace("destination", { type: "cafe", near: actor.home, withinKm: 5 });
  actor.replaceWindow("00:00", "24:00");
  const ride = s.trip("ride", { mode: "taxi", riders: [actor], requestedBy: actor, to: cafe, departAt: "12:00" });
  s.stay("visit", { people: [actor], at: cafe, startAt: ride.arrival, for: "60m", purpose: "cafe" });
});

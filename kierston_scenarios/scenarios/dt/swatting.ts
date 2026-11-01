import { scenario } from "../../src/index.ts";

/**
 * A false report of an armed intruder at a home. A caller across town,
 * from the occupant's circle when the day has one, rings the occupant
 * twice and is rejected, then rings 911 once the occupant is home. The
 * report and the response follow routed arrivals.
 */
export default scenario({
  name: "swatting",
  seed: 22,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_swatting_22.kdiff",
  maxAffected: 64,
}, async (s) => {
  // Late afternoon into the evening: the occupant is going home for the
  // night and the caller, who does nothing but ring, is awake.
  const start = s.start(["16:00", "21:00"]);
  const circle = ["colleague", "ex_colleague", "clubmate", "classmate", "congregant"];
  const occupants = s.selectPeople("occupant", {
    age: { min: 21, max: 70 }, excludeOccupations: ["police_officer", "paramedic"], requires: { platforms: ["voice"] },
    hasTie: { kind: circle },
  }, { count: 1 });
  const occupant = occupants.members[0]!;
  const house = occupant.home;
  // The rejected calls on both handsets are the evidence; no random draw may
  // leave either phone at home or switch it off.
  occupant.keepHandset();
  // Home for the evening, whatever the recorded day had planned.
  const home = occupants.gather("evening-in", { at: house, departAt: start, onInfeasible: "fail" });
  const homeAt = await s.after(home.start);

  // The caller has no physical actions that would wake him, so he must be
  // awake in the recorded day from the first call through the 911 call.
  const callAt = Math.max(homeAt, start + 10);
  // Somebody from the occupant's circle who lives across town; failing one,
  // a stranger across town.
  const stranger = { age: { min: 18, max: 65 }, homeNear: house, withinKm: 40, minKm: 2,
    excludeOccupations: ["police_officer", "paramedic"], requires: { platforms: ["voice"] as const }, awake: [start, callAt + 2] as const };
  const known = { ...stranger, tiedTo: { actor: occupant, kind: circle } };
  const caller = s.selectPerson("caller", s.matching(known) > 0 ? known : stranger);
  caller.keepHandset();
  caller.call("grudge-1", occupant, { at: start, outcome: "rejected" });
  caller.call("grudge-2", occupant, { at: start + 5, outcome: "rejected" });
  caller.call("call-911", "911", { at: callAt, duration: "2m" });
  s.event("report", { kind: "swatting", at: house, start: callAt, end: callAt + 1, radius: "100m",
    note: "911 caller reports an armed man inside the house threatening the occupants" });
  s.respond("police", { flexible: true, to: house, at: callAt + 3, units: 3, holdFor: "90m", minUnits: 1 });
});

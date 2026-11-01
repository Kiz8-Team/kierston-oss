import { scenario, minute, seedFor } from "../../src/index.ts";

/** Drug classes in the formulary that treat a mental-health condition. */
const PSYCHIATRIC = ["SSRI", "NDRI", "SARI", "benzodiazepine", "stimulant"];

/**
 * A shooting at a school when the recorded day has students inside, by
 * someone on psychiatric medication. The student branch uses peak recorded
 * attendance; an outsider walks there and arrives a few minutes before
 * it. Lockdown, flight, calls and response are timed from the incident.
 */
export default scenario({
  name: "school-shooting",
  seed: 6,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_school-shooting_6.kdiff",
  maxAffected: 2500,
}, async (s) => {
  await s.ready();
  const school = s.selectSite("school", { class: "school", minCapacity: 300 });
  const occupied = s.baseline!.busiestMinute(school, 0.12, 14, 18);
  // Peak attendance by 14-18 year olds is a school-day minute; a site whose
  // peak falls outside school hours is counting the houses around it.
  if (occupied < minute("07:30") || occupied > minute("15:30")) {
    throw new Error(`school-shooting: peak attendance at minute ${occupied} is outside school hours`);
  }
  const student = s.pick("shooter-kind", ["student", "outsider"]) === "student";
  // Either way the shooter carries a current psychiatric prescription, so the
  // investigation has a medical trail to find. The records hold current
  // prescriptions only, so this is an ongoing script, not a treatment history.
  const shooters = student
    ? s.selectPeople("shooter", { age: { min: 14, max: 18 }, presentNear: { near: school, at: occupied, within: "120m" },
        prescriptions: { drugClass: PSYCHIATRIC } }, { count: 1 })
    : s.selectPeople("shooter", { age: { min: 17, max: 30 }, sex: "male", homeNear: school, withinKm: 5, notWorksAt: school,
        // Within walking reach of the school when his day is taken over, home included.
        presentNear: { near: school, at: Math.max(0, occupied - 130), within: "5km", atHome: true, asleep: true },
        excludeOccupations: ["police_officer"], firearms: { owns: true },
        prescriptions: { drugClass: PSYCHIATRIC } }, { count: 1 });
  // On foot: a car left at the school after the flight strands whoever's
  // recorded day still needs it, and the shooter cannot be dropped. The
  // outsider arrives two to eight minutes before the shots, so neither he
  // nor his phone waits at the school for hours beforehand.
  let shots = occupied;
  if (!student) {
    const early = 2 + seedFor(s.seed, "school-shooting/early") % 7;
    const arrival = shooters.gather("shooter-arrives", { at: school, arriveAt: occupied - early, lead: "120m", mode: "walk", onInfeasible: "fail" });
    shots = Math.max(occupied, await s.after(arrival.start.plus(`${early}m`)));
  }
  s.event("shots", { kind: "school-shooting", at: school, start: shots, end: shots + 4, radius: "250m" });

  const inside = s.present("inside", { near: school, at: shots, within: "150m", exclude: [shooters] });
  const { dead, hiding, fleeing } = inside.partition("fate", { dead: 0.01, hiding: 0.6, fleeing: 0.39 });
  dead.perish("killed", { at: shots, spread: { for: "3m", shape: "burst" }, onInfeasible: "drop" });
  const lockdown = hiding.wait("lockdown", { at: shots, spread: { for: "2m", shape: "burst" }, for: "80m", then: "stay" });
  hiding.goHome("released", { at: lockdown.end, spread: { for: "40m" } });
  const flight = fleeing.disperse("flight", { at: shots + 1, spread: { for: "4m", shape: "burst" }, from: school,
    within: "500m", pace: 1.8, hideFor: "15m", then: "home", minCount: 20 });
  const alive = inside.minus("alive", dead);
  fleeing.sample("callers-911", 0.1).call("call-911", "911", { at: flight.start.plus("1m"), spread: { for: "5m", shape: "burst" } });
  alive.sample("callers-family", 0.7).call("call-family", "family", { at: shots + 3, spread: { for: "15m", shape: "burst" }, retries: 2 });
  alive.sample("texters", 0.6).text("text-family", "family", { at: shots + 5, spread: { for: "20m" }, count: 1 });
  s.respond("police", { flexible: true, to: school, at: shots + 5, units: 3, holdFor: "3h", minUnits: 1 });

  if (s.pick("aftermath", ["flee", "perish"]) === "flee") {
    shooters.disperse("shooter-flight", { at: shots + 4, from: school, minDistance: "300m", within: "700m",
      pace: 1.8, hideFor: "5m", then: "home", maxWalkKm: 30, onInfeasible: "fail" });
  } else {
    shooters.perish("shooter-dies", { at: shots + 6 });
  }
});

import { scenario } from "../../src/index.ts";

/** Drug classes in the formulary that treat a mental-health condition. */
const PSYCHIATRIC = ["SSRI", "NDRI", "SARI", "benzodiazepine", "stimulant"];

/**
 * A crowd gathers at a bar and a handgun owner on psychiatric medication
 * arrives on foot. The shooting starts after their routed arrivals; deaths,
 * sheltering, flight, calls and patrol response follow that event. The seed
 * chooses whether the shooter flees, blends into the crowd or dies at the scene.
 */
export default scenario({
  name: "mass-shooting",
  seed: 11,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_mass-shooting_11.kdiff",
  maxAffected: 1500,
}, async (s) => {
  // An evening at a bar that is open for it.
  const start = s.start(["18:00", "21:00"]);
  const hall = s.selectPlace("hall", { type: "bar", openDuring: [start, Math.min(1440, start + 180)] });
  const attendees = s.selectPeople("attendees", { age: { min: 18, max: 60 }, homeNear: hall, withinKm: 12 }, { count: { min: 120, max: 180 } });
  // Nobody walks more than three kilometres to it, so one slow walker does
  // not push the shooting, which waits for the last arrival, late.
  const concert = attendees.gather("concert", { at: hall, departAt: start, spread: { for: "50m" }, purpose: "bar", minCount: 80, maxWalkKm: 3 });

  // One shooter, as a group of one so the aftermath can use the crowd verbs.
  // On foot from nearby: a drive would strand the household car at the hall
  // for whoever's recorded evening still needs it, and that fails the run.
  // Carrying a current psychiatric prescription, so the investigation has a
  // medical trail to find. The records hold current prescriptions only, so
  // this is an ongoing script rather than a treatment history.
  const shooters = s.selectPeople("shooter", {
    age: { min: 20, max: 45 }, sex: "male", homeNear: hall, withinKm: 5, excludeOccupations: ["police_officer"],
    firearms: { owns: true, type: "handgun" }, prescriptions: { drugClass: PSYCHIATRIC }, exclude: [attendees],
  }, { count: 1 });
  const arrival = shooters.gather("shooter-arrives", { at: hall, departAt: start, mode: "walk", onInfeasible: "fail" });
  const shots = await s.after(concert.start, arrival.start);
  s.event("shots", { kind: "shooting", at: hall, start: shots, end: shots + 4, radius: "200m" });

  const bystanders = s.present("bystanders", { near: hall, at: shots, within: "120m", exclude: [attendees, shooters] });
  const crowd = attendees.union("crowd", bystanders);
  const { dead, hiding, fleeing } = crowd.partition("fate", { dead: 0.03, hiding: 0.25, fleeing: 0.72 });
  // Multiple casualties: at least two dead, here and after replay drops.
  if (dead.size < 2) throw new Error(`mass-shooting: a crowd of ${crowd.size} gives ${dead.size} dead; at least two are needed`);
  dead.perish("killed", { at: shots, spread: { for: "3m", shape: "burst" }, onInfeasible: "drop", minCount: 2 });
  const flight = fleeing.disperse("flight", { at: shots, spread: { for: "4m", shape: "burst" }, from: hall,
    within: "500m", pace: 1.8, hideFor: "10m", then: "home", phoneLeft: 0.06, minCount: 40 });
  const shelter = hiding.wait("shelter", { at: shots, spread: { for: "2m", shape: "burst" }, for: "55m", then: "stay" });
  hiding.goHome("hiding-home", { at: shelter.end, spread: { for: "30m" } });

  const alive = crowd.minus("alive", dead);
  fleeing.sample("callers-911", 0.15).call("call-911", "911", { at: flight.start.plus("1m"), spread: { for: "5m", shape: "burst" } });
  hiding.sample("hidden-callers-911", 0.3).call("hidden-911", "911", { at: shots + 2, spread: { for: "4m", shape: "burst" } });
  alive.sample("callers-family", 0.6).call("call-family", "family", { at: shots + 3, spread: { for: "12m", shape: "burst" }, retries: 2 });
  alive.sample("texters", 0.5).text("text-friends", "friends", { at: shots + 5, spread: { for: "25m" }, count: 2 });

  s.respond("police", { flexible: true, to: hall, at: shots + 6, units: 2, holdFor: "2h" });

  switch (s.pick("aftermath", ["flee", "blend", "perish"])) {
    case "flee":
      // Out ahead of the crowd, a pause out of sight, then away by whatever they have.
      shooters.disperse("shooter-flight", { at: shots + 4, from: hall, minDistance: "300m", within: "600m",
        pace: 1.8, hideFor: "4m", then: "home", maxWalkKm: 30, onInfeasible: "fail" });
      break;
    case "blend":
      // Indistinguishable from the crowd: same minute, same distances, same walk home.
      shooters.disperse("shooter-flight", { at: shots, spread: { for: "4m", shape: "burst" }, from: hall,
        within: "500m", pace: 1.8, hideFor: "10m", then: "home", onInfeasible: "fail" });
      break;
    case "perish":
      shooters.perish("shooter-dies", { at: shots + 4 });
      break;
  }
});

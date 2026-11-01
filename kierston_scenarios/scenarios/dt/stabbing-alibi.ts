import { scenario, minute, type Place, type Time } from "../../src/index.ts";

/**
 * A partner reports finding his girlfriend stabbed at home. In fact the
 * two met at home, travelled together, returned together, and she died
 * with him present; their exchanges are muted while together. Every phase
 * follows actual arrivals, so the day holds together without fixed clock
 * appointments.
 */
export default scenario({
  name: "stabbing-alibi",
  seed: 21,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_stabbing-alibi_21.kdiff",
  maxAffected: 64,
}, async (s) => {
  // Late morning, so the couple is home in time for lunch out.
  const start = s.start(["10:30", "12:30"]);
  const boyfriend = s.selectPerson("boyfriend", {
    age: { min: 21, max: 55 }, sex: "male", excludeOccupations: ["police_officer", "paramedic"],
    requires: { platforms: ["voice"] }, hasTie: { kind: "partner", household: true, sex: "female" },
  });
  const girlfriend = s.selectPerson("girlfriend", { sex: "female", tiedTo: { actor: boyfriend, kind: "partner" }, householdOf: boyfriend });
  const home = boyfriend.home;
  // Two handsets side by side all day is the evidence: the day's own
  // left-at-home, power-off and battery draws must not part either of them.
  boyfriend.keepHandset();
  girlfriend.keepHandset();
  // Finish any in-progress journey before taking over each partner's day.
  boyfriend.ensureWindow(start, 1440);
  girlfriend.ensureWindow(start, 1440);

  // Close enough to walk, so a household without a car still gets there;
  // four kilometres because some homes have no sit-down place nearer.
  // Open through a lunch from late morning and an afternoon of shopping.
  const lunch = s.selectPlace("lunch", { type: "food-sit", near: home, withinKm: 4, openDuring: ["11:30", "15:30"] });
  const shops = s.selectPlace("shops", { type: "retail", near: lunch, withinKm: 1.5, openDuring: ["12:30", "18:30"] });

  // Side by side all day: the same car when the household has one and he
  // may drive it, otherwise on foot; the same table and the same aisle.
  // First meet at home; sharing an address does not mean the recorded day
  // has both partners at the same location when the scenario begins.
  const him = s.trip("him-home", { mode: "auto", people: [boyfriend], to: home, departAt: start, flexibleDepart: true });
  const her = s.trip("her-home", { mode: "auto", people: [girlfriend], to: home, departAt: start, flexibleDepart: true });
  const togetherAt = await s.after(him.arrival, her.arrival);
  if (togetherAt > minute("14:00")) throw new Error("stabbing-alibi: the couple is not home together in time for lunch");
  const cars = boyfriend.canDrive ? s.vehicles({ parkedNear: home, at: togetherAt, within: "150m", householdOf: boyfriend, serviceClass: "none" }) : [];
  const car = cars[0] ?? null;
  const together = (id: string, to: Place, when: { arriveAt: Time } | { departAt: Time }) =>
    car ? s.trip(id, { mode: "car", vehicle: car, driver: boyfriend, passengers: [girlfriend], to, ...when })
      : s.trip(id, { mode: "walk", people: [boyfriend, girlfriend], to, ...when });
  const out = together("out", lunch, { departAt: togetherAt });
  const meal = s.stay("meal", { people: [boyfriend, girlfriend], at: lunch, startAt: out.arrival, for: "80m", purpose: "food-sit" });
  boyfriend.purchase("pays-lunch", { at: out.arrival.plus("70m"), channel: "in_person", venue: lunch, amount: { min: 24, max: 58 }, instrument: "debit" });
  const onward = together("onward", shops, { departAt: meal.end });
  const browse = s.stay("browse", { people: [boyfriend, girlfriend], at: shops, startAt: onward.arrival, for: "100m", purpose: "retail" });
  girlfriend.purchase("buys", { at: onward.arrival.plus("75m"), channel: "in_person", venue: shops, amount: { min: 12, max: 90 }, instrument: "debit" });
  const returned = together("home", home, { departAt: browse.end });
  const deathAt = await s.after(returned.arrival.plus("10m"));
  const callAt = deathAt + 18;
  s.mute("never-apart", { between: [boyfriend, girlfriend], from: togetherAt });
  girlfriend.perish("stabbed", { at: deathAt });
  s.event("stabbing", { kind: "stabbing", at: home, start: deathAt, end: callAt, radius: "100m",
    note: "partner reports finding the victim on getting home" });
  boyfriend.call("call-911", "911", { at: callAt, duration: "3m" });
  s.respond("police", { flexible: true, to: home, at: callAt + 5, units: 2, holdFor: "3h", minUnits: 1 });
});

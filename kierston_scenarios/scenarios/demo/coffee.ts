import { scenario } from "../../src/index.ts";

export default scenario({
  name: "coffee-and-a-call",
  seed: 42,
  input: "../../../kierston/sim_outputs/day_2026-08-23.bin",
  output: "../../../kierston/sim_outputs/scenario_coffee_42.kdiff",
  maxAffected: 64,
}, (s) => {
  const actor = s.selectPerson("main_actor", {
    age: { min: 25, max: 55 }, requires: { car: true, platforms: ["whatsapp"] },
  });
  const contact = s.selectPerson("contact", { age: { min: 18, max: 70 }, requires: { platforms: ["whatsapp"] } });
  const cafe = s.selectPlace("cafe", { type: "cafe", near: actor.home, withinKm: 8, openDuring: ["12:00", "14:00"] });
  const car = s.selectVehicle("car", { householdOf: actor });
  actor.replaceWindow("00:00", "24:00");
  const outbound = s.trip("outbound", { mode: "car", vehicle: car, driver: actor, to: cafe, departAt: "12:00" });
  const visit = s.stay("visit", { people: [actor], at: cafe, startAt: outbound.arrival, for: "45m", purpose: "cafe" });
  actor.text("arrival", contact, { at: visit.start.plus("1m"), platform: "whatsapp" });
  actor.call("call", contact, { at: visit.start.plus("5m"), outcome: "answered", duration: "2m" });
  actor.purchase("coffee", { at: visit.start.plus("10m"), channel: "in_person", venue: cafe,
    amount: { min: 4, max: 9 }, instrument: "debit" });
  s.trip("home", { mode: "car", vehicle: car, driver: actor, to: actor.home, departAt: visit.end });
  actor.purchase("book", { at: "18:00", channel: "online", merchant: { name: "Scenario Bookshop", mcc: 5942 },
    amount: 19.99, instrument: "debit" });
});

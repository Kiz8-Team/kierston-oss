import { scenario } from "../../src/index.ts";

/**
 * A victim visits a venue and walks to a kerb. A crew with violent
 * records meets at the driver's home and drives there. The abduction starts
 * when both are present: the phone is dropped, the car takes the victim to
 * the driver's home, and a witness reports it. The witness is a recorded
 * passer-by, a nearby resident walked past, or a relative on the phone.
 */
export default scenario({
  name: "abduction",
  seed: 23,
  input: "../../../kierston/sim_outputs/day_2026-09-04.bin",
  output: "../../../kierston/sim_outputs/scenario_abduction_23.kdiff",
  maxAffected: 64,
}, async (s) => {
  await s.ready();
  // Daytime and evening only: the venue is open and the relative who may
  // be on the line is awake.
  const start = s.start(["11:00", "20:00"]);
  const noUniform = ["police_officer", "paramedic"];
  const kin = ["partner", "parent", "child", "sibling"];
  const victim = s.selectPerson("victim", {
    age: { min: 18, max: 60 }, excludeOccupations: noUniform, requires: { platforms: ["voice"] },
    hasTie: { kind: kin, household: true, platforms: ["voice"] },
  });
  const venueKind = s.pick("venue", ["food-sit", "bar", "retail"]);
  const venue = s.selectPlace("venue", { type: venueKind, near: victim.home, withinKm: 6, openDuring: [start, Math.min(1440, start + 150)] });
  const kerb = s.near("kerb", { near: venue, minDistance: "80m", within: "250m", kinds: ["street"] });

  // The crew: long violent histories, loosened only as far as the
  // population makes necessary. Nobody currently in custody.
  const violent = [
    { cases: { min: 3, max: 99 }, felonyConvicted: true as const, convictedOf: "person" as const, offendingClass: ["chronic_high", "chronic_moderate"] as const, incarcerated: false },
    { cases: { min: 3, max: 99 }, felonyConvicted: true as const, convictedOf: "person" as const, incarcerated: false },
    { cases: { min: 2, max: 99 }, convictedOf: "person" as const, incarcerated: false },
  ];
  const driverBase = { age: { min: 18, max: 55 }, homeNear: venue, withinKm: 30, minKm: 4, excludeOccupations: noUniform,
    requires: { car: true as const, vehicle: true as const, platforms: ["voice"] as const }, exclude: [victim] };
  const driverOptions = violent.map((criminal) => ({ ...driverBase, criminal }));
  const driver = s.selectPerson("driver", driverOptions.find((filter) => s.matching(filter) > 0) ?? driverOptions[violent.length - 1]!);
  const car = s.selectVehicle("car", { householdOf: driver, serviceClass: "none" });
  // One or two accomplices: as many as the driver's own circle has with a
  // violent record, the rest violent people living within a few kilometres
  // of the driver.
  const crewSize = s.pick("crew", ["two", "three"]) === "two" ? 1 : 2;
  const accompliceBase = { age: { min: 18, max: 55 }, excludeOccupations: noUniform, requires: { platforms: ["voice"] as const }, exclude: [victim, driver] };
  const known = violent.map((criminal) => ({ ...accompliceBase, criminal, tiedTo: { actor: driver } }));
  const local = violent.map((criminal) => ({ ...accompliceBase, criminal, homeNear: driver.home, withinKm: 6 }));
  const knownFilter = known.find((filter) => s.matching(filter) > 0);
  const mates = knownFilter === undefined ? null : s.selectPeople("mates", knownFilter, { count: Math.min(crewSize, s.matching(knownFilter)) });
  const hiredCount = crewSize - (mates?.size ?? 0);
  const hired = hiredCount === 0 ? null
    : s.selectPeople("hired", local.find((filter) => s.matching({ ...filter, exclude: [...filter.exclude, ...(mates ? [mates] : [])] }) >= hiredCount) ?? local[violent.length - 1]!, { count: hiredCount });
  const accomplices = mates && hired ? mates.union("accomplices", hired) : (mates ?? hired)!.sample("accomplices", { count: crewSize });

  // The victim visits, pays, and walks to the kerb when the journey allows.
  victim.ensureWindow(start, 1440);
  const out = s.trip("victim-out", { mode: "auto", people: [victim], to: venue, departAt: start, flexibleDepart: true });
  s.stay("victim-evening", { people: [victim], at: venue, startAt: out.arrival, until: "next", purpose: venueKind });
  victim.purchase("victim-pays", { at: out.arrival.plus("30m"), channel: "in_person", venue, amount: { min: 8, max: 40 }, instrument: "debit" });
  const walk = s.trip("victim-walk", { mode: "walk", people: [victim], to: kerb, departAt: out.arrival.plus("35m") });

  // The crew meets at the driver's, drives to the kerb, waits, and takes
  // the victim home with them. The driver's day is replaced from the start
  // when the base day has both driver and car at the house then, and
  // from midnight otherwise, when both are there by construction. The
  // driver is already bound, so presence is read from the driver's own
  // recorded position rather than through `matching`, which skips bound people.
  const parked = s.vehicles({ parkedNear: driver.home, at: start, within: "150m", householdOf: driver, serviceClass: "none" });
  const settled = parked.some((candidate) => candidate.vin === car.vin) && s.wasAt(driver, driver.home, start, "100m");
  const from = settled ? start : 0;
  driver.replaceWindow(from, "24:00");
  s.wait("driver-waits", { people: [driver], atCurrent: true, startAt: from, until: "next" });
  const meeting = accomplices.gather("meet", { at: driver.home, departAt: start, onInfeasible: "fail" });
  const ready = await s.after(meeting.start);
  const crew = accomplices.members;
  const approach = s.trip("approach", { mode: "car", vehicle: car, driver, passengers: crew, to: kerb, departAt: ready });
  let taken = await s.after(walk.arrival, approach.arrival);
  // Whoever reports it must be awake through the call and hold a carrier
  // voice account; the call itself is not droppable, because the truth
  // names a witness.
  const bystanders = s.present("bystanders", { near: kerb, during: [taken, taken + 4], within: "150m", exclude: [victim, driver, accomplices],
    requires: { platforms: ["voice"] }, awake: [taken, taken + 10] });
  const passing = { presentNear: { near: kerb, at: taken, within: "500m" }, age: { min: 16, max: 80 },
    requires: { platforms: ["voice"] as const }, awake: [taken, taken + 40] as const,
    exclude: [victim, driver, accomplices], excludeOccupations: noUniform };
  const witness = bystanders.size === 0 && s.matching(passing) > 0 ? s.selectPeople("witness", passing, { count: 1 }) : null;
  if (witness) {
    const arrival = witness.gather("passing", { at: kerb, departAt: taken, mode: "walk", onInfeasible: "fail" });
    const schedule = await witness.resumeAfter("passing-leaves", arrival.start, { for: "11m" });
    taken = schedule.start;
  }
  const waiting = s.wait("victim-waits", { people: [victim], at: kerb, startAt: walk.arrival, until: taken + 4 });
  s.wait("crew-waits", { people: [driver, ...crew], at: kerb, startAt: approach.arrival, until: waiting.end });
  victim.leaveHandset("phone-dropped", { at: taken + 2, place: kerb, outdoors: true });
  const away = s.trip("away", { mode: "car", vehicle: car, driver, passengers: [...crew, victim], to: driver.home, departAt: waiting.end });
  s.wait("held", { people: [driver, ...crew, victim], at: driver.home, startAt: away.arrival, until: "24:00" });

  s.event("taken", { kind: "abduction", at: kerb, start: taken, end: taken + 4, radius: "150m",
    note: "victim forced into a private car at the kerb and driven away; the phone stays on the pavement" });

  // The report: a passer-by the day had there, a resident walked past, or
  // somebody at home on the phone with the victim as it happened.
  const callAt = taken + 6;
  if (bystanders.size > 0) {
    bystanders.sample("witness", { count: 1 }).call("call-911", "911", { at: callAt, duration: "3m", onInfeasible: "fail" });
  } else if (witness) {
    witness.call("call-911", "911", { at: callAt, duration: "3m", onInfeasible: "fail" });
  } else {
    const relatives = { tiedTo: { actor: victim, kind: kin }, householdOf: victim, requires: { platforms: ["voice"] as const },
      awake: [taken - 2, callAt + 3] as const };
    if (s.matching(relatives) === 0) throw new Error("abduction: no bystander, passer-by or relative is awake with a voice account to report it");
    const relative = s.selectPerson("kin", relatives);
    // On the line from just before the struggle; the call ends when the
    // phone hits the pavement, and nobody answers a callback from the kerb.
    victim.call("on-the-line", relative, { at: taken - 2, duration: "4m", outcome: "answered", replies: false });
    relative.call("call-911", "911", { at: callAt, duration: "3m" });
  }
  s.respond("police", { flexible: true, to: kerb, at: callAt + 5, units: 2, holdFor: "60m", minUnits: 1 });
});

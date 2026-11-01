import { scenario, minute, seedFor, type Place } from "../../src/index.ts";

/**
 * A partner reports his girlfriend missing: she set off for a relative's
 * place, he says, and never arrived. The script stages their whole
 * Saturday: a late morning, one run to the shops, the afternoon at home,
 * and her texts and a call to the relative arranging the visit. At 18:02
 * they left home together in the household car, his phone in the house and
 * hers in her bag. Halfway to
 * the relative's he pulled into a quiet car park, where she died. He drove
 * on across town, threw her phone out on the way, left the body on the far
 * side of the city and came home alone. The relative rings her twice, gets
 * nothing and rings him; he then rings 911 himself. After 18:02 every
 * phase follows actual arrivals.
 */
export default scenario({
  name: "never-arrived",
  seed: 24,
  input: "../../../kierston/sim_outputs/day_2026-09-05.bin",
  output: "../../../kierston/sim_outputs/scenario_never-arrived_24.kdiff",
  maxAffected: 64,
}, async (s) => {
  const leaveAt = minute("18:02");
  // Minutes off a nominal clock time, so no seed keeps round hours.
  const jitter = (key: string, span: number) => seedFor(s.seed, `never-arrived/${key}`) % span;
  const noUniform = ["police_officer", "paramedic"];
  const partner = s.selectPerson("partner", {
    age: { min: 21, max: 55 }, sex: "male", excludeOccupations: noUniform,
    requires: { car: true, vehicle: "couple", platforms: ["voice"] }, wholeDay: true, householdSize: { min: 2, max: 2 },
    hasTie: { kind: "partner", household: true, sex: "female", platforms: ["voice", "sms"], wholeDay: true },
  });
  const missing = s.selectPerson("missing", { sex: "female", tiedTo: { actor: partner, kind: "partner" }, householdOf: partner,
    requires: { platforms: ["voice", "sms"] }, wholeDay: true });
  const home = partner.home;
  // Whoever she was supposedly visiting: family across town when she has
  // any, otherwise anybody of hers across town, and nearer only when
  // nobody of hers lives that far out.
  const around = (minKm: number) => ({ age: { min: 18, max: 80 }, homeNear: home, withinKm: 40, minKm, excludeOccupations: noUniform,
    requires: { platforms: ["voice", "sms"] as const }, wholeDay: true, exclude: [partner, missing] });
  const family = ["parent", "child", "sibling", "kin_ext"];
  const options = [6, 3].flatMap((minKm) => [
    { ...around(minKm), tiedTo: { actor: missing, kind: family } },
    { ...around(minKm), tiedTo: { actor: missing } },
  ]);
  const relative = s.selectPerson("relative", options.find((filter) => s.matching(filter) > 0) ?? options.at(-1)!);
  const car = s.selectVehicle("car", { householdOf: partner, serviceClass: "none", usedOnlyBy: [partner, missing] });
  partner.ensureWindow(0, 1440);
  missing.ensureWindow(0, 1440);
  // His phone at home and hers on the road are the evidence, as is the
  // relative's ringing: the day's own handset draws must not touch them.
  // The scripted holds below still apply.
  partner.keepHandset();
  missing.keepHandset();
  relative.keepHandset();

  // The whole day is theirs. Both get home first: sharing an address does
  // not mean the recorded night has them there. Then a weekend lie-in, each
  // to their own hour, skipped by whoever only got in that morning.
  const him = s.trip("him-home", { mode: "auto", people: [partner], to: home, departAt: 0, flexibleDepart: true });
  const her = s.trip("her-home", { mode: "auto", people: [missing], to: home, departAt: 0, flexibleDepart: true });
  const togetherAt = await s.after(him.arrival, her.arrival);
  if (togetherAt + 30 > leaveAt) throw new Error("never-arrived: the couple is not home in time to leave at 18:02");
  s.mute("not-a-word", { between: [partner, missing] });
  const lieIn = [
    { person: partner, key: "him", arrival: him.arrival, wake: minute("09:07") + jitter("him-wakes", 55) },
    { person: missing, key: "her", arrival: her.arrival, wake: minute("08:41") + jitter("her-wakes", 55) },
  ];
  for (const { person, key, arrival, wake } of lieIn) {
    const slept = await s.after(arrival) + 30 <= wake ? s.sleep(`${key}-sleeps`, { person, startAt: arrival, until: wake }) : null;
    s.wait(`${key}-morning`, { people: [person], at: home, startAt: slept?.end ?? arrival, until: "next" });
  }

  // One outing, to the shops and back in the car, when the morning left room.
  const shopAt = minute("12:13") + jitter("shops", 40);
  if (togetherAt + 60 <= shopAt) {
    const grocery = s.selectPlace("shops", { type: "grocery", near: home, withinKm: 6 });
    const there = s.trip("to-shops", { mode: "car", vehicle: car, driver: partner, passengers: [missing], to: grocery, departAt: shopAt });
    const aisles = s.stay("shopping", { people: [partner, missing], at: grocery, startAt: there.arrival, for: 28 + jitter("aisles", 17), purpose: "grocery" });
    missing.purchase("groceries", { at: there.arrival.plus("24m"), channel: "in_person", venue: grocery, amount: { min: 31, max: 140 }, instrument: "debit" });
    const homeAgain = s.trip("from-shops", { mode: "car", vehicle: car, driver: partner, passengers: [missing], to: home, departAt: aisles.end });
    s.wait("afternoon", { people: [partner, missing], at: home, startAt: homeAgain.arrival, until: leaveAt });
  }

  // She arranges the visit through the day, so the relative is expecting her.
  missing.text("asks-to-come", relative, { at: minute("10:26") + jitter("asks", 30), platform: "sms", replies: true });
  missing.call("settles-it", relative, { at: minute("14:32") + jitter("settles", 25), outcome: "answered", duration: "6m" });
  missing.text("leaving-soon", relative, { at: minute("17:21") + jitter("soon", 20), platform: "sms", replies: true });

  // His phone stays in the house; hers goes with her. Halfway to the
  // relative's he turns into a car park beside a park when there is one, any
  // car park otherwise, and she dies there.
  const between = (a: Place, b: Place, label: string): Place =>
    ({ id: null, kind: "kerb", label, lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
  // Catalogued places only: a random street point can land off the road
  // network, and the router then prices the drive as nonsense.
  const quiet = ["park_lot", "parking_lot"] as const;
  const firstFound = (options: readonly (() => Place)[]): Place => {
    for (const [index, option] of options.entries()) {
      try { return option(); } catch (error) { if (index === options.length - 1) throw error; }
    }
    throw new Error("never-arrived: no place options");
  };
  partner.leaveHandset("his-phone-stays", { at: leaveAt - 1, place: home, outdoors: false });
  // Close enough to the halfway point that the stop is well out of the neighbourhood.
  const metres = (a: Place, b: Place) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) * 111_320;
  const reach = Math.min(2000, Math.round(metres(home, relative.home) * 0.3));
  const halfway = between(home, relative.home, "halfway there");
  const stop = firstFound([reach, 3000].map((within) => () =>
    s.near("stop", { near: halfway, within, kinds: quiet, inOrder: true })));
  const out = s.trip("out", { mode: "car", vehicle: car, driver: partner, passengers: [missing], to: stop, departAt: leaveAt });
  const deathAt = await s.after(out.arrival.plus("4m"));
  missing.perish("killed", { at: deathAt, moved: true });
  const parked = s.wait("at-the-stop", { people: [partner, missing], at: stop, startAt: out.arrival, until: deathAt + 6 });

  // The body goes to the far side of the city from the relative's. Her phone
  // does not go that far: it is thrown out at a kerb on the way, and rings
  // there for the rest of the day.
  const grave = firstFound([
    () => s.near("grave", { near: home, awayFrom: relative.home, minDistance: "6km", within: "14km", kinds: quiet, inOrder: true }),
    () => s.near("grave", { near: home, awayFrom: relative.home, minDistance: "4km", within: "20km", kinds: quiet, inOrder: true }),
    () => s.near("grave", { near: home, minDistance: "6km", within: "20km", kinds: quiet, inOrder: true }),
  ]);
  const onTheWay = between(stop, grave, "on the way across town");
  // Near enough the middle of the drive that it is neither end of it.
  const spread = Math.round(metres(stop, grave) * 0.3);
  const toss = firstFound([Math.min(1500, spread), spread].map((within) => () =>
    s.near("toss", { near: onTheWay, within: Math.max(within, 100), kinds: ["parking_lot", "venue"] })));
  const crossing = s.trip("across", { mode: "car", vehicle: car, driver: partner, passengers: [missing], to: toss, departAt: parked.end });
  const thrown = s.wait("at-the-kerb", { people: [partner, missing], at: toss, startAt: crossing.arrival, for: "2m" });
  missing.leaveHandset("her-phone-thrown", { at: crossing.arrival.plus("1m"), place: toss, outdoors: true });
  const onward = s.trip("onward", { mode: "car", vehicle: car, driver: partner, passengers: [missing], to: grave, departAt: thrown.end });
  s.wait("left-there", { people: [missing], at: grave, startAt: onward.arrival, until: "24:00" });
  const hidden = s.wait("hides-her", { people: [partner], at: grave, startAt: onward.arrival, for: "40m" });
  const back = s.trip("back", { mode: "car", vehicle: car, driver: partner, to: home, departAt: hidden.end });
  s.wait("home-alone", { people: [partner], at: home, startAt: back.arrival, until: "24:00" });

  // The relative spends the evening at home expecting her, and stays up.
  relative.ensureWindow(leaveAt, 1440);
  const expecting = s.trip("relative-home", { mode: "auto", people: [relative], to: relative.home, departAt: leaveAt, flexibleDepart: true });
  s.wait("relative-waits", { people: [relative], at: relative.home, startAt: expecting.arrival, until: "24:00" });

  // The relative hears nothing from her and asks him; he reports it himself.
  const worriedAt = await s.after(back.arrival.plus("20m"), expecting.arrival.plus("5m"));
  relative.call("rings-her", missing, { at: worriedAt, outcome: "no-answer" });
  relative.call("rings-her-again", missing, { at: worriedAt + 9, outcome: "no-answer" });
  relative.call("asks-him", partner, { at: worriedAt + 16, outcome: "answered", duration: "4m" });
  const callAt = worriedAt + 24;
  partner.call("call-911", "911", { at: callAt, duration: "4m" });
  s.event("missing", { kind: "disappearance", at: home, start: leaveAt, end: callAt, radius: "100m",
    note: "partner reports her missing; he says she left home for a relative's and never arrived" });
  s.respond("police", { flexible: true, to: home, at: callAt + 8, units: 1, holdFor: "90m", minUnits: 1 });
});

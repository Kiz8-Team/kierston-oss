/**
 * One simulated day: who went where, how, and whether the trip was possible.
 *
 * A day file is mostly movement, and movement is where a population edit shows
 * up second. Give people more cars and the mode split moves; give them cars in
 * the wrong places and the mode split barely moves while the mean car trip
 * gets three kilometres longer. So distance, duration and speed are profiled
 * per mode and per purpose, not just overall, and the hour-by-hour departure
 * curve is kept per mode as well — a peak that flattens is a scheduling change
 * nothing else here would report.
 *
 * The invariants matter more in this file than anywhere else, because a plan
 * is a chain and a chain can break in ways a distribution looks fine through.
 * A leg that arrives before it departs, a leg that starts where the last one
 * did not end, a walk at ninety kilometres an hour, a routed path with no
 * points behind a trip with distance: each of those is a specific way the
 * planner can fail, each is counted, and each carries a few example rows so a
 * regression is findable rather than merely known about.
 *
 * The routed paths are walked in full — thirty million points — to measure how
 * much longer the road is than the straight line. That ratio is the only thing
 * in a day file that says anything about the road network itself, and it moves
 * the moment routing changes.
 *
 * A version 3 day also carries the cellular network, which is four more tables
 * and lives in `network.ts` rather than here — it is a day of its own, keyed on
 * subscriptions rather than on people.
 */

import { columns, type Envelope } from "../format.ts";
import { Builder, Cat, Num, ageBand, band, moneyBand } from "../metrics.ts";
import type { Population } from "../population.ts";
import { analyseNetwork } from "./network.ts";

/** What each mode can plausibly average over a whole leg, in km/h. */
const CEILING: Record<string, number> = {
  walk: 9, bike: 45, car: 140, carpool: 140, taxi: 140, cab: 140,
  passenger: 140, transit: 120, bus: 120, other: 200,
};

const hour = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;

export function analyseDay(b: Builder, env: Envelope, pop: Population | null): void {
  const meta = env.meta;
  const a = columns(env);
  const modes: string[] = meta.enums.mode;
  const purposes: string[] = meta.enums.purpose;
  const kinds: string[] = meta.enums.scheduleKind;
  const labels: string[] = meta.strings;

  b.provenance.date = meta.date;
  b.provenance.day = meta.day;
  b.provenance.initDigest = meta.initDigest;
  for (const [name, value] of Object.entries(meta.counts)) b.scalar(`day.count.${name}`, value as number);
  b.scalar("day.count.strings", labels.length);

  people(b, a, pop);
  schedules(b, a, kinds, labels);
  legs(b, a, modes, purposes, labels, pop);
  transactions(b, a, meta.enums ?? {}, labels, pop, Number(meta.counts?.banked ?? 0));
  analyseNetwork(b, a, meta, pop);
}

/** Money moved during the day, including bills and income that have no trip. */
function transactions(
  b: Builder,
  a: Record<string, any>,
  enums: Record<string, string[]>,
  labels: string[],
  pop: Population | null,
  banked: number,
): void {
  // Version 1 day files predate transactions. A version 2 export made without
  // a bank has the columns but no rows; `day.transaction.banked` preserves the
  // important distinction between those and a banked day with no activity.
  b.scalar("day.transaction.banked", banked, "share");
  const amount = a["tx.amount"] as Float32Array | undefined;
  if (!amount) return;

  const minute = a["tx.minute"] as Int32Array;
  const kind = a["tx.kind"] as Uint8Array;
  const reason = a["tx.reason"] as Uint8Array;
  const approved = a["tx.approved"] as Uint8Array;
  const decline = a["tx.decline"] as Uint8Array;
  const instrument = a["tx.instrument"] as Uint8Array;
  const mcc = a["tx.mcc"] as Uint32Array;
  const merchant = a["tx.merchant"] as Uint32Array;
  const account = a["tx.account"] as Uint32Array;
  const balance = a["tx.balanceAfter"] as Float32Array;
  const personId = a["person.id"] as Uint32Array;
  const offset = a["person.txOffset"] as Uint32Array;
  const perPerson = a["person.txCount"] as Uint32Array;
  const kinds = enums.txKind ?? [];
  const reasons = enums.reason ?? [];
  const instruments = enums.instrument ?? [];
  const declines = enums.decline ?? [];
  const n = amount.length;

  const kindCat = new Cat();
  const reasonCat = new Cat();
  const instrumentCat = new Cat();
  const declineCat = new Cat();
  const merchantCat = new Cat();
  const mccCat = new Cat();
  const reasonByInstrument = new Cat();
  const reasonByApproval = new Cat();
  const amountAll = new Num();
  const minuteAll = new Num();
  const balanceAfter = new Num();
  const txByAge = new Cat();
  const amountByReason = new Map<string, Num>();
  let approvedCount = 0;
  let unknownKind = 0;
  let unknownReason = 0;
  let unknownInstrument = 0;
  let unknownDecline = 0;
  let nonpositiveAmount = 0;
  let approvedWithAccount = 0;
  let offsetsBroken = 0;

  for (let i = 0; i < n; i += 1) {
    const kindName = kinds[kind[i]] ?? `kind ${kind[i]}`;
    const reasonName = reasons[reason[i]] ?? `reason ${reason[i]}`;
    const instrumentName = instrument[i] === 0xff
      ? "«none»" : instruments[instrument[i]] ?? `instrument ${instrument[i]}`;
    kindCat.add(kindName);
    reasonCat.add(reasonName);
    instrumentCat.add(instrumentName);
    reasonByInstrument.add(`${reasonName} × ${instrumentName}`);
    reasonByApproval.add(`${reasonName} × ${approved[i] ? "approved" : "declined"}`);
    amountAll.push(amount[i]);
    minuteAll.push(minute[i]);
    if (!amountByReason.has(reasonName)) amountByReason.set(reasonName, new Num());
    amountByReason.get(reasonName)!.push(amount[i]);
    if (!Number.isNaN(balance[i])) balanceAfter.push(balance[i]);
    if (merchant[i] !== 0xffffffff) merchantCat.add(labels[merchant[i]] ?? `string ${merchant[i]}`);
    if (mcc[i]) mccCat.add(String(mcc[i]));
    if (approved[i]) approvedCount += 1;
    else if (decline[i] !== 0xff) declineCat.add(declines[decline[i]] ?? `decline ${decline[i]}`);

    if (!kinds[kind[i]]) unknownKind += 1;
    if (!reasons[reason[i]]) unknownReason += 1;
    if (instrument[i] !== 0xff && !instruments[instrument[i]]) unknownInstrument += 1;
    if (decline[i] !== 0xff && !declines[decline[i]]) unknownDecline += 1;
    // Invalid amounts are deliberately retained as declined attempts, so this
    // is a tracked rate rather than an invariant that a valid export violates.
    if (!Number.isFinite(amount[i]) || amount[i] <= 0) nonpositiveAmount += 1;
    if (approved[i] && account[i] !== 0xffffffff) approvedWithAccount += 1;
  }

  for (let p = 0; p < perPerson.length; p += 1) {
    if (offset[p] + perPerson[p] > n || (p > 0 && offset[p] !== offset[p - 1] + perPerson[p - 1])) {
      offsetsBroken += 1;
    }
    if (pop && personId[p] < pop.residents) {
      txByAge.add(ageBand(pop.age(personId[p])), perPerson[p]);
    }
  }

  b.num("day.person.transactions", perPerson);
  b.num("day.transaction.amount", amountAll);
  b.num("day.transaction.minute", minuteAll);
  b.num("day.transaction.balanceAfter", balanceAfter);
  b.cat("day.transaction.kind", kindCat);
  b.cat("day.transaction.reason", reasonCat);
  b.cat("day.transaction.instrument", instrumentCat);
  b.cat("day.transaction.decline", declineCat);
  b.cat("day.transaction.merchant", merchantCat);
  b.cat("day.transaction.mcc", mccCat);
  b.cat("day.transaction.reason×instrument", reasonByInstrument);
  b.cat("day.transaction.reason×approval", reasonByApproval);
  if (pop) b.cat("day.transaction.by.ageBand", txByAge);
  for (const [name, sketch] of amountByReason) b.num(`day.transaction.amount.by.reason.${name}`, sketch);
  b.countAndShare("day.transaction.approved", approvedCount, n);
  b.countAndShare("day.transaction.nonpositiveAmount", nonpositiveAmount, n);
  b.countAndShare("day.transaction.approvedWithAccount", approvedWithAccount, approvedCount);
  b.invariant("day.transaction.unknownKind", "every transaction kind is named by the header", unknownKind, n);
  b.invariant("day.transaction.unknownReason", "every transaction reason is named by the header", unknownReason, n);
  b.invariant("day.transaction.unknownInstrument", "every transaction instrument is named by the header", unknownInstrument, n);
  b.invariant("day.transaction.unknownDecline", "every decline reason is named by the header", unknownDecline, n);
  b.invariant("day.transaction.offsets", "each person's transaction slice is contiguous and in bounds", offsetsBroken, perPerson.length);
}

function people(b: Builder, a: Record<string, any>, pop: Population | null): void {
  const id = a["person.id"] as Uint32Array;
  const scheduleCount = a["person.scheduleCount"] as Uint32Array;
  const legCount = a["person.legCount"] as Uint32Array;
  const n = id.length;

  b.num("day.person.schedules", scheduleCount);
  b.num("day.person.legs", legCount);

  let idle = 0;
  let unscheduled = 0;
  let stray = 0;
  let outOfOrder = 0;
  const legsByAge = new Map<string, Num>();
  const legsBySex = new Map<string, Num>();
  const legsByEmployment = new Map<string, Num>();
  const legsByIncome = new Map<string, Num>();
  const idleByAge = new Map<string, [number, number]>();
  const push = (into: Map<string, Num>, key: string, value: number) => {
    if (!into.has(key)) into.set(key, new Num());
    into.get(key)!.push(value);
  };

  for (let i = 0; i < n; i += 1) {
    if (!legCount[i]) idle += 1;
    if (!scheduleCount[i]) unscheduled += 1;
    if (i && id[i] <= id[i - 1]) outOfOrder += 1;
    if (!pop) continue;
    if (id[i] >= pop.residents) { stray += 1; continue; }
    const bandName = ageBand(pop.age(id[i]));
    push(legsByAge, bandName, legCount[i]);
    push(legsBySex, pop.sex(id[i]), legCount[i]);
    push(legsByEmployment, pop.employment(id[i]), legCount[i]);
    push(legsByIncome, moneyBand(pop.income(id[i])), legCount[i]);
    const cell = idleByAge.get(bandName) ?? [0, 0];
    cell[0] += legCount[i] ? 0 : 1;
    cell[1] += 1;
    idleByAge.set(bandName, cell);
  }

  b.countAndShare("day.person.idle", idle, n);
  b.countAndShare("day.person.unscheduled", unscheduled, n);
  b.invariant("day.person.order", "person ids are unique and ascending", outOfOrder, n);
  if (pop) {
    b.invariant("day.person.stray", "every planned person is a resident", stray, n);
    b.countAndShare("day.person.missing", pop.residents - n, pop.residents);
    for (const [key, sketch] of [...legsByAge].sort()) b.num(`day.person.legs.by.ageBand.${key}`, sketch);
    for (const [key, sketch] of legsBySex) b.num(`day.person.legs.by.sex.${key}`, sketch);
    for (const [key, sketch] of legsByEmployment) b.num(`day.person.legs.by.employment.${key}`, sketch);
    for (const [key, sketch] of legsByIncome) b.num(`day.person.legs.by.incomeBand.${key}`, sketch);
    for (const [key, [alone, total]] of [...idleByAge].sort()) {
      b.scalar(`day.person.idle.by.ageBand.${key}`, total ? alone / total : 0, "share");
    }
  }
}

function schedules(b: Builder, a: Record<string, any>, kinds: string[], labels: string[]): void {
  const start = a["schedule.start"] as Int32Array;
  const end = a["schedule.end"] as Int32Array;
  const kind = a["schedule.kind"] as Uint8Array;
  const label = a["schedule.label"] as Uint32Array;
  const where = a["schedule.where"] as Uint32Array;
  const offset = a["person.scheduleOffset"] as Uint32Array;
  const count = a["person.scheduleCount"] as Uint32Array;
  const n = start.length;

  const kindCat = new Cat();
  const labelCat = new Cat();
  const placeCat = new Cat();
  const startHour = new Cat();
  const kindByHour = new Cat();
  const duration = new Num();
  const durationByKind = new Map<string, Num>();
  const startByKind = new Map<string, Num>();
  let backwards = 0;
  let overlong = 0;
  const examples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const name = kinds[kind[i]] ?? `kind ${kind[i]}`;
    kindCat.add(name);
    labelCat.add(labels[label[i]] ?? "—");
    placeCat.add(labels[where[i]] ?? "—");
    const minutes = end[i] - start[i];
    duration.push(minutes);
    if (!durationByKind.has(name)) {
      durationByKind.set(name, new Num());
      startByKind.set(name, new Num());
    }
    durationByKind.get(name)!.push(minutes);
    startByKind.get(name)!.push(start[i]);
    if (start[i] >= 0 && start[i] < 1440) {
      startHour.add(hour(start[i]));
      kindByHour.add(`${name} × ${hour(start[i])}`);
    }
    if (minutes < 0) {
      backwards += 1;
      if (examples.length < 5) examples.push(`schedule ${i}: ${start[i]} → ${end[i]}`);
    }
    if (minutes > 20 * 60) overlong += 1;
  }

  b.cat("day.schedule.kind", kindCat);
  b.cat("day.schedule.label", labelCat);
  b.cat("day.schedule.where", placeCat);
  b.cat("day.schedule.startHour", startHour);
  b.cat("day.schedule.kind×startHour", kindByHour);
  b.num("day.schedule.duration", duration);
  for (const [key, sketch] of durationByKind) b.num(`day.schedule.duration.by.kind.${key}`, sketch);
  for (const [key, sketch] of startByKind) b.num(`day.schedule.start.by.kind.${key}`, sketch);
  b.invariant("day.schedule.backwards", "a schedule entry does not end before it starts", backwards, n, examples);
  b.invariant("day.schedule.overlong", "no single entry runs longer than twenty hours", overlong, n);

  // Two entries in one person's day that claim the same minutes. The planner
  // sorts them, so this is a check on the plan rather than on the packing.
  //
  // Not every overlap is a fault, and counting them together hid the ones that
  // are. `roster.ts` marks a block *porous* when it is somewhere a person can
  // be interrupted — working from home is the case that matters — and the
  // simulation is entitled to put a dinner inside one. Somebody who works from
  // home 09:00 to 19:13 and walks out to a restaurant at 18:47 has not been
  // cloned; they stopped working and went to dinner, and the block was never a
  // claim that they sat at a desk for the whole of it.
  //
  // So a pair with a porous side is counted apart from a pair without one.
  // Before the split, seven of every ten reported overlaps were this, which is
  // what buried the genuine cases underneath them.
  const porous = (i: number) => (labels[label[i]] ?? "").includes("(porous)");

  let overlapping = 0;
  let interrupted = 0;
  let checked = 0;
  const clashes: string[] = [];
  const describe = (p: number, i: number) =>
    `person ${p}: ${labels[label[i - 1]] ?? "—"} ${start[i - 1]}–${end[i - 1]}`
    + ` then ${labels[label[i]] ?? "—"} ${start[i]}–${end[i]}`;

  for (let p = 0; p < count.length; p += 1) {
    for (let i = offset[p] + 1; i < offset[p] + count[p]; i += 1) {
      checked += 1;
      if (start[i] >= end[i - 1]) continue;
      if (porous(i) || porous(i - 1)) {
        interrupted += 1;
        continue;
      }
      overlapping += 1;
      if (clashes.length < 5) clashes.push(describe(p, i));
    }
  }

  b.invariant(
    "day.schedule.overlap",
    "one person's entries do not overlap, porous blocks aside",
    overlapping,
    checked,
    clashes,
  );
  // Kept as a number rather than a rule: it is expected, but a large move in it
  // still says something about how much of the day is being spent at home.
  b.scalar("day.schedule.overlap.porous", interrupted);
}

function legs(
  b: Builder,
  a: Record<string, any>,
  modes: string[],
  purposes: string[],
  labels: string[],
  pop: Population | null,
): void {
  const depart = a["leg.depart"] as Int32Array;
  const arrive = a["leg.arrive"] as Int32Array;
  const mode = a["leg.mode"] as Uint8Array;
  const purpose = a["leg.purpose"] as Uint8Array;
  const fromLat = a["leg.fromLatE6"] as Int32Array;
  const fromLon = a["leg.fromLonE6"] as Int32Array;
  const toLat = a["leg.toLatE6"] as Int32Array;
  const toLon = a["leg.toLonE6"] as Int32Array;
  const km = a["leg.kilometres"] as Float32Array;
  const estimated = a["leg.estimated"] as Uint8Array;
  const wait = a["leg.wait"] as Float32Array;
  const fromLabel = a["leg.fromLabel"] as Uint32Array;
  const toLabel = a["leg.toLabel"] as Uint32Array;
  const pathOffset = a["leg.pathOffset"] as Uint32Array;
  const pathCount = a["leg.pathCount"] as Uint32Array;
  const pathLat = a["path.latE6"] as Int32Array;
  const pathLon = a["path.lonE6"] as Int32Array;
  const personId = a["person.id"] as Uint32Array;
  const legOffset = a["person.legOffset"] as Uint32Array;
  const legCount = a["person.legCount"] as Uint32Array;
  const n = depart.length;

  const modeCat = new Cat();
  const purposeCat = new Cat();
  const modeByPurpose = new Cat();
  const departHour = new Cat();
  const modeByHour = new Cat();
  const purposeByHour = new Cat();
  const distanceBand = new Cat();
  const modeByDistance = new Cat();
  const fromCat = new Cat();
  const toCat = new Cat();
  const distance = new Num();
  const straight = new Num();
  const detour = new Num();
  const duration = new Num();
  const speed = new Num();
  const waiting = new Num();
  const points = new Num();
  const departures = new Num();
  const byMode: Record<string, { km: Num; minutes: Num; speed: Num; wait: Num; detour: Num }> = {};
  const kmByPurpose = new Map<string, Num>();
  let waited = 0;
  let backwards = 0;
  let instant = 0;
  let negative = 0;
  let pathless = 0;
  let impossible = 0;
  let unknownMode = 0;
  let unknownPurpose = 0;
  const backwardsExamples: string[] = [];
  const impossibleExamples: string[] = [];
  const pathlessExamples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const modeName = modes[mode[i]] ?? `mode ${mode[i]}`;
    const purposeName = purposes[purpose[i]] ?? `purpose ${purpose[i]}`;
    if (!modes[mode[i]]) unknownMode += 1;
    if (!purposes[purpose[i]]) unknownPurpose += 1;
    modeCat.add(modeName);
    purposeCat.add(purposeName);
    modeByPurpose.add(`${modeName} × ${purposeName}`);
    fromCat.add(labels[fromLabel[i]] ?? "—");
    toCat.add(labels[toLabel[i]] ?? "—");

    const minutes = arrive[i] - depart[i];
    duration.push(minutes);
    departures.push(depart[i]);
    if (depart[i] >= 0 && depart[i] < 1440) {
      departHour.add(hour(depart[i]));
      modeByHour.add(`${modeName} × ${hour(depart[i])}`);
      purposeByHour.add(`${purposeName} × ${hour(depart[i])}`);
    }

    const travelled = km[i];
    distance.push(travelled);
    distanceBand.add(band(travelled, [0.5, 1, 2, 5, 10, 25, 50], "km"));
    modeByDistance.add(`${modeName} × ${band(travelled, [0.5, 1, 2, 5, 10, 25, 50], "km")}`);
    const line = haversine(fromLat[i], fromLon[i], toLat[i], toLon[i]);
    straight.push(line);
    const ratio = line > 0.05 ? travelled / line : null;
    if (ratio !== null) detour.push(ratio);

    const hours = minutes / 60;
    const pace = hours > 0 ? travelled / hours : null;
    if (pace !== null) speed.push(pace);
    waiting.push(wait[i]);
    if (wait[i] > 0) waited += 1;
    points.push(pathCount[i]);

    if (!byMode[modeName]) {
      byMode[modeName] = { km: new Num(), minutes: new Num(), speed: new Num(), wait: new Num(), detour: new Num() };
    }
    const bucket = byMode[modeName];
    bucket.km.push(travelled);
    bucket.minutes.push(minutes);
    bucket.speed.push(pace);
    bucket.wait.push(wait[i]);
    bucket.detour.push(ratio);
    if (!kmByPurpose.has(purposeName)) kmByPurpose.set(purposeName, new Num());
    kmByPurpose.get(purposeName)!.push(travelled);

    if (minutes < 0) {
      backwards += 1;
      if (backwardsExamples.length < 5) backwardsExamples.push(`leg ${i}: departs ${depart[i]}, arrives ${arrive[i]}`);
    } else if (minutes === 0 && travelled > 0.1) instant += 1;
    if (travelled < 0) negative += 1;
    if (travelled > 0.1 && pathCount[i] === 0) {
      pathless += 1;
      if (pathlessExamples.length < 5) pathlessExamples.push(`leg ${i}: ${travelled.toFixed(2)} km by ${modeName}, no routed path`);
    }
    const ceiling = CEILING[modeName] ?? 200;
    if (pace !== null && pace > ceiling) {
      impossible += 1;
      if (impossibleExamples.length < 5) {
        impossibleExamples.push(`leg ${i}: ${modeName} at ${pace.toFixed(0)} km/h over ${travelled.toFixed(2)} km`);
      }
    }
  }

  b.cat("day.leg.mode", modeCat);
  b.cat("day.leg.purpose", purposeCat);
  b.cat("day.leg.mode×purpose", modeByPurpose);
  b.cat("day.leg.departHour", departHour);
  b.cat("day.leg.mode×departHour", modeByHour);
  b.cat("day.leg.purpose×departHour", purposeByHour);
  b.cat("day.leg.distanceBand", distanceBand);
  b.cat("day.leg.mode×distanceBand", modeByDistance);
  b.cat("day.leg.from", fromCat);
  b.cat("day.leg.to", toCat);
  b.num("day.leg.kilometres", distance);
  b.num("day.leg.straightLineKm", straight);
  b.num("day.leg.detourRatio", detour);
  b.num("day.leg.minutes", duration);
  b.num("day.leg.kmPerHour", speed);
  b.num("day.leg.wait", waiting);
  b.num("day.leg.pathPoints", points);
  b.num("day.leg.departMinute", departures);
  b.countAndShare("day.leg.waited", waited, n);
  b.countAndShare("day.leg.estimated", count(estimated), n);
  for (const [name, bucket] of Object.entries(byMode)) {
    b.num(`day.leg.kilometres.by.mode.${name}`, bucket.km);
    b.num(`day.leg.minutes.by.mode.${name}`, bucket.minutes);
    b.num(`day.leg.kmPerHour.by.mode.${name}`, bucket.speed);
    b.num(`day.leg.wait.by.mode.${name}`, bucket.wait);
    b.num(`day.leg.detourRatio.by.mode.${name}`, bucket.detour);
  }
  for (const [name, sketch] of kmByPurpose) b.num(`day.leg.kilometres.by.purpose.${name}`, sketch);

  b.invariant("day.leg.backwards", "a leg does not arrive before it departs", backwards, n, backwardsExamples);
  b.invariant("day.leg.instant", "a leg with distance takes time", instant, n);
  b.invariant("day.leg.negativeDistance", "no leg covers negative distance", negative, n);
  b.invariant("day.leg.pathless", "a leg with distance carries a routed path", pathless, n, pathlessExamples);
  b.invariant("day.leg.impossibleSpeed", "no leg exceeds what its mode can average", impossible, n, impossibleExamples);
  b.invariant("day.leg.unknownMode", "every leg's mode is one the header names", unknownMode, n);
  b.invariant("day.leg.unknownPurpose", "every leg's purpose is one the header names", unknownPurpose, n);

  chains(b, { depart, arrive, fromLat, fromLon, toLat, toLon, legOffset, legCount, purpose, purposes });
  paths(b, { pathOffset, pathCount, pathLat, pathLon, km, mode, modes });
  if (pop) modeShare(b, { mode, modes, legOffset, legCount, personId }, pop);
}

/** Whether each person's day joins up: leg to leg, and back home at the end. */
function chains(b: Builder, d: any): void {
  let broken = 0;
  let checked = 0;
  let overlapping = 0;
  let endsAtHome = 0;
  let tours = 0;
  const examples: string[] = [];
  const chainLength = new Num();

  for (let p = 0; p < d.legCount.length; p += 1) {
    const first = d.legOffset[p];
    const last = first + d.legCount[p];
    if (d.legCount[p] === 0) continue;
    tours += 1;
    chainLength.push(d.legCount[p]);
    if (d.purposes[d.purpose[last - 1]] === "home") endsAtHome += 1;
    for (let i = first + 1; i < last; i += 1) {
      checked += 1;
      if (d.fromLat[i] !== d.toLat[i - 1] || d.fromLon[i] !== d.toLon[i - 1]) {
        broken += 1;
        if (examples.length < 5) {
          examples.push(`person row ${p}: leg ${i - 1} ends ${d.toLat[i - 1]},${d.toLon[i - 1]} but leg ${i} starts ${d.fromLat[i]},${d.fromLon[i]}`);
        }
      }
      if (d.depart[i] < d.arrive[i - 1]) overlapping += 1;
    }
  }

  b.num("day.tour.legs", chainLength);
  b.countAndShare("day.tour.endsAtHome", endsAtHome, tours);
  b.invariant("day.tour.broken", "each leg starts where the last one ended", broken, checked, examples);
  b.invariant("day.tour.overlap", "a leg does not depart before the previous one arrives", overlapping, checked);
}

/**
 * The routed geometry, measured rather than trusted.
 *
 * `leg.kilometres` is what the planner recorded; walking the path is what the
 * road network actually laid down. Where the two disagree the trip was costed
 * against a route nobody took, which is a class of bug no distribution over
 * `kilometres` alone can see.
 */
function paths(b: Builder, d: any): void {
  const measured = new Num();
  const drift = new Num();
  const perMode = new Map<string, Num>();
  let disagreeing = 0;
  let checked = 0;
  const examples: string[] = [];

  for (let i = 0; i < d.pathCount.length; i += 1) {
    const count = d.pathCount[i];
    if (count < 2) continue;
    let total = 0;
    const start = d.pathOffset[i];
    for (let p = start + 1; p < start + count; p += 1) {
      total += haversine(d.pathLat[p - 1], d.pathLon[p - 1], d.pathLat[p], d.pathLon[p]);
    }
    measured.push(total);
    const name = d.modes[d.mode[i]] ?? `mode ${d.mode[i]}`;
    if (!perMode.has(name)) perMode.set(name, new Num());
    perMode.get(name)!.push(total);
    const claimed = d.km[i];
    if (claimed > 0.1) {
      checked += 1;
      const ratio = total / claimed;
      drift.push(ratio);
      if (ratio < 0.5 || ratio > 2) {
        disagreeing += 1;
        if (examples.length < 5) {
          examples.push(`leg ${i}: recorded ${claimed.toFixed(2)} km, path measures ${total.toFixed(2)} km`);
        }
      }
    }
  }

  b.num("day.path.measuredKm", measured);
  b.num("day.path.measuredOverRecorded", drift);
  for (const [name, sketch] of perMode) b.num(`day.path.measuredKm.by.mode.${name}`, sketch);
  b.invariant("day.path.disagrees", "a routed path is within a factor of two of the recorded distance", disagreeing, checked, examples);
}

/** Mode share within each demographic band — the join a day file exists for. */
function modeShare(b: Builder, d: any, pop: Population): void {
  const byAge = new Cat();
  const bySex = new Cat();
  const byIncome = new Cat();
  const byEmployment = new Cat();
  const byEducation = new Cat();
  const drivers = new Set<number>();

  for (let p = 0; p < d.legCount.length; p += 1) {
    const id = d.personId[p];
    if (id >= pop.residents) continue;
    const bandName = ageBand(pop.age(id));
    const sex = pop.sex(id);
    const income = moneyBand(pop.income(id));
    const status = pop.employment(id);
    const schooling = pop.education(id);
    for (let i = d.legOffset[p]; i < d.legOffset[p] + d.legCount[p]; i += 1) {
      const name = d.modes[d.mode[i]] ?? `mode ${d.mode[i]}`;
      byAge.add(`${bandName} × ${name}`);
      bySex.add(`${sex} × ${name}`);
      byIncome.add(`${income} × ${name}`);
      byEmployment.add(`${status} × ${name}`);
      if (pop.age(id) >= 25) byEducation.add(`${schooling} × ${name}`);
      if (name === "car") drivers.add(id);
    }
  }

  b.cat("day.mode.by.ageBand", byAge);
  b.cat("day.mode.by.sex", bySex);
  b.cat("day.mode.by.incomeBand", byIncome);
  b.cat("day.mode.by.employment", byEmployment);
  b.cat("day.mode.by.education", byEducation);
  b.countAndShare("day.mode.drivers", drivers.size, pop.residents);
}

const count = (values: Uint8Array) => {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i]) total += 1;
  return total;
};

/** Kilometres between two microdegree points. */
function haversine(latA: number, lonA: number, latB: number, lonB: number): number {
  const toRad = Math.PI / 180e6;
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

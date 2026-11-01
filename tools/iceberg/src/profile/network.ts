/**
 * The day on the cellular network: who is on it, what they camped on, and what
 * the operator would have logged.
 *
 * A version 3 day file carries four tables, and the reason they are profiled
 * together is that none of them means anything alone. A cell is a row of
 * geometry; a span is a foreign key into it; an event is a claim about a span.
 * The measurements worth having are the joins — RSRP by exposure, layer by
 * handset tier, an operator's share of the minutes it served rather than of
 * the cells it owns — and the rules worth checking are almost all rules about
 * two tables agreeing.
 *
 * Three of those rules earn their place over anything a distribution could
 * show:
 *
 *   The span table tiles the day. Every subscriber's spans run from midnight
 *   to midnight with no gap and no overlap, because a handset is always
 *   somewhere even when that somewhere is "off". A gap is not a small error —
 *   it is a stretch of a person's day that no consumer can ask about, and it
 *   is invisible in every aggregate here because the minutes simply stop being
 *   counted.
 *
 *   A span sits in its owner's slice. The exporter writes spans per person and
 *   the network layer keys them per subscriber, so the two indexes have to
 *   agree; if they ever drift, every record in the file points at the wrong
 *   person while every count stays exactly right.
 *
 *   An LTE-only handset never appears on an NR cell. That is a fact about the
 *   device rather than a modelling choice — a 2017 phone has no NR radio — and
 *   it is the one place where a serving decision can be wrong in a way that
 *   still looks entirely plausible in the aggregate.
 *
 * The event table is deliberately not asserted to be a subset of anything. It
 * is what a network's own records would hold, the spans are the ground truth,
 * and the whole point of shipping both is that they differ; what is checked is
 * that where they do speak about the same minute, they say the same thing.
 */

import { Builder, Cat, Num, ageBand, moneyBand } from "../metrics.ts";
import type { Population } from "../population.ts";

/** Minutes in the simulated day, which the span table has to tile exactly. */
const MINUTES = 1440;
/** No serving cell: powered off, out of coverage, or nowhere to be. */
const UNATTACHED = -1;
/** The widest RSRP a link budget can honestly produce, dBm. */
const RSRP_RANGE: [number, number] = [-145, -20];
/** Physical cell identities are 0..503 in LTE and NR alike. */
const PCI_MAX = 503;

const hour = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;

interface Subs {
  n: number;
  person: Uint32Array;
  operator: Uint8Array;
  tier: Uint8Array;
}

interface CellTable {
  n: number;
  operator: Uint8Array;
  layer: Uint8Array;
}

export function analyseNetwork(
  b: Builder,
  a: Record<string, any>,
  meta: any,
  pop: Population | null,
): void {
  // The same distinction `banked` draws for the money: a day exported without
  // a network on the context is not a city where nobody had a phone.
  b.scalar("day.network.networked", Number(meta.counts?.networked ?? 0), "share");
  if (!a["span.subscriber"]) return;

  const enums: Record<string, string[]> = meta.enums ?? {};
  const labels: string[] = meta.strings ?? [];
  const subs = subscribers(b, a, enums, labels, pop);
  const cells = cellTable(b, a, enums, labels);
  spans(b, a, subs, cells, enums, pop);
  events(b, a, subs, cells, enums);
}

/** Who is on the network, and how thinly it is spread across the population. */
function subscribers(
  b: Builder,
  a: Record<string, any>,
  enums: Record<string, string[]>,
  labels: string[],
  pop: Population | null,
): Subs {
  const person = a["subscriber.person"] as Uint32Array;
  const imsi = a["subscriber.imsi"] as Uint32Array;
  const imei = a["subscriber.imei"] as Uint32Array;
  const msisdn = a["subscriber.msisdn"] as Uint32Array;
  const carrier = a["subscriber.carrier"] as Uint32Array;
  const operator = a["subscriber.operator"] as Uint8Array;
  const tier = a["subscriber.tier"] as Uint8Array;
  const mvno = a["subscriber.mvno"] as Uint8Array;
  const prepaid = a["subscriber.prepaid"] as Uint8Array;
  const operators = enums.operator ?? [];
  const tiers = enums.radioTier ?? [];
  const n = person.length;

  const carrierCat = new Cat();
  const operatorCat = new Cat();
  const tierCat = new Cat();
  const carrierByOperator = new Cat();
  const tierByOperator = new Cat();
  const perPerson = new Map<number, number>();
  let mvnoCount = 0;
  let prepaidCount = 0;
  let unknownOperator = 0;
  let unknownTier = 0;
  let stray = 0;
  const strayExamples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const operatorName = operators[operator[i]] ?? `operator ${operator[i]}`;
    const tierName = tiers[tier[i]] ?? `tier ${tier[i]}`;
    const carrierName = labels[carrier[i]] ?? "—";
    carrierCat.add(carrierName);
    operatorCat.add(operatorName);
    tierCat.add(tierName);
    carrierByOperator.add(`${carrierName} × ${operatorName}`);
    tierByOperator.add(`${tierName} × ${operatorName}`);
    if (!operators[operator[i]]) unknownOperator += 1;
    if (!tiers[tier[i]]) unknownTier += 1;
    if (mvno[i]) mvnoCount += 1;
    if (prepaid[i]) prepaidCount += 1;
    perPerson.set(person[i], (perPerson.get(person[i]) ?? 0) + 1);
    if (pop && person[i] >= pop.residents) {
      stray += 1;
      if (strayExamples.length < 5) strayExamples.push(`subscriber ${i}: person ${person[i]} of ${pop.residents}`);
    }
  }

  b.cat("day.subscriber.carrier", carrierCat);
  b.cat("day.subscriber.operator", operatorCat);
  b.cat("day.subscriber.radioTier", tierCat);
  b.cat("day.subscriber.carrier×operator", carrierByOperator);
  b.cat("day.subscriber.radioTier×operator", tierByOperator);
  b.countAndShare("day.subscriber.mvno", mvnoCount, n);
  b.countAndShare("day.subscriber.prepaid", prepaidCount, n);

  const counts = new Num();
  for (const value of perPerson.values()) counts.push(value);
  b.num("day.subscriber.perSubscribedPerson", counts);
  b.countAndShare("day.subscriber.people", perPerson.size, n);

  // Identifiers are the one thing in this table that has to be unique. An IMEI
  // is not: a handset with two SIMs is one device on two subscriptions, so
  // that one is a tracked rate rather than a rule.
  b.invariant("day.subscriber.imsi.unique", "no two subscriptions share an IMSI", n - distinct(imsi), n);
  b.invariant("day.subscriber.msisdn.unique", "no two subscriptions share a number", n - distinct(msisdn), n);
  b.countAndShare("day.subscriber.imei.shared", n - distinct(imei), n);
  b.invariant("day.subscriber.unknownOperator", "every subscriber's operator is named by the header", unknownOperator, n);
  b.invariant("day.subscriber.unknownRadioTier", "every handset's radio tier is named by the header", unknownTier, n);

  if (pop) {
    // Phone ownership by age and by income, which is the calibration this
    // table exists to be judged on: a city where every four-year-old carries a
    // handset is wrong in a way no count of subscriptions can show.
    b.invariant("day.subscriber.stray", "every subscription belongs to a resident", stray, n, strayExamples);
    b.countAndShare("day.subscriber.penetration", perPerson.size, pop.residents);
    const byAge = new Map<string, [number, number]>();
    const byIncome = new Map<string, [number, number]>();
    for (let id = 0; id < pop.residents; id += 1) {
      const has = perPerson.has(id) ? 1 : 0;
      for (const [into, key] of [
        [byAge, ageBand(pop.age(id))] as const,
        [byIncome, moneyBand(pop.income(id))] as const,
      ]) {
        const cell = into.get(key) ?? [0, 0];
        cell[0] += has;
        cell[1] += 1;
        into.set(key, cell);
      }
    }
    for (const [key, [with_, total]] of [...byAge].sort()) {
      b.scalar(`day.subscriber.penetration.by.ageBand.${key}`, total ? with_ / total : 0, "share");
    }
    for (const [key, [with_, total]] of [...byIncome].sort()) {
      b.scalar(`day.subscriber.penetration.by.incomeBand.${key}`, total ? with_ / total : 0, "share");
    }
  }

  return { n, person, operator, tier };
}

/** The network as built: sites, sectors, bands and the areas they announce. */
function cellTable(
  b: Builder,
  a: Record<string, any>,
  enums: Record<string, string[]>,
  labels: string[],
): CellTable {
  const cgi = a["cell.cgi"] as Uint32Array;
  const structure = a["cell.structure"] as Uint32Array;
  const operator = a["cell.operator"] as Uint8Array;
  const layer = a["cell.layer"] as Uint8Array;
  const band = a["cell.band"] as Uint32Array;
  const area = a["cell.trackingArea"] as Uint32Array;
  const pci = a["cell.pci"] as Uint32Array;
  const lat = a["cell.latE6"] as Int32Array;
  const lon = a["cell.lonE6"] as Int32Array;
  const operators = enums.operator ?? [];
  const layers = enums.radioLayer ?? [];
  const n = cgi.length;

  const operatorCat = new Cat();
  const layerCat = new Cat();
  const bandCat = new Cat();
  const operatorByLayer = new Cat();
  const operatorByBand = new Cat();
  const perStructure = new Map<number, number>();
  const perArea = new Map<number, number>();
  const areasByOperator = new Map<string, Set<number>>();
  let unknownOperator = 0;
  let unknownLayer = 0;
  let badPci = 0;
  let unplaced = 0;
  const pciExamples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const operatorName = operators[operator[i]] ?? `operator ${operator[i]}`;
    const layerName = layers[layer[i]] ?? `layer ${layer[i]}`;
    const bandName = labels[band[i]] ?? "—";
    operatorCat.add(operatorName);
    layerCat.add(layerName);
    bandCat.add(bandName);
    operatorByLayer.add(`${operatorName} × ${layerName}`);
    operatorByBand.add(`${operatorName} × ${bandName}`);
    if (!operators[operator[i]]) unknownOperator += 1;
    if (!layers[layer[i]]) unknownLayer += 1;
    perStructure.set(structure[i], (perStructure.get(structure[i]) ?? 0) + 1);
    perArea.set(area[i], (perArea.get(area[i]) ?? 0) + 1);
    if (!areasByOperator.has(operatorName)) areasByOperator.set(operatorName, new Set());
    areasByOperator.get(operatorName)!.add(area[i]);
    if (pci[i] > PCI_MAX) {
      badPci += 1;
      if (pciExamples.length < 5) pciExamples.push(`cell ${i}: pci ${pci[i]}`);
    }
    if (lat[i] === 0 && lon[i] === 0) unplaced += 1;
  }

  const sectors = new Num();
  for (const value of perStructure.values()) sectors.push(value);
  const areaSize = new Num();
  for (const value of perArea.values()) areaSize.push(value);

  b.scalar("day.cell.count", n);
  b.scalar("day.cell.structures", perStructure.size);
  b.scalar("day.cell.trackingAreas", perArea.size);
  b.cat("day.cell.operator", operatorCat);
  b.cat("day.cell.layer", layerCat);
  b.cat("day.cell.band", bandCat);
  b.cat("day.cell.operator×layer", operatorByLayer);
  b.cat("day.cell.operator×band", operatorByBand);
  b.num("day.cell.perStructure", sectors);
  b.num("day.cell.perTrackingArea", areaSize);
  b.num("day.cell.pci", pci);
  for (const [name, areas] of [...areasByOperator].sort()) {
    b.scalar(`day.cell.trackingAreas.by.operator.${name}`, areas.size);
  }

  b.invariant("day.cell.cgi.unique", "no two cells share a global identity", n - distinct(cgi), n);
  b.invariant("day.cell.unknownOperator", "every cell's operator is named by the header", unknownOperator, n);
  b.invariant("day.cell.unknownLayer", "every cell's radio layer is named by the header", unknownLayer, n);
  b.invariant("day.cell.pci", "a physical cell identity is inside 0..503", badPci, n, pciExamples);
  b.invariant("day.cell.unplaced", "every cell has a position", unplaced, n);

  return { n, operator, layer };
}

/**
 * Where each handset actually was, minute by minute.
 *
 * The span table is the file's ground truth, so it is where the structural
 * rules live: the day is tiled, the slices belong to the right people, and no
 * handset is served by a radio it does not have.
 */
function spans(
  b: Builder,
  a: Record<string, any>,
  subs: Subs,
  cells: CellTable,
  enums: Record<string, string[]>,
  pop: Population | null,
): void {
  const subscriber = a["span.subscriber"] as Uint32Array;
  const cell = a["span.cell"] as Int32Array;
  const start = a["span.start"] as Int32Array;
  const end = a["span.end"] as Int32Array;
  const rsrp = a["span.rsrp"] as Float32Array;
  const exposure = a["span.exposure"] as Uint8Array;
  const connected = a["span.connected"] as Int32Array;
  const personId = a["person.id"] as Uint32Array;
  const offset = a["person.spanOffset"] as Uint32Array;
  const perPerson = a["person.spanCount"] as Uint32Array;
  const exposures = enums.exposure ?? [];
  const layers = enums.radioLayer ?? [];
  const operators = enums.operator ?? [];
  const tiers = enums.radioTier ?? [];
  const n = subscriber.length;

  const minutes = new Num();
  const attachedMinutes = new Num();
  const signal = new Num();
  const connectedShare = new Num();
  const exposureCat = new Cat();
  const layerCat = new Cat();
  const operatorCat = new Cat();
  const spansByAge = new Cat();
  const rsrpByExposure = new Map<string, Num>();
  const rsrpByLayer = new Map<string, Num>();
  const servedByOperator = new Cat();
  const cellsPerSubscriber = new Num();
  const coverage = new Num();
  let unattachedRows = 0;
  let unattachedMinutes = 0;
  let totalMinutes = 0;
  let connectedTotal = 0;
  let unknownExposure = 0;
  let strayCell = 0;
  let straySubscriber = 0;
  let backwards = 0;
  let overConnected = 0;
  let idleConnected = 0;
  let badSignal = 0;
  let signalWhenUnattached = 0;
  let wrongPerson = 0;
  let impossibleRadio = 0;
  let offsetsBroken = 0;
  const backwardsExamples: string[] = [];
  const signalExamples: string[] = [];
  const personExamples: string[] = [];
  const radioExamples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const held = end[i] - start[i];
    minutes.push(held);
    totalMinutes += held;
    exposureCat.add(exposures[exposure[i]] ?? `exposure ${exposure[i]}`, held);
    if (!exposures[exposure[i]]) unknownExposure += 1;
    connectedTotal += connected[i];

    if (held <= 0) {
      backwards += 1;
      if (backwardsExamples.length < 5) backwardsExamples.push(`span ${i}: ${start[i]} → ${end[i]}`);
    }
    if (connected[i] > held || connected[i] < 0) overConnected += 1;
    if (subscriber[i] >= subs.n) { straySubscriber += 1; continue; }

    if (cell[i] === UNATTACHED) {
      unattachedRows += 1;
      unattachedMinutes += held;
      if (connected[i] > 0) idleConnected += 1;
      if (Number.isFinite(rsrp[i])) signalWhenUnattached += 1;
      continue;
    }
    if (cell[i] < 0 || cell[i] >= cells.n) { strayCell += 1; continue; }

    attachedMinutes.push(held);
    const layerName = layers[cells.layer[cell[i]]] ?? `layer ${cells.layer[cell[i]]}`;
    const operatorName = operators[cells.operator[cell[i]]] ?? `operator ${cells.operator[cell[i]]}`;
    layerCat.add(layerName, held);
    operatorCat.add(operatorName, held);
    servedByOperator.add(
      `${operators[subs.operator[subscriber[i]]] ?? "—"} × ${operatorName}`,
      held,
    );
    signal.push(rsrp[i]);
    if (held > 0) connectedShare.push(connected[i] / held);
    if (!rsrpByExposure.has(exposures[exposure[i]] ?? "—")) rsrpByExposure.set(exposures[exposure[i]] ?? "—", new Num());
    rsrpByExposure.get(exposures[exposure[i]] ?? "—")!.push(rsrp[i]);
    if (!rsrpByLayer.has(layerName)) rsrpByLayer.set(layerName, new Num());
    rsrpByLayer.get(layerName)!.push(rsrp[i]);

    if (!Number.isFinite(rsrp[i]) || rsrp[i] < RSRP_RANGE[0] || rsrp[i] > RSRP_RANGE[1]) {
      badSignal += 1;
      if (signalExamples.length < 5) signalExamples.push(`span ${i}: rsrp ${rsrp[i]}`);
    }
    // An LTE-only handset has no NR radio at all, so an NR layer under it is
    // the serving decision having ignored what the device is.
    if (subs.tier[subscriber[i]] === 0 && layerName.startsWith("NR")) {
      impossibleRadio += 1;
      if (radioExamples.length < 5) {
        radioExamples.push(`span ${i}: ${tiers[subs.tier[subscriber[i]]] ?? "?"} handset on ${layerName}`);
      }
    }
  }

  // The two structural rules, which need the spans grouped rather than counted.
  // Spans arrive in person order and, inside a person, in subscriber order, so
  // one pass over the runs answers both.
  const seen = new Set<number>();
  let gaps = 0;
  let tiled = 0;
  const gapExamples: string[] = [];
  for (let p = 0; p < perPerson.length; p += 1) {
    const first = offset[p];
    const last = first + perPerson[p];
    if (last > n || (p > 0 && offset[p] !== offset[p - 1] + perPerson[p - 1])) offsetsBroken += 1;
    let runStart = first;
    for (let i = first; i < last; i += 1) {
      if (subscriber[i] < subs.n && subs.person[subscriber[i]] !== personId[p]) {
        wrongPerson += 1;
        if (personExamples.length < 5) {
          personExamples.push(
            `span ${i}: in person ${personId[p]}'s slice, subscriber ${subscriber[i]} belongs to ${subs.person[subscriber[i]]}`,
          );
        }
      }
      const boundary = i + 1 === last || subscriber[i + 1] !== subscriber[i];
      if (!boundary) continue;
      seen.add(subscriber[i]);
      tiled += 1;
      let broken = start[runStart] !== 0 || end[i] !== MINUTES;
      const distinctCells = new Set<number>();
      for (let j = runStart; j <= i; j += 1) {
        if (j > runStart && start[j] !== end[j - 1]) broken = true;
        if (cell[j] !== UNATTACHED) distinctCells.add(cell[j]);
      }
      cellsPerSubscriber.push(distinctCells.size);
      let attached = 0;
      for (let j = runStart; j <= i; j += 1) if (cell[j] !== UNATTACHED) attached += end[j] - start[j];
      coverage.push(attached / MINUTES);
      if (broken) {
        gaps += 1;
        if (gapExamples.length < 5) {
          gapExamples.push(`subscriber ${subscriber[i]}: spans run ${start[runStart]}–${end[i]} in ${i - runStart + 1} pieces`);
        }
      }
      runStart = i + 1;
    }
    if (pop && personId[p] < pop.residents && perPerson[p] > 0) {
      spansByAge.add(ageBand(pop.age(personId[p])), perPerson[p]);
    }
  }

  b.num("day.span.minutes", minutes);
  b.num("day.span.attachedMinutes", attachedMinutes);
  b.num("day.span.rsrp", signal);
  b.num("day.span.connectedShare", connectedShare);
  b.num("day.person.spans", perPerson);
  b.num("day.span.cellsPerSubscriber", cellsPerSubscriber);
  b.num("day.span.coveragePerSubscriber", coverage);
  b.cat("day.span.exposureMinutes", exposureCat);
  b.cat("day.span.layerMinutes", layerCat);
  b.cat("day.span.operatorMinutes", operatorCat);
  b.cat("day.span.homeOperator×servingOperator", servedByOperator);
  if (pop) b.cat("day.span.by.ageBand", spansByAge);
  for (const [name, sketch] of [...rsrpByExposure].sort()) b.num(`day.span.rsrp.by.exposure.${name}`, sketch);
  for (const [name, sketch] of [...rsrpByLayer].sort()) b.num(`day.span.rsrp.by.layer.${name}`, sketch);
  b.countAndShare("day.span.unattached", unattachedRows, n);
  b.scalar("day.span.unattached.minuteShare", totalMinutes ? unattachedMinutes / totalMinutes : 0, "share");
  b.scalar("day.span.connected.minuteShare", totalMinutes ? connectedTotal / totalMinutes : 0, "share");
  b.countAndShare("day.span.subscribersWithADay", seen.size, subs.n);

  b.invariant("day.span.backwards", "a span holds at least one minute", backwards, n, backwardsExamples);
  b.invariant("day.span.straySubscriber", "every span names a subscriber in the table", straySubscriber, n);
  b.invariant("day.span.strayCell", "an attached span names a cell in the table", strayCell, n);
  b.invariant("day.span.unknownExposure", "every span's exposure is named by the header", unknownExposure, n);
  b.invariant("day.span.connectedWithoutCell", "an unattached span spends no minute connected", idleConnected, unattachedRows);
  b.invariant("day.span.connectedOverruns", "connected minutes fit inside the span", overConnected, n);
  b.invariant("day.span.rsrpWhenUnattached", "an unattached span carries no signal level", signalWhenUnattached, unattachedRows);
  b.invariant("day.span.rsrp.range", `an attached span's mean RSRP is inside ${RSRP_RANGE[0]}..${RSRP_RANGE[1]} dBm`, badSignal, n - unattachedRows, signalExamples);
  b.invariant("day.span.tiling", "each subscriber's spans cover midnight to midnight with no gap or overlap", gaps, tiled, gapExamples);
  b.invariant("day.span.wrongPerson", "a span sits in the slice of the person who owns the subscription", wrongPerson, n, personExamples);
  b.invariant("day.span.impossibleRadio", "an LTE-only handset never camps on an NR cell", impossibleRadio, n, radioExamples);
  b.invariant("day.span.offsets", "each person's span slice is contiguous and in bounds", offsetsBroken, perPerson.length);
}

/**
 * What the operator's own logs would hold, which is less than the truth.
 *
 * Nothing here asserts the event table is complete with respect to the spans —
 * it is not meant to be, and that difference is the reason both are shipped.
 * What is checked is that the two never contradict each other: where an event
 * says a handset moved to a cell at a minute, the span table has that handset
 * on that cell from that minute.
 */
function events(
  b: Builder,
  a: Record<string, any>,
  subs: Subs,
  cells: CellTable,
  enums: Record<string, string[]>,
): void {
  const subscriber = a["event.subscriber"] as Uint32Array;
  const minute = a["event.minute"] as Int32Array;
  const kind = a["event.kind"] as Uint8Array;
  const cell = a["event.cell"] as Int32Array;
  const previous = a["event.previous"] as Int32Array;
  const cause = a["event.cause"] as Uint8Array;
  const spanSubscriber = a["span.subscriber"] as Uint32Array;
  const spanCell = a["span.cell"] as Int32Array;
  const spanStart = a["span.start"] as Int32Array;
  const personId = a["person.id"] as Uint32Array;
  const offset = a["person.eventOffset"] as Uint32Array;
  const perPerson = a["person.eventCount"] as Uint32Array;
  const spanOffset = a["person.spanOffset"] as Uint32Array;
  const spanCount = a["person.spanCount"] as Uint32Array;
  const kinds = enums.eventKind ?? [];
  const causes = enums.eventCause ?? [];
  const operators = enums.operator ?? [];
  const n = subscriber.length;

  const kindCat = new Cat();
  const causeCat = new Cat();
  const kindByCause = new Cat();
  const kindByHour = new Cat();
  const minuteCat = new Cat();
  const operatorCat = new Cat();
  const minutes = new Num();
  let unknownKind = 0;
  let unknownCause = 0;
  let outOfDay = 0;
  let strayCell = 0;
  let straySubscriber = 0;
  let movesWithoutPrevious = 0;
  let moves = 0;
  let dayStartLate = 0;
  let offsetsBroken = 0;
  let outOfOrder = 0;
  let ordered = 0;
  let disagrees = 0;
  let checked = 0;
  const orderExamples: string[] = [];
  const disagreeExamples: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const kindName = kinds[kind[i]] ?? `kind ${kind[i]}`;
    const causeName = causes[cause[i]] ?? `cause ${cause[i]}`;
    kindCat.add(kindName);
    causeCat.add(causeName);
    kindByCause.add(`${kindName} × ${causeName}`);
    minutes.push(minute[i]);
    if (minute[i] >= 0 && minute[i] < MINUTES) {
      kindByHour.add(`${kindName} × ${hour(minute[i])}`);
      minuteCat.add(hour(minute[i]));
    } else outOfDay += 1;
    if (!kinds[kind[i]]) unknownKind += 1;
    if (!causes[cause[i]]) unknownCause += 1;
    if (subscriber[i] >= subs.n) straySubscriber += 1;
    if (cell[i] !== UNATTACHED && (cell[i] < 0 || cell[i] >= cells.n)) strayCell += 1;
    else if (cell[i] !== UNATTACHED) operatorCat.add(operators[cells.operator[cell[i]]] ?? "—");
    if (kindName === "handover" || kindName === "reselect") {
      moves += 1;
      // A move is a statement about two cells. One of them missing is a move
      // that cannot be followed, which is the whole use of the event table.
      if (cell[i] === UNATTACHED || previous[i] === UNATTACHED) movesWithoutPrevious += 1;
    }
    // The synthetic cause for the attach at midnight that did not happen. It
    // exists to keep ninety thousand fictional switch-ons out of the log, and
    // it stops doing that the moment it appears anywhere but minute zero.
    if (causeName === "day-start" && minute[i] !== 0) dayStartLate += 1;
  }

  // Per person: the slice is contiguous, each subscriber's events ascend, and
  // an event that names a cell agrees with the span that starts at its minute.
  for (let p = 0; p < perPerson.length; p += 1) {
    const first = offset[p];
    const last = first + perPerson[p];
    if (last > n || (p > 0 && offset[p] !== offset[p - 1] + perPerson[p - 1])) offsetsBroken += 1;

    const starts = new Map<number, number>();
    for (let j = spanOffset[p]; j < spanOffset[p] + spanCount[p]; j += 1) {
      starts.set(spanSubscriber[j] * (MINUTES + 1) + spanStart[j], spanCell[j]);
    }
    for (let i = first; i < last; i += 1) {
      if (i > first && subscriber[i] === subscriber[i - 1]) {
        ordered += 1;
        if (minute[i] < minute[i - 1]) {
          outOfOrder += 1;
          if (orderExamples.length < 5) {
            orderExamples.push(`person ${personId[p]}: event ${i - 1} at ${minute[i - 1]}, event ${i} at ${minute[i]}`);
          }
        }
      }
      const kindName = kinds[kind[i]] ?? "";
      if (kindName !== "attach" && kindName !== "handover" && kindName !== "reselect") continue;
      const opened = starts.get(subscriber[i] * (MINUTES + 1) + minute[i]);
      checked += 1;
      if (opened === undefined || opened !== cell[i]) {
        disagrees += 1;
        if (disagreeExamples.length < 5) {
          disagreeExamples.push(
            `event ${i}: ${kindName} onto cell ${cell[i]} at ${minute[i]}, span table opens ${opened ?? "nothing"}`,
          );
        }
      }
    }
  }

  b.num("day.person.events", perPerson);
  b.num("day.event.minute", minutes);
  b.cat("day.event.kind", kindCat);
  b.cat("day.event.cause", causeCat);
  b.cat("day.event.kind×cause", kindByCause);
  b.cat("day.event.kind×hour", kindByHour);
  b.cat("day.event.hour", minuteCat);
  b.cat("day.event.operator", operatorCat);

  b.invariant("day.event.unknownKind", "every event kind is named by the header", unknownKind, n);
  b.invariant("day.event.unknownCause", "every event cause is named by the header", unknownCause, n);
  b.invariant("day.event.outOfDay", "every event falls inside the day it belongs to", outOfDay, n);
  b.invariant("day.event.straySubscriber", "every event names a subscriber in the table", straySubscriber, n);
  b.invariant("day.event.strayCell", "an event's cell is one the table holds", strayCell, n);
  b.invariant("day.event.moveWithoutBothCells", "a handover or reselection names the cell left and the cell taken", movesWithoutPrevious, moves);
  b.invariant("day.event.dayStartLate", "the day-start cause appears only at midnight", dayStartLate, n);
  b.invariant("day.event.order", "one subscriber's events ascend in time", outOfOrder, ordered, orderExamples);
  b.invariant("day.event.agreesWithSpans", "an event that takes a cell opens a span on that cell", disagrees, checked, disagreeExamples);
  b.invariant("day.event.offsets", "each person's event slice is contiguous and in bounds", offsetsBroken, perPerson.length);
}

/** How many distinct values a column holds, for the uniqueness rules. */
function distinct(values: ArrayLike<number>): number {
  const seen = new Set<number>();
  for (let i = 0; i < values.length; i += 1) seen.add(values[i]);
  return seen.size;
}

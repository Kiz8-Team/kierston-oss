/**
 * Cuts a browsable sample of one exported day for the project website.
 *
 *   bun run site-city --day <day.bin> --out <dir> [--people 2500] [--featured 6] [--sim-data kierston/sim_data]
 *
 * A full KDAY is over a gigabyte. The site gets a seeded sample of residents
 * who travelled that day: their schedules, routed legs with thinned paths,
 * card transactions, and the serving cells the carrier saw them on, plus the
 * cell sites and plate readers those records refer to. Coordinates are whole
 * units of 1e-5 degree from the sample's south-west corner, which is about a
 * metre and keeps the JSON small.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { KdayReader, NONE } from "../../kierston_bench/task_generators/src/kday.ts";
import { decodeRecords, type RecordSet, type RecordTable } from "../../packages/kierston-records/src/index.ts";
import { buildDossier } from "../kierstonblue/lib/dossier.ts";
import { Identity } from "../kierstonblue/lib/identity.ts";
import { decodeTies, GROUP_LABEL, groupOf, KIND_LABEL, TIER_LABEL } from "../kierstonblue/lib/ties.ts";
import { decodePopulation } from "../kierstonblue/lib/population.ts";
import { option, required } from "./args.ts";

const PATH_POINTS = 16;

const USAGE = "bun run site-city --day <day.bin> --out <dir> [--people 2500] [--featured 6] [--sim-data kierston/sim_data]";
const dayFile = required("--day", USAGE);
const want = Number(option("--people", "2500"));
const featuredCount = Number(option("--featured", "6"));
const simData = option("--sim-data", "kierston/sim_data");
const out = required("--out", USAGE);

/** mulberry32: the sample must not change between exports of the same day. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = await KdayReader.open(dayFile);
const load = async (...names: string[]) => Promise.all(names.map((name) => day.column(name)));
const text = (id: number) => (id === NONE ? null : day.string(id));

const [personId, scheduleOffset, scheduleCount, legOffset, legCount, txOffset, txCount, eventOffset, eventCount] = await load(
  "person.id", "person.scheduleOffset", "person.scheduleCount", "person.legOffset", "person.legCount",
  "person.txOffset", "person.txCount", "person.eventOffset", "person.eventCount",
);

// ---- Featured residents: the ones with the most kinds of record, who also drove past cameras that day ----

const records = async (name: string): Promise<RecordSet> => decodeRecords(await Bun.file(join(simData, `${name}.bin`)).arrayBuffer());
const identity = new Identity(await records("identity"));
const sets = { criminal: await records("criminal"), civil: await records("civil"), firearms: await records("firearms"), vehicles: await records("vehicles"), holdings: await records("holdings") };
const vehicleTable = sets.vehicles.table("vehicle");
const vehiclesByOwner = vehicleTable.groupedBy("owner");

const [truthSource, truthMovement, truthCorrelation] = await load("alprTruth.source", "alprTruth.movement", "alprTruth.correlationId");
const residentSource = day.enumValues("alprMovementSource").indexOf("resident");
const legOwner = new Uint32Array(day.meta.counts.legs ?? 0);
for (let person = 0; person < personId!.length; person++) legOwner.fill(person, legOffset![person]!, legOffset![person]! + legCount![person]!);
/** Person row -> correlation ids of every camera pass one of their legs made. */
const passes = new Map<number, number[]>();
for (let i = 0; i < truthSource!.length; i++) {
  if (truthSource![i] !== residentSource) continue;
  const person = legOwner[truthMovement![i]!]!;
  const list = passes.get(person);
  if (list) list.push(truthCorrelation![i]!);
  else passes.set(person, [truthCorrelation![i]!]);
}

const ranked: { person: number; labels: string[]; passes: number }[] = [];
for (const [person, list] of passes) {
  if (list.length < 3 || eventCount![person]! < 30 || legCount![person]! < 4) continue;
  const id = personId![person]!;
  const labels = buildDossier(id, identity, sets).groups.flatMap((group) => group.sections.map((section) => section.def.label));
  if (vehiclesByOwner.has(id)) labels.push("Vehicles");
  ranked.push({ person, labels, passes: list.length });
}
// Greedy cover: each pick is whoever adds the most kinds of record not shown yet, so between them the
// featured residents show every table — immigration papers, military service, a sentence being served.
const featuredRows: number[] = [];
const covered = new Set<string>();
while (featuredRows.length < featuredCount && ranked.length > 0) {
  let best = 0;
  let bestGain = -1;
  ranked.forEach((entry, position) => {
    const gain = entry.labels.filter((label) => !covered.has(label)).length * 100 + entry.labels.length + Math.min(entry.passes, 9) / 10;
    if (gain > bestGain) {
      bestGain = gain;
      best = position;
    }
  });
  const [picked] = ranked.splice(best, 1);
  featuredRows.push(picked!.person);
  for (const label of picked!.labels) covered.add(label);
}
// The first resident is the one the page opens on, so it is someone who goes to work that day:
// a whole day at home makes an empty timeline and an empty map.
{
  const [kind] = await load("schedule.kind");
  const work = day.enumValues("scheduleKind").indexOf("work");
  const works = (person: number) => kind!.subarray(scheduleOffset![person]!, scheduleOffset![person]! + scheduleCount![person]!).includes(work);
  const first = featuredRows.findIndex(works);
  if (first > 0) featuredRows.unshift(...featuredRows.splice(first, 1));
}

const random = rng(56);
const movers: number[] = [];
for (let person = 0; person < personId!.length; person++) if (legCount![person]! >= 2) movers.push(person);
for (let i = movers.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [movers[i], movers[j]] = [movers[j]!, movers[i]!];
}
const sample = [...new Set([...featuredRows, ...movers.slice(0, want)])].sort((a, b) => a - b);

const [scheduleStart, scheduleEnd, scheduleKind, scheduleLabel, scheduleWhere] = await load(
  "schedule.start", "schedule.end", "schedule.kind", "schedule.label", "schedule.where",
);
const [legDepart, legArrive, legMode, legPurpose, legTo, legPathOffset, legPathCount, legFromLat, legFromLon, legToLat, legToLon] = await load(
  "leg.depart", "leg.arrive", "leg.mode", "leg.purpose", "leg.toLabel", "leg.pathOffset", "leg.pathCount",
  "leg.fromLatE6", "leg.fromLonE6", "leg.toLatE6", "leg.toLonE6",
);
const [pathLat, pathLon] = await load("path.latE6", "path.lonE6");
const [txMinute, txAmount, txKind, txMerchant, txApproved, txLat, txLon] = await load(
  "tx.minute", "tx.amount", "tx.kind", "tx.merchant", "tx.approved", "tx.latE6", "tx.lonE6",
);
const [eventMinute, eventCell] = await load("event.minute", "event.cell");
const [cellLat, cellLon, cellOperator] = await load("cell.latE6", "cell.lonE6", "cell.operator");
const [cameraLat, cameraLon] = await load("camera.latE6", "camera.lonE6");

/** A leg's routed points as [latE6, lonE6] pairs, thinned evenly; an unrouted leg is its two ends. */
function legPoints(leg: number, limit = PATH_POINTS): [number, number][] {
  const count = legPathCount![leg]!;
  if (count < 2) return [[legFromLat![leg]!, legFromLon![leg]!], [legToLat![leg]!, legToLon![leg]!]];
  const offset = legPathOffset![leg]!;
  const keep = Math.min(count, limit);
  const points: [number, number][] = [];
  for (let i = 0; i < keep; i++) {
    const at = offset + Math.round((i * (count - 1)) / (keep - 1));
    points.push([pathLat![at]!, pathLon![at]!]);
  }
  return points;
}

// First pass finds the box everything is measured from.
let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
const routed = new Map<number, [number, number][]>();
for (const person of sample) {
  for (let leg = legOffset![person]!; leg < legOffset![person]! + legCount![person]!; leg++) {
    // Featured residents are looked at one at a time, so their routes keep their shape.
    const points = legPoints(leg, featuredRows.includes(person) ? 80 : PATH_POINTS);
    routed.set(leg, points);
    for (const [lat, lon] of points) {
      south = Math.min(south, lat); north = Math.max(north, lat);
      west = Math.min(west, lon); east = Math.max(east, lon);
    }
  }
}
const y = (latE6: number) => Math.round((latE6 - south) / 10);
const x = (lonE6: number) => Math.round((lonE6 - west) / 10);
const inside = (latE6: number, lonE6: number) => latE6 >= south && latE6 <= north && lonE6 >= west && lonE6 <= east;

// Every cell in the day, with the sector geometry the tower plan gives it, so a serving cell is a KDAY cell index.
const [cellCgi] = await load("cell.cgi");
const towerFile = (await Bun.file(join(simData, "towers.json")).json()) as { cell_records: { cgi: string; azimuth: number; beamwidth: number; range_m: number; band: string }[] };
const sectorByCgi = new Map(towerFile.cell_records.map((cell) => [cell.cgi, cell]));
const cells: (number | string | null)[][] = [];
for (let cell = 0; cell < cellLat!.length; cell++) {
  const cgi = text(cellCgi![cell]!);
  const sector = cgi ? sectorByCgi.get(cgi) : undefined;
  cells.push([x(cellLon![cell]!), y(cellLat![cell]!), cellOperator![cell]!, sector?.azimuth ?? null, sector?.beamwidth ?? null, sector?.range_m ?? null, cgi, sector?.band ?? null]);
}

function daySide(person: number) {
  const schedule = [];
  for (let i = scheduleOffset![person]!; i < scheduleOffset![person]! + scheduleCount![person]!; i++) {
    schedule.push([scheduleStart![i]!, scheduleEnd![i]!, scheduleKind![i]!, text(scheduleLabel![i]!), text(scheduleWhere![i]!)]);
  }
  const legs = [];
  for (let leg = legOffset![person]!; leg < legOffset![person]! + legCount![person]!; leg++) {
    legs.push([legDepart![leg]!, legArrive![leg]!, legMode![leg]!, legPurpose![leg]!, text(legTo![leg]!), routed.get(leg)!.flatMap(([lat, lon]) => [x(lon), y(lat)])]);
  }
  const tx = [];
  for (let i = txOffset![person]!; i < txOffset![person]! + txCount![person]!; i++) {
    const placed = inside(txLat![i]!, txLon![i]!);
    tx.push([txMinute![i]!, Math.round(txAmount![i]! * 100) / 100, txKind![i]!, text(txMerchant![i]!), txApproved![i]!, placed ? x(txLon![i]!) : null, placed ? y(txLat![i]!) : null]);
  }
  return { id: personId![person]!, schedule, legs, tx };
}

const people = sample.map(daySide);

// ---- Plate readers: where they are, how busy each minute was, and a thinned log of what each one read ----

const [obsCorrelation, obsCamera, obsSecond, obsDetected, obsConfidence, obsOutcome] = await load(
  "alprObservation.correlationId", "alprObservation.camera", "alprObservation.second", "alprObservation.detectedText",
  "alprObservation.confidence", "alprObservation.outcome",
);
const cameraCount = cameraLat!.length;
const READ_LOG = 120;
const perCamera = Array.from({ length: cameraCount }, () => [] as number[]);
const observationOf = new Map<number, number>();
for (let i = 0; i < obsCamera!.length; i++) {
  perCamera[obsCamera![i]!]?.push(i);
  observationOf.set(obsCorrelation![i]!, i);
}
// The observation's own `canonicalText` is the read, normalised; the plate that actually passed is on the truth row.
const [truthPlate] = await load("alprTruth.plate");
const truthOf = new Map<number, number>();
for (let i = 0; i < truthCorrelation!.length; i++) truthOf.set(truthCorrelation![i]!, i);
const actualPlate = (i: number) => {
  const truthRow = truthOf.get(obsCorrelation![i]!);
  return truthRow === undefined ? null : text(truthPlate![truthRow]!);
};
const readRow = (i: number) => [obsSecond![i]!, text(obsDetected![i]!), actualPlate(i), Math.round(obsConfidence![i]! * 100) / 100, obsOutcome![i]!];
const cameras = perCamera.map((reads, camera) => {
  // Reads per ten minutes: enough to pulse the map without shipping 350,000 rows.
  const activity = new Array<number>(144).fill(0);
  for (const i of reads) activity[Math.min(143, Math.floor(obsSecond![i]! / 600))]! += 1;
  const step = Math.max(1, Math.floor(reads.length / READ_LOG));
  const log = reads.filter((_, position) => position % step === 0).slice(0, READ_LOG).map(readRow);
  return { x: x(cameraLon![camera]!), y: y(cameraLat![camera]!), reads: reads.length, activity, log };
});

// ---- Cell towers: the structures the cells stand on, and what the carrier logged through each ----

const BINS = 144;
const bins = () => new Array<number>(BINS).fill(0);
const binOfSecond = (second: number) => Math.min(BINS - 1, Math.max(0, Math.floor(second / 600)));
const [cellStructure, cellBand] = await load("cell.structure", "cell.band");
const towerByStructure = new Map<number, number>();
const towerOfCell = new Int32Array(cellLat!.length).fill(-1);
const towers: { x: number; y: number; cells: number[]; operators: Set<number>; bands: Set<string>; calls: number; texts: number; events: number; handsets: Set<number>; activity: { calls: number[]; texts: number[] } }[] = [];
for (let cell = 0; cell < cellLat!.length; cell++) {
  let tower = towerByStructure.get(cellStructure![cell]!);
  if (tower === undefined) {
    tower = towers.length;
    towerByStructure.set(cellStructure![cell]!, tower);
    towers.push({ x: x(cellLon![cell]!), y: y(cellLat![cell]!), cells: [], operators: new Set(), bands: new Set(), calls: 0, texts: 0, events: 0, handsets: new Set(), activity: { calls: bins(), texts: bins() } });
  }
  towerOfCell[cell] = tower;
  const entry = towers[tower]!;
  entry.cells.push(cell);
  entry.operators.add(cellOperator![cell]!);
  const band = text(cellBand![cell]!);
  if (band) entry.bands.add(band);
}
const towerAt = (cell: number) => (cell >= 0 ? towers[towerOfCell[cell]!] : undefined);

// City-wide, each call, text and transaction counts once; a tower counts whatever it carried at either end.
const activity = { calls: bins(), texts: bins(), tx: bins(), txVolume: bins() };
const [cdrCall, cdrOriginCell, cdrToOriginCell, callAt] = await load("cdr.call", "cdr.originCell", "cdr.toOriginCell", "call.at");
for (let i = 0; i < cdrCall!.length; i++) {
  const bin = binOfSecond(callAt![cdrCall![i]!]!);
  activity.calls[bin]! += 1;
  const origin = towerAt(cdrOriginCell![i]!);
  const far = towerAt(cdrToOriginCell![i]!);
  for (const tower of new Set([origin, far])) {
    if (!tower) continue;
    tower.calls += 1;
    tower.activity.calls[bin]! += 1;
  }
}
// An SMS record is one part of one message; the first part stands for the message.
const [smsMessage, smsCell, smsToCell, smsPart, messageAt] = await load("sms.message", "sms.cell", "sms.toCell", "sms.part", "message.at");
for (let i = 0; i < smsMessage!.length; i++) {
  if (smsPart![i] !== 0) continue;
  const bin = binOfSecond(messageAt![smsMessage![i]!]!);
  activity.texts[bin]! += 1;
  for (const tower of new Set([towerAt(smsCell![i]!), towerAt(smsToCell![i]!)])) {
    if (!tower) continue;
    tower.texts += 1;
    tower.activity.texts[bin]! += 1;
  }
}
// Scheduled payments can fall outside the day; only what happened within it is plotted.
for (let i = 0; i < txMinute!.length; i++) {
  const minute = txMinute![i]!;
  if (minute < 0 || minute >= 1440) continue;
  activity.tx[Math.floor(minute / 10)]! += 1;
  activity.txVolume[Math.floor(minute / 10)]! += Math.abs(txAmount![i]!);
}
activity.txVolume = activity.txVolume.map((volume) => Math.round(volume));

// Payday: wages paid by direct deposit post overnight, and on a payday they are most of the day's
// volume. The band spans the middle 98% of the overnight wage credits, snapped to the chart's bins;
// a day with too few of them to be a payday has none.
const [txReason] = await load("tx.reason");
const wagesReason = day.meta.enums.reason!.indexOf("wages");
const transferIn = day.meta.enums.txKind!.indexOf("transfer_in");
const wageMinutes: number[] = [];
let wageAmount = 0;
for (let i = 0; i < txMinute!.length; i++) {
  const minute = txMinute![i]!;
  if (minute < 0 || minute >= 6 * 60 || txReason![i] !== wagesReason || txKind![i] !== transferIn) continue;
  wageMinutes.push(minute);
  wageAmount += txAmount![i]!;
}
wageMinutes.sort((a, b) => a - b);
const payroll = wageMinutes.length >= 1000
  ? {
      from: Math.floor(wageMinutes[Math.floor(wageMinutes.length * 0.01)]! / 10) * 10,
      to: Math.ceil((wageMinutes[Math.floor(wageMinutes.length * 0.99)]! + 1) / 10) * 10,
      deposits: wageMinutes.length,
      amount: Math.round(wageAmount),
    }
  : null;
for (let i = 0; i < eventCell!.length; i++) {
  const tower = towerAt(eventCell![i]!);
  if (tower) tower.events += 1;
}
const [spanSubscriber, spanCell] = await load("span.subscriber", "span.cell");
for (let i = 0; i < spanCell!.length; i++) towerAt(spanCell![i]!)?.handsets.add(spanSubscriber![i]!);
const towerRows = towers.map((tower) => ({
  x: tower.x, y: tower.y, cells: tower.cells,
  operators: [...tower.operators].sort((a, b) => a - b),
  bands: [...tower.bands].sort(),
  calls: tower.calls, texts: tower.texts, events: tower.events, handsets: tower.handsets.size,
  activity: tower.activity,
}));
const totals = { calls: cdrCall!.length, texts: activity.texts.reduce((sum, count) => sum + count, 0), tx: activity.tx.reduce((sum, count) => sum + count, 0), txVolume: activity.txVolume.reduce((sum, volume) => sum + volume, 0) };

// ---- Featured residents: the carrier's event log, their car's plate reads, their ties, their whole file ----

const [eventKind, eventTa] = await load("event.kind", "event.ta");
const population = decodePopulation(await Bun.file(join(simData, "population.bin")).arrayBuffer());
const ties = decodeTies(await Bun.file(join(simData, "ties.bin")).arrayBuffer(), population.counts.persons + population.counts.quarters);

// Records name places by OSM id. A reader gets the name the workplace catalogue has, or else the building's address.
const workplaces = (await Bun.file(join(simData, "workplaces.json")).json()) as { site_records: { id: string; name: string; address: string }[] };
const siteById = new Map(workplaces.site_records.map((site) => [site.id, site]));
const OSM_ID = /^(way|node|relation)\/\d+$/;
function place(value: unknown) {
  if (typeof value !== "string" || !OSM_ID.test(value)) return value;
  const site = siteById.get(value);
  const building = population.buildingByOsmId.get(value);
  const address = site?.address || (building === undefined ? "" : population.building(building).address);
  return [site?.name, address].filter(Boolean).join(", ") || null;
}

function tableRows(table: RecordTable, rows: number[], skip: string[]) {
  const fields = table.fieldNames.filter((field) => !skip.includes(field));
  return {
    // Once resolved, a workplace id is the workplace.
    fields: fields.map((field) => (field === "workplace_id" ? "workplace" : field)),
    kinds: fields.map((field) => table.kindOf(field)),
    rows: rows.map((row) => fields.map((field) => place(table.value(field, row)))),
    children: table.childNames.flatMap((name) =>
      rows.flatMap((row, position) => {
        const slice = table.children(name, row);
        if (!slice || slice.to === slice.from) return [];
        const childFields = slice.table.fieldNames.filter((field) => field !== "person");
        const childRows = [];
        for (let child = slice.from; child < slice.to; child++) childRows.push(childFields.map((field) => place(slice.table.value(field, child))));
        return [{ of: position, name, fields: childFields, kinds: childFields.map((field) => slice.table.kindOf(field)), rows: childRows }];
      }),
    ),
  };
}

const featured = featuredRows.map((person) => {
  const id = personId![person]!;
  const events = [];
  for (let i = eventOffset![person]!; i < eventOffset![person]! + eventCount![person]!; i++) {
    events.push([eventMinute![i]!, eventKind![i]!, eventCell![i]!, eventTa![i]!]);
  }
  const reads = (passes.get(person) ?? []).flatMap((correlation) => {
    const i = observationOf.get(correlation);
    return i === undefined ? [] : [[obsCamera![i]!, ...readRow(i)]];
  }).sort((a, b) => (a[1] as number) - (b[1] as number));

  const dossier = buildDossier(id, identity, sets);
  const sections = dossier.groups.flatMap((group) =>
    group.sections.map((section) => ({
      group: group.label,
      label: section.def.label,
      summary: section.def.summary ?? [],
      formats: section.def.formats ?? {},
      // The identity row's children are sections of their own.
      ...tableRows(section.table, section.rows, [...section.skip, ...(section.def.table === "identity" ? ["person"] : [])]),
      ...(section.def.table === "identity" ? { children: [] } : {}),
    })),
  );
  // `buildDossier` looks vehicles up by a `person` column the table does not have; they are keyed by `owner`.
  const owned = vehiclesByOwner.get(id) ?? [];
  const before = sections.findIndex((section) => section.group === "Vehicles");
  if (owned.length > 0) sections.splice(before < 0 ? sections.length : before, 0, { group: "Vehicles", label: "Vehicles", summary: ["model_year", "make", "model"], formats: {}, ...tableRows(vehicleTable, owned, ["owner", "owner_type", "household"]) });

  const all = ties.tiesOf(id).filter((tie) => !ties.isStub(tie.other));
  // Strongest first, but dealt one kind at a time: forty colleagues would otherwise crowd out the family.
  const byKind = new Map<string, typeof all>();
  for (const tie of [...all].sort((a, b) => b.affinity + b.exposure - (a.affinity + a.exposure))) byKind.set(tie.kind, [...(byKind.get(tie.kind) ?? []), tie]);
  const alters: typeof all = [];
  for (let round = 0; alters.length < 30 && round < 30; round++) {
    for (const list of byKind.values()) if (list[round] && alters.length < 30) alters.push(list[round]!);
  }
  const index = new Map(alters.map((tie, position) => [tie.other, position]));
  const links: number[][] = [];
  for (const [a, from] of index) {
    for (const tie of ties.tiesOf(a)) {
      const to = index.get(tie.other);
      if (to !== undefined && from < to) links.push([from, to]);
    }
  }
  return {
    id,
    name: identity.name(id),
    born: identity.birthDate(id),
    events,
    reads,
    ties: {
      total: all.length,
      alters: alters.map((tie) => ({
        name: identity.name(tie.other),
        kind: KIND_LABEL[tie.kind] ?? tie.kind,
        group: GROUP_LABEL[groupOf(tie.kind)],
        tier: TIER_LABEL[tie.tier] ?? tie.tier,
        foci: ties.fociOf(tie.focus),
        affinity: Math.round(tie.affinity * 100) / 100,
        exposure: Math.round(tie.exposure * 100) / 100,
        valence: tie.valence,
        since: tie.since || null,
      })),
      links,
    },
    sections,
  };
});

const frame = { origin: { lat: south / 1e6, lon: west / 1e6 }, size: { x: x(east), y: y(north) } };
const enums = {
  mode: day.enumValues("mode"),
  purpose: day.enumValues("purpose"),
  scheduleKind: day.enumValues("scheduleKind"),
  txKind: day.enumValues("txKind"),
  operator: day.enumValues("operator"),
  eventKind: day.enumValues("eventKind"),
  alprOutcome: day.enumValues("alprOutcome"),
};
const body = JSON.stringify({ date: day.meta.date, population: day.meta.counts.persons, ...frame, enums, cells, towers: towerRows, activity: { ...activity, payroll }, totals, cameras, featured: featured.map((entry) => entry.id), people });
const featuredBody = JSON.stringify({ date: day.meta.date, residents: featured });
await day.close();
await mkdir(out, { recursive: true });
await Bun.write(join(out, "city.json"), body);
await Bun.write(join(out, "featured.json"), featuredBody);
const size = (text: string) => `${(text.length / 1e6).toFixed(1)} MB, ${(Bun.gzipSync(Buffer.from(text)).length / 1e6).toFixed(2)} MB gzipped`;
console.log(`city.json: ${people.length} residents, ${cells.length} cells on ${towerRows.length} towers, ${cameras.length} cameras: ${size(body)}`);
console.log(`featured.json: ${featured.map((entry) => `${entry.name} (${entry.sections.length} sections, ${entry.reads.length} reads, ${entry.events.length} events, ${entry.ties.total} ties)`).join("; ")}: ${size(featuredBody)}`);

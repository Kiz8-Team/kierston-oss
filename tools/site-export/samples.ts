/**
 * Cuts one real record for every line of the website's "what the engine simulates" table.
 *
 *   bun run site-samples --day <day.bin> --scenario-day <day.bin> --scenario <delta.kdiff> --out <dir> [--sim-data kierston/sim_data] [--sources kierston/sources/kierston]
 *
 * Every sample is a row the engine wrote: a household from population.bin, a card payment from the
 * day's transactions, a plate misread from the camera log. Ids are resolved to names and addresses
 * and every value is formatted here, so the page only lays out label/value pairs. The staged
 * scenario rows come from a scenario delta read over its own base day (`--scenario-day`,
 * `--scenario`), since a delta applies to the day it was staged on and no other.
 *
 * Writes samples.json: { date, samples: { [key]: { kind, fields: [label, value][] } } }.
 */

import { join } from "node:path";
import { KdayReader, NONE } from "../../kierston_bench/task_generators/src/kday.ts";
import { decodeRecords, type RecordSet, type RecordTable } from "../../packages/kierston-records/src/index.ts";
import { buildDossier } from "../kierstonblue/lib/dossier.ts";
import { Identity } from "../kierstonblue/lib/identity.ts";
import { decodePopulation, RACE_LABEL } from "../kierstonblue/lib/population.ts";
import { decodeTies, KIND_LABEL } from "../kierstonblue/lib/ties.ts";
import { option, required } from "./args.ts";

const USAGE = "bun run site-samples --day <day.bin> --scenario-day <day.bin> --scenario <delta.kdiff> --out <dir> [--sim-data kierston/sim_data] [--sources kierston/sources/kierston]";
const dayFile = required("--day", USAGE);
const scenarioDay = required("--scenario-day", USAGE);
const scenarioFile = required("--scenario", USAGE);
const simData = option("--sim-data", "kierston/sim_data");
const sources = option("--sources", "kierston/sources/kierston");
const out = required("--out", USAGE);

type Value = string | number | boolean | null | undefined;
interface Sample { kind: string; fields: [string, string][] }
const samples: Record<string, Sample> = {};

/** Records a sample, dropping the fields that have nothing to say. */
function put(key: string, kind: string, fields: [string, Value][]) {
  samples[key] = {
    kind,
    fields: fields.flatMap(([label, value]) => {
      if (value === null || value === undefined || value === "") return [];
      return [[label, typeof value === "boolean" ? (value ? "yes" : "no") : String(value)]];
    }),
  };
}

const clock = (minute: number) => {
  const wrapped = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};
const clockSeconds = (second: number) => {
  const s = ((second % 86400) + 86400) % 86400;
  return `${clock(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
};
const span = (from: number, to: number) => `${clock(from)}–${clock(to)}`;
const money = (amount: number) => `${amount < 0 ? "−" : ""}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;
const minutes = (count: number) => `${Math.round(count)} min`;
const place = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const e6 = (latE6: number, lonE6: number) => place(latE6 / 1e6, lonE6 / 1e6);
const humanise = (value: string) => value.replace(/[_-]/g, " ");

/** mulberry32: the same records come out of every export of the same day. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(4242);

/** A random row in [0, count) satisfying `test`, scanning on from a seeded start. */
function pick(count: number, test: (row: number) => boolean): number {
  const start = Math.floor(random() * count);
  for (let step = 0; step < count; step++) {
    const row = (start + step) % count;
    if (test(row)) return row;
  }
  throw new Error("no row matches");
}

const json = async <T>(name: string) => (await Bun.file(join(simData, name)).json()) as T;
const records = async (name: string): Promise<RecordSet> => decodeRecords(await Bun.file(join(simData, `${name}.bin`)).arrayBuffer());

const day = await KdayReader.open(dayFile);
const col = (name: string) => day.column(name);
const text = (id: number) => (id === NONE ? null : day.string(id));
const en = (group: string, id: number) => day.enumValues(group)[id] ?? null;

const identity = new Identity(await records("identity"));
const name = (id: number) => identity.name(id);
const population = decodePopulation(await Bun.file(join(simData, "population.bin")).arrayBuffer());
const occupations = ((await Bun.file("kierston/reference/occp_mapping.json").json()) as { occupations: Record<string, { label: string }> }).occupations;
const occupation = (code: string | null) => (code ? occupations[code.padStart(4, "0")]?.label ?? null : null);
const sets = { criminal: await records("criminal"), civil: await records("civil"), firearms: await records("firearms"), vehicles: await records("vehicles"), holdings: await records("holdings") };

// Places are named by OSM id throughout. Venues carry a `v:` prefix and are pois.json points, which
// share their order with the OSM export they were cut from.
const pois = await json<{ groups: { types: { i: number; label: string }[] }[]; points: [number, number, number, number, string | null, string | null, number][] }>("pois.json");
const osm = (await Bun.file(join(sources, "pois_export.json")).json()) as { elements: { type: string; id: number }[] };
const typeLabel = new Map<number, string>();
for (const group of pois.groups) for (const type of group.types) typeLabel.set(type.i, type.label);
const poiById = new Map(osm.elements.map((element, index) => [`${element.type}/${element.id}`, pois.points[index]!]));
const workplaces = await json<{ site_records: { id: string; name: string; address: string; capacity: number; class: string }[] }>("workplaces.json");
const siteById = new Map(workplaces.site_records.map((site) => [site.id, site]));
const schools = await json<{ school_records: { id: string; name: string; kind: string; bands: string[]; sector?: string; seats?: number; capacity?: number; lat: number; lon: number }[] }>("schools.json");
const schoolById = new Map(schools.school_records.map((school) => [school.id, school]));
function placeName(id: string | null): string | null {
  if (!id) return null;
  const bare = id.replace(/^[a-z]:/, "");
  const poi = poiById.get(bare);
  if (poi) return [poi[4], poi[5]].filter(Boolean).join(", ") || typeLabel.get(poi[3]) || null;
  const site = siteById.get(bare);
  const building = population.buildingByOsmId.get(bare);
  const address = site?.address || (building === undefined ? "" : population.building(building).address);
  return [site?.name || schoolById.get(bare)?.name, address].filter(Boolean).join(", ") || null;
}

// ---- Population ----

{
  const household = pick(population.counts.households, (row) => {
    const h = population.household(row);
    return h.size === 4 && h.members.some((m) => m.age < 14);
  });
  const h = population.household(household);
  put("households", "Household", [
    ["Address", h.building.address],
    ["Members", h.members.map((m) => `${m.relationship} (${m.age})`).join(", ")],
    ["Household income", dollars(h.income)],
    ["Building", humanise(h.building.kind)],
  ]);

  const person = pick(population.counts.persons, (id) => {
    const p = population.resident(id);
    return p.age > 25 && p.age < 60 && p.occupation !== null && p.income > 20000 && identity.knows(id);
  });
  const p = population.resident(person);
  put("people", "Resident", [
    ["Name", name(person)],
    ["Age", p.age],
    ["Sex", p.sex],
    ["Race", RACE_LABEL[p.race] ?? p.race],
    ["Education", p.education],
    ["Occupation", occupation(p.occupation)],
    ["Income", dollars(p.income)],
  ]);
}

{
  const employment = await json<{ assignments: { person: number; role?: string; occupation: string; site?: string; mode: string; shift?: { start: number; end: number; rota?: { on: number; off: number } } }[] }>("employment.json");
  const job = employment.assignments[pick(employment.assignments.length, (row) => {
    const a = employment.assignments[row]!;
    return a.mode === "sited" && !!a.shift && !!siteById.get(a.site ?? "")?.name;
  })]!;
  const site = siteById.get(job.site!)!;
  put("jobs", "Job", [
    ["Employee", name(job.person)],
    ["Occupation", occupation(job.occupation)],
    ["Employer", site.name],
    ["Address", site.address],
    ["Shift", span(job.shift!.start, job.shift!.end)],
    ["Rotation", job.shift!.rota ? `${job.shift!.rota.on} days on, ${job.shift!.rota.off} off` : null],
  ]);

  const enrollment = await json<{ assignments: { person: number; band: string; grade: string; sector: string; school: string; mode: string; depart: number; arrive: number }[] }>("enrollment.json");
  const pupil = enrollment.assignments[pick(enrollment.assignments.length, (row) => {
    const a = enrollment.assignments[row]!;
    return a.mode === "enrolled" && a.band === "elem" && schoolById.has(a.school);
  })]!;
  put("enrolment", "Enrollment", [
    ["Student", name(pupil.person)],
    ["Age", population.resident(pupil.person).age],
    ["School", schoolById.get(pupil.school)!.name],
    ["Grade", Number(pupil.grade) - 2 <= 0 ? "kindergarten" : String(Number(pupil.grade) - 2)],
    ["Sector", pupil.sector],
    ["Departs home", clock(pupil.depart)],
    ["Arrives home", clock(pupil.arrive)],
  ]);
}

{
  const ties = decodeTies(await Bun.file(join(simData, "ties.bin")).arrayBuffer(), population.counts.persons + population.counts.quarters);
  const tieSample = (key: string, kind: string, test: (tie: ReturnType<typeof ties.tiesOf>[number]) => boolean) => {
    let found: [number, ReturnType<typeof ties.tiesOf>[number]] | null = null;
    pick(population.counts.persons, (id) => {
      const tie = ties.tiesOf(id).find((t) => !ties.isStub(t.other) && identity.knows(t.other) && test(t));
      if (tie) found = [id, tie];
      return !!tie;
    });
    const [id, tie] = found!;
    put(key, kind, [
      ["Person", name(id)],
      ["Other", name(tie.other)],
      ["Relation", KIND_LABEL[tie.kind] ?? tie.kind],
      ["Met through", ties.fociOf(tie.focus).filter((focus) => focus !== "kin" && focus !== "household").join(", ")],
      ["Since", tie.since || null],
      ["Affinity", `${Math.round(tie.affinity * 100)}%`],
      ["Time together", `${Math.round(tie.exposure * 100)}%`],
    ]);
  };
  tieSample("family", "Family tie", (t) => t.kind === "sibling");
  tieSample("friends", "Friendship", (t) => t.kind === "clubmate" && t.tier === "close_friend" && t.since > 0);
}

{
  const orgs = await json<{ org_records: { id: string; class: string; subclass?: string; name: string }[] }>("orgs.json");
  const orgById = new Map(orgs.org_records.map((org) => [org.id, org]));
  const affiliations = await json<{ affiliation_records: { person: number; org: string; class: string; role: string; since: number }[] }>("affiliations.json");
  const a = affiliations.affiliation_records[pick(affiliations.affiliation_records.length, (row) => {
    const record = affiliations.affiliation_records[row]!;
    return record.class === "worship" && orgById.has(record.org) && identity.knows(record.person);
  })]!;
  const org = orgById.get(a.org)!;
  put("groups", "Membership", [
    ["Member", name(a.person)],
    ["Organization", org.name],
    ["Kind", humanise(org.class)],
    ["Role", a.role],
    ["Since", a.since],
  ]);
}

// ---- Official and commercial records: the same dossiers KierstonBlue opens ----

type Dossier = ReturnType<typeof buildDossier>;
const dossiers = new Map<number, Dossier>();
const dossier = (id: number) => dossiers.get(id) ?? dossiers.set(id, buildDossier(id, identity, sets)).get(id)!;
/** The first row of a dossier section, from someone who has one. */
function section(label: string, test: (table: RecordTable, row: number) => boolean = () => true): { id: number; table: RecordTable; row: number } {
  let found: { id: number; table: RecordTable; row: number } | null = null;
  pick(population.counts.persons, (id) => {
    if (!identity.knows(id)) return false;
    for (const group of dossier(id).groups) for (const s of group.sections) {
      if (s.def.label !== label) continue;
      const row = s.rows.find((r) => test(s.table, r));
      if (row !== undefined) found = { id, table: s.table, row };
    }
    return !!found;
  });
  return found!;
}
const value = (table: RecordTable, field: string, row: number) => (table.has(field) ? (table.value(field, row) as Value | Value[]) : null);
const listed = (v: Value | Value[]) => (Array.isArray(v) ? v.join("; ") : v);

{
  const { id, table, row } = section("Identity", (t, r) => value(t, "taxpayer_id_kind", r) === "ssn");
  put("identity", "Identity record", [
    ["Name", name(id)],
    ["Born", value(table, "birth_date", row) as string],
    ["SSN", value(table, "taxpayer_id", row) as string],
    ["SSN issued", value(table, "taxpayer_id_issued", row) as number],
    ["Citizenship", ({ born_us: "born in the US", naturalized: "naturalized", born_abroad_us_parents: "born abroad to US parents" } as Record<string, string>)[String(value(table, "citizenship", row))] ?? humanise(String(value(table, "citizenship", row)))],
  ]);
}
{
  const { id, table, row } = section("Driver licences and IDs", (t, r) => value(t, "holding", r) === "driver_licence");
  put("licences", "Driver license", [
    ["Holder", name(id)],
    ["Number", value(table, "number", row) as string],
    ["Class", value(table, "class", row) as string],
    ["Issued", value(table, "issued", row) as string],
    ["Expires", value(table, "expires", row) as string],
    ["REAL ID", value(table, "real_id", row) as boolean],
    ["Status", value(table, "status", row) as string],
  ]);
}
{
  const { id, table, row } = section("Criminal cases", (t, r) => value(t, "convicted", r) === true && value(t, "offence_year", r) as number > 2010);
  put("criminal", "Criminal case", [
    ["Defendant", name(id)],
    ["Docket", value(table, "docket", row) as string],
    ["Arrested", value(table, "arrest_date", row) as string],
    ["Lead charge", value(table, "lead_charge", row) as string],
    ["Disposition", humanise(String(value(table, "disposition", row)))],
    ["Disposed", value(table, "disposed", row) as string],
  ]);
  // Each count on the docket is a row of its own, hung off the case.
  const slice = table.childNames.map((child) => table.children(child, row)).find((c) => c && c.to > c.from)!;
  const charge = (field: string) => value(slice.table, field, slice.from);
  put("charges", "Charge", [
    ["Defendant", name(id)],
    ["Docket", value(table, "docket", row) as string],
    ["Statute", charge("cite") as string],
    ["Offense", charge("description") as string],
    ["Grade", charge("grade") as string],
    ["Counts", charge("counts") as number],
  ]);
}
{
  const { id, table, row } = section("Immigration documents", (t, r) => value(t, "document", r) === "permanent_resident_card");
  const field = (name: string) => value(table, name, row) as Value;
  put("immigration", "Immigration document", [
    ["Holder", name(id)],
    ["Document", humanise(String(field("document")))],
    ["Form", field("form")],
    ["Number", field("number")],
    ["Category", field("category")],
    ["Basis", field("basis") === null ? null : humanise(String(field("basis")))],
    ["Country", field("country")],
    ["Issued", field("issued")],
    ["Expires", field("expires")],
    ["Status", field("status") === null ? null : humanise(String(field("status")))],
    ["Issuer", field("issuer")],
  ]);
}
{
  const { id, table, row } = section("Civil and family cases", (t, r) => value(t, "kind", r) === "divorce");
  put("civil", "Civil case", [
    ["Party", name(id)],
    ["Kind", humanise(String(value(table, "kind", row)))],
    ["Docket", value(table, "docket", row) as string],
    ["Filed", value(table, "filed", row) as string],
    ["Role", value(table, "role", row) as string],
    ["Outcome", humanise(String(value(table, "outcome", row) ?? ""))],
  ]);
}
{
  const vehicles = sets.vehicles.table("vehicle");
  const row = pick(vehicles.rows, (r) => value(vehicles, "owner_type", r) === "person" && value(vehicles, "plate", r) !== null && (value(vehicles, "model_year", r) as number) > 2015);
  put("vehicles", "Registration", [
    ["Owner", name(value(vehicles, "owner", row) as number)],
    ["Plate", value(vehicles, "plate", row) as string],
    ["Vehicle", `${value(vehicles, "model_year", row)} ${value(vehicles, "make", row)} ${value(vehicles, "model", row)}, ${value(vehicles, "colour", row)}`],
    ["VIN", value(vehicles, "vin", row) as string],
    ["Registration expires", value(vehicles, "registration_expires", row) as string],
    ["Title", value(vehicles, "title_status", row) as string],
  ]);
}
{
  const { id, table, row } = section("Mortgages", (t, r) => (value(t, "balance", r) as number) > 0 && (value(t, "monthly_payment", r) as number) > 0);
  put("loans", "Mortgage", [
    ["Borrower", name(id)],
    ["Lender", value(table, "lender", row) as string],
    ["Originated", value(table, "originated", row) as string],
    ["Principal", dollars(value(table, "principal", row) as number)],
    ["Rate", `${(value(table, "rate", row) as number).toFixed(2)}%`],
    ["Monthly payment", dollars(value(table, "monthly_payment", row) as number)],
    ["Balance", dollars(value(table, "balance", row) as number)],
  ]);
}
{
  const { id, table, row } = section("Bank accounts");
  put("bank", "Bank account", [
    ["Holder", name(id)],
    ["Bank", value(table, "institution", row) as string],
    ["Routing", value(table, "routing", row) as string],
    ["Account", value(table, "number", row) as string],
    ["Type", value(table, "type", row) as string],
    ["Opened", value(table, "opened", row) as number],
    ["Balance", money(value(table, "balance", row) as number)],
  ]);
}
{
  const { id, table, row } = section("Credit cards", (t, r) => (value(t, "balance", r) as number) > 0);
  put("cards", "Credit card", [
    ["Holder", name(id)],
    ["Issuer", value(table, "issuer", row) as string],
    ["Network", value(table, "network", row) as string],
    ["Card", `•••• ${value(table, "last_four", row)}`],
    ["Expires", value(table, "expires", row) as string],
    ["Limit", dollars(value(table, "limit", row) as number)],
    ["Balance", money(value(table, "balance", row) as number)],
  ]);
}
{
  const { id, table, row } = section("Property");
  put("property", "Deed", [
    ["Owner", name(id)],
    ["Address", placeName(value(table, "address", row) as string) ?? (value(table, "address", row) as string)],
    ["Parcel", value(table, "parcel", row) as string],
    ["Recorded", value(table, "recorded", row) as string],
    ["Purchase price", dollars(value(table, "purchase_price", row) as number)],
    ["Assessed value", dollars(value(table, "assessed_value", row) as number)],
  ]);
}
{
  const { id, table, row } = section("Firearms", (t, r) => value(t, "transfer", r) === "dealer");
  put("firearms", "Gun purchase", [
    ["Buyer", name(id)],
    ["Firearm", value(table, "description", row) as string],
    ["Serial", value(table, "serial", row) as string],
    ["Bought", value(table, "acquired", row) as number],
    ["Dealer", value(table, "dealer", row) as string],
    ["Background check", value(table, "pics_approval", row) as string],
  ]);
}
{
  const { id, table, row } = section("Prescriptions");
  put("prescriptions", "Prescription", [
    ["Patient", name(id)],
    ["Drug", `${value(table, "drug", row)} (${value(table, "drug_class", row)})`],
    ["Written", value(table, "written", row) as string],
    ["Supply", `${value(table, "days_supply", row)} days, ${value(table, "refills", row)} refills`],
    ["Pharmacy", value(table, "pharmacy", row) as string],
  ]);
}
{
  const { id, table, row } = section("Handsets");
  put("handsets", "Handset", [
    ["User", name(id)],
    ["Phone", `${value(table, "make", row)} ${value(table, "model", row)}`],
    ["IMEI", value(table, "imei", row) as string],
    ["OS", value(table, "os_version", row) as string],
    ["Acquired", value(table, "acquired", row) as string],
  ]);
}
{
  const { id, table, row } = section("Lines", (t, r) => value(t, "mvno", r) === false);
  put("lines", "Phone line", [
    ["Subscriber", name(id)],
    ["Number", value(table, "msisdn", row) as string],
    ["Carrier", value(table, "carrier", row) as string],
    ["Plan", value(table, "plan_type", row) as string],
    ["IMSI", value(table, "imsi", row) as string],
    ["SIM", value(table, "iccid", row) as string],
  ]);
}
{
  const { id, table, row } = section("Messaging accounts", (t, r) => value(t, "channel", r) === "whatsapp");
  put("messaging", "Messaging account", [
    ["Owner", name(id)],
    ["App", "WhatsApp"],
    ["Handle", value(table, "handle", row) as string],
    ["Display name", value(table, "display_name", row) as string],
    ["Phone", value(table, "line", row) as string],
    ["Created", value(table, "created", row) as string],
  ]);
}

// ---- Places and fleet ----

{
  const dwellings = await json<{ dwellings: { address: string; kind: string; units: number; levels: number; lat: number; lon: number }[] }>("dwellings.json");
  const d = dwellings.dwellings[pick(dwellings.dwellings.length, (r) => dwellings.dwellings[r]!.units > 1 && !!dwellings.dwellings[r]!.address)]!;
  put("dwellings", "Home", [["Address", d.address], ["Building", humanise(d.kind)], ["Units", d.units], ["Location", place(d.lat, d.lon)]]);

  const site = workplaces.site_records[pick(workplaces.site_records.length, (r) => !!workplaces.site_records[r]!.name && !!workplaces.site_records[r]!.address && workplaces.site_records[r]!.capacity > 20)]!;
  put("workplaces", "Workplace", [["Name", site.name], ["Address", site.address], ["Jobs", site.capacity]]);

  const school = schools.school_records[pick(schools.school_records.length, (r) => schools.school_records[r]!.bands.includes("high"))]!;
  put("schools", "School", [["Name", school.name], ["Grades", school.bands.join(", ")], ["Sector", school.sector], ["Seats", school.seats ?? school.capacity], ["Location", place(school.lat, school.lon)]]);

  const venue = pois.points[pick(pois.points.length, (r) => !!pois.points[r]![4] && !!pois.points[r]![5] && pois.points[r]![2] === 0)]!;
  put("venues", "Venue", [["Name", venue[4]], ["Type", typeLabel.get(venue[3])], ["Address", venue[5]], ["Location", place(venue[0], venue[1])]]);
}

{
  // The road graph the router drives on: CSR adjacency over OSM nodes, one edge per direction.
  const graph = await Bun.file(join(simData, "car_graph.bin")).arrayBuffer();
  const headerLength = new DataView(graph).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(graph.slice(8, 8 + headerLength))) as { names: string[]; classes: string[]; arrays: { name: string; kind: string; length: number; byteOffset: number }[] };
  const base = (8 + headerLength + 7) & ~7;
  const array = (name: string) => {
    const spec = header.arrays.find((a) => a.name === name)!;
    const Ctor = { f64: Float64Array, f32: Float32Array, u32: Uint32Array, u8: Uint8Array }[spec.kind as "f64"]!;
    return new Ctor(graph.slice(base + spec.byteOffset, base + spec.byteOffset + spec.length * Ctor.BYTES_PER_ELEMENT));
  };
  const [offset, length, cost, nameId, classId] = [array("offset"), array("length"), array("cost"), array("nameId"), array("classId")];
  const edge = pick(length.length, (e) => header.classes[classId[e]!] === "secondary" && nameId[e]! > 0 && length[e]! > 150);
  let from = 0;
  while (offset[from + 1]! <= edge) from++;
  put("roads", "Street segment", [
    ["Street", header.names[nameId[edge]!]],
    ["Class", header.classes[classId[edge]!]],
    ["Length", `${Math.round(length[edge]!)} m`],
    ["Drive time", `${Math.round(cost[edge]!)} s`],
    ["Speed", `${Math.round((length[edge]! / cost[edge]!) * 3.6)} km/h`],
  ]);
}

const [cellCgi, cellOperator, cellBand, cellStructure, cellLat, cellLon, cellPci, cellTa, cellLayer] = await Promise.all(
  ["cell.cgi", "cell.operator", "cell.band", "cell.structure", "cell.latE6", "cell.lonE6", "cell.pci", "cell.trackingArea", "cell.layer"].map(col),
);
const operatorName: Record<string, string> = { verizon: "Verizon", att: "AT&T", tmobile: "T-Mobile", boost: "Boost" };
const cellLabel = (cell: number) => (cell < 0 ? null : `${operatorName[en("operator", cellOperator![cell]!)!] ?? ""} ${text(cellBand![cell]!)} · ${text(cellCgi![cell]!)}`);
{
  const towers = await json<{ cell_records: { cgi: string; azimuth: number; beamwidth: number; range_m: number; band: string; height_m?: number }[] }>("towers.json");
  const sector = new Map(towers.cell_records.map((c) => [c.cgi, c]));
  const cell = pick(cellCgi!.length, (c) => sector.has(text(cellCgi![c]!)!) && text(cellStructure![c]!)!.startsWith("asr"));
  const s = sector.get(text(cellCgi![cell]!)!)!;
  put("cells", "Cell", [
    ["Cell id", text(cellCgi![cell]!)],
    ["Carrier", operatorName[en("operator", cellOperator![cell]!)!]],
    ["Band", text(cellBand![cell]!)],
    ["Layer", en("radioLayer", cellLayer![cell]!)],
    ["Tower", text(cellStructure![cell]!)!.replace(/^asr\//, "FCC ASR ")],
    ["Facing", `${Math.round(s.azimuth)}°, ${Math.round(s.beamwidth)}° wide`],
    ["Reach", `${(s.range_m / 1000).toFixed(1)} km`],
    ["Physical cell id", cellPci![cell]!],
    ["Tracking area", cellTa![cell]!],
    ["Location", e6(cellLat![cell]!, cellLon![cell]!)],
  ]);
}

const [cameraId, cameraSide, cameraRole, cameraOwner, cameraLat, cameraLon] = await Promise.all(["camera.id", "camera.side", "camera.role", "camera.owner", "camera.latE6", "camera.lonE6"].map(col));
{
  const camera = pick(cameraId!.length, () => true);
  put("cameras", "Plate camera", [
    ["Camera", text(cameraId![camera]!)],
    ["Reads", en("plateSide", cameraSide![camera]!) + " plates"],
    ["Site", text(cameraRole![camera]!)],
    ["Operator", text(cameraOwner![camera]!)],
    ["Location", e6(cameraLat![camera]!, cameraLon![camera]!)],
  ]);
}

{
  const fleet = await json<{ operators: { id: number; name: string; kind: string; depot: { site: string } }[]; vehicles: { vin: string; service_class: string; operator: number }[] }>("fleet.json");
  const vehicles = sets.vehicles.table("vehicle");
  const vehicleRow = new Map<string, number>();
  for (let r = 0; r < vehicles.rows; r++) vehicleRow.set(value(vehicles, "vin", r) as string, r);
  for (const [key, service, kind] of [["taxis", "taxi", "Taxi"], ["buses", "school_bus", "School bus"], ["patrolCars", "police", "Patrol car"], ["ambulances", "ems", "Ambulance"]] as const) {
    const v = fleet.vehicles.find((entry) => entry.service_class === service && vehicleRow.has(entry.vin))!;
    const operator = fleet.operators.find((o) => o.id === v.operator)!;
    const r = vehicleRow.get(v.vin)!;
    put(key, kind, [
      ["Operator", operator.name],
      ["Vehicle", [value(vehicles, "model_year", r), value(vehicles, "make", r), value(vehicles, "model", r) ?? value(vehicles, "bus_type", r)].filter((v) => v !== null).join(" ")],
      ["Plate", value(vehicles, "plate", r) as string],
      ["VIN", v.vin],
      ["Seats", value(vehicles, "seats", r) as number],
      ["Base", placeName(operator.depot.site)],
    ]);
  }
}

// Vehicles on the day are named by VIN; the registry says what they are.
const vehicleTable = sets.vehicles.table("vehicle");
const vinRow = new Map<string, number>();
for (let r = 0; r < vehicleTable.rows; r++) vinRow.set(value(vehicleTable, "vin", r) as string, r);
const describe = (vin: string) => {
  const r = vinRow.get(vin);
  if (r === undefined) return vin;
  const field = (name: string) => value(vehicleTable, name, r);
  return `${[field("model_year"), field("make"), field("model") ?? field("bus_type")].filter((v) => v !== null).join(" ")}, ${field("plate")}`;
};

// ---- The day: schedules ----

const [personSchedule, personScheduleCount, personLeg, personLegCount] = await Promise.all(["person.scheduleOffset", "person.scheduleCount", "person.legOffset", "person.legCount"].map(col));
const [sStart, sEnd, sKind, sLabel, sWhere] = await Promise.all(["schedule.start", "schedule.end", "schedule.kind", "schedule.label", "schedule.where"].map(col));
const scheduleOwner = new Uint32Array(sStart!.length);
for (let p = 0; p < personSchedule!.length; p++) scheduleOwner.fill(p, personSchedule![p]!, personSchedule![p]! + personScheduleCount![p]!);
const scheduleOf = (kind: string, test: (row: number) => boolean = () => true) => {
  const code = day.enumValues("scheduleKind").indexOf(kind);
  return pick(sStart!.length, (r) => sKind![r] === code && test(r));
};
const stay = (key: string, kind: string, row: number, extra: [string, Value][] = []) =>
  put(key, kind, [
    ["Person", name(scheduleOwner[row]!)],
    ["Time", span(sStart![row]!, sEnd![row]!)],
    ["Activity", sKind![row] === day.enumValues("scheduleKind").indexOf("school") ? `${text(sLabel![row]!)} school` : text(sLabel![row]!) === "work" ? null : text(sLabel![row]!)],
    ["Where", placeName(text(sWhere![row]!)) ?? text(sWhere![row]!)],
    ...extra,
  ]);
stay("work", "Work shift", scheduleOf("work", (r) => placeName(text(sWhere![r]!)) !== null));
stay("school", "School day", scheduleOf("school", (r) => placeName(text(sWhere![r]!)) !== null));
{
  const row = scheduleOf("sleep", (r) => sStart![r]! > 1260 && sEnd![r]! < 1440 + 480);
  put("sleep", "Sleep", [["Person", name(scheduleOwner[row]!)], ["Asleep", clock(sStart![row]!)], ["Awake", clock(sEnd![row]!)], ["Hours", ((sEnd![row]! - sStart![row]!) / 60).toFixed(1)]]);
}
stay("errands", "Errand", scheduleOf("stop", (r) => (text(sLabel![r]!) ?? "").startsWith("grocery")));
stay("clubs", "Group activity", scheduleOf("affiliation", (r) => placeName(text(sWhere![r]!)) !== null));

{
  const [mKey, mKind, mPurpose, mVenue, mStart, mEnd, mHost, mPartyOffset, mPartyCount] = await Promise.all(
    ["meeting.key", "meeting.kind", "meeting.purpose", "meeting.venue", "meeting.start", "meeting.end", "meeting.host", "meeting.partyOffset", "meeting.partyCount"].map(col),
  );
  const [partyPerson, partyRole] = await Promise.all(["party.person", "party.role"].map(col));
  const attendees = (m: number) => {
    const names: string[] = [];
    for (let i = mPartyOffset![m]!; i < mPartyOffset![m]! + mPartyCount![m]!; i++) if (en("partyRole", partyRole![i]!) === "attendee") names.push(name(partyPerson![i]!));
    return names;
  };
  const friends = pick(mKind!.length, (m) => en("meetingKind", mKind![m]!) === "hosted" && mPartyCount![m]! >= 3 && placeName(text(mVenue![m]!)) !== null);
  put("meetings", "Meet-up", [
    ["Organiser", name(mHost![friends]!)],
    ["With", attendees(friends).filter((n) => n !== name(mHost![friends]!)).join(", ")],
    ["Time", span(mStart![friends]!, mEnd![friends]!)],
    ["Purpose", humanise(text(mPurpose![friends]!) ?? "")],
    ["Where", placeName(text(mVenue![friends]!))],
  ]);
  const outing = pick(mKind!.length, (m) => en("meetingKind", mKind![m]!) === "household" && mPartyCount![m]! >= 3 && placeName(text(mVenue![m]!)) !== null);
  put("outings", "Family outing", [
    ["People", attendees(outing).join(", ")],
    ["Time", span(mStart![outing]!, mEnd![outing]!)],
    ["Purpose", humanise(text(mPurpose![outing]!) ?? "")],
    ["Where", placeName(text(mVenue![outing]!))],
  ]);
}

// ---- Travel ----

const [lDepart, lArrive, lMode, lPurpose, lVehicle, lKm, lWait, lFrom, lTo, lPathCount] = await Promise.all(
  ["leg.depart", "leg.arrive", "leg.mode", "leg.purpose", "leg.vehicle", "leg.kilometres", "leg.wait", "leg.fromLabel", "leg.toLabel", "leg.pathCount"].map(col),
);
const legOwner = new Uint32Array(lDepart!.length);
for (let p = 0; p < personLeg!.length; p++) legOwner.fill(p, personLeg![p]!, personLeg![p]! + personLegCount![p]!);
const mode = (leg: number) => en("mode", lMode![leg]!);
const purpose = (leg: number) => en("purpose", lPurpose![leg]!);
const legFields = (leg: number): [string, Value][] => [
  ["Person", name(legOwner[leg]!)],
  ["Time", span(lDepart![leg]!, lArrive![leg]!)],
  ["From", text(lFrom![leg]!)],
  ["To", text(lTo![leg]!)],
  ["Mode", mode(leg)],
  ["Distance", `${lKm![leg]!.toFixed(1)} km`],
];
{
  const leg = pick(lDepart!.length, (l) => mode(l) === "car" && purpose(l) === "work" && lPathCount![l]! > 100 && text(lFrom![l]!) === "home");
  put("trips", "Trip", [...legFields(leg), ["Route points", lPathCount![leg]!]]);
  const walk = pick(lDepart!.length, (l) => mode(l) === "walk" && lKm![l]! > 0.4 && purpose(l) === "stop");
  put("modes", "Trip", legFields(walk));
  const run = pick(lDepart!.length, (l) => purpose(l) === "run" && mode(l) === "bus" && lKm![l]! > 3);
  put("busRuns", "Bus run", [["Driver", name(legOwner[run]!)], ["Time", span(lDepart![run]!, lArrive![run]!)], ["From", text(lFrom![run]!)], ["To", text(lTo![run]!)], ["Bus", describe(text(lVehicle![run]!)!)], ["Distance", `${lKm![run]!.toFixed(1)} km`]]);
  const ride = pick(lDepart!.length, (l) => mode(l) === "taxi" && lWait![l]! > 0);
  put("taxiRides", "Taxi ride", [...legFields(ride).filter(([label]) => label !== "Mode"), ["Waited", minutes(lWait![ride]!)], ["Cab", lVehicle![ride]! === NONE ? null : describe(text(lVehicle![ride]!)!)]]);
  const patrol = pick(lDepart!.length, (l) => purpose(l) === "patrol" && lKm![l]! > 2);
  put("patrols", "Patrol leg", [["Officer", name(legOwner[patrol]!)], ["Time", span(lDepart![patrol]!, lArrive![patrol]!)], ["From", text(lFrom![patrol]!)], ["To", text(lTo![patrol]!)], ["Car", describe(text(lVehicle![patrol]!)!)], ["Distance", `${lKm![patrol]!.toFixed(1)} km`]]);
}

{
  const [vVin, vOwner, vHousehold, vService, vSpanOffset, vSpanCount] = await Promise.all(["vehicle.vin", "vehicle.owner", "vehicle.household", "vehicle.serviceClass", "vehicle.spanOffset", "vehicle.spanCount"].map(col));
  const [spStart, spEnd, spKind, spLeg, spLat, spLon] = await Promise.all(["vehicleSpan.startSecond", "vehicleSpan.endSecond", "vehicleSpan.kind", "vehicleSpan.leg", "vehicleSpan.latE6", "vehicleSpan.lonE6"].map(col));
  const moving = day.enumValues("vehicleSpanKind").indexOf("moving");
  // A household car driven by someone other than its registered owner.
  let shared: [number, number] | null = null;
  pick(vVin!.length, (v) => {
    if (en("vehicleServiceClass", vService![v]!) !== "none" || vHousehold![v]! < 0) return false;
    for (let s = vSpanOffset![v]!; s < vSpanOffset![v]! + vSpanCount![v]!; s++) {
      if (spKind![s] !== moving || spLeg![s]! < 0) continue;
      const driver = legOwner[spLeg![s]!]!;
      if (driver !== vOwner![v]! && population.residentHousehold(driver) === vHousehold![v]!) {
        shared = [v, s];
        return true;
      }
    }
    return false;
  });
  const [v, s] = shared!;
  const leg = spLeg![s]!;
  put("householdCars", "Car use", [
    ["Car", describe(text(vVin![v]!)!)],
    ["Registered to", name(vOwner![v]!)],
    ["Driven by", name(legOwner[leg]!)],
    ["Time", span(lDepart![leg]!, lArrive![leg]!)],
    ["To", text(lTo![leg]!)],
  ]);
  const parked = pick(spKind!.length, (p) => spKind![p] !== moving && p > 0 && spLeg![p - 1]! >= 0 && (text(lTo![spLeg![p - 1]!]!) ?? "").startsWith("parked near") && spEnd![p]! - spStart![p]! > 1800 && spEnd![p]! < 86400);
  let owner = 0;
  while (vSpanOffset![owner + 1] !== undefined && vSpanOffset![owner + 1]! <= parked) owner++;
  put("parking", "Parked car", [
    ["Car", describe(text(vVin![owner]!)!)],
    ["Parked", `${clockSeconds(spStart![parked]!).slice(0, 5)}–${clockSeconds(spEnd![parked]!).slice(0, 5)}`],
    ["Where", text(lTo![spLeg![parked - 1]!]!)],
    ["Location", e6(spLat![parked]!, spLon![parked]!)],
  ]);
}

{
  const [xKind, xState, xPlate, xMake, xModel, xColour, xYear] = await Promise.all(["externalVehicle.kind", "externalVehicle.state", "externalVehicle.plate", "externalVehicle.make", "externalVehicle.model", "externalVehicle.colour", "externalVehicle.modelYear"].map(col));
  const [tVehicle, tKind, tDepart, tArrive] = await Promise.all(["externalTrip.vehicle", "externalTrip.kind", "externalTrip.departSecond", "externalTrip.arriveSecond"].map(col));
  const outside = (key: string, kind: string, tripKind: string) => {
    const t = pick(tKind!.length, (r) => en("externalTripKind", tKind![r]!) === tripKind);
    const v = tVehicle![t]!;
    put(key, kind, [
      ["Vehicle", `${xYear![v]} ${text(xMake![v]!)} ${text(xModel![v]!)}, ${text(xColour![v]!)}`],
      ["Plate", `${text(xPlate![v]!)} (${text(xState![v]!)})`],
      ["Kind", ({ worker: "commuter", delivery: "delivery", repeat_visitor: "regular visitor", single_visit: "one-off visitor", through: "passing through" } as Record<string, string>)[en("externalVehicleKind", xKind![v]!)!]],
      ["Time in city", `${clockSeconds(tDepart![t]!).slice(0, 5)}–${clockSeconds(tArrive![t]!).slice(0, 5)}`],
    ]);
  };
  outside("commuters", "Commuter trip", "work_arrival");
  outside("deliveries", "Delivery trip", "service_arrival");
  outside("visitors", "Visitor trip", "visit_arrival");
  outside("through", "Through trip", "through");
}

// ---- Emergency response ----

{
  const [iKind, iPriority, iPlace, iPlaceClass, iReceived, iCaller, iDispatched, iOnScene, iCleared, iLat, iLon] = await Promise.all(
    ["incident.kind", "incident.priority", "incident.place", "incident.placeClass", "incident.receivedMinute", "incident.caller", "incident.dispatchedMinute", "incident.firstOnSceneMinute", "incident.clearedMinute", "incident.latE6", "incident.lonE6"].map(col),
  );
  const [rIncident, rService, rVehicle, rPerson, rPartner, rDispatched, rArrived, rCleared, rHospital, rHospitalArrived] = await Promise.all(
    ["response.incident", "response.service", "response.vehicle", "response.person", "response.partner", "response.dispatchedMinute", "response.arrivedMinute", "response.clearedMinute", "response.hospital", "response.hospitalArrivedMinute"].map(col),
  );
  const call = pick(iKind!.length, (i) => en("incidentKind", iKind![i]!) === "burglary" || en("incidentKind", iKind![i]!) === "domestic");
  put("calls911", "911 call", [
    ["Caller", name(iCaller![call]!)],
    ["Received", clock(iReceived![call]!)],
    ["Kind", en("incidentKind", iKind![call]!)],
    ["Priority", iPriority![call]!],
    ["At", placeName(text(iPlace![call]!)) ?? en("incidentPlaceClass", iPlaceClass![call]!)],
    ["Location", e6(iLat![call]!, iLon![call]!)],
    ["Dispatched", clock(iDispatched![call]!)],
    ["First on scene", clock(iOnScene![call]!)],
    ["Cleared", clock(iCleared![call]!)],
  ]);
  const unit = pick(rIncident!.length, (r) => en("service", rService![r]!) === "police");
  const incident = rIncident![unit]!;
  put("dispatch", "Unit response", [
    ["Incident", `${en("incidentKind", iKind![incident]!)}, received ${clock(iReceived![incident]!)}`],
    ["Unit", `police car ${text(rVehicle![unit]!)}`],
    ["Officers", [name(rPerson![unit]!), rPartner![unit]! >= 0 ? name(rPartner![unit]!) : null].filter(Boolean).join(", ")],
    ["Dispatched", clock(rDispatched![unit]!)],
    ["Arrived", `${clock(rArrived![unit]!)} (${minutes(rArrived![unit]! - rDispatched![unit]!)} drive)`],
    ["Cleared", clock(rCleared![unit]!)],
  ]);
  const ride = pick(rIncident!.length, (r) => en("service", rService![r]!) === "ems" && rHospitalArrived![r]! >= 0);
  put("ambulanceRuns", "Ambulance run", [
    ["Incident", `${en("incidentKind", iKind![rIncident![ride]!]!)}, received ${clock(iReceived![rIncident![ride]!]!)}`],
    ["Patient", name(iCaller![rIncident![ride]!]!)],
    ["Crew", [name(rPerson![ride]!), rPartner![ride]! >= 0 ? name(rPartner![ride]!) : null].filter(Boolean).join(", ")],
    ["Dispatched", clock(rDispatched![ride]!)],
    ["On scene", clock(rArrived![ride]!)],
    ["Hospital", placeName(text(rHospital![ride]!)?.replace(/^poi\//, "") ?? null) ?? (() => {
      const index = Number(text(rHospital![ride]!)?.replace(/^poi\//, ""));
      return pois.points[index]?.[4] ?? null;
    })()],
    ["At hospital", clock(rHospitalArrived![ride]!)],
  ]);
}

// ---- Money ----

{
  const [tPerson, tMinute, tAmount, tKind, tReason, tApproved, tDecline, tInstrument, tMerchant, tCard, tNetwork, tBalance] = await Promise.all(
    ["tx.person", "tx.minute", "tx.amount", "tx.kind", "tx.reason", "tx.approved", "tx.decline", "tx.instrument", "tx.merchant", "tx.card", "tx.network", "tx.balanceAfter"].map(col),
  );
  const reason = (t: number) => en("reason", tReason![t]!);
  const instrument = (t: number) => en("instrument", tInstrument![t]!);
  const tx = (key: string, kind: string, test: (t: number) => boolean, extra: (t: number) => [string, Value][] = () => []) => {
    const t = pick(tMinute!.length, (r) => tMinute![r]! >= 0 && tMinute![r]! < 1440 && test(r));
    put(key, kind, [
      ["Person", name(tPerson![t]!)],
      ["Time", clock(tMinute![t]!)],
      ["Amount", money(tAmount![t]!)],
      ["Payee", text(tMerchant![t]!)],
      ["For", humanise(reason(t) ?? "")],
      ["Paid by", instrument(t)],
      ["Card", tCard![t]! !== NONE && instrument(t) !== "cash" && instrument(t) !== "ach" ? `${text(tNetwork![t]!)} •••• ${text(tCard![t]!)}` : null],
      ...extra(t),
    ]);
  };
  const approved = (t: number) => tApproved![t] === 1;
  tx("cardPayments", "Card payment", (t) => approved(t) && instrument(t) === "credit" && reason(t) === "food-sit", (t) => [["Balance after", money(tBalance![t]!)]]);
  tx("cash", "Cash purchase", (t) => approved(t) && instrument(t) === "cash" && reason(t) === "convenience");
  tx("fares", "Fare", (t) => approved(t) && reason(t) === "fare");
  tx("parkingFees", "Parking fee", (t) => approved(t) && reason(t) === "parking");
  tx("bills", "Bill payment", (t) => approved(t) && reason(t) === "electricity", (t) => [["Balance after", money(tBalance![t]!)]]);
  tx("wages", "Deposit", (t) => en("txKind", tKind![t]!) === "transfer_in" && tAmount![t]! > 500, (t) => [["Balance after", money(tBalance![t]!)]]);
  tx("balances", "Account balance", (t) => approved(t) && instrument(t) === "debit" && reason(t) === "grocery", (t) => [["Balance before", money(tBalance![t]! + Math.abs(tAmount![t]!))], ["Balance after", money(tBalance![t]!)]]);
  tx("declines", "Declined payment", (t) => !approved(t) && en("decline", tDecline![t]!) === "insufficient_funds", (t) => [["Declined", humanise(en("decline", tDecline![t]!) ?? "")]]);
}

// ---- Communications ----

const [aPerson, aChannel, aHandle, aSubscriber] = await Promise.all(["account.person", "account.channel", "account.handle", "account.subscriber"].map(col));
const [subPerson, subMsisdn, subCarrier] = await Promise.all(["subscriber.person", "subscriber.msisdn", "subscriber.carrier"].map(col));
const [cChannel, cKind, cAt, cCount, cTitle] = await Promise.all(["conversation.channel", "conversation.kind", "conversation.at", "conversation.count", "conversation.title"].map(col));
const [participant] = await Promise.all(["participant.account"].map(col));
const [mConversation, mFrom, mAt, mKind, mChannel, mBytes, mReplyTo] = await Promise.all(["message.conversation", "message.from", "message.at", "message.kind", "message.channel", "message.bytes", "message.replyTo"].map(col));
const channelName: Record<string, string> = { sms: "SMS", mms: "MMS", voice: "phone", imessage: "iMessage", whatsapp: "WhatsApp", telegram: "Telegram", signal: "Signal", messenger: "Messenger", snapchat: "Snapchat" };
const members = (conversation: number) => {
  const ids: number[] = [];
  for (let i = cAt![conversation]!; i < cAt![conversation]! + cCount![conversation]!; i++) ids.push(participant![i]!);
  return ids;
};
const others = (conversation: number, from: number) => members(conversation).filter((a) => a !== from).map((a) => name(aPerson![a]!));
{
  const [callConversation, callFrom, callAt, callOutcome, callRing, callDuration] = await Promise.all(["call.conversation", "call.from", "call.at", "call.outcome", "call.ring", "call.duration"].map(col));
  const [cdrCall, cdrFrom, cdrTo, cdrOrigin, cdrToOrigin] = await Promise.all(["cdr.call", "cdr.from", "cdr.to", "cdr.originCell", "cdr.toOriginCell"].map(col));
  const cdr = pick(cdrCall!.length, (r) => en("callOutcome", callOutcome![cdrCall![r]!]!) === "answered" && callDuration![cdrCall![r]!]! > 120);
  const c = cdrCall![cdr]!;
  put("phoneCalls", "Call record", [
    ["Caller", `${name(subPerson![cdrFrom![cdr]!]!)}, ${text(subMsisdn![cdrFrom![cdr]!]!)}`],
    ["Called", cdrTo![cdr]! >= 0 ? `${name(subPerson![cdrTo![cdr]!]!)}, ${text(subMsisdn![cdrTo![cdr]!]!)}` : others(callConversation![c]!, callFrom![c]!).join(", ")],
    ["Started", clockSeconds(callAt![c]!)],
    ["Rang", `${callRing![c]} s`],
    ["Duration", `${Math.floor(callDuration![c]! / 60)} min ${callDuration![c]! % 60} s`],
    ["Caller's cell", cellLabel(cdrOrigin![cdr]!)],
    ["Callee's cell", cellLabel(cdrToOrigin![cdr]!)],
  ]);

  const [smsMessage, smsFrom, smsTo, smsCell, smsDelivered] = await Promise.all(["sms.message", "sms.from", "sms.to", "sms.cell", "sms.delivered"].map(col));
  const sms = pick(smsMessage!.length, (r) => smsFrom![r]! >= 0 && smsTo![r]! >= 0 && smsDelivered![r]! >= 0);
  const m = smsMessage![sms]!;
  put("texts", "Text message", [
    ["From", `${name(subPerson![smsFrom![sms]!]!)}, ${text(subMsisdn![smsFrom![sms]!]!)}`],
    ["To", `${name(subPerson![smsTo![sms]!]!)}, ${text(subMsisdn![smsTo![sms]!]!)}`],
    ["Sent", clockSeconds(mAt![m]!)],
    ["Delivered", clockSeconds(smsDelivered![sms]!)],
    ["Length", `${mBytes![m]} bytes`],
    ["Sender's cell", cellLabel(smsCell![sms]!)],
    ["Carrier", text(subCarrier![smsFrom![sms]!]!)],
  ]);
}
{
  const message = (key: string, kind: string, test: (m: number) => boolean, extra: (m: number) => [string, Value][] = () => []) => {
    const m = pick(mConversation!.length, test);
    const conversation = mConversation![m]!;
    put(key, kind, [
      ["App", channelName[en("channel", mChannel![m]!)!]],
      ["From", `${name(aPerson![mFrom![m]!]!)} (${text(aHandle![mFrom![m]!]!)})`],
      ["To", others(conversation, mFrom![m]!).slice(0, 6).join(", ")],
      ["Sent", clockSeconds(mAt![m]!)],
      ["Content", `${en("messageKind", mKind![m]!)}, ${mBytes![m]} bytes`],
      ...extra(m),
    ]);
  };
  const channel = (m: number) => en("channel", mChannel![m]!);
  const dyad = (m: number) => en("conversationKind", cKind![mConversation![m]!]!) === "dyad";
  message("chats", "Chat message", (m) => channel(m) === "whatsapp" && dyad(m) && en("messageKind", mKind![m]!) === "text" && others(mConversation![m]!, mFrom![m]!).length > 0);
  message("groupChats", "Group message", (m) => en("conversationKind", cKind![mConversation![m]!]!) === "group" && text(cTitle![mConversation![m]!]!) !== null && cCount![mConversation![m]!]! >= 4, (m) => [
    ["Group", text(cTitle![mConversation![m]!]!)],
    ["Members", cCount![mConversation![m]!]!],
  ]);
  // `replyTo` is a position within the thread, not a message row.
  const [mSeq] = await Promise.all(["message.seq"].map(col));
  const original = (m: number) => {
    for (let o = 0; o < mConversation!.length; o++) if (mConversation![o] === mConversation![m] && mSeq![o] === mReplyTo![m]) return o;
    return -1;
  };
  message("replies", "Reply", (m) => mReplyTo![m]! >= 0 && channel(m) === "imessage" && dyad(m) && mFrom![m] !== undefined, (m) => {
    const o = original(m);
    return [["Replying to", o < 0 ? null : `${name(aPerson![mFrom![o]!]!)}, ${clockSeconds(mAt![o]!)}`]];
  });
  void aChannel;
  void aSubscriber;
  void cChannel;
}

// ---- The carrier's view ----

{
  const [spanSubscriber, spanCell, spanStart, spanEnd, spanRsrp, spanExposure, spanConnected, spanTa] = await Promise.all(
    ["span.subscriber", "span.cell", "span.start", "span.end", "span.rsrp", "span.exposure", "span.connected", "span.ta"].map(col),
  );
  const s = pick(spanCell!.length, (r) => spanCell![r]! >= 0 && spanEnd![r]! - spanStart![r]! >= 20 && spanEnd![r]! < 1440);
  put("servingCells", "Serving cell", [
    ["Phone", `${name(subPerson![spanSubscriber![s]!]!)}, ${text(subMsisdn![spanSubscriber![s]!]!)}`],
    ["Time", span(spanStart![s]!, spanEnd![s]!)],
    ["Cell", cellLabel(spanCell![s]!)],
    ["Signal", `${spanRsrp![s]!.toFixed(0)} dBm`],
    ["Handset", en("exposure", spanExposure![s]!)],
    ["Radio active", spanConnected![s]! > 0 ? `${spanConnected![s]} min` : "idle"],
    ["Timing advance", spanTa![s]! >= 0 ? spanTa![s]! : null],
  ]);

  const [eSubscriber, eMinute, eKind, eCell, ePrevious, eCause, eTa] = await Promise.all(
    ["event.subscriber", "event.minute", "event.kind", "event.cell", "event.previous", "event.cause", "event.ta"].map(col),
  );
  const event = (key: string, kind: string, test: (e: number) => boolean) => {
    const e = pick(eKind!.length, test);
    put(key, kind, [
      ["Phone", `${name(subPerson![eSubscriber![e]!]!)}, ${text(subMsisdn![eSubscriber![e]!]!)}`],
      ["Time", clock(eMinute![e]!)],
      ["Event", en("eventKind", eKind![e]!)],
      ["Cause", humanise(en("eventCause", eCause![e]!) ?? "")],
      ["From cell", cellLabel(ePrevious![e]!)],
      ["To cell", cellLabel(eCell![e]!)],
      ["Timing advance", eTa![e]! >= 0 ? eTa![e]! : null],
    ]);
  };
  const is = (e: number, kind: string) => en("eventKind", eKind![e]!) === kind;
  event("handovers", "Handover", (e) => is(e, "handover") && ePrevious![e]! >= 0);
  event("reselections", "Idle reselection", (e) => is(e, "reselect") && ePrevious![e]! >= 0);
  event("signalling", "Network event", (e) => is(e, "attach") && en("eventCause", eCause![e]!) === "power-on");
}

// ---- Plate cameras ----

{
  const [oCorrelation, oCamera, oSecond, oDetected, oConfidence, oOutcome, oLighting] = await Promise.all(
    ["alprObservation.correlationId", "alprObservation.camera", "alprObservation.second", "alprObservation.detectedText", "alprObservation.confidence", "alprObservation.outcome", "alprObservation.lighting"].map(col),
  );
  const [truthCorrelation, truthPlate, truthJurisdiction] = await Promise.all(["alprTruth.correlationId", "alprTruth.plate", "alprTruth.jurisdiction"].map(col));
  const truthOf = new Map<number, number>();
  for (let i = 0; i < truthCorrelation!.length; i++) truthOf.set(truthCorrelation![i]!, i);
  const read = (key: string, kind: string, outcome: string) => {
    const o = pick(oOutcome!.length, (r) => en("alprOutcome", oOutcome![r]!) === outcome);
    const truth = truthOf.get(oCorrelation![o]!);
    put(key, kind, [
      ["Camera", text(cameraId![oCamera![o]!]!)],
      ["Time", clockSeconds(oSecond![o]!)],
      ["Read", text(oDetected![o]!) ?? "nothing"],
      ["Confidence", oConfidence![o]! > 0 ? `${Math.round(oConfidence![o]! * 100)}%` : null],
      ["Actual plate", truth === undefined ? "no vehicle" : `${text(truthPlate![truth]!)} (${text(truthJurisdiction![truth]!)})`],
      ["Light", humanise(en("lighting", oLighting![o]!) ?? "")],
      ["Result", humanise(outcome)],
    ]);
  };
  read("plateReads", "Plate read", "correct");
  read("missedReads", "Missed vehicle", "not_captured");
  read("misreads", "Misread", "misread");
  read("unreadable", "Unreadable plate", "unreadable");
}

// ---- Scenarios: one staged incident over its own base day ----
// Staged deltas are the bases of scored bench cases, so only non-identifying shape is published:
// no person, role, place or handset detail.

{
  const staged = await KdayReader.open(scenarioDay, { delta: scenarioFile });
  const header = (staged.meta as unknown as { scenario: {
    name: string;
    events: { kind: string; start: number; end: number }[];
    affected: { person: number; reasons: string[] }[];
  } }).scenario;
  const event = header.events[0]!;
  put("staged", "Staged incident", [
    ["Scenario", header.name],
    ["Date", staged.meta.date],
    ["Time", span(event.start, event.end)],
    ["People re-planned", header.affected.length],
  ]);
  await staged.close();
}

const body = JSON.stringify({ date: day.meta.date, samples });
await Bun.write(join(out, "samples.json"), body);
console.log(`samples.json: ${Object.keys(samples).length} samples, ${(body.length / 1024).toFixed(1)} KB`);

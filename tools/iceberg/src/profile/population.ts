/**
 * What the city looks like before anybody has left the house.
 *
 * Two rules shaped what goes in here. The first is that a count on its own is
 * almost never the invariant — 46,039 households is a fact about how big the
 * run was, while the share of them holding a child is a fact about the model,
 * and only the second should hold still when the population is regenerated at
 * a different size. So counts are recorded with their share alongside.
 *
 * The second is that a marginal hides what a cross-tab shows. An edit that
 * moves working women into part-time work and men out of it leaves the sex
 * split and the employment split both untouched; the two of them crossed moves
 * by ten points. That is most of the length of this file: the marginals are
 * cheap and there for orientation, and the crosses are what an invariant check
 * actually runs on.
 */

import { Builder, Cat, Num, ageBand, band, moneyBand } from "../metrics.ts";
import { Population, RELATIONSHIP, education } from "../population.ts";

/** The under-18 cut every household composition metric here uses. */
const CHILD = 18;
const SENIOR = 65;

export function analysePopulation(b: Builder, pop: Population): void {
  const counts = pop.counts;
  for (const [name, value] of Object.entries(counts)) b.scalar(`population.count.${name}`, value);
  b.scalar("population.count.residents", pop.residents);
  b.scalar("population.household.meanSize", counts.persons / counts.households, "rate");
  b.scalar("population.building.meanHouseholds", counts.households / counts.dwellingBuildings, "rate");

  buildings(b, pop);
  households(b, pop);
  people(b, pop, "person", counts.persons);
  people(b, pop, "quarters", counts.quarters);
  crosses(b, pop);
  invariants(b, pop);
}

function buildings(b: Builder, pop: Population): void {
  const a = pop.a;
  const n = pop.counts.buildings;
  const kind = new Cat();
  const street = new Cat();
  const postcode = new Cat();
  const kindByPostcode = new Cat();
  const units = new Num();
  const perBuilding = new Num();
  const residents = new Num();
  const occupancy = new Num();
  const unitsByKind = new Map<string, Num>();
  let empty = 0;
  let overFull = 0;

  for (let i = 0; i < n; i += 1) {
    const label = pop.buildingKind(i);
    kind.add(label);
    street.add(pop.street(i));
    postcode.add(pop.postcode(i));
    kindByPostcode.add(`${pop.postcode(i)} × ${label}`);
    const unitCount = (a.building_units as Uint16Array)[i];
    units.push(unitCount);
    if (!unitsByKind.has(label)) unitsByKind.set(label, new Num());
    unitsByKind.get(label)!.push(unitCount);
    const homes = pop.householdsInBuilding[i];
    perBuilding.push(homes);
    residents.push(pop.residentsInBuilding[i]);
    if (unitCount > 0) occupancy.push(homes / unitCount);
    if (homes === 0 && pop.residentsInBuilding[i] === 0) empty += 1;
    if (unitCount > 0 && homes > unitCount) overFull += 1;
  }

  b.cat("population.building.kind", kind);
  b.cat("population.building.street", street);
  b.cat("population.building.postcode", postcode);
  b.cat("population.building.postcode×kind", kindByPostcode);
  b.num("population.building.units", units);
  b.num("population.building.households", perBuilding);
  b.num("population.building.residents", residents);
  b.num("population.building.occupancy", occupancy);
  for (const [label, sketch] of unitsByKind) b.num(`population.building.units.by.kind.${label}`, sketch);
  b.countAndShare("population.building.empty", empty, n);
  b.num("population.building.lat", a.building_lat as Float64Array);
  b.num("population.building.lon", a.building_lon as Float64Array);
  b.invariant(
    "population.building.overFull",
    "a building holds no more households than it has units",
    overFull, n,
  );
}

function households(b: Builder, pop: Population): void {
  const a = pop.a;
  const n = pop.counts.households;
  const offsets = a.household_person as Uint32Array;
  const size = new Cat();
  const composition = new Cat();
  const sizeByKind = new Cat();
  const income = new Num();
  const incomeBand = new Cat();
  const area = new Num();
  const perCapita = new Num();
  const adults = new Num();
  const children = new Num();
  const seniors = new Num();
  const workers = new Num();
  const earners = new Num();
  const householderAge = new Num();
  const incomeBySize = new Map<number, Num>();
  const incomeByKind = new Map<string, Num>();
  const sourceUse = new Cat();
  let withChildren = 0;
  let withSeniors = 0;
  let multigenerational = 0;
  let noEarner = 0;
  let sizeMismatch = 0;
  let noHouseholder = 0;
  let manyHouseholders = 0;

  for (let h = 0; h < n; h += 1) {
    const members = offsets[h + 1] - offsets[h];
    const declared = (a.household_size as Uint8Array)[h];
    if (members !== declared) sizeMismatch += 1;
    const kind = pop.buildingKind((a.household_building as Uint32Array)[h]);
    size.add(String(declared));
    sizeByKind.add(`${kind} × ${band(declared, [1, 2, 3, 4, 5, 7])}`);
    sourceUse.add(pop.s.source[(a.household_source as Uint16Array)[h]]);

    const money = (a.household_income as Int32Array)[h];
    income.push(money);
    incomeBand.add(moneyBand(money));
    if (members) perCapita.push(money / members);
    if (!incomeBySize.has(declared)) incomeBySize.set(declared, new Num());
    incomeBySize.get(declared)!.push(money);
    if (!incomeByKind.has(kind)) incomeByKind.set(kind, new Num());
    incomeByKind.get(kind)!.push(money);
    area.push((a.household_area as Float32Array)[h]);

    let adultCount = 0;
    let childCount = 0;
    let seniorCount = 0;
    let workerCount = 0;
    let earnerCount = 0;
    let householderCount = 0;
    let generations = new Set<string>();
    for (let p = offsets[h]; p < offsets[h + 1]; p += 1) {
      const age = (a.person_age as Uint8Array)[p];
      if (age >= CHILD) adultCount += 1; else childCount += 1;
      if (age >= SENIOR) seniorCount += 1;
      const status = (a.person_employment as Uint8Array)[p];
      if (status === 1 || status === 2 || status === 4 || status === 5) workerCount += 1;
      if ((a.person_income as Int32Array)[p] > 0) earnerCount += 1;
      const relation = RELATIONSHIP[(a.person_relationship as Uint8Array)[p]] ?? "—";
      if (relation === "householder") { householderCount += 1; householderAge.push(age); }
      if (relation === "child" || relation === "adopted child" || relation === "stepchild") generations.add("child");
      if (relation === "householder" || relation === "spouse" || relation === "unmarried partner") generations.add("head");
      if (relation === "parent" || relation === "parent-in-law") generations.add("parent");
      if (relation === "grandchild") generations.add("grandchild");
    }
    adults.push(adultCount);
    children.push(childCount);
    seniors.push(seniorCount);
    workers.push(workerCount);
    earners.push(earnerCount);
    if (childCount) withChildren += 1;
    if (seniorCount) withSeniors += 1;
    if (generations.size >= 3) multigenerational += 1;
    if (!earnerCount) noEarner += 1;
    if (!householderCount) noHouseholder += 1;
    if (householderCount > 1) manyHouseholders += 1;
    composition.add(
      `${adultCount ? `${Math.min(adultCount, 3)} adult` : "0 adult"}` +
      `${childCount ? ` + ${Math.min(childCount, 3)} child` : ""}` +
      `${seniorCount ? " + senior" : ""}`,
    );
  }

  b.cat("population.household.size", size);
  b.cat("population.household.composition", composition);
  b.cat("population.household.buildingKind×size", sizeByKind);
  b.cat("population.household.pumsSource", sourceUse);
  b.num("population.household.income", income);
  b.cat("population.household.incomeBand", incomeBand);
  b.num("population.household.incomePerPerson", perCapita);
  b.num("population.household.area", area);
  b.num("population.household.adults", adults);
  b.num("population.household.children", children);
  b.num("population.household.seniors", seniors);
  b.num("population.household.workers", workers);
  b.num("population.household.earners", earners);
  b.num("population.household.householderAge", householderAge);
  for (const [members, sketch] of [...incomeBySize].sort((x, y) => x[0] - y[0])) {
    b.num(`population.household.income.by.size.${members}`, sketch);
  }
  for (const [kind, sketch] of incomeByKind) b.num(`population.household.income.by.buildingKind.${kind}`, sketch);
  b.countAndShare("population.household.withChildren", withChildren, n);
  b.countAndShare("population.household.withSeniors", withSeniors, n);
  b.countAndShare("population.household.multigenerational", multigenerational, n);
  b.countAndShare("population.household.noEarner", noEarner, n);
  b.invariant("population.household.sizeMismatch", "declared size equals the number of members packed", sizeMismatch, n);
  b.invariant("population.household.noHouseholder", "every household has a householder", noHouseholder, n);
  b.invariant("population.household.manyHouseholders", "no household has two householders", manyHouseholders, n);
}

/** The person columns, run over either the household table or group quarters. */
function people(b: Builder, pop: Population, prefix: "person" | "quarters", n: number): void {
  if (!n) return;
  const a = pop.a;
  const at = `population.${prefix}`;
  const age = new Num();
  const ages = new Cat();
  const sex = new Cat();
  const race = new Cat();
  const relationship = new Cat();
  const schooling = new Cat();
  const employment = new Cat();
  const income = new Num();
  const incomeBand = new Cat();
  const occupation = new Cat();
  const industry = new Cat();
  const major = new Cat();
  const base = prefix === "person" ? 0 : pop.counts.persons;

  for (let i = 0; i < n; i += 1) {
    const id = base + i;
    const years = (a[`${prefix}_age`] as Uint8Array)[i];
    age.push(years);
    ages.add(ageBand(years));
    sex.add(pop.sex(id));
    race.add(pop.race(id));
    relationship.add(RELATIONSHIP[(a[`${prefix}_relationship`] as Uint8Array)[i]] ?? "—");
    schooling.add(education((a[`${prefix}_education`] as Uint8Array)[i]));
    employment.add(pop.employment(id));
    const money = (a[`${prefix}_income`] as Int32Array)[i];
    income.push(money);
    incomeBand.add(moneyBand(money));
    const job = pop.s.occupation[(a[`${prefix}_occupation`] as Uint16Array)[i]];
    if (job) {
      occupation.add(job);
      major.add(pop.socMajor(id) ?? "—");
    }
    const sector = pop.s.industry[(a[`${prefix}_industry`] as Uint16Array)[i]];
    if (sector) industry.add(sector);
  }

  b.num(`${at}.age`, age);
  b.cat(`${at}.ageBand`, ages);
  b.cat(`${at}.sex`, sex);
  b.cat(`${at}.race`, race);
  b.cat(`${at}.relationship`, relationship);
  b.cat(`${at}.education`, schooling);
  b.cat(`${at}.employment`, employment);
  b.num(`${at}.income`, income);
  b.cat(`${at}.incomeBand`, incomeBand);
  b.cat(`${at}.occupation`, occupation);
  b.cat(`${at}.industry`, industry);
  b.cat(`${at}.socMajor`, major);
  b.countAndShare(`${at}.withOccupation`, occupation.n, n);
}

/**
 * The crossed distributions, over everybody — household members and quarters
 * residents together, because a change that pushes people between the two is
 * exactly the kind of thing a marginal on one of them would hide.
 */
function crosses(b: Builder, pop: Population): void {
  const sexByAge = new Cat();
  const employmentByAge = new Cat();
  const employmentBySex = new Cat();
  const educationByAge = new Cat();
  const educationByRace = new Cat();
  const educationBySex = new Cat();
  const raceByAge = new Cat();
  const jobBySex = new Cat();
  const jobByRace = new Cat();
  const incomeByEducation = new Cat();
  const incomeBandByAge = new Cat();
  const quartersByAge = new Cat();
  const incomeBySex = new Map<string, Num>();
  const incomeByRace = new Map<string, Num>();
  const incomeByAge = new Map<string, Num>();
  const incomeBySchooling = new Map<string, Num>();
  const incomeByMajor = new Map<string, Num>();
  const ageByMajor = new Map<string, Num>();
  const push = (into: Map<string, Num>, key: string, value: number) => {
    if (!into.has(key)) into.set(key, new Num());
    into.get(key)!.push(value);
  };

  for (let id = 0; id < pop.residents; id += 1) {
    const years = pop.age(id);
    const bandName = ageBand(years);
    const sex = pop.sex(id);
    const race = pop.race(id);
    const status = pop.employment(id);
    const schooling = pop.education(id);
    const money = pop.income(id);
    const major = pop.socMajor(id);

    sexByAge.add(`${bandName} × ${sex}`);
    employmentByAge.add(`${bandName} × ${status}`);
    employmentBySex.add(`${sex} × ${status}`);
    raceByAge.add(`${bandName} × ${race}`);
    incomeBandByAge.add(`${bandName} × ${moneyBand(money)}`);
    quartersByAge.add(`${bandName} × ${pop.isQuarters(id) ? "quarters" : "household"}`);
    if (years >= 25) {
      educationByAge.add(`${bandName} × ${schooling}`);
      educationByRace.add(`${race} × ${schooling}`);
      educationBySex.add(`${sex} × ${schooling}`);
      incomeByEducation.add(`${schooling} × ${moneyBand(money)}`);
      push(incomeBySchooling, schooling, money);
    }
    if (major) {
      jobBySex.add(`${major} × ${sex}`);
      jobByRace.add(`${major} × ${race}`);
      push(incomeByMajor, major, money);
      push(ageByMajor, major, years);
    }
    push(incomeBySex, sex, money);
    push(incomeByRace, race, money);
    push(incomeByAge, bandName, money);
  }

  b.cat("population.cross.ageBand×sex", sexByAge);
  b.cat("population.cross.ageBand×employment", employmentByAge);
  b.cat("population.cross.sex×employment", employmentBySex);
  b.cat("population.cross.ageBand×education", educationByAge);
  b.cat("population.cross.race×education", educationByRace);
  b.cat("population.cross.sex×education", educationBySex);
  b.cat("population.cross.ageBand×race", raceByAge);
  b.cat("population.cross.socMajor×sex", jobBySex);
  b.cat("population.cross.socMajor×race", jobByRace);
  b.cat("population.cross.education×incomeBand", incomeByEducation);
  b.cat("population.cross.ageBand×incomeBand", incomeBandByAge);
  b.cat("population.cross.ageBand×living", quartersByAge);
  for (const [key, sketch] of incomeBySex) b.num(`population.income.by.sex.${key}`, sketch);
  for (const [key, sketch] of incomeByRace) b.num(`population.income.by.race.${key}`, sketch);
  for (const [key, sketch] of [...incomeByAge].sort()) b.num(`population.income.by.ageBand.${key}`, sketch);
  for (const [key, sketch] of incomeBySchooling) b.num(`population.income.by.education.${key}`, sketch);
  for (const [key, sketch] of incomeByMajor) b.num(`population.income.by.socMajor.${key}`, sketch);
  for (const [key, sketch] of ageByMajor) b.num(`population.age.by.socMajor.${key}`, sketch);
}

/**
 * The rules the population is supposed to obey.
 *
 * These are the ones that can be stated over the packed columns alone. Every
 * other file adds its own — a licence issued before its holder was born is
 * checked where the licences are read, not here.
 */
function invariants(b: Builder, pop: Population): void {
  const a = pop.a;
  let impossibleAge = 0;
  let workingChild = 0;
  let earningChild = 0;
  let degreeChild = 0;
  let sentinelIncome = 0;
  let noSex = 0;
  const examples: string[] = [];

  for (let id = 0; id < pop.residents; id += 1) {
    const age = pop.age(id);
    const status = pop.of("employment", id);
    const money = pop.income(id);
    if (age > 115) impossibleAge += 1;
    if (age < 16 && (status === 1 || status === 2 || status === 4 || status === 5)) {
      workingChild += 1;
      if (examples.length < 5) examples.push(`resident ${id}, age ${age}, ${pop.employment(id)}`);
    }
    if (age < 14 && money > 0) earningChild += 1;
    if (age < 18 && pop.of("education", id) >= 21) degreeChild += 1;
    // PINCP's not-in-universe code. It is a real number in a real column and
    // reads as a plausible loss if nothing looks for it.
    if (money === -19999) sentinelIncome += 1;
    if (!(pop.of("sex", id) === 1 || pop.of("sex", id) === 2)) noSex += 1;
  }

  const n = pop.residents;
  b.invariant("population.invariant.age", "nobody is older than 115", impossibleAge, n);
  b.invariant("population.invariant.workingChild", "nobody under 16 is in the labor force", workingChild, n, examples);
  b.invariant("population.invariant.earningChild", "nobody under 14 has earnings", earningChild, n);
  b.invariant("population.invariant.degreeChild", "nobody under 18 holds a bachelor's or above", degreeChild, n);
  b.invariant("population.invariant.pumsSentinelIncome", "no income is the PUMS -19999 not-in-universe code", sentinelIncome, n);
  b.invariant("population.invariant.sex", "every resident has a coded sex", noSex, n);

  const orphaned = pop.householdOf.reduce((count, household) => count + (household < 0 ? 1 : 0), 0);
  b.invariant("population.invariant.orphanedPerson", "every household member belongs to a household", orphaned, pop.counts.persons);

  const buildings = a.household_building as Uint32Array;
  let strayBuilding = 0;
  for (let h = 0; h < buildings.length; h += 1) if (buildings[h] >= pop.counts.buildings) strayBuilding += 1;
  b.invariant("population.invariant.householdBuilding", "every household lives in a building that exists", strayBuilding, pop.counts.households);
}

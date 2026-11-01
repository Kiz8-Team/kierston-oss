/**
 * Every personal-record table, profiled without naming any of them.
 *
 * There are about twenty tables across the six record files and they will keep
 * changing. So nothing here mentions a mortgage or a firearm: a field is
 * profiled according to the kind its packer declared, and the interesting
 * questions — who holds one, how many, which people don't — are answered
 * through the `person` column that every holding table carries.
 *
 * That column is what makes this the richest part of a profile. Joined against
 * the population it turns "26,298 firearms" into the share of men over 55 who
 * own one, the share of households with any, and the mean number per owner,
 * and it does that for guns, cars, credit cards, prescriptions and criminal
 * cases through the same twenty lines. An edit that raises gun ownership
 * overall while quietly moving it a decade younger shows up as the second
 * thing even when the total was left alone.
 *
 * The date fields get one check that has caught things twice: an event dated
 * before the person it belongs to was born. Nothing in the generators asserts
 * it, and a resampled age or a mis-scaled year lands there immediately.
 */

import { Builder, Cat, Num, ageBand, band, moneyBand } from "../metrics.ts";
import type { Population } from "../population.ts";
import { RecordSet, Table, dateMonth, dateYear, type Field } from "../tables.ts";
import { analyseBanking } from "./banking.ts";
import { analyseImmigration } from "./immigration.ts";

/** Fields whose values are identifiers: counted and checked, never tallied. */
const IDENTIFIER = new Set(["str"]);

/** How many distinct values an enum may have and still be crossed against. */
const CROSSABLE = 14;

/** Ordered date pairs, checked wherever a table happens to carry both. */
const ORDER: [string, string][] = [
  ["issued", "expires"], ["first_issued", "issued"], ["filed", "disposed"],
  ["arrest_date", "filed"], ["entered", "separated"], ["originated", "balance_date"],
  ["opened", "closed"], ["recorded", "sold"], ["written", "expires"],
  ["sentence_start", "release_year"],
];

/**
 * PUMS not-in-universe codes, and the only two columns they can appear in.
 *
 * YOEP writes 1937 and CITWP writes 1946 for people the question did not
 * apply to, and both read as perfectly ordinary years. Checked here rather
 * than across every year column, because 1937 is also just a year: a hundred
 * real arrests and marriages happened in it and calling those sentinels would
 * make the check worthless.
 */
const SENTINEL: Record<string, number> = { entry_year: 1937, naturalized_year: 1946 };

/** Fields that are supposed to be in the future. */
const FUTURE_IS_FINE = /expire|release/;

/**
 * Fields dated before the holder was born for good reason. A house built in
 * 1950 and a car of model year 1998 are older than most of their owners; a
 * licence issued before its holder existed is not.
 */
const OLDER_THAN_OWNER = new Set(["year_built", "model_year", "model_released"]);

/**
 * Identifiers that have to be unique. Everything else that looks like one is
 * measured instead: a landline is shared by a household, a docket number by
 * every suspension it produced, and a deed by the couple that signed it.
 */
const UNIQUE = new Set(["vin", "plate", "serial", "taxpayer_id"]);

export function analyseRecords(b: Builder, set: RecordSet, pop: Population | null): void {
  const dataset = set.dataset;
  b.scalar(`records.${dataset}.tables`, set.tables.length);
  for (const table of set.tables) {
    const at = `records.${dataset}.${table.name}`;
    b.scalar(`${at}.rows`, table.rows);
    fields(b, at, table, pop, set.meta.referenceYear ?? new Date().getUTCFullYear());
    if (pop && table.has("person")) coverage(b, at, table, pop);
    ordering(b, at, table);
  }
  // The one part of a record file whose facts live between its tables rather
  // than inside them. It is keyed on what the tables carry, so a file without
  // banking in it pays a map lookup and returns.
  analyseBanking(b, set, pop);
  // And the same for immigration, whose rules join a document to its holder.
  analyseImmigration(b, set);
}

function fields(b: Builder, at: string, table: Table, pop: Population | null, referenceYear: number): void {
  const crossable: Field[] = [];
  const numeric: Field[] = [];

  for (const field of table.fields) {
    const path = `${at}.${field.name}`;
    switch (field.kind) {
      case "enum": {
        const cat = new Cat();
        let nulls = 0;
        for (let row = 0; row < table.rows; row += 1) {
          const label = table.label(field, row);
          if (label === null) nulls += 1; else cat.add(label);
        }
        b.cat(path, cat);
        b.countAndShare(`${path}.missing`, nulls, table.rows);
        if (cat.size >= 2 && cat.size <= CROSSABLE) crossable.push(field);
        break;
      }
      case "bool": {
        const cat = new Cat();
        for (let row = 0; row < table.rows; row += 1) cat.add(table.label(field, row) ?? "«null»");
        b.cat(path, cat);
        if (cat.size >= 2 && cat.size <= CROSSABLE) crossable.push(field);
        break;
      }
      case "list": {
        const cat = new Cat();
        const length = new Num();
        for (let row = 0; row < table.rows; row += 1) {
          const values = table.value(field, row) as string[];
          length.push(values.length);
          for (const value of values) cat.add(value);
        }
        b.cat(path, cat);
        b.num(`${path}.count`, length);
        break;
      }
      case "date": case "year": {
        const years = new Num();
        const byYear = new Cat();
        const byMonth = new Cat();
        let nulls = 0;
        let future = 0;
        let ancient = 0;
        let sentinel = 0;
        let beforeBirth = 0;
        const examples: string[] = [];
        const person = table.field("person");
        for (let row = 0; row < table.rows; row += 1) {
          const raw = field.column[row];
          const year = field.kind === "date" ? dateYear(raw) : (raw || null);
          if (year === null) { nulls += 1; continue; }
          years.push(year);
          byYear.add(String(year));
          if (field.kind === "date") {
            const month = dateMonth(raw);
            if (month) byMonth.add(String(month).padStart(2, "0"));
          }
          if (year > referenceYear + 1) future += 1;
          if (year < 1900) ancient += 1;
          if (SENTINEL[field.name] === year) sentinel += 1;
          if (pop && person && !OLDER_THAN_OWNER.has(field.name)) {
            const id = person.column[row];
            // An age at the reference date leaves two possible birth years:
            // someone 45 whose birthday has not come round yet was born the
            // year before `referenceYear - 45`. Only the earlier one is a bound.
            if (id < pop.residents && year < referenceYear - pop.age(id) - 1) {
              beforeBirth += 1;
              if (examples.length < 5) examples.push(`row ${row}, resident ${id} aged ${pop.age(id)}, ${field.name} ${year}`);
            }
          }
        }
        b.num(path, years);
        b.cat(`${path}.year`, byYear);
        if (byMonth.n) b.cat(`${path}.month`, byMonth);
        b.countAndShare(`${path}.missing`, nulls, table.rows);
        if (FUTURE_IS_FINE.test(field.name)) b.countAndShare(`${path}.future`, future, table.rows);
        else b.invariant(`${path}.future`, `${field.name} is not in the future`, future, table.rows);
        b.invariant(`${path}.ancient`, `${field.name} is not before 1900`, ancient, table.rows);
        if (field.name in SENTINEL) {
          b.invariant(`${path}.pumsSentinel`, `${field.name} is not the PUMS ${SENTINEL[field.name]} not-in-universe code`, sentinel, table.rows);
        }
        if (pop && person && !OLDER_THAN_OWNER.has(field.name)) {
          b.invariant(`${path}.beforeBirth`, `${field.name} is not before the holder was born`, beforeBirth, table.rows, examples);
        }
        numeric.push(field);
        break;
      }
      case "int": case "rate": case "money": case "u8": case "u16": {
        const values = new Num();
        for (let row = 0; row < table.rows; row += 1) values.push(table.number(field, row));
        b.num(path, values);
        // Amounts get bands as well as quantiles. A median that holds still
        // while the top band doubles is a tail that moved, and the quantile
        // sketch alone reports that as a rounding change at q95.
        if (field.kind === "int" || field.kind === "money") {
          const bands = new Cat();
          for (let row = 0; row < table.rows; row += 1) {
            const value = table.number(field, row);
            if (value !== null) bands.add(moneyBand(value));
          }
          b.cat(`${path}.band`, bands);
        }
        numeric.push(field);
        break;
      }
      case "id": {
        let nulls = 0;
        let stray = 0;
        for (let row = 0; row < table.rows; row += 1) {
          const value = table.value(field, row);
          if (value === null) nulls += 1;
          else if (pop && field.name === "person" && (value as number) >= pop.residents) stray += 1;
        }
        b.countAndShare(`${path}.missing`, nulls, table.rows);
        if (pop && field.name === "person") {
          b.invariant(`${path}.stray`, "every row belongs to a resident who exists", stray, table.rows);
        }
        break;
      }
      default: {
        if (!IDENTIFIER.has(field.kind)) break;
        // An identifier is not a category. What matters is whether it is
        // unique and whether it is ever missing — a plate reused across two
        // vehicles is a bug, and a tally of 63,000 plates is noise.
        const seen = new Set<string>();
        let nulls = 0;
        let duplicates = 0;
        const examples: string[] = [];
        for (let row = 0; row < table.rows; row += 1) {
          const value = table.label(field, row);
          if (value === null) { nulls += 1; continue; }
          if (seen.has(value)) {
            duplicates += 1;
            if (examples.length < 5) examples.push(`${field.name} ${value} at row ${row}`);
          } else seen.add(value);
        }
        b.scalar(`${path}.distinct`, seen.size);
        b.countAndShare(`${path}.missing`, nulls, table.rows);
        if (UNIQUE.has(field.name)) {
          b.invariant(`${path}.duplicate`, `${field.name} is unique`, duplicates, table.rows, examples);
        } else {
          // Shared on purpose, but how much it is shared is still a number
          // worth holding still: a phone book that suddenly stops repeating is
          // a household model that stopped putting families on one line.
          b.countAndShare(`${path}.duplicate`, duplicates, table.rows);
        }
        break;
      }
    }
  }

  cross(b, at, table, crossable, numeric);
}

/**
 * Each numeric field's mean within each of the table's own small enums.
 *
 * A mean rather than a distribution, because this is a wide sweep — every
 * money column against every grade, insurer and status the table carries — and
 * a full quantile set for each would be more profile than analysis. The
 * distributions are recorded on the marginals; this is here to catch a shift
 * that only happens inside one category.
 */
function cross(b: Builder, at: string, table: Table, enums: Field[], numeric: Field[]): void {
  for (const key of enums.slice(0, 4)) {
    for (const value of numeric.slice(0, 6)) {
      const groups = new Map<string, { sum: number; n: number }>();
      for (let row = 0; row < table.rows; row += 1) {
        const number = table.number(value, row);
        if (number === null) continue;
        const label = table.label(key, row) ?? "«null»";
        const group = groups.get(label) ?? { sum: 0, n: 0 };
        group.sum += number;
        group.n += 1;
        groups.set(label, group);
      }
      for (const [label, group] of groups) {
        if (group.n < 20) continue;
        b.scalar(`${at}.${value.name}.by.${key.name}.${label}.mean`, group.sum / group.n, "rate");
      }
    }
  }
}

/**
 * Who holds these, as shares of the groups they were drawn from.
 *
 * The share is the invariant, not the count: regenerate the city at half the
 * size and every count here halves while every share should not move. So the
 * rate per person and the rate per household are recorded for every table, and
 * then the same rate within each demographic band — which is where a change in
 * a propensity actually shows up.
 */
function coverage(b: Builder, at: string, table: Table, pop: Population): void {
  const person = table.field("person")!;
  const held = new Int32Array(pop.residents);
  let stray = 0;
  for (let row = 0; row < table.rows; row += 1) {
    const id = person.column[row];
    if (id < pop.residents) held[id] += 1; else stray += 1;
  }

  let holders = 0;
  const perHolder = new Num();
  const perResident = new Num();
  const byAge = new Map<string, [number, number]>();
  const bySex = new Map<string, [number, number]>();
  const byRace = new Map<string, [number, number]>();
  const byEmployment = new Map<string, [number, number]>();
  const byIncome = new Map<string, [number, number]>();
  const byEducation = new Map<string, [number, number]>();
  const bySexAge = new Map<string, [number, number]>();
  const tally = (into: Map<string, [number, number]>, key: string, holding: boolean) => {
    const cell = into.get(key) ?? [0, 0];
    cell[0] += holding ? 1 : 0;
    cell[1] += 1;
    into.set(key, cell);
  };

  for (let id = 0; id < pop.residents; id += 1) {
    const count = held[id];
    const holding = count > 0;
    if (holding) { holders += 1; perHolder.push(count); }
    perResident.push(count);
    const years = pop.age(id);
    const bandName = ageBand(years);
    tally(byAge, bandName, holding);
    tally(bySex, pop.sex(id), holding);
    tally(byRace, pop.race(id), holding);
    tally(byEmployment, pop.employment(id), holding);
    tally(byIncome, moneyBand(pop.income(id)), holding);
    if (years >= 25) tally(byEducation, pop.education(id), holding);
    tally(bySexAge, `${bandName} × ${pop.sex(id)}`, holding);
  }

  b.countAndShare(`${at}.holders`, holders, pop.residents);
  b.num(`${at}.perHolder`, perHolder);
  b.num(`${at}.perResident`, perResident);
  b.scalar(`${at}.rowsPerResident`, table.rows / pop.residents, "rate");
  b.invariant(`${at}.strayHolder`, "every row belongs to a resident who exists", stray, table.rows);

  const dimensions: [string, Map<string, [number, number]>][] = [
    ["ageBand", byAge], ["sex", bySex], ["race", byRace],
    ["employment", byEmployment], ["incomeBand", byIncome],
    ["education", byEducation], ["ageBand×sex", bySexAge],
  ];
  for (const [name, groups] of dimensions) {
    for (const [label, [holding, total]] of [...groups].sort()) {
      if (total < 50) continue;
      b.scalar(`${at}.holders.by.${name}.${label}`, holding / total, "share");
    }
  }

  // The household view, which is the one a question like "how many families
  // have a car" is actually asking. Group-quarters residents have no
  // household and are left out of it rather than counted as a household of
  // one, which would drag every share down by their five thousand.
  const perHousehold = new Num();
  const counts = new Int32Array(pop.counts.households);
  for (let id = 0; id < pop.counts.persons; id += 1) {
    const household = pop.householdOf[id];
    if (household >= 0) counts[household] += held[id];
  }
  let households = 0;
  const bySize = new Map<string, [number, number]>();
  const byIncomeBand = new Map<string, [number, number]>();
  for (let h = 0; h < counts.length; h += 1) {
    perHousehold.push(counts[h]);
    if (counts[h] > 0) households += 1;
    const size = (pop.a.household_size as Uint8Array)[h];
    tally(bySize, band(size, [1, 2, 3, 4, 5, 7]), counts[h] > 0);
    tally(byIncomeBand, moneyBand((pop.a.household_income as Int32Array)[h]), counts[h] > 0);
  }
  b.num(`${at}.perHousehold`, perHousehold);
  b.countAndShare(`${at}.households`, households, pop.counts.households);
  for (const [label, [holding, total]] of [...bySize].sort()) {
    if (total >= 50) b.scalar(`${at}.households.by.size.${label}`, holding / total, "share");
  }
  for (const [label, [holding, total]] of [...byIncomeBand].sort()) {
    if (total >= 50) b.scalar(`${at}.households.by.income.${label}`, holding / total, "share");
  }
}

/** Dates that have to come in an order, wherever a table carries both ends. */
function ordering(b: Builder, at: string, table: Table): void {
  for (const [first, second] of ORDER) {
    const early = table.field(first);
    const late = table.field(second);
    if (!early || !late) continue;
    const scale = (field: Field, row: number) => {
      const raw = field.column[row];
      if (!raw) return null;
      return field.kind === "date" ? raw : raw * 10000;
    };
    let wrong = 0;
    let checked = 0;
    const examples: string[] = [];
    for (let row = 0; row < table.rows; row += 1) {
      const a = scale(early, row);
      const z = scale(late, row);
      if (a === null || z === null) continue;
      checked += 1;
      if (z < a) {
        wrong += 1;
        if (examples.length < 5) examples.push(`row ${row}: ${first} ${a}, ${second} ${z}`);
      }
    }
    if (checked) {
      b.invariant(`${at}.order.${first}→${second}`, `${second} is not before ${first}`, wrong, checked, examples);
    }
  }

  // Loans, wherever they turn up. A balance above the principal means interest
  // was capitalised into it or the draw was written twice; either way it is
  // worth one line rather than a per-table rule.
  const principal = table.field("principal");
  const balance = table.field("balance");
  if (principal && balance) {
    let over = 0;
    let checked = 0;
    for (let row = 0; row < table.rows; row += 1) {
      const owed = table.number(balance, row);
      const borrowed = table.number(principal, row);
      if (owed === null || borrowed === null) continue;
      checked += 1;
      if (owed > borrowed) over += 1;
    }
    b.invariant(`${at}.order.balance≤principal`, "a balance never exceeds the principal", over, checked);
  }

  const limit = table.field("limit");
  if (limit && balance) {
    let over = 0;
    let checked = 0;
    const utilisation = new Num();
    for (let row = 0; row < table.rows; row += 1) {
      const owed = table.number(balance, row);
      const ceiling = table.number(limit, row);
      if (owed === null || ceiling === null || ceiling <= 0) continue;
      checked += 1;
      utilisation.push(owed / ceiling);
      if (owed > ceiling) over += 1;
    }
    b.num(`${at}.utilisation`, utilisation);
    b.invariant(`${at}.order.balance≤limit`, "a balance never exceeds the credit limit", over, checked);
  }
}

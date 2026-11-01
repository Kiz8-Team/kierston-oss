import { products } from "../../../kierston/sim/src/index.ts";

/** Replace CSR person slices, rebasing references but preserving other values. */
export async function replacePeople(
  file: products.KdayFile, replacements: ReadonlyMap<number, products.DayColumns>,
): Promise<Int32Array> {
  const ids = await file.column("person.id");
  const person = await file.table("person");
  const leg = await file.table("leg");
  const path = await file.table("path");
  const tables = ["person", "schedule", "leg", "path", "tx", "span", "event", "attention"] as const;
  const oldRanges = new Map<string, { start: number; count: number }[]>();
  const newRanges = new Map<string, { start: number; count: number }[]>();
  for (const table of tables) {
    let offset = 0;
    const old = Array.from(ids, (_, row) => {
      if (table === "person") return { start: row, count: 1 };
      if (table === "path") {
        const startLeg = person.legOffset![row]!;
        const count = person.legCount![row]!;
        const start = count ? leg.pathOffset![startLeg]! : 0;
        const last = startLeg + count - 1;
        return { start, count: count ? leg.pathOffset![last]! + leg.pathCount![last]! - start : 0 };
      }
      return { start: person[`${table}Offset`]![row]!, count: person[`${table}Count`]![row]! };
    });
    oldRanges.set(table, old);
    newRanges.set(table, Array.from(ids, (id, row) => {
      const replacement = replacements.get(id);
      const count = replacement ? products.rowsIn(replacement)[table] : old[row]!.count;
      const range = { start: offset, count }; offset += count; return range;
    }));
  }
  const moved = new Int32Array(leg.depart!.length).fill(-1);
  for (let row = 0; row < ids.length; row++) {
    const old = oldRanges.get("leg")![row]!;
    const next = newRanges.get("leg")![row]!;
    const replacement = replacements.get(ids[row]!);
    if (!replacement) {
      for (let i = 0; i < old.count; i++) moved[old.start + i] = next.start + i;
    } else {
      const byJourney = new Map(replacement.legJourney.map((journey, index) =>
        [`${journey}/${replacement.legDepart[index]}/${replacement.legArrive[index]}`, index]));
      for (let i = old.start; i < old.start + old.count; i++) {
        const index = byJourney.get(`${leg.journey![i]}/${leg.depart![i]}/${leg.arrive![i]}`);
        if (index !== undefined && replacement.legDepart[index] === leg.depart![i]
            && replacement.legArrive[index] === leg.arrive![i] && replacement.legMode[index] === leg.mode![i]
            && replacement.legPurpose[index] === leg.purpose![i] && replacement.legPathCount[index] === leg.pathCount![i]) {
          const from = leg.pathOffset![i]!, to = replacement.legPathOffset[index]!;
          let same = true;
          for (let point = 0; point < leg.pathCount![i]!; point++) {
            if (path.latE6![from + point] !== replacement.pathLat[to + point]
                || path.lonE6![from + point] !== replacement.pathLon[to + point]) { same = false; break; }
          }
          if (same) moved[i] = next.start + index;
        }
      }
    }
  }
  for (const spec of products.PERSON_COLUMNS) {
    if (!file.has(spec.name)) throw new Error(`replay requires ${spec.name}; regenerate the base KDAY`);
    const old = await file.column(spec.name);
    const ranges = newRanges.get(spec.of)!;
    const last = ranges.at(-1);
    const values = new products.ARRAYS[spec.type](last ? last.start + last.count : 0);
    for (let row = 0; row < ids.length; row++) {
      const replacement = replacements.get(ids[row]!);
      const range = oldRanges.get(spec.of)![row]!;
      const target = ranges[row]!;
      values.set(replacement ? replacement[spec.field] : old.subarray(range.start, range.start + range.count), target.start);
      if (spec.rebase) {
        const before = replacement ? 0 : oldRanges.get(spec.rebase)![row]!.start;
        const after = newRanges.get(spec.rebase)![row]!.start;
        for (let i = target.start; i < target.start + target.count; i++) values[i] += after - before;
      }
    }
    file.set(spec.name, values);
  }
  const names = { schedule: "schedules", leg: "legs", path: "pathPoints", tx: "transactions", span: "spans", event: "events", attention: "attentionRuns" };
  for (const [table, name] of Object.entries(names)) {
    const last = newRanges.get(table)!.at(-1);
    file.header.counts[name] = last ? last.start + last.count : 0;
  }
  return moved;
}

export async function appendRows(file: products.KdayFile, table: string, rows: readonly Record<string, number>[]): Promise<number> {
  const columns = await file.table(table);
  const offset = Object.values(columns)[0]?.length ?? 0;
  for (const [field, old] of Object.entries(columns)) {
    const values = new (old.constructor as typeof Uint32Array)(old.length + rows.length);
    values.set(old);
    rows.forEach((row, index) => {
      if (row[field] === undefined) throw new Error(`missing ${table}.${field} in appended row`);
      values[offset + index] = row[field]!;
    });
    file.set(`${table}.${field}`, values);
  }
  return offset;
}

export async function personColumns(file: products.KdayFile, row: number): Promise<products.DayColumns> {
  const p = await file.table("person"), legs = await file.table("leg");
  const startLeg = p.legOffset![row]!, legCount = p.legCount![row]!;
  const pathStart = legCount ? legs.pathOffset![startLeg]! : 0;
  const pathEnd = legCount ? legs.pathOffset![startLeg + legCount - 1]! + legs.pathCount![startLeg + legCount - 1]! : 0;
  const ranges: Record<string, [number, number]> = { person: [row, 1], path: [pathStart, pathEnd - pathStart] };
  for (const table of ["schedule", "leg", "tx", "span", "event", "attention"]) ranges[table] = [p[`${table}Offset`]![row]!, p[`${table}Count`]![row]!];
  const out = products.emptyColumns();
  for (const spec of products.PERSON_COLUMNS) {
    const [start, count] = ranges[spec.of]!;
    const values = await file.column(spec.name);
    const shift = spec.rebase ? ranges[spec.rebase]![0] : 0;
    out[spec.field] = Array.from(values.subarray(start, start + count), (value) => value - shift);
  }
  return out;
}

export function keepUnchangedTables(
  base: products.DayColumns, generated: products.DayColumns, changed: ReadonlySet<string>,
): products.DayColumns {
  for (const spec of products.PERSON_COLUMNS) {
    const owner = spec.of === "person" ? spec.name.replace(/^person\./, "").replace(/(?:Offset|Count)$/, "") : spec.of;
    if (changed.has(owner)) base[spec.field] = generated[spec.field];
  }
  return base;
}

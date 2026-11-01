import { ADI } from "../../model_visible_text";
import type { Column, FilterOperator, FilterType, FilterValue, Match, NearFilter, QueryDef, QueryRequest } from "./catalog-types";
import { filtersForQuery } from "./catalog";
import { calendarDate, normalize } from "./normalize";
import { clockColumn } from "./policy";
import { resolve, subjectFor, type Subject } from "./resolve";
import { CITY_TIME_ZONE, clickhouse, postgres, STATIC_SCHEMA } from "./stores";

export type QueryErrorCode = "INVALID_FILTER" | "UNSUPPORTED_OPERATOR" | "INVALID_VALUE" | "BATCH_TOO_LARGE"
  | "WINDOW_REQUIRED" | "WINDOW_TOO_LARGE" | "RADIUS_TOO_LARGE" | "INVALID_SELECT";
export class QueryRejected extends Error {
  constructor(readonly code: QueryErrorCode, message: string) { super(message); }
}
export interface Execution {
  columns: readonly Column[];
  rows: Record<string, unknown>[];
  count: number;
  subject: Subject | null;
}
interface PreparedFilter extends FilterValue { type: FilterType; columns: readonly string[]; match?: Match }
interface Predicate { sql: string }
const MAX_RADIUS = 10_000;
const DAY_MS = 86_400_000;

function pgId(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid internal column");
  return `"${name}"`;
}
function chId(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid internal column");
  return `\`${name}\``;
}
function selectedColumns(query: QueryDef, requested?: string[]): Column[] {
  if (!requested?.length) return [...query.select];
  const names = [...new Set(requested)];
  const available = new Map(query.select.map((column) => [column.name, column]));
  const invalid = names.filter((name) => !available.has(name));
  if (invalid.length) throw new QueryRejected("INVALID_SELECT", ADI.notSelectable(invalid));
  return names.map((name) => available.get(name)!);
}
function typed(value: string, type: FilterType): string | number | boolean {
  if (type === "datetime") {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
      throw new QueryRejected("INVALID_VALUE", ADI.badTimestamp(value));
    return new Date(value).toISOString();
  }
  if (type === "date") {
    const date = calendarDate(value);
    if (!date) throw new QueryRejected("INVALID_VALUE", ADI.badDate(value));
    return date;
  }
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new QueryRejected("INVALID_VALUE", ADI.badNumber(value));
    return number;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new QueryRejected("INVALID_VALUE", ADI.badBoolean(value));
  }
  return value;
}
function prepare(query: QueryDef, request: QueryRequest): PreparedFilter[] {
  const allowed = new Map(filtersForQuery(query).map((filter) => [filter.name, filter]));
  const matches = new Map(query.match.map((match) => [match.field, match]));
  const fields = new Map(query.fields.map((field) => [field.name, field]));
  const seen = new Set<string>();
  return request.filters.map((filter) => {
    const definition = allowed.get(filter.field);
    if (!definition) throw new QueryRejected("INVALID_FILTER", ADI.noSuchFilter(query.id, filter.field));
    if (!definition.operators.includes(filter.operator))
      throw new QueryRejected("UNSUPPORTED_OPERATOR", ADI.noSuchOperator(filter.field, filter.operator));
    const key = `${filter.field}.${filter.operator}`;
    if (seen.has(key)) throw new QueryRejected("INVALID_FILTER", ADI.duplicateFilter(key));
    seen.add(key);
    if (!filter.values.length) throw new QueryRejected("INVALID_VALUE", ADI.filterNeedsValue(filter.field));
    if (filter.values.length > definition.maxValues)
      throw new QueryRejected("BATCH_TOO_LARGE", ADI.batchTooLarge(filter.field, definition.maxValues));
    if (filter.operator !== "eq" && filter.values.length !== 1)
      throw new QueryRejected("INVALID_FILTER", ADI.batchNeedsEquality);
    if (filter.operator === "between" && filter.values[0]!.split("..").length !== 2)
      throw new QueryRejected("INVALID_VALUE", ADI.betweenShape(filter.field));
    const field = fields.get(filter.field);
    const values = [...new Set(filter.values.map((value) => normalize(value, field?.normalize)))];
    const match = matches.get(filter.field);
    return { ...filter, values, type: definition.type, columns: match?.columns ?? [filter.field], match };
  });
}
function validateNear(query: QueryDef, near?: NearFilter): void {
  if (!near) return;
  if (!query.spatial) throw new QueryRejected("INVALID_FILTER", ADI.noSpatial(query.id));
  if (!Number.isFinite(near.latitude) || near.latitude < -90 || near.latitude > 90
      || !Number.isFinite(near.longitude) || near.longitude < -180 || near.longitude > 180
      || !Number.isFinite(near.radiusMetres) || near.radiusMetres <= 0)
    throw new QueryRejected("INVALID_VALUE", ADI.badNear);
  if (near.radiusMetres > MAX_RADIUS)
    throw new QueryRejected("RADIUS_TOO_LARGE", ADI.radiusTooLarge(MAX_RADIUS));
}
function validateBreadth(query: QueryDef, filters: PreparedFilter[], near?: NearFilter): void {
  const present = new Set(filters.map((filter) => filter.field));
  const time = query.select.find((column) => column.format === "datetime")?.name;
  const day = filters.find((filter) => filter.field === "date" && filter.operator === "eq");
  const lower = filters.find((filter) => filter.field === time && ["gte", "gt"].includes(filter.operator));
  const upper = filters.find((filter) => filter.field === time && ["lte", "lt"].includes(filter.operator));
  if (query.kind === "history" && query.fields.some((field) => field.name === "date") && !day && (!lower || !upper))
    throw new QueryRejected("WINDOW_REQUIRED", ADI.windowRequired(time));
  if (!!lower !== !!upper) throw new QueryRejected("WINDOW_REQUIRED", ADI.windowNeedsBothBounds);
  if (lower && upper) {
    const start = Date.parse(String(typed(lower.values[0]!, "datetime")));
    const end = Date.parse(String(typed(upper.values[0]!, "datetime")));
    if (end <= start) throw new QueryRejected("INVALID_VALUE", ADI.windowBackwards);
    const cohort = !!near || present.has("cell") || present.has("camera");
    const days = cohort ? 1 : 31;
    if (end - start > days * DAY_MS)
      throw new QueryRejected("WINDOW_TOO_LARGE", ADI.windowTooLarge(days));
  }
  const required = query.requires.some((group) => group.some((name) => present.has(name)));
  if (!required && !near && !day && !(lower && upper))
    throw new QueryRejected("INVALID_FILTER", ADI.needsOneOf(query.requires.flat()));
}
async function expanded(filter: PreparedFilter): Promise<(string | number | boolean)[]> {
  if (filter.match?.op !== "in") return filter.values.map((value) => typed(value, filter.type));
  const keys = new Set<string>();
  for (const value of filter.values) for (const key of await resolve(filter.match.via!, value)) keys.add(key);
  return [...keys];
}
function pgCast(type: FilterType): string {
  return type === "number" ? "::numeric" : type === "boolean" ? "::boolean"
    : type === "date" ? "::date" : type === "datetime" ? "::timestamptz" : "::text";
}
function pgFilterCast(filter: PreparedFilter): string {
  if (filter.match?.cast?.startsWith("bigint")) return "::bigint";
  return pgCast(filter.type);
}
async function pgPredicates(filters: PreparedFilter[], params: unknown[]): Promise<Predicate[]> {
  const out: Predicate[] = [];
  for (const filter of filters) {
    const columns = filter.columns.map(pgId);
    if (filter.operator === "is_null") {
      const absent = typed(filter.values[0]!, "boolean");
      out.push({ sql: `(${columns.map((column) => `${column} IS ${absent ? "NULL" : "NOT NULL"}`).join(" OR ")})` });
      continue;
    }
    const raw = filter.operator === "between" ? filter.values[0]!.split("..") : filter.values;
    const values = filter.operator === "eq" ? await expanded({ ...filter, values: raw }) : raw.map((value) => typed(value, filter.type));
    if (!values.length) { out.push({ sql: "FALSE" }); continue; }
    const bound = values.map((value) => { params.push(value); return `$${params.length}${pgFilterCast(filter)}`; });
    const comparison = (column: string) => {
      if (filter.operator === "contains") return `${column}::text ILIKE '%' || ${bound[0]} || '%'`;
      if (filter.operator === "between") return `${column} BETWEEN ${bound[0]} AND ${bound[1]}`;
      if (filter.operator === "eq" && filter.match?.op === "name")
        return `(${bound.map((value) => `upper(${column}::text) = upper(${value}::text)`).join(" OR ")})`;
      const op = ({ eq: "=", gte: ">=", gt: ">", lte: "<=", lt: "<" } as const)[filter.operator as "eq" | "gte" | "gt" | "lte" | "lt"];
      return bound.length === 1 ? `${column} ${op} ${bound[0]}` : `${column} = ANY(ARRAY[${bound.join(",")}])`;
    };
    out.push({ sql: `(${columns.map(comparison).join(" OR ")})` });
  }
  return out;
}
function chType(type: FilterType): string {
  return type === "number" ? "Float64" : type === "boolean" ? "Bool"
    : type === "date" ? "Date" : type === "datetime" ? "DateTime64(3, 'UTC')" : "String";
}
function chValue(value: string | number | boolean, type: FilterType): string | number | boolean {
  return type === "datetime" ? String(value).replace("T", " ").replace(/Z$/, "") : value;
}
async function chPredicates(filters: PreparedFilter[], params: Record<string, unknown>): Promise<Predicate[]> {
  const out: Predicate[] = [];
  let index = 0;
  const bind = (value: unknown, type: string) => { const name = `p${index++}`; params[name] = value; return `{${name}:${type}}`; };
  for (const filter of filters) {
    const columns = filter.columns.map((column) => `_source.${chId(column)}`);
    if (filter.match?.op === "day") {
      const value = bind(typed(filter.values[0]!, "date"), "String");
      out.push({ sql: `(${columns.map((column) => `toDate(${column}, {tz:String}) = toDate(${value})`).join(" OR ")})` });
      continue;
    }
    if (filter.operator === "is_null") {
      const absent = typed(filter.values[0]!, "boolean");
      out.push({ sql: `(${columns.map((column) => `${absent ? "isNull" : "isNotNull"}(${column})`).join(" OR ")})` });
      continue;
    }
    const raw = filter.operator === "between" ? filter.values[0]!.split("..") : filter.values;
    const values = filter.operator === "eq" ? await expanded({ ...filter, values: raw }) : raw.map((value) => typed(value, filter.type));
    if (!values.length) { out.push({ sql: "0" }); continue; }
    const bound = values.map((value) => bind(chValue(value, filter.type), chType(filter.type)));
    const comparison = (column: string) => {
      if (filter.operator === "contains") return `positionCaseInsensitive(toString(${column}), ${bound[0]}) > 0`;
      if (filter.operator === "between") return `${column} BETWEEN ${bound[0]} AND ${bound[1]}`;
      if (filter.operator === "eq" && filter.match?.op === "name")
        return `(${bound.map((value) => `upper(toString(${column})) = upper(toString(${value}))`).join(" OR ")})`;
      const op = ({ eq: "=", gte: ">=", gt: ">", lte: "<=", lt: "<" } as const)[filter.operator as "eq" | "gte" | "gt" | "lte" | "lt"];
      return bound.length === 1 ? `${column} ${op} ${bound[0]}` : `${column} IN (${bound.join(",")})`;
    };
    out.push({ sql: `(${columns.map(comparison).join(" OR ")})` });
  }
  return out;
}
/**
 * A task's cutoff as the row source: the table with nothing on its clock
 * column after that instant, and with the catalog's per-table masks applied
 * to columns that would otherwise carry facts from after it. Filters,
 * selections and ordering all read this source, so a masked column is masked
 * everywhere. Rows are what the store holds, so this is the only place a
 * "now" exists for the agent.
 */
export function cutoffSource(query: QueryDef, params: Record<string, unknown>): string | null {
  if (query.cutoff === undefined) return null;
  const column = clockColumn(query);
  if (!column) throw new Error(`${query.id} has a cutoff but no clock column`);
  params.cutoff = chValue(new Date(query.cutoff).toISOString(), "datetime");
  const instant = `{cutoff:${chType("datetime")}}`;
  const where = `WHERE ${chId(column)} <= ${instant}`;
  const mask = query.cutoffRule?.mask ?? [];
  if (!mask.length) return `(SELECT * FROM ${chId(query.table)} ${where})`;
  // ClickHouse aliases are visible across a whole SELECT, so a mask that read
  // a column another mask replaces would see the replacement. Stored values
  // are copied under STORED_PREFIX one level down and masks read only those.
  const stored = new Set<string>();
  const masks = mask.map(({ column: name, expr }) => {
    const sql = expr.replaceAll("{cutoff}", instant).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, source: string) => {
      stored.add(source);
      return chId(STORED_PREFIX + source);
    });
    return `${sql} AS ${chId(name)}`;
  });
  const copies = [...stored].map((name) => `${chId(name)} AS ${chId(STORED_PREFIX + name)}`);
  const inner = `(SELECT *${copies.length ? `, ${copies.join(", ")}` : ""} FROM ${chId(query.table)} ${where})`;
  return `(SELECT * REPLACE (${masks.join(", ")}) FROM ${inner})`;
}
const STORED_PREFIX = "kdi_stored_";
function distanceSql(latColumn: string, lonColumn: string, bind: (value: number) => string, near: NearFilter): string {
  const lat = bind(near.latitude), lon = bind(near.longitude), radius = bind(near.radiusMetres);
  return `(6371000 * 2 * asin(sqrt(power(sin(radians((${latColumn}) - ${lat}) / 2), 2)
    + cos(radians(${lat})) * cos(radians(${latColumn})) * power(sin(radians((${lonColumn}) - ${lon}) / 2), 2)))) <= ${radius}`;
}
async function nearby(kind: "camera" | "cell", near: NearFilter): Promise<string[]> {
  const table = kind === "camera" ? "alpr_cameras" : "carrier_cell_sites";
  const column = kind === "camera" ? "camera_id" : "cgi";
  const params: unknown[] = [];
  const bind = (value: number) => { params.push(value); return `$${params.length}::double precision`; };
  const result = await postgres().query(`SELECT ${pgId(column)} FROM "${STATIC_SCHEMA}".${pgId(table)}
    WHERE ${distanceSql("latitude", "longitude", bind, near)}`, params);
  return result.rows.map((row) => String(row[column]));
}
function identityInputs(filters: PreparedFilter[]): Map<string, string> {
  return new Map(filters.filter((filter) => filter.operator === "eq" && filter.values.length === 1)
    .map((filter) => [filter.field, filter.values[0]!]));
}
async function subject(query: QueryDef, values: Map<string, string>): Promise<Subject | null> {
  for (const candidate of query.subjects ?? []) {
    const value = values.get(candidate.field);
    if (!value) continue;
    try { const found = await subjectFor(candidate.via, value); if (found) return found; } catch { /* decoration is optional */ }
  }
  return null;
}
function selection(columns: readonly Column[], quote: (name: string) => string): string {
  return columns.map((column) => column.expr ? `${column.expr} AS ${quote(column.name)}` : quote(column.name)).join(", ");
}

export async function execute(query: QueryDef, request: QueryRequest): Promise<Execution> {
  validateNear(query, request.near);
  const filters = prepare(query, request);
  validateBreadth(query, filters, request.near);
  const columns = selectedColumns(query, request.select);
  if (query.store === "postgres") {
    const params: unknown[] = [];
    const predicates = await pgPredicates(filters, params);
    if (request.near) {
      const bind = (value: number) => { params.push(value); return `$${params.length}::double precision`; };
      predicates.push({ sql: distanceSql("latitude", "longitude", bind, request.near) });
    }
    const where = predicates.length ? predicates.map((predicate) => `(${predicate.sql})`).join(" AND ") : "TRUE";
    const result = await postgres().query(`SELECT ${selection(columns, pgId)} FROM "${STATIC_SCHEMA}".${pgId(query.table)}
      WHERE ${where} ${query.order ? `ORDER BY ${query.order}` : ""}`, params);
    return { columns, rows: result.rows, count: result.rows.length,
      subject: await subject(query, identityInputs(filters)) };
  }
  const params: Record<string, unknown> = { tz: CITY_TIME_ZONE };
  const predicates = await chPredicates(filters, params);
  if (request.near && query.spatial === "coordinates") {
    let index = 0;
    const bind = (value: number) => { const name = `n${index++}`; params[name] = value; return `{${name}:Float64}`; };
    predicates.push({ sql: distanceSql("merchant_latitude", "merchant_longitude", bind, request.near) });
  } else if (request.near && (query.spatial === "camera" || query.spatial === "cell")) {
    const ids = await nearby(query.spatial, request.near);
    if (!ids.length) predicates.push({ sql: "0" });
    else {
      params.nearby_ids = ids;
      predicates.push({ sql: `_source.${chId(query.spatial === "camera" ? "camera_id" : "cell_cgi")} IN ({nearby_ids:Array(String)})` });
    }
  }
  const where = predicates.length ? predicates.map((predicate) => `(${predicate.sql})`).join(" AND ") : "1";
  const response = await clickhouse().query({ query: `SELECT ${selection(columns, chId)} FROM ${cutoffSource(query, params) ?? chId(query.table)} AS _source
    WHERE ${where} ${query.order ? `ORDER BY ${query.order}` : ""}`, query_params: params, format: "JSONEachRow" });
  const rows = await response.json<Record<string, unknown>>();
  return { columns, rows, count: rows.length, subject: await subject(query, identityInputs(filters)) };
}

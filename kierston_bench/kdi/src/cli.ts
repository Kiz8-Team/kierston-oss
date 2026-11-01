#!/usr/bin/env bun

import Table from "cli-table3";
import type { FilterOperator, FilterValue, NearFilter, QueryRequest } from "./catalog-types";
import { QueryRejected } from "./execute";
import { formatCell } from "./format";
import { catalog, health, heldDays, query, type QueryResponse } from "./interface";
import { closeStores, CITY_TIME_ZONE } from "./stores";
import { ADI } from "../../model_visible_text";
import { recordCause } from "./diagnostics";

// The help text and every rejection below are read by the evaluated model; they live in ADI.
const HELP = ADI.help;

type Format = "ndjson" | "json" | "pretty";
interface Parsed {
  command: string;
  positional: string[];
  format: Format;
  reason: string;
  filters: FilterValue[];
  near?: NearFilter;
  select?: string[];
}
const OPERATORS = new Set<FilterOperator>(["eq", "contains", "gte", "gt", "lte", "lt", "between", "is_null"]);

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new QueryRejected("INVALID_VALUE", ADI.optionNeedsValue(option));
  return value;
}
function parseWhere(pair: string, groups: Map<string, FilterValue>): void {
  const separator = pair.indexOf("=");
  if (separator < 1) throw new QueryRejected("INVALID_FILTER", ADI.whereShape);
  const left = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  const dot = left.lastIndexOf(".");
  const possible = dot > 0 ? left.slice(dot + 1) as FilterOperator : "eq";
  if (dot > 0 && !OPERATORS.has(possible))
    throw new QueryRejected("UNSUPPORTED_OPERATOR", ADI.unsupportedOperator(possible));
  const operator = OPERATORS.has(possible) ? possible : "eq";
  const field = operator === "eq" ? left : left.slice(0, dot);
  if (!field || !value) throw new QueryRejected("INVALID_FILTER", ADI.whereNeedsBoth);
  const key = `${field}.${operator}`;
  const existing = groups.get(key);
  if (existing) existing.values.push(value);
  else groups.set(key, { field, operator, values: [value] });
}
function parseNear(value: string): NearFilter {
  const parts = value.split(",").map(Number);
  if (parts.length !== 3) throw new QueryRejected("INVALID_VALUE", ADI.nearShape);
  return { latitude: parts[0]!, longitude: parts[1]!, radiusMetres: parts[2]! };
}
function names(value: string): string[] {
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!parsed.length) throw new QueryRejected("INVALID_VALUE", ADI.noFieldNames);
  return parsed;
}
function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const filters = new Map<string, FilterValue>();
  let format: Format = "ndjson", reason = "", near: NearFilter | undefined, select: string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--help" || value === "-h") { positional.push("help"); continue; }
    if (value === "--pretty") { format = "pretty"; continue; }
    if (value === "--json") { format = "json"; continue; }
    if (value === "--format") {
      const next = valueAfter(argv, index++, value) as Format;
      if (!["ndjson", "json", "pretty"].includes(next)) throw new QueryRejected("INVALID_VALUE", ADI.unknownFormat(next));
      format = next; continue;
    }
    if (value === "--reason") { reason = valueAfter(argv, index++, value); continue; }
    if (value === "--where" || value === "--input") { parseWhere(valueAfter(argv, index++, value), filters); continue; }
    if (value === "--near") { near = parseNear(valueAfter(argv, index++, value)); continue; }
    if (value === "--select") { select = names(valueAfter(argv, index++, value)); continue; }
    if (value.startsWith("--")) throw new QueryRejected("INVALID_FILTER", ADI.unknownOption(value));
    positional.push(value);
  }
  return { command: positional.shift() ?? "help", positional, format, reason,
    filters: [...filters.values()], near, select };
}

function printJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.join("; ");
  return String(value).replace(/[\t\r\n]+/g, " ");
}
function publicResponse(response: QueryResponse) {
  return { database: response.database, query: response.query, columns: response.columns,
    rows: response.rows, count: response.count, subject: response.subject };
}
function printNdjson(response: QueryResponse): void {
  printJson({ type: "meta", database: response.database, query: response.query,
    time_zone: CITY_TIME_ZONE, columns: response.columns, subject: response.subject });
  for (const row of response.rows) printJson({ type: "row", row });
  printJson({ type: "end", rows: response.count });
}
function printPretty(response: QueryResponse): void {
  const summary = new Table({ colWidths: [22, 96], wordWrap: true, style: { head: ["cyan"] } });
  summary.push(["Source", `${response.database.name} (${response.database.code})`],
    ["Search", response.query.label], ["Custodian", response.database.holder], ["Result", `${response.count} record(s)`]);
  if (response.subject) summary.push(["Subject", `${response.subject.name} · ${response.subject.derivation}`]);
  console.log(summary.toString());
  if (!response.rows.length) { console.log(ADI.nothingOnFile); return; }
  if (response.columns.length > 8) {
    response.rows.forEach((row, index) => {
      console.log(`Record ${index + 1}`);
      const record = new Table({ colWidths: [30, 90], wordWrap: true });
      for (const column of response.columns) record.push([column.label, render(formatCell(row[column.name], column.format))]);
      console.log(record.toString());
    });
    return;
  }
  const width = Math.max(14, Math.min(32, Math.floor(140 / response.columns.length)));
  const table = new Table({ head: response.columns.map((column) => column.label),
    colWidths: response.columns.map(() => width), wordWrap: true, style: { head: ["cyan"] } });
  for (const row of response.rows) table.push(response.columns.map((column) => render(formatCell(row[column.name], column.format))));
  console.log(table.toString());
}
function output(response: QueryResponse, format: Format): void {
  if (format === "ndjson") printNdjson(response);
  else if (format === "json") printJson(publicResponse(response));
  else printPretty(response);
}
function filteredCatalog(positional: string[]) {
  const [source, search, ...extra] = positional;
  if (extra.length) throw new QueryRejected("INVALID_FILTER", ADI.catalogArgs);
  let databases = catalog();
  if (source) databases = databases.filter((database) => database.id === source);
  if (source && !databases.length) throw new QueryRejected("INVALID_FILTER", ADI.unknownSource(source));
  if (search) databases = databases.map((database) => ({ ...database,
    queries: database.queries.filter((query) => query.id === search) })).filter((database) => database.queries.length);
  if (search && !databases.length) throw new QueryRejected("INVALID_FILTER", ADI.unknownSearch(source, search));
  return databases;
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(parsed.command)) { console.log(HELP); return; }
  if (parsed.command === "catalog") {
    const result = { databases: filteredCatalog(parsed.positional), timeZone: CITY_TIME_ZONE };
    if (parsed.format === "pretty") {
      for (const database of result.databases) for (const search of database.queries)
        console.log(`${database.id}.${search.id}\n  filters: ${search.filters.map((filter) => `${filter.name}[${filter.operators.join("|")}]`).join(", ")}\n  returns: ${search.columns.map((column) => column.name).join(", ")}`);
    } else printJson(result);
    return;
  }
  if (parsed.command === "days") { const days = await heldDays(); printJson({ days, timeZone: CITY_TIME_ZONE }); return; }
  if (parsed.command === "health") { const status = await health(); printJson(status); if (status.status !== "online") process.exitCode = 1; return; }
  if (parsed.command === "query") {
    const [source, search, ...extra] = parsed.positional;
    if (!source || !search || extra.length) throw new QueryRejected("INVALID_FILTER", ADI.queryArgs);
    const request: QueryRequest = { filters: parsed.filters, near: parsed.near, select: parsed.select };
    const response = await query(source, search, parsed.reason, request);
    output(response, parsed.format); return;
  }
  throw new QueryRejected("INVALID_FILTER", ADI.unknownCommand(parsed.command));
}

try { await main(); }
catch (error) {
  const code = error instanceof QueryRejected ? error.code : "QUERY_FAILED";
  const message = error instanceof QueryRejected ? error.message : ADI.failed;
  // The agent gets the message above; the operator gets the cause, host-side only.
  // A rejection's message is already the whole story.
  if (!(error instanceof QueryRejected)) recordCause("failed", error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
} finally { await closeStores(); }

import { ClickHouseLogLevel, createClient, type ClickHouseClient } from "@clickhouse/client";
import { Pool } from "pg";
import { loadProjectEnvironment } from "./env";

loadProjectEnvironment();

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required; put it in the project .env.local`);
  return value;
}

/** The PostgreSQL schema Fastgate writes its static provider tables into. */
export const STATIC_SCHEMA = process.env.POSTGRES_SCHEMA?.trim() || "fastgate_static";

// Next reloads server modules between requests in development, so the clients
// hang off globalThis rather than module scope; otherwise every edit leaks a
// connection pool.
const globals = globalThis as typeof globalThis & {
  kdiPostgres?: Pool;
  kdiClickHouse?: ClickHouseClient;
};

export function postgres(): Pool {
  globals.kdiPostgres ??= new Pool({
    connectionString: required("POSTGRES_URL", "postgres://postgres@127.0.0.1:5432/city_data"),
    max: 8,
    idleTimeoutMillis: 30_000,
  });
  return globals.kdiPostgres;
}

export function clickhouse(): ClickHouseClient {
  globals.kdiClickHouse ??= createClient({
    url: required("CLICKHOUSE_URL", "http://127.0.0.1:8123"),
    database: required("CLICKHOUSE_DATABASE", "city_data"),
    username: required("CLICKHOUSE_USER", "default"),
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    clickhouse_settings: { max_execution_time: 30 },
    log: { level: ClickHouseLogLevel.OFF },
  });
  return globals.kdiClickHouse;
}

/** Release clients so one-shot CLI invocations terminate immediately. */
export async function closeStores(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (globals.kdiPostgres) {
    tasks.push(globals.kdiPostgres.end());
    globals.kdiPostgres = undefined;
  }
  if (globals.kdiClickHouse) {
    tasks.push(globals.kdiClickHouse.close());
    globals.kdiClickHouse = undefined;
  }
  await Promise.all(tasks);
}

/** The city's wall clock. Every timestamp the interface prints is in this zone. */
export const CITY_TIME_ZONE = process.env.CITY_TIME_ZONE?.trim() || "America/New_York";

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { schemaSql } from "./schema.ts";

export interface Database {
  client: ClickHouseClient;
  database: string;
  end(): Promise<void>;
}

export interface ConnectionOptions {
  url: string;
  database: string;
  username?: string;
  password?: string;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid ClickHouse identifier: ${value}`);
  }
  return `\`${value}\``;
}

export function table(database: Database, name: string): string {
  return `${identifier(database.database)}.${identifier(name)}`;
}

export function connect(options: ConnectionOptions): Database {
  identifier(options.database);
  const client = createClient({
    url: options.url,
    username: options.username ?? "default",
    password: options.password ?? "",
    database: "default",
    // Mutations rewrite parts and can take longer than the client's default
    // 30 seconds even for a small set of IDs.
    request_timeout: 300_000,
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: "10000",
    },
  });
  return {
    client,
    database: options.database,
    end: () => client.close(),
  };
}

export async function initializeSchema(database: Database): Promise<void> {
  for (const query of schemaSql(database.database)) {
    await database.client.command({ query });
  }
}

export async function truncateTable(database: Database, tableName: string): Promise<void> {
  await database.client.command({ query: `TRUNCATE TABLE ${table(database, tableName)}` });
}

/** ClickHouse mutations are asynchronous by default; every delete here waits so
 * a caller can read the table straight after. */
export async function deleteWhere(
  database: Database,
  tableName: string,
  condition: string,
  parameters: Record<string, unknown>,
): Promise<void> {
  await database.client.command({
    query: `ALTER TABLE ${table(database, tableName)}
      DELETE WHERE ${condition}
      SETTINGS mutations_sync = 1`,
    query_params: parameters,
  });
}

export async function deleteIds(
  database: Database,
  tableName: string,
  field: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  // One mutation per table: batching IDs repeatedly rewrites the same parts.
  // command() puts query_params in the URL. Keep this potentially large UUID
  // set in the SQL request body instead, validating before interpolating.
  for (const id of unique) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
      throw new Error(`invalid UUID in ${tableName}.${field}`);
    }
  }
  const query = `ALTER TABLE ${table(database, tableName)} DELETE WHERE ${identifier(field)}
    IN CAST([${unique.map((id) => `'${id}'`).join(",")}], 'Array(UUID)') SETTINGS mutations_sync = 1`;
  await database.client.command({
    query,
    clickhouse_settings: { max_query_size: String(Math.max(262_144, Buffer.byteLength(query) + 1024)) },
  });
}

/** Rows per ClickHouse insert. Each insert is one acknowledged round trip and
 * one new part, so small batches leave a remote import waiting on latency. */
export const INSERT_BATCH = 50_000;

export async function insertBatches<T extends object>(
  database: Database,
  tableName: string,
  rows: readonly T[],
  version: string,
  batchSize = INSERT_BATCH,
  progress?: (completed: number, total: number) => void,
): Promise<void> {
  progress?.(0, rows.length);
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await database.client.insert({
      table: table(database, tableName),
      values: batch.map((row) => ({ ...row, _version: version })),
      format: "JSONEachRow",
    });
    progress?.(start + batch.length, rows.length);
  }
}

import { Pool } from "pg";
import { postgresIdentifier, staticSchemaSql } from "./static-schema.ts";

export interface StaticDatabase {
  pool: Pool;
  schema: string;
  end(): Promise<void>;
}

export interface StaticConnectionOptions {
  url: string;
  schema?: string;
  maxConnections?: number;
}

export function staticTable(database: StaticDatabase, name: string): string {
  return `${postgresIdentifier(database.schema)}.${postgresIdentifier(name)}`;
}

export function connectStatic(options: StaticConnectionOptions): StaticDatabase {
  const schema = options.schema ?? "fastgate_static";
  postgresIdentifier(schema);
  const pool = new Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 4,
  });
  return {
    pool,
    schema,
    end: () => pool.end(),
  };
}

export async function initializeStaticSchema(database: StaticDatabase): Promise<void> {
  const client = await database.pool.connect();
  try {
    for (const query of staticSchemaSql(database.schema)) await client.query(query);
  } finally {
    client.release();
  }
}

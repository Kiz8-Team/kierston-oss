function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function staticSchemaSql(schema: string): string[] {
  const namespace = quoteIdentifier(schema);
  return [`CREATE SCHEMA IF NOT EXISTS ${namespace}`];
}

export function postgresIdentifier(identifier: string): string {
  return quoteIdentifier(identifier);
}

export type ImportMode = "overwrite" | "append";

export interface TableImportOptions {
  tables?: readonly string[];
  mode?: ImportMode;
  /** Dynamic imports only: write selected tables even while a scenario is
   * active for the date. */
  forceWithScenario?: boolean;
}

export interface ResolvedTableImport {
  tables: ReadonlySet<string>;
  mode: ImportMode;
  explicit: boolean;
}

export function resolveTableImport(
  allowedTables: readonly string[],
  options: TableImportOptions | undefined,
  defaultMode: ImportMode,
): ResolvedTableImport {
  const allowed = new Set(allowedTables);
  const mode = options?.mode ?? defaultMode;
  if (mode !== "overwrite" && mode !== "append") {
    throw new Error(`invalid import mode ${String(mode)}; expected overwrite or append`);
  }

  const requested = options?.tables?.flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (options?.tables !== undefined && requested?.length === 0) {
    throw new Error("at least one table is required");
  }
  const unknown = [...new Set(requested?.filter((name) => !allowed.has(name)) ?? [])];
  if (unknown.length > 0) {
    throw new Error(
      `unknown table${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}; `
      + `allowed tables: ${allowedTables.join(", ")}`,
    );
  }

  return {
    tables: new Set(requested ?? allowedTables),
    mode,
    explicit: options?.tables !== undefined || options?.mode !== undefined,
  };
}

export function importOptionsFromValues(
  tables: readonly string[],
  mode: string | null | undefined,
): TableImportOptions | undefined {
  if (tables.length === 0 && mode == null) return undefined;
  if (mode != null && mode !== "overwrite" && mode !== "append") {
    throw new Error(`invalid import mode ${mode}; expected overwrite or append`);
  }
  return {
    ...(tables.length > 0 ? { tables } : {}),
    ...(mode != null ? { mode } : {}),
  };
}

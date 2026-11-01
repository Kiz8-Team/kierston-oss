// Loads the project-level .env.local; keep this first so the imports below see it.
import "./env.ts";
import { resolve } from "node:path";
import { cityTimeZone } from "./city.ts";
import { importAlprCameras } from "./camera-importer.ts";
import { importCellSites } from "./cell-importer.ts";
import { connect, initializeSchema } from "./database.ts";
import { importKday, sha256 } from "./importer.ts";
import { annotateDelta } from "./kdif.ts";
import { importOptionsFromValues, type TableImportOptions } from "./import-options.ts";
import { progressLogger } from "./progress.ts";
import { activeScenarios, importScenario } from "./scenario-importer.ts";
import { revertScenario } from "./scenario-revert.ts";
import { connectStatic } from "./static-database.ts";
import { importStaticRecords } from "./static-importer.ts";

function environment(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required; put it in the project .env.local`);
  return value;
}

function optionalEnvironment(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function importArguments(
  args: readonly string[], usage: string, allowForce = false,
): { input: string; options?: TableImportOptions } {
  let input: string | undefined;
  let mode: string | undefined;
  let forceWithScenario = false;
  const tables: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (allowForce && argument === "--force-with-scenario") {
      forceWithScenario = true;
    } else if (argument === "--tables" || argument === "--table" || argument === "--mode") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value; ${usage}`);
      index += 1;
      if (argument === "--mode") mode = value;
      else tables.push(value);
    } else if (argument.startsWith("--tables=") || argument.startsWith("--table=")) {
      tables.push(argument.slice(argument.indexOf("=") + 1));
    } else if (argument.startsWith("--mode=")) {
      mode = argument.slice("--mode=".length);
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}; ${usage}`);
    } else if (input) {
      throw new Error(`unexpected argument ${argument}; ${usage}`);
    } else {
      input = argument;
    }
  }
  if (!input) throw new Error(usage);
  const options = importOptionsFromValues(tables, mode);
  return { input, options: forceWithScenario ? { ...options, forceWithScenario } : options };
}

function scenarioArguments(args: readonly string[]): { delta: string } {
  const usage = "usage: bun run ingest:scenario -- <path-to-scenario.kdiff>";
  if (args.length !== 1 || args[0]!.startsWith("--")) throw new Error(usage);
  return { delta: args[0]! };
}

function annotateArguments(args: readonly string[]): { base: string; delta: string } {
  const usage = "usage: bun run annotate:scenario -- <path-to-base-day.bin> <path-to-scenario.kdiff>";
  if (args.length !== 2 || args.some((argument) => argument.startsWith("--"))) throw new Error(usage);
  return { base: args[0]!, delta: args[1]! };
}

function revertArguments(args: readonly string[]): { date: string } {
  const usage = "usage: bun run revert:scenario -- <observation-date>";
  const date = args[0];
  if (args.length !== 1 || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(usage);
  return { date };
}

const usage = `usage: bun run src/cli.ts <command> [arguments]

commands:
  ingest-dynamic   import a packed KDAY into ClickHouse
  ingest-scenario  apply the rows a KDIF carries to its imported base KDAY
  annotate-scenario  write the ClickHouse rows into a KDIF from its exact base KDAY
  revert-scenario  remove the active scenario for a date, restoring its base day
  list-scenarios   print every date with a scenario applied, as JSON
  ingest-static    import sim_init.bin records into PostgreSQL
  ingest-cameras   import a cameras.json inventory into PostgreSQL
  ingest-cells     import a towers.json inventory into PostgreSQL`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }

  const database = connect({
    url: environment("CLICKHOUSE_URL", "http://127.0.0.1:8123"),
    database: environment("CLICKHOUSE_DATABASE", "city_data"),
    username: environment("CLICKHOUSE_USER", "default"),
    password: optionalEnvironment("CLICKHOUSE_PASSWORD"),
  });
  const staticDatabase = connectStatic({
    url: environment("POSTGRES_URL", "postgres://postgres@127.0.0.1:5432/city_data"),
    schema: environment("POSTGRES_SCHEMA", "fastgate_static"),
  });

  try {
    if (command === "ingest" || command === "ingest-dynamic") {
      const parsed = importArguments(
        process.argv.slice(3),
        "usage: bun run ingest:dynamic -- <path-to-day.bin> [--tables <name,...>] [--mode overwrite|append]"
          + " [--force-with-scenario]",
        true,
      );
      const progress = progressLogger();
      let result;
      try {
        result = await importKday(
          database, resolve(parsed.input), cityTimeZone(), progress.report, staticDatabase, parsed.options,
        );
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "ingest-scenario") {
      const parsed = scenarioArguments(process.argv.slice(3));
      const progress = progressLogger("[scenario] ");
      let result;
      try {
        result = await importScenario(database, resolve(parsed.delta), cityTimeZone(), progress.report);
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "annotate-scenario") {
      const parsed = annotateArguments(process.argv.slice(3));
      const progress = progressLogger("[annotate] ");
      let records;
      try {
        const baseDigest = await sha256(resolve(parsed.base), progress.report);
        records = await annotateDelta(
          resolve(parsed.base), resolve(parsed.delta), baseDigest, cityTimeZone(),
          (label) => progress.report({ stage: "extract", label }),
        );
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify({
        scenarioId: records.scenarioId,
        tables: Object.fromEntries(Object.entries(records.tables).map(([name, entry]) => [
          name, { deleted: entry.deleted.length, inserted: entry.inserted.length },
        ])),
      }, null, 2));
    } else if (command === "list-scenarios") {
      if (process.argv.length > 3) throw new Error("usage: bun run list:scenarios");
      await initializeSchema(database);
      console.log(JSON.stringify(await activeScenarios(database)));
    } else if (command === "revert-scenario") {
      const parsed = revertArguments(process.argv.slice(3));
      const progress = progressLogger("[revert] ");
      let result;
      try {
        result = await revertScenario(database, parsed.date, progress.report);
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "ingest-static") {
      const parsed = importArguments(
        process.argv.slice(3),
        "usage: bun run ingest:static -- <path-to-sim_init.bin> [--tables <name,...>] [--mode overwrite|append]",
      );
      const progress = progressLogger();
      let result;
      try {
        result = await importStaticRecords(staticDatabase, resolve(parsed.input), progress.report, parsed.options);
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "ingest-cameras") {
      const parsed = importArguments(
        process.argv.slice(3),
        "usage: bun run ingest:cameras -- <path-to-cameras.json> [--mode overwrite|append]",
      );
      const progress = progressLogger();
      let result;
      try {
        result = await importAlprCameras(staticDatabase, resolve(parsed.input), progress.report, parsed.options);
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "ingest-cells") {
      const parsed = importArguments(
        process.argv.slice(3),
        "usage: bun run ingest:cells -- <path-to-towers.json> [--tables <name,...>] [--mode overwrite|append]",
      );
      const progress = progressLogger();
      let result;
      try {
        result = await importCellSites(staticDatabase, resolve(parsed.input), progress.report, parsed.options);
      } finally {
        progress.finish();
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      throw new Error(`unknown command ${command}\n\n${usage}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await database.end().catch(() => {});
    await staticDatabase.end().catch(() => {});
  }
}

await main();

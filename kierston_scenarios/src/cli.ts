import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { products } from "../../kierston/sim/src/index.ts";
import { applyScenario } from "./replay/runner.ts";
import type { ScenarioDefinition } from "./authoring/dsl.ts";
import { materializeScenario } from "./storage/delta.ts";
import { STEP_MARK } from "./step-mark.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(`Usage:
  bun run scenarios create --scenario SCENARIO.ts [--input DAY.bin] [--seed INTEGER] [--output SCENARIO.kdiff] [--opening-state KSTATE.json|PREVIOUS.bin] [--max-affected 64]
  bun run scenarios merge --input DAY.bin --delta SCENARIO.kdiff --output SCENARIO.bin

Notes:
  "create" is the default command.
  create flags override values set in the scenario definition.
  Paths in a scenario file are relative to that file; CLI paths are relative to cwd.
  merge reads only the base KDAY and the delta.`);
} else {
  try {
    const command = args[0]!.startsWith("--") ? "create" : args.shift();
    if (command !== "create" && command !== "merge") throw new Error(`unknown command ${command}`);
    const options = new Map<string, string>();
    const allowed = new Set(command === "merge" ? ["--input", "--delta", "--output"]
      : ["--input", "--scenario", "--seed", "--output", "--opening-state", "--max-affected"]);
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]!) || !args[i + 1]?.trim() || args[i + 1]!.startsWith("--") || options.has(args[i]!)) throw new Error(`invalid argument ${args[i]}`);
      options.set(args[i]!, args[i + 1]!);
    }
    const required = command === "merge" ? ["--input", "--delta", "--output"] : ["--scenario"];
    for (const name of required) if (!options.has(name)) throw new Error(`missing ${name}`);
    if (command === "merge") {
      console.error("Verifying base and materializing scenario KDAY");
      console.log(JSON.stringify(await materializeScenario({ input: resolve(options.get("--input")!),
        delta: resolve(options.get("--delta")!), output: resolve(options.get("--output")!) }), null, 2));
    } else {
      const source = resolve(options.get("--scenario")!);
      const definition = (await import(pathToFileURL(source).href)).default as ScenarioDefinition;
      if (!definition?.name || typeof definition.build !== "function") throw new Error("scenario file must default-export scenario(options, builder)");
      const report = await applyScenario({ input: options.get("--input"), output: options.get("--output"),
        scenario: definition, scenarioPath: source,
        seed: options.has("--seed") ? Number(options.get("--seed")) : undefined, openingState: options.get("--opening-state"),
        maxAffected: options.has("--max-affected") ? Number(options.get("--max-affected")) : undefined,
        // Steps are marked so a caller drawing progress can tell them from
        // warnings the engine prints on the same stream.
        sourceHash: await products.fileDigest(source), status: (message) => console.error(`${STEP_MARK}${message}`),
      });
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error); process.exitCode = 1;
  }
}

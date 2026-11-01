/**
 * Generate benchmark tasks from one KDAY file.
 *
 *   bun run tasks <family|all> \
 *     --day kierston/sim_outputs/day_2026-08-23.bin \
 *     [--delta scenario.kdiff] [--sim-data kierston/sim_data] [--seed 1] [--count 5]
 *
 * `--delta` reads a scenario over the day in memory, for the RTI and DT families.
 *
 * Tasks are printed as JSON lines. A family a day cannot support (no noisy
 * plates, no shared journeys) reports and is skipped rather than failing the
 * run.
 */

import { join } from "node:path";
import { GENERATORS, generatorByFamily, openContext, Rng } from "./index.ts";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const familyArgument = process.argv[2];
if (!familyArgument) {
  console.error("usage: bun run tasks <family|all> --day <kday file> [--delta <scenario.kdiff>] [--sim-data <dir>] [--seed <n>] [--count <n>]");
  console.error(`families: ${GENERATORS.map((generator) => generator.family).join(", ")}`);
  process.exit(2);
}

const dayFile = argument("day");
const deltaFile = process.argv.includes("--delta") ? argument("delta") : undefined;
const simDataDir = argument("sim-data", join(import.meta.dir, "../../../kierston/sim_data"));
const baseSeed = Number(argument("seed", "1"));
const count = Number(argument("count", "1"));

const families = familyArgument === "all"
  ? GENERATORS
  : [generatorByFamily.get(familyArgument) ?? ((): never => {
      throw new Error(`unknown family ${familyArgument}`);
    })()];

const ctx = await openContext({ dayFile, deltaFile, simDataDir });
for (const generator of families) {
  for (let i = 0; i < count; i += 1) {
    const seed = (baseSeed + i * 2654435761) >>> 0;
    try {
      const task = await generator.generate(ctx, new Rng(seed ^ hash(generator.family)), seed);
      console.log(JSON.stringify(task));
    } catch (error) {
      console.error(`${generator.family}: skipped: ${(error as Error).message}`);
    }
  }
}
await ctx.day.close();

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  }
  return value >>> 0;
}

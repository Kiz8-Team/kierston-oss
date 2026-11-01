/**
 * The benchmark scenario catalogue and the scripts it names: every entry
 * loads, declares the run defaults a series overrides, records the event
 * kind the catalogue says it does, and every family it lists exists.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCH_SCENARIOS, SCENARIO_GROUPS, scenarioById } from "../scenarios/catalog.ts";
import type { ScenarioDefinition } from "../src/index.ts";
import { GENERATORS, taskGroupOf } from "../../kierston_bench/task_generators/src/index.ts";

const directory = join(import.meta.dir, "../scenarios");

describe("benchmark scenario catalogue", () => {
  test("ids are distinct and every listed family has a generator that reads the listed event kind", () => {
    expect(new Set(BENCH_SCENARIOS.map((entry) => entry.id)).size).toBe(BENCH_SCENARIOS.length);
    const byFamily = new Map(GENERATORS.map((generator) => [generator.family, generator]));
    for (const entry of BENCH_SCENARIOS) {
      expect(entry.families.length).toBeGreaterThan(0);
      for (const family of entry.families) {
        const generator = byFamily.get(family);
        expect(generator, `${entry.id} lists ${family}`).toBeDefined();
        expect(generator!.eventKind, `${family} reads ${entry.eventKind}`).toBe(entry.eventKind);
        expect(taskGroupOf(family)?.id, `${family} is in the ${entry.group} group`).toBe(entry.group);
      }
      expect(entry.file.startsWith(`${entry.group}/`), `${entry.id} lives under ${entry.group}/`).toBe(true);
    }
    expect(scenarioById.get("protest")?.file).toBe("rti/protest.ts");
    expect(scenarioById.get("swatting")?.file).toBe("dt/swatting.ts");
    expect(SCENARIO_GROUPS).toEqual(["rti", "dt"]);
  });

  test("every catalogued script loads, names itself after its id and records the event kind", async () => {
    const source = await Promise.all(BENCH_SCENARIOS.map((entry) => Bun.file(join(directory, entry.file)).text()));
    for (const [index, entry] of BENCH_SCENARIOS.entries()) {
      const definition = (await import(pathToFileURL(join(directory, entry.file)).href)).default as ScenarioDefinition;
      expect(definition.name).toBe(entry.id);
      expect(typeof definition.build).toBe("function");
      expect(definition.seed).toBeDefined();
      expect(definition.input).toMatch(/\.bin$/);
      expect(definition.output).toMatch(/\.kdiff$/);
      expect(definition.maxAffected).toBe(entry.maxAffected);
      expect(source[index], `${entry.file} records kind ${entry.eventKind}`).toContain(`kind: "${entry.eventKind}"`);
    }
  });

  test("every script under a group directory is catalogued; demos are not", async () => {
    const top = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
    expect(top).toEqual(["catalog.ts"]);
    const files: string[] = [];
    for (const group of SCENARIO_GROUPS) {
      files.push(...(await readdir(join(directory, group))).filter((name) => name.endsWith(".ts")).map((name) => `${group}/${name}`));
    }
    expect(files.sort()).toEqual(BENCH_SCENARIOS.map((entry) => entry.file).sort());
    const groups = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(groups.sort()).toEqual([...SCENARIO_GROUPS, "demo"].sort());
    const demos = await readdir(join(directory, "demo"));
    expect(demos.sort()).toEqual(["coffee.ts", "taxi.ts"]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scenario } from "../src/index.ts";
import { resolveRunOptions, type ScenarioRunOptions } from "../src/authoring/run.ts";

describe("scenario run defaults", () => {
  const defaults = { input: "base.bin", output: "scene.kdiff", seed: 42, openingState: "opening.json", maxAffected: 8 };
  const source = resolve("nested scripts/scene.ts");

  test("supports both the object DSL and legacy name/version signature", () => {
    const build = () => {};
    const definition = scenario({ name: "configured", ...defaults, version: 3 }, build);
    expect(definition).toEqual({ name: "configured", ...defaults, version: 3, build });
    expect(scenario({ name: "configured" }, build).version).toBe(1);
    expect(scenario("legacy", build, 2)).toEqual({ name: "legacy", version: 2, build });
  });

  test("resolves every script path relative to its source file", () => {
    expect(resolveRunOptions(defaults, {}, source)).toEqual({
      input: resolve("nested scripts/base.bin"), output: resolve("nested scripts/scene.kdiff"), seed: 42,
      openingState: resolve("nested scripts/opening.json"), maxAffected: 8,
    });
    expect(resolveRunOptions(defaults).input).toBe(resolve("base.bin"));
  });

  test("explicit values override all defaults, including seed zero; override paths use cwd", () => {
    const overrides = { input: "other.bin", output: "other.kdiff", seed: 0, openingState: "other.json", maxAffected: 1 };
    expect(resolveRunOptions(defaults, overrides, source)).toEqual({ ...overrides,
      input: resolve("other.bin"), output: resolve("other.kdiff"), openingState: resolve("other.json") });
    expect(defaults).toEqual({ input: "base.bin", output: "scene.kdiff", seed: 42, openingState: "opening.json", maxAffected: 8 });
  });

  test("partial or undefined overrides retain script defaults and absolute paths", () => {
    const resolved = resolveRunOptions({ ...defaults, input: resolve("absolute.bin") }, { seed: 7, input: undefined }, source);
    expect(resolved).toEqual({ input: resolve("absolute.bin"), output: resolve("nested scripts/scene.kdiff"), seed: 7,
      openingState: resolve("nested scripts/opening.json"), maxAffected: 8 });
    expect(resolveRunOptions({ input: "base", output: "delta", seed: 0 }).maxAffected).toBe(64);
  });

  test("rejects missing values and invalid overrides rather than falling back", () => {
    for (const key of ["input", "output", "seed"] as const) {
      expect(() => resolveRunOptions({ ...defaults, [key]: undefined })).toThrow(`missing ${key}`);
    }
    for (const overrides of [
      { seed: NaN }, { seed: Infinity }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
      { maxAffected: 0 }, { maxAffected: -1 }, { maxAffected: 1.5 },
      { input: "" }, { output: " " }, { openingState: "" },
    ] satisfies ScenarioRunOptions[]) expect(() => resolveRunOptions(defaults, overrides, source)).toThrow();
  });
});

describe("create CLI with script defaults", () => {
  let directory: string, source: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "kierston-run-options-"));
    const scripts = join(directory, "scripts with spaces");
    await mkdir(scripts);
    source = join(scripts, "scene.ts");
    const api = pathToFileURL(resolve(import.meta.dir, "../src/index.ts")).href;
    await Bun.write(source, `import { scenario } from ${JSON.stringify(api)};
export default scenario({ name: "cli", input: "base.bin", output: "scene.kdiff", seed: 42, maxAffected: 8 }, () => {});\n`);
    // Stop at the binary reader, before city loading; the chosen path/error
    // confirms options reached the real runner through the actual CLI.
    await Bun.write(join(scripts, "base.bin"), "not a KDAY");
    await Bun.write(join(directory, "override.bin"), "also not a KDAY");
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
      { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return { exit, stderr };
  }

  test("only --scenario is required, with or without the create command", async () => {
    for (const prefix of [[], ["create"]]) {
      const result = await run([...prefix, "--scenario", source]);
      expect(result.exit).toBe(1);
      expect(result.stderr).toContain(`${join(directory, "scripts with spaces/base.bin")} is not a KDAY file`);
    }
  });

  test("CLI overrides use cwd and invalid values do not disappear into defaults", async () => {
    const result = await run(["create", "--scenario", source, "--input", "override.bin", "--seed", "0"]);
    expect(result.stderr).toContain(`${join(directory, "override.bin")} is not a KDAY file`);
    expect((await run(["--scenario", source, "--seed", "NaN"])).stderr).toContain("seed must be a safe integer");
    expect((await run(["--scenario", source, "--max-affected", "0"])).stderr).toContain("maxAffected must be a positive integer");
    expect((await run(["--scenario", source, "--seed", "--output", "out.kdiff"])).stderr).toContain("invalid argument --seed");
  });

  test("an output override cannot overwrite the scenario source itself", async () => {
    const before = await Bun.file(source).text();
    const result = await run(["--scenario", source, "--output", source]);
    expect(result.stderr).toContain("must differ");
    expect(await Bun.file(source).text()).toBe(before);
  });
});

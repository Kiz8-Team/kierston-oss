import { dirname, resolve } from "node:path";

/** Script defaults; explicit CLI/API values take precedence per field. */
export interface ScenarioRunOptions {
  input?: string;
  /** Output KDIF delta, not a materialized KDAY. */
  output?: string;
  seed?: number;
  /** Legacy v11 input: a KSTATE JSON or the previous day's KDAY. */
  openingState?: string;
  maxAffected?: number;
}
export interface ResolvedRunOptions extends ScenarioRunOptions {
  input: string;
  output: string;
  seed: number;
  maxAffected: number;
}

/** Script paths use the script directory; overrides use cwd. API callers that
 * omit scenarioPath use cwd for both. Resolve before loading any city assets.
 */
export function resolveRunOptions(
  defaults: ScenarioRunOptions, overrides: ScenarioRunOptions = {}, scenarioPath?: string,
): ResolvedRunOptions {
  const directory = scenarioPath ? dirname(resolve(scenarioPath)) : process.cwd();
  const path = (key: "input" | "output" | "openingState", flag: string, required = true): string | undefined => {
    const value = overrides[key] !== undefined ? overrides[key] : defaults[key];
    if (value === undefined && !required) return undefined;
    if (value === undefined) throw new Error(`missing ${key}: set scenario.${key} or ${flag}`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty path`);
    return resolve(overrides[key] !== undefined ? process.cwd() : directory, value);
  };
  const seed = overrides.seed !== undefined ? overrides.seed : defaults.seed;
  if (seed === undefined) throw new Error("missing seed: set scenario.seed or --seed");
  if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
  const maxAffected = overrides.maxAffected !== undefined ? overrides.maxAffected : defaults.maxAffected ?? 64;
  if (!Number.isSafeInteger(maxAffected) || maxAffected < 1) throw new Error("maxAffected must be a positive integer");
  return { input: path("input", "--input")!, output: path("output", "--output")!, seed, maxAffected,
    openingState: path("openingState", "--opening-state", false) };
}

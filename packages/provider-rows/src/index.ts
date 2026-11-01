/**
 * The provider rows a KDAY yields — ALPR reads, network events, carrier
 * records, bank transactions — and the per-row hashing that finds which of
 * them a scenario changed.
 *
 * Shared by Fastgate, which imports the rows, and the scenario writer, which
 * computes a KDIF's `records` section. Pure: no database, no city assets.
 */
export * from "./kday.ts";
export * from "./time.ts";
export * from "./id.ts";
export * from "./extract.ts";
export * from "./scenario-rows.ts";

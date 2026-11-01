/**
 * Kierston's internal engine surface.
 *
 * Core code should import a subsystem entry point directly. This file exists
 * for top-level consumers such as the CLI, tools, and tests that need to
 * assemble several subsystems at once.
 */
export * from "./engine/index.ts";
export * from "./scheduler/index.ts";
export * as world from "./world/index.ts";
export * as work from "./activities/work/index.ts";
export * as school from "./activities/school/index.ts";
export * as sleep from "./activities/sleep/index.ts";
export * as social from "./activities/social/index.ts";
export * as discretionary from "./activities/discretionary/index.ts";
export * as transport from "./transport/index.ts";
export * as economy from "./economy/index.ts";
export * as products from "./export/index.ts";
export * as surveillance from "./surveillance/index.ts";
export * as traffic from "./traffic/index.ts";
export * as shared from "./shared/index.ts";
export * as network from "./network/index.ts";
export * as comms from "./comms/index.ts";

/**
 * Package entry point for Trace.
 *
 * Concept: a single import surface for the harness. Most callers need only
 * a Harness, a Policy to decide tool calls, tool() to add their own tools,
 * and runFleet() to run many harnesses at once; the parts it composes stay
 * importable from their own modules.
 *
 * Design rules: standard library only; re-exports only, no logic.
 */
export { type FleetJob, type FleetResult, runFleet } from "./fleet.ts";
export { Harness } from "./harness.ts";
export type { Tool } from "./loop.ts";
export { Policy } from "./security.ts";
export { tool } from "./tools.ts";

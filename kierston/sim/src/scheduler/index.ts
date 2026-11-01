/**
 * The scheduler: what a person does on one date, and how they got there.
 *
 *   day.ts        composition — every layer's proposal, as immutable intents
 *   planner.ts    placement — anchors, then windows, then the journeys between
 *   mobility.ts   pricing — one transition at a time, over the real road graph
 *   types.ts      the vocabulary the three share
 */

export { scheduleDay, HOME_GAP_MINUTES, type PlanRequest } from "./planner.ts";
export { RoutedMobility, type MobilityPolicy } from "./mobility.ts";
export { callsFor, whereAt } from "./calls.ts";
export {
  planDay, dispatchFor, entries, dayFromTimeline, HouseholdDayPlanner,
  type Day, type Entry, type SchedulerPayload,
} from "./compose.ts";
export { PrivateVehicleFleet, type PrivateVehicleTally } from "./private_vehicles.ts";
export type * from "./types.ts";

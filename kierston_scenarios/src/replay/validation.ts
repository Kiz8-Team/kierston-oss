import { products } from "../../../kierston/sim/src/index.ts";
import { Baseline, SHARED_MODES, SHARED_PURPOSES, type RecordedDay } from "./baseline.ts";

/**
 * Check every changed day against the journeys it shared. A person in
 * `droppable` who fails is removed from `changed` and reported through
 * `dropped` instead of failing the run; anybody else fails it.
 */
export async function validateSharedJourneys(
  baseline: Baseline, changed: Map<number, RecordedDay>, droppable: ReadonlySet<number> = new Set(),
  dropped: Map<number, string> = new Map(),
): Promise<void> {
  if (!changed.size) return;
  const [p, legs] = await Promise.all([baseline.file.table("person"), baseline.file.table("leg")]);
  const owners = new Map<string, Set<number>>();
  for (let row = 0; row < p.id!.length; row++) {
    for (let i = p.legOffset![row]!; i < p.legOffset![row]! + p.legCount![row]!; i++) {
      const id = baseline.file.string(legs.journey![i]!);
      if (!id) continue;
      const set = owners.get(id) ?? new Set<number>(); set.add(p.id![row]!); owners.set(id, set);
    }
  }
  for (const [person, replacement] of [...changed]) {
    const original = await baseline.person(person);
    try { check(person, replacement, original); } catch (error) {
      if (!droppable.has(person) || !(error instanceof Error)) throw error;
      changed.delete(person); dropped.set(person, error.message);
    }
  }
  function check(person: number, replacement: RecordedDay, original: RecordedDay): void {
    for (const leg of original.day.legs) {
      if (leg.mode === "cab" && leg.purpose !== "fare") continue;
      if (replacement.day.legs.some((next) => next.journeyId === leg.journeyId && next.depart === leg.depart && next.arrive === leg.arrive)) continue;
      // `patrol` is here for a different reason from the rest. Nobody shares the
      // journey, but the car is shared: three watches take the same VIN out in
      // turn, so dropping one officer's tour leaves a hole in that vehicle's
      // day that the other two cannot fill.
      // A patrol leg may go when the scenario itself drives the same car: a
      // unit sent to a call still brings the car back to the yard, and the
      // vehicle ledger has already checked that chain end to end.
      const redriven = leg.mode === "patrol" && replacement.day.legs.some((next) =>
        next.mode === "patrol" && next.vehicleId === leg.vehicleId && next.journeyId?.startsWith("scenario/"));
      if ((SHARED_MODES.includes(leg.mode) && !redriven) || SHARED_PURPOSES.includes(leg.purpose)) {
        throw new Error(`person ${person}: replacing ${leg.mode}/${leg.purpose} requires shared school/carpool/fleet replanning, which is not supported`);
      }
      for (const other of owners.get(leg.journeyId!) ?? []) {
        if (other === person) continue;
        const day = changed.get(other);
        if (!day || day.day.legs.some((next) => next.journeyId === leg.journeyId
          && !(next.mode === "cab" && next.purpose !== "fare"))) {
          throw new Error(`replacing shared journey ${leg.journeyId} would leave person ${other}'s ride unchanged; include a compatible replacement`);
        }
      }
    }
  }
}

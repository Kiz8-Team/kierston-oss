/** A unit's day with its calls spliced in, replayed from what the dispatcher recorded. */

import type { Sojourn } from "../transport/index.ts";
import type { PatrolPost } from "../activities/work/index.ts";
import type { AmbulanceDuty, Response } from "./cad.ts";

/** The patrol tour with runs spliced in; slack after clearing is spent at the scene so the tour stays contiguous. */
export function respondingTour(
  tour: readonly Sojourn<PatrolPost>[], runs: readonly Response[],
): Sojourn<PatrolPost>[] {
  if (runs.length === 0) return [...tour];
  const out: Sojourn<PatrolPost>[] = [tour[0]!];
  let next = 1;

  for (const run of runs) {
    if (run.leaveFrom.kind === "stay") {
      for (let k = next; k <= run.leaveFrom.index; k += 1) out.push({ ...tour[k]! });
      const last = out[out.length - 1]!;
      last.leave = Math.max(last.arrive + 1, Math.min(last.leave, run.dispatchedAt));
      next = run.leaveFrom.index + 1;
    } else {
      out[out.length - 1]!.leave = run.dispatchedAt;
    }
    const previous = out[out.length - 1]!;
    out.push({
      place: run.scene,
      arrive: run.arrivedAt,
      leave: Math.max(run.arrivedAt + 1, run.sceneUntil),
      fixed: true,
      purpose: "response",
      ref: { kind: "scene", beat: previous.ref.beat, index: run.incident, vin: run.vin, incident: run.incident, incidentKind: run.kind },
      mode: "patrol",
      minutes: Math.max(1, run.arrivedAt - run.dispatchedAt),
      vehicleId: run.vin,
    });
    next = run.resumeIndex;
  }

  const resumed = tour[next];
  if (resumed) {
    const scene = out[out.length - 1]!;
    const drive = Math.max(1, resumed.arrive - scene.leave);
    out.push({ ...resumed, minutes: drive });
    for (let k = next + 1; k < tour.length; k += 1) out.push({ ...tour[k]! });
  }
  return out;
}

export interface AmbulanceStop {
  kind: "house" | "scene" | "hospital";
  vin: string;
  incident: number | null;
  kindIndex: number | null;
  journeyId: string | null;
  driver: boolean;
}

/** A crew member's day: house, scene, hospital if transported, house again unless sent straight on. */
export function ambulanceStays(
  duty: AmbulanceDuty, runs: readonly Response[], person: number, day: number, blockEnd: number,
): Sojourn<AmbulanceStop>[] {
  const driver = duty.driver === person;
  const house = (arrive: number, leave: number, minutes: number | null, incident: number | null): Sojourn<AmbulanceStop> => ({
    place: duty.base, arrive, leave, fixed: true, purpose: "work",
    ref: { kind: "house", vin: duty.vin, incident, kindIndex: null, journeyId: incident === null ? null : `ems/${day}/${duty.vin}/${incident}/return`, driver },
    ...(minutes === null ? {} : { mode: driver ? "ambulance" : "passenger", minutes }),
    ...(minutes !== null && driver ? { vehicleId: duty.vin } : {}),
  });
  const stays: Sojourn<AmbulanceStop>[] = [house(duty.block.start, runs[0]?.dispatchedAt ?? blockEnd, null, null)];
  if (runs.length === 0) return stays;

  for (const [n, run] of runs.entries()) {
    const previous = stays[stays.length - 1]!;
    previous.leave = Math.max(previous.arrive + 1, run.dispatchedAt);
    stays.push({
      place: run.scene, arrive: run.arrivedAt,
      leave: Math.max(run.arrivedAt + 1, run.transport ? run.clearedAt : run.sceneUntil),
      fixed: true, purpose: "response",
      ref: { kind: "scene", vin: duty.vin, incident: run.incident, kindIndex: run.kind, journeyId: `ems/${day}/${duty.vin}/${run.incident}/out`, driver },
      mode: driver ? "ambulance" : "passenger",
      minutes: Math.max(1, run.arrivedAt - run.dispatchedAt),
      ...(driver ? { vehicleId: duty.vin } : {}),
    });
    if (run.transport) {
      stays.push({
        place: run.transport.hospital, arrive: run.transport.arrivedAt,
        leave: Math.max(run.transport.arrivedAt + 1, run.sceneUntil),
        fixed: true, purpose: "response",
        ref: { kind: "hospital", vin: duty.vin, incident: run.incident, kindIndex: run.kind, journeyId: `ems/${day}/${duty.vin}/${run.incident}/transport`, driver },
        mode: driver ? "ambulance" : "passenger",
        minutes: Math.max(1, run.transport.arrivedAt - run.clearedAt),
        ...(driver ? { vehicleId: duty.vin } : {}),
      });
    }
    if (run.returnedAt !== null) {
      const following = runs[n + 1];
      stays.push(house(run.returnedAt, following?.dispatchedAt ?? blockEnd, Math.max(1, run.returnedAt - run.sceneUntil), run.incident));
    }
  }
  const last = stays[stays.length - 1]!;
  if (last.leave < blockEnd && last.ref.kind === "house") last.leave = blockEnd;
  return stays;
}

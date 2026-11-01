import { products, surveillance, traffic, type DayContext } from "../../../kierston/sim/src/index.ts";
import { appendRows } from "../storage/columns.ts";

/** Retain baseline observations, deriving new ones only for changed movements. */
export async function refreshAlpr(
  context: DayContext, file: products.KdayFile, date: Date, legMap: Int32Array, identity: string,
): Promise<void> {
  if (!file.header.counts.surveilled) return;
  const [truth, observations, cameras, p, legs, paths] = await Promise.all([
    file.table("alprTruth"), file.table("alprObservation"), file.table("camera"), file.table("person"), file.table("leg"), file.table("path"),
  ]);
  const kept: number[] = [], keepCorrelation = new Set<number>();
  const background: { camera: string; second: number }[] = [];
  for (let i = 0; i < truth.leg!.length; i++) {
    if (truth.source![i] === 0) {
      const next = legMap[truth.leg![i]!] ?? -1;
      if (next < 0) continue;
      truth.leg![i] = next; truth.movement![i] = next;
    }
    kept.push(i); keepCorrelation.add(truth.correlationId![i]!);
    background.push({ camera: file.string(cameras.id![truth.camera![i]!]!)!, second: truth.second![i]! });
  }
  for (const [field, values] of Object.entries(truth)) file.set(`alprTruth.${field}`, kept.map((i) => values[i]!));
  const retainedObservations = Array.from(observations.correlationId!, (id, i) => keepCorrelation.has(id) ? i : -1).filter((i) => i >= 0);
  for (const [field, values] of Object.entries(observations)) file.set(`alprObservation.${field}`, retainedObservations.map((i) => values[i]!));
  const unchanged = new Set(legMap.filter((value) => value >= 0));
  const personId: number[] = [], offsets: number[] = [], counts: number[] = [];
  for (let row = 0; row < p.id!.length; row++) {
    for (let leg = p.legOffset![row]!; leg < p.legOffset![row]! + p.legCount![row]!; leg++) {
      if (unchanged.has(leg)) continue;
      personId.push(p.id![row]!); offsets.push(leg); counts.push(1);
    }
  }
  const derived = await surveillance.simulateAlpr(context, date, file.header.day, {
    personId, personLegOffset: offsets, personLegCount: counts,
    legDepart: legs.depart!, legArrive: legs.arrive!, legMode: legs.mode!, legPurpose: legs.purpose!, legJourney: legs.journey!,
    legVehicle: legs.vehicle!,
    legPathOffset: legs.pathOffset!, legPathCount: legs.pathCount!, pathLat: paths.latE6!, pathLon: paths.lonE6!,
    modes: file.header.enums.mode!, purposes: file.header.enums.purpose!,
  }, traffic.emptyExternalTrafficDay(), file.strings, undefined, undefined, { background, identityPrefix: identity });
  const cameraIndex = new Map(Array.from(cameras.id!, (id, i) => [file.string(id), i]));
  const remapCamera = derived.cameraId.map((id) => {
    const index = cameraIndex.get(file.string(id));
    if (index === undefined) throw new Error("camera inventory differs from the base day; regenerate it with current assets");
    return index;
  });
  await appendRows(file, "alprTruth", derived.truthLeg.map((leg, i) => ({
    correlationId: derived.truthCorrelation[i]!, camera: remapCamera[derived.truthCamera[i]!]!,
    second: derived.truthSecond[i]!, leg, source: derived.truthSource[i]!, movement: derived.truthMovement[i]!,
    side: derived.truthSide[i]!, plate: derived.truthPlate[i]!, jurisdiction: derived.truthJurisdiction[i]!,
  })));
  await appendRows(file, "alprObservation", derived.observationCorrelation.map((correlationId, i) => ({
    correlationId, camera: remapCamera[derived.observationCamera[i]!]!, second: derived.observationSecond[i]!,
    detectedText: derived.observationDetected[i]!, canonicalText: derived.observationCanonical[i]!,
    confidence: derived.observationConfidence[i]!, outcome: derived.observationOutcome[i]!, lighting: derived.observationLighting[i]!,
    headwaySeconds: derived.observationHeadway[i]!, dwellSeconds: derived.observationDwell[i]!,
  })));
  const outcomes = await file.column("alprObservation.outcome");
  const frequencies = new Map<string, number>();
  for (const value of outcomes) {
    const name = file.header.enums.alprOutcome![value]!;
    frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
  }
  file.header.counts.alprPasses = file.count("alprTruth.leg");
  file.header.counts.alprObservations = outcomes.length;
  for (const [count, outcome] of Object.entries({ alprCorrect: "correct", alprMisread: "misread", alprUnreadable: "unreadable",
    alprNotCaptured: "not_captured", alprNoPlate: "no_plate", alprSpurious: "spurious" })) file.header.counts[count] = frequencies.get(outcome) ?? 0;
  file.header.counts.alprReads = (frequencies.get("correct") ?? 0) + (frequencies.get("misread") ?? 0) + (frequencies.get("spurious") ?? 0);
}

import { products, transport } from "../../../kierston/sim/src/index.ts";

/** One defect in a vehicle's day, keyed so the same defect is recognised after a replay. */
interface VehicleBreak { key: string; message: string }

/**
 * Every continuity defect in the vehicle product, in order. Coverage breaks
 * are keyed by VIN and the seconds involved; position jumps (a moving span
 * that starts more than 100 m from where the VIN's previous leg ended, the
 * exporter's own `teleports` test) by VIN and the identity of both legs:
 * owner, journey, depart and arrive, which survive the row renumbering a
 * replay does. Structural errors (a span on the wrong vehicle, a bad leg
 * reference) are returned separately and never tolerated.
 */
async function vehicleBreaks(file: products.KdayFile): Promise<{ breaks: VehicleBreak[]; structural: string | null }> {
  const breaks: VehicleBreak[] = [];
  if (!file.has("vehicle.vin")) return { breaks, structural: null };
  const [vehicles, spans, legs, people] = await Promise.all([file.table("vehicle"), file.table("vehicleSpan"), file.table("leg"), file.table("person")]);
  const legCount = file.count("leg.depart");
  const owner = new Int32Array(legCount).fill(-1);
  for (let row = 0; row < people.id!.length; row++) {
    for (let i = people.legOffset![row]!; i < people.legOffset![row]! + people.legCount![row]!; i++) owner[i] = people.id![row]!;
  }
  const legKey = (i: number) => `${owner[i]}:${file.string(legs.journey![i]!) ?? ""}:${legs.depart![i]}:${legs.arrive![i]}`;
  const moving = (file.header.enums.vehicleSpanKind ?? ["parked", "moving"]).indexOf("moving");
  let offset = 0;
  for (let vehicle = 0; vehicle < vehicles.vin!.length; vehicle += 1) {
    if (vehicles.spanOffset![vehicle] !== offset) return { breaks, structural: `non-contiguous vehicle spans at vehicle ${vehicle}` };
    const count = vehicles.spanCount![vehicle]!;
    offset += count;
    const vin = file.string(vehicles.vin![vehicle]!) ?? `#${vehicle}`;
    let second = 0, previous = -1;
    for (let span = offset - count; span < offset; span += 1) {
      if (spans.vehicle![span] !== vehicle) return { breaks, structural: `vehicleSpan ${span} has wrong vehicle reference` };
      const leg = spans.leg![span]!;
      if (leg < -1 || leg >= legCount || (spans.kind![span] === moving && leg < 0)) {
        return { breaks, structural: `vehicleSpan ${span} has invalid leg reference` };
      }
      const start = spans.startSecond![span]!, end = spans.endSecond![span]!;
      if (start !== second || end <= second) {
        breaks.push({ key: `${vin}|coverage|${second}|${start}|${end}`, message: `vehicle ${vin} has broken span coverage at ${second}` });
      }
      second = end;
      if (spans.kind![span] !== moving) continue;
      if (previous >= 0) {
        const jump = transport.haversineKm({ lat: legs.toLatE6![previous]! / 1e6, lon: legs.toLonE6![previous]! / 1e6 },
          { lat: legs.fromLatE6![leg]! / 1e6, lon: legs.fromLonE6![leg]! / 1e6 });
        if (jump > JUMP_KM) {
          breaks.push({ key: `${vin}|jump|${legKey(previous)}|${legKey(leg)}`,
            message: `vehicle ${vin} jumps ${Math.round(jump * 1000)} m between legs ${previous} and ${leg}` });
        }
      }
      previous = leg;
    }
    if (second !== 86_400) breaks.push({ key: `${vin}|end|${second}`, message: `vehicle ${vin} span coverage does not end at midnight` });
  }
  if (offset !== spans.startSecond!.length) return { breaks, structural: "vehicle span row count mismatch" };
  return { breaks, structural: null };
}

/** Furthest a VIN may be from the end of its previous leg when the next one starts. */
const JUMP_KM = 0.1;

/**
 * The vehicle defects already in a file, by key.
 *
 * The exporter tolerates a few vehicle timelines it cannot make chain (a
 * cabbie whose day the scheduler shifted past the next driver's start, a
 * carried cab that reappears elsewhere) and writes the day with a warning.
 * A scenario cannot mend those and must not be failed for them; it is
 * failed for any it adds, including on the same vehicle.
 */
export async function brokenVehicleSpans(file: products.KdayFile): Promise<Set<string>> {
  return new Set((await vehicleBreaks(file)).breaks.map((row) => row.key));
}

export async function validateProduct(file: products.KdayFile, tolerated: ReadonlySet<string> = new Set()): Promise<void> {
  const p = await file.table("person");
  for (const [table, field] of Object.entries({ schedule: "start", leg: "depart", tx: "minute", span: "start", event: "minute", attention: "start" })) {
    let offset = 0;
    for (let i = 0; i < p.id!.length; i++) {
      if (p[`${table}Offset`]![i] !== offset) throw new Error(`non-contiguous ${table} CSR at person ${p.id![i]}`);
      offset += p[`${table}Count`]![i]!;
    }
    if (offset !== file.count(`${table}.${field}`)) throw new Error(`${table} row count mismatch`);
  }
  const legs = await file.table("leg");
  const paths = await file.table("path");
  for (let i = 0; i < legs.depart!.length; i++) {
    if (legs.pathOffset![i]! + legs.pathCount![i]! > file.count("path.latE6")) throw new Error("leg path reference out of bounds");
    if (legs.pathCount![i]! > 0) {
      const first = legs.pathOffset![i]!, last = first + legs.pathCount![i]! - 1;
      if (paths.latE6![first] !== legs.fromLatE6![i] || paths.lonE6![first] !== legs.fromLonE6![i]
          || paths.latE6![last] !== legs.toLatE6![i] || paths.lonE6![last] !== legs.toLonE6![i]) throw new Error(`leg ${i} geometry does not match its endpoints`);
    }
  }
  for (const [column, target] of Object.entries({ "sms.message": "message.at", "cdr.call": "call.at",
    "message.conversation": "conversation.at", "call.conversation": "conversation.at", "participant.account": "account.person" })) {
    if (!file.has(column)) continue;
    for (const reference of await file.column(column)) if (reference < 0 || reference >= file.count(target)) throw new Error(`${column} reference out of bounds`);
  }
  const { breaks, structural } = await vehicleBreaks(file);
  if (structural) throw new Error(structural);
  const added = breaks.find((row) => !tolerated.has(row.key));
  if (added) throw new Error(added.message);
}

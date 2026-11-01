/** Who rings and when: a person and a minute, placed wherever their day has them. The dispatch day runs 07:00–07:00 (minutes 420..1860) so every watch and platoon is owned whole by one date. */

import { homeOf, type Person, type World } from "../world/index.ts";
import { LAYER, mix, Rng } from "../shared/index.ts";
import { CALLS_PER_THOUSAND_PER_DAY, HOURLY_SHARE, INCIDENT_KINDS, type PlaceClass } from "./kinds.ts";

export const DISPATCH_DAY_START = 7 * 60;
export const DISPATCH_DAY_END = 31 * 60;

const CALLER_MIN_AGE = 16;

const RESPONDERS: ReadonlySet<string> = new Set(["police_officer", "paramedic", "emt"]);

export interface CallDraw {
  index: number;
  caller: number;
  /** Minute in the planning frame, 420..1859. */
  minute: number;
}

const eligibleCache = new WeakMap<World, Person[]>();

function eligible(world: World): Person[] {
  const known = eligibleCache.get(world);
  if (known) return known;
  const out: Person[] = [];
  for (const person of world.persons.values()) {
    if (person.age < CALLER_MIN_AGE) continue;
    if (RESPONDERS.has(world.assignments.get(person.id)?.role ?? "")) continue;
    if (!homeOf(world, person)) continue;
    out.push(person);
  }
  out.sort((a, b) => a.id - b.id);
  eligibleCache.set(world, out);
  return out;
}

function poisson(rng: Rng, mean: number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let count = 0;
  let product = rng.next();
  while (product > limit) {
    count += 1;
    product *= rng.next();
  }
  return count;
}

/** The day's calls in minute order; the rate is per resident, the draw is from adults who are not responders. */
export function sampleCalls(world: World, day: number, people?: readonly Person[]): CallDraw[] {
  const everyone = eligible(world);
  const pool = people ? (() => { const ok = new Set(everyone); return people.filter((p) => ok.has(p)); })() : everyone;
  if (pool.length === 0) return [];
  const residents = people ? people.length : world.persons.size;
  const rng = new Rng(mix(world.seed, LAYER.calls, day));
  const share = HOURLY_SHARE.reduce((total, value) => total + value, 0);
  const daily = (CALLS_PER_THOUSAND_PER_DAY * residents) / 1000;

  const draws: CallDraw[] = [];
  const taken = new Set<number>();
  for (let hour = DISPATCH_DAY_START / 60; hour < DISPATCH_DAY_END / 60; hour += 1) {
    const count = poisson(rng, (daily * HOURLY_SHARE[hour % 24]!) / share);
    for (let n = 0; n < count; n += 1) {
      let caller = pool[rng.int(0, pool.length - 1)]!;
      for (let attempt = 0; taken.has(caller.id) && attempt < 8; attempt += 1) {
        caller = pool[rng.int(0, pool.length - 1)]!;
      }
      if (taken.has(caller.id)) continue;
      taken.add(caller.id);
      draws.push({ index: draws.length, caller: caller.id, minute: hour * 60 + rng.int(0, 59) });
    }
  }
  draws.sort((a, b) => a.minute - b.minute || a.caller - b.caller);
  return draws.map((draw, index) => ({ ...draw, index }));
}

export function drawKind(rng: Rng, at: PlaceClass): number {
  const weights = INCIDENT_KINDS.map((kind) => kind.at[at]);
  const indices = INCIDENT_KINDS.map((_, index) => index);
  return rng.weighted(indices, weights);
}

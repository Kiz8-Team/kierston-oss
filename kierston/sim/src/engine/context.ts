/**
 * The context every simulated day is planned against, and how it is built.
 *
 * Split from the scheduler because of what it costs and how long it lasts. The
 * road graph, the venue index, the org calendar and the cab stands are derived
 * once from the population and then read for every person on every date — none
 * of them depends on which day is being planned, and deriving them per day
 * would dwarf the planning itself. What *does* vary by date is the fleet, and
 * it is the one field on the context that a caller is expected to replace.
 */

import { join } from "node:path";
import { Affiliations, Graph } from "../activities/social/index.ts";
import type { Bank, Bills } from "../economy/index.ts";
import type { Network } from "../network/index.ts";
import type { Comms } from "../comms/index.ts";
import type { CommuteContext } from "../activities/work/index.ts";
import { SIM_DATA_DIR, loadWorld, type Person, type World } from "../world/index.ts";
import type { HirePolicy } from "../transport/index.ts";
import { Kerb, Roads, stands, type Fleet, type Stand } from "../transport/index.ts";
import type { TourContext } from "../activities/discretionary/index.ts";
import { Venues } from "../activities/discretionary/index.ts";
import type { SimulationState } from "./state.ts";
import type { HouseholdDayPlanner } from "../scheduler/index.ts";
import type { CallsForService } from "../dispatch/index.ts";

export interface DayContext extends CommuteContext, TourContext {
  /** Canonical POIs, including non-commercial destinations such as parking. */
  poiCatalog?: readonly { id: string; lat: number; lon: number; tag: string; name: string }[];
  world: World;
  venues: Venues;
  affiliations: Affiliations;
  /**
   * The tie graph, which every run needs and not only the ones packing phone
   * traffic.
   *
   * It used to be loaded by the communications layer alone, and that was
   * correct while a tie's only consequence was a text message. A shared
   * activity is a consequence of a tie that changes where somebody physically
   * goes, so a run without this would plan a different — and quietly wrong —
   * day. Half a second and some tens of megabytes, once.
   */
  ties: Graph;
  /**
   * The city's cab stands, which are static and cost a clustering pass to
   * derive, so they are built once with the context rather than per day.
   */
  stands?: readonly Stand[];
  /**
   * Today's cab allocation, where `dispatchFor` has been run for today.
   *
   * Optional because it has to be: the pass that produces it works by planning
   * days without it. A day planned with no fleet is not a broken day — it is
   * the demand pass, and every taxi leg in it is a request nobody has answered
   * yet.
   */
  fleet?: Fleet | null;
  /** The day's calls for service, dispatched before planning like the fleet. */
  calls?: CallsForService | null;
  /** Date-local coordinator that executes all members against one household VIN pool. */
  householdPlanner?: HouseholdDayPlanner;
  /**
   * Who is taken to have no car, and how often they pay for one.
   *
   * On the context so the sweep that fitted it can vary it without editing the
   * module it lives in. Absent is `hire.ts`'s own default, which is what every
   * ordinary run uses.
   */
  hire?: HirePolicy;
  /**
   * The bank, where the caller wants the day paid for as well as planned.
   *
   * Optional, and optional in a way the fleet is not. Every other field here is
   * derived once and then only read; this one holds live balances, so a caller
   * that keeps it across dates is accumulating a ledger and a caller that
   * reloads it per date is not. `spend.ts` says why that difference matters and
   * why nothing inside `planDay` is allowed to touch it.
   */
  bank?: Bank;
  /**
   * The city's recurring commitments, where the caller wants them billed.
   *
   * Loaded beside the bank and for the same reason — a run that is not
   * settling money has no use for a rent schedule — but unlike the bank this
   * one is immutable. It is a set of rules; nothing in a simulated day writes
   * to it, and two dates read it identically.
   */
  bills?: Bills;
  /**
   * The cellular network, where the caller wants the day's radio life as well.
   *
   * Optional in the same way the bank is optional and immutable in the way the
   * bills are. A run that is inspecting one person's commute has no use for
   * two and a half thousand cells and ninety-eight thousand subscribers, and
   * loading them costs a second nobody asked to spend; a run that is packing a
   * day for a consumer needs nothing else.
   */
  network?: Network;
  /**
   * The communications layer, where the caller wants the day's conversations.
   *
   * Optional on the same terms as the network, with one difference that
   * matters to anyone assembling a run: it is *stateful across the day* in a
   * way none of the others are. A conversation cannot be resolved until every
   * party's day has been planned, so the layer accumulates one attention curve
   * per person as the caller streams them past and only produces records when
   * asked afterwards. A caller that runs two dates against one instance must
   * call `reset` between them; a caller that plans a cohort and expects the
   * whole city's traffic will get the cohort's, which is the honest answer.
   */
  comms?: Comms;
  /** The authoritative opening/closing boundary for a chronological run. */
  state?: SimulationState;
}

/**
 * A slice of the city, for a run that does not want the whole of it.
 *
 * Almost everything in `planDay` is a fact about one person — the kerb is a
 * static supply grid, the school runs and the org calendar are artefacts built
 * before the day starts, and every draw is seeded on the person's own id — so
 * planning a thousand people costs a thousand people and nothing else has to be
 * present for it.
 *
 * The fleet is the exception, and the reason this carries a step as well as a
 * list. A cab allocation is the one object in the day that is made out of
 * everybody at once: what a passenger's journey costs them depends on how many
 * other people are asking for a car at that minute and how many drivers are on
 * the road. Serve a thousandth of the demand with the whole fleet and every
 * fare is answered on the spot, which is not a cheaper version of the city's
 * day but a different one — nobody waits, nobody gives up and walks, and the
 * two figures `hire.ts` was fitted to (fares per shift, the empty share) stop
 * meaning anything. So the step is the fraction the drivers are thinned by too,
 * and the contention survives the shrink.
 */
export interface Cohort {
  /** The people this run plans. */
  people: readonly Person[];
  /** One person in every `step` was kept, and one driver in every `step` too. */
  step: number;
}

/** Parking POIs, which are the fallback when the kerb is full. */
async function loadLots(): Promise<{ lots: { lat: number; lon: number }[]; all: { lat: number; lon: number }[]; catalog: NonNullable<DayContext["poiCatalog"]> }> {
  const pois = (await Bun.file(join(SIM_DATA_DIR, "pois.json")).json()) as {
    groups: { types: { i: number; id: string }[] }[];
    points: unknown[][];
  };
  const types = new Map<number, string>();
  for (const group of pois.groups) for (const type of group.types) types.set(type.i, type.id);
  const lots: { lat: number; lon: number }[] = [];
  const all: { lat: number; lon: number }[] = [];
  const catalog: { id: string; lat: number; lon: number; tag: string; name: string }[] = [];
  for (const [index, point] of pois.points.entries()) {
    const place = { lat: point[0] as number, lon: point[1] as number };
    all.push(place);
    const id = types.get(point[3] as number);
    catalog.push({ ...place, id: `poi/${index}`, tag: id ?? "", name: point[4] as string });
    if (id === "amenity=parking" || id === "amenity=parking_entrance") lots.push(place);
  }
  return { lots, all, catalog };
}

/**
 * Everything static, loaded once.
 *
 * The venue merge in the middle is the one non-obvious step: venues resolve
 * through the same id table as everything else, so a stop can be pointed at by
 * id the way a workplace or an org can. A venue that is also an org keeps the
 * org's coordinates — `orgs.json` was built with more knowledge of what the
 * building is than the OSM tag alone carries.
 */
export async function loadDayContext(): Promise<DayContext> {
  const [world, roads, pois] = await Promise.all([loadWorld(), Roads.open(), loadLots()]);
  const [venues, affiliations, ties] = await Promise.all([
    Venues.open(world.seed), Affiliations.open(world.seed), Graph.open(),
  ]);
  const kerb = Kerb.build(roads, pois.all, pois.lots);
  for (const [id, point] of venues.points()) if (!world.places.has(id)) world.places.set(id, point);
  for (const poi of pois.catalog) world.places.set(poi.id, { lat: poi.lat, lon: poi.lon });
  return { world, roads, kerb, venues, affiliations, ties, poiCatalog: pois.catalog, stands: stands(world), fleet: null };
}

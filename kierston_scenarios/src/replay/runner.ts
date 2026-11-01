import { SimulationState, checkpointFromKday, loadDayContext, products, economy, network, comms, shared, transport, world,
  type DayContext, type StateCheckpoint } from "../../../kierston/sim/src/index.ts";
import { ScenarioBuilder, seedFor, type Action, type ScenarioDefinition, type Communication, type Mute, type Purchase, type Window } from "../authoring/dsl.ts";
import { Baseline, type RecordedDay } from "./baseline.ts";
import { personColumns, keepUnchangedTables, replacePeople } from "../storage/columns.ts";
import { moveActor, resolveTime, type Realized } from "./movement.ts";
import { settleActor } from "../effects/money.ts";
import { cellLookup, refreshCarrier, appendExchange } from "../effects/communications.ts";
import { reconcileScripted, type Collisions } from "./collisions.ts";
import { truncateForTheDead, truncateForTheParted, muteExchanges, silenceAttention } from "../effects/mortality.ts";
import { refreshAlpr } from "../effects/sensors.ts";
import { updateMeetings, repairMeetings } from "./meetings.ts";
import { validateSharedJourneys } from "./validation.ts";
import { validateProduct, brokenVehicleSpans } from "../storage/validation.ts";
import { PriorityTaxis } from "./taxi.ts";
import { writeDelta } from "../storage/delta.ts";
import { distinctOutput } from "../storage/paths.ts";
import { resolveRunOptions, type ScenarioRunOptions, type ResolvedRunOptions } from "../authoring/run.ts";
import { replayJointActions } from "./joint.ts";
import { rebuildVehicleProduct } from "./vehicles.ts";
import { DayBoundaryError } from "../authoring/schedule.ts";

export interface ApplyOptions extends ScenarioRunOptions {
  scenario: ScenarioDefinition;
  /** Resolve relative script defaults here; CLI/API path overrides still use cwd. */
  scenarioPath?: string;
  sourceHash?: string;
  status?: (message: string) => void;
  /** Reuse already loaded immutable assets; mutable state is always restored. */
  context?: DayContext;
}
export interface ScenarioResult {
  output: string;
  format: "KDIF";
  baseHash: string;
  affected: { person: number; reasons: string[] }[];
  actions: { id: string; kind: string; result: Realized }[];
  seed: number;
  /** Group members the roads or the network could not deliver, and why. */
  dropped: { person: number; reason: string }[];
  /** Group communications the engine declined, and why. Not failures. */
  skipped: { id: string; reason: string }[];
  groups: Record<string, number[]>;
}

/** Minutes between attempts when a call goes unanswered and the caller tries again. */
const RETRY_GAP_SECONDS = 150;

function mergeRows<T>(original: T[], replacement: T[], key: (row: T) => number, changed: ReadonlySet<number>): T[] {
  const byId = new Map(replacement.filter((row) => changed.has(key(row))).map((row) => [key(row), row]));
  const known = new Set(original.map(key));
  return [...original.map((row) => byId.get(key(row)) ?? row), ...replacement.filter((row) => changed.has(key(row)) && !known.has(key(row)))];
}

function participants(action: Action): number[] {
  if ("people" in action) return action.people;
  return [action.person];
}
const physicalKind = (action: Action, person: number): boolean =>
  (action.kind === "goto" && action.person === person)
  || ((action.kind === "trip" || action.kind === "stay" || action.kind === "wait") && action.people.includes(person))
  || ((action.kind === "perish" || action.kind === "handset") && action.person === person);

/**
 * When the owner is back with the phone: the first arrival within
 * `REUNION_METRES` of it after having been further away, or midnight. The
 * walk out to the car ends beside the house too, so leaving does not count.
 */
const REUNION_METRES = network.REUNION_METRES;
function reunitedAt(legs: readonly transport.Leg[], hold: { from: number; at: { lat: number; lon: number } }): number {
  let away = false;
  for (const leg of [...legs].sort((a, b) => a.arrive - b.arrive)) {
    if (leg.depart < hold.from) continue;
    const near = transport.haversineKm(leg.to, hold.at) * 1000 <= REUNION_METRES;
    if (!near) away = true;
    else if (away) return Math.max(hold.from, Math.floor(leg.arrive));
  }
  return 1440;
}

async function openingFor(options: ResolvedRunOptions): Promise<StateCheckpoint> {
  if (!options.openingState) return checkpointFromKday(options.input, "opening");
  const file = Bun.file(options.openingState);
  const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  return magic === "KDAY" ? checkpointFromKday(options.openingState) : file.json();
}

export async function applyScenario(provided: ApplyOptions): Promise<ScenarioResult> {
  try { return await applyScheduledScenario(provided, false); }
  catch (error) {
    if (!(error instanceof DayBoundaryError)) throw error;
    provided.status?.("Moving the schedule earlier to finish before midnight");
    return applyScheduledScenario(provided, true);
  }
}

async function applyScheduledScenario(provided: ApplyOptions, earlyStart: boolean): Promise<ScenarioResult> {
  const options = { ...provided, ...resolveRunOptions(provided.scenario, provided, provided.scenarioPath) };
  await distinctOutput(options.output, [options.input, ...(options.openingState ? [options.openingState] : []),
    ...(options.scenarioPath ? [options.scenarioPath] : [])]);
  const limit = options.maxAffected;
  const status = options.status ?? (() => {});
  status("Reading base day and checkpoints");
  const file = await products.KdayFile.open(options.input);
  try {
    if (![14, 15, 16].includes(file.header.version) || !file.has("tx.person") || !file.has("leg.vehicle")
        || !file.has("vehicleSpan.kind")) {
      throw new Error("scenario replay requires vehicle-tracked KDAY v14 to v16; regenerate the base day");
    }
    const [opening, closing, inputHash] = await Promise.all([
      openingFor(options), checkpointFromKday(options.input), products.fileDigest(options.input),
    ]);
    if (opening.nextDate !== file.header.date) throw new Error("opening checkpoint is not the start of the input day");
    if (closing.completedDays !== opening.completedDays + 1 || opening.coldStart !== closing.coldStart) throw new Error("checkpoint chronology mismatch");
    const provenance = await products.replayProvenance();
    if (file.header.replayProvenance && JSON.stringify(file.header.replayProvenance) !== JSON.stringify(provenance)) {
      throw new Error("engine or city assets differ from the base KDAY; regenerate it before applying a scenario");
    }
    status("Loading matching city assets");
    const context = options.context ?? await loadDayContext();
    context.network ??= await network.Network.open();
    context.comms ??= await comms.Comms.open(context.network.subscribers, context.ties);
    context.comms.reset();
    context.fleet = null;
    context.state = SimulationState.restore(opening, economy.Bank.load());
    context.bank = context.state.bank;
    context.state.beginTransition();
    const date = shared.parseDate(file.header.date), day = shared.dayNumber(date);
    if (day !== file.header.day) throw new Error("KDAY day number does not match its date");
    if (shared.dayNumber(shared.parseDate(closing.nextDate)) !== day + 1) throw new Error("closing checkpoint is not the end of the input day");
    const baseline = await Baseline.open(file, context);
    await baseline.preload();
    const toleratedVehicles = await brokenVehicleSpans(file);
    const scene = new ScenarioBuilder(
      options.scenario.name, options.seed, context, new Set(baseline.people.keys()), baseline.vehicles, baseline, earlyStart,
    );
    await options.scenario.build(scene);
    const affected = new Map<number, Set<string>>();
    const involve = (person: number, reason: string) => {
      if (comms.isService(person)) return;
      if (!baseline.people.has(person)) throw new Error(`affected person ${person} is absent from the input KDAY`);
      const reasons = affected.get(person) ?? new Set<string>(); reasons.add(reason); affected.set(person, reasons);
    };
    const realized = new Map<string, Realized>();
    const changed = new Map<number, RecordedDay>();
    const windows = new Map<number, Window[]>();
    for (const actor of scene.actorsById.values()) if (scene.actions.some((action) => physicalKind(action, actor.id))) {
      windows.set(actor.id, actor.windows);
    }
    const taxis = new PriorityTaxis(context, baseline, date, changed, windows, involve);
    status("Resolving movement and affected people");
    const dropped = new Map<number, string>();
    const joint = await replayJointActions(context, baseline, windows, scene.actions, date, realized,
      (action, from, at) => taxis.request(action, from, at), dropped);
    for (const [person, day] of joint) changed.set(person, day);
    // A fare the joint replay took displaces its passenger, and the reroute can
    // swallow that passenger's later booked ride. Cancel those bookings on the
    // driver's side before the shared-journey check below, or it sees the
    // driver still carrying somebody who is no longer there. Run again after
    // `goto` actors, whose taxis are requested later.
    await taxis.reconcile();
    const droppable = new Set(scene.actions.flatMap((action) => "droppable" in action && action.droppable ? participants(action) : []));
    await validateSharedJourneys(baseline, changed, droppable, dropped);
    for (const person of dropped.keys()) windows.delete(person);
    // A dropped member takes every action of theirs with them, including the
    // texts and calls: a person the roads never delivered to the hall did not
    // ring home from it either.
    const actions = scene.actions.filter((action) => !participants(action).some((person) => dropped.has(person)));
    for (const requirement of scene.requirements) {
      const kept = requirement.people.filter((person) => !dropped.has(person)).length;
      if (kept < requirement.minCount) {
        const reasons = requirement.people.filter((person) => dropped.has(person)).slice(0, 5).map((person) => `${person}: ${dropped.get(person)}`);
        throw new Error(`${requirement.action}: only ${kept} of ${requirement.people.length} members of ${requirement.group} were feasible; minCount is ${requirement.minCount}. First drops: ${reasons.join("; ")}`);
      }
    }
    for (const action of actions) {
      for (const person of participants(action)) involve(person, `actor: ${action.id}`);
      if (action.kind === "text" || action.kind === "call") involve(action.to, `recipient: ${action.id}`);
    }
    for (const actor of scene.actors.values()) {
      if (!actions.some((action) => action.kind === "goto" && action.person === actor.id)) continue;
      if (actions.some((action) => (action.kind === "trip" || action.kind === "stay" || action.kind === "wait")
          && action.people.includes(actor.id))) throw new Error(`person ${actor.id}: cannot mix goto with trip/stay/wait in one scenario`);
      const recorded = changed.get(actor.id) ?? await baseline.person(actor.id);
      const result = await moveActor(context, recorded, actor.windows, actions, date, realized,
        (action, from, at) => taxis.request(action, from, at));
      changed.set(actor.id, result);
    }
    await taxis.reconcile();
    // A meeting somebody re-planned has left: a counterpart left alone waits
    // and leaves, and a bill whose payer left passes to a remaining party.
    const meetingRepair = await repairMeetings(context, baseline, changed, windows, date);
    for (const [person, stood] of meetingRepair.stoodUp) {
      involve(person, `stood up at meeting ${stood.meeting}`);
      changed.set(person, stood.day);
      windows.set(person, [stood.window]);
    }
    for (const purchase of meetingRepair.payers) involve(purchase.person, `pays for meeting: ${purchase.id}`);
    if (affected.size > limit) throw new Error(`scenario exceeds maxAffected=${limit}; ${affected.size} people are affected`);
    const physical = new Set(changed.keys());
    await validateSharedJourneys(baseline, changed);
    const deaths = new Map<number, number>();
    for (const action of actions) if (action.kind === "perish") {
      const at = realized.get(action.id)!.start;
      deaths.set(action.person, Math.min(deaths.get(action.person) ?? 1440, at));
    }
    // A mute is not physical: it is realized here so the report can list it.
    for (const action of actions) if (action.kind === "mute") {
      realized.set(action.id, { person: action.people[0], start: action.from, arrival: action.from, departure: action.until, people: action.people });
    }
    // People whose phone stays on them all day: a scripted `keepHandset`, and
    // anyone the script makes place a call that may not be dropped, because a
    // day draw that parts them from the phone would fail the run.
    const keeps = new Set<number>();
    for (const action of actions) {
      if (action.kind === "handset-keep") {
        keeps.add(action.person);
        realized.set(action.id, { person: action.person, start: 0, arrival: 0, departure: 1440, people: [action.person] });
      }
      if ((action.kind === "call" || action.kind === "text") && !action.droppable) keeps.add(action.person);
    }
    const holds = new Map<number, { from: number; at: { lat: number; lon: number }; outdoors: boolean }>();
    for (const action of actions) if (action.kind === "handset") {
      const done = realized.get(action.id)!;
      holds.set(action.person, { from: done.start, at: { lat: done.lat as number, lon: done.lon as number }, outdoors: Boolean(done.outdoors) });
    }
    // Minutes each living person had no phone on them: a scripted hold until
    // the reunion, or the day's own left-at-home draw while out of the house.
    const parted = new Map<number, { from: number; until: number }[]>();
    const financial = new Set<number>(file.header.counts.banked ? physical : []);
    const purchases = [...actions.filter((action): action is Purchase => action.kind === "purchase"), ...meetingRepair.payers];
    for (const purchase of purchases) financial.add(purchase.person);
    for (const person of affected.keys()) {
      const recorded = changed.get(person) ?? await baseline.person(person);
      if (physical.has(person)) {
        context.comms.observe(recorded.day, context.world.persons.get(person)!, context.world.assignments.get(person)?.occupation ?? null,
          context.world.seed, day);
        if (deaths.has(person)) context.comms.silence(person, deaths.get(person)!);
        // A phone left behind cannot be used by its owner: nothing sent,
        // nothing answered, until the owner's own legs bring them back to
        // where it lies — or never, for a phone thrown from a car.
        const hold = holds.get(person);
        const spans: { from: number; until: number }[] = [];
        if (hold && !deaths.has(person)) spans.push({ from: hold.from, until: reunitedAt(recorded.day.legs, hold) });
        // The day's own draws, as on a plain day: power-off, dead battery,
        // and (without a scripted hold) left at home while out of the house.
        // A kept handset has none of them.
        if (!deaths.has(person) && !keeps.has(person) && context.network) {
          spans.push(...context.network.partedFromHandsets(recorded.day, world.homeOf(context.world, context.world.persons.get(person)!),
            day, context.world.seed, null, hold !== undefined) ?? []);
        }
        if (spans.length) parted.set(person, spans);
        for (const span of spans) context.comms.partFromHandset(person, span.from, span.until);
      } else {
        // The stored curve includes the original temperament and break draws.
        const local = await personColumns(file, baseline.people.get(person)!);
        const minute = new Uint8Array(1440), asleep = new Uint8Array(1440);
        local.attentionStart.forEach((start, i) => {
          const end = local.attentionStart[i + 1] ?? 1440;
          minute.fill(local.attentionLevel[i]!, start, end); asleep.fill(local.attentionAsleep[i]!, start, end);
        });
        // A frozen person keeps the day's handset draws too, so a scripted
        // call to them rings out in the minutes their phone was off or at home.
        const away = context.network && !keeps.has(person)
          ? context.network.partedFromHandsets(recorded.day, world.homeOf(context.world, context.world.persons.get(person)!), day, context.world.seed, null)
          : null;
        if (away?.length) parted.set(person, away);
        context.comms.adopt({ person, age: context.world.persons.get(person)!.age,
          attention: { known: local.attentionStart.length > 0, minute, asleep },
          anchors: recorded.day.legs.flatMap((leg) => [leg.depart, leg.arrive]), held: [], ...(away?.length ? { parted: away } : {}) });
      }
    }
    status("Resolving scripted exchanges and replies");
    const exchanges: { action: Communication; result: comms.DayComms }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const action of actions) {
      if (action.kind !== "text" && action.kind !== "call") continue;
      if (!file.header.counts.messaged || !file.header.counts.networked) throw new Error("communications require a networked/messaged base day");
      const at = Math.round(resolveTime(action.at, realized) * 60);
      if (at >= 86400 || at + (action.duration ?? 0) > 86400) throw new DayBoundaryError(`${action.id}: exchange crosses midnight`);
      const attempt = (second: number, index: number): comms.DayComms => {
        const result = context.comms!.request({ from: action.person, to: action.to, at: second,
          channel: comms.CHANNELS.indexOf(action.platform), kind: action.kind, bytes: action.bytes,
          replies: action.replies, duration: action.duration,
          outcome: action.outcome === undefined ? undefined : comms.CALL_OUTCOMES.indexOf(action.outcome),
          seed: seedFor(options.seed, `${scene.name}/exchange/${action.id}${index ? `/retry/${index}` : ""}`),
        }, context.world.seed, day, context.world, date);
        if (result.calls.some((call) => call.at + call.ring + call.duration > 86400)
          || result.messages.some((message) => message.at >= 86400)) throw new DayBoundaryError(`${action.id}: exchange crosses midnight`);
        if (result.messages.length + result.calls.length === 0) throw new Error(`${action.id}: the engine could not produce the requested exchange`);
        return result;
      };
      let attempts = 0;
      try {
        let second = at;
        for (let index = 0; index <= (action.retries ?? 0); index++) {
          if (second >= 86400) break;
          // The radio is not told about scripted calls. Organic calls are
          // projected over spans whose connected state is the radio's own
          // random bearer chain, and the carrier rows (callCells) read only
          // the serving cell, which does not depend on that state. Forcing
          // connected minutes for scripted calls alone made them stand out
          // in the event table by their handovers.
          const result = attempt(second, index);
          exchanges.push({ action, result });
          attempts++;
          const placed = result.calls.find((call) => call.callback < 0);
          if (action.kind !== "call" || !placed || placed.outcome === comms.outcomeOf("answered")) break;
          second = placed.at + placed.ring + RETRY_GAP_SECONDS;
        }
      } catch (error) {
        if (error instanceof DayBoundaryError) throw error;
        if (!(error instanceof Error)) throw error;
        if (!action.droppable || attempts) throw new Error(`${action.id}: ${error.message}`, { cause: error });
        skipped.push({ id: action.id, reason: error.message });
        realized.set(action.id, { person: action.person, start: at / 60, arrival: at / 60, departure: at / 60,
          recipient: action.to, platform: action.platform, skipped: error.message });
        continue;
      }
      realized.set(action.id, { person: action.person, start: at / 60, arrival: at / 60, departure: at / 60,
        recipient: action.to, platform: action.platform, attempts });
    }
    status(`Simulating downstream effects for ${affected.size} people`);
    const replacement = new Map<number, products.DayColumns>();
    const subscribers = new Set<number>();
    // This loop is where a crowd scenario spends its minutes; say how far it
    // is every couple of seconds so a caller drawing progress can show it.
    let lastReported = Date.now();
    for (const [index, person] of [...affected.keys()].sort((a, b) => a - b).entries()) {
      if (Date.now() - lastReported >= 2000) {
        lastReported = Date.now();
        status(`Simulating downstream effects for ${affected.size} people · ${index}/${affected.size} done`);
      }
      const recorded = changed.get(person) ?? await baseline.person(person);
      // Resolve newly routed paths once; packPerson and radio share them.
      for (const leg of recorded.day.legs) if (!recorded.paths.has(products.pathKey(leg))) {
        recorded.paths.set(products.pathKey(leg), (leg.journeyId ? recorded.paths.get(leg.journeyId) : undefined)
          ?? context.roads.path(leg.from, leg.to, leg.mode === "walk"));
      }
      const posted = financial.has(person)
        ? await settleActor(context, baseline, person, recorded, windows.get(person) ?? [], purchases.filter((p) => p.person === person), realized, date, deaths.get(person))
        : [];
      const packed = products.emptyColumns();
      const hold = holds.get(person);
      products.packPerson(context, context.world.persons.get(person)!, date, day, packed, file.strings, products.radioScratch(), new shared.Timings(),
        { planned: recorded.day, posted, paths: recorded.paths, keepHandset: keeps.has(person),
          ...(hold ? { handsetHold: { from: hold.from, at: hold.at, outdoors: hold.outdoors } } : {}) });
      if (deaths.has(person)) silenceAttention(packed, deaths.get(person)!);
      const tables = new Set<string>(file.header.counts.networked ? ["span", "event"] : []);
      if (physical.has(person)) for (const table of ["schedule", "leg", "path", "attention"]) tables.add(table);
      if (financial.has(person)) tables.add("tx");
      const base = await personColumns(file, baseline.people.get(person)!);
      replacement.set(person, keepUnchangedTables(base, packed, tables));
      if (file.header.counts.networked) for (const subscriber of context.network.subscribers.forPerson(person)) subscribers.add(subscriber.index);
    }
    status(`Writing ${replacement.size} replaced people back into the day`);
    const legMap = replacement.size ? await replacePeople(file, replacement) : new Int32Array();
    if (physical.size) status("Rebuilding the vehicle product for the changed routes");
    const closingVehicles = physical.size ? await rebuildVehicleProduct(context, file) : closing.vehicles;
    if (process.env.SCENARIO_DEBUG_VEHICLES) {
      const [pp, ll] = await Promise.all([file.table("person"), file.table("leg")]);
      const owner = new Map<number, number>();
      for (let row = 0; row < pp.id!.length; row++) for (let i = pp.legOffset![row]!; i < pp.legOffset![row]! + pp.legCount![row]!; i++) owner.set(i, pp.id![row]!);
      const byVin = new Map<string, number[]>();
      for (let i = 0; i < ll.depart!.length; i++) {
        const vin = file.string(ll.vehicle![i]!);
        if (!vin) continue;
        const list = byVin.get(vin) ?? []; list.push(i); byVin.set(vin, list);
      }
      let shown = 0;
      for (const [vin, legs] of byVin) {
        legs.sort((a, b) => ll.depart![a]! - ll.depart![b]!);
        for (let k = 1; k < legs.length && shown < 8; k++) {
          const a = legs[k - 1]!, b = legs[k]!;
          const gap = transport.haversineKm({ lat: ll.toLatE6![a]! / 1e6, lon: ll.toLonE6![a]! / 1e6 }, { lat: ll.fromLatE6![b]! / 1e6, lon: ll.fromLonE6![b]! / 1e6 });
          if (gap < 0.1) continue;
          shown++;
          const describe = (i: number) => ({ person: owner.get(i), journey: file.string(ll.journey![i]!), mode: file.header.enums.mode![ll.mode![i]!],
            depart: ll.depart![i], arrive: ll.arrive![i], affected: affected.has(owner.get(i)!), dropped: dropped.has(owner.get(i)!), physical: physical.has(owner.get(i)!) });
          console.error("DEBUG teleport", vin, Math.round(gap * 1000), "m", JSON.stringify([describe(a), describe(b)]));
        }
      }
    }
    const mutes = actions.filter((action): action is Mute => action.kind === "mute");
    const muted = await muteExchanges(file, context.comms.accounts, mutes);
    const truncated = await truncateForTheDead(file, context.comms.accounts, deaths, options.seed);
    const partedTruncation = await truncateForTheParted(file, context.comms.accounts, parted, options.seed);
    let collisions: Collisions = { baseCallsDropped: 0, scriptedFailed: 0, scriptedBusy: 0 };
    if (file.header.counts.networked && affected.size) {
      status(`Refreshing carrier records for ${subscribers.size} subscriptions and ${exchanges.length} exchanges`);
      const lookup = await cellLookup(file);
      for (const { result } of exchanges) context.comms.project(result, context.world.seed, day, lookup, context.world, date);
      // One line per person across recorded and scripted calls; removes
      // recorded rows, so it runs before the carrier refresh and the appends.
      collisions = await reconcileScripted(file, context.comms.accounts, exchanges.map(({ result }) => result), windows, lookup);
      await refreshCarrier(file, subscribers, lookup);
      for (const { action, result } of exchanges) Object.assign(realized.get(action.id)!, await appendExchange(file, result));
    }
    if (physical.size) {
      status("Deriving ALPR observations for changed routes");
      await refreshAlpr(context, file, date, legMap, `scenario/${inputHash.slice(0, 16)}/${seedFor(options.seed, scene.name).toString(16)}`);
      await updateMeetings(file, changed);
    }
    context.state.stageVehicles(closingVehicles);
    context.state.advance(date);
    const partial = context.state.checkpoint(affected.keys());
    // Rejoined days keep their exact original boundary payloads, including
    // work/sleep continuation metadata omitted from analytical schedule rows.
    const explicitMovers = new Set(actions.flatMap((action) => action.kind === "goto" ? [action.person]
      : action.kind === "trip" ? action.people : []));
    partial.persons = partial.persons.map((row) => {
      const original = closing.persons.find((old) => old.person === row.person);
      const intervals = windows.get(row.person) ?? [];
      if (!original || (explicitMovers.has(row.person) && intervals.some((window) => window.end === 1440))) return row;
      return { ...original, vehicle: explicitMovers.has(row.person) ? row.vehicle : original.vehicle };
    });
    const resultingState: StateCheckpoint = { ...closing,
      persons: mergeRows(closing.persons, partial.persons, (row) => row.person, physical),
      bank: mergeRows(closing.bank, partial.bank, (row) => row.person, financial),
      radio: mergeRows(closing.radio, partial.radio, (row) => row.subscriber, subscribers),
      vehicles: partial.vehicles,
    };
    const groups = Object.fromEntries([...scene.groups].map(([role, group]) =>
      [role, group.ids.filter((person) => !dropped.has(person))]));
    const report: ScenarioResult = { output: options.output, format: "KDIF", baseHash: inputHash, seed: options.seed,
      affected: [...affected].sort((a, b) => a[0] - b[0]).map(([person, reasons]) => ({ person, reasons: [...reasons] })),
      actions: actions.map((action) => {
        const result = realized.get(action.id);
        if (!result) throw new Error(`action ${action.id} was not realized`);
        return { id: action.id, kind: action.kind, result };
      }),
      dropped: [...dropped].sort((a, b) => a[0] - b[0]).map(([person, reason]) => ({ person, reason })),
      skipped, groups,
    };
    const [people, legs] = await Promise.all([file.table("person"), file.table("leg")]);
    for (const action of report.actions) {
      if (action.kind === "goto" || action.kind === "trip") action.result.legs = Array.from(legs.journey!, (id, index) => {
        const key = file.string(id);
        return key === `scenario/${action.id}` || key?.startsWith(`scenario/${action.id}/`) ? index : -1;
      }).filter((index) => index >= 0);
      if (action.kind === "purchase") {
        const row = baseline.people.get(action.result.person)!;
        action.result.transactions = [people.txOffset![row]! + Number(action.result.transactionInPerson)];
      }
    }
    file.header.scenario = { format: "KIERSTON_SCENARIO", version: 1, name: options.scenario.name,
      scenarioVersion: options.scenario.version, seed: options.seed, sourceHash: options.sourceHash ?? null, inputHash,
      provenance, isolation: "frozen-background-with-explicit-dependencies", maxAffected: limit,
      actors: Object.fromEntries([...scene.actors].map(([role, actor]) => [role, actor.id])),
      vehicles: Object.fromEntries([...scene.vehicleBindings].map(([role, vehicle]) => [role, vehicle.vin])),
      places: Object.fromEntries([...scene.places].map(([role, place]) => [role, place.id])),
      choices: Object.fromEntries(scene.choices),
      groups, events: scene.events, dropped: report.dropped, skipped,
      deaths: [...deaths].map(([person, minute]) => ({ person, minute })),
      handsetsLeft: [...holds].map(([person, hold]) => ({ person, ...hold })),
      handsetsKept: [...keeps].sort((a, b) => a - b),
      mortality: truncated,
      parted: { intervals: [...parted].map(([person, spans]) => ({ person, spans })), ...partedTruncation },
      lineCollisions: collisions,
      meetingRepair: {
        stoodUp: [...meetingRepair.stoodUp].map(([person, stood]) => ({ person, meeting: stood.meeting, window: stood.window })),
        payers: meetingRepair.payers.map((purchase) => ({ person: purchase.person, id: purchase.id, amount: purchase.amount })),
      },
      muted: mutes.map((mute, index) => ({ people: mute.people, from: mute.from, until: mute.until, ...muted[index]! })),
      affected: report.affected, actions: report.actions, instructions: actions, taxiCancellations: taxis.cancellations };
    status("Validating scenario and writing KDIF delta");
    await validateProduct(file, toleratedVehicles);
    await writeDelta(file, options.output, opening, resultingState, inputHash);
    return report;
  } finally { await file.close(); }
}

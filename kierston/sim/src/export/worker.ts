/**
 * One worker: a slice of the city, planned and packed.
 *
 * The whole justification for this file is in `scheduler/compose.ts` — a
 * planned day is a pure function of one person and the static city, so the
 * order people are planned in cannot matter and neither can the process. What
 * a worker cannot do is anything that is a fact about the *run*: it does not
 * intern into the run's string table, it does not know what row its first
 * person's schedule starts at, and it does not resolve a conversation. It
 * packs a slice, numbers it from zero, and `merge.ts` rebases it.
 *
 * Two things are handed in rather than derived here, and for opposite reasons.
 * The fleet, because it is the one part of a day made out of everybody at once
 * and three workers each matching a third of the demand would put three
 * different cars at three different kerbs. The date, because there is nothing
 * else to say.
 *
 * Everything else is loaded per worker, which is a gigabyte a process and the
 * reason the pool is small. The city is immutable once loaded, so this is
 * duplication rather than contention — three copies of one road graph, three
 * banks whose balances never meet because no two workers hold one person.
 */

import { Fleet, type FleetState } from "../transport/index.ts";
import { Bank, Bills } from "../economy/index.ts";
import { Network } from "../network/index.ts";
import { loadDayContext, type DayContext } from "../engine/index.ts";
import { Timings } from "../shared/index.ts";
import type { Person } from "../world/index.ts";
import type { Meeting } from "../activities/social/index.ts";
import type { Observation } from "../comms/index.ts";
import {
  emptyColumns, packPerson, radioScratch, Strings,
} from "./pack.ts";
import { buffersOf, typedColumns, type Shard } from "./merge.ts";

/** What the main process asks for. */
export type Ask =
  | { kind: "open"; date: number; day: number; fleet: FleetState; money: boolean; radio: boolean }
  | { kind: "pack"; index: number; from: number; to: number }
  | { kind: "close" };

/** What comes back. */
export type Reply =
  | { kind: "open"; milliseconds: number }
  | { kind: "shard"; shard: Shard; timings: Record<string, { ms: number; calls: number }> }
  | { kind: "failed"; message: string };

// The worker global, which is not the `Worker` a page holds a handle to: this
// side has `close` and `postMessage` with no target.
declare const self: {
  onmessage: ((event: MessageEvent<Ask>) => void) | null;
  postMessage(message: Reply, transfer?: ArrayBuffer[]): void;
  close(): void;
};

const timings = new Timings();
let context: DayContext | null = null;
let people: Person[] = [];
let date = new Date();
let day = 0;

async function open(ask: Extract<Ask, { kind: "open" }>): Promise<void> {
  const started = performance.now();
  date = new Date(ask.date);
  day = ask.day;
  context = await loadDayContext();
  if (ask.radio) context.network = await Network.open();
  if (ask.money) {
    context.bank = Bank.load();
    context.bills = Bills.load();
  }
  context.fleet = Fleet.adopt(ask.fleet);
  // The same order the main process walks, because a shard is a range of it.
  people = [...context.world.persons.values()].sort((a, b) => a.id - b.id);
  self.postMessage({ kind: "open", milliseconds: performance.now() - started } satisfies Reply);
}

function pack(ask: Extract<Ask, { kind: "pack" }>): void {
  if (!context) throw new Error("packed before the city was open");
  const columns = emptyColumns();
  const strings = new Strings();
  const radio = radioScratch();
  const observations: Observation[] = [];
  const attended: { person: number; meeting: Meeting }[] = [];
  let spent = 0;

  for (let index = ask.from; index < ask.to; index += 1) {
    const person = people[index]!;
    const packed = packPerson(context, person, date, day, columns, strings, radio, timings);
    spent += packed.spent;
    observations.push(packed.observation);
    for (const meeting of packed.attended) attended.push({ person: person.id, meeting });
  }

  const shard: Shard = {
    index: ask.index,
    columns: typedColumns(columns),
    strings: strings.values,
    spent,
    observations,
    attended,
  };
  self.postMessage(
    { kind: "shard", shard, timings: timings.snapshot() } satisfies Reply,
    buffersOf(shard),
  );
}

self.onmessage = async (event: MessageEvent<Ask>) => {
  const ask = event.data;
  try {
    if (ask.kind === "open") await open(ask);
    else if (ask.kind === "pack") pack(ask);
    else self.close();
  } catch (error) {
    self.postMessage({
      kind: "failed", message: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
    } satisfies Reply);
  }
};

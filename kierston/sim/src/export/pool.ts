/**
 * The workers, and how a shard gets handed out.
 *
 * Small on purpose. The pool owns three things — which slice each worker is
 * on, that the shards reach the merger in person order however they arrive,
 * and that a worker's failure becomes this process's failure rather than a
 * hang — and nothing else. What a worker does with a slice is `worker.ts`;
 * what the merger does with a shard is `merge.ts`.
 *
 * Chunks are handed out as workers come free rather than split evenly up
 * front. A slice of the population is not a fixed amount of work: a shift
 * worker with a car, three errands and a gathering costs several times what a
 * housebound retiree does, and people are packed in id order, which is
 * household order, which is not random with respect to any of that. Static
 * thirds would have every run finish at the pace of its unluckiest third.
 *
 * They arrive out of order, and are merged in order. Buffering is what pays
 * for the difference, and it is bounded by how far ahead the fastest worker
 * can get — a few chunks, not a shard of the city.
 */

import { Timings } from "../shared/index.ts";
import type { FleetState } from "../transport/index.ts";
import type { Shard } from "./merge.ts";
import type { Ask, Reply } from "./worker.ts";

/** What every worker needs before it can pack anything. */
export interface Opening {
  date: Date;
  day: number;
  fleet: FleetState;
  money: boolean;
  radio: boolean;
}

/** One slice of the population, in the order it will be merged. */
export interface Chunk {
  index: number;
  from: number;
  to: number;
}

export class Pool {
  /** Every worker's own stage table, summed. CPU across the pool, not wall clock. */
  readonly timings = new Timings();
  private readonly snapshots = new Map<number, Record<string, { ms: number; calls: number }>>();

  private constructor(private readonly workers: Worker[]) {}

  /**
   * Start the workers and wait for every one of them to have loaded the city.
   *
   * Waiting is deliberate. A worker that is still reading the road graph when
   * the first chunk lands would hold that chunk for the length of the load,
   * and with chunks handed out on completion the pool would spend its first
   * minute looking like it had one worker.
   */
  static async open(count: number, opening: Opening): Promise<Pool> {
    const url = new URL("./worker.ts", import.meta.url).href;
    const workers: Worker[] = [];
    for (let index = 0; index < count; index += 1) workers.push(new Worker(url, { type: "module" }));

    // A worker that cannot open is fatal, and the rest are stopped rather than
    // left running: they hold a gigabyte each and nothing will ever ask them
    // for a shard.
    const opened = Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<Reply>) => {
        if (event.data.kind === "open") resolve();
        else reject(new Error(`worker answered ${event.data.kind} before it was open`));
      };
      worker.onerror = (event) => reject(new Error(String((event as ErrorEvent).message ?? event)));
      worker.postMessage({
        kind: "open",
        date: opening.date.getTime(),
        day: opening.day,
        fleet: opening.fleet,
        money: opening.money,
        radio: opening.radio,
      } satisfies Ask);
    })));
    try {
      await opened;
    } catch (error) {
      for (const worker of workers) worker.terminate();
      throw error;
    }
    return new Pool(workers);
  }

  /**
   * Pack every chunk, calling `onShard` with each in index order.
   *
   * `onIdle` is charged the time this process spends with nothing to do but
   * wait, which is the figure that says whether the pool is big enough: a run
   * that is idle for most of its length is a run whose workers are the
   * bottleneck, and one that is never idle is a run whose merge is.
   */
  run(
    chunks: readonly Chunk[],
    onShard: (shard: Shard) => void,
    onIdle: (milliseconds: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const held = new Map<number, Shard>();
      let handed = 0;
      let merged = 0;
      let idleFrom = performance.now();

      const give = (worker: Worker): void => {
        if (handed >= chunks.length) return;
        const chunk = chunks[handed]!;
        handed += 1;
        worker.postMessage({ kind: "pack", index: chunk.index, from: chunk.from, to: chunk.to } satisfies Ask);
      };

      for (const [index, worker] of this.workers.entries()) {
        worker.onmessage = (event: MessageEvent<Reply>) => {
          const reply = event.data;
          if (reply.kind === "failed") {
            this.close();
            reject(new Error(`worker ${index}: ${reply.message}`));
            return;
          }
          if (reply.kind !== "shard") return;
          onIdle(performance.now() - idleFrom);
          this.snapshots.set(index, reply.timings);
          // Given back before merging, so a worker is never idle while this
          // process is busy with the shard it just handed over.
          give(worker);

          held.set(reply.shard.index, reply.shard);
          for (let next = held.get(merged); next; next = held.get(merged)) {
            held.delete(merged);
            merged += 1;
            onShard(next);
          }
          idleFrom = performance.now();
          if (merged === chunks.length) {
            for (const rows of this.snapshots.values()) this.timings.absorb(rows);
            resolve();
          }
        };
        worker.onerror = (event) => {
          this.close();
          reject(new Error(`worker ${index}: ${(event as ErrorEvent).message}`));
        };
        give(worker);
      }
      if (chunks.length === 0) resolve();
    });
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
  }
}

/** Slice the population into chunks small enough to keep every worker fed. */
export function chunksOf(people: number, size: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let from = 0; from < people; from += size) {
    chunks.push({ index: chunks.length, from, to: Math.min(people, from + size) });
  }
  return chunks;
}

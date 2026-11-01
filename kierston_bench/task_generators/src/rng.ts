/**
 * A small deterministic generator so a task id reproduces its task.
 *
 * mulberry32: one u32 of state, good enough for sampling targets. Not for
 * anything cryptographic, which nothing here is.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, bound). */
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  pick<T>(items: ArrayLike<T>): T {
    if (items.length === 0) throw new Error("cannot pick from an empty collection");
    return items[this.int(items.length)]!;
  }

  /** Fisher–Yates over a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Up to `count` distinct items, order randomised. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }
}

/**
 * Draw until `eligible` accepts, within a sane bound. Generators use this to
 * apply their family's selection rules — a re-identification target must have
 * moved, an occupancy target must have carried somebody — without any one
 * rule turning into an unbounded loop on a day that cannot satisfy it.
 */
export function drawEligible<T>(
  rng: Rng,
  items: ArrayLike<T>,
  eligible: (item: T) => boolean,
  attempts = 500,
): T {
  for (let i = 0; i < attempts; i += 1) {
    const item = rng.pick(items);
    if (eligible(item)) return item;
  }
  throw new Error("no eligible target found; the day may not support this family");
}

/**
 * Binary min-heap over (priority, node) pairs held in typed arrays.
 *
 * There is no decrease-key: a node is pushed again whenever a cheaper path to
 * it is found and stale entries are skipped on pop. That trades a little memory
 * for a heap with no auxiliary index, which is the faster deal in practice.
 */
export class MinHeap {
  private keys: Float64Array;
  private values: Uint32Array;
  private count = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.values = new Uint32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }

  push(key: number, value: number): void {
    if (this.count === this.keys.length) this.grow();
    let child = this.count++;
    const keys = this.keys;
    const values = this.values;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[child] = keys[parent];
      values[child] = values[parent];
      child = parent;
    }
    keys[child] = key;
    values[child] = value;
  }

  /** Removes and returns the lowest-priority node. Empty heap returns -1. */
  pop(): number {
    if (this.count === 0) return -1;
    const keys = this.keys;
    const values = this.values;
    const top = values[0];
    const last = --this.count;
    if (last > 0) {
      const key = keys[last];
      const value = values[last];
      let parent = 0;
      for (;;) {
        let child = parent * 2 + 1;
        if (child >= last) break;
        if (child + 1 < last && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= key) break;
        keys[parent] = keys[child];
        values[parent] = values[child];
        parent = child;
      }
      keys[parent] = key;
      values[parent] = value;
    }
    return top;
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    const values = new Uint32Array(this.values.length * 2);
    keys.set(this.keys);
    values.set(this.values);
    this.keys = keys;
    this.values = values;
  }
}

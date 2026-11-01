/**
 * A uniform latitude/longitude bucket grid.
 *
 * Every layer on the map answers the same question — "what is inside the
 * viewport?" — over a hundred thousand fixed records. A grid keyed on the
 * cell a record falls in answers it by touching only the cells the viewport
 * covers, which is what keeps panning at 60 fps with roads, buildings and
 * points of interest all on at once.
 */

export const CELL = 0.005;

const cell = (value: number) => Math.floor(value / CELL);
const key = (row: number, col: number) => row * 100_000 + col;

export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

export class SpatialGrid {
  private buckets = new Map<number, number[]>();
  /** Records spanning several cells appear in each, so results need de-duping. */
  private spans: boolean;

  constructor(spans = false) {
    this.spans = spans;
  }

  add(index: number, lat: number, lon: number): void {
    const k = key(cell(lat), cell(lon));
    const bucket = this.buckets.get(k);
    if (bucket) bucket.push(index);
    else this.buckets.set(k, [index]);
  }

  addBox(index: number, minLat: number, minLon: number, maxLat: number, maxLon: number): void {
    for (let row = cell(minLat); row <= cell(maxLat); row += 1) {
      for (let col = cell(minLon); col <= cell(maxLon); col += 1) {
        const k = key(row, col);
        const bucket = this.buckets.get(k);
        if (bucket) bucket.push(index);
        else this.buckets.set(k, [index]);
      }
    }
  }

  /** Visit every record whose cell overlaps the box, at most once each. */
  query(box: Box, visit: (index: number) => void): void {
    const seen = this.spans ? new Set<number>() : null;
    for (let row = cell(box.south); row <= cell(box.north); row += 1) {
      for (let col = cell(box.west); col <= cell(box.east); col += 1) {
        const bucket = this.buckets.get(key(row, col));
        if (!bucket) continue;
        for (const index of bucket) {
          if (seen) {
            if (seen.has(index)) continue;
            seen.add(index);
          }
          visit(index);
        }
      }
    }
  }
}

export function buildPointGrid(
  count: number,
  at: (index: number) => [number, number],
): SpatialGrid {
  const grid = new SpatialGrid();
  for (let i = 0; i < count; i += 1) {
    const [lat, lon] = at(i);
    grid.add(i, lat, lon);
  }
  return grid;
}

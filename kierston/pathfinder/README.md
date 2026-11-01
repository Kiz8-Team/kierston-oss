# Pathfinder

Car routing over the Kierston road network: two or more addresses (or
coordinates) in, a drivable route through them with turn-by-turn steps out.

```
bun run build-graph     # once, after the topology export changes
bun run serve           # http://localhost:8787/tools/map/pathfinder.html
bun run route "1200 Hamilton St" "119 E Juniata Street"
bun run route "1200 Hamilton St" "City Hall" "119 E Juniata Street"
bun run bench           # timing distribution over random pairs
```

## How it works

**Build once, query in a millisecond.** `build-graph` reads the 63 MB GraphML
export, keeps only the ways a car may drive, and writes a 3.4 MB binary of flat
typed arrays. The service loads that in ~20 ms and never parses XML again.

| Stage | Result |
| --- | --- |
| Parse `topology_*.graphml` | 78,626 nodes, 103,842 drivable edges (~0.5 s) |
| Filter | drops footpaths, tracks and `access=private`/`no` ways |
| Price | `length / maxspeed`, falling back to a speed per highway class |
| Order | nodes sorted along a Morton curve, so neighbours share cache lines |
| Label | strongly connected components — the largest holds 94.6% of nodes |

**The search is plain A\***, over a forward CSR adjacency
(`offset`/`target`/`cost`), minimising travel time. The heuristic is
straight-line distance divided by the fastest speed in the network, which never
overestimates and so keeps results optimal. Per-query state is allocated once
and invalidated with a generation counter rather than cleared, so the cost of a
query is the nodes it settles and nothing else:

```
3,000 random routes, mean length 6.6 km
mean 1.23 ms · p50 1.03 ms · p95 3.00 ms · 810 routes/s on one core
```

That is deliberately the simple option. What makes it scale is the data layout,
not the algorithm: the same arrays are what a bidirectional search, an ALT
landmark heuristic or contraction hierarchies would need, so any of those can be
dropped in later without touching the builder, the geocoder or the API.

**Endpoints are snapped** to the nearest node in the largest strongly connected
component. Snapping to any nearest node would happily pick a gated driveway or
an isolated service loop and then report that no route exists.

**Addresses resolve offline.** `buildings.json` and `pois.json` already carry
~47k addresses for the area, indexed by house number, street and name, with
abbreviations folded (`Street`/`St`, `North`/`N`). An unknown house number on a
known street falls back to the nearest number on that street. Only queries the
local index cannot answer at all reach Nominatim, and those answers are cached
to `data/pathfinder_geocode.json`.

## HTTP API

`bun run serve` also serves the repository as static files, so the map tool and
the API share an origin.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | graph and index statistics |
| `GET /api/geocode?q=&limit=` | ranked address candidates |
| `GET /api/describe?lat=&lon=` | nearest known address to a point |
| `GET /api/route?from=&via=&to=` | route in the given order; repeat optional `via`; values are addresses or `lat,lon` |

```json
{
  "from": { "label": "…", "lat": 40.6, "lon": -75.47,
            "snapped": { "lat": 40.6, "lon": -75.47, "osmid": 1234, "metersAway": 17.7 } },
  "distanceMeters": 2958.4,
  "durationSeconds": 202.1,
  "geometry": [[40.6028, -75.4716], "…"],
  "steps": [{ "maneuver": "left", "instruction": "Turn left onto West Union Street",
              "distanceMeters": 87.2, "durationSeconds": 8.9, "lat": 40.6, "lon": -75.47 }],
  "stats": { "settledNodes": 2857, "searchMs": 1.12, "totalMs": 3.59 }
}
```

Failures are typed: `unresolved` (404) when a query matches no place,
`off-network` (404) when a point is outside the mapped area, `no-route` (422)
when no drivable connection exists.

## As a library

```ts
import { Pathfinder } from "./src/index.ts";

const pathfinder = await Pathfinder.open();
const plan = await pathfinder.route("1200 Hamilton St", { lat: 40.59, lon: -75.45 });
const detour = await pathfinder.route([
  "1200 Hamilton St",
  "Kierston City Hall",
  { lat: 40.59, lon: -75.45 },
]);
console.log(plan.distanceMeters, plan.steps.length);
```

## Layout

| File | Role |
| --- | --- |
| `src/build.ts` | GraphML → the binary car graph |
| `src/graph.ts` | graph format, loader, nearest-node grid |
| `src/router.ts` | A* search |
| `src/heap.ts` | typed-array binary heap |
| `src/geocode.ts` | local address index and Nominatim fallback |
| `src/plan.ts` | node path → geometry and turn-by-turn steps |
| `src/index.ts` | `Pathfinder`, the façade the CLI and service use |
| `src/server.ts` | HTTP API plus static file serving |
| `src/cli.ts`, `src/bench.ts` | terminal entry points |

The map front end lives in `tools/map/pathfinder.html`.

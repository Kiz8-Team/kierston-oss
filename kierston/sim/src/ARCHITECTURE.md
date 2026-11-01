# Runtime architecture

The simulation is a modular monolith. Directories are subsystem boundaries,
not separate packages or public SDKs.

## Rules

- A subsystem's `index.ts` is its internal API to the rest of the engine.
- Files inside a subsystem may import each other directly.
- Cross-subsystem imports go through the target subsystem's `index.ts`.
- `shared/` contains only domain-neutral primitives. Domain models belong to
  the subsystem that gives them meaning.
- `cli.ts`, exporters, and other top-level consumers assemble subsystems; they
  do not own simulation mechanics.
- Add abstractions only when the engine has a concrete need for more than one
  implementation.

Run `bun run check:boundaries` to verify the import rule.

## Subsystems

| Directory | Owns |
| --- | --- |
| `world/` | Loaded city data, people, households, places, and lookups |
| `activities/work/` | Rosters, work blocks, commutes, and police patrol |
| `activities/school/` | School attendance, escorts, riders, and bus runs |
| `activities/sleep/` | Sleep traits, bouts, and day carry-over |
| `activities/social/` | The tie graph, organisations, affiliations, attendance, and arranged meetings |
| `activities/discretionary/` | Venue choice and discretionary stops |
| `transport/` | Roads, travel, parking, vehicle hire, and taxis |
| `network/` | Cellular attachment: serving cells, handovers, and signalling |
| `comms/` | Who talks to whom: attention, conversations, messages, calls, and the traffic a gathering generates |
| `surveillance/` | Fixed-camera ground truth, plate presentation, and simulated ALPR observations |
| `dispatch/` | Calls for service: who rings 911, which police and EMS units go, and what that does to their day |
| `traffic/` | Vehicles from outside the city: persistent commuters and deliveries, and date-local visitors and through traffic |
| `scheduler/` | Intent composition, placement, and routed mobility |
| `economy/` | Banking, bills, spending, and settlement |
| `engine/` | Long-lived simulation context and top-level construction |
| `export/` | Packed simulation products |
| `shared/` | Time and deterministic random-number primitives |

`src/index.ts` is the engine-wide entry point for tools and other top-level
core consumers. Mechanics should prefer the narrower subsystem entry points.

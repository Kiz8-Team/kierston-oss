# Staging scenarios

A scenario is a seeded TypeScript script that adds an incident to an exported
day. The scenario runner re-simulates only the people the script involves,
using the day simulator. All other people keep their recorded day. The output
is a `.kdiff` file with the changes against the base day.

Series builds stage scenarios automatically ([Building a series](../bench/series.md)).
Manual staging is needed only for inspection or for writing new scenarios.

## Benchmark scenarios

Listed in [`kierston_scenarios/scenarios/catalog.ts`](../../kierston_scenarios/scenarios/catalog.ts).
Series configs refer to them by id.

| Id | Group | Incident | Task family |
| --- | --- | --- | --- |
| `mass-shooting` | RTI | Shooting inside a bar | `mass-shooting` |
| `shots-fired` | RTI | Shots fired on a street corner | `shots-fired` |
| `protest` | RTI | Protest at a park or civic building | `protest-members` |
| `mass-gathering` | RTI | Unannounced crowd | `mass-gathering` |
| `explosion` | RTI | Planted explosive device | `explosion` |
| `school-shooting` | RTI | Shooting inside a school | `school-shooting` |
| `abduction` | RTI | Abduction by a group in a car | `abduction` |
| `stabbing-alibi` | DT | Stabbing reported by the partner who did it | `stabbing` |
| `swatting` | DT | False armed-intruder 911 call | `swatting` |
| `never-arrived` | DT | Missing-person report by the partner who did it | `disappearance` |

`scenarios/demo/` has two DSL examples that are not benchmark scenarios.

## Manual staging

```bash
bun run scenarios create \
  --scenario kierston_scenarios/scenarios/demo/coffee.ts \
  --input kierston/sim_outputs/day_2026-09-01.bin \
  --seed 7 \
  --output kierston/sim_outputs/scenario_coffee_7.kdiff
```

| Flag | Meaning |
| --- | --- |
| `--scenario FILE.ts` | Script; required |
| `--input DAY.bin` | Base day |
| `--seed N` | Seed for role selection and branches |
| `--output FILE.kdiff` | Output path |
| `--max-affected N` | Maximum number of re-simulated people |

Flags other than `--scenario` default to values in the script. Paths in a
script are relative to the script file. Paths on the command line are relative
to the working directory.

A delta stores the SHA-256 of its base day and applies only to that file.
Deltas with the same base day cannot be combined.

### Standalone day

`merge` writes a full KDAY with the delta applied:

```bash
bun run scenarios merge \
  --input kierston/sim_outputs/day_2026-09-01.bin \
  --delta kierston/sim_outputs/scenario_coffee_7.kdiff \
  --output kierston/sim_outputs/scenario_coffee_7.bin
```

The benchmark does not use merged days. It reads the base day and the delta.
KierstonBlue's `/scenarios` page shows deltas without merging.

## Writing a scenario

A script default-exports `scenario({...}, (s) => {...})`.

```ts
import { scenario } from "../../src/index.ts";

export default scenario({
  name: "lunch-visit",
  seed: 42,
  input: "../../../kierston/sim_outputs/day_2026-09-01.bin",
}, (s) => {
  const actor = s.selectPerson("actor", { age: { min: 25, max: 55 }, requires: { car: true } });
  const cafe = s.selectPlace("cafe", { type: "cafe", near: actor.home, withinKm: 8 });
  const car = s.selectVehicle("car", { householdOf: actor });

  actor.replaceWindow("11:30", "14:30");
  const there = s.trip("outbound", { mode: "car", vehicle: car, driver: actor, to: cafe, arriveAt: "12:30" });
  const visit = s.stay("visit", { people: [actor], at: cafe, startAt: there.arrival, for: "45m" });
  s.trip("home", { mode: "car", vehicle: car, driver: actor, to: actor.home, departAt: visit.end });
});
```

| Part | API |
| --- | --- |
| Role selection | `s.selectPerson`, `s.selectPlace`, `s.selectVehicle` |
| Editable time window | `actor.replaceWindow(start, end)` |
| Actions | `s.trip`, `s.stay`, `actor.text`, `actor.call`, `actor.purchase` |
| Groups | Crowd actions applied to many people with per-person offsets |
| Events | Incident records read by task generators |

Template: [`scenarios/demo/coffee.ts`](../../kierston_scenarios/scenarios/demo/coffee.ts).
Full API: [Scenario DSL guide](../../kierston_scenarios/docs/DSL.md).
Runner internals: [`kierston_scenarios/README.md`](../../kierston_scenarios/README.md).

Scripts run as normal local programs with no sandbox.

A new benchmark scenario also needs a catalog entry and a task generator in
[`kierston_bench/task_generators`](../../kierston_bench/task_generators).

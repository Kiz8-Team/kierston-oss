# Kierston scenarios

Kierston scenarios apply a deterministic, seeded intervention to an existing
simulated day. A scenario produces a compact KDIF delta (`.kdiff`) against an
immutable KDAY base rather than copying the entire day.

The package provides:

- A typed TypeScript DSL for selecting people, places, sites, and vehicles.
- Actions for movement, shared trips, presence, communications, and purchases.
- Groups: crowds selected by filter or read from who was already there, acted
  on together with a per-member spread — gatherings, flight, sheltering, death,
  calls to family, friends and 911 — plus patrol responders and event records.
- CLI commands to create a scenario and produce a standalone day file.
- The benchmark scenarios under `scenarios/`, grouped by the task group that
  reads them: `scenarios/rti/` holds the staged incidents whose deltas
  feed the Real-Time Investigation (RTI) families, `scenarios/dt/` the
  incidents with a story attached that feed the Deception Task (DT) families.

For the complete authoring reference, including every selector, action, timing
rule, example, and troubleshooting guide, see the
**[Scenario DSL Guide](docs/DSL.md)**.

## Requirements

Scenario creation requires:

- Bun dependencies installed for `kierston/sim`.
- Initialized city and routing assets matching the base day.
- A current vehicle-tracked KDAY export (v14 or v15) whose embedded opening
  state matches the engine's `KSTATE` version.

## Architecture

A scenario is an intervention on a day that has already been simulated, not a
new simulation. The design goal is that a staged incident is indistinguishable,
in the records, from something that happened on that day: the people involved
travel on real roads, their phones hand over between real cells, their cards
are charged at real merchants, and cameras read their plates — while the rest
of the city carries on exactly as it was recorded.

```
scenario script ──► authoring ──► replay ──► effects ──► storage ──► .kdiff
 (roles, windows,    (seeded      (engine     (carrier,   (column
  actions, groups,    bindings,    re-plans    bank, ALPR, patches,
  events)             schedule)    affected    mortality)  header,
                                   people)                 provider rows)
```

**Authoring** (`src/authoring/`). A script binds *roles* to residents, places
and vehicles by seeded selection, so a role name plus the seed always binds the
same thing. A *replacement window* is the permission to change a person's
timeline; everything outside it is kept from the base day. *Actions* are the
required facts — a trip, a stay, a text, a call, a purchase, a death, a phone
left behind — and *groups* expand one crowd action into per-member actions with
seeded offsets. *Events* record the incident itself (kind, centre, radius,
window) for the task generators. Personal-record filters let a role require,
say, a handgun owner or a long violent record.

**Replay** (`src/replay/`). The runner restores the base day's embedded opening
state and loads the engine's static context. The base day is read as the
*baseline*: who was where, which car was where, which patrol unit was on the
road. Only the people the script touches, plus those it pulls in as
consequences (a message recipient, a taxi driver, a displaced passenger, a
responding officer), are re-planned with the engine's own scheduler and
routing, and shared journeys are replayed jointly so a driver and passengers
agree. Everyone else is frozen. Physical actions must be feasible; a person is
never teleported, and a schedule that cannot finish before midnight is refused
(or rebuilt earlier from the same seed).

**Effects** (`src/effects/`). From the new movements the runner regenerates
what providers would record: carrier sessions, messages, calls, SMS and CDRs
with serving cells at both ends; bank transactions and balances; plate-reader
passes and observations for the changed vehicles. Mortality truncates a dead
person's day and communications, and muting silences a person's handset over
an interval.

**Storage** (`src/storage/`). The affected people's rows replace theirs in the
day's columns, and the product is validated as a whole (vehicle spans,
continuity, table joins). The writer then diffs the result against the base
and stores only byte patches for the columns, header, and opening and closing
state that changed. The `scenario` header records the incident's truth: the
events, every actor, vehicle, place and crowd binding, each seeded branch,
deaths, phones left behind, muted intervals, dropped members and the full
affected set. Finally the writer computes the provider rows the scenario
removes and adds in each of Fastgate's six event tables, so the event store
can apply it without the base day. Because the delta names its base by
SHA-256, many scenarios share one stored day; deltas from one base are
alternative branches and never stack.

## Quick start

Generate a base day:

```sh
bun run day --export-day --date 2026-08-23
```

Create a KDIF from one of the examples:

```sh
bun run scenarios create \
  --scenario kierston_scenarios/scenarios/demo/coffee.ts
```

Override script defaults when needed:

```sh
bun run scenarios create \
  --scenario kierston_scenarios/scenarios/demo/coffee.ts \
  --seed 7 \
  --output kierston/sim_outputs/scenario_coffee_7.kdiff
```

Materialize a standalone KDAY for existing consumers:

```sh
bun run scenarios merge \
  --input kierston/sim_outputs/day_2026-08-23.bin \
  --delta kierston/sim_outputs/scenario_coffee_7.kdiff \
  --output kierston/sim_outputs/scenario_coffee_7.bin
```

Run `bun run scenarios --help` for the CLI synopsis.

## Minimal scenario

For a scenario stored under `kierston_scenarios/scenarios/rti/`:

```ts
import { scenario } from "../../src/index.ts";

export default scenario({
  name: "lunch-visit",
  seed: 42,
  input: "../../kierston/sim_outputs/day_2026-08-23.bin",
  output: "../../kierston/sim_outputs/scenario_lunch_42.kdiff",
}, (s) => {
  const actor = s.selectPerson("actor", {
    age: { min: 25, max: 55 },
    requires: { car: true },
  });
  const cafe = s.selectPlace("cafe", {
    type: "cafe",
    near: actor.home,
    withinKm: 8,
  });
  const car = s.selectVehicle("car", { householdOf: actor });

  actor.replaceWindow("11:30", "14:30");
  const outbound = s.trip("outbound", {
    mode: "car",
    vehicle: car,
    driver: actor,
    to: cafe,
    arriveAt: "12:30",
  });
  const visit = s.stay("visit", {
    people: [actor],
    at: cafe,
    startAt: outbound.arrival,
    for: "45m",
    purpose: "cafe",
  });
  s.trip("return-home", {
    mode: "car",
    vehicle: car,
    driver: actor,
    to: actor.home,
    departAt: visit.end,
  });
});
```

Scenario files are trusted local TypeScript programs, not sandboxed
configuration. Paths declared in a scenario are relative to that scenario
file; explicit CLI paths are relative to the current working directory.

## Output and safety

`create` writes a `.kdiff`. `merge` combines that delta with its original base
day and writes a standalone `.bin`. Deltas from one base are alternative
branches and cannot be stacked arbitrarily. The commands do not overwrite their
inputs.

## Scenarios

`scenarios/` holds the benchmark scenarios, one script per staged incident,
in a directory per task group: `scenarios/rti/` for the Real-Time
Investigations and `scenarios/dt/` for the Deception Tasks. [`scenarios/catalog.ts`](scenarios/catalog.ts)
lists them: the group, the event kind each records and the task families
that read it (base day + delta). A
series config names a scenario by its catalogue id; the run-series prep runs
the script against each base day, writes the delta, and generates the
families from the result (see
[`kierston_bench/run_series_prep`](../kierston_bench/run_series_prep/README.md)).
Each script's `input`, `output` and `seed` are only defaults for a manual run.

RTI and DT schedules follow actual routed arrivals, not fixed clock
appointments. An async scenario can use `s.start()` for a seeded departure
preference anywhere in the day, `gather({ departAt: ... })` to finish any journey already in
progress before setting off, and `await s.after(...)` to resolve a trip or
wait for the last feasible member of a gathering. Events, witness queries,
calls and responses then use those resolved times. School attendance is
located in the recorded day rather than assumed at a fixed morning hour.
Patrol response can wait for the next available watch. For gatherings that
resume the recorded day, `await group.resumeAfter(...)` includes restored
household car bookings when resolving arrivals and departure times.

Midnight is the hard timing boundary. If the preferred start would spill
into tomorrow, the runner rebuilds the same seed from the start of the day;
it never shortens a route to meet an appointment. A schedule that still
crosses midnight is refused. Physical continuity, participant requirements
and shared vehicle checks continue to apply.

| Scenario | Event | What is staged | Family |
| --- | --- | --- | --- |
| [`rti/mass-shooting.ts`](scenarios/rti/mass-shooting.ts) | `shooting` | A crowd at a bar; one attendee with a handgun; deaths, sheltering, flight, 911, patrol response. The shooter flees, blends into the crowd or dies, as the seed decides. | `mass-shooting` |
| [`rti/shots-fired.ts`](scenarios/rti/shots-fired.ts) | `shots-fired` | One handgun owner stands on a corner for two minutes and leaves; witnesses call 911; a decoy is bound when the day has one. | `shots-fired` |
| [`rti/protest.ts`](scenarios/rti/protest.ts) | `protest` | A few hundred people converge on a park or a civic building for two hours; bystanders are bound as the decoy group. | `protest-members` |
| [`rti/mass-gathering.ts`](scenarios/rti/mass-gathering.ts) | `gathering` | An unannounced crowd at a park, a lot or a corner for an hour and a quarter. | `mass-gathering` |
| [`rti/explosion.ts`](scenarios/rti/explosion.ts) | `explosion` | A visitor plants a device at a hospital, warehouse, office or church and watches from a street away; two other visitors leave beforehand. | `explosion` |
| [`rti/school-shooting.ts`](scenarios/rti/school-shooting.ts) | `school-shooting` | Shots inside an occupied school; the shooter is a student already inside or an outsider who arrives; lockdown, flight, response. | `school-shooting` |
| [`rti/abduction.ts`](scenarios/rti/abduction.ts) | `abduction` | A victim and a violent crew converge at a kerb; the crew takes the victim to the driver's home and leaves the phone behind. A recorded passer-by, a nearby resident walked past, or a relative on the line calls 911. | `abduction` |
| [`dt/stabbing-alibi.ts`](scenarios/dt/stabbing-alibi.ts) | `stabbing` | A partner reports finding his girlfriend stabbed on getting home. In fact they travelled out and returned together, and she died with him present. | `stabbing` |
| [`dt/swatting.ts`](scenarios/dt/swatting.ts) | `swatting` | A caller across town rings the occupant twice, is rejected, then makes a false armed-intruder report to 911. | `swatting` |
| [`dt/never-arrived.ts`](scenarios/dt/never-arrived.ts) | `disappearance` | A partner reports his girlfriend missing: she left for a relative's, he says, and never arrived. The script stages their whole Saturday — a lie-in, a run to the shops, her texts and a call to the relative arranging the visit — and at 18:02 they leave together in the household car, his phone in the house and hers with her. She died in a quiet car park halfway there; he threw her phone out on the way across town, left the body on the far side of the city and came home alone. | `disappearance` |

The RTI families give the agent the day as it stood minutes after the
event: KDI hides records after the task's cutoff. The DT scripts stage a
day on which the account given to 911 is false, and the prompt tells that
account as given.

Demonstrations of the DSL that are not benchmark scenarios live in
`scenarios/demo/`:

- [`demo/coffee.ts`](scenarios/demo/coffee.ts) — movement, messaging, a call,
  and in-person/online purchases.
- [`demo/taxi.ts`](scenarios/demo/taxi.ts) — a priority single-person taxi trip.

# Kierston Scenario DSL Guide

[Back to the package README](../README.md)

Use the typed TypeScript DSL to select people, places, and vehicles and describe
how a simulated day should change. Scenarios can add movement, shared
activities, communications, and purchases.

## Contents

- [Quick start](#quick-start)
- [Scenario file structure](#scenario-file-structure)
- [How the DSL works](#how-the-dsl-works)
- [DSL reference](#dsl-reference)
- [Groups and crowds](#groups-and-crowds)
- [Events and responders](#events-and-responders)
- [Timing and replacement](#timing-and-replacement)
- [Communications and money](#communications-and-money)
- [Taxis and affected people](#taxis-and-affected-people)
- [Troubleshooting](#troubleshooting)
- [Programmatic API](#programmatic-api)

## Quick start

Use the repository's existing Bun dependencies and initialized city assets.
Generate a current base day, then run from the repository root:

```sh
bun run day --export-day --date 2026-08-23
```

Create a scenario by copying an example or starting from the template below.
The checked-in examples already define their input, output, seed, and
affected-person limit:

```sh
# The example script defines its input, output, seed and affected-person limit.
bun run scenarios create --scenario kierston_scenarios/scenarios/demo/coffee.ts

# Override only what needs to change for this run.
bun run scenarios create --scenario kierston_scenarios/scenarios/demo/coffee.ts \
  --seed 7 --output kierston/sim_outputs/scenario_coffee_7.kdiff

# Later, reconstruct a normal KDAY for existing readers/importers.
bun run scenarios merge \
  --input kierston/sim_outputs/day_2026-08-23.bin \
  --delta kierston/sim_outputs/scenario_coffee_42.kdiff \
  --output kierston/sim_outputs/scenario_coffee_42.bin
```

`create` requires `--scenario`. The script may supply `input`, `output`, `seed`,
`openingState`, and `maxAffected`; the corresponding CLI flags override them.
`merge` requires all three of `--input`, `--delta`, and `--output`. Run
`bun run scenarios --help` for the compact command synopsis.

The CLI prints progress to stderr and a JSON result to stdout. `create` writes a
`.kdiff`; `merge` turns it into a standalone `.bin` for tools that expect a
normal day file. A delta must be merged with the same base day used to create
it. To branch from an existing scenario, merge it first and use that `.bin` as
the new base.

Scenario creation requires a current vehicle-tracked KDAY v14 or v15. Regenerate older
base days. Use the same `KIERSTON_CITY` setting and city assets used for the
base. Scenario `.ts` files are trusted local executable code; do not run an
untrusted scenario.

## Scenario file structure

Every scenario module default-exports a `scenario(...)` definition. The object
form is recommended because it keeps reproducible run defaults beside the
source. For a script in `kierston_scenarios/scenarios/rti/`:

```ts
import { scenario } from "../../src/index.ts";

export default scenario({
  name: "coffee-and-a-call",
  version: 1,
  seed: 42,
  input: "../../../kierston/sim_outputs/day_2026-08-23.bin",
  output: "../../../kierston/sim_outputs/scenario_coffee_42.kdiff",
  maxAffected: 64,
  // openingState: "../../../kierston/sim_outputs/day_2026-08-22.bin",
}, (s) => {
  // Select people and places, then declare their actions.
});
```

| DSL field | CLI override |
| --- | --- |
| `input` | `--input` |
| `output` | `--output` |
| `seed` | `--seed` |
| `openingState` | `--opening-state` |
| `maxAffected` | `--max-affected` |

Explicit flags win per field. Omitted flags retain the script's values, including
a seed of zero. `input`, `output`, and `seed` must be supplied by either source;
`maxAffected` otherwise defaults to 64, and `openingState` otherwise comes from
the base KDAY. Invalid explicit values fail rather than falling back to defaults.

**Paths in a script are relative to that script's directory. Paths passed on the
CLI are relative to the working directory.** Absolute paths work in both places.
Output names are literal: overriding the seed does not automatically rename the
output, so override `--output` too when keeping multiple runs.

The previous `scenario("name", builder, version?)` form remains supported and
can still get all run options from the CLI. The object form accepts an optional
`version` field (default 1). The `merge` command is unchanged: it reads an existing
delta and its base without executing a scenario script.

## How the DSL works

There are four concepts:

1. **Roles** are deterministic bindings to residents, places, or vehicles. A
   role name is stable input to seeded selection, not merely a display label.
2. **Replacement windows** grant permission to change a person's physical
   timeline. Everything outside each window is retained from the base day.
3. **Actions** describe required facts such as a trip, presence at a venue, a
   message, or a purchase. Physical actions must be feasible; the runner does
   not teleport people or vehicles.
4. **Consequences** may involve additional people. A message includes its
   recipient, and a taxi request may also affect a driver or another passenger.

The scenario name, seed, role names, and action IDs determine repeatable
selections and choices. Give every person, place, and vehicle role a meaningful
name that is unique within its selector kind, and give every action a globally
unique ID. Renaming one may change the result.

Declare physical actions in the order they occur. A relative time may only
refer to a movement or presence action that has already been resolved. Use
`s.trip(...)` for movement and `s.stay(...)` or `s.wait(...)` for presence.

A fifth concept, **groups**, covers crowds: a set of residents acted on
together, each with their own seeded offset into a spread of minutes. Group
actions expand into the ordinary per-person primitives; see
[Groups and crowds](#groups-and-crowds).

## DSL reference

### Common value formats

| Value | Accepted forms | Meaning |
| --- | --- | --- |
| `Range` | `42` or `{ min: 25, max: 55 }` | Exact numeric match or inclusive range. |
| `Time` | `"14:30"`, `"14:30:20"`, `870`, or an action boundary | Local time on the base KDAY date; numeric values are minutes after midnight. |
| Duration | `"30s"`, `"20m"`, `"2h"`, or `20` | String with unit, or numeric minutes. |
| Distance | `"250m"`, `"1.5km"`, or `250` | String with unit, or numeric metres. |
| Movement mode | `"walk"`, `"car"`, or `"taxi"` | Modes supported by `trip`. |

Times and durations are not JavaScript dates. Physical movement, presence, and
replacement windows must resolve to whole minutes. Texts and calls retain
second-level timing. `"24:00"` is valid only as the end of the day.

Movement and presence calls return boundaries that can anchor later actions:

```ts
const outbound = s.trip("outbound", {
  mode: "car", vehicle: car, driver: actor, to: cafe, departAt: "12:00",
});
const visit = s.stay("visit", {
  people: [actor], at: cafe, startAt: outbound.arrival,
  for: "45m", purpose: "cafe",
});
actor.text("arrived", contact, {
  at: outbound.arrival.plus("30s"), platform: "whatsapp",
});
s.trip("home", {
  mode: "car", vehicle: car, driver: actor, to: actor.home,
  departAt: visit.end,
});
```

### Selecting people

```ts
const actor = s.selectPerson("actor", filter);
```

| Filter | Type | Behavior |
| --- | --- | --- |
| `id` | `number` | Bind the exact resident ID. |
| `age` | `Range` | Match age. |
| `sex` | `"male" \| "female" \| number` | Match the stored sex category. |
| `raceEthnicity` | `string \| string[]` | Match stored categories such as `"nh_white"`. |
| `personalIncome` | `Range` | Match personal income; missing income does not match. |
| `householdIncome` | `Range` | Match household income. |
| `exclude` | `(Actor \| Group)[]` | Exclude explicit prior bindings or whole groups. |
| `homeNear` + `withinKm` | `Place` + number | Home within a radius of a place; `withinKm` defaults to 5. |
| `occupation` | `string \| string[]` | Match the work assignment's occupation, such as `"police_officer"`. |
| `excludeOccupations` | `string \| string[]` | Leave listed occupations out. |
| `requires.car` | `boolean` | Require driving eligibility; this does not guarantee a car at a later origin. |
| `requires.vehicle` | `boolean \| "couple"` | Require a private vehicle registered to the household, so `selectVehicle({ householdOf })` cannot come up empty. `"couple"` also requires a household car parked at home at midnight that only the person and their household partner drive on the recorded day, and no car the two of them drive that anybody else also drives: a script can then take over both their whole days without leaving a flatmate's drive starting where the car no longer is. |
| `requires.platforms` | `Channel[]` | Require accounts on every named communication platform. |
| `firearms` | object | Match firearm holdings; see below. |
| `criminal` | object | Match criminal history and current custody; see below. |
| `prescriptions` | object | Match current prescriptions; see below. |
| `worksAt` | `Place \| string` | Employed at a site: a place bound by `selectSite`, or a site id. |
| `notWorksAt` | `Place \| string` | Not employed at that site, so a visitor is never one of its staff. |
| `presentNear` | `{ near, at \| during, within?, atHome?, moving?, asleep? }` | Was there on the base day, read from recorded positions with the same presence rules as `s.present(...)`; `within` defaults to 150 m. Needs the base day, so it is unavailable in a bare builder. |
| `awake` | `[from, through]` | Awake in the recorded day at every minute of the interval, read from the base day's attention curve. Use it for anybody who only texts or calls: the exchange layer refuses a call from somebody asleep. People with no recorded curve count as awake. |
| `minKm` | number | With `homeNear`: home at least this far from the place, so a caller is not the next-door neighbour. |
| `householdOf` | `Actor` | Shares a household with an already bound actor. |
| `householdSize` | `Range` | Residents in the person's household, the person included, counted from the population. |
| `wholeDay` | `boolean` | The recorded day can be replaced from midnight to midnight: no carpool, lift, bus, patrol tour, escort or school run in it that somebody else's day depends on. Also accepted on `hasTie`, for the other party. |
| `tiedTo` | `{ actor, kind? }` | Has a tie of one of the listed kinds (any kind when omitted) to an already bound actor, read from the tie graph: `partner`, `sibling`, `colleague`, `clubmate`, `congregant`, `neighbour` and the rest of its `kinds`. Ties to people outside the population never match. |
| `hasTie` | `{ kind, household?, sex?, platforms?, wholeDay? }` | Has at least one tie of the listed kinds to somebody present in the base day with a local home, so a later `tiedTo` selection from this person cannot come up empty. `household` requires the other party to share the home; `sex` and `platforms` are the other party's. |

A couple is two selections: the first asks for somebody with a cohabiting
partner, the second for that partner.

```ts
const boyfriend = s.selectPerson("boyfriend", { sex: "male", hasTie: { kind: "partner", household: true, sex: "female" } });
const girlfriend = s.selectPerson("girlfriend", { tiedTo: { actor: boyfriend, kind: "partner" }, householdOf: boyfriend });
```

`s.matching(filter)` counts the residents a filter would offer without
binding anyone, for a role a script wants only when somebody fits:

```ts
const lookalike = { presentNear: { near: corner, during: ["13:55", "14:15"] }, firearms: { owns: true } };
if (s.matching(lookalike) > 0) s.selectPerson("decoy", lookalike);
```

#### Personal records

```ts
const buyer = s.selectPerson("buyer", {
  age: { min: 25, max: 60 },
  firearms: { owns: true, type: "handgun", carryLicence: true },
  criminal: { convictions: 0 },
  prescriptions: { drugClass: "opioid", schedule: "II" },
});
```

| Filter | Type | Behavior |
| --- | --- | --- |
| `firearms.owns` | `boolean` | Holds at least one firearm, or none. |
| `firearms.type` | `"handgun" \| "long_gun"` or an array | Holds a firearm of any listed type. |
| `firearms.count` | `Range` | Number of firearms held. |
| `firearms.carryLicence` | `boolean` | Holds a valid licence to carry. |
| `firearms.prohibited` | `boolean` | Under a § 6105 or federal firearms prohibition. |
| `firearms.deniedCheck` | `boolean` | Has a denied PICS check on record. |
| `criminal.cases` | `Range` | Criminal cases of any disposition. |
| `criminal.convictions` | `Range` | Cases ending in a conviction. |
| `criminal.felonyConvicted` | `boolean` | Has, or has no, felony conviction. |
| `criminal.charged` | string or array | Any charge in a listed category or section. |
| `criminal.convictedOf` | string or array | A conviction in a listed category or section. |
| `criminal.incarcerated` | `boolean` | Currently in custody. |
| `criminal.supervision` | `boolean`, `"probation"`, `"state_parole"`, `"county_parole"`, or an array | `true` means any supervision; `false` means none. |
| `criminal.offendingClass` | `"none"`, `"adolescence_limited"`, `"chronic_moderate"`, `"chronic_high"`, or an array | Match the latent offending class the history was generated from. |
| `prescriptions.holds` | `boolean` | Holds at least one current prescription, or none. |
| `prescriptions.count` | `Range` | Number of current prescriptions. |
| `prescriptions.drug` | string or array | Match a drug name such as `"oxycodone"`. |
| `prescriptions.drugClass` | string or array | Match a class such as `"benzodiazepine"`. |
| `prescriptions.schedule` | `"II"`–`"V"` or an array | Match a controlled-substance schedule. |
| `prescriptions.controlled` | `boolean` | Match a scheduled or unscheduled prescription. |

Charge categories are `person`, `property`, `drug`, `weapons`, `public_order`,
`mv_other`, and `other`. A section such as `"3802"` matches every subsection
(`"3802(a)(1)"`, `"3802(d)"`). A conviction counts toward `convictedOf` through
the statute it was entered on, or its lead charge when none is named.

`drug`, `drugClass`, and `schedule` must all hold for the same prescription;
`count` counts every current prescription. Array values match any listed value.
Unknown values, empty arrays, and contradictions such as `owns: false` with a
`type` fail instead of returning no candidates.

These filters read ground truth from `criminal.bin`, `firearms.bin`, and
`holdings.bin` in `kierston/sim_data`. Sealed and expunged cases, juvenile
adjudications, and private firearm transfers all count. Each file loads only
when a filter first uses it.

Selected actor roles are automatically distinct, present in the base KDAY, and
required to have a local home. `actor.id` is the resident ID and `actor.home` is
a reusable `Place`. Empty candidate sets fail; constraints are never silently
widened.

Communication channels are `sms`, `mms`, `voice`, `imessage`, `whatsapp`,
`telegram`, `signal`, `messenger`, and `snapchat`.

### Selecting and binding places

```ts
const cafe = s.selectPlace("cafe", {
  type: "cafe", near: actor.home, withinKm: 5,
});
const known = s.place("node/123456");
const rendezvous = s.near("rendezvous", {
  near: known, minDistance: "50m", within: "250m", kinds: ["street"],
});
```

`s.selectPlace(role, filter)` samples one matching place:

| Filter | Type | Behavior |
| --- | --- | --- |
| `id` | `string` | Match the exact venue or parking POI ID. |
| `type` | purpose, `"mall"`, `"parking"`, or `"parking_lot"` | Match an engine venue purpose or special place class. |
| `tag` | `string` | Match an exact OSM tag such as `"amenity=restaurant"`. |
| `near` + `withinKm` | `Place` + positive number | Restrict selection to a radius; `withinKm` requires `near`. |
| `openDuring` | `[start, end]` | Require a venue open for the full interval. Parking opening hours are not modeled. |

Venue purposes are `grocery`, `convenience`, `cafe`, `food-quick`, `food-sit`,
`bar`, `fuel`, `pharmacy`, `health`, `personal`, `errand`, `retail`, `vehicle`,
and `park`. Parking lots use canonical `poi/<index>` IDs; venue IDs keep their
OSM identity.

`s.place(id)` binds a known venue or world place without sampling. `s.near(...)`
samples a reusable concrete point near an anchor. Its `kinds` may contain
`street`, `cafe`, `parking_lot`, `park_lot`, and `venue`; the default allows all
but `park_lot`, which is a parking lot within 250 m of a park, a garden, a dog
park or a nature reserve. The kinds are pooled unless `inOrder` is set, in
which case the first kind with any candidate wins. `awayFrom` keeps only the far
side of the anchor from another place: candidates within 60° of the bearing
that leads directly away from it. If no catalogued candidate matches and
`street` is allowed, it returns a deterministic street/kerb point in the
requested annulus, on the `awayFrom` bearing when one was given. Otherwise
selection fails.

### Selecting sites

```ts
const hospital = s.selectSite("target", { class: ["hospital", "warehouse", "government"], minCapacity: 60 });
const nearby = s.sites({ class: "school", near: hospital, withinKm: 2 });
```

Venues are where people go for coffee; sites are where the employment and
school layers send them for the day. `s.selectSite(role, filter)` samples one
from the workplace and school catalogues (`workplaces.json`, `schools.json`)
and binds it like a venue, so trips route to it, `present` reads who the day
had inside, and `worksAt` names its staff. Filters are `id`, `class` (one or
several catalogue classes such as `hospital`, `warehouse`, `industrial`,
`office`, `government`, `church`, `school`), `minCapacity`, and `near` +
`withinKm`. `s.sites(filter)` returns every match for inspection.

### Seeded branches

```ts
switch (s.pick("aftermath", ["flee", "blend", "perish"])) { ... }
```

`s.pick(role, options)` chooses one option, seeded on the scenario name, seed
and role like every selection, and records the choice in the header
(`scenario.choices`). A scenario that always ends the same way is a fixture;
`pick` is how a script lets the seed decide which way the incident goes while
the task layer can still read which way it went.

### Selecting and looking up vehicles

```ts
const car = s.selectVehicle("car", { householdOf: alice });
const nearby = s.vehicles({
  parkedNear: courthouse, at: "14:30", within: "250m", serviceClass: "none",
});
```

`s.selectVehicle(role, filter)` deterministically selects one vehicle. Filters
are `vin`, `owner`, `householdOf`, `serviceClass`, `usedOnlyBy` (parked at the first
actor's home at midnight and driven on the recorded day by nobody outside the
listed actors), and a parked-near query.
`serviceClass` is `none`, `taxi`, `school_bus`, or `police`. A parked-near query requires
all of `parkedNear`, `at`, and `within`. When `householdOf` is used without an
explicit VIN or service class, selection defaults to private (`none`) vehicles.

`s.vehicles(filter)` returns every match for inspection or branching in trusted
scenario code and always requires `parkedNear`, `at`, and `within`. A `Vehicle`
exposes its `vin`. Vehicle selection requires a vehicle-tracked KDAY.

### Single-actor example

```ts
import { scenario } from "../src/index.ts";

export default scenario("meeting", (s) => {
  const actor = s.selectPerson("actor", {
    age: { min: 25, max: 45 },
    sex: "female",
    personalIncome: { min: 25_000, max: 80_000 },
    requires: { car: true, platforms: ["whatsapp"] },
  });
  const other = s.selectPerson("other", {
    requires: { platforms: ["whatsapp"] },
  });
  const cafe = s.selectPlace("cafe", {
    type: "cafe", near: actor.home, withinKm: 8,
    openDuring: ["12:00", "14:00"],
  });
  const car = s.selectVehicle("car", { householdOf: actor });

  actor.replaceWindow("10:00", "16:00");
  const outbound = s.trip("outbound", {
    mode: "car", vehicle: car, driver: actor, to: cafe, arriveAt: "12:00",
  });
  const visit = s.stay("visit", {
    people: [actor], at: cafe, startAt: outbound.arrival,
    for: "45m", purpose: "cafe",
  });
  actor.text("hello", other, {
    at: visit.start.plus("1m"), platform: "whatsapp",
  });
  actor.purchase("coffee", {
    at: visit.start.plus("5m"), channel: "in_person",
    venue: cafe, amount: { min: 4, max: 9 }, instrument: "debit",
  });
  s.trip("home", {
    mode: "car", vehicle: car, driver: actor, to: actor.home,
    departAt: visit.end,
  });
});
```

### Replacement windows

```ts
actor.replaceWindow("11:30", "14:30");
```

A person needs a replacement window for any `trip`, `stay`, or `wait`
that changes their physical day. Windows are half-open `[start, end)`, use whole
minutes, and may not overlap. Multiple non-overlapping windows are allowed.
Texts, calls, and online purchases do not by themselves require a window. An
in-person purchase requires the actor to be physically present at the merchant.

### Movement: `trip`

```ts
s.trip("walk", {
  mode: "walk", people: [alice, bob], to: cafe, departAt: "12:00",
});
s.trip("drive", {
  mode: "car", vehicle: car, driver: alice, passengers: [bob],
  to: cafe, arriveAt: "12:30",
});
s.trip("ride", {
  mode: "taxi", riders: [alice, bob], requestedBy: alice,
  to: cafe, departAt: "12:00",
});
```

Walk and car trips take exactly one of `arriveAt` and `departAt`; taxi takes
`departAt` only. `from` is optional and, when supplied, asserts the common
origin. Every participant must already be at that origin. People must be
distinct, the taxi requester must be a rider, the car driver must be eligible,
and passenger count must fit the selected vehicle. The selected car moves once,
with the declared driver and passengers travelling together.

```ts
s.trip("leave", { mode: "auto", people: [alice], to: alice.home, departAt: "21:30", maxWalkKm: 4 });
s.trip("run", { mode: "walk", people: [alice], to: corner, departAt: "21:10", pace: 1.8 });
```

`mode: "auto"` moves one person by whatever they have: their household car
when it is parked where they are and they may drive it, otherwise on foot.
`maxWalkKm` (auto only) skips the trip and leaves the person where they are
when the only option is a walk longer than that. `pace` scales a walked
journey: 1 is a walk, 1.8 a run, 2 the most the roads allow.

### Presence: `stay` and `wait`

```ts
const lunch = s.stay("lunch", {
  people: [alice, bob], at: cafe, startAt: outbound.arrival,
  for: "45m", purpose: "cafe",
});
s.wait("outside", {
  people: [alice, bob], at: cafe, startAt: lunch.end, until: "14:00",
});
```

Both methods take a non-empty, distinct `people` list; `startAt`; exactly one of
`for` and `until`; and exactly one of `at` and `near`. `near` accepts the same
`minDistance`, `within`, and `kinds` fields as `s.near(...)`. `stay` additionally
requires a venue purpose and records a purposeful activity. `wait` records
neutral presence. They return `{ start, end }` boundaries. `until: "next"`
leaves the presence open: it ends when the person's next action starts, or at
their window end. `atCurrent: true` places it wherever the person already is.

Presence does not route anyone. Every participant must already be at the exact
resolved point. If a trip must lead there, call `s.near(...)` once, use that
same `Place` as the trip destination, and pass it as `at` to the presence call.

### Texts and calls

```ts
actor.text("message", recipient, {
  at: "13:00:30", platform: "signal", bytes: 120, replies: false,
});
actor.call("call", recipient, {
  at: "13:05", platform: "whatsapp", outcome: "answered",
  duration: "2m", replies: false,
});
```

`text` requires a non-voice platform and supports optional `bytes` and
`replies`. `call` defaults to carrier `voice`; SMS, MMS, and Snapchat are not
valid call platforms. Call outcomes are `answered`, `no-answer`, `busy`,
`rejected`, `voicemail`, and `failed`. Unless constrained, outcomes, replies,
and callbacks use the normal communications model. Both selected people must
hold accounts on the chosen platform.

`actor.call(id, "911", { at, duration? })` rings the emergency line: carrier
voice, always answered, never called back, so `platform`, `outcome` and
`replies` are not accepted. The call is on the record like any other, from
wherever the caller's handset is at that second.

### Silence and death

```ts
s.mute("never-apart", { between: [alice, bob] });
s.mute("radio-silence", { between: [alice, bob], from: "09:00", until: "18:00" });
alice.perish("stabbed", { at: "20:20" });
```

`s.mute(...)` says two people did not text or call each other inside a
window (the whole day by default). The runner removes the recorded day's
exchanges in their one-to-one threads — every message and call between
them in the window, and whatever answered one — and lists what it removed in
the header (`scenario.muted`). Group threads they both sit in are left
alone; scenario texts and calls are unaffected, so a mute never silences an
exchange the script asks for.

`actor.perish(...)` is `Group.perish` for one declared actor: the person
dies where they stand at a clock minute inside a declared replacement window
that runs to midnight. See [Group actions](#group-actions) for what a death
does to the records. With `moved: true` the body does not stay where it fell:
the script keeps the person as a passenger on later trips and says where they
end up, and the handset rides along until `leaveHandset` parts it from them.

`s.sleep(id, { person, startAt, until })` is a stay at the person's home that the
records treat as sleep, the way the planner's own nights are: nothing sent,
calls ringing out. A script that replaces a whole day uses it for the night;
a plain `wait` there leaves the person awake at four in the morning.

### Phones left behind

```ts
victim.leaveHandset("phone-dropped", { at: "19:20", place: kerb, outdoors: true });
```

`actor.leaveHandset(...)` is `disperse`'s `phoneLeft` for one actor: from
`at` the person's handsets stay put — at `place`, or wherever the person is
at that minute — while the person's own day goes on without them, so a
phone keeps registering on one cell while its owner is driven across town.
The owner sends nothing and answers nothing until their own legs bring them
back to within 75 m of the phone (or never, for a phone thrown from a car);
texts to it are still delivered. `outdoors` defaults to anywhere but a venue.
The header lists it under `scenario.handsetsLeft`.

```ts
boyfriend.keepHandset();
```

`actor.keepHandset(id?)` protects a person's phone record from the day's own
random handset draws. On a plain day each handset can be left at home, switched
off for a stretch or run flat; for a task whose evidence is "two handsets side
by side all day" one such draw erases the answer. The call records a
`handset-keep` action for the person (default id `${role}/handset-keep`, once
per person). Scripted `leaveHandset` holds still apply.

Replay contract for `handset-keep`: the runner realizes it like a mute (no
physical effect), lists the person in the header, and for that person passes
`pinned: true` to the radio attach and skips the left-at-home draw
(`partedFromHandsets`), the power-off draw and the dead-battery draw, so the
handsets stay with the person, or at a scripted hold, for the whole day.

### Purchases

```ts
actor.purchase("coffee", {
  at: "13:10", channel: "in_person", venue: cafe,
  amount: { min: 4, max: 9 }, instrument: "debit",
});
actor.purchase("book", {
  at: "18:00", channel: "online",
  merchant: { name: "Scenario Bookshop", mcc: 5942 },
  amount: 19.99, instrument: "credit",
});
```

`amount` is an exact positive number or inclusive range. Instruments are
`cash`, `debit`, and `credit`. In-person purchases require a merchant venue with
an MCC and physical presence within 80 metres; online purchases require a
`merchant` name/MCC and cannot use cash. Online purchases default to debit when
the instrument is omitted. Approval is not guaranteed.

## Groups and crowds

A `Group` is a set of Actors. Every group action takes the same shape as its
single-person counterpart plus a `spread`, and expands into one action per
member with the id `${id}/${personId}`. Members are ordinary actors: the same
person is the same `Actor` object whether reached by `selectPerson`, a group,
or `present`, and a person already bound is never selected again.

### Making groups

```ts
const attendees = s.selectPeople("attendees", { age: { min: 18, max: 60 }, homeNear: hall, withinKm: 12 },
  { count: { min: 120, max: 180 } });
const bystanders = s.present("bystanders", { near: hall, at: "21:10", within: "120m", exclude: [attendees, shooter] });
const crowd = attendees.union("crowd", bystanders);
const { dead, hiding, fleeing } = crowd.partition("fate", { dead: 0.03, hiding: 0.25, fleeing: 0.72 });
const callers = crowd.minus("alive", dead).sample("callers", 0.6);
```

| Method | Result |
| --- | --- |
| `s.selectPeople(role, filter, { count })` | `count` residents matching a `selectPerson` filter, drawn without replacement. A `{ min, max }` count draws the size first. |
| `s.present(role, { near, at \| during, within?, exclude?, requires?, awake?, atHome?, moving?, asleep? })` | Whoever the base day already had within `within` (default 150 m) of a place at one minute, or at any minute of `during`. Read from recorded positions, so it finds bystanders, customers and staff. See the presence rules below. |
| `group.partition(role, weights)` | Disjoint subgroups by share; every member lands in exactly one. Names become `${role}/${name}`. |
| `group.sample(role, fraction \| { count })` | A subset that may overlap any other sample. |
| `group.union(role, other)`, `group.minus(role, other)` | Set algebra. `minus` also accepts an `Actor[]`. |
| `group.members`, `group.ids`, `group.size`, `group.has(actor)` | Inspection. A group is iterable. |

All draws are seeded on the scenario name, seed and role, like every other
selection. Rename a role and the draw changes.

**Presence rules.** A crowd is the people actually at the place. By default a
person counts at a sampled minute only if they are not within 75 m of their
own home, not on a recorded leg (waiting for a bus included), and not asleep
by the base day's attention curve. A neighbour asleep in a house beside the
bar, or a driver passing on the road, is therefore never in the crowd and
never dies in bed. `atHome: true`, `moving: true` and `asleep: true` let each
group back in. `awake: [from, through]` additionally keeps only people awake
at every minute of the interval, and `requires.platforms` only people holding
those accounts; a member who will ring 911 needs both, with `voice`. The same
rules apply to `presentNear` in a person filter.

These rules read the base day's leg times and attention curves, which the
builder loads in the background. `s.after(...)` waits for them; a script that
calls `present`, `presentNear`, `awake` or `s.wasAt` before its first `after`
first calls `await s.ready()`.

`s.wasAt(actor, place, at, within?)` answers the same question for one bound
actor: whether their recorded position at that minute was within `within`
(default 150 m) of the place and not on a leg. `s.matching` cannot answer it,
because it never offers people who are already bound.

### Spread

Three hundred people do not start running in the same second. Every group
action takes `spread: { for, shape? }` and gives each member a seeded offset
inside it: `uniform` across the interval, or `burst` (front-loaded with a
tail, the shape of a panic). Physical actions round the offset to whole
minutes; texts and calls keep seconds.

A group action returns `{ start, end }` **member times**. Passing one as `at`
to a later group action gives each member their own copy of the earlier
boundary — the minute *they* set off, not the first member's — so
`callers.call("home", "family", { at: flight.start.plus("2m") })` stays true
per person. Member times cannot anchor single-actor actions; use a clock time
there.

### Group actions

```ts
attendees.gather("concert", { at: hall, arriveAt: "19:30", spread: { for: "50m" }, purpose: "bar", minCount: 80 });
dead.perish("killed", { at: "21:10", spread: { for: "3m", shape: "burst" } });
const flight = fleeing.disperse("flight", { at: "21:10", spread: { for: "4m", shape: "burst" }, within: "500m",
  pace: 1.8, hideFor: "10m", then: "home", phoneLeft: 0.06, minCount: 40 });
hiding.wait("shelter", { at: "21:10", spread: { for: "2m" }, for: "55m" });
hiding.goHome("hiding-home", { at: "22:10", spread: { for: "30m" } });
regulars.dissolve("back-to-normal", { at: "22:30", spread: { for: "20m" } });
```

| Action | What each member does |
| --- | --- |
| `gather(id, { at, arriveAt \| departAt, spread?, leaveAt?, leaveSpread?, then?, mode?, pace?, maxWalkKm?, lead?, purpose?, onInfeasible?, minCount? })` | Travels to `at` (auto mode by default), stays there — a purposeful `stay` with `purpose`, a neutral `wait` without — until `leaveAt`, or until a later group action moves them. `then` is `resume` (leave at `leaveAt` and rejoin the recorded day wherever it has them once they get there, the default with `leaveAt`), `home` (go home, then nothing more today) or `stay` (default without `leaveAt`). `lead` (default 90 m) is how long before an arrival the member's day is opened. `maxWalkKm` (auto mode only) drops a member who would have to walk farther than that, so an event timed off the last arrival is not held back by one slow walker. |
| `disperse(id, { at, spread?, from?, minDistance?, within?, pace?, hideFor?, then?, maxWalkKm?, phoneLeft?, onInfeasible?, minCount? })` | Runs (`pace` default 1.8) to their own kerb point 150–600 m from `from` (the gathering place by default), waits `hideFor` if given, then goes `home` (default, by whatever they have; farther than `maxWalkKm` on foot and they stay put) or `stay`s. `phoneLeft` is the share whose handsets remain at `from`. The day ends there: no rejoin. |
| `wait(id, { at, spread?, for \| until, purpose?, then? })` | Stays where they are. `then: "resume"` with `until` rejoins the recorded day. |
| `goHome(id, { at, spread?, mode?, maxWalkKm? })` | Goes home from wherever they are and stays there. |
| `dissolve(id, { at, spread? })` | Closes each member's open window at that minute; the recorded day resumes from there. |
| `perish(id, { at, spread?, onInfeasible?, minCount? })` | Dies where they stand. Fatal when infeasible unless `onInfeasible: "drop"`: a crowd's dead can be dropped, a lone shooter's death must not be. See below. |
| `text(id, target, { at, spread?, platform?, count?, replies?, bytes? })` | Texts `count` contacts of the named kind. |
| `call(id, target, { at, spread?, platform?, count?, retries?, duration?, outcome?, onInfeasible? })` | Calls them; `retries` re-dials a few minutes on while a call goes unanswered. |

Group texts and calls are droppable by default: replay skips one it cannot
place. `onInfeasible: "fail"` makes them required, for a call the task's
truth depends on, such as a witness's 911 call; the run then fails rather
than respond to a report nobody made.

Targets are `"911"`, `"family"`, `"household"`, `"friends"`, or an `Actor`.
Family and friends come from the tie graph (partners, parents, children,
siblings and kin; then everybody else, by affinity), restricted to residents
present in the base day who share a platform with the member. The platform is
the pair's own usual one unless `platform` forces it. A member with nobody of
that kind to reach simply makes no call. Calls to 911 go over carrier voice to
the emergency line, are always answered, and never call back; texts to it are
rejected.

**Perish.** From the member's minute of death: they do not move (a wait to
midnight), nothing they would have sent is sent — the runner removes their
recorded later messages and calls, and every reply or callback that answered
one — no call to them is answered (rewritten to ring out or reach voicemail),
no card of theirs is presented, and their attention curve is zero. Texts to
them are still delivered, and their handset keeps its serving cell, because
the phone is still where the body is.

### Windows, drops and floors

Group members never declare replacement windows. Each group action derives a
**soft** window, merges it with the member's earlier soft windows, and snaps
its ends forward at replay to the end of any recorded journey they fall inside,
so a member driving to work when the scenario takes over is taken over at the
kerb. A soft window that resumes the recorded day closes when the member is
back on it, not when they leave: the return trip is routed first and the day
picks up wherever it has them at that arrival. A soft window never merges with a declared `replaceWindow`.

A member the roads cannot deliver — nothing to drive and too far to walk, a
window that would have to cut a shared ride, no way back at all — is **dropped** with every action of theirs, texts and calls
included, rather than failing the run. `onInfeasible: "fail"` on a group action
makes any drop fatal. `minCount` is the floor a group action will accept; below
it the run fails and names the first drops. The result lists every drop and
reason, the report carries `groups` (surviving members per role), and
`maxAffected` counts survivors and their recipients, so set it to the crowd.

## Events and responders

```ts
s.event("shots", { kind: "shooting", at: hall, start: "21:10", end: "21:14", radius: "200m" });
const units = s.respond("police", { to: hall, at: "21:16", units: 2, holdFor: "2h", minUnits: 1 });
```

`s.event(...)` records nothing in anybody's day. It writes the incident's
kind, centre, radius and window into the delta's header (`scenario.events`),
beside `scenario.groups`, `scenario.actors` and `scenario.choices`, so a task
generator reads what happened from the file and never from the script. The
Real-Time Investigation and Deception Task families key on the event `kind`;
the catalogue in [`scenarios/catalog.ts`](../scenarios/catalog.ts) says
which group a script belongs to (its directory under `scenarios/`), which
kind it records and which families read it. A Deception Task script also
records the branch the story took as `s.pick("story", [...])`, which its
generator reads from `scenario.choices.story`.

`s.respond(...)` sends the nearest `units` patrol cars the base day has out on
the road at that minute. Each officer drives their own car to the scene, holds
there for `holdFor`, and drives back to the station in time for the watch's
recorded return, so the car is in the yard when the next watch takes it. A
unit that cannot make the round trip inside its watch is dropped; `minUnits` is
the floor. The officers are returned as a Group. With `flexible: true`, a
response that finds no unit on the road (or none with enough watch left) moves
to the next minute a patrol watch starts instead of failing.

## Resolved timing

Benchmark scenarios do not put incidents at fixed clock times. A fixed
appointment either fails on a day where nobody can reach the place in time, or
makes every staging of a script happen at the same minute, which an agent could
learn. Scripts instead start from a seeded preference and schedule the incident
from the arrivals the roads actually produce. The build function may be
`async` for this.

```ts
export default scenario({ name: "mass-gathering", seed: 8 }, async (s) => {
  const depart = s.start();
  const crowd = s.selectPeople("crowd", { homeNear: spot, withinKm: 10 }, { count: { min: 80, max: 220 } });
  const gathering = crowd.gather("gathering", { at: spot, departAt: depart, spread: { for: "25m" } });
  const { start, end } = await crowd.resumeAfter("leave", gathering.start, { for: "75m", spread: { for: "25m" } });
  s.event("gathering", { kind: "gathering", at: spot, start, end, radius: "150m" });
});
```

| Call | Returns | Meaning |
| --- | --- | --- |
| `s.start(window?)` | minute | A seeded departure preference, a whole minute in `[from, until)` when a window such as `["16:00", "21:00"]` is given, anywhere in the day otherwise. It is a starting point, never an arrival deadline. Pass the hours the script is plausible in: a venue's opening hours, or the waking hours of a person who only calls. |
| `await s.after(...times)` | minute | Replays the actions declared so far and returns the latest of the given boundaries. A group boundary waits for the last member who could actually get there. |
| `gather({ departAt })` | group action | Members finish any journey already in progress before setting off, rather than being cut off mid-trip. |
| `await group.resumeAfter(id, arrival, { for, spread })` | `{ start, end }` | Holds the group for `for` from its resolved arrival, then lets each member resume their recorded day. Arrivals are re-resolved with the household car bookings that closing the window restores, and only ever move later. |
| `s.baseline!.busiestMinute(place, withinKm, minAge?, maxAge?)` | minute | Peak recorded stationary attendance near a site, from the base day's journeys rather than an assumed school or work hour. |

Events, witness selection, calls and responses then use those resolved minutes.

Midnight is a hard boundary. A replacement window, event, exchange or group
hold that would cross it raises a day-boundary error. The runner then rebuilds
the same seed once with `s.start` returning a second seeded minute in the
earlier half between the window start and the first draw, so late seeds move
earlier without all collapsing onto one minute; if the schedule still crosses
midnight, the staging is refused. Routes are
never shortened to meet a time.

## Timing and replacement

A replacement window authorizes replacing that actor's activities and movements
inside it. Outside activities are retained. The runner routes a return to the
original endpoint before the window ends; a window ending at midnight can leave
the actor at the final scenario destination. Arrival constraints, route durations
and the return must all fit. Ordinary actor windows cannot cut a baseline trip
in half or overwrite a continuation carried from the previous day. Choose its
endpoints or a wider window. Impossible plans fail without teleportation or
silently dropping required scenario actions.

Arrival-constrained movement chooses the latest feasible departure. A
departure-constrained movement starts at the requested time. Early arrivals may
wait at the destination, but routed travel is never shortened to force an
appointment. Actions for the same person may not overlap or run backward in
time.

A selected vehicle is physical state, not a label. It must be parked at the
trip origin, cannot be reserved by overlapping movements, and remains at the
exact parking endpoint until another trip moves it. A later retained baseline
trip must still find it at the correct origin. Driver handoffs are supported
when each driver is present and eligible.

## Communications and money

`text(id, recipient, { at, platform, bytes?, replies? })` starts a text exchange.
`replies: false` requests a single send. Both people must hold accounts on the
specified platform. `bytes` controls the message size; the DSL does not accept
message body text.

`call(id, recipient, { at, platform?, duration?, outcome?, replies? })` defaults to
voice. Outcomes and callbacks vary unless constrained; use
`outcome: "answered"` with a duration when the scenario requires a conversation.
Calls crossing midnight are rejected.

Purchases are processed chronologically against the actor's available accounts
and may decline. In-person purchases require the payer at the venue. Online
purchases need `{ merchant: { name, mcc }, channel: "online" }` and cannot use
cash. An earlier scenario purchase can affect whether a later payment succeeds.

## Taxis and affected people

Recipients of new communications are included in the affected-person count.
Shared trips include every declared participant.

Taxi `trip` uses `departAt` as the request time. A request can fail if no taxi is
available. A taxi change may add a driver or displaced passenger to the
affected-person count.
A taxi window must explicitly return its actor to the original endpoint, unless
the window ends at midnight.

`--max-affected` defaults to 64 and fails if the affected-person count exceeds it.
No affected person is silently omitted. Shared school, escort, and carpool trips
cannot currently be replaced. A shared trip also cannot be changed for only one
participant. A patrol tour can be replaced only by `s.respond(...)`, which
keeps the car's day whole.

## Troubleshooting

Scenario failures are deliberately strict. The most common messages mean:

| Error fragment | Cause | Fix |
| --- | --- | --- |
| `no residents satisfy selection constraints` | No base-day resident matches every person filter. | Relax the intended filter, use an exact known `id`, or inspect whether the required platform/car eligibility exists. |
| `no places satisfy selection constraints` | The venue type/tag/radius/open interval has no match. | Increase `withinKm`, change the purpose/tag, or remove `openDuring` if opening hours are irrelevant. |
| `movements require replaceWindow` / `action ... requires a replacement window` | A physical action has no window containing its anchor time. | Add `replaceWindow` for every physical participant. |
| `cuts movement` | A window boundary falls inside a retained baseline trip. | Move the boundary to a baseline route endpoint or widen the window. |
| `cannot rejoin baseline by window end` | A declared window leaves no time to return to the recorded position at its end. | End later, add an explicit feasible return, or end the window at `24:00`. Group windows extend themselves. |
| `taxi window must explicitly return` | Taxi cannot be assumed available for an automatic return. | Declare the return trip or use a midnight-ending window. |
| `person ... is not at the requested place/origin` | A presence or shared trip used a different point from the previous action. | Reuse the exact same `Place` object and add a trip when movement is needed. |
| `time references an unresolved action` | A boundary refers to an action declared later or one that is not physical/presence. | Declare the referenced movement/presence first. |
| `no car is available` / `vehicle ... is not at the trip origin` | Driving eligibility exists, but the physical vehicle is elsewhere or moving. | Select/look up a vehicle at that time and place, or change the route/time/mode. |
| `payer is not at the merchant` | An in-person purchase occurs while moving or away from its venue. | Anchor it between arrival and departure at that exact venue. |
| `scenario exceeds maxAffected` | Taxi, communication, or shared-trip dependencies expanded beyond the safety bound. | Raise `maxAffected` intentionally or reduce the scenario's dependency footprint. |
| `only N of M members ... were feasible` | More group members were dropped than `minCount` allows; the message names the first drops. | Read the drop reasons: widen the selection radius, use `departAt` instead of `arriveAt`, allow a longer `lead`, or lower the floor. |
| `group time for ... must be resolved per member` | A member time from a group action was passed to a single-actor action. | Use a clock time, or make the action a group action. |
| `no patrol unit is on the road` | No officer's watch has a car out at that minute. | Pick a minute inside a watch, or drop `respond`. |
| `the day cannot be taken over before` | A member's soft window snapped past their first action because they were mid-journey. | Give a longer `lead`, or accept the drop. |
| `engine or city assets differ` | The base day was created with a different project or city setup. | Use the matching setup or regenerate the base KDAY. |

When diagnosing timing, first reduce the script to selections, windows, and one
movement. Add later actions back in chronological order. The CLI writes no
partial delta when planning or validation fails.

## Programmatic API

```ts
import { applyScenario, materializeScenario } from "./src/index.ts";

// Uses defaults on the definition; scenarioPath gives script-relative paths.
await applyScenario({ scenario: definition, scenarioPath: sourcePath });

// Explicit API options override script defaults just like CLI flags.
await applyScenario({ scenario: definition, input: basePath, output: deltaPath, seed: 7 });
await materializeScenario({ input: basePath, delta: deltaPath, output: dayPath });
```

For API calls without `scenarioPath`, relative defaults use the working
directory. Explicit API path overrides always use the working directory.

`applyScenario` returns the output path, selected seed, affected people,
realized action results, the members dropped from each group with the reason,
group communications the engine declined, and the surviving members per group.

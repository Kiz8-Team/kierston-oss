# kierston/sim

The behaviour runtime. Reads what `init/` built and produces what people do.

```
bun run day --person 0 --date 2026-07-28      one person's day
bun run day --person 85819 --week             their rota over a week
bun run check                                  aggregate validation
bun run day --taxi --date 2026-07-28          the cab fleet on its own
bun run day --export-day --date 2026-07-28    one stateful KDAY in ../sim_outputs
bun run day --export-day --week --date 2026-08-17
                                                seven days sharing one accumulated state
bun run audit:week ../sim_data/week_2026-08-17_2026-08-23.json
                                                audit every join and carried event
bun run day --city <build> --export-day --date 2026-07-28
                                                the same on another city build
bun run day --seed 7 --export-day --date 2026-07-28
                                                day draws keyed on seed 7, not the population's
```

## What is here

Current runtime capabilities:

| capability | state |
| --- | --- |
| roster and shifts | done — `roster.ts` |
| sleep across midnight | done — `sleep.ts` |
| school attendance, bus runs, escorts | done — `school.ts` |
| affiliations, errands, purchases | done — `affiliations.ts`, `tours.ts` |
| meetings convened by one person | done — `meetings.ts` |
| police patrol | done — `patrol.ts` |
| taxis | done — `taxi.ts` |
| household cars as VINs, parking | done — `private_vehicles.ts`, `parking.ts` |
| calls for service, police and EMS dispatch | done — `dispatch/` |
| communications and attention | done — `comms/` |
| cellular attachment and signalling | done — `network/` |
| plate readers | done — `surveillance/` |
| external road traffic | done — `traffic/` |
| commuter carpools | not started |

`commute.ts` handles the journey that needs no second person: a work block
becomes a journey. Joint activities (`meetings.ts`, school escorts, taxis,
patrol crews) are the layers that need two; commuter carpool matching is the
one still not written.

## How a day is produced

Opening `KSTATE` → closing `KSTATE`. Passes run in this order; each reads only
what earlier passes fixed.

| # | Pass | Scope | Reads | Produces |
| --- | --- | --- | --- | --- |
| 1 | Enter date | city | opening `KSTATE` | restored balances, midnight positions, running journeys, parked cars, taxi duty, radio attachment, carried 911 calls; opening checkpoint written |
| 2a | Taxi dispatch | city | demand from a first planning pass | frozen cab/fare table (`transport/taxi.ts`) |
| 2b | Calls for service | city | residents, patrol and EMS baseline days | incidents, callers, unit responses by drive time (`dispatch/`) |
| 3 | Planning | per person | static facts, opening state, tables from 2 | intents → placed stays → routed legs (`scheduler/`) |
| 4 | Private vehicles | per person | routed legs | car legs bound to VINs, parking (`private_vehicles.ts`) |
| 5 | Money, radio | per person | finished day | settled transactions (`economy/`), serving-cell spans and events (`network/`) |
| 6 | External traffic | city | date | visitor and through trips (`traffic/`) |
| 7 | Plate readers | city | resident + external movements | ALPR truth and observations (`surveillance/`) |
| 8 | Communications | city | all planned days | conversations, messages, calls, SMS, CDR, 911 calls (`comms/`) |
| 9 | Pack, close | city | everything | KDAY columns + header; closing `KSTATE` embedded |

Steps 3–5 depend only on per-person inputs and frozen tables, so they are
deterministic and parallel-safe. Step 8 runs after all days are planned
because a reply depends on the recipient's day.

`taxi.ts` is the first layer that does need a second person, and the shape it
uses is the one carpools and crews will need too. Matching cannot happen in
`init/` — a fare exists only once a day has been built, so nothing upstream can
enumerate it — and it cannot happen inside the scheduler, which prices journeys
one at a time and cannot see the fleet as a whole. So it is a pass between the
two: days are built to find out what the demand is, cars are matched to it, and
the days are built again against an immutable table that the passenger and the
driver both read. Two people end up in one car without
either of them simulating the other, which keeps the pass parallel.

`travel.ts` is the layer under all of them. No layer generates its own travel,
because no layer knows what the others decided — the commute cannot know a stop
will be inserted into it, and the affiliations layer puts someone in a hall at
19:00 without knowing whether they are coming from the office or from their
front door. So the day's *stays* are decided first and routed afterwards: every
gap between two consecutive places is a leg with a real path, a real mode and a
real duration. Before it existed, only the commute had legs and every other
movement in the city was free.

`scheduler/` composes what exists. Every layer states what it wants as an
immutable *intent* — a place, a fixed span or a window, and a policy saying how
hard it is to move — and the planner decides which of them the day can hold. The
policy is the ranking that used to be implicit in the order the layers ran: a
shift cannot bend, an org's calendar cannot bend around one member, and shopping
is the only thing that yields. Nothing re-times an intent behind a layer's back,
so an activity the day had no room for is *rejected*, with a reason, rather than
quietly becoming something nobody asked for — which is what the `required`
rejection invariant in iceberg watches.

    scheduler/compose.ts    composition — every layer's proposal, as intents
    scheduler/planner.ts    placement — anchors, then windows, then the journeys
    scheduler/mobility.ts   pricing — one transition at a time, over the roads
    scheduler/types.ts      the vocabulary the three share

`--export-day` runs that composition for the whole population and writes
`sim_outputs/day_YYYY-MM-DD.bin`. The `KDAY` binary contains per-person offsets
into schedule and movement-leg tables, plus every leg's routed path as compact
microdegree coordinates. Its header records the `sim_init.bin` digest, so a
consumer can detect a day generated against a different population.

Adding `--week` to `--export-day` cold-starts a `SimulationState` on `--date`, reconstructs the
bounded physical tail of the preceding date, exports seven dates in
chronological order, and passes each date's end state into the next.
Current exports are KDAY v15 and embed both gzip-compressed opening and closing
`KSTATE` v4 checkpoints; no checkpoint sidecar is written. Opening state is
captured before settlement so `kierston_scenarios` can replay a modified day.
v15 adds the calls-for-service `incident` and `response` tables, and `KSTATE`
v4 carries emergency calls that fall past midnight into the next date. The
header also fingerprints the engine and runtime assets.
`sim_data/week_START_END.json` is the rebuildable manifest whose
adjacent state hashes must join. A checkpoint holds only mutable inputs to the
future; the population, calendars and other static facts remain in
`sim_init.bin` and the source assets.

The state is authoritative. It carries balances, every person's midnight
location and active activity/journey, the still-running timeline, private-car
parking position, cab/VIN duty and bookings, and each handset's serving cell,
connection, hysteresis candidate and signalling timer. The next planner starts
after that continuation rather than regenerating the morning. Fuel/charge,
sleep debt, pending replies and contact recency have explicit neutral slots in
the envelope; the engine does not yet model their dynamics, so the checkpoint
records `null`, zero or an empty list instead of inventing values.

The canonical week transition currently runs in one process. Ordinary day
workers each own a private bank, which is correct when every person appears
once and cannot preserve tomorrow's balance. Parallel week export therefore
waits for a state-aware worker protocol instead of producing plausible but
independent ledgers.

`audit:week` opens the packed products rather than trusting the manifest. It
checks every checkpoint digest and adjacent join, exact schedule and routed-leg
continuations, conflicts with newly planned events, invalid/overlapping rows,
and synthetic radio attachments at warm midnights. It exits non-zero when a
continuity invariant fails.

## Stateful exports are currently serial

The worker pool remains in the exporter for a future state-aware protocol, but
every KDAY now needs one authoritative closing checkpoint. Workers currently
hold private banks and cannot exchange tomorrow's balances or boundary state,
so `--export-day` and `--export-day --week` both use the canonical in-process
transition. A non-zero `--workers` value is reported and ignored by the CLI.

Planning remains per person and deterministic. The serial restriction is about
joining the mutable closing state, not about random draws or the scheduler.
`merge.ts` and `pool.ts` remain the basis for restoring parallelism once shards
can return their financial, physical and radio boundary rows.

## Modules

| file | what it owns |
| --- | --- |
| `shared/rng.ts` | per-person deterministic streams, keyed on identity not call order |
| `shared/time.ts` | minutes and day numbers; the congestion curve |
| `world/data.ts` | loaders, and the id → coordinate table every layer resolves against |
| `activities/work/roster.ts` | which days, which hours, which watch |
| `transport/routing.ts` | the pathfinder in-process, with caching and drive-time pricing |
| `transport/parking.ts` | kerbside supply from road length; where the car actually ends up |
| `activities/work/commute.ts` | work blocks to a provisional journey, anchored on arrival |
| `activities/work/patrol.ts` | which officers are in a car, whose beat, and where the watch goes |
| `activities/discretionary/venues.ts` | places with no membership — the catalogue, the corridor search, the habit |
| `activities/social/affiliations.ts` | when an org meets, and who came |
| `activities/discretionary/tours.ts` | what hangs off the commute, and what does not |
| `activities/social/meetings.ts` | two or more people, one place, on purpose — drawn from one convener so every party derives the same meeting |
| `activities/school/school.ts` | bus runs priced once per route, escorts on the days the escort is free |
| `activities/sleep/sleep.ts` | sleep bouts and what runs past midnight, over a yesterday–today–tomorrow window |
| `scheduler/private_vehicles.ts` | household car journeys executed against real VINs |
| `comms/attention.ts` | how likely a person is to look at their phone, minute by minute, from their day plan |
| `comms/exchange.ts` | which pairs speak today, what for, who starts, how the exchange branches, over which channel |
| `comms/gatherings.ts` | the traffic a gathering generates: arranging, the run-up, the silence, afterwards |
| `network/cells.ts` | which cells a point can hear, and how strongly: two-slope loss, sector pattern, indoor penetration |
| `network/attach.ts` | a handset's serving cell over the day, with idle reselection and connected handover hysteresis |
| `surveillance/alpr.ts` | every pass over a camera's edge, and what the camera made of it |
| `economy/spend.ts`, `economy/bills.ts` | charges for the visits in a finished day; recurring bills on their own cadence |
| `traffic/external.ts` | vehicles from outside the city sharing its roads |
| `engine/state.ts` | the `KSTATE` boundary checkpoint: everything mutable that crosses midnight |
| `export/week.ts` | consecutive dates against one accumulated state |
| `transport/travel.ts` | the day's stays to routed legs — every trip, every mode, where the car is |
| `transport/hire.ts` | who has no car, and how often that makes a trip a fare |
| `dispatch/kinds.ts` | what people ring 911 about, who answers, and every rate the subsystem uses |
| `dispatch/calls.ts` | who rings and when — a person and a minute, placed wherever their day has them |
| `dispatch/cad.ts` | which unit goes: patrol units measured against their beat, ambulances against their house |
| `dispatch/stays.ts` | the runs spliced back into a unit's day, exactly as the dispatcher assumed them |
| `scheduler/calls.ts` | the two-pass calls-for-service pass, beside the taxi one |
| `transport/taxi.ts` | which cab answers which call, and where it waits between them |
| `engine/context.ts` | the static context a day is planned against, loaded once |
| `export/pack.ts` | one person, as columns: the plan, the paths, the money, the radio |
| `export/merge.ts` | shards into one file — offsets rebased, string tables replayed |
| `export/pool.ts` | the workers, and which slice each is on |
| `export/day.ts` | the whole city, packed, and the `KDAY` envelope |
| `shared/timing.ts` | where a run's wall clock went |
| `scheduler/` | the composition, the planner, and the flat execution timeline |
| `cli.ts` | the two views, and the checks |

## Venues are not small orgs

`init/social/orgs.py` drew this line and drew it well: only tags describing
somewhere with a membership become an org, because "a restaurant has regulars
but not a roster, and the difference is whether the same forty people are there
every week". So bars, cafés and restaurants are venues, and a visit to one is
generated three different ways depending on who is going:

| | mechanism | where |
| --- | --- | --- |
| alone, en route | a stop on a leg already being driven | `tours.ts` · `intercept` |
| alone, from a base | a trip out and back. The lunch break is the big one | `tours.ts` · `excursion`, `midday` |
| with someone | not generated here — the meetings layer picks the venue with the company | not written |

What holds a venue's regulars together without a roster is habit.
`venues.ts::habitual` draws a person's shop once per purpose and keeps it, so
the same face is at the same counter most Tuesdays. Loyalty is 62% to the
primary and 23% to a fallback; the remaining fresh draw is the trip an analyst
actually notices.

The work lunch is deliberately none of the three. Nobody negotiates lunch with
a colleague a week out — the group version emerges during execution from colleagues
sharing a break window and walking to the same place. Deliberate meetings are
scheduled; work lunches are not, and the meetings layer should not schedule them.

## Shifts come from init, not from here

`init/work/shifts.py` writes a `shift` onto every `class: primary` assignment
and rewrites that person's `depart`/`arrive` from it. Before it existed, a
night-watch officer left home at 07:45 because the roster and the PUMS record
had never been reconciled. The runtime reads `shift` and does not re-derive it —
if a watch looks wrong, it is wrong in `employment.json`.

## Calibration

Everything the checks print has a published counterpart, and two constants are
fitted rather than measured:

- **`routing.ts`** `RUNNING` and `SIGNAL_DELAY_S` — the gap between a free-flow
  graph and a real drive. Fitted so the simulated commute distribution lands on
  the PUMS one (median 19 against 20, mean 19.8 against 21.0). The residual is
  the right sign: self-reported commute times run above measured ones.
- **`parking.ts`** `USABLE_KERB` = 0.55 — the share of nominal kerb that is
  actually parkable. The single number here most worth replacing with a
  measured one.
- **`roster.ts`** `WEEKEND_WORKER` = 0.27 — tuned to put Saturday working at
  about 43% of the weekday level.
- **`affiliations.ts`** `LIFT` — the only genuinely new affiliation constant,
  and the most interesting thing in it. Attendance is not guessed: `ties.py`
  published an EXPOSURE table — the share of days two co-members are in the
  same room — and used it to weight every edge in the social graph, which makes
  it a constraint on this layer rather than a coincidence. With *k* meetings a
  week and independent attendance *p*, exposure is `k·p²/7`, so choosing a
  cadence chooses the attendance. Conventional cadences — a congregation on
  Sunday plus a midweek group, a team that trains and plays, a lodge every
  fortnight, a local every month — all solve to between 0.67 and 0.75, which is
  the strongest evidence available that both tables are about right. `LIFT`
  then corrects for what the formula does not model: shift conflicts, the
  midweek discount, tenure. Fitted so *realised* exposure lands on target,
  within 8% for every class.

  The gym needs no lift and no calendar. Two members attending independently at
  *v* visits a week share a day with probability `(v/7)²`, and EXPOSURE 0.11
  gives v = 2.3 — the published US average, to two figures. It reproduced its
  own exposure with no synchronisation at all, which is the cleanest evidence
  in the table that `ties.py` was right to give the gym the lowest REALIZE of
  any class.
- **`routing.ts`** `WALK_SPEED_M_PER_MIN` = 78 and `PED_SIGNAL_DELAY_S` = 22 —
  measured, not fitted. Routing the walk was what exposed a placement bug in
  `init/work/assign_work.py`: the candidate shortlist was drawn uniformly from
  the whole town, so a walker aiming at 330 m was handed 60 sites of which the
  nearest was 1.5 km, and every walker ended up at about that distance whatever
  they had reported. Fixed there by drawing the shortlist from within the
  worker's reach and letting industry give way to geography for those who
  cannot cross town. Walked distance went 2.36 km → 0.93 km median; the driven
  distribution is unchanged.

- **`hire.ts`** `carless` = 0.12 and `elder` = 0.45 — the share of a non-driver's
  non-walkable trips that are a cab rather than a bus or a lift. Fitted against
  two published numbers at once, which is what makes the fit worth anything.
  Fares per driver per shift is the one aimed at: 16.7 against the trade's
  15–25, up from 4.0 when every fare descended from JWTRNS 7. The share of fleet
  kilometres run empty is the one that is not aimed at, and it falls from 62% to
  41% against a published 40–50% — empty running is a property of the
  dispatcher, no constant in it was touched, and it landed in the band on its
  own.

  The sweep behind them is worth recording because it found a ceiling rather
  than an optimum. Above about 0.16 the fleet is what binds: total fares stop
  rising near 2,400, the median wait climbs to the passenger's 18-minute
  patience, and everything further comes back out as people giving up and
  walking. At 0.34 the city asks for 5,085 rides and gets 3,060 of them. So the
  propensity is not free to be as large as the demand argument would like — 127
  drivers can carry what 127 drivers can carry, and the fit is really a fit to
  the fleet.

`parking.ts` occupancy uses POI count as a demand proxy. The intended
replacement is the simulation's own output: count vehicles parked per cell per
ten-minute bin and feed it back, the same loop network loading would close for
congestion.

## What discretionary activity modelling found

- **Worship, sports and a union local are pinned.** Each reaches its exposure
  target only at an attendance of 0.95–0.99, which is another way of saying the
  target is not reachable at the cadence assumed: a congregation gathering
  twice a week cannot produce co-presence on 16% of days unless essentially
  nobody ever misses. Either they meet more often, or EXPOSURE overstates them.
  The check flags these rather than burying them.

- **Cafés are a tagging artefact.** The extract has five. That is not the
  number of places in Allentown where somebody buys a coffee on the way to
  work, it is the number where a mapper wrote `amenity=cafe`; in the US most of
  that trade is at counters tagged `amenity=fast_food`. All fast food therefore
  serves the café purpose at a 0.55 weight. Gating it on a `cuisine` tag, as
  the first version did, left 16 café venues town-wide, so a morning coffee was
  almost never on anyone's way and the model sent them out on a dedicated trip
  for it — inventing vehicle-kilometres out of a tagging gap.

- **Two occupancy bugs the day view caught and no aggregate would have.** A
  member of a congregation running two services attended both, doubling the
  building's occupancy while halving the chance two members met. And the
  intercept test rejected every stop, because a stop on a leg overlaps the leg
  it is part of and a lunch break overlaps the shift it is a break from — the
  "is this person busy" test has to know what is asking.

## Known gaps

- **School escorts only.** `school_travel.py` names the adult who drives a
  child to school and `school.ts` sends them on the days they are free, but
  nobody collects anyone from anywhere else. Non-school escorting remains a
  reason the trip rate reads below NHTS's 3.5–4.0 per adult.

- **One mode per person, for every trip they make.** JWTRNS is how somebody gets
  to work, and it is used here as how they get everywhere. A bus commuter with a
  car on the drive does not take the bus to the supermarket on a Sunday, so
  non-work transit is overstated and non-work driving understated. The walk
  threshold is the only thing that varies the mode within a day.

  `hire.ts` closed the worst part of this, which was not the bus commuter but
  the two thirds of the town JWTRNS never asked. They were all drivers, which
  put a car on the road for every trip made by a household the vehicle registry
  gives no car to. Citywide, the car's share of trips falls from 69.8% to 64.4%
  and driving from 6.4 to 6.0 km per person; transit's rises from 1.9% to 5.9%,
  which is the non-hired half of the same population and is closer to what a
  city with LANTA in it looks like than 1.9% ever was. The trip *rate* does not
  move — 2.83 to 2.85 — which is the check that matters: the layer changes how
  people travel and does not invent journeys.

- **Discretionary transit and cycling are priced, not routed.** A commute
  believes JWMNP because the respondent gave it; there is no such number for a
  trip to the shops, so a bus trip there is the drive times a factor plus a
  wait, and a bike is the routed distance at a fixed speed. Both are flagged
  `estimated`.

- **Only 31% of stops are intercepted**, against propensities of 30–90% in
  `DEMAND`. The propensity is what someone would do *if* a suitable venue were
  on the way; often none is, and the fallback to a dedicated trip is correct
  behaviour rather than a miss. Whether 31% is the right realised figure is not
  something this repository can currently answer — NHTS trip chaining would.

- **Some meetings are now missed.** A stay the roads cannot reach before it ends
  is dropped rather than attended late, which is right — but it is a second,
  quieter suppression on top of the ones `LIFT` was fitted against, and it costs
  the calibrated classes a few points of exposure. Worth refitting `LIFT` once
  the travel constants stop moving.

- **No weather and no holidays.** A park trip in February is drawn at the
  July rate, and Christmas is a Friday like any other.

- **No carpool.** JWTRNS has no code for it — that is JWRIP, vehicle occupancy,
  which synthesis does not carry. Every code 1 is currently a car with one
  person in it.
- **Six sites in a 6,000-person sample have no coordinates.** Small, but they
  are silent — the person simply does not commute.
- **Transit and cycling are not routed.** Their duration is the survey's. A bus
  takes its line's travel time and there is no line geometry here; a bike is
  neither the car's speed nor the pedestrian's and the guess needed to price it
  would not beat the respondent's answer.

- **Walking is routed on the car graph**, assuming every road has a footway.
  Real, and the assumption is deliberate — it costs the park cut-through and
  the alley, and inherits one-way edges a pedestrian would ignore, so a walk is
  biased slightly long. The measured detour over straight line is 1.4×, which
  is right for a grid.

- **Walked commutes still run long: 12 minutes simulated against 7 reported.**
  Down from 32 — see the note below — and the residual is structural rather
  than a constant left untuned. About 130 walkers have no premises of any kind
  inside the distance they reported, so no choice of site can be right for
  them; the rest compete for a small stock of walkable seats and settle at the
  far edge of their band. Closing it further needs more tagged premises in
  residential parts of the catalogue, not a different weighting.

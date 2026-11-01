# iceberg

Invariant detection over `sim_data`. It measures a binary as thoroughly as it
can, keeps that as a baseline, and after a change to the generators says what
moved.

```bash
tools/iceberg/iceberg baseline kierston/sim_data/sim_init.bin kierston/sim_outputs/day_2026-07-28.bin
# …change some code, rebuild the population…
tools/iceberg/iceberg check    kierston/sim_data/sim_init.bin kierston/sim_outputs/day_2026-07-28.bin
```

Baselines are named by kind, so an init file checks against the init baseline
and a day file against the day one without either being named. `--name` keeps
more than one — a branch, a seed, a scenario. They land in
`tools/iceberg/baselines/` as JSON, about 100 KB for a day and a couple of
megabytes for an init, small enough to commit.

## What it reads

| File | What comes out |
| --- | --- |
| `sim_init.bin` | every packed section it contains, profiled in one pass |
| `population.bin` | buildings, households, people, and the crosses over them |
| `identity.bin`, `criminal.bin`, `civil.bin`, `firearms.bin`, `vehicles.bin`, `holdings.bin`, `recurring_spending.bin` | every table and every field, joined to the population where the table carries a person |
| `ties.bin` | degree, kinds, foci, exposure and affinity, homophily |
| `day_*.bin` | schedules, legs, modes, distances, routed paths, transactions, bills and income, and the same day on the cellular network |

A day file is joined against the `sim_init.bin` beside it so mode splits can be
read by age, sex, income and education. If that init's digest is not the one
the day names, the join is refused rather than made wrongly — `--init` points
at another one, `--force` overrides the refusal.

## What it measures

Around 3,600 metrics for the current init, 350 for the recurring-spending file,
and 250 for a banked day. A metric is one of four things: a scalar, a
distribution with its tails, a tally of categories, or a rule with a count of
how often it was broken. Cross-tabs are tallies whose
category is `35-44 × female`, which is why there are so many of them — a
marginal hides what a cross shows.

The joins are most of the value. `records.vehicles.vehicle.holders.by.ageBand.65-74`
is the share of people in their late sixties who own a registered vehicle;
there is one of those for every holding table against age, sex, race,
employment, income, education, and age × sex, plus per-household versions of
the same. Guns, cars, licences, mortgages, prescriptions and criminal cases all
come out of the same twenty lines of code, and a field added to a generator
appears in the next profile with nothing here being edited.

Money is the one part of a record file profiled by name rather than by kind,
because the banking tables only mean anything against each other. A deposit row
is not necessarily a bank account — carried currency is a row in the same table,
so every count of accounts and balances excludes it and the people whose only
row is that pocket are the unbanked share, graded by income under
`records.holdings.banking.unbanked.by.incomeBand`. Beside it sit what the city
holds and what lands: deposits and currency in total and per person, balances by
what each account is for, net pay projected to a year from each stream's own
interval, credit extended against credit drawn, and how many people have no
income stream at all by age band.

Rules are checked alongside. Some are structural (a household's declared size
equals its members, an edge is stored with the lower id first); some are about
time (nothing is dated before its holder was born, a leg does not arrive before
it departs, one person's schedule entries do not overlap); some are physical (a
leg does not exceed what its mode can average, a routed path is within a factor
of two of the distance the planner recorded); and the banking ones are about
reachability, which is where a payments bug hides — a debit card draws on an
account its own holder holds and may debit, a direct deposit lands in one set up
to receive it, an account has a spend rank exactly when it can be spent from,
nothing a card can reach is unspendable, everybody carries exactly one cash row,
and every resident has somewhere money can come from at all.

A holdings file written before banking.py existed carries no balances, and the
banking section is skipped rather than reported as a city with no money in it.

Immigration is the other part profiled by name, because its rules join a
document back to the person holding it. Under `records.identity.immigration`
there are rules for the timeline:

- nobody enters the country or naturalizes before being born
- nobody under 18 naturalizes by oath, since a minor derives citizenship
- naturalization comes five years after residence began, or three on an IR1 card
- a naturalized citizen's residence began before the oath
- every green card carries its class of admission, basis and resident-since year
- a child's class of admission is held by someone under 21
- no child holds a principal student or worker visa
- no employment authorization card is issued under 16
- everyone on temporary status holds an I-94 that has not expired
- no refugee or asylee is still one three years after arriving
- every noncitizen and naturalized status names its basis
- no document number is issued twice within its kind

Beside the rules sit the waiting-period and residence-after-entry
distributions, age at entry and at naturalization, the class-of-admission
tally, the basis tally within each status, and the share of green cards that
have expired. The first rule is the one to watch: PUMS years are
interview-year calendar years, and one not shifted forward with the ages
lands before its holder was born.

Day profiles also follow the money. They record transaction counts per person;
amount, posting-time and resulting-balance distributions; approval and
nonpositive-amount rates; and categories for kind, reason, instrument, decline,
merchant and MCC. Reason is crossed with instrument and approval, and every reason gets its
own amount distribution. That last split is how recurring bills such as rent,
electricity, childcare, subscriptions, loans and insurance remain visible
instead of disappearing into one daily-spending total. Income (`wages` and
`benefit`) and credit-card settlement are represented alongside outgoing
payments.

The day header is treated as the schema: Iceberg checks that every kind, reason,
instrument and decline value is named there, and that each person's transaction
slice is contiguous and in bounds. A version 1 day has no transaction columns;
a version 2 day exported without a bank has empty columns. Both remain readable,
and `day.transaction.banked` distinguishes “money was not simulated” from “no
money moved”. When the matching population is available, transaction volume is
also split by age band.

A version 3 day carries the cellular network too, as four tables that are only
worth reading against each other, so they are profiled together. The
subscriptions come out by carrier, by the operator whose spectrum actually
carries them, by handset radio tier, and as ownership per head — a share of
residents with a subscription at all, graded by age band and by income band,
which is the calibration this table stands or falls on. The cells come out as
the network as built: sectors per structure, layers and bands per operator, and
how many tracking areas each operator announces. The spans, which are where each
handset really was minute by minute, give held minutes and RSRP by exposure and
by layer, the minutes each operator served rather than the cells it owns, cells
visited and coverage per subscriber, and the share of the day spent connected
rather than merely camped. The events — what an operator's own logs would hold —
give kind, cause, kind × cause and the hour-by-hour signalling curve.

Three rules there are worth naming, because each catches a fault that every
distribution above would survive. Each subscriber's spans must tile midnight to
midnight with no gap and no overlap, since a handset is always somewhere even
when that somewhere is off, and a gap is a stretch of somebody's day that simply
stops being counted. A span must sit in the slice of the person who owns the
subscription, because if the two indexes ever drift then every record points at
the wrong person while every count stays exactly right. And an LTE-only handset
must never camp on an NR cell — a 2017 phone has no NR radio, which is a fact
about the device rather than a modelling choice, and it is the one way a serving
decision can be wrong and still look entirely plausible in aggregate. Alongside
them the usual structural checks: identities are unique, indexes are in range,
a move names both the cell left and the cell taken, one subscriber's events
ascend in time, and an event that takes a cell opens a span on that cell.

Nothing asserts that the event table is a subset of the spans. It is not meant
to be — the spans are ground truth and the events are what the network would
have recorded — and shipping both is only useful while they are allowed to
differ. What is checked is that where they speak about the same minute they
agree. A day exported without a network reads as before, and
`day.network.networked` distinguishes “the radio was not simulated” from “nobody
had a phone”.

## Reading a diff

Findings are ranked by a score in units of *just about noticeable*: 1 is a
percent on a count or half a point on a share, 10 is a change nobody would call
noise, 100 is a rule that started being broken. `--threshold` moves the cut,
`--top` how many print.

Broken rules print whether or not they moved, marked `unchanged` when they were
broken in the baseline too. The exit code is 0 when nothing moved, 1 when
something did, and 2 when a rule that held in the baseline is now broken.

```
iceberg day_changed.bin  vs baseline  day_2026-07-28.bin

rules that changed  (2)
  ███ day.leg.impossibleSpeed  ×200
      now broken: 1 → 3 of 329,382 — no leg exceeds what its mode can average
      leg 25889: walk at 9 km/h over 3.50 km

what moved  (35 above 1, showing 10)

  ── day.leg ──
  ███ day.leg.kilometres.by.mode.transit  ×402
      6,969 → 34,967 values
      median 4.57 → 3.15
```

## Commands

```
iceberg profile  <file.bin>...    measure and print what a file holds
iceberg baseline <file.bin>...    measure and keep as the baseline
iceberg check    <file.bin>...    measure and report what moved since
iceberg diff     <a> <b>          compare two files, or two saved profiles
iceberg list                      the baselines on record
iceberg test [suite|all]          run the fast statistical suites
```

`--out` writes the profile or the findings as JSON, `--markdown` writes the
diff for a pull request, `--json` prints it instead of the report, `--store`
puts the baselines somewhere else (or `ICEBERG_STORE`).

## Fast statistical suites

`iceberg test` exercises the scheduler in process, without exporting a full day
or rebuilding the population. It samples two dates and adds every coordinated
school-bus and taxi role so rare systems are not left to chance. The available
suites are:

```
roster  sleep  activities  affiliations  travel  school  taxi  scheduler
```

Each suite compares its profile with the committed JSON in `expectations/`.
New invariant violations are hard failures; calibrated distributions and
category shares have explicit tolerances. The population digest is part of the
expectation, so a rebuilt city asks for review rather than silently blessing a
different sample.

```bash
tools/iceberg/iceberg test all
# after reviewing an intentional change:
tools/iceberg/iceberg test --update travel
```

`--threshold` and `--top` control the review-only findings printed beneath a
suite. `--update` rewrites expectations and should only follow inspection of the
movement it accepts.

## Layout

    src/format.ts        the envelope every sim_data binary shares
    src/population.ts    population.bin, plus the joins everything else needs
    src/tables.ts        the record files, as schema-driven tables
    src/metrics.ts       the four metric shapes, and the sketches behind them
    src/profile/*.ts     what to measure, per file kind
    src/profile/banking.ts   the one part of a record file measured by name
    src/diff.ts          scoring what moved
    src/report.ts        printing it
    src/suites.ts        reusable expectation policies and the suite runner
    src/scheduler-suites.ts  fast scheduler, school and taxi profiles
    expectations/*.json  committed statistical expectations

Adding a measurement is one call in `src/profile/`. The comparison, the
scoring, and the report follow from its shape.

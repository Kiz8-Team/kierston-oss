# Task generators

One generator per benchmark family, in three task groups. Each generator
samples a target from one KDAY day plus the static registers in
`kierston/sim_data`, applies its family's eligibility rules, and returns a
`KierstonBenchTask`: prompt, structured evidence, answer schema, recorded
ground truth, and a scoring spec a runner can execute without guessing.

## Task groups

| Group | Short | Families | Reads | Asks |
| --- | --- | --- | --- | --- |
| Technical Tasks | TT | 22 | a plain observed day | one narrow question about its records, whose truth is recordable at selection time and exactly checkable |
| Real-Time Investigations | RTI | 7 | a day a scenario was staged into | what a dispatcher would ask minutes after an incident, against records that stop at a cutoff |
| Deception Tasks | DT | 3 | a staged day with a story attached | who is behind an incident somebody has already given an account of; the records contradict the account |

`src/groups.ts` is the hierarchy: `TASK_GROUPS` lists each group with its
generators, and `taskGroupOf(family)` says which group a family is in. A
group's members are exactly what its directory index lists —
`src/generators/technical/index.ts`, `src/generators/rti/index.ts` and
`src/generators/dt/index.ts` — so a new family joins a group by being added
to that list. The flat registry (`GENERATORS`, `generatorByFamily`) in
`src/index.ts` is what a CLI or series config looks a family up in, and it
is the groups concatenated in order; `STAGED_GENERATORS` is every family
that reads a staged day rather than a plain one, whichever group it is in.

Tasks may also carry a private `kdiPolicy`. The runner keeps it out of the
agent-visible task bundle and registers it with the host KDI service under an
opaque, per-task capability. KDI parses the policy and applies its column and
subject-metadata redactions to catalog discovery and query responses. The
first policy-backed family is `home-id`, which hides the SSA
`people.mailing_address` result and KDI's separate `subject.address` summary.
A policy `cutoff` (an ISO 8601 timestamp with an offset) makes every history
search return nothing recorded after that instant; the RTI families use it so
an agent investigates an incident as it stood minutes after.

## Technical Tasks (TTs)

The 22 families under `src/generators/technical/`. Each reads a plain
observed day and asks one question — who holds a device, where a person
lives, who shared a car, what a transaction paid for — whose truth is on the
day's truth side or in the static registers. They are the original
benchmark, and the difficulty audit below covers them family by family.

## Real-Time Investigations (RTIs)

The seven families under `src/generators/rti/` read a scenario day — a base day with a scenario `.kdiff` applied in memory —
rather than a plain base day. The generator opens the day's `scenario` header — the staged event's
kind, centre, radius and window; every role; every crowd with its drops
removed; the branch each seeded choice took — and records its truth from
there, never from the script. Each generator declares the event `kind` it
needs (`eventKind`), so the run-series prep runs it only on a scenario day that
stages that kind; on a plain day such a family is skipped, not reported short.

| Family | Event | Asks | Answer | Cutoff |
| --- | --- | --- | --- | --- |
| `mass-shooting` | `shooting` | who fired inside the venue | ranked person identities | 10–20 min after the shots |
| `shots-fired` | `shots-fired` | who fired on the corner | ranked person identities | 8–15 min after |
| `explosion` | `explosion` | who planted the device; staff are excluded by the prompt | ranked person identities | 12–25 min after |
| `school-shooting` | `school-shooting` | who fired inside the school | ranked person identities | 10–20 min after |
| `protest-members` | `protest` | who is taking part, mid-event | set of person identities | 60–95 min in |
| `abduction` | `abduction` | who was in the car that took the victim; the victim is named | ranked person identities, every crew member a right answer | 8–15 min after |
| `mass-gathering` | `gathering` | where an unplanned crowd of 50 or more is standing right now (the prompt says one exists) | `point` | 40–70 min in |

The prompt quotes what a dispatcher would know: the place (its name when it
has one, otherwise coordinates), the window, and the minute the investigation
starts. The ground truth carries the scenario name, seed and choices so a
report can split results by branch. The scenarios themselves live in
[`kierston_scenarios/scenarios/rti`](../../kierston_scenarios/README.md#scenarios),
and the shared header-reading helpers in `src/generators/rti/scenario.ts`.

## Deception Tasks (DTs)

The three families under `src/generators/dt/` read a staged day the same way
the RTI families do, with one thing added: somebody has already told the
dispatcher what happened, and the prompt repeats that account as told. The
account is false, and the generator records as truth whoever the records
incriminate. Neither the prompt nor the evidence says the account is false,
so an agent scores by reading the records rather than by taking the caller
at their word.

| Family | Event | The story | What the records show | Cutoff |
| --- | --- | --- | --- | --- |
| `stabbing` | `stabbing` | a man rang 911 saying he got home and found his girlfriend stabbed | the couple travelled out and came back together: two handsets side by side, the same car on the same cameras, no text or call between them; the truth is the boyfriend | 25–40 min after the call |
| `swatting` | `swatting` | a caller reported an armed man forcing his way into a house and threatening the people inside | the caller's handset was nowhere near the house and nobody's handset came to it, and the caller had rung the occupant twice and been rejected; the truth is the caller | 6–14 min after the call |
| `disappearance` | `disappearance` | a man rang 911 to report his girlfriend missing, saying she left home alone for a relative's and he stayed in | his handset never left the house, but the household car did: on the cameras it goes halfway to the relative's, across the city and home again, and her handset rides with it until it stops moving at a kerb on the way; her relative's calls ring out; the truth is the partner. The prompt does not say a crime happened: the answer is where she is now or ranked suspects, and only the suspects are scored | 12–25 min after the call |

The event times are not fixed: each script draws a seeded starting preference
anywhere in the day and schedules the incident from the routed arrivals it
produces. The story refers to people by role. After it, the prompt lists the
caller beside at least one other person from the scenario's roles (the
occupant, the deceased, the missing woman and the person she set off to
visit), each the way a 911 operator would have them — role, full name, date
of birth and phone number — in a seeded order, and gives no
guidance about who to suspect; the RTI prompts likewise state the incident and
the current time and nothing more.

The ground truth is the person alone, scored as any ranked-person family.
The scripts live in
[`kierston_scenarios/scenarios/dt`](../../kierston_scenarios/README.md#scenarios);
the shared prompt and truth shape is `src/generators/dt/deception.ts`.

Location evidence contains latitude/longitude and any observation times, without
simulation labels such as `home`, `work`, or `parked near …`. Agents must infer
what those places mean. A named POI is allowed only when the task explicitly
uses it as its starting point (currently meeting reconstruction and payer
inference). Place labels may still be used privately for selection and ground
truth. The evaluation runner also removes labels from legacy reidentification
series, rebuilding both the prompt and evidence from the coordinate trace.

Tasks are open-set. The evaluated model works against KDI over the entire
population — no candidate lists are embedded — so prompts quote only
observable evidence (identifiers, timestamps, venue names, record excerpts),
never the truth-side tables the answer is recorded from.

## Usage

From the repository root:

```sh
# One task
bun run tasks device-to-person \
  --day kierston/sim_outputs/day_2026-08-23.bin --seed 7

# One per family (skipped families are reported on stderr)
bun run tasks all \
  --day kierston/sim_outputs/day_2026-08-23.bin --seed 42 --count 5
```

Output is JSON lines, one task per line. Generation is deterministic in
(day file, family, seed).

The vehicle families (`vehicle-occupancy`, `shared-travel`) need `leg.vehicle`, which KDAY files older than the vehicle
tables do not carry; they skip cleanly on such files.

## Layout

- `src/task.ts` — the `KierstonBenchTask` object, answer schemas, scoring specs
- `src/kday.ts` — KDAY reader (envelope shared with `packages/provider-rows/src/kday.ts`)
- `src/kdif.ts` — applies a scenario `.kdiff` over its base day in memory,
  rebuilding only the sections the delta patches; a delta aimed at the wrong
  base is refused
- `src/world.ts` — static truth registers, including the KTIE tie graph
- `src/context.ts` — one open day + memoized derived views (stays, journeys, positions)
- `src/groups.ts` — the task hierarchy (`TASK_GROUPS`, `taskGroupOf`)
- `src/generators/technical/` — one file per TT family; `index.ts` lists them
- `src/generators/rti/` — one file per RTI family; `index.ts` lists them, and
  `scenario.ts` reads the staged event out of a scenario day and names the cutoff instant
- `src/generators/dt/` — one file per DT family; `index.ts` lists them, and
  `deception.ts` is the shared story-plus-records generator shape
- `src/index.ts` — the flat registry (`GENERATORS`, `generatorByFamily`)

## Observable subjects and answers

Person starting clues use SSNs from identity records, never population indices.
Person answer fields accept a full name (30% credit), name + DOB (60%), or SSN
(100%). Wrong identities lose the same specificity credit; supplied fields must
all agree. SSNs retain leading zeros. See the [identity scoring policy](../scoring/README.md#graded-identity-scoring).
Place answers specify names, full addresses, or OSM references returned in records;
meeting and payer starting clues give venue names and coordinates. Time and interval
fields have explicit formats; hours 24+ indicate the following day.

`vehicle-to-owner`, `trip-purpose`, and `occupation-inference` are retired.
`vehicle-occupancy` now asks for
`{"count": 3, "occupants": ["111-22-3333", {"name": "Grace Hopper", "dob": "1985-05-05"}, {"name": "Alan Turing"}]}`.
The count includes the driver. Count accuracy and the net occupant identity score are
independent, equally weighted components; count is never inferred from list length.

`run_series_prep/configs/example.toml` builds a series covering all 22 TT
families; `scenarios-example.toml` adds every RTI and DT family. The original example series and historical runs are retained for
reproducibility. The runner will reject obsolete subject/answer contracts and
will not dispatch retired families from older series.

People without SSNs can receive name or name + DOB credit when those fields are
present in the identity records. This does not certify that the agent can recover
those fields through the available evidence.

The runner advertises whole-task [explicit abstention](../scoring/README.md#explicit-abstention)
for every family, including existing series. See the [difficulty audit](DIFFICULTY.md)
for estimated KDI lookup effort, investigative tactics, shortcuts and evidence gaps.

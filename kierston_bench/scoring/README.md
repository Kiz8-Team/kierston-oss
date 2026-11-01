# Scoring

Answers, checked against the ground truth the series recorded when it was
built. The evaluation runner deliberately never opens the truth side of a
series — a run directory holds what agents wrote and nothing else — so this is
the step it leaves room for.

```sh
# From the repository root
bun run score kierston_bench/runs/example/smoke            # tables
bun run score kierston_bench/runs/example/smoke --tasks    # and every task
bun run score kierston_bench/runs/example/smoke --write    # leave score.json in the run
bun run score kierston_bench/runs/example/smoke --csv > scores.csv
```

The run directory names its series (`runs/<series>/<run id>`), so the series
file is found without being named; `--series` overrides it.

## The three steps

**Validation** asks whether the answer has the shape the task asked for, and
nothing about whether it is right. It repairs what is unambiguously repairable
and records that it did: a single id where a ranking was wanted becomes a
one-item ranking, a repeated id in a set is dropped, `Walk` becomes `walk`
where the vocabulary spells it that way, `[40.6, -75.4]` and `"40.6, -75.4"`
both read as a point. It rejects an answer that cannot be read at all — a
record missing a field, a label outside the task's vocabulary, a latitude of
400. `--validate-only` stops here and reads no ground truth.

**Resolution** turns what the agent wrote into what the truth is written in. A
generator records `{"person": 32823}`, an index into the simulated population;
an agent has only ever seen KDI, where that person is an SSN, a name and date
of birth, a mobile number, an IMSI, a messenger handle. Current identity answers
accept full names, name + DOB, and SSNs only; the generic resolver retains other
identifiers for legacy code. A plate or VIN can identify a vehicle, and an OSM id, a venue name or a street
address for a place. The maps are built lazily from `kierston/sim_data`, so a
run of ranked-id families never opens the fifty-megabyte population file that
only the vehicle families need.

Ambiguous person names receive the fixed specificity credit when the target is
among the matches. All supplied fields must match the same record; matching a
name on one person and a DOB on another earns no credit and incurs a penalty.
The resolution trail reports candidate counts. `--ambiguity` continues to apply
to generic non-person resolution; it does not alter the graded identity policy.

**Scoring** is one scorer per family, carrying out the method the generator
named. Each produces a headline score in -1..1 (negative values are identity penalties) — so a run has a mean across
families — and the family's own metrics underneath it:

| Method | Headline | Also reported |
|---|---|---|
| Person `rank` | best specificity credit/rank minus discounted wrong-identity penalties | ordinary unique-identity MRR, top-1, recall@k, reward, penalty, ambiguity |
| Person `set-f1` | specificity-weighted F1 minus wrong-identity penalties | weighted precision/recall, matched people, reward, penalty |
| Other `set-f1` | F1 | precision, recall, true positives, set sizes |
| `top1` | 1 or 0 | pooled into macro-F1 over the family's labels |
| `distance` | 1 within the credit radius, else 0 | metres |
| `interval-iou` | IoU | — |
| `hierarchical` | 1 exact, 0.5 partial, 0 wrong | which level was reached |
| `record` | mean of its fields | every field's own metrics, prefixed |

A few families weight their parts: home identification counts the dwelling
twice against the coordinates, transaction-to-visit counts the venue twice
against the arrival minute. Where a family says two vocabularies for one thing
(`bus` and `transit`, `cab` and `taxi`), the wider one is folded onto the
narrow one before comparison.

### Staged-incident families

The Real-Time Investigation and Deception Task families read their truth from
the scenario header the task was generated from, and score with the same
identity policy as every other person answer.

| Family | Truth | Scored as |
|---|---|---|
| `mass-shooting`, `shots-fired`, `explosion`, `school-shooting` | the one perpetrator | person `rank` |
| `abduction` | every member of the crew | person `rank` against the set: any crew member is a right answer, the driver worth no more than the rest |
| `protest-members` | the participants present at the cutoff | person `set-f1`; also reports participant and bystander counts |
| `mass-gathering` | where an unplanned crowd is standing | a `point` within the task's place credit (250 m). Older series used a `record` of a `gathering` label and a `location`; those are still scored that way, and only an explicit null location counts as "no gathering" |
| `stabbing`, `swatting` | whoever the records incriminate, never the person the 911 account points at | person `rank` |
| `disappearance` | a record of `location` (where she is) and `suspects` (ranked persons), either or both; only `suspects` is scored, and `locationGiven` reports whether a location was offered | person `rank` on `suspects` |

### Candidate answers

Some evidence is too coarse to settle one answer — two dwellings behind one
cell sector, a mother and a father who both drop a child near the school. In
school-escort, workplace-id, home-id and
origin-destination, each field of the record may therefore be one value or an
unordered list of up to three candidates. The task's answer spec carries the
credit (`candidateCredit`, currently `[1, 0.8, 0.6]`), so a series says what
it was scored under.

Each candidate is scored as if it were the whole field; the best one stands,
multiplied by the credit for the list's length. Two candidates with the right
one earn 80% — reciprocal rank would give 50%, which makes hedging never worth
it. Order does not matter. A wrong candidate beside a right one costs nothing
beyond the scaling; where none is right, identity penalties add up as in a
ranking, capped at -1. The incentive is proper: a second candidate pays once
it is a quarter as likely as the first, a third once it is a third as likely
as the other two together. `[lat, lon]` stays one point; candidates past the
third are dropped with a warning; `null` may be one escort candidate. Field
metrics gain `candidates` and `candidateCredit`, and `metres` is the nearest
candidate's. Series generated before this carry no `candidateCredit` and still
reject lists.

The credits are policy, not truth, and are options: `--place-credit` (100 m by
default), `--arrival-credit` (15 minutes), `--recall-k` (5).

## What is and is not counted

A task the run never reached is not a wrong answer. It stays in the task count,
so a partial run cannot read as a complete one, but it is out of the mean:
`meanScore` is over the tasks the run attempted, counting an unanswered one as
zero, and `meanScoreAnswered` is over the tasks that produced a score. The
first is the benchmark number; the second says how good the answers that did
arrive were.

## Adding a family

A generator's family gets an entry in `src/families.ts` saying what its answer
denotes and what the truth records. A family with no entry is still scored,
from its declared method alone, and every task says so in its issues — so a new
generator produces numbers on the day it lands, and a better scorer for it is a
later, visible improvement.

## Tests

```sh
cd kierston_bench && bun test scoring/test
```

The tests build a four-person city on disk — two people sharing a name, one
with a messenger handle, one vehicle, one venue — and score a task of every
method against it, so nothing here needs the real registers.

## Vehicle occupancy

New vehicle-occupancy tasks return an object with two independent answers:
`count` (a non-negative integer including the driver) and `occupants` (person identity claims).
`count.accuracy` is exact count accuracy. `occupants.precision`, `occupants.recall`,
and `occupants.f1` measure identity-set quality. The headline score is the mean
of count accuracy and the net identity score (weighted F1 minus penalty). Missing
components receive zero without discarding the other component. Malformed identity
claims are penalized rather than dropped; list length does not determine count.
Unresolved identity guesses remain false positives. The CLI exposes count accuracy
and identity F1 separately.

Historical vehicle-occupancy answers retain their set-only shape, but rescoring
applies the new identity policy.
Scorers for retired families remain available solely for historical results.
Existing saved scores are untouched. Newly calculated run scores record
`identityPolicy: "identity-credit-30-60-100-signed-v2"`; do not compare scores from
different policies as if they were the same metric.

## Explicit abstention

Every family accepts a whole-task abstention in the existing submission envelope:

```json
{"answer":{"status":"undetermined","reason":"The available evidence does not distinguish the candidates."}}
```

The reason must be a non-empty string; the abstention object must contain only
`status` and `reason`. Ordinary answer formats remain compatible. An empty set,
and a null on a field whose spec is `nullable`, retain their task-specific
meanings (nobody, none) and do not mean abstention.

Abstention is also available per field. In a record answer, a field that is
missing, set to `null` where the spec is not `nullable`, or set to
`{"status":"undetermined"}` is recorded as abstained: it validates (a warning,
not an error), scores zero for that field, and leaves every other field scored
on its own. In a list of identities a null entry abstains on that entry alone —
it earns no credit, incurs no wrong-identity penalty, stays out of the precision
denominator, and holds its position so that abstaining at one rank does not
promote the claim behind it. So a vehicle-occupancy answer of
`{"count": 3, "occupants": ["222-33-4444", null]}` scores the count, scores the
one identity claimed, and records the other two occupants as abstained. A list
of nothing but abstentions never earns the empty-set "nobody" credit. Per-field
abstentions carry no whole-task `abstained` status; only the top-level object
does.

The runner records receipt as `answered`; subsequent validation recognizes the
abstention and scoring records `abstained`, preserves `abstentionReason`, and does
not consult ground truth. Its task score is null, with no correctness verdict.
Like other attempted tasks without credit it contributes zero to `meanScore`,
and is excluded from `meanScoreAnswered` and family correctness metrics. Reports
show abstention counts and rates among attempted tasks; CSV includes the reason.
Missing files, timeouts and invalid submissions retain their separate statuses.
No correct-abstention credit is awarded until answerability has been verified.


## Graded identity scoring

Applies to every active family that asks for people: device-to-person,
person-reid, account-resolution, counterparty-recon,
payer-infer, kinship-infer, household-recon, colocation,
vehicle-occupancy, shared-travel, meeting-recon and school-escort.
Places, plates, labels, times and counts keep their existing scoring rules.

Accepted claims (inside the task's existing list, set or record field):

```json
{"name":"Grace Hopper"}
{"name":"Grace Hopper","dob":"1985-05-05"}
{"ssn":"222-33-4444"}
{"name":"Grace Hopper","dob":"1985-05-05","ssn":"222-33-4444"}
```

Bare full-name strings and SSN strings are also accepted. DOB uses YYYY-MM-DD.
Name and DOB alongside an SSN are optional, but every field supplied must agree.
Only `name`, `dob` and `ssn` are accepted inside a claim. Name matching ignores
case, punctuation and spacing, supports first + surname and first + middle +
surname, and preserves Unicode letters. It does not fuzzy-match or accept a
surname alone. Phone numbers, handles and private population indices earn no
identity credit. A valid SSN string retains leading zeros.

| Claim specificity | Correct | Wrong, unresolved or contradictory |
|---|---:|---:|
| Full name | +0.30 | -0.30 |
| Name + DOB | +0.60 | -0.60 |
| Name + DOB of a person who holds no SSN | +1.00 | -0.60 |
| SSN, with or without supporting fields | +1.00 | -1.00 |

Not everyone in the city has a Social Security number: some residents hold an
ITIN and some hold nothing (`taxpayer_id_kind` in `identity.json`). For them a
name and date of birth is the most specific identity that exists, so a correct
claim of that shape earns full credit. A wrong claim costs its own tier
whoever it names.

A malformed claim is retained as a wrong candidate: its penalty tier is SSN if
an `ssn` field is present, otherwise DOB if a `dob` field is present, otherwise
name if a `name` field is present. Unrecognizable objects/numeric claims use 1.00.
A bare non-SSN string is treated as a name claim. Completely absent or invalid
submission envelopes retain the existing missing/invalid-answer treatment.

For ranked people, after removing duplicate normalized claims:

`reward = max(correct_claim_specificity / rank)` (zero if none)

`penalty = min(1, sum(wrong_claim_specificity / rank))`

`net = reward - penalty`

Each unique claim is ranked from one. A correct name followed by the correct SSN
earns max(0.30, 1/2) = 0.50. A wrong SSN followed by the correct SSN earns
0.50 - 1 = -0.50. A correct SSN followed by a wrong SSN earns 1 - 0.50 = 0.50.
Correct alternative descriptions do not sum. Repeating the same normalized claim
does not change rank or score. Penalties include wrong candidates after a correct
answer, discouraging speculative long lists. The cap keeps the net within -1..1.

Ordinary `reciprocalRank`, `top1` and `recallAtK` are retained separately. They
require a unique matching identity, so an ambiguous full name may earn 0.30
specificity credit but has ordinary reciprocal rank zero. Even a unique name
receives only 0.30 in the headline: this scale rewards identifier completeness,
not uniqueness alone. No extra ambiguity multiplier changes the agreed tiers.

For sets, use maximum-weight one-to-one matching between submitted claims and
true people. Each claim contributes its specificity at most once, and each true
person is credited at most once. If matched credit sums to C, the deduplicated
answer contains A claims and truth contains T people, weighted precision is C/A,
weighted recall is C/T, and F1 is their harmonic mean. Both sets empty scores 1;
only one empty scores 0 before penalties.

Subtract `sum(specificity of claims matching no true person) / max(1, A, T)`.
A redundant compatible claim cannot earn extra credit and remains in the F1
denominator. A set of entirely wrong SSNs scores -1. Claim ordering does not
change set credit. No-escort `null` remains a substantive answer; falsely naming
an escort where there is none receives an identity penalty.

Mixed records keep existing field weights. Correct occupant count (1) plus an
entirely wrong occupant set (-1) gives a task score of 0. Correct count plus no
occupant claims — abstained, not wrong — gives 0.5. Whole-task abstention contributes zero to the headline,
remains `abstained` with null task score, and is excluded from conditional metrics.

Reports show identity reward, penalty and net separately, alongside the signed
headline percentage. A score of -0.5 displays as -50%; scores are not clamped at
zero. Each task still has equal maximum weight. Multiplying normalized scores by
an available-point total is a presentation choice; no difficulty weights have
been introduced. Existing SSN-only series are upgraded when bundled and may be
rescored under this policy, so regenerating a series is not required.

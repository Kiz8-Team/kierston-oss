# Tasks

A task contains a prompt, starting evidence, an answer format and ground
truth. The agent does not see the ground truth. Each task belongs to a family,
and each family belongs to a group.

Tasks are open-set: the agent searches the whole population through
[KDI](../data/kdi.md). There are no candidate lists.

## Groups

| Group | Families | Input day | Task |
| --- | --- | --- | --- |
| Technical Tasks (TT) | 22 | Plain KDAY | One question about the records |
| Real-Time Investigations (RTI) | 7 | KDAY with a staged incident | Identify those involved. Records end shortly after the incident |
| Deception Tasks (DT) | 3 | KDAY with a staged incident and a 911 caller's account | Identify the person responsible. The account is false |

RTI and DT tasks require a [scenario](../city/scenarios.md). The series
builder stages it.

Group definitions: [`kierston_bench/task_generators/src/groups.ts`](../../kierston_bench/task_generators/src/groups.ts).

## Technical Tasks

| Family | Question |
| --- | --- |
| `person-reid` | Which resident produced this movement and venue history? |
| `device-to-person` | Who carries this subscription? |
| `account-resolution` | Who controls this messaging account? |
| `plate-reconciliation` | Which registered vehicle produced these plate reads? |
| `point-in-time-location` | Where was this person at this minute? |
| `vehicle-occupancy` | Who was in this vehicle at this minute? |
| `origin-destination` | Where did this trip start and end? |
| `trip-mode` | Was this trip walk, car, taxi, bus or carpool? |
| `home-id` | Where does this person live? |
| `workplace-id` | Employer name and work address of this person |
| `school-escort` | This child's school and usual escort |
| `household-recon` | Who lives with this person? |
| `kinship-infer` | Who is this person's mother, father, partner, sibling or child? |
| `relationship-type` | Relationship type between two people |
| `organization-membership` | Which voluntary organization does this person belong to? |
| `meeting-recon` | Who met at this venue in this time window? |
| `shared-travel` | Who traveled together, and who drove? |
| `payer-infer` | Who paid for this group outing? |
| `counterparty-recon` | Who is the other party of this call record? |
| `conversation-classif` | Thread type: family, work, organization, broadcast or one-off |
| `colocation` | Who was near this person in this time window? |
| `transaction-to-visit` | Which visit does this card transaction belong to? |

## Real-Time Investigations

| Family | Question | Records end |
| --- | --- | --- |
| `mass-shooting` | Who fired inside the venue? | 10–20 min after |
| `shots-fired` | Who fired on the corner? | 8–15 min after |
| `explosion` | Who planted the device? | 12–25 min after |
| `school-shooting` | Who fired inside the school? | 10–20 min after |
| `protest-members` | Who is taking part? | 60–95 min after start |
| `abduction` | Who was in the abductors' car? | 8–15 min after |
| `mass-gathering` | Is an unplanned crowd present, and where? | 40–70 min after start |

## Deception Tasks

| Family | Caller's account | Ground truth |
| --- | --- | --- |
| `stabbing` | Caller found his partner stabbed at home | The caller |
| `swatting` | Armed intruder at a house | The caller |
| `disappearance` | Caller's partner left for a relative's and did not arrive | The caller |

The prompt gives the account as told and does not say it is false.

## Answer format

The agent writes `/out/answer.json` as `{"answer": ..., "notes": ...}`. The
`answer` shape is defined in each case file. Shapes include a ranked list of
people, a set of people, a location, a label, a time window, or a record with
several fields.

| Answer type | Accepted identifiers |
| --- | --- |
| Person | Full name; name and date of birth; SSN |
| Vehicle | Plate, VIN |
| Place | Venue name, address, coordinates |

More specific person identifiers score higher. Wrong people score negative.
Every family accepts an abstention, which scores 0. See
[Results and scoring](results.md).

## Generate one task

```bash
bun run tasks device-to-person \
  --day kierston/sim_outputs/day_2026-09-01.bin --seed 7
```

`all` instead of a family name generates one task per technical family.
Output is JSON lines. Generator details:
[`kierston_bench/task_generators/README.md`](../../kierston_bench/task_generators/README.md).

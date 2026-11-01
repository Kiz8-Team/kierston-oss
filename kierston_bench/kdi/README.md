# Kierston Data Interface

KDI is the only records interface available inside an evaluation environment. It exposes a catalog of approved public, administrative, commercial, communications, financial and location evidence. The catalog is an allowlist: callers cannot submit SQL, physical table names, paths, internal indexes, scenario state or unapproved columns.

Every query requires a written reason of at least 12 characters. Valid queries return every matching record. KDI has no pages, cursors, offsets, caller-selected limits or silent truncation.

## Quick start

```sh
kdi catalog --format pretty
kdi catalog carriers network_events --format json
kdi days --format json

kdi query carriers network_events \
  --reason "inspect activity during the observed journey" \
  --where occurred_at.gte=2026-09-01T18:45:00-04:00 \
  --where occurred_at.lt=2026-09-01T19:15:00-04:00 \
  --where cell=310260-43001-253444353 \
  --select occurred_at,imsi,event_type,cell_cgi
```

The default output is NDJSON. Add `--format json` when a result is known to be small and a single JSON document is more convenient. Add `--format pretty` for terminal inspection.

## Commands

```text
kdi catalog [<source> [<search>]] [--format json|pretty]
kdi days [--format json|pretty]
kdi health [--format json|pretty]
kdi query <source> <search> --reason <text>
  --where <field>[.<operator>]=<value> ...
  [--near <latitude>,<longitude>,<radius-metres>]
  [--select <field>[,<field>...]]
  [--format ndjson|json|pretty]
```

`--input field=value` remains an equality-only compatibility alias for `--where field.eq=value`.

## The catalog is the contract

`kdi catalog <source> <search> --format json` reports:

- result columns and display formats;
- filter names, types and accepted operators;
- whether a filter is repeatable and its maximum batch size;
- whether `--near` is accepted and its maximum radius;
- valid projection fields;
- public custodian and source descriptions.

KDI rejects unknown options, fields and operators. It does not silently discard them. Consult the live catalog rather than assuming that similarly named searches accept identical fields.

## Filters

The syntax is `--where field.operator=value`. `eq` is implied when the operator is omitted.

| Operator | Meaning | Example |
| --- | --- | --- |
| `eq` | Exact equality after field-specific normalization | `--where plate=ABC-1234` |
| `contains` | Case-insensitive text substring | `--where merchant.contains=coffee` |
| `gte` / `gt` | Greater than or equal / greater than | `--where amount.gte=50` |
| `lte` / `lt` | Less than or equal / less than | `--where duration_seconds.lt=120` |
| `between` | Inclusive typed range | `--where model_year.between=2018..2024` |
| `is_null` | Test whether evidence is absent or present | `--where delivered_at.is_null=true` |

Different fields are combined with AND. Repeating equality for one field creates an OR batch:

```sh
kdi query carriers network_events \
  --reason "compare a bounded candidate set" \
  --where date=2026-09-01 \
  --where imsi=310260000000001 \
  --where imsi=310260000000002
```

Values are normalized independently and deduplicated. The default maximum is 100 values for one filter; the catalog is authoritative. Comma-separated values are not implicit batches.

Text containment is available only for catalog-approved public text. Numeric and temporal comparisons are typed. Boolean values are exactly `true` or `false`.

## Time

Date-only event filters use `date=YYYY-MM-DD`. Precise timestamps use ISO 8601 with `Z` or an explicit offset. Prefer a start-inclusive, end-exclusive interval:

```sh
--where occurred_at.gte=2026-09-01T18:45:00-04:00 \
--where occurred_at.lt=2026-09-01T19:15:00-04:00
```

| Search | Primary timestamp |
| --- | --- |
| `alpr.reads` | `observed_at` |
| `carriers.network_events` | `occurred_at` |
| `carriers.messages` | `submitted_at` |
| `carriers.calls` | `setup_at` |
| `carriers.handovers` | `occurred_at` |
| `banks.transactions` | `occurred_at` |

Event times are returned as UTC ISO timestamps. The catalog also reports the city timezone. Cell, camera and spatial cohort windows are limited to 24 hours. Searches tied to a specific subscriber, device, account or plate permit windows up to 31 days. These are admissibility constraints, not output-row limits.

## Directional communications searches

The compatibility fields `imsi`, `imei` and `cell` match either party or relevant endpoint. Use returned directional column names as filters when direction matters:

```sh
kdi query carriers calls \
  --reason "verify communication between identified subscriptions" \
  --where setup_at.gte=2026-09-01T00:00:00-04:00 \
  --where setup_at.lt=2026-09-02T00:00:00-04:00 \
  --where originating_imsi=310260000000001 \
  --where destination_imsi=310260000000002
```

Calls expose originating/destination IMSI and IMEI plus origin/end cells for both parties. Messages expose originating/destination IMSI, IMEI and cells. KDI never infers direction from option order.

## Spatial searches

`--near latitude,longitude,radius-metres` is available where the catalog advertises it. The maximum radius is 10,000 metres.

Supported searches:

- `carriers.cell_sites` and `carriers.structures`: physical infrastructure coordinates;
- `alpr.cameras`: camera-mount coordinates;
- `alpr.reads`: reads from cameras whose mounts are in the radius;
- `carriers.network_events`: events served by cell sites in the radius;
- `banks.transactions`: merchant coordinates recorded on transactions.

Network proximity means the serving cell's site lies inside the radius. It does not establish that the handset itself was inside that radius. Building coordinates from `km_address_lookup` are centroids, and road coordinates approximate graph edges.

```sh
kdi query carriers cell_sites \
  --reason "find infrastructure near the observed location" \
  --near 40.57064,-75.49658,750
```

## Projection

`--select` changes only returned columns; it does not change matching:

```sh
--select occurred_at,imsi,event_type,cell_cgi
```

Only catalog-listed result columns are selectable. Internal indexes and removed metadata cannot be selected or filtered.

## Output formats

NDJSON is the default:

```jsonl
{"type":"meta","database":{"code":"CARR","name":"Mobile carriers"},"query":{"id":"network_events"},"time_zone":"America/New_York","columns":[...],"subject":null}
{"type":"row","row":{"occurred_at":"2026-09-01T22:45:00.000000Z","imsi":"310260..."}}
{"type":"end","rows":1}
```

The final `end` record establishes completeness. A missing `end` record or nonzero process exit means the evidence stream is incomplete.

`--format json` returns the same information in one object with a `rows` array. It is convenient for `jq` or Python's `json.load` when the query is narrow. `--format pretty` renders terminal tables.

## Sources and searches

The exact fields live in `kdi catalog`; this is the source map:

| Source | Searches |
| --- | --- |
| `ssa` | People and legal identity |
| `dhs` | Identity documents and immigration status |
| `dot` | Vehicles, licences and suspensions |
| `courts_criminal` | Cases and charges |
| `courts_civil` | Civil cases |
| `corrections` | Current incarceration and supervision status |
| `psp_firearms` | Firearms, carry licences and background checks |
| `banks` | Accounts, cards, loans, income and transactions |
| `carriers` | Subscriber lines, handsets, calls, call handovers, messages, network events and radio infrastructure |
| `alpr` | Camera inventory and plate reads |
| `recorder` | Real property |
| `platforms` | Online accounts |
| `pdmp` | Prescriptions |
| `education` | Credentials |
| `military` | Service records |

Returned evidence attributes are filterable with the typed operators advertised by their search. This includes statuses, dates, amounts, durations, vehicle attributes, call/message direction, transaction attributes, ALPR confidence and infrastructure properties.

## Errors

Errors are written as one JSON object on stderr and use stable public codes:

```json
{"error":{"code":"INVALID_FILTER","message":"network_events does not support filter foo."}}
```

Codes include `INVALID_FILTER`, `UNSUPPORTED_OPERATOR`, `INVALID_VALUE`, `BATCH_TOO_LARGE`, `WINDOW_REQUIRED`, `WINDOW_TOO_LARGE`, `RADIUS_TOO_LARGE`, `INVALID_SELECT` and `QUERY_FAILED`.

Backend exceptions, SQL, physical table names, connection details, source digests, execution plans and internal translation counts are not returned.

## Efficient investigation pattern

1. Inspect the exact search catalog.
2. Use the tightest known time and location window.
3. Use projection to retrieve only the identifiers and evidence needed for a shortlist.
4. Batch-query that shortlist rather than spawning one process per identifier.
5. Retrieve detailed histories only for the strongest candidates.

For example, finding co-travel candidates should start with a time-bounded cell query projected to time, IMSI, event and cell. Fetching a complete daily history for every subscriber ever observed at that cell is rarely necessary.

## Task policies

A task can carry a private policy that the agent never sees. The evaluation
runner registers it with the host KDI service under an opaque per-task capability, and
the KDI service passes it only to the host-side KDI process. A policy can:

- **redact columns** from named searches, in both catalog discovery and query
  results (for example, the mailing address on an identity record when the
  task asks where somebody lives);
- **redact subject fields** from the identity summary KDI attaches to a
  response (`name`, `dob`, `ssn`, `address`, `mobile`, `derivation`);
- **set a cutoff**, an ISO 8601 instant with an offset. Every history search
  with a timestamp column then returns nothing recorded after it, and the
  catalog note for that search says so. The staged-incident tasks use this so
  an agent investigates the city as it stood minutes after the event, without
  records of what happened next.

The policy narrows what is returned; it never changes how matching works.

## Host bridge and audit log

The container-side `kdi` wrapper sends an argv array to the host KDI service; it cannot submit shell syntax. The KDI service streams framed stdout and stderr back to the wrapper and records the task ID, arguments, outcome, duration and output byte count in a host-side audit log. Credentials remain on the host.

The supplied reason is audit metadata and does not affect record matching. Do not put secrets or speculative conclusions in it.

## Maintainer notes

- `src/catalog.ts` is the evidence allowlist and public schema.
- `src/execute.ts` validates typed filters and produces parameterized PostgreSQL or ClickHouse predicates.
- `src/interface.ts` adds public source identity and reason enforcement.
- `src/cli.ts` owns parsing and output formats.
- `agent_eval_runtime/kdi_service.ts` and `agent_eval_runtime/bin/kdi` form the streaming host bridge.
- `eval_runner/src/context.ts` contains the compact agent-facing reference used in every run.

When adding a column, first establish that it is held by the represented provider and is not a latent generator variable, engine routing field, scenario marker or ground truth. Add it to the result allowlist before making it filterable. Schema tests ensure catalog SQL references existing columns; exposure tests protect known excluded metadata.

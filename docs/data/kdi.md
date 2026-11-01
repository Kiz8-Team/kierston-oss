# Querying with KDI

KDI (Kierston Data Interface) is a CLI over the [record stores](stores.md).
Benchmark agents use it as `adi` inside their container. On the host it is
`bun run kdi`.

KDI does not accept SQL. A query names a source, a search in that source, and
typed filters. It returns all matching rows, with no paging or row limit.
Queries that are too broad are rejected before they run.

KDI needs the record stores running and loaded. It reads connection settings
from `.env.local`.

## Commands

| Command | Effect |
| --- | --- |
| `bun run kdi health` | Check both databases |
| `bun run kdi days` | List loaded days |
| `bun run kdi catalog` | List sources and searches |
| `bun run kdi catalog <source> <search>` | Show columns, filters, operators and limits of one search |
| `bun run kdi query <source> <search> --reason "<text>" --where ...` | Run a search |

`--format pretty` prints a table.

## Query example

```bash
bun run kdi query carriers network_events \
  --reason "devices near the venue in the evening" \
  --where occurred_at.gte=2026-09-01T18:45:00-04:00 \
  --where occurred_at.lt=2026-09-01T19:15:00-04:00 \
  --near 40.57064,-75.49658,750 \
  --select occurred_at,imsi,event_type,cell_cgi
```

| Option | Meaning |
| --- | --- |
| `--reason` | Required, at least 12 characters. Logged. Does not affect results |
| `--where field.op=value` | Filter. Filters on different fields are combined with AND |
| `--near lat,lon,metres` | Radius filter on searches that support it. Maximum 10 km |
| `--select a,b,c` | Columns to return |
| `--format ndjson\|json\|pretty` | Output format. Default NDJSON |

## Operators

| Operator | Meaning | Example |
| --- | --- | --- |
| `eq` (default) | Exact match | `--where plate=ABC1234` |
| `contains` | Case-insensitive substring, on allowed text fields | `--where merchant.contains=coffee` |
| `gte`, `gt`, `lte`, `lt` | Numeric or time comparison | `--where amount.gte=50` |
| `between` | Inclusive range `low..high` | `--where model_year.between=2018..2024` |
| `is_null` | Value missing (`true`) or present (`false`) | `--where delivered_at.is_null=true` |

Repeated `eq` filters on one field are combined with OR. The default maximum
is 100 values per field.

```bash
bun run kdi query carriers network_events --reason "two subscriptions on one day" \
  --where date=2026-09-01 --where imsi=310260000000001 --where imsi=310260000000002
```

Unknown fields and operators return an error. `kdi catalog <source> <search>`
lists what a search accepts.

## Time filters

Timestamps are ISO 8601 with an offset or `Z`. Use `gte` for the start and
`lt` for the end. `date=YYYY-MM-DD` selects one day. Results are in UTC. The
catalog shows the city time zone.

| Query type | Maximum time window |
| --- | --- |
| By cell, camera or location | 24 hours |
| By one phone, account or plate | 31 days |

| Search | Time field |
| --- | --- |
| `alpr reads` | `observed_at` |
| `carriers network_events` | `occurred_at` |
| `carriers messages` | `submitted_at` |
| `carriers calls` | `setup_at` |
| `carriers handovers` | `occurred_at` |
| `banks transactions` | `occurred_at` |

On calls and messages, `imsi`, `imei` and `cell` match either party. Use
`originating_imsi`, `destination_imsi` and similar fields to filter by
direction.

`--near` on network events matches events whose serving cell site is inside
the radius. The phone itself may be outside it.

## Sources

| Source | Contents |
| --- | --- |
| `ssa` | People, legal identity |
| `dhs` | Identity documents, immigration status |
| `dot` | Vehicles, driver's licenses, suspensions |
| `courts_criminal`, `courts_civil` | Court cases, charges |
| `corrections` | Incarceration, supervision |
| `psp_firearms` | Firearms, carry licenses, background checks |
| `banks` | Accounts, cards, loans, income, transactions |
| `carriers` | Subscriptions, handsets, calls, texts, network events, cell sites |
| `alpr` | Cameras, plate reads |
| `recorder` | Real property |
| `platforms` | Online and messaging accounts |
| `pdmp` | Prescriptions |
| `education` | Degrees, credentials |
| `military` | Service records |

`bun run kdi catalog --format pretty` lists the searches in each source.

## Output

NDJSON output has one `meta` line, one `row` line per result and one `end`
line with the row count. If the `end` line is missing or the exit code is not
0, the result is incomplete. `--format json` returns one object with a `rows`
array.

Errors are one JSON object on stderr with a code: `INVALID_FILTER`,
`UNSUPPORTED_OPERATOR`, `INVALID_VALUE`, `BATCH_TOO_LARGE`, `WINDOW_REQUIRED`,
`WINDOW_TOO_LARGE`, `RADIUS_TOO_LARGE`, `INVALID_SELECT`, `QUERY_FAILED`.

## Map lookups

Available in the agent container next to `adi`. They read the city build's
place and address files.

| Command | Returns |
| --- | --- |
| `km_search_places <lat> <lon> <metres>` | Named places in the radius, nearest first |
| `km_address_lookup "<address or street>"` | Matching buildings and streets |
| `km_address_lookup <lat> <lon> [metres]` | Addresses and streets near a point. Default radius 100 m |

## Task policies

During a benchmark task, the KDI service applies a policy hidden from the
agent. A policy can:

| Policy | Example |
| --- | --- |
| Hide columns | The mailing address in `home-id` tasks |
| Set a cutoff time | RTI and DT tasks return no events after the investigation start |

Policies change returned data. They do not change matching. Host queries have no policy.

Full reference: [`kierston_bench/kdi/README.md`](../../kierston_bench/kdi/README.md).

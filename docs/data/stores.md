# Record stores

The evidence is stored in two databases, split by provider:

| Store | Contents |
| --- | --- |
| PostgreSQL | Registers: one set of tables per provider (identity registry, carriers, courts, DOT, banks and others) |
| ClickHouse | Event logs: plate reads, network events, texts, calls, call handovers, bank transactions |

Providers do not share a person key. Event rows contain identifiers such as
IMSI or plate. They do not contain names. [KDI](kdi.md) and the benchmark read these stores.
[Fastgate](../../fastgate) loads them.

## Start the databases

```bash
cp .env.example .env.local
```

In `.env.local`, set `POSTGRES_PASSWORD` and `CLICKHOUSE_PASSWORD`, and set
the same PostgreSQL password in `POSTGRES_URL`. Do this before the first
start. PostgreSQL keeps the password its volume was created with. The
benchmark refuses to run with the default passwords from [`.env.example`](../../.env.example).

```bash
docker compose --env-file .env.local up -d
```

Both databases bind to `127.0.0.1`. All tools read `.env.local`. Shell
variables take precedence.

## Load data

Run from [`fastgate/`](../../fastgate), in this order:

```bash
cd fastgate
bun run ingest:static -- ../kierston/sim_data/sim_init.bin
bun run ingest:cameras -- ../kierston/cities/kierston/cameras.json
bun run ingest:cells -- ../kierston/sim_data/towers.json
bun run ingest:dynamic -- ../kierston/sim_outputs/day_2026-09-01.bin
```

| Command | Input | Store |
| --- | --- | --- |
| `ingest:static` | `sim_init.bin` | PostgreSQL |
| `ingest:cameras` | `cameras.json` | PostgreSQL |
| `ingest:cells` | `towers.json` | PostgreSQL |
| `ingest:dynamic` | `day_<date>.bin` | ClickHouse |

Run `ingest:dynamic` for each day you use. Loading the same file again has no
effect. Loading a different file for an already loaded date is refused.

| Flag | Meaning |
| --- | --- |
| `--mode overwrite` | Replace existing rows. Use after a rebuild |
| `--tables a,b` | Load only these tables |

`bun run fastgate <command>` from the repository root runs the same CLI.

## Scenario deltas

The benchmark runner applies a scenario task's delta before the task and
reverts it after. For manual inspection:

| Command | Effect |
| --- | --- |
| `bun run ingest:scenario -- <file.kdiff>` | Apply a delta. Its base day must be loaded |
| `bun run revert:scenario -- 2026-09-01` | Restore the base day for that date |
| `bun run list:scenarios` | List dates with an applied delta |
| `bun run annotate:scenario -- <base day.bin> <file.kdiff>` | Add database rows to a delta made by an older version |

Revert manually applied deltas before a benchmark run.

## Full rebuild script

[`tools/rebuild-bench-week.sh`](../../tools/rebuild-bench-week.sh) builds the
city and graph, exports a day chain, empties both databases and loads the
chain.

| Flag | Meaning |
| --- | --- |
| `--start YYYY-MM-DD` | First date. Default `2026-08-31` |
| `--days N` | Number of days. Default 7 |
| `--yes` | Empty the databases without a prompt |
| `--detach` | Run in tmux session `bench-rebuild`. Requires `--yes` |
| `--shutdown` | Power off when finished |
| `--dry-run` | Print the plan only |

## Reset

Data is in the Docker volumes `postgres-data` and `clickhouse-data`.
`docker compose down -v` deletes both. The next `up` creates empty databases
with the passwords from `.env.local`.

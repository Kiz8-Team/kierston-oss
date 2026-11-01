# Simulating days

A day export simulates the whole city for one date and writes one KDAY file.
Fastgate loads it, task generators read it, and scenarios use it as a base.

Run the commands below from the repository root.

## Exports

| Goal | Command |
| --- | --- |
| One day | `bun run day --export-day --date 2026-09-01` |
| One day with a warm start | `bun run day --export-day --date 2026-09-01 --init-cold-start-day` |
| Seven chained days | `bun run day --export-day --week --date 2026-08-31` |
| N chained days | `bun run day --export-day --week --days 2 --date 2026-08-31` |
| Continue from an existing day | `bun run day --export-day --date 2026-09-02 --from-state kierston/sim_outputs/day_2026-09-01.bin` |
| Write to another folder | add `--output-dir <dir>` (single-day exports only) |
| Use another city build | add `--city <build folder>` |

A single-day export starts from a cold state: everyone at home, default
balances. `--init-cold-start-day` simulates the previous day first and starts
the export from its end state. `--week` chains days, each starting from the
previous day's end state.

Export each date once with one full-city run.

## Output paths

| Output | Default | With `--output-dir` |
| --- | --- | --- |
| KDAY | `kierston/sim_outputs/day_<date>.bin` | `<dir>/day_<date>.bin` |
| Export manifest | `kierston/sim_data/week_<start>_<end>.json` | `<dir>/week_<start>_<end>.json` |

For a build made with `--out`, days go to the build's `days/` folder.

Each KDAY header stores the engine version (`dd.mm.yyyy.n-hash`). The
repository README shows the current version.

## One person's day

| Goal | Command |
| --- | --- |
| Timeline for one person | `bun run day --person 0 --date 2026-09-01` |
| Add serving cells and handovers | add `--radio` |
| Add balances and spending | add `--money` |
| Whole week | add `--week` |

KierstonBlue shows the same data in a browser ([Tools](../tools.md#kierstonblue)).

## Other flags

| Flag | Meaning |
| --- | --- |
| `--seed N` | Override the seed. Default: the city build's seed |
| `--sample N` | Simulate N random people and print aggregate checks |
| `--taxi` | Simulate the taxi fleet and print its checks |
| `--export-taxi` | Write taxi stands and drivers to `sim_data/taxi.json` for KierstonBlue |

`bun run check` runs the aggregate checks on a 4,000-person sample.

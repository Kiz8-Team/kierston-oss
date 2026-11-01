# Getting started

Steps from a fresh clone to one exported day. Commands run from the repository
root.

## Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| Python | 3.11+ | City build |
| [Bun](https://bun.sh) | latest | All TypeScript packages |
| `zstd` | any | Unpacking the input bundle |
| Docker with Compose | any | Record stores, benchmark containers |
| Node.js | 22.18+ | Benchmark runner |

All build inputs are in [`kierston/init-inputs.tar.zst`](../kierston/init-inputs.tar.zst). The build does not
download anything.

## Setup

```bash
bun run setup-project
```

The command asks two questions, each picked with the arrow keys, before it runs anything: whether to build the
Allentown city, and whether to export no day, one day (2026-09-01) or one week
(from 2026-08-31). It then runs these steps:

| Step | Command run |
| --- | --- |
| Unpack the input bundle, if `kierston/sources/` is missing | `tar --zstd -xf kierston/init-inputs.tar.zst -C kierston` |
| Create the venv, if missing | `python3 -m venv kierston/.venv` |
| Python dependencies and pytest | `kierston/.venv/bin/python -m pip install -r kierston/requirements-dev.txt` |
| Bun dependencies | `bun install --frozen-lockfile` |
| Git hooks | `git config core.hooksPath .githooks` |
| City build, if chosen | `bun run city-init` |
| Day or week export, if chosen | `bun run day --export-day [--week] --date ...` |

Flags answer the questions without prompting: `--city`, `--no-city` and
`--export none|day|week`.

## Build the city

```bash
bun run city-init
```

This writes the city to `kierston/sim_data/`, then the road graph into the same
folder. Arguments are passed to `kierston/init/init_sim.py`; add
`--households 1000` for a small test city. Use the full city for benchmark data.

## Export a day

```bash
bun run day --export-day --date 2026-09-01
```

Output: `kierston/sim_outputs/day_2026-09-01.bin`.

## View it

```bash
bun run kblue
```

Opens KierstonBlue on http://localhost:3000. See [Tools](tools.md#kierstonblue).

## Next steps

| Goal | Page |
| --- | --- |
| Load and query the day | [Record stores](data/stores.md), [Querying with KDI](data/kdi.md) |
| Run the benchmark | [Building a series](bench/series.md), [Running a series](bench/running.md) |
| Export more days | [Simulating days](city/days.md) |
| Add an incident | [Staging scenarios](city/scenarios.md) |

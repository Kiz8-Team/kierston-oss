# Building a city

A city build is a folder with one generated city: population, registers, cell
network, vehicle fleets and road graph. The default build is
`kierston/sim_data/`. Prerequisites are in [Getting started](../getting-started.md).

## Default build

```bash
bun run city-init
```

`city-init` runs `kierston/init/init_sim.py` with the arguments it is given,
then `build-graph` in `kierston/pathfinder`, which writes `car_graph.bin` into
the same folder. `init_sim.py` alone does not build the graph. The graph step
is skipped with `--only` and `--manifest-only`.

Do not commit `kierston/sim_data/`.

## `city-init` flags

| Flag | Meaning |
| --- | --- |
| `--households N` | Generate N households. `1000` gives a small test city |
| `--seed N` | Seed for all random draws |
| `--out PATH` | Write the build to PATH instead of `kierston/sim_data/` |
| `--from STAGE` | Run from STAGE onward, reusing earlier outputs |
| `--only STAGE ...` | Run only the listed stages |
| `--manifest-only` | With `--out`: write the build manifest for an existing folder without rebuilding |
| `--verbose-output` | Print each stage's report, timings and file sizes |

`--from` and `--only` are for engine development. Stage names are listed by
`bun run city-init --help`.

Use the full city (no `--households`) for benchmark data.

## Multiple builds

| Step | Command |
| --- | --- |
| Build and road graph into a folder | `bun run city-init --out kierston/builds/trial --seed 7` |
| Export a day on it | `bun run day --city kierston/builds/trial --export-day --date 2026-09-01` |

`--out` writes `kierston-city.json` into the folder. It records the city,
seed, household count and git commit. Days for that build are written to its
`days/` folder. KierstonBlue lists the builds under [`kierston/`](../../kierston) and selects one
in its header.

## Build contents

| File | Contents | Read by |
| --- | --- | --- |
| `sim_init.bin` | All registers | Fastgate, scoring |
| `population.json`, `ties.bin` | Population, social graph | Day simulation |
| `pois.json`, `buildings.json` | Named places, building addresses | Day simulation, agent place lookups |
| `towers.json` | Cell network | Fastgate |
| `car_graph.bin` | Road graph | Day simulation, pathfinder |
| `city.json` | City name, time zone, settings | Most tools |

ALPR cameras are in the tracked file [`kierston/cities/kierston/cameras.json`](../../kierston/cities/kierston/cameras.json),
not in the build.

## City profiles

The engine builds whichever city a profile describes. A profile is
`kierston/cities/<city>.toml` plus the CSV lists in `kierston/cities/<city>/`.

| Profile section | Sets |
| --- | --- |
| `[extent]` | Center point and radius of the OpenStreetMap area |
| `[microdata]` | ACS PUMS dataset, state and PUMAs the population is generated from |
| `[jurisdiction]` | Legal rules, from `kierston/jurisdictions/<profile>/` |
| `[locale]` | Time zone, reference date, area codes, county and court names |

The repository has one profile, `kierston`: 5 km around central Allentown,
PA, with PUMA 42-02803 and jurisdiction `us-pa`. `KIERSTON_CITY=<slug>`
selects another profile. [Setting up another US city](new-city.md) lists
the files and downloads a new profile needs.

## Downloading prebuilt data

`tools/fetch-kdays.sh` downloads KDAY files from S3 into
`kierston/sim_outputs/` and replaces `kierston/sim_data/` with the newest city
snapshot. It requires the AWS CLI and access to the bucket. With dates as
arguments it downloads only those days.

```bash
tools/fetch-kdays.sh 2026-09-01 2026-09-02
```

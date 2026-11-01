# Kierston

Engine version: `06.10.2026.2-db6af8dc`

![Welcome to Kierston](docs/assets/welcome_sign.svg)

Kierston is two things:

| Name | Meaning |
| --- | --- |
| Kierston engine | A deterministic simulation that builds an American city from a city profile and public data, and simulates its residents' days and the records they produce |
| Kierston city | The default city profile. It copies Allentown, Pennsylvania: 5 km around the center, about 46,000 households and 125,000 synthetic residents |

KierstonBench is a benchmark built on the Kierston city. An agent gets a case
and a query tool over the city's records, and answers who, where or what.

Days are not distributed. Build the city and export days locally. The same
inputs and seeds reproduce the same output byte for byte.

## Components

| Component | Code | Docs |
| --- | --- | --- |
| City build | [`kierston/init`](kierston/init) | [Building a city](docs/city/building.md) |
| Other US cities | [`kierston/cities`](kierston/cities), [`kierston/acquire`](kierston/acquire) | [Setting up another US city](docs/city/new-city.md) |
| Road graph and routing | [`kierston/pathfinder`](kierston/pathfinder) | [Building a city](docs/city/building.md) |
| Day simulation | [`kierston/sim`](kierston/sim) | [Simulating days](docs/city/days.md) |
| Scenarios | [`kierston_scenarios`](kierston_scenarios) | [Staging scenarios](docs/city/scenarios.md) |
| Record stores | [`fastgate`](fastgate) | [Record stores](docs/data/stores.md) |
| Query tool (KDI) | [`kierston_bench/kdi`](kierston_bench/kdi) | [Querying with KDI](docs/data/kdi.md) |
| Tasks | [`kierston_bench/task_generators`](kierston_bench/task_generators) | [Tasks](docs/bench/tasks.md) |
| Series | [`kierston_bench/run_series_prep`](kierston_bench/run_series_prep) | [Building a series](docs/bench/series.md) |
| Runs | [`kierston_bench/eval_runner`](kierston_bench/eval_runner), [`kierston_bench/bench_cli`](kierston_bench/bench_cli) | [Running a series](docs/bench/running.md) |
| Scoring | [`kierston_bench/scoring`](kierston_bench/scoring) | [Results and scoring](docs/bench/results.md) |
| Viewers and tools | [`tools`](tools) | [Tools](docs/tools.md) |

## Benchmark groups

| Group | Families | Task |
| --- | --- | --- |
| Technical Tasks | 22 | One question about a plain simulated day |
| Real-Time Investigations | 7 | Identify those involved in a staged incident shortly after it happens |
| Deception Tasks | 3 | Identify the person responsible when the 911 caller's account is false |

## Quickstart

Requires Python 3.11+, [Bun](https://bun.sh), `zstd` and Docker.

```bash
bun run setup-project
```

| Step | Asked first |
| --- | --- |
| Unpack `kierston/init-inputs.tar.zst`, create `kierston/.venv`, install Python and Bun dependencies | No |
| Build the Allentown city (`bun run city-init`) | Yes |
| Export one day (2026-09-01) or one week (from 2026-08-31) | Yes, none by default |

Next steps are in [Getting started](docs/getting-started.md).

## Documentation

Start at [docs/README.md](docs/README.md).

| Page | Covers |
| --- | --- |
| [Concepts](docs/concepts.md) | Pipeline, design rules, terms |
| [Getting started](docs/getting-started.md) | Install and first day |
| [Configuration](docs/reference/configuration.md) | Environment variables |
| [Repository map](docs/reference/repository.md) | Code layout and checks |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Checks, hooks, commit rules |
| [`CANARY.md`](CANARY.md) | Training-data canary |
| [`NOTICES.md`](NOTICES.md) | Known anomalies and weakly sourced numbers |
| [`ATTRIBUTION.md`](ATTRIBUTION.md) | Data sources and licenses |
| [`LICENSE`](LICENSE) | Apache 2.0 for code, CC BY 4.0 for generated data, ODbL and CC BY-SA for named inputs |

## Citation

See [`CITATION.cff`](CITATION.cff).

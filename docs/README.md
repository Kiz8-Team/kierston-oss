# Kierston documentation

How to build and use Kierston and KierstonBench. Implementation details are in
the package READMEs linked from each page.

## Start

| Page | Covers |
| --- | --- |
| [Concepts](concepts.md) | What the project is, the pipeline, terms |
| [Getting started](getting-started.md) | Install, build the city, export a first day |

## City

| Page | Covers |
| --- | --- |
| [Building a city](city/building.md) | Population, registers, road graph, multiple builds |
| [Simulating days](city/days.md) | Day exports, day chains, one person's day |
| [Staging scenarios](city/scenarios.md) | Incidents on top of an exported day |
| [Setting up another US city](city/new-city.md) | Profile, city lists, jurisdiction, source downloads |

## Records

| Page | Covers |
| --- | --- |
| [Record stores](data/stores.md) | PostgreSQL and ClickHouse setup and loading |
| [Querying with KDI](data/kdi.md) | The query tool agents use |

## Benchmark

| Page | Covers |
| --- | --- |
| [Tasks](bench/tasks.md) | Task groups, families, answer formats |
| [Building a series](bench/series.md) | Series configs |
| [Running a series](bench/running.md) | Agent image, credentials, preflight, dispatch, TUI |
| [Results and scoring](bench/results.md) | Scoring and run directories |
| [Other models and agents](bench/agents.md) | Providers, custom models, custom agent images |

## Tools and reference

| Page | Covers |
| --- | --- |
| [Tools](tools.md) | KierstonBlue, run browser, Iceberg, website export, data fetch |
| [Configuration](reference/configuration.md) | Environment variables |
| [Repository map](reference/repository.md) | Code layout and checks |

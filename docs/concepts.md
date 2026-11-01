# Concepts

## Kierston

The name Kierston refers to two things:

| Term | Meaning |
| --- | --- |
| Kierston engine | The simulation code. It builds a city from a city profile, a jurisdiction and public data, and simulates its days |
| Kierston city | The default city profile ([`kierston/cities/kierston.toml`](../kierston/cities/kierston.toml)). It copies Allentown, Pennsylvania |

The Kierston city has about 46,000 households and 125,000 people. The
population is generated from US census microdata (ACS PUMS) for the Allentown
area and placed into OpenStreetMap buildings within 5 km of central Allentown.
Legal records follow Pennsylvania and Lehigh County rules. All residents are
synthetic. It is the only city profile in the repository. Other profiles can
be added under [`kierston/cities/`](../kierston/cities) ([Building a city](city/building.md#city-profiles)).

Each resident has a household, a job or school, relatives, social ties and
organization memberships. Each also has administrative records: identity
documents, court cases, licenses, vehicles, loans, bank accounts, property,
prescriptions, a phone and a carrier subscription. The city has a road
network, a cellular network, license plate reader (ALPR) cameras, taxis,
school buses, patrol cars and ambulances.

## KierstonBench

KierstonBench is a benchmark for language-model agents. Each task gives the
agent a case file and access to KDI, a query tool over the city's records. The agent
writes an answer. A separate scoring step compares the answer with the ground
truth stored when the task was generated.

## Pipeline

Each stage reads the output of the previous stage.

| Stage | Output | Code |
| --- | --- | --- |
| City build | `kierston/sim_data/` | [`kierston/init`](../kierston/init) |
| Road graph | `car_graph.bin` | [`kierston/pathfinder`](../kierston/pathfinder) |
| Day simulation | one KDAY file per date | [`kierston/sim`](../kierston/sim) |
| Scenario staging | a KDIF delta against one KDAY | [`kierston_scenarios`](../kierston_scenarios) |
| Record stores | PostgreSQL and ClickHouse tables | [`fastgate`](../fastgate) |
| KDI | query results | [`kierston_bench/kdi`](../kierston_bench/kdi) |
| Series | tasks with ground truth | [`kierston_bench/run_series_prep`](../kierston_bench/run_series_prep) |
| Run | one directory per run | [`kierston_bench/eval_runner`](../kierston_bench/eval_runner) |
| Scoring | scores per task and family | [`kierston_bench/scoring`](../kierston_bench/scoring) |

The `bench` CLI ([`kierston_bench/bench_cli`](../kierston_bench/bench_cli))
covers series, runs and scoring.

## Design rules

| Rule | Effect |
| --- | --- |
| Ground truth stays out of the record stores | Only scoring reads ground truth |
| Determinism | The same inputs and seeds produce byte-identical cities and days. A task is determined by day file, family and seed |
| Day chaining | Each KDAY stores its end state. The next day can start from it |
| Scenario deltas | A scenario stores only its changes against one base day. Deltas from the same base day do not stack |
| Open-set tasks | No candidate lists. Every family accepts an abstention, which scores 0 |

Day files are not distributed with the repository. Build them locally.

## Terms

| Term | Meaning |
| --- | --- |
| Kierston engine | The simulation code |
| Kierston city | The default city profile, a copy of Allentown, PA |
| City profile | `kierston/cities/<city>.toml` and its lists; defines one city for the engine |
| KDAY | One exported day, `day_<date>.bin` |
| KDIF, `.kdiff` | A scenario delta against one KDAY |
| KSTATE | City state at midnight; each KDAY contains its opening and closing state |
| City build | A folder with one generated city; default `kierston/sim_data/` |
| Fastgate | Loader for the record stores |
| Record stores | PostgreSQL (registers) and ClickHouse (event logs) |
| KDI | Kierston Data Interface, the query CLI. Named `adi` inside agent containers |
| KDI service | Host process that forwards container queries to KDI and logs them |
| Scenario | Seeded script that adds an incident to a KDAY |
| Family | One task type, with one generator and one scorer |
| Group | TT, RTI or DT |
| Series | Fixed task set with ground truth, built from a TOML config |
| Run | One model's attempt at a series |
| KierstonBlue | Web viewer for city builds and days |

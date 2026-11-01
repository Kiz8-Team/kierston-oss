# Repository map

The repository is one Bun workspace plus a Python package for the city build.

## Engine

| Path | Language | Contents |
| --- | --- | --- |
| [`kierston/init`](../../kierston/init) | Python | City build pipeline (`init_sim.py`) |
| [`kierston/sim`](../../kierston/sim) | TypeScript | Day simulator and KDAY export |
| [`kierston/pathfinder`](../../kierston/pathfinder) | TypeScript | Road graph build, routing server |
| [`kierston/cities`](../../kierston/cities) | TOML, CSV, JSON | City profiles, local lists, ALPR camera inventory |
| [`kierston/jurisdictions`](../../kierston/jurisdictions) | TOML | Legal jurisdiction rules |
| [`kierston/init/state_specific_generators`](../../kierston/init/state_specific_generators) | Python | Code for one state's laws and formats, one folder per state code |
| [`kierston/acquire`](../../kierston/acquire), [`kierston/reference/build`](../../kierston/reference/build) | Python | Scripts that produced the bundled inputs. Not needed for a build |
| [`kierston/init-inputs.tar.zst`](../../kierston/init-inputs.tar.zst) | | Bundled build inputs |
| [`kierston_scenarios`](../../kierston_scenarios) | TypeScript | Scenario DSL, runner and benchmark scenarios |
| [`packages/kierston-records`](../../packages/kierston-records) | TypeScript | Decoder for the record binaries |
| [`packages/provider-rows`](../../packages/provider-rows) | TypeScript | Extraction of store rows from KDAY and KDIF files |
| [`fastgate`](../../fastgate) | TypeScript | Record store loader |

## Benchmark

| Path | Contents |
| --- | --- |
| [`kierston_bench/kdi`](../../kierston_bench/kdi) | KDI query CLI and catalog |
| [`kierston_bench/task_generators`](../../kierston_bench/task_generators) | One generator per task family |
| [`kierston_bench/run_series_prep`](../../kierston_bench/run_series_prep) | Series builder and example configs |
| [`kierston_bench/agent_eval_runtime`](../../kierston_bench/agent_eval_runtime) | Agent image, `evalenv`, KDI service |
| [`kierston_bench/eval_runner`](../../kierston_bench/eval_runner) | Run executor |
| [`kierston_bench/scoring`](../../kierston_bench/scoring) | Scorer |
| [`kierston_bench/bench_cli`](../../kierston_bench/bench_cli) | `bench` CLI and TUI |
| [`kierston_bench/model_visible_text.ts`](../../kierston_bench/model_visible_text.ts) | All text shown to the model |
| `kierston_bench/run_series` | Built series (not committed) |
| `kierston_bench/runs` | Run directories (not committed) |

## Tools and other

| Path | Contents |
| --- | --- |
| [`tools/kierstonblue`](../../tools/kierstonblue) | Web viewer |
| [`tools/run-browser`](../../tools/run-browser) | Run viewer |
| [`tools/iceberg`](../../tools/iceberg) | Binary profiling and statistical checks |
| [`tools/site-export`](../../tools/site-export) | Website data export |
| [`tools/setup`](../../tools/setup) | `setup-project` and `city-init` |
| [`tools/rebuild-bench-week.sh`](../../tools/rebuild-bench-week.sh), `tools/fetch-kdays.sh` | Server rebuild, S3 download |
| `paper` | Paper source |
| [`docker-compose.yml`](../../docker-compose.yml) | PostgreSQL 16 and ClickHouse 24.8 |

## Ignored folders

| Path | Contents |
| --- | --- |
| `kierston/sources`, [`kierston/reference`](../../kierston/reference), data in `kierston/jurisdictions/<profile>/` | Unpacked build inputs |
| `kierston/sim_data` | Default city build |
| `kierston/builds` | Additional city builds |
| `kierston/sim_outputs` | Day files and scenario deltas |
| `kierston_bench/run_series` | Series files |
| `kierston_bench/runs` | Run directories |

## Root scripts

| Script | Runs |
| --- | --- |
| `bun run scenarios` | Scenario CLI |
| `bun run fastgate` | Fastgate CLI |
| `bun run kdi` | KDI |
| `bun run bench` | Bench CLI and TUI |
| `bun run bench-runner` | Run executor directly |
| `bun run score` | Scorer directly |
| `bun run kblue` | KierstonBlue |
| `bun run pf` | Pathfinder server |
| `bun run runs-ui` | Run browser |
| `bun run iceberg` | Iceberg |
| `bun run site-*` | Website export |

## Checks

| Check | Command |
| --- | --- |
| Type check | `bun run typecheck` |
| TypeScript tests | `bun run test` |
| Module boundaries | `bun run check-boundaries` |
| Python tests | `bun run test:py` |

Tests that need a city build or a database are skipped when it is missing.
Commit rules and git hooks are in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

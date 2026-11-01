# Configuration

All tools read `.env.local` in the repository root. Shell variables take
precedence. Create it from [`.env.example`](../../.env.example).

## Databases

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | `kierston` in [`.env.example`](../../.env.example) | Docker Compose | PostgreSQL password, applied when the volume is created |
| `POSTGRES_URL` | `postgres://postgres:kierston@127.0.0.1:5432/city_data` | Fastgate, KDI | PostgreSQL connection |
| `POSTGRES_SCHEMA` | `fastgate_static` | Fastgate, KDI | Register schema |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | Fastgate, KDI | ClickHouse endpoint |
| `CLICKHOUSE_DATABASE` | `city_data` | Fastgate, KDI | ClickHouse database |
| `CLICKHOUSE_USER` | `default` | Fastgate, KDI | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | `kierston` in [`.env.example`](../../.env.example) | Fastgate, KDI, Docker Compose | ClickHouse password |
| `CITY_TIME_ZONE` | from `sim_data/city.json` | Fastgate, scenarios, KDI | Time zone for event timestamps |

## City and simulation

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `KIERSTON_CITY` | `kierston` | init, sim, pathfinder, KierstonBlue | City profile in [`kierston/cities/`](../../kierston/cities) |
| `KIERSTON_SIM_DATA_DIR` | `kierston/sim_data` | init, sim, Fastgate, pathfinder | City build folder |
| `KIERSTON_ENGINE_VERSION` | from git | day export | Engine version written to KDAY headers |

## Benchmark

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_AGENT_DIR` | unset | Default `--agent-dir` for dispatch |
| `BENCH_ALLOW_OPEN_DB` | unset | `1` allows databases without passwords |
| `BENCH_SCENARIO_LOCK_DIR` | `kierston_bench/agent_eval_runtime/scenario_lock` | Scenario lock shared by runners on the host |
| `BENCH_DOCKER` | `docker` | Docker executable |
| `KDI_SERVICE_HOST` | `127.0.0.1` | KDI service bind address |
| `KDI_SERVICE_PORT` | `8765` | KDI service port |
| `KDI_SERVICE_LOG_DIR` | `kierston_bench/agent_eval_runtime/kdi_log` | Per-task KDI call logs |
| `KDI_SERVICE_POLICY_DIR` | `kierston_bench/agent_eval_runtime/kdi_policy` | Per-task policies |
| `EVALENV_IMAGE` | `kierston-eval-env` | Agent image tag |
| `PI_SRC` | `../pi-cwl` | pi-cwl checkout for `build-pi.sh` |
| `PI_TARGET` | host architecture | Bun compile target for `build-pi.sh` |
| `PI_AGENT_DIR` | `~/.claude/agent` | Agent folder mounted by `evalenv run` |

## Tools

| Variable | Default | Used by |
| --- | --- | --- |
| `PATHFINDER_URL` | `http://localhost:8787` | KierstonBlue `/routes` |
| `PORT` | `8787` / `8788` | Pathfinder server / run browser |
| `BENCH_REBUILD_DIR` | `~/bench-rebuild` | `rebuild-bench-week.sh` log folder |
| `KDAY_BUCKET`, `KDAY_DEST`, `SIM_DATA_TARBALL` | see script | `fetch-kdays.sh` |

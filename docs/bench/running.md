# Running a series

Each task runs in its own Docker container with a coding agent (pi by
default). The container reaches KDI only through the KDI service on the host.
All commands use the `bench` CLI from the repository root.

Run the benchmark on a dedicated host or VM. Agents execute arbitrary shell
commands.

## Requirements

| Requirement | Page |
| --- | --- |
| Series built | [Building a series](series.md) |
| Record stores running, with registers, cameras, cells and every series day loaded | [Record stores](../data/stores.md) |
| Docker daemon running | |
| Node.js 22.18+ on `PATH` | The runner applies scenario deltas through Node |
| pi-cwl checkout, built with `npm install && npm run build` | For the default agent image |

## Steps

| Step | Command |
| --- | --- |
| 1. Compile pi for Linux | `PI_SRC=/path/to/pi-cwl kierston_bench/agent_eval_runtime/build-pi.sh` |
| 2. Build the image | `kierston_bench/agent_eval_runtime/evalenv build` |
| 3. Check the host | `bun run bench doctor --env ANTHROPIC_API_KEY` |
| 4. Run | `bun run bench dispatch example --model anthropic/claude-sonnet-5 --env ANTHROPIC_API_KEY` |
| 5. Score | `bun run bench score example/<run id> --write` |

## Agent image

The default image `kierston-eval-env` is Ubuntu 24.04 with Python, Bun, `jq`,
git and pi. pi is not in this repository.

| Item | Detail |
| --- | --- |
| pi checkout | First argument of `build-pi.sh`, else `PI_SRC`, else `../pi-cwl` |
| Target | Host architecture. Pass `bun-linux-x64` as the second argument for an x86-64 Docker host |
| pi build output | `kierston_bench/agent_eval_runtime/pi/` |
| Rebuild | After the pi checkout changes: `build-pi.sh`, then `evalenv build` |
| Image tag | `EVALENV_IMAGE` |

`evalenv` commands for manual use:

| Command | Effect |
| --- | --- |
| `evalenv build` | Build the image |
| `evalenv run [name]` | Start an interactive container |
| `evalenv shell [name]` | Shell into a running container |
| `evalenv exec [name] cmd...` | Run a command in a running container |
| `evalenv check [name]` | Run `kdi health` from inside a container |
| `evalenv stop [name]` | Stop and remove a container |
| `evalenv service` | Run the KDI service in the foreground |
| `evalenv clean` | Remove the image |

## Credentials

Containers get no host credentials unless the run passes them.

| Method | Flag |
| --- | --- |
| API key | `--env NAME` (copies the host value) or `--env NAME=VALUE`. Repeatable |
| pi sign-in | `--agent-dir ~/.claude/agent`. Each task gets a copy of `auth.json` and `models.json` |

With `--agent-dir`, token refreshes inside containers are lost. Refresh on the
host before long runs. `BENCH_AGENT_DIR` sets a default agent directory.

The runner rejects `--env` for `CLICKHOUSE_*`, `POSTGRES_*`, `PG*`,
`DATABASE_URL`, `KDI_*` and `FASTGATE_*`. Provider key names are listed in
[Other models and agents](agents.md).

### Database passwords

Containers can reach the host through `host.docker.internal`. `doctor` and
`dispatch` therefore refuse to run when `CLICKHOUSE_PASSWORD` is empty or
`POSTGRES_URL` has no password. `--allow-open-db` or `BENCH_ALLOW_OPEN_DB=1`
disables this check. Use it only for local development.

## KDI service

`bench dispatch` starts the KDI service if it is not running. `bench doctor`
only checks it.

| Setting | Default |
| --- | --- |
| `KDI_SERVICE_HOST` | `127.0.0.1` |
| `KDI_SERVICE_PORT` | `8765` |
| `--kdi-service-url` (dispatch) | `http://host.docker.internal:8765` |

Docker Desktop (macOS, Windows) works with the defaults. On Linux with native
Docker, set `KDI_SERVICE_HOST` to the docker0 address (`ip -4 addr show docker0`,
usually `172.17.0.1`).

Manual start: `bun run kierston_bench/agent_eval_runtime/kdi_service.ts`.
A systemd user unit example is in `agent_eval_runtime/kdi.service.example`.

## Doctor

```bash
bun run bench doctor --env ANTHROPIC_API_KEY
```

| Check | Fails when |
| --- | --- |
| docker | Daemon not reachable |
| image | Image not built |
| sim_data | `kierston/sim_data` missing (warning only) |
| agent credentials | No key passed and no valid `--agent-dir` sign-in |
| .env.local | File missing |
| database passwords | A store accepts a login without a password |
| KDI service | Service not answering, or `kdi health` fails |

Options: `--json`, `--image`, `--agent-dir`, `--env`, `--allow-open-db`.

## Dispatch

```bash
bun run bench dispatch <series> --model <provider>/<model> --env <KEY>
```

`<series>` is a series id or a series file path.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model provider/model` | pi default | Model |
| `--env NAME[=VALUE]` | none | Container environment variable. Repeatable |
| `--agent-dir DIR` | `none` | pi agent directory to copy auth from |
| `--concurrency N` | `2` | Parallel containers. Scenario tasks always run alone |
| `--deadline MIN` | series value, else `20` | Time limit per task. `0` disables it |
| `--deadline-grace MIN` | `3` | Extra minutes before the container is killed |
| `--image TAG` | `kierston-eval-env` | Agent image |
| `--startup-command S` | series value, else pi | Container command |
| `--name TEXT` | none | Display name |
| `--run-id ID` | `<image>-<timestamp>` | Run directory name |
| `--out DIR` | `kierston_bench/runs` | Run root folder |
| `--family F` | all | Only this family. Repeatable |
| `--task ID` | all | Only this task. Repeatable |
| `--resume` | off | Skip tasks that have a `meta.json` |
| `--docker-arg A` | none | Extra `docker run` argument. Repeatable |
| `--background` | off | Run detached from the terminal |
| `--backend auto\|process\|systemd` | `auto` | Background worker type |
| `--dry-run` | off | Print the runner command and exit |

Preflight runs before dispatch. A blocking failure exits with code 1. Ctrl-C
stops all containers of the run.

Scenario tasks change the shared event store, so the runner runs each one
alone: it waits for other tasks, applies the delta, runs the task, and
reverts the delta. A lock in `BENCH_SCENARIO_LOCK_DIR` covers all runners on
the host.

## Run commands

`<run>` is `<series>/<run id>`, a unique run id or name, or a path.

| Command | Effect |
| --- | --- |
| `bench runs` | List runs and progress |
| `bench series` | List series |
| `bench show <run>` | One run and its tasks |
| `bench task <run> <task id>` | One task: answer, notes, KDI calls, console tail |
| `bench watch <run>` | Print changes. Exit 0 on completion, 1 if stalled |
| `bench logs <run>` | Print a background run's `runner.log` |
| `bench stop <run>` | Stop a background run |
| `bench resume <run>` | Continue a run, skipping recorded tasks |
| `bench validate <run>` | Check answer formats without ground truth |

Most commands accept `--json`.

## TUI

```bash
bun run bench
```

Tabs: Runs, Series, New run, New series. `bun run bench ui <run>` opens one
run. Finished runs are scored automatically unless `--no-auto-score` is set.

| Key | Action |
| --- | --- |
| `↑↓` `⏎` `esc` `←→` | Move, open, back, switch tab |
| `/` | Filter |
| `?` | Key list |
| `q` | Back or quit |
| `n` | New run or new series |
| `s` | Score the run |
| `X` / `R` | Stop / resume the run |
| `A` | Abort the selected task |
| `T` | Rerun the selected task, keep the previous attempt, rescore |
| `D` | Delete the selected run or series |
| `r` | Recheck preflight |

Full key list: [`kierston_bench/bench_cli/README.md`](../../kierston_bench/bench_cli/README.md).

## Reruns

| Goal | Method |
| --- | --- |
| One task | `T` in the TUI |
| Finish an interrupted run | `R` in the TUI or `bench resume <run>` |
| Subset | `--task ID` or `--family F` on dispatch |

Resume skips every task with a `meta.json`, including failed ones.

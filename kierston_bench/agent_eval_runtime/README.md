# Agent evaluation runtime

A Docker container the evaluated agent lives in. It is Ubuntu 24.04 with
python3, pip (inside a virtualenv on PATH), bun, jq and git, plus a small
analytical baseline from `requirements.txt`, and the pi coding agent as
`pi`. The agent can run bash, install packages and execute code, but sees
nothing of this repository.

`pi` is not vendored. It is a Linux build of a separate checkout of the
`pi-cwl` monorepo (`packages/coding-agent`, built with `npm run build`),
produced by `build-pi.sh` into `pi/` (gitignored, about 115 MB) and copied to
`/opt/pi` in the image. Without that checkout there is no default agent image
(an image of your own that follows the contract below works instead). Build pi
before the image, and again after changing the checkout; `evalenv build`
refuses to start without it and stamps pi's version into the image's
`pi.version` label, which the runner records in `run.json`:

```sh
agent_eval_runtime/build-pi.sh                       # a pi-cwl directory next to the repository, host architecture
PI_SRC=~/src/pi-cwl agent_eval_runtime/build-pi.sh   # or name the checkout
agent_eval_runtime/build-pi.sh ~/src/pi-cwl bun-linux-x64
```

The image sets `PI_OFFLINE=1`, so pi does no update or changelog fetches at
startup. It reads its settings from `~/.claude/agent` inside the container,
which starts empty; model and API keys come in as flags and environment from
the runner (or a throwaway per-task copy of an `--agent-dir`'s auth files).

## The agent contract

The runner does not care what runs in the image, only what it does. An
alternative agent image must:

- start from the image's command, or the series' startup command under
  `bash -c` (the default starts pi);
- read the case file at `$ETF` (`/input/input.json`, read-only): prompt,
  evidence, `answerShape`, `instructions`; and the shared context in `$EC`;
- reach the records only through `adi` (and `km_search_places`,
  `km_address_lookup`), which post to the KDI service at `$AU` with the capability in
  `$AT`; there is no other data access, and a deadline closes the KDI service;
- keep work under `/work` and logs under `/out/logs` (`$ELD`);
- write `/out/answer.json` as `{"answer": ..., "notes": ...}` and exit. With a deadline, `$ED` is the allowance in
  milliseconds; the container is killed a grace period after it, and whatever
  `/out/answer.json` holds then is the answer.

The `E*` variables are unset by the default command before pi starts; an
agent of its own should do the same so its model never reads them.
`eval_runner/agents/example/` is the smallest such image.

The data interface is reached through `adi` (Allentown Data Interface, the model-facing name; the code and host tooling still say KDI), a wrapper in the
container that forwards its arguments to `kdi_service.ts` on the host. The KDI service
listens on loopback, runs `bun run kdi/src/cli.ts <args>` as an argv array with
no shell, and returns stdout, stderr and the exit code. Credentials stay in the
host's `.env.local`; the container has no database access of its own.

`km_search_places <latitude> <longitude> <radius-metres>` uses the same bridge
to search the initialized city's `sim_data/pois.json`. It returns compact JSON
containing every POI in the radius, nearest first, with its `poi/<index>` id,
name, type, group, address, coordinates and distance in metres.

`km_address_lookup "<address or street>"` searches mapped building addresses and
street names. Matching is case-insensitive, ignores punctuation, expands common
street/direction abbreviations, and matches consecutive whole words. It returns
all matches, so a street-only query can resolve multiple buildings. An unknown
address returns an empty list; the tool does not invent or interpolate addresses.

`km_address_lookup <latitude> <longitude> [radius-metres]` returns building
addresses and distinct named streets within the radius (default 100 m), each list
sorted nearest first, with distances in metres. It reads `sim_data/buildings.json`
and `sim_data/car_graph.bin`; initialize the city and build the graph first.
Building coordinates are centroids, not entrances or footprint containment tests.
Street coordinates are the nearest point on an approximate graph edge for reverse
queries, or a representative graph node for text queries. These are local map
lookups, not an external geocoding service. Streets absent from the car graph and
buildings without mapped street/house-number tags cannot be resolved.

The container never learns its task id. The runner registers an opaque capability (`AT`) whose host-side file names the task, and the
wrapper sends it along; the KDI service resolves the task and appends one JSON line per call to
`kdi_log/<task id>.jsonl`, with the arguments, exit code, wall time and output
size. That file is how a run keeps every KDI call an agent made for a task.
Except for the
host's unscoped `health` probe, the KDI service refuses calls without a registered
capability, reads the task's private policy from `KDI_SERVICE_POLICY_DIR`, and
passes that policy only to the host-side KDI process. The policy is how a task
hides columns and, for staged incidents, cuts records off at the
investigation's start (see [KDI task policies](../kdi/README.md#task-policies)).

The trust boundary is therefore the KDI service. The container holds no credentials,
no repository, no ground truth and no policy; it can send an argument list and
read back what KDI printed, and every such call is logged against the task.

`eval_runner/` runs a series in this image, one container per task, each
running the task's startup command (pi on the case file, by default). See
`eval_runner/README.md`. The runner persists Pi's default session JSONL files
in each host task result's `logs/pi-sessions/`; its default startup command
uses an explicit session directory and writes them directly into `logs/`.
These mounts retain recorded session content even when a task times out.

## Layout

```
agent_eval_runtime/
├── Dockerfile        ubuntu + python3/pip/venv + bun + kdi wrapper + pi
├── requirements.txt  pip packages baked into the image
├── build-pi.sh       compiles pi for Linux from the pi-cwl checkout
├── pi/               the Linux pi build and its assets (gitignored)
├── bin/kdi           container-side KDI wrapper (python, stdlib only)
├── bin/km_search_places  container-side POI radius-search wrapper
├── bin/km_address_lookup  container-side forward/reverse address wrapper
├── kdi_service.ts    host-side KDI service, run with bun
├── evalenv           manager script for interactive use
├── kdi_log/          per-task call logs written by the KDI service (gitignored)
└── work/<name>/      per-container work directory, mounted at /work (gitignored)
```

## Usage

From `kierston_bench/`:

```sh
agent_eval_runtime/build-pi.sh            # build pi for Linux (once, and after pi changes)
agent_eval_runtime/evalenv build          # build the image
agent_eval_runtime/evalenv service        # host terminal 1: start the KDI service
agent_eval_runtime/evalenv run            # host terminal 2: interactive container
agent_eval_runtime/evalenv run trial-7    # named container, work dir agent_eval_runtime/work/trial-7
agent_eval_runtime/evalenv check          # kdi health from inside the container
agent_eval_runtime/evalenv shell          # another shell into the running container
agent_eval_runtime/evalenv exec trial-7 kdi days --format pretty
agent_eval_runtime/evalenv stop trial-7
```

`bun run evalenv ...` and `bun run kdi-service` are aliases in `package.json`.
`bun run bench dispatch ...` and the interactive bench CLI start the KDI service in
the background automatically when it is absent; `evalenv service` remains useful
for direct runtime development.

Inside the container:

```sh
adi catalog --format pretty
adi query <source> <search> --reason "..." --where field=value --format json | jq .
km_search_places 40.6023 -75.4714 500 | jq .
km_address_lookup "520 West Cumberland Street" | jq .
km_address_lookup 40.590609 -75.462947 100 | jq .
python3 -c 'import pandas, duckdb'
pip install <package>
pi --version
```

## Settings

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `KDI_SERVICE_PORT` | host | `8765` | port the KDI service listens on |
| `KDI_SERVICE_HOST` | host | `127.0.0.1` | bind address (also `kdi_service.ts --host`); loopback for Docker Desktop, the docker0 address (`ip -4 addr show docker0`, often `172.17.0.1`) on native Linux Docker, whose host-gateway never reaches loopback |
| `KDI_SERVICE_LOG_DIR` | host | `agent_eval_runtime/kdi_log` | where per-task call logs go |
| `AU` | container | `http://host.docker.internal:8765` | where `kdi` sends requests |
| `AT` | container | unset | opaque per-task capability; set by the bench runner and required by the KDI service |
| `KDI_SERVICE_POLICY_DIR` | host | `agent_eval_runtime/kdi_policy` | host-only directory containing ephemeral task-policy capability records |
| `PI_OFFLINE` | container | `1` | no network at pi startup |
| `EM` | container | unset | model pi is started with; set by the runner's `--model` |
| `EVALENV_IMAGE` | host | `kierston-eval-env` | image tag |

On Linux, `evalenv run` passes `--add-host=host.docker.internal:host-gateway`
so the name resolves; Docker Desktop on macOS and Windows resolves it natively.

The KDI service accepts up to 512 arguments of at most 4096 characters each and logs
one line per call with the exit code and wall time. When a call fails, KDI
writes the full cause to a host-only file the KDI service reads back: it goes to the
KDI service's stderr and the call's `error` field in `kdi_log/<task id>.jsonl`, while
the container gets only the generic message from `model_visible_text.ts`. Everything else about what
the agent can ask is decided by the KDI CLI itself.

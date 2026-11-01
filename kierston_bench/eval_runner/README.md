# Evaluation runner

Runs one series against one agent, a fresh container per task, several at a
time, and keeps everything each task produced. Each container runs the task's
startup command, which starts the agent; when it exits, the runner collects
what the container wrote and removes it.

## The startup command

Every task carries a `startupCommand`: one shell line run under `bash -c`
inside a container of the image (`kierston-eval-env` by default, which has
the pi coding agent on PATH). The command starts the agent, or anything else
the run needs, and the container ends when it does. It comes from, in order
of precedence: `--startup-command` on the runner, the task's own field, the
series file's `agent.startupCommand` (set by `[agent] startup_command` in
the series config), and the runner's default, which is

```sh
pi -p --append-system-prompt "$EC" --session-dir "$ELD" ${EM:+--model "$EM"} @"$ETF" "Complete the records investigation described in the attached case file, following its instructions field."
```

`$EM` is set from `--model`. The prompt text is `STARTUP_PROMPT` in
`model_visible_text.ts`; everything the model reads lives there. The command
each task ran is recorded in its `meta.json`. A `-- cmd...` after the options runs that
command directly, with no shell and no startup command.

## Shared context and task prompt

Edit `EC` in `eval_runner/src/context.ts` to change the shared city
context, available tools, and the abstention contract. Identifier conventions
belong in each task. The runner passes this
constant into every container as the `EC` environment variable and
saves the exact text as `context.txt` in each task result. Changes apply to new
runs without rebuilding the image.

The default Pi command appends it to the system prompt using
`--append-system-prompt "$EC"`. Task-specific evidence, question,
answer specification, and submission instructions remain in `/input/input.json`,
attached through `@"$ETF"`. Custom startup commands must explicitly
consume `$EC` (use the same Pi flag); the runner does not rewrite
custom commands.

Person answers accept full names (30% credit), name + DOB (60%), or SSN strings
(100%, retaining leading zeros). Wrong identity claims incur matching penalties;
all supplied fields must agree. The task bundle describes the exact formats,
rank discounts, and set matching; the shared context carries the abstention
contract. See the
[scoring policy](../scoring/README.md#graded-identity-scoring).
New task templates specify this in their answer contracts. The runner rejects
legacy numeric subject clues and obsolete answer contracts; regenerate those
series before dispatch. Shared context contains no identifier or scoring advice.

## How the agent authenticates

By default nothing from the host's pi setup is mounted: the agent
authenticates with an API key the run forwards explicitly, e.g.
`--env ANTHROPIC_API_KEY` (bare `NAME` copies the host's value). The bench CLI
never adds host API keys to a run on its own.

`--agent-dir <dir>` names a pi agent directory on the host (usually
`~/.claude/agent`) for OAuth sign-ins. Only its auth files (`auth.json`, and
`models.json` for custom providers) are copied, into a fresh `agent/`
directory inside each task's result directory; that copy is mounted at
`/opt/pi-agent` with `PI_CODING_AGENT_DIR` pointing at it, and deleted when
the task ends. Settings, sessions and caches stay on the host, and nothing a
task writes reaches the next task or the host. The price: an OAuth token pi
refreshes inside a container is thrown away with it, so refresh the sign-in
with pi on the host before a long run (`bench doctor --agent-dir <dir>`
reports the expiry), or use an API key.

## The agent contract

Whatever the startup command starts:

1. reads the case file from `$ETF` (`/input/input.json`, read-only),
2. queries KDI through the `adi` command as often as it likes,
3. keeps its scripts and intermediate files under `/work`,
4. puts any transcript its tooling produces under `/out/logs/`,
5. writes `/out/answer.json` and exits.

The answer file is one JSON object:

```json
{ "answer": ["111-22-3333", "222-33-4444"], "notes": "optional" }
```

The file names no case: each container holds one case and writes to its own
`/out`, so the runner already knows which task an answer belongs to. The case
file's `id` is an opaque per-attempt hash, never the task id, which names the
family, date and generator seed; the runner records it as `caseId` in the
task's `meta.json`. Answer files from before 2026-10-01 carry `caseId` (or
`taskId`); both are ignored.

`answer` takes the shape given by the task's `answerShape` field, which is
derived from `answer.kind`: a string for `id` and `label`, an array of strings
for `ranked-ids`, `id-set` and `label-set`, `{lat, lon}` for `point`, and an
object of named fields for `record`. The task's `instructions` field says all
of this to the agent in prose, so a startup command can hand the file over
as-is, which is what the default does with pi.

Nothing the agent prints is read. Exiting without an answer file, or with one
that is not JSON or names a different case, is recorded as such and the run
moves on. `agents/example/` is the smallest possible agent image: its
entrypoint checks KDI answers and writes an empty answer. Run it with
`--image kierston-agent-example -- agent-entrypoint` to smoke-test the runner.

## Usage

The KDI service must be running on the host (`agent_eval_runtime/evalenv service`), because it is
the only way a container reaches KDI. Then, from the repository root:

```sh
bun run bench-runner \
  kierston_bench/run_series/run_series_example_tasks_data.json \
  --model anthropic/claude-sonnet-5 --env ANTHROPIC_API_KEY \
  --concurrency 4
```

| Option | Default | Meaning |
|---|---|---|
| `--image <tag>` | `kierston-eval-env` | the container image |
| `--startup-command <s>` | the task's | shell line every container runs |
| `--model <pattern>` | unset | passed to the container as `EM`; pi's `--model` |
| `--env NAME[=VALUE]` | none | container environment; bare `NAME` copies the host's value; repeatable |
| `--agent-dir <dir>` | `none` | pi agent directory whose auth files each task gets a throwaway copy of, at `/opt/pi-agent` |
| `--run-id <id>` | `<image>-<timestamp>` | names the run directory |
| `--out <dir>` | `kierston_bench/runs` | root of run directories |
| `--concurrency <n>` | 2 | containers at a time; a positive whole number |
| `--timeout <d>` | ignored | legacy compatibility option; tasks have no automatic deadline |
| `--kdi-service-url <url>` | `http://host.docker.internal:8765` | KDI service, as seen from a container |
| `--kdi-policy-dir <path>` | `agent_eval_runtime/kdi_policy` | host-only capability directory shared with the KDI service |
| `--kdi-log-dir <dir>` | `kierston_bench/agent_eval_runtime/kdi_log` | where the KDI service writes per-task logs |
| `--lock-dir <dir>` | `$BENCH_SCENARIO_LOCK_DIR`, else `kierston_bench/agent_eval_runtime/scenario_lock` | scenario lock shared by every runner on the host; see Scenario tasks |
| `--family <name>` | all | only this family; repeatable |
| `--task <id>` | all | only this task; repeatable |
| `--resume` | off | skip tasks this run already finished |
| `--docker-arg <arg>` | none | extra `docker run` flag; repeatable |
| `--docker <binary>` | `docker` | also `BENCH_DOCKER` |
| `-- cmd...` | none | raw command run instead of any startup command |

`bun run bench-runner` is the repository-root alias, and `bun run eval-runner`
from `kierston_bench/` does the same. `bun run bench` is the bench CLI, which
drives this runner and can dispatch a run for you.

## What a run leaves behind

```
runs/<series id>/<run id>/
├── run.json                 image, timings, per-task summary, status counts, provenance
└── <task id>/
    ├── context.txt          exact shared context passed to the container
    ├── input.json           the case file the agent saw (/input/input.json): prompt, evidence, answer spec, instructions; no ground truth
    ├── answer.json          what the agent wrote, if anything
    ├── console.log          the container's stdout and stderr, interleaved
    ├── logs/                explicit session-dir transcripts and other agent logs
    │   └── pi-sessions/     default Pi session directories and their JSONL files
    ├── work/                /work as the agent left it: scripts, notebooks, downloads
    ├── kdi_calls.jsonl      every KDI call from this task, from the KDI service's log
    └── meta.json            status, exit code, timings, KDI call count, startup command, caseId, model
```

`run.json`'s `provenance` records what the run was made with: the model asked
for (`--model`, null for pi's own default) and `modelsSeen`, the
`provider/model` pi reported in each transcript; the image, its `docker image
inspect` id and repo digests; the pi version (the image's `pi.version` label,
set by `evalenv build`, else the host build in `agent_eval_runtime/pi/`); and
the repository's git HEAD with a `gitDirty` flag for uncommitted changes.

Pi's default `/work/.pi/agent/sessions/` is bind-mounted to each task's
`logs/pi-sessions/`, preserving `--<path>--/<timestamp>_<uuid>.jsonl` and all
session content Pi records, including reasoning and tool calls. Older builds'
global session location (`/opt/pi-agent/sessions` with host authentication,
otherwise `/home/agent/.claude/agent/sessions`) uses the same task-local mount.
Files are written directly to the host, so completed writes survive failure,
timeout, and container removal. The default startup command's explicit
`--session-dir "$ELD"` continues to save JSONL files directly in
`logs/`. Custom session paths must stay under a mounted output or work directory
to be retained; `--no-session` disables Pi session recording.

Task directories use `_` where the task id has `:`. A task's `status` is one
of `answered`, `no-answer`, `invalid-answer`, `timeout` or `error` (docker
itself failed). Scoring is not done here: it reads `answer.json` against the
series file's ground truth in a later step, so nothing in a run ever touches
the truth. That step is `scoring/` (`bun run score <run dir>`), and
`bench_cli/` drives both it and this runner from one place.

## Scenario tasks

An RTI or DT task carries `scenario`: its base day and the `.kdiff` staged
over it. Applying one changes ClickHouse under everything reading it, so a
scenario task always runs alone — concurrency 1, no other task of any kind
beside it, in this run or any other on the host. The runner drives this
through the Fastgate CLI (`list-scenarios`, `ingest-scenario`,
`revert-scenario`) rather than importing it. These subprocesses
require Node.js 22.18+ (or 24+) on PATH: the ClickHouse Node client can hang
in Bun's HTTP timeout path. Fastgate allows five minutes of request inactivity
and requests server progress headers for long mutations. Scenario progress is
streamed into the runner log and the TUI's runner line as it happens:

1. When the run starts, every applied scenario is reverted to its base day,
   unless another live runner holds the scenario lock.
2. A scenario task waits until every running task has finished (no new task
   starts once it is waiting), reverts anything applied, applies its own
   `.kdiff`, runs its container, and reverts when the container ends —
   answered, failed or interrupted.
3. Plain tasks run side by side as `--concurrency` allows, but never beside a
   scenario task.

The lock is a file under `--lock-dir`, so a rerun or a second run on the same
host waits rather than clobbering the store; a runner that dies outright is
pruned by pid. Applying imports the provider rows carried in the KDIF and
issues one deletion mutation per affected table. Mutations can take tens of
seconds because ClickHouse rewrites data parts. Applying fails unless the exact
base KDAY is the one imported. A failed apply is the task's `error`, and its container never
starts. If a revert fails, it is logged and the next task on that date
retries it.

## Isolation

Each task gets a fresh container, fresh `task`, `out` and `work` directories,
and a KDI task id of `<run id>/<task id>` that the KDI service uses to file its
calls. The container never sees the task id, its family or its seed: the case
file carries an opaque `case-<hash>` id, the container is named
`bench-<run id>-<case id>` (docker does not expose the name inside; the
hostname is the container id), and KDI calls reach the task through the
opaque capability in `AT`, which only the host maps back. The KDI call log,
including each failure's full cause (`error`), is written host-side by the
KDI service and copied into the task directory only after the container exits. A rerun of a task (without `--resume`) discards the previous attempt's
directory first. Containers share nothing, so `--concurrency` is bounded by
the host and by what Postgres and ClickHouse will take, not by the runner.

On Ctrl-C every running container is killed before the runner exits. Tasks
have no automatic timeout. In the bench TUI, select a running task and press
`Shift+A` to abort only that task; remaining tasks continue. Its files are
retained, and new runners record the result as an operator-aborted error.

The runner does not restrict the container's network beyond what the base
image does. To cut off everything but the KDI service, pass a `--docker-arg` with the
network setup you want; `--network=none` also cuts off the KDI service, so a private
bridge with the KDI service bound to it is the usual answer.

Databases are the other thing a container can reach: every container gets
`host.docker.internal`, so ClickHouse and PostgreSQL listening on the host are
one hop away, around the KDI service. Their logins must therefore have passwords.
`bench dispatch` and `bench doctor` refuse a run when `CLICKHOUSE_PASSWORD` is
empty or `POSTGRES_URL` carries no password (from the shell or `.env.local`);
`--allow-open-db` (or `BENCH_ALLOW_OPEN_DB=1`) overrides that for a local
development stack nobody else can reach. Database settings never enter a
container: the runner refuses `--env` for `CLICKHOUSE_*`, `POSTGRES_*`,
`PG*`, `DATABASE_URL`, `KDI_*` and `FASTGATE_*`, and they reach only the
host-side KDI process the KDI service starts.

The KDI service binds `127.0.0.1` by default, which Docker Desktop reaches as
`host.docker.internal`. On native Linux Docker the host-gateway is the docker0
bridge address (`ip -4 addr show docker0`, usually `172.17.0.1`), which a
loopback listener never sees; run the KDI service with `KDI_SERVICE_HOST=172.17.0.1`
(or `kdi_service.ts --host 172.17.0.1`). The bench CLI starts the KDI service with the
same variable and probes it at that address.

## Tests

```sh
cd kierston_bench && bun test eval_runner/test
```

The tests drive the runner with `test/fixtures/fake-docker.sh` in place of
docker, so they cover directory layout, status detection, filters, resume
and timeouts without an image or a daemon. `test/container_surface.test.ts`
records every mount target, variable and file a container would see and
checks that no family name, task id or seed is among them.

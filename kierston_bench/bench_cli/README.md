# Bench CLI

One command for the benchmark: what has been run, how each run did, and how to
start another. Interactive when it has a terminal to itself, and every view it
offers also exists as a subcommand for scripts and CI.

```sh
bun run bench                       # the TUI; finished runs score themselves
bun run bench runs                  # the same list as text
bun run bench ui example/smoke      # open one run in the TUI
```

The CLI does not re-implement anything. It builds the command line a person
would have typed, spawns the evaluation runner, and reads the run directory —
so a run started here and a run started by hand are the same thing, and both
show up in the list.

## The TUI

Five tabs — **Runs**, **Series**, **New run**, **New series**, **Sweeps** —
and pages opened from them. Arrows do the getting around; letters are actions.

| Key | Does |
|---|---|
| `↑↓` | move; `page up/down`, `home`, `end` as usual |
| `⏎` | open the run or task under the cursor; edit, toggle or press a form row |
| `esc` | back one level (clears a filter or family narrowing first) |
| `←→` | switch tabs while nothing is open; inside a run, switch Tasks · Problems · Families; inside a task, its sections; in a form field, move the caret |
| `/` | filter the list by typing; `esc` clears it |
| `?` | the keys; `q` back, or quit from a tab |

Actions, wherever the thing they act on is under the cursor:

| Key | Does |
|---|---|
| `s` | score the run now, whatever state it is in |
| `n` | new run of the selected series (on Runs), new series (on Series) |
| `X` / `R` | stop the run (a runner started here, or a background worker) / resume it here |
| `A` | abort the selected running task; the rest of the run continues |
| `T` | rerun the selected task, keep the previous attempt, rescore the run |
| `D` | delete the selected run (on Runs): its directory and the KDI service's copies of its per-task call logs, freeing its run id and its name for the next run; the series is kept |
| `D` | delete the selected series (on Series): its task file, every run made from it, the config New series wrote for it, and any staged kdiff no other series still names; a hand-written config is left alone |
| `r` | recheck preflight on the new-run form |

**Runs** is home. `⏎` opens a run: the header carries state, progress and the
aggregate score, and the list carries a score and the reason for it per task.
`←→` swap the list for the tasks that got no usable answer or scored nothing,
or for the family breakdown — worst family first, one column carrying whichever
metric that family is reported by. `⏎` on a family narrows the task list to it.

A task opens in sections — overview, answer, prompt, KDI calls, console,
files — moved between with `←→` or a digit. The overview is the "why did it
score what it scored" page: status, method, metrics and the scorer's notes.

**Starting a run** opens the run's screen with Runs directly underneath, so
`esc` goes home. The same screen serves a run in flight and a finished one: it
re-reads the run directory once a second, a running task shows the tool it
called last and the last heading the agent gave its own work, and the score
appears in the header the moment the run is scored. A run that finishes is
scored without being asked — one dispatched here, or one finished in another
terminal — and a run whose directory has moved on since `score.json` was
written is scored again. `bench --no-auto-score` leaves scoring to `s`.

A task in flight writes no `meta.json` until its container exits; the running
row tails the agent's session transcript instead. Anthropic models return
thinking as an opaque signature with the text stripped, so the heading is the
last thing the agent said out loud and changes only when it stops to explain
itself; the tool name changes with every call.

A run with no `run.json` whose files were touched in the last five minutes is
*running*; one that has gone quiet is *interrupted*, which is the honest reading
of a directory nobody is writing to any more.

**New run** is a form: series, tasks, image, model, concurrency, run id, and the
rest, with **Start run** and **Start in background** as the last two rows.
`⏎` on Series picks another series; `⏎` on Tasks opens the family chooser,
where `←→` set how many of one family's tasks to run and a typed number sets
every family at once (a family with fewer tasks takes all it has). Every task
is selected by default. Preflight — docker, the image, credentials,
`.env.local`, database passwords, the KDI service — runs by itself when the form opens and again when
the image, env or KDI service URL change, and the exact command it will spawn sits
underneath. Opening the form is the intent to run, so a local KDI service that is not
listening is started here; a remote KDI service is checked but never replaced. A
blocking failure asks before starting. `bench doctor` is the same check as a
read-only report.

Preflight reads the agent's credentials rather than only checking that a
directory exists: an expired OAuth token fails every task in about a second.
It passes when the run forwards a key pi knows for any provider it supports
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`,
`DEEPSEEK_API_KEY`, and the rest of the table in `src/preflight.ts`), in the
Env field or as `--env NAME`; when an explicit `--env` names a variable outside
that table, which is taken as a custom provider's key; or when `--agent-dir`
names a directory whose `auth.json` holds a live sign-in. It also blocks a run
when `CLICKHOUSE_PASSWORD` is empty or `POSTGRES_URL` has no password, since a
container can reach the host's databases through `host.docker.internal`;
`--allow-open-db` (or `BENCH_ALLOW_OPEN_DB=1`) accepts that for local
development. A foreground `dispatch` exits 1 on a blocking failure, as
`--background` does. The
KDI service's health check gets a twenty-second budget and runs last; `kdi health`
opens the event stores, which routinely takes the better part of ten seconds
on a cold pool.

**New series** builds a fixed task set with hidden ground truth. Every exported
day under `kierston/sim_outputs` and every task family is selected by default;
`⏎` on Days or Families opens a checklist. **Generate series** writes the prep
config under `run_series_prep/configs`, runs the series builder, and opens New
run for the result. RTI and DT families are listed with the technical ones;
choosing one writes a `[[scenarios]]` entry for the scenario that stages it.
**Copies** is how many tasks each technical family gets per day, and also how
many kdiffs each such scenario gets per day; every kdiff yields one task per
RTI or DT family. Each kdiff runs the scenario against a day, so they cost far
more than technical tasks.

## Sweeps

A sweep runs one task on a list of models. Each model gets its own run,
selecting that one task, with the model as the run name. The runner, scorer
and run screens treat them as normal runs. The sweep record in
`kierston_bench/sweeps/<id>.json` lists the run ids.

```sh
bench sweep s3 --task person-reid:2026-09-05:3313213332 \
  --models anthropic/claude-sonnet-5,openai/gpt-5 --env ANTHROPIC_API_KEY --env OPENAI_API_KEY
bench sweep --family trip-mode-classif --day 2026-08-31 --seed 3 --models-file models.txt
bench sweeps                 # list sweeps
bench sweeps <sweep id>      # one sweep: model, state, score, KDI calls, time, answer
```

Task source: `<series> --task <id>` takes a series task. `--family`, `--day`,
`--seed` generates one: a one-family, one-day, one-copy series named
`task-<family>-<day>-s<seed>` is built with the series prep, so the task has
hidden ground truth. The same family, day and seed reuse the existing series.

Options: `--models` is comma-separated and repeatable. `--models-file` reads
one model per line; `#` starts a comment. `--parallel n` runs n models at
once (default 1). `--background` starts every run as a managed worker.
Dispatch flags (`--image`, `--env`, `--agent-dir`, `--deadline`, ...) apply to
every run. `--model`, `--name`, `--run-id` and `--family` selection are set by
the sweep and ignored. A startup command that hard-codes a model is refused;
the model is passed through `$EM`.

TUI: the **Sweeps** tab lists sweeps. The **New sweep** button (`⏎`) opens the form: task source
(series + task, or family + day + seed), models (typed, or ticked from models
used by earlier runs), parallel count, run settings. **Start sweep** opens
the sweep screen: one row per model, refreshed once a second. `⏎` opens that
model's run. `D` on the tab, or `bench sweeps <id> --delete`, removes the
sweep record and keeps the runs.

## Commands

```sh
bench runs [--json]                     every run and how far it got
bench series [--json]                   series available to dispatch
bench show <run> [--json]               one run, its counts and its tasks
bench task <run> <task id> [--json]     one task: answer, notes, KDI calls, console tail
bench dispatch <series> [options]       start a run and follow its log
bench watch <run> [--interval 5]        follow a run started elsewhere
bench score <run> [--write] [--tasks] [--json|--csv] [--ambiguity strict|lenient]
bench validate <run> [--json]           answer shapes only; reads no ground truth
bench new-series <config.toml> [--force]
bench doctor [--json] [--agent-dir d] [--env NAME]... [--allow-open-db]
bench sweep <series> --task <id> --models a,b [--parallel n] [--sweep-id id] [--background] [--dry-run]
bench sweep --family f --day YYYY-MM-DD [--seed n] --models a,b
bench sweeps [sweep] [--json] [--delete]
```

A word that is not a command prints this list and exits 1; only a bare
`bench` (or flags alone) opens the TUI. Numeric options (`--concurrency`,
`--deadline`, `--deadline-grace`) that are not numbers are errors rather than
silent defaults.

The TUI takes `--no-auto-score` to leave scoring to `s` and `bench score`.

Tasks have no automatic deadline. Select a running task in the run or task
screen and press `A` to abort it without stopping other tasks. Select a task
and press `T` to rerun it, retain its previous attempt, and automatically
update the full run score.
This also works for interrupted runs and failed tasks in running runs. A
task that is still running or queued cannot run a second copy concurrently.
`--timeout` remains accepted for old commands but is ignored. An already
running process retains the timeout behavior of the code it started with.

`<run>` is `<series>/<run id>`, a run id or custom name on its own where it is
unambiguous, or a path. `dispatch` takes the runner's options — `--image`, `--model`,
`--concurrency`, `--timeout`, `--name`, `--run-id`, `--family`, `--task`, `--resume`,
`--env`, `--agent-dir`, `--docker-arg`, `--startup-command`, `--deadline` and
`--deadline-grace` (both in minutes) — and `--dry-run` prints the command
instead of running it. A run gives each task 20 minutes unless the series or
`--deadline` says otherwise; `--deadline 0` runs without one. The TUI's run
form offers a custom display name, the deadline and the kill grace; the name
does not change the stable run id, directory, or container names. The agent directory, container
environment, docker arguments and startup command are `dispatch` options only.

`watch` prints a line whenever a run's counts change and exits 0 when the run
finishes, 1 when it stops making progress; that is the shape a CI step wants.

No agent directory is mounted by default: add an API key to the Env field or
pass `--env NAME` (host API keys are never forwarded implicitly). `--agent-dir
~/.claude/agent` uses pi's OAuth sign-ins instead; each task then gets a
throwaway copy of the directory's auth files only, so a token pi refreshes
inside a container is not kept — refresh on the host before a long run. When
the token has expired and no key is forwarded, preflight blocks the run and
says so — the container would otherwise start, fail to authenticate and exit
within a second, once per task.

Scoring is the `scoring/` package; `bench score` is the same call with the
run's series found for you. Per-task score results retain the declared method,
aggregation, raw metrics and a short explanation. Open a task in the TUI, or
run `bench task <run> <task id>`, to see details such as the matched rank for a
ranked answer rather than only its final percentage.

## Tests

```sh
cd kierston_bench && bun test bench_cli/test
```

The inventory tests build run directories by hand — one finished, one with a
container still open, one abandoned — and check that each reads as what it is.
The rest cover the dispatch command line, key decoding, the drawing helpers,
and the list, editor, filter and form state the pages are built from.

## Background runs on Linux and macOS

From the repository root:

```sh
bun run bench dispatch <series> --background --run-id trial-1 --model <model>
bun run bench runs
bun run bench watch <series>/trial-1
bun run bench logs <series>/trial-1
bun run bench stop <series>/trial-1
bun run bench resume <series>/trial-1
```

`--backend auto` (the default) selects a reachable systemd user manager on Linux,
otherwise a detached process. Force `--backend process` for macOS/local testing,
or `--backend systemd` to require systemd. Both backends launch the same worker,
write `runner.log`, and survive closing the bench UI or terminal. Background CLI
dispatch refuses failed preflight checks. In the TUI, **Start in background**
on the new-run form starts one; `X` on the runs and run screens stops a managed
run, including one launched by another terminal. Resuming (`R`, or
`bench resume`) always runs in the foreground of the TUI or terminal that asked
for it; the old worker record is set aside as `manager-<token>.json`.

On a systemd server, enable lingering for the account that owns the runs before
relying on logout survival (`sudo loginctl enable-linger <account>`). The account
needs Bun, Docker access, the initialized data and agent credentials. Each run is
a transient `kierston-bench-<uuid>.service`; its name is returned by dispatch.
`systemctl --user status <unit>` and `journalctl --user -u <unit>` inspect it.
Transient units do not automatically resume after reboot.

The KDI service is shared across runs. Existing preflight starts it as a detached process
on both platforms when absent. For Linux servers, install the example
`agent_eval_runtime/kdi.service.example` as a user service after adjusting its
paths, then `systemctl --user enable --now kdi.service`. This gives the KDI service
its own restart policy. Configure networking so the evaluation containers can
reach it; keep access restricted to the host/container network.

Workers expose authenticated loopback health/stop endpoints. `manager.json`
contains worker identity, host, backend, service name, lifecycle and heartbeat;
`launch.json` saves the exact selection/settings and required environment. Both
are private (0600); do not publish them, since launch settings can contain API
keys. Public run summaries never expose the control token. The TUI and read-only
run browser reuse worker heartbeat state even while no task output is changing.
Stopping addresses the authenticated worker, never an unverified saved PID.
The runner checks its owner and stops active containers if the worker disappears.

Resume reuses the saved specification and skips every task with `meta.json`,
including recorded failures; it does not retry failures or restore agent sessions.
Previous manager and run reports are retained. Only a worker that has recorded a
terminal state can be resumed automatically. After a crash or reboot, stale runs
are shown as interrupted and relaunch is refused until manually reconciled with
remaining processes/containers. This prevents accidental duplicate evaluations.

Control is local to the host and user owning the worker. Use SSH to run these
commands on another server; cross-server aggregation is not implemented. Runs in
a custom `--out` directory can be addressed by their full run-directory path;
the default list scans `kierston_bench/runs`. `logs` prints the current complete
runner log; use `tail -f <run-directory>/runner.log` for streaming.

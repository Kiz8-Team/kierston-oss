# Kierston Bench

Kierston Bench is the benchmark built on the Kierston city: tasks that ask an
agent to investigate the simulated population through the records separate
providers would hold, a controlled environment to run those agents in, and the
scoring that reads what they answered. The Kierston Data Interface (KDI; presented to the model as ADI, the Allentown Data Interface, and the model must never see the word Kierston or anything that hints at evaluation) is the
agent's only view of the city. It reads the same stores Fastgate writes: static
registers in PostgreSQL and observed-day events in ClickHouse.

The bench CLI is the way in:

```sh
bun run bench            # runs, results, dispatch, progress — interactively
bun run bench runs       # the same, as text, for a script
```

## Architecture

```
          series config (TOML)
                  │
                  ▼
   run_series_prep ──── task_generators ◄── KDAY (+ .kdiff in memory), sim_data truth
          │   └──── kierston_scenarios CLI (stages .kdiff per day and seed)
          ▼
   run_series/<id>.json   tasks + ground truth + staged deltas
          │
          ▼
   eval_runner ── one container per task (agent_eval_runtime image, pi agent)
          │            │
          │            └─ kdi wrapper ──► host KDI service ──► kdi ──► PostgreSQL / ClickHouse
          │                                  (capability, policy, audit log)
          │   └── fastgate CLI: apply a task's .kdiff before it, revert after
          ▼
   runs/<series>/<run>/   answers, transcripts, work files, KDI calls — no truth
          │
          ▼
   scoring ◄── series ground truth + sim_data registers
          │
          ▼
   bench_cli (TUI / CLI) and tools/run-browser
```

| Package | Role |
| --- | --- |
| [`kdi/`](kdi/README.md) | The records interface: an allowlisted catalog of logical searches, typed filters, spatial queries, complete results, per-task policies |
| [`task_generators/`](task_generators/README.md) | One generator per task family; samples a target, records truth at selection time, writes an open-set prompt from observable evidence only |
| [`run_series_prep/`](run_series_prep/README.md) | Turns a TOML config into a fixed run series, staging scenario deltas where staged families are asked for |
| `run_series/` | The generated `run_series_<id>_tasks_data.json` files |
| [`agent_eval_runtime/`](agent_eval_runtime/README.md) | The container image agents run in, and the host KDI service that is its only route to KDI |
| [`eval_runner/`](eval_runner/README.md) | Runs a series one container per task, serialising staged-incident tasks around applying and reverting their deltas |
| `runs/` | What each run left behind, per task |
| [`scoring/`](scoring/README.md) | Validates answers, resolves the identifiers in them, and scores each family against the series' truth |
| [`bench_cli/`](bench_cli/README.md) | The TUI and CLI over all of it: series, runs, dispatch, progress, scores |

## Tasks

A task is a family, a sampled target and the ground truth recorded when it was
drawn. Families come in three groups:

| Group | Families | Day it reads | What the agent does |
| --- | --- | --- | --- |
| Technical Tasks (TT) | 22 | a plain observed day | answers one narrow question about the records — who holds a device, where somebody lives, who shared a car, what a payment was for |
| Real-Time Investigations (RTI) | 7 | a base day with a staged incident | works a shooting, an explosion, a protest, an abduction or an unplanned gathering minutes after it happened, with records cut off at that minute |
| Deception Tasks (DT) | 3 | a staged incident with a 911 caller's account attached | finds who is responsible when the account may be true or a lie; the records decide |

Tasks are open-set. No candidate list is embedded; the agent searches the
whole population through KDI, and a person answer is graded by how specific
the claimed identity is (full name, name and date of birth, or SSN), with
matching penalties for wrong claims. Every family also accepts an explicit
abstention.

## Isolation and what an agent can see

- **The task bundle** (the container's case file) carries the prompt, the
  evidence, the answer specification and submission instructions under an
  opaque case id. Ground truth, the task's KDI policy, and the task id itself
  (family, date, seed) never enter the container.
- **The container** has a shell, Python, Bun and a coding agent, but no
  repository and no database credentials. It reaches KDI only through a
  wrapper that sends an argument list to the host KDI service. The runner does not
  restrict container networking by default; a locked-down deployment passes a
  private bridge through `--docker-arg`. Because the host's databases are one
  hop away, preflight refuses a run whose ClickHouse or PostgreSQL login has
  no password unless `--allow-open-db` is given.
- **The KDI service** requires the per-task capability the runner registered, applies
  that task's private policy (redacted columns, redacted identity-summary
  fields, and the event-history cutoff for staged incidents), and logs every
  call against the task.
- **Staged incidents** change the event store for everyone reading it, so a
  scenario task runs alone on the host: the runner waits for other tasks to
  finish, applies the task's delta rows to ClickHouse, runs the container, and
  reverts afterwards, under a lock shared by every runner on the machine.
- **Scoring happens afterwards**, in a separate step that is the only reader
  of ground truth.

## Reproducibility

Every generator draw is seeded, and a series is generated once and never
overwritten, so every model evaluated on a series answers the same tasks. A
task reproduces from (day file, family, seed); a staged delta from (scenario
script, base day, seed); the series records its config, the git commit its
generators ran at (and whether the tree was dirty), and every rejected seed
with the reason. A run records the exact shared context, task bundle and
startup command each container ran, and in `run.json` the model, image id, pi
version, git HEAD and a dirty flag.

## KDI

From the repository root:

```sh
bun run kdi catalog --format pretty
bun run kdi days
bun run kdi health --format pretty
bun run kdi query carriers network_events \
  --reason "inspect activity during the observed journey" \
  --where date=2026-09-01 \
  --where imsi=310260000000001 \
  --select occurred_at,imsi,event_type,cell_cgi
```

Every search requires a free-text reason of at least 12 characters, returns
every matching record (NDJSON by default), and rejects unknown fields and
operators rather than ignoring them. Credentials are loaded from the
repository-level `.env.local`, shared with Fastgate; the registers must already
be loaded (see [`fastgate/README.md`](../fastgate/README.md)). The full query
language, source map and policy model are in [`kdi/README.md`](kdi/README.md).

## Install

From the repository root, which is the Bun workspace root:

```sh
bun install --frozen-lockfile
```

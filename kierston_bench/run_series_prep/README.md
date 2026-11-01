# Run series prep

A **RunSeries** is one whole benchmark run: a fixed collection of tasks. A
task is a family, a sampled target (what the model is shown) and the ground
truth recorded at selection time. Every generator draw is random, so the
series is what pins a run down — it is generated once from a config, written
to one file, and every model evaluated on that series answers the same tasks.

## Usage

From the repository root:

```sh
bun run kierston_bench/run_series_prep/src/cli.ts kierston_bench/run_series_prep/configs/example.toml
```

The result lands in `kierston_bench/run_series/run_series_<id>_tasks_data.json`.
An existing file is never overwritten without `--force`, because a series is
meant to stay fixed once models have been run on it.

## Config

```toml
[series]
id = "pilot-01"                                   # names the output file
seed = 42                                         # the whole series reproduces from this
days = ["kierston/sim_outputs/day_2026-09-01.bin"]  # one entry per observed day
# sim_data = "kierston/sim_data"
# output_dir = "kierston_bench/run_series"

[tasks]
include = "all"          # or a list of families
exclude = []
copies = 3               # distinct copies of each family, per day
# attempts_per_copy = 8

[tasks.per_family]       # per-family overrides of `copies`; 0 drops the family
device-to-person = 5

[[scenarios]]            # optional, repeatable: stage a scenario and draw its families
id = "mass-shooting"     # a catalogue id from kierston_scenarios/scenarios/catalog.ts
# count = 2              # successful stagings per day (default: tasks.copies), seeds derived from series.seed; or seeds = [11, 12]
# days = [...]           # default: series.days
# max_affected = 1500    # default: the catalogue's figure

[agent]                  # optional
# The shell line every task's container runs; it starts the agent and the
# container ends when it exits. Copied onto each task as `startupCommand`.
# Runs under `bash -c` in the container, so $BENCH_* variables expand there.
startup_command = 'pi -p --append-system-prompt "$EC" --session-dir "$ELD" --model anthropic/claude-sonnet-5 @"$ETF" "Complete the records investigation described in the attached case file, following its instructions field."'
```

Relative paths resolve from the repository root. Family names are the
generator families listed by `task_generators/src/index.ts`, in any task
group (TT, RTI or DT); an unknown name fails before any day file is opened.

## Scenario stagings

Each `[[scenarios]]` entry is run once per (day, seed) through the scenarios
CLI in its own process: `create` writes the delta under `series.scenario_dir`
(default `kierston/sim_outputs/scenarios/<series id>`, named
`<scenario>_<date>_<seed>.kdiff`). The delta is never merged: the generators
read the base day with the delta applied in memory. A delta already on disk
is reused. Without `seeds`, each day wants `count` successful stagings, and
`tasks.copies` when `count` is left out, so Copies sets how many deltas a
scenario gets per day. Derived seeds are candidates: a seed the runner refuses (nobody
fits a role, a trip is infeasible) is logged under `series.failedStagings`
and the next one is tried, up to `attempts_per_copy` seeds per wanted
staging; an explicit `seeds` list must succeed in full. The
families the scenario's catalogue entry lists — those the series includes —
are then generated from that base + delta, one copy per staging unless
`tasks.per_family` says otherwise. Technical Task (TT) families never run on
a scenario day, and the staged families — Real-Time Investigations (RTI) and
Deception Tasks (DT) — never run on a base day. A DT script stages one of
two flavours of its story per seed, so a series that wants both should
stage it several times.

A task from a staging carries `scenario`: the script's name and seed and the
repository-relative base and delta paths. The evaluation runner
applies that delta to ClickHouse for the task and reverts it afterwards (see
[`eval_runner`](../eval_runner/README.md#scenario-tasks)); the
series file lists every staging under `series.scenarios`.

## What "copies" means

Copies of a family are distinct tasks. Each copy gets its own seed derived
from (series seed, day, family, attempt); a draw whose evidence — the part
the model sees — repeats an earlier copy is discarded and the next seed is
tried, up to `attempts_per_copy` seeds per wanted copy. A family a day
cannot support (no shared journeys, no vehicle legs) is reported short in
`outcomes` rather than failing the series.

## Output

```
series    id, createdAt, seed, days (file + date), families, taskCount,
          the parsed config verbatim, the git commit the generators ran at,
          and `agent.startupCommand` when the config set one
outcomes  per family and day (and staging, for RTI and DT families): requested,
          produced, and every rejected seed with the generator's reason
tasks     the KierstonBenchTask objects, in family order then copy order,
          each carrying `startupCommand` when the config set one
```

Each task's `seed` reproduces it alone through the task-generators CLI:

```sh
bun run tasks <family> --day <file> --seed <seed>
```

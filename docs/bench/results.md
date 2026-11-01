# Results and scoring

Scoring is a separate step after a run. It is the only step that reads ground
truth.

## Score a run

```bash
bun run bench score <series>/<run id> --write
```

| Flag | Meaning |
| --- | --- |
| `--write` | Write `score.json` into the run directory |
| `--tasks` | Print a per-task table |
| `--json`, `--csv` | Machine-readable output |
| `--family F`, `--task ID` | Score a subset. Repeatable |
| `--ambiguity strict\|lenient` | Non-person identifiers that match several records: no credit (`strict`, default) or credit |
| `--sim-data DIR` | City build for series without a truth snapshot |

`bun run score kierston_bench/runs/<series>/<run id>` runs the scorer
directly. Extra options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--series <file>` | from the run path | Series file |
| `--validate-only` | off | Check answer formats only |
| `--place-credit <m>` | 100 | Distance for a correct place |
| `--arrival-credit <min>` | 15 | Time tolerance for arrivals |
| `--recall-k <k>` | 5 | k for recall@k |

The TUI scores finished runs automatically.

## Scoring steps

| Step | Effect |
| --- | --- |
| Validation | Checks the answer format. Fixes unambiguous format errors and records the fix |
| Resolution | Maps identifiers in the answer (name, SSN, plate, venue) to simulation ids |
| Scoring | Applies the family's scoring method |

Each task gets a headline score from -1 to 1. Negative scores come from naming
wrong people. Abstentions score 0.

| Method | Headline score |
| --- | --- |
| Person ranking | Credit for the correct person by rank and identifier specificity, minus penalties for wrong people |
| Person set | Weighted F1 minus penalties for wrong people |
| Other set | F1 |
| Label | 1 or 0 |
| Distance | 1 within the credit radius, else 0 |
| Time window | Intersection over union |
| Hierarchical | 1 exact, 0.5 partial, 0 wrong |
| Record | Mean of the field scores |

Details: [`kierston_bench/scoring/README.md`](../../kierston_bench/scoring/README.md).

## Run directory

```
kierston_bench/runs/<series id>/<run id>/
├── run.json          image, timings, task summary, status counts, provenance
├── launch.json       dispatch settings; may contain API keys
├── manager.json      background worker state (background runs)
├── runner.log        runner output (background runs)
├── score.json        scores (after --write)
└── <task id>/        ':' in the task id is replaced with '_'
    ├── input.json        case file given to the agent
    ├── context.txt       shared context given to the container
    ├── answer.json       {"answer", "notes"}
    ├── meta.json         status, exit code, timings, KDI call count, model
    ├── console.log       container stdout and stderr
    ├── kdi_calls.jsonl   all KDI calls
    ├── logs/             agent transcripts (pi sessions in logs/pi-sessions/)
    └── work/             agent's /work folder at exit
```

| Task status | Meaning |
| --- | --- |
| `answered` | Valid answer file |
| `no-answer` | No answer file |
| `invalid-answer` | Answer file cannot be read |
| `timeout` | Killed at the deadline |
| `error` | Container or runner error |

`run.json` provenance contains the requested model, models seen in
transcripts, image id and digests, pi version, git HEAD and a dirty flag.

`meta.json` contains `caseId`, the id the container saw instead of the task
id.

Do not commit `kierston_bench/runs/`. Published runs and transcripts must
include the canary from [`CANARY.md`](../../CANARY.md).

## Viewing runs

| Tool | Command |
| --- | --- |
| TUI | `bun run bench` |
| Run browser | `bun run runs-ui` ([Tools](../tools.md#run-browser)) |

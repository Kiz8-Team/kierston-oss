# Building a series

A series is a fixed set of tasks with ground truth, built from a TOML config.
All models run on a series get the same tasks.

## Requirements

| Requirement | Page |
| --- | --- |
| City build | [Building a city](../city/building.md) |
| Every day named in the config, exported | [Simulating days](../city/days.md) |
| For running (not building): those days loaded | [Record stores](../data/stores.md) |

The builder stages RTI and DT scenarios itself.

## Build

```bash
bun run bench new-series kierston_bench/run_series_prep/configs/example.toml
```

Output: `kierston_bench/run_series/run_series_<id>_tasks_data.json`. If the
file exists, the command fails. `--force` overwrites it. Do not overwrite a
series that has runs.

| Example config | Contents |
| --- | --- |
| [`configs/example.toml`](../../kierston_bench/run_series_prep/configs/example.toml) | Technical Tasks on 2026-09-01 |
| [`configs/scenarios-example.toml`](../../kierston_bench/run_series_prep/configs/scenarios-example.toml) | All scenarios and Technical Tasks on 2026-09-04 |

## Config

```toml
[series]
id = "example"
seed = 42
days = ["kierston/sim_outputs/day_2026-09-01.bin"]

[tasks]
include = "all"
copies = 3

[tasks.per_family]
device-to-person = 5

[[scenarios]]
id = "mass-shooting"
count = 2
```

| Field | Default | Meaning |
| --- | --- | --- |
| `[series] id` | required | Series name; letters, digits, `.`, `_`, `-` |
| `[series] seed` | `1` | Seed for all draws |
| `[series] days` | required | KDAY paths |
| `[series] sim_data` | `kierston/sim_data` | City build |
| `[series] output_dir` | `kierston_bench/run_series` | Output folder |
| `[series] scenario_dir` | `kierston/sim_outputs/scenarios/<id>` | Folder for staged deltas |
| `[tasks] include` | `"all"` | `"all"` or a list of families |
| `[tasks] exclude` | `[]` | Families to skip |
| `[tasks] copies` | `1` | Tasks per technical family per day |
| `[tasks] attempts_per_copy` | `8` | Seeds tried per task |
| `[tasks.per_family] <family>` | `copies` | Per-family count. `0` skips the family |
| `[[scenarios]] id` | required | Scenario id from the [catalog](../city/scenarios.md#benchmark-scenarios) |
| `[[scenarios]] count` | `copies` | Stagings per day |
| `[[scenarios]] seeds` | derived | Explicit seeds. Not combined with `count` |
| `[[scenarios]] days` | `series.days` | Days to stage on |
| `[agent] startup_command` | pi default | Shell command each container runs |
| `[agent] deadline_minutes` | 20 | Time limit per task |

Paths are relative to the repository root.

Technical families use plain days. RTI and DT families use staged days and
need a `[[scenarios]]` entry. `include = "all"` without scenarios produces
technical tasks only.

Some seeds produce no valid task. The series file lists rejected seeds with
the reason. If a family has fewer tasks than requested, increase
`attempts_per_copy` or add days.

## Series file contents

| Field | Contents |
| --- | --- |
| Tasks | Prompt, evidence, answer format, ground truth, KDI policy |
| Config | The config used |
| Provenance | Git commit and dirty flag |
| Truth snapshot | Register data used by scoring |

Series files contain answers. Do not share them. Published data from a series
must include the canary from [`CANARY.md`](../../CANARY.md).

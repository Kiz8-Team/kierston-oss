# Tools

| Tool | Command | Reads |
| --- | --- | --- |
| [KierstonBlue](#kierstonblue) | `bun run kblue` | City builds and day files |
| [Pathfinder server](#pathfinder-server) | `bun run pf` | Road graph |
| [Run browser](#run-browser) | `bun run runs-ui` | `kierston_bench/runs` |
| [Iceberg](#iceberg) | `bun run iceberg` | City and day binaries |
| [Website export](#website-export) | `bun run site-*` | Runs, days, scenarios |
| [Data fetch](#data-fetch) | `tools/fetch-kdays.sh` | S3 bucket |

## KierstonBlue

Next.js viewer for city builds and exported days. It reads files directly and does not use the
databases. Code: [`tools/kierstonblue`](../tools/kierstonblue).

```bash
bun run kblue
```

Opens on http://localhost:3000. The header selects the city build and day.

| Page | Shows |
| --- | --- |
| `/map` | Roads, places, buildings, density layers |
| `/people`, `/households`, `/record` | Residents, households, full person record |
| `/social` | Social ties of one person |
| `/work`, `/workplaces`, `/students`, `/schools` | Jobs and schools |
| `/identities`, `/devices`, `/accounts` | Identity, handsets, subscriptions, messaging accounts |
| `/criminal`, `/civil`, `/firearms`, `/holdings` | Court cases, firearms, property and other holdings |
| `/banking`, `/spending` | Accounts and transactions |
| `/vehicles` | Vehicle registry and daily movement per VIN |
| `/days`, `/comms` | Day files, calls, texts, cellular records |
| `/meetings` | Gatherings in a day with attendee movement |
| `/scenarios` | Scenario deltas compared with their base day |
| `/towers` | Cell network |
| `/cell-location` | Cell location estimator |
| `/cameras` | ALPR cameras and their reads |
| `/buses`, `/taxi` | School buses, taxis |
| `/dispatch` | 911 calls |
| `/routes` | Routing; needs the pathfinder server |

`/taxi` needs `sim_data/taxi.json` from `bun run day --export-taxi`.

## Pathfinder server

HTTP routing server on port 8787, used by KierstonBlue's `/routes` page.

```bash
bun run pf
```

`PORT` changes the port. `PATHFINDER_URL` points KierstonBlue at another
server. One route on the command line: `bun run route "<from>" "<to>"` in
[`kierston/pathfinder`](../kierston/pathfinder).

## Run browser

Read-only web view of benchmark runs: transcripts, answers, scores, KDI calls,
files. Code: [`tools/run-browser`](../tools/run-browser).

```bash
bun run runs-ui
```

Opens on http://127.0.0.1:8788. `PORT` changes the port. It does not score
runs. Use `bun run bench score` first.

## Iceberg

Measures city and day binaries and compares them with a saved baseline. Use it
to check what a code change did to the output.

```bash
bun run iceberg baseline kierston/sim_data/sim_init.bin kierston/sim_outputs/day_2026-09-01.bin
```

```bash
bun run iceberg check kierston/sim_data/sim_init.bin kierston/sim_outputs/day_2026-09-01.bin
```

| Command | Effect |
| --- | --- |
| `profile <file>...` | Measure and print |
| `baseline <file>...` | Measure and save as the baseline |
| `check <file>...` | Measure and compare with the baseline |
| `diff <a> <b>` | Compare two files or two saved profiles |
| `list` | List baselines |
| `test [suite\|all]` | Run statistical suites |

`bun run iceberg help` lists options. Details: [`tools/iceberg/README.md`](../tools/iceberg/README.md).

## Website export

Scripts in [`tools/site-export`](../tools/site-export) write static JSON for
the project website. The run export contains scores, cost and time per task.
It does not contain prompts, answers or transcripts.

| Command | Output |
| --- | --- |
| `bun run site-export --out <dir> <series>/<run id> ...` | Score table per model |
| `bun run site-city --day <day.bin> --out <dir>` | Sample of residents from one day |
| `bun run site-map --out <dir>` | Base map |
| `bun run site-engine --day <day.bin> --out <dir>` | Engine statistics |
| `bun run site-scenario --day <base.bin> --scenario <x.kdiff> --tasks <series file> --out <dir>` | One scenario |
| `bun run site-samples --day <day.bin> --scenario-day <day.bin> --scenario <x.kdiff> --out <dir>` | Sample records |
| `bun run site-figures <site data dir> <out dir>` | Figures |

## Data fetch

`tools/fetch-kdays.sh` downloads KDAY files to `kierston/sim_outputs/` and
replaces `kierston/sim_data/` with the newest city snapshot from S3. Requires
the AWS CLI with bucket access.

| Variable | Meaning |
| --- | --- |
| `KDAY_BUCKET` | Bucket name |
| `KDAY_DEST` | Download folder for days |
| `SIM_DATA_TARBALL` | Specific snapshot instead of the newest |

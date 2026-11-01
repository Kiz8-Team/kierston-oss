# Contributing

## Setup

- Install and first day: [docs/getting-started.md](docs/getting-started.md)
- Code layout: [docs/reference/repository.md](docs/reference/repository.md)
- Local PostgreSQL and ClickHouse: `docker compose up -d`, then copy `.env.example` to `.env.local`

## Checks

Run before opening a pull request.

| Check | Command |
|---|---|
| Install | `bun install --frozen-lockfile` |
| Type check | `bun run typecheck` |
| TypeScript tests | `bun run test` |
| Module boundaries | `bun run check-boundaries` |
| Python tests | `bun run test:py` |

Tests that need built sim data or a database skip when it is absent.

## Git hooks

`.githooks/post-commit` stamps the engine version into `README.md` as a follow-up commit after an engine change. `bun run setup-project` enables it; to enable it by hand:

```sh
git config core.hooksPath .githooks
```

## Commits

- One logical change per commit; the message says what changed and why.
- Keep generated output out of commits unless the change is to that output.
- Never commit `kierston/sim_data/`, `kierston/sim_outputs/`, `kierston_bench/runs/`, or any `.env*` file other than `.env.example`.
- Never commit API keys, database credentials, or model transcripts.

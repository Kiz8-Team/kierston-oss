#!/usr/bin/env bash
# Rebuild the bench from scratch: re-init the population, export one sequential week,
# wipe the Fastgate stores (PostgreSQL + ClickHouse) and load the new week into them.
#
# Usage: tools/rebuild-bench-week.sh [options]
#   --start YYYY-MM-DD   first date of the week (default 2026-08-31)
#   --days N             length of the sequential chain (default 7)
#   --yes                wipe the databases without asking (required with --detach)
#   --detach             run inside tmux session "bench-rebuild" and return; survives SSH logout
#   --shutdown           power the machine off when the run ends (off unless given; needs passwordless sudo)
#   --work-dir DIR       parent of the per-run log dirs (default $BENCH_REBUILD_DIR or ~/bench-rebuild)
#   --dry-run            print the plan and the database objects that would be dropped, then exit
#
# Progress: $LOG_DIR/STATUS (RUNNING: <step> / DONE / FAILED) and $LOG_DIR/run.log.
# LOG_DIR defaults to <work-dir>/<UTC timestamp>; <work-dir>/latest points at the newest.
#
# Host: targets a Linux build server (bash, tmux for --detach, sudo shutdown for --shutdown).
# GNU and BSD date both work, so the plan and dry run also run on macOS.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/tools/rebuild-bench-week.sh"
SESSION=bench-rebuild

START=2026-08-31
DAYS=7
YES=0
DETACH=0
SHUTDOWN=0
DRY_RUN=0
WORK_DIR="${BENCH_REBUILD_DIR:-$HOME/bench-rebuild}"
ARGS=("$@")

while [ "$#" -gt 0 ]; do
  case "$1" in
    --start) START="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --detach) DETACH=1; shift ;;
    --shutdown) SHUTDOWN=1; shift ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,18p' "$SCRIPT" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# add_days YYYY-MM-DD N -> YYYY-MM-DD, with GNU date (Linux) or BSD date (macOS).
if date --version >/dev/null 2>&1; then
  add_days() { date -u -d "$1 + $2 day" +%F; }
else
  add_days() { date -u -j -v+"$2"d -f %F "$1" +%F; }
fi
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

[[ "$START" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ "$(add_days "$START" 0 2>/dev/null)" = "$START" ] \
  || { echo "invalid --start: $START" >&2; exit 2; }
[[ "$DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid --days: $DAYS" >&2; exit 2; }
START="$(add_days "$START" 0)"
DATES=()
for ((i = 0; i < DAYS; i++)); do DATES+=("$(add_days "$START" "$i")"); done
END="${DATES[${#DATES[@]}-1]}"

# Drops every table fastgate owns. PostgreSQL: the whole static schema.
# ClickHouse: the tables fastgate's schema.ts creates, never the database itself.
WIPE_TS='
import { PROJECT_ROOT } from "./src/env.ts";
import { schemaSql } from "./src/schema.ts";
import pg from "pg";
import { createClient } from "@clickhouse/client";
void PROJECT_ROOT;
const env = process.env;
const dry = env.WIPE_DRY_RUN === "1";
const pgSchema = env.POSTGRES_SCHEMA || "fastgate_static";
const chDatabase = env.CLICKHOUSE_DATABASE || "city_data";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pgSchema)) throw new Error(`invalid schema ${pgSchema}`);

const postgres = new pg.Client({ connectionString: env.POSTGRES_URL });
await postgres.connect();
const pgTables = await postgres.query(
  "select table_name from information_schema.tables where table_schema = $1 order by 1", [pgSchema]);
console.log(`PostgreSQL ${new URL(env.POSTGRES_URL!).host} schema ${pgSchema}: ${pgTables.rowCount} tables`);
if (!dry) await postgres.query(`DROP SCHEMA IF EXISTS "${pgSchema}" CASCADE`);
await postgres.end();

const owned = schemaSql(chDatabase)
  .map((sql) => /CREATE TABLE IF NOT EXISTS \S+\.`?(\w+)`?/.exec(sql)?.[1])
  .filter((name): name is string => Boolean(name));
const clickhouse = createClient({
  url: env.CLICKHOUSE_URL, username: env.CLICKHOUSE_USER || "default", password: env.CLICKHOUSE_PASSWORD || "",
});
const present = await (await clickhouse.query({
  query: "select name, total_rows from system.tables where database = {db:String} and name in {names:Array(String)}",
  query_params: { db: chDatabase, names: owned }, format: "JSONEachRow",
})).json<{ name: string; total_rows: number | null }>();
console.log(`ClickHouse ${new URL(env.CLICKHOUSE_URL!).host} database ${chDatabase}:`);
for (const t of present) console.log(`  ${t.name} (${t.total_rows ?? "?"} rows)`);
if (!dry) {
  for (const t of present) await clickhouse.command({ query: `DROP TABLE IF EXISTS \`${chDatabase}\`.\`${t.name}\` SYNC` });
}
await clickhouse.close();
console.log(dry ? "dry run: nothing dropped" : "dropped");
'

if [ "$DRY_RUN" = 1 ]; then
  echo "repo     $REPO_ROOT @ $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  echo "week     $START .. $END (${DAYS} days, sequential)"
  echo "shutdown $([ "$SHUTDOWN" = 1 ] && echo "when finished" || echo no)"
  echo
  (cd "$REPO_ROOT/fastgate" && WIPE_DRY_RUN=1 bun -e "$WIPE_TS")
  exit 0
fi

if [ "$DETACH" = 1 ]; then
  [ "$YES" = 1 ] || { echo "--detach needs --yes: a detached run cannot ask before wiping the databases" >&2; exit 2; }
  tmux has-session -t "$SESSION" 2>/dev/null && { echo "tmux session $SESSION already exists" >&2; exit 1; }
  forward=()
  for arg in "${ARGS[@]}"; do [ "$arg" = --detach ] || forward+=("$arg"); done
  tmux new-session -d -s "$SESSION" "$(printf '%q ' bash "$SCRIPT" "${forward[@]}")"
  echo "started in tmux session $SESSION"
  echo "  status: cat $WORK_DIR/latest/STATUS"
  echo "  log:    tail -f $WORK_DIR/latest/run.log"
  exit 0
fi

if [ "$YES" != 1 ]; then
  echo "This drops all Fastgate data in PostgreSQL and ClickHouse (after the export succeeds)."
  read -r -p "Type 'wipe' to continue: " answer
  [ "$answer" = wipe ] || { echo "aborted"; exit 1; }
fi

LOG_DIR="${LOG_DIR:-$WORK_DIR/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$LOG_DIR"
ln -sfn "$LOG_DIR" "$WORK_DIR/latest" 2>/dev/null || true
exec > >(tee -a "$LOG_DIR/run.log") 2>&1

finish() {
  local code=$?
  if [ "$code" = 0 ]; then
    echo "DONE $(now)" > "$LOG_DIR/STATUS"
  else
    echo "FAILED during: $(sed 's/^RUNNING: //' "$LOG_DIR/STATUS" 2>/dev/null) (exit $code, $(now))" > "$LOG_DIR/STATUS"
  fi
  echo; echo "=== [$(now)] $(cat "$LOG_DIR/STATUS")"
  if [ "$SHUTDOWN" = 1 ]; then
    echo "powering off"
    sudo shutdown -h now
  fi
}
trap finish EXIT
step() { echo; echo "=== [$(now)] $*"; echo "RUNNING: $* ($(now))" > "$LOG_DIR/STATUS"; }

[ "$SHUTDOWN" = 1 ] && { sudo -n true || { echo "--shutdown needs passwordless sudo" >&2; exit 1; }; }
echo "repo $REPO_ROOT @ $(git -C "$REPO_ROOT" rev-parse --short HEAD), week $START .. $END, log $LOG_DIR"

step "remove previous outputs for $START .. $END"
for d in "${DATES[@]}"; do rm -f "$REPO_ROOT/kierston/sim_outputs/day_$d.bin"; done
rm -f "$REPO_ROOT/kierston/sim_data/week_${START}_${END}.json"

step "build full population (init_sim.py)"
cd "$REPO_ROOT" && kierston/.venv/bin/python kierston/init/init_sim.py

step "build car graph"
cd "$REPO_ROOT/kierston/pathfinder" && bun run build-graph

step "export sequential week $START .. $END"
cd "$REPO_ROOT/kierston/sim" && bun run day --export-day --week --days "$DAYS" --date "$START"
test -f "$REPO_ROOT/kierston/sim_data/week_${START}_${END}.json"
for d in "${DATES[@]}"; do test -s "$REPO_ROOT/kierston/sim_outputs/day_$d.bin"; done

cd "$REPO_ROOT/fastgate"
step "wipe PostgreSQL and ClickHouse"
bun -e "$WIPE_TS"

step "ingest static records (PostgreSQL)"
bun run ingest:static -- ../kierston/sim_data/sim_init.bin
step "ingest cameras (PostgreSQL)"
bun run ingest:cameras -- "../kierston/cities/${KIERSTON_CITY:-kierston}/cameras.json"
step "ingest cell sites (PostgreSQL)"
bun run ingest:cells -- ../kierston/sim_data/towers.json
for d in "${DATES[@]}"; do
  step "ingest day $d (ClickHouse)"
  bun run ingest:dynamic -- "../kierston/sim_outputs/day_$d.bin"
done

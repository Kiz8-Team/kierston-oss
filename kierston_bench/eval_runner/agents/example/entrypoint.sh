#!/bin/bash
# Reads the case file, touches ADI once, and writes a placeholder answer.
set -uo pipefail

task="${ETF:-/input/input.json}"
out="${EOD:-/out}"
work="${EWD:-/work}"

id="$(jq -r .id "$task")"
kind="$(jq -r .answer.kind "$task")"
echo "case $id ($kind)"

# `adi days` prints {"days": [...], "timeZone": ...}; count the list, not the object's keys.
adi days --format json > "$work/days.json" && echo "adi reachable, $(jq '.days | length' "$work/days.json") day(s) loaded" || echo "adi unreachable"

case "$kind" in
  ranked-ids|id-set|label-set) answer='[]' ;;
  point) answer='{"lat": 0, "lon": 0}' ;;
  record) answer='{}' ;;
  *) answer='""' ;;
esac
jq -n --argjson answer "$answer" '{answer: $answer, notes: "example agent, placeholder answer"}' > "$out/answer.json"
echo "wrote $out/answer.json"

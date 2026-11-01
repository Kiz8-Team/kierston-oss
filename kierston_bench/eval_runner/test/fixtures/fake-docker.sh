#!/bin/bash
# Stands in for docker in tests. `run` parses the mounts and env the runner
# passes, then behaves per FAKE_MODE: answer (write a valid answer), bad-json,
# none (exit without an answer), hang (sleep until killed), fail (exit 3).
# `kill` ends a hanging run through a pid file in the out mount.
set -u
cmd="${1:-}"; shift || true
case "$cmd" in
  run)
    out=""; work=""; task=""; taskid=""; cap=""; name=""; sessions=""; global_sessions=""; context=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in *:/work/.pi/agent/sessions) sessions="${2%%:*}";; *:/opt/pi-agent/sessions|*:/home/agent/.claude/agent/sessions) global_sessions="${2%%:*}";; *:/out) out="${2%%:*}";; *:/work) work="${2%%:*}";; *:/input|*:/input:ro) task="${2%%:*}";; esac; shift 2;;
        -e) case "$2" in EC=*) context="${2#EC=}";; AT=*) cap="${2#AT=}";; esac; shift 2;;
        --name) name="$2"; shift 2;;
        bash) echo "fake docker: startup: $3"; break;;
        *) shift;;
      esac
    done
    # The container never sees its task id; like the KDI service, resolve it from the capability registration.
    [ -n "$cap" ] && [ -n "${FAKE_KDI_POLICY_DIR:-}" ] && taskid="$(jq -r .taskId "$FAKE_KDI_POLICY_DIR/$cap.json")"
    echo "fake docker: task $(jq -r .id "$task/input.json") as $name"
    echo "stderr line" >&2
    echo "print('hi')" > "$work/script.py"
    [ -n "$sessions" ] && [ "$sessions" = "$global_sessions" ] || exit 4
    mkdir -p "$sessions/--work--"
    printf '{"type":"session","id":"%s"}\n{"type":"message","message":{"role":"toolResult","content":"recorded"}}\n' "$taskid" > "$sessions/--work--/2026-09-06T00-00-00-000Z_test.jsonl"
    printf '%s\n' "$context" > "$out/logs/context.txt"
    echo "transcript" > "$out/logs/agent.log"
    if [ -n "${FAKE_KDI_LOG_DIR:-}" ]; then
      f="$FAKE_KDI_LOG_DIR/$(printf '%s' "$taskid" | sed 's/[^A-Za-z0-9_.-]/_/g').jsonl"
      printf '{"taskId":"%s","args":["days"],"code":0}\n{"taskId":"%s","args":["catalog"],"code":0}\n' "$taskid" "$taskid" >> "$f"
    fi
    case "${FAKE_MODE:-answer}" in
      answer) echo '{"answer":["p1","p2"]}' > "$out/answer.json";;
      bad-json) echo '{not json' > "$out/answer.json";;
      wrong-id) echo '{"taskId":"other","answer":1}' > "$out/answer.json";;
      none) ;;
      slow) sleep 0.3; echo '{"answer":["p1","p2"]}' > "$out/answer.json";;
      fail) exit 3;;
      hang) echo $$ > "$out/.pid"; sleep 30; exit 137;;
    esac
    ;;
  kill)
    for pid in "${FAKE_OUT_ROOT:-/nonexistent}"/*/out/.pid; do [ -f "$pid" ] && kill "$(cat "$pid")" 2>/dev/null; done
    pkill -f "sleep 30" 2>/dev/null
    ;;
esac

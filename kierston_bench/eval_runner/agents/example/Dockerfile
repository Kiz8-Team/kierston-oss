# A minimal agent image for smoke-testing the runner. The base image already
# carries pi, so a run normally needs no image of its own; this one adds an
# entrypoint that reads $ETF, touches KDI, and writes an empty
# $EOD/answer.json. Run it with
#
#   docker build -t kierston-agent-example kierston_bench/eval_runner/agents/example
#   bun run eval-runner <series.json> --image kierston-agent-example -- agent-entrypoint
#
# or set the series' startup command to `agent-entrypoint`.

FROM kierston-eval-env

COPY --chmod=0755 entrypoint.sh /usr/local/bin/agent-entrypoint
ENTRYPOINT ["agent-entrypoint"]

#!/usr/bin/env bash
# Build the pi coding agent as a Linux binary for the evaluation image.
#
#   agent_eval_runtime/build-pi.sh [pi-cwl checkout] [bun target]
#   PI_SRC=~/src/pi-cwl agent_eval_runtime/build-pi.sh
#
# The checkout is the first argument, else $PI_SRC, else a pi-cwl directory
# next to the repository (../pi-cwl from the repository root).
#
# Compiles packages/coding-agent/dist/bun/cli.js of the checkout with
# `bun build --compile` for Linux and copies the assets the binary reads next
# to itself (package.json, themes, export template, photon wasm, docs) into
# agent_eval_runtime/pi/. The Dockerfile copies that directory to /opt/pi.
#
# The checkout must already be built (`npm run build` in the monorepo). The
# target defaults to the host's architecture; pass bun-linux-x64 for an
# x86-64 docker host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-${PI_SRC:-$HERE/../../../pi-cwl}}"
case "${2:-${PI_TARGET:-}}" in
  "") case "$(uname -m)" in arm64|aarch64) TARGET=bun-linux-arm64 ;; *) TARGET=bun-linux-x64 ;; esac ;;
  *) TARGET="$2" ;;
esac
PKG="$SRC/packages/coding-agent"
OUT="$HERE/pi"

if [ ! -d "$PKG" ]; then
  cat >&2 <<MSG
build-pi.sh: no pi checkout at $SRC
The evaluation image runs the pi coding agent, built from a checkout of the
pi-cwl monorepo (packages/coding-agent). Clone and build it, then point this
script at it:
  PI_SRC=/path/to/pi-cwl agent_eval_runtime/build-pi.sh
or pass the path as the first argument. Without it there is no agent image;
an image of your own that follows the agent contract in README.md works too.
MSG
  exit 1
fi
[ -f "$PKG/dist/bun/cli.js" ] || { echo "no $PKG/dist/bun/cli.js; run 'npm install && npm run build' in $SRC first" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/theme" "$OUT/assets" "$OUT/export-html/vendor"
bun build --compile --target="$TARGET" "$PKG/dist/bun/cli.js" --outfile "$OUT/pi"

cp "$PKG/package.json" "$PKG/README.md" "$PKG/CHANGELOG.md" "$OUT/"
cp "$PKG"/src/modes/interactive/theme/*.json "$OUT/theme/"
cp "$PKG"/src/modes/interactive/assets/*.png "$OUT/assets/"
cp "$PKG/src/core/export-html/template.html" "$OUT/export-html/"
cp "$PKG"/src/core/export-html/vendor/*.js "$OUT/export-html/vendor/"
cp -R "$PKG/docs" "$OUT/docs"
node "$PKG/scripts/copy-photon-wasm.mjs" "$OUT" "$PKG"

echo "built $OUT/pi ($TARGET, $(jq -r .version "$OUT/package.json"))"

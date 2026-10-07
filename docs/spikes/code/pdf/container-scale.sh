#!/bin/sh
# Second pass, in a container committed from the first (engines already installed in /w):
# the 500-thing Arabic report per engine, then the 60-thing one under a 512 MB limit is run by the
# caller with `docker run --memory 512m`. Usage: container-scale.sh [SCALE]
set -e
cd /w
cp /spike/lib/*.mjs lib/ && cp /spike/*.mjs /spike/report.typ . && rm -rf sample && cp -r /spike/sample .
export CHROMIUM_PATH=$(find /ms-playwright -type f \( -name chrome-headless-shell -o -name headless_shell \) | head -1)
ls -la "$CHROMIUM_PATH"
S=${1:-500}
for i in 1 2; do
  SCALE=$S TAG=-$S node measure.mjs render-typst.mjs ar
  SCALE=$S TAG=-$S node measure.mjs render-chromium.mjs ar
  SCALE=$S TAG=-$S node measure.mjs render-reactpdf.mjs ar
done

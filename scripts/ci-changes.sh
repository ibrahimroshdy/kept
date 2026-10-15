#!/usr/bin/env bash
# Which of ci.yml's jobs a change needs (the `changes` job). Reads changed paths, one per line, on
# stdin and prints two GitHub outputs:
#
#   unit=true|false    the unit tests (fast's `unit` and `eval` steps): false only when every path
#                      is prose: docs/ (outside docs/spikes/, which holds code a test reads) or a
#                      Markdown file at the root (CHANGELOG.md, README.md, …)
#   heavy=true|false   db, e2e, the images and helm: false when every path is prose or the docs
#                      site (apps/docs/, which none of them builds or runs; docs.yml builds it)
#
# Anything else, an empty list included, needs everything. `fast`'s lint, catalogues and
# typecheck run whatever this says. A release PR (CHANGELOG.md, README.md) and a release record
# (docs/releases/) need neither.
#
#   git diff --name-only "$BASE...$HEAD" | bash scripts/ci-changes.sh >>"$GITHUB_OUTPUT"
set -euo pipefail

unit=false
heavy=false
n=0
while IFS= read -r path; do
  [[ -n $path ]] || continue
  n=$((n + 1))
  if [[ $path == docs/spikes/* ]]; then
    unit=true heavy=true # code a test reads
  elif [[ $path == docs/* || ($path == *.md && $path != */*) ]]; then
    : # prose: no test reads it (release.sh checks README.md at release time)
  elif [[ $path == apps/docs/* ]]; then
    unit=true
  else
    unit=true heavy=true
  fi
done
if ((n == 0)); then
  unit=true heavy=true
fi
echo "unit=$unit"
echo "heavy=$heavy"

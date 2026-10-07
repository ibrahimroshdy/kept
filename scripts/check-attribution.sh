#!/usr/bin/env bash
# D173: no AI attribution in commit messages, authors or committers.
# Usage: check-attribution.sh <message-file>        (commit-msg hook)
#        check-attribution.sh --range <rev-range>    (CI: every commit in range)
set -euo pipefail
pattern='(co-authored-by:.*(claude|anthropic|copilot|openai|chatgpt|gpt|gemini|cursor|codeium|devin))|generated (with|by) .*(claude|ai|copilot|chatgpt)|noreply@anthropic\.com|🤖'
check_text() {
  if grep -Eiq "$pattern" <<<"$1"; then
    echo "D173: AI attribution found in $2" >&2
    grep -Ein "$pattern" <<<"$1" >&2 || true
    return 1
  fi
}
if [[ "${1:-}" == "--range" ]]; then
  status=0
  while read -r sha; do
    body=$(git log -1 --format='%an <%ae>%n%cn <%ce>%n%B' "$sha")
    check_text "$body" "commit $sha" || status=1
  done < <(git rev-list "$2")
  exit $status
fi
check_text "$(cat "$1")" "commit message"

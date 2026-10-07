#!/usr/bin/env bash
# The Developer Certificate of Origin (https://developercertificate.org/, go-public plan D5):
# every non-merge commit in a range carries a `Signed-off-by:` trailer naming its author exactly,
# as `git commit -s` writes it. No bot and no third-party app: the ci workflow runs this on a pull
# request's commits. It applies from the first public pull request on; the history before that has
# no sign-offs, so it is never run over the whole history.
#
# Usage: check-dco.sh --range <rev-range>     e.g. check-dco.sh --range origin/main..HEAD
set -euo pipefail
if [[ ${1:-} != --range || -z ${2:-} ]]; then
  echo "usage: check-dco.sh --range <rev-range>" >&2
  exit 2
fi
status=0
count=0
while read -r sha; do
  [[ -n $sha ]] || continue
  count=$((count + 1))
  author=$(git log -1 --format='%an <%ae>' "$sha")
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly,unfold)' "$sha" |
    sed -e 's/[[:space:]]*$//' | grep -Fxq -- "$author"; then
    echo "DCO: commit ${sha:0:12} has no \"Signed-off-by: $author\"." >&2
    status=1
  fi
done < <(git rev-list --no-merges "$2")
if [[ $status -ne 0 ]]; then
  echo "Sign off each commit with \`git commit -s\` (CONTRIBUTING.md, \"Sign your commits\"); fix" >&2
  echo "existing ones with \`git rebase --signoff <base>\` and force-push the branch." >&2
else
  echo "DCO: $count commit(s) signed off"
fi
exit $status

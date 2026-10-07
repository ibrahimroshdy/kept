#!/bin/sh
# Step-8 spike R1: retention over 40 faked days (backup --time), and what --group-by must be.
#   RESTIC=<restic binary> WORK=<scratch dir> sh r1-retention.sh
# Synthetic data; throwaway password in the environment only. macOS or GNU date.
set -u
: "${RESTIC:?}" "${WORK:?}"
export RESTIC_PASSWORD='spike-only-retention'
rm -rf "$WORK/ret"; mkdir -p "$WORK/ret/data/backup/db" "$WORK/ret/out"
O=$WORK/ret/out; D=$WORK/ret/data
export RESTIC_CACHE_DIR="$WORK/ret/cache"
run() { # $1 repo  $2 label  $3 mode(stable|tmp)  $4 group-by
  export RESTIC_REPOSITORY="$WORK/ret/$1"
  "$RESTIC" init --json >/dev/null
  i=0
  while [ $i -lt 40 ]; do
    day=$(date -u -j -v+${i}d -f %Y-%m-%d 2026-08-28 +%Y-%m-%d 2>/dev/null || date -u -d "2026-08-28 +$i day" +%Y-%m-%d)
    echo "$day" >"$D/backup/db/db.dump"
    if [ "$3" = tmp ]; then T="$WORK/ret/tmp-$i"; mkdir -p "$T"; cp "$D/backup/db/db.dump" "$T/"; P="$T"; else P="$D/backup"; fi
    "$RESTIC" backup -q --host kept --tag nightly --time "$day 02:00:00" "$P" >/dev/null
    i=$((i + 1))
  done
  # A pre-upgrade snapshot series beside it, kept by its own rule.
  for d in 2026-09-01 2026-09-10 2026-09-20 2026-10-01; do
    "$RESTIC" backup -q --host kept --tag pre_upgrade --time "$d 03:00:00" "$D/backup/db" >/dev/null
  done
  "$RESTIC" forget --json --host kept --tag nightly --group-by "$4" \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >"$O/$2-forget.json" 2>"$O/$2-forget.err"
  echo "$2 forget exit $?"
  "$RESTIC" forget --json --host kept --tag pre_upgrade --group-by "$4" --keep-last 3 >"$O/$2-forget-pre.json" 2>&1
  "$RESTIC" snapshots --json >"$O/$2-snapshots.json"
  python3 - "$O/$2-snapshots.json" "$2" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
n = sorted((x["time"][:10], ",".join(x.get("tags") or [])) for x in s)
print(sys.argv[2], "kept", len(n), [d for d, t in n if t == "nightly"], "pre_upgrade:", [d for d, t in n if t == "pre_upgrade"])
PY
}
run stable stable-default stable host,paths
run tmp tmp-default tmp host,paths
run tmp2 tmp-hosttags tmp host,tags

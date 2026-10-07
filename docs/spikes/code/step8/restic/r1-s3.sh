#!/bin/sh
# Step-8 spike R1: restic against the dev RustFS (compose.dev.yaml, profile s3, port 9452).
#   docker compose -f compose.dev.yaml --profile s3 up -d s3
#   RESTIC=<restic binary> WORK=<scratch dir> sh r1-s3.sh
# The dev RustFS credentials from compose.dev.yaml (dev only); a throwaway repository password.
set -u
: "${RESTIC:?}" "${WORK:?}"
export AWS_ACCESS_KEY_ID=kept-dev AWS_SECRET_ACCESS_KEY=kept-dev-secret
export RESTIC_PASSWORD='spike-only-s3'
export RESTIC_CACHE_DIR="$WORK/s3/cache"
O=$WORK/s3/out; rm -rf "$WORK/s3"; mkdir -p "$O" "$WORK/s3/data/backup/db"
head -c 2000000 /dev/urandom >"$WORK/s3/data/backup/db/db.dump"
B=kept-spike8-$$
# 1. A bucket that does not exist yet: does init create it?
export RESTIC_REPOSITORY="s3:http://localhost:9452/$B/kept/restic"
"$RESTIC" init --json >"$O/init-nobucket.json" 2>"$O/init-nobucket.err"; echo "init (no bucket, auto lookup) $?"
"$RESTIC" -o s3.bucket-lookup=path init --json >"$O/init-path.json" 2>"$O/init-path.err"; echo "init (path lookup) $?"
O2="-o s3.bucket-lookup=path -o s3.region=us-east-1"
cd "$WORK/s3/data"
"$RESTIC" $O2 backup --json --host kept --tag nightly backup >"$O/backup.jsonl" 2>"$O/backup.err"; echo "backup $?"
"$RESTIC" $O2 backup --json --host kept --tag nightly backup >"$O/backup2.jsonl" 2>"$O/backup2.err"; echo "backup2 $?"
"$RESTIC" $O2 snapshots --json >"$O/snapshots.json" 2>"$O/snapshots.err"; echo "snapshots $?"
"$RESTIC" $O2 check --json >"$O/check.json" 2>"$O/check.err"; echo "check $?"
"$RESTIC" $O2 check --json --read-data >"$O/check-read.json" 2>"$O/check-read.err"; echo "check --read-data $?"
"$RESTIC" $O2 restore --json latest --target "$WORK/s3/restored" >"$O/restore.jsonl" 2>"$O/restore.err"; echo "restore $?"
cmp "$WORK/s3/restored/backup/db/db.dump" "$WORK/s3/data/backup/db/db.dump" && echo "restored dump identical"
# 2. Wrong secret key, and an unreachable endpoint: which exit code, which message.
AWS_SECRET_ACCESS_KEY=wrong "$RESTIC" $O2 snapshots --json >/dev/null 2>"$O/badkey.err"; echo "bad secret $?"
RESTIC_REPOSITORY="s3:http://localhost:9/$B/kept/restic" "$RESTIC" $O2 snapshots --json >/dev/null 2>"$O/unreachable.err" &
P=$!; sleep 20; kill $P 2>/dev/null && echo "unreachable: still retrying after 20 s (killed)"; wait $P; echo "unreachable exit $?"
echo "bucket=$B" >"$O/bucket.txt"

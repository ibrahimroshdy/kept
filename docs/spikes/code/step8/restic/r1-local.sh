#!/bin/sh
# Step-8 spike R1: restic against a local directory target, inside the runtime image's base
# (node:24.21.0-bookworm-slim), as uid 10001 with a read-only root and HOME=/tmp, as Kept runs.
#
#   docker volume create r1work   # a named volume: a macOS bind mount gave EIO on reads as uid 10001
#   docker run --rm -v r1work:/work alpine chown 10001:10001 /work   (or any root shell)
#   docker run --rm --read-only --tmpfs /tmp --user 10001:10001 -e HOME=/tmp \
#     -v r1work:/work -v <this dir>:/spike:ro -v <restic-linux-binary>:/usr/local/bin/restic:ro \
#     node:24.21.0-bookworm-slim@sha256:0e0ff40c... sh /spike/r1-local.sh
#
# Writes every JSON message it sees to /work/out/*.jsonl and each exit code to /work/out/codes.txt.
# Synthetic data only. The password is a throwaway, passed only in the environment.
set -u
W=/work; O=$W/out; rm -rf "$O" "$W/target" "$W/data"; mkdir -p "$O"
code() { echo "$1 $2" >>"$O/codes.txt"; }
export RESTIC_PASSWORD='spike-only-correct-horse'   # throwaway
# The alpha target already holds runs/ and blobs/ (Q2): the repository goes in restic/ beside them.
mkdir -p "$W/target/runs/2026-10-01T02-00-00Z" "$W/target/blobs/ab"
echo alpha >"$W/target/runs/2026-10-01T02-00-00Z/db.dump"
export RESTIC_REPOSITORY="$W/target/restic"
# What KEPT_DATA_DIR looks like: backup/{db,readable} beside blobs/, and the proposed cache dir.
D=$W/data; mkdir -p "$D/backup/db" "$D/backup/readable/home" "$D/blobs/aa" "$D/.cache"
head -c 3000000 /dev/urandom | od -An -tx1 >"$D/backup/db/db.dump"
echo '{"counts":{"things":3}}' >"$D/backup/db/manifest.json"
echo '<h1>Home</h1>' >"$D/backup/readable/home/index.html"
for i in 1 2 3; do head -c 200000 /dev/urandom >"$D/blobs/aa/blob$i.jpg"; done
export RESTIC_CACHE_DIR="$D/.cache/restic"
cd "$D"   # relative paths keep the snapshot's paths stable whatever KEPT_DATA_DIR is

# Exit code: no repository yet.
restic snapshots --json >"$O/norepo.out" 2>"$O/norepo.err"; code norepo $?
restic init --json >"$O/init.jsonl" 2>"$O/init.err"; code init $?
# Warm the cache first: two restic processes creating a fresh cache dir at once can fail (exit 1,
# "unable to open cache: readVersion", seen in this spike's first run).
restic snapshots --json >/dev/null 2>&1
# A password given only in the environment never shows in argv: read every process's cmdline mid-backup.
head -c 300000000 /dev/zero >"$D/backup/big.bin"
restic backup --json --host kept --tag nightly backup blobs >"$O/backup-big.jsonl" 2>"$O/backup-big.err" &
P=$!; sleep 1
( for p in /proc/[0-9]*; do tr '\0' ' ' <"$p/cmdline" 2>/dev/null; echo; done ) >"$O/ps-cmdlines.txt"
grep -c 'spike-only' "$O/ps-cmdlines.txt" >"$O/ps-password-hits.txt"
# Exit code: locked. prune wants an exclusive lock while the backup holds a shared one.
restic prune --json >"$O/locked.out" 2>"$O/locked.err"; code locked $?
wait $P; code backup-big $?
rm "$D/backup/big.bin"
# Exit code: wrong password.
RESTIC_PASSWORD=wrong restic snapshots --json >"$O/wrongpw.out" 2>"$O/wrongpw.err"; code wrongpw $?
# Two backups of the same paths with a fixed host.
restic backup --json --host kept --tag nightly backup blobs >"$O/backup1.jsonl" 2>"$O/backup1.err"; code backup1 $?
head -c 200000 /dev/urandom >"$D/blobs/aa/blob4.jpg"
restic backup --json --host kept --tag nightly backup blobs >"$O/backup2.jsonl" 2>"$O/backup2.err"; code backup2 $?
# Exit code 3: a file restic can't read.
head -c 10 /dev/urandom >"$D/blobs/aa/locked.jpg"; chmod 000 "$D/blobs/aa/locked.jpg"
restic backup --json --host kept --tag nightly backup blobs >"$O/backup3.jsonl" 2>"$O/backup3.err"; code backup-unreadable $?
chmod 600 "$D/blobs/aa/locked.jpg"; rm "$D/blobs/aa/locked.jpg"
restic snapshots --json >"$O/snapshots.json" 2>"$O/snapshots.err"; code snapshots $?
restic ls --json latest >"$O/ls.jsonl" 2>"$O/ls.err"; code ls $?
restic stats --json >"$O/stats.json" 2>"$O/stats.err"; code stats $?
restic stats --json --mode raw-data >"$O/stats-raw.json" 2>"$O/stats-raw.err"; code stats-raw $?
restic check --json >"$O/check.jsonl" 2>"$O/check.err"; code check $?
mkdir -p "$W/restored"; rm -rf "$W/restored/"*
restic restore --json latest --target "$W/restored" --include /backup/readable >"$O/restore.jsonl" 2>"$O/restore.err"; code restore-include $?
find "$W/restored" -type f >"$O/restored-files.txt"
restic forget --json --host kept --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --dry-run >"$O/forget-dry.json" 2>"$O/forget-dry.err"; code forget-dry $?
du -sk "$D/.cache/restic" >"$O/cache-size.txt"
ls "$W/target" >"$O/target-ls.txt"
echo done

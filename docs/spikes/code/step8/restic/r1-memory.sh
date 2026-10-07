#!/bin/sh
# Step-8 spike R1: restic's peak RSS and wall time on the 2 GB floor's proxy.
#   docker volume create kept-spike8-mem && (chown it to 10001)
#   docker run --rm --memory 2g --cpus 2 --read-only --tmpfs /tmp --user 10001:10001 \
#     -v kept-spike8-mem:/data -v <this dir>:/spike:ro kept-spike8-restic:tmp sh /spike/r1-memory.sh
# Synthetic data (labelled as such in the note): a 100 MiB incompressible "dump" standing in for a
# 10,000-thing pg_dump -Fc (whose real size is not measured here), and 2 GiB of random 1 MiB files
# standing in for JPEGs (incompressible, like JPEGs). The repository is a directory target on the
# same volume. Throwaway password, environment only.
set -u
export RESTIC_PASSWORD='spike-only-memory'
export RESTIC_REPOSITORY=/data/target/restic
export RESTIC_CACHE_DIR=/data/.cache/restic
D=/data
if [ ! -f "$D/.prepared" ]; then
  mkdir -p "$D/backup/db" "$D/blobs"
  head -c 104857600 /dev/urandom >"$D/backup/db/db.dump"
  i=0; while [ $i -lt 2048 ]; do d="$D/blobs/$(printf %02x $((i % 256)))"; mkdir -p "$d"; head -c 1048576 /dev/urandom >"$d/p$i.jpg"; i=$((i + 1)); done
  touch "$D/.prepared"
fi
rm -rf /data/target; restic init -q
measure() { # $1 label, rest: restic args
  label=$1; shift
  start=$(date +%s.%N)
  restic "$@" >/tmp/out.json 2>/tmp/err.txt &
  pid=$!; peak=0
  while kill -0 $pid 2>/dev/null; do
    h=$(sed -n 's/^VmHWM:[[:space:]]*\([0-9]*\) kB/\1/p' /proc/$pid/status 2>/dev/null)
    [ -n "$h" ] && [ "$h" -gt "$peak" ] && peak=$h
    sleep 0.2
  done
  wait $pid; rc=$?
  end=$(date +%s.%N)
  echo "$label exit=$rc peak_rss_mib=$((peak / 1024)) wall_s=$(echo "$end - $start" | awk '{print $1 - $3}')"
  grep '"summary"' /tmp/out.json | head -c 600; echo
}
cd "$D"
measure first backup --json --host kept --tag nightly backup blobs
i=0; while [ $i -lt 50 ]; do head -c 1048576 /dev/urandom >"$D/blobs/00/new$i.jpg"; i=$((i + 1)); done
measure second backup --json --host kept --tag nightly backup blobs
measure check check --json
measure forget forget --json --host kept --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
echo "cache: $(du -sh /data/.cache/restic | cut -f1)  repository: $(du -sh /data/target/restic | cut -f1)"
rm -f "$D"/blobs/00/new*.jpg

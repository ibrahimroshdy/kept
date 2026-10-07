#!/bin/sh
# Step-8 spike R1: restic over SFTP to a throwaway SSH server, from the spike image
# (Dockerfile.restic) as uid 10001 with a read-only root. Mounted: the key volume at /keys
# (id_ed25519 at 0600 and a known_hosts line from ssh-keyscan, both owned by 10001).
#   docker run --rm --read-only --tmpfs /tmp --user 10001:10001 --network kept-spike8-net \
#     -v kept-spike8-keys:/keys:ro -v <this dir>:/spike:ro kept-spike8-restic:tmp sh /spike/r1-sftp.sh
set -u
export RESTIC_PASSWORD='spike-only-sftp'
export RESTIC_CACHE_DIR=/tmp/cache
mkdir -p /tmp/data/backup/db && head -c 1000000 /dev/urandom >/tmp/data/backup/db/db.dump
cd /tmp/data
# Host key pinned: our known_hosts only, strict checking, our key only, no agent, never a prompt.
ARGS="-o UserKnownHostsFile=/keys/known_hosts -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -i /keys/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=240"
REPO="sftp://kept@sftp:2222//config/kept-target/restic"
echo "ssh -V: $(ssh -V 2>&1)"
restic -r "$REPO" -o sftp.args="$ARGS" init --json; echo "init $?"
restic -r "$REPO" -o sftp.args="$ARGS" backup --json --host kept --tag nightly backup | grep -v '"status"'; echo "backup $?"
restic -r "$REPO" -o sftp.args="$ARGS" snapshots --json | head -c 200; echo; echo "snapshots $?"
restic -r "$REPO" -o sftp.args="$ARGS" check --json; echo "check $?"
# A wrong pinned host key must refuse.
echo "[sftp]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDj3WqkXoQ6m1t3Wq6x3KXbTgmeXz6dOYDqXbQJ2yN0b" >/tmp/bad_known_hosts
BAD=$(echo "$ARGS" | sed 's#/keys/known_hosts#/tmp/bad_known_hosts#')
restic -r "$REPO" -o sftp.args="$BAD" snapshots --json; echo "wrong host key $?"

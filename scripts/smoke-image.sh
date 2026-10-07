#!/usr/bin/env bash
# Smoke test for a built Kept image (task 29; L103; D147, D186, D193).
#
#   bash scripts/smoke-image.sh <image>        e.g. kept:dev, kept:ci-arm64
#
# Runs the image the way compose.yaml does, against a throwaway Postgres bootstrapped by
# docker/initdb-prod (so the production roles script is exercised too), on its own network with
# fresh volumes, and asserts:
#   1. `kept migrate` succeeds with only KEPT_OWNER_DATABASE_URL;
#   2. /readyz answers 200, and the image's own HEALTHCHECK script agrees;
#   3. /version reports the source URL, and it matches the image's OCI source label;
#   4. the web bundle is served at / under a CSP without 'unsafe-inline';
#   5. the process runs as uid 10001 with a read-only root filesystem (and really can't write);
#   6. first boot generated /config/secrets.json and logged one line saying so;
#   7. a second boot on the same volumes reuses that file byte for byte and logs no new keys;
#   8. first boot printed exactly one `KEPT SETUP CODE: XXX-XXX` line, GET /api/v1/setup says
#      setup is needed, and the second boot prints no new code;
#   9. the image's pg_dump is the database's major version, and `kept admin backup` makes a
#      backup with it (T31c);
#  10. restic and ssh run as uid 10001 (ssh needs the passwd entry), and /app/THIRD-PARTY-NOTICES.txt
#      names this image's version and architecture (step-8 T15);
#  11. with the restic backup in the image (dist/backup/drill.js, step-8 T5/T7): a backup with
#      KEPT_BACKUP_DIR and KEPT_BACKUP_PASSWORD makes a restic snapshot, and `kept admin backup
#      drill` restores it into a second database the superuser creates, every table's count and
#      digest equal. Before T5/T7 the image's alpha backup is checked instead (9).
# BOOT_TIMEOUT (seconds, default 60) bounds each wait for Postgres and /readyz; raise it for an
# image run under emulation (an amd64 image on an arm64 Mac).
# SMOKE_SCOPE=release (scripts/release.sh, stage 4) runs 1-10 and stops after the first boot: no
# restic backup and drill (11) and no second boot (7, and 8's second half). Those check Kept's
# own code, which ci-local's `images` step smokes in full before the tag; the release smoke is
# about this artifact on this architecture: it boots, migrates, serves, and its pinned binaries
# (node, pg_dump, restic, ssh) run. The default, SMOKE_SCOPE=full, runs everything.
# Everything it creates (containers, network, volumes) is removed on exit, pass or fail.
#
# Docker: DOCKER_CONFIG defaults to /tmp/kept-docker-config, as in scripts/ci-local.sh (the
# Docker Desktop credential helper can hang without a desktop session).
set -euo pipefail

image=${1:?usage: smoke-image.sh <image>}
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/kept-docker-config}

# Same pinned image as compose.yaml.
PG_IMAGE=pgvector/pgvector:0.8.6-pg18-bookworm@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a
BOOT_TIMEOUT=${BOOT_TIMEOUT:-60}
SMOKE_SCOPE=${SMOKE_SCOPE:-full}
[[ $SMOKE_SCOPE == full || $SMOKE_SCOPE == release ]] || {
  echo "smoke: SMOKE_SCOPE is full or release, not '$SMOKE_SCOPE'" >&2
  exit 2
}

run_id="kept-smoke-$(date +%s)-$$"
net=$run_id
db=$run_id-db
app=$run_id-app
vol_data=$run_id-data
vol_config=$run_id-config
vol_db=$run_id-pg

cleanup() {
  local rc=$?
  if ((rc != 0)) && docker inspect "$app" >/dev/null 2>&1; then
    echo "--- kept logs (last 40) ---" >&2
    docker logs --tail 40 "$app" >&2 2>&1 || true
  fi
  docker rm -f "$app" "$db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker volume rm "$vol_data" "$vol_config" "$vol_db" >/dev/null 2>&1 || true
  if ((rc == 0)); then echo "smoke: PASS ($image)"; else echo "smoke: FAIL ($image)" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "smoke: $*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

docker image inspect "$image" >/dev/null 2>&1 || fail "no local image '$image' (build it with --load)"

# Hex passwords, generated per run; nothing here is reused anywhere.
pw() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
owner_pw=$(pw) app_pw=$(pw) auth_pw=$(pw) system_pw=$(pw) super_pw=$(pw)

step "network, volumes and Postgres ($PG_IMAGE)"
docker network create "$net" >/dev/null
docker volume create "$vol_data" >/dev/null
docker volume create "$vol_config" >/dev/null
docker volume create "$vol_db" >/dev/null
docker run -d --name "$db" --network "$net" --network-alias db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$super_pw" -e POSTGRES_DB=kept -e TZ=UTC \
  -e KEPT_DB_OWNER_PASSWORD="$owner_pw" -e KEPT_DB_APP_PASSWORD="$app_pw" \
  -e KEPT_DB_AUTH_PASSWORD="$auth_pw" -e KEPT_DB_SYSTEM_PASSWORD="$system_pw" \
  -v "$vol_db:/var/lib/postgresql" \
  -v "$repo/docker/initdb-prod:/docker-entrypoint-initdb.d:ro" \
  "$PG_IMAGE" >/dev/null

# Over TCP: the init-time server listens on the socket only, so this passes after initdb.
deadline=$((SECONDS + BOOT_TIMEOUT))
until docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d kept >/dev/null 2>&1; do
  ((SECONDS < deadline)) || { docker logs --tail 40 "$db" >&2; fail "Postgres not ready in ${BOOT_TIMEOUT}s"; }
  [[ $(docker inspect -f '{{.State.Running}}' "$db") == true ]] || { docker logs "$db" >&2; fail "Postgres exited"; }
  sleep 1
done
roles=$(docker exec "$db" psql -U postgres -d kept -qAt -c \
  "SELECT string_agg(rolname || ':' || rolcreatedb, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'kept\_%'")
[[ $roles == "kept_app:false,kept_auth:false,kept_owner:false,kept_system:false" ]] ||
  fail "initdb-prod roles: got '$roles'"
echo "roles: $roles"
app_settings=$(docker exec "$db" psql -U postgres -d kept -qAt -c \
  "SELECT array_to_string(rolconfig, ',') FROM pg_roles WHERE rolname = 'kept_app'")
[[ $app_settings == "statement_timeout=15s,idle_in_transaction_session_timeout=30s" ]] ||
  fail "kept_app role settings: got '$app_settings'"

url() { echo "postgres://kept_$1:$2@db:5432/kept"; }

# The same hardening as compose.yaml.
hardening=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true)

step "kept migrate (owner login only)"
docker run --rm --network "$net" "${hardening[@]}" --entrypoint kept \
  -e KEPT_OWNER_DATABASE_URL="$(url owner "$owner_pw")" \
  "$image" migrate

step "restic, ssh and the third-party notices"
restic_v=$(docker run --rm "${hardening[@]}" --entrypoint restic "$image" version) ||
  fail "restic version failed in the image"
echo "$restic_v"
# ssh refuses to start for a uid with no passwd entry; restic's SFTP backend runs it.
ssh_v=$(docker run --rm "${hardening[@]}" --entrypoint ssh "$image" -V 2>&1) ||
  fail "ssh -V failed in the image: $ssh_v"
echo "$ssh_v"
user=$(docker run --rm "${hardening[@]}" --entrypoint id "$image" -un) || fail "no passwd entry for the runtime uid"
[[ $user == kept ]] || fail "the runtime uid is '$user', expected kept"
arch=$(docker image inspect -f '{{.Architecture}}' "$image")
label_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
notices_head=$(docker run --rm "${hardening[@]}" --entrypoint head "$image" -n 1 /app/THIRD-PARTY-NOTICES.txt) ||
  fail "/app/THIRD-PARTY-NOTICES.txt is missing"
[[ $notices_head == "Third-party software in the Kept $label_version image (linux/$arch)" ]] ||
  fail "THIRD-PARTY-NOTICES.txt heads '$notices_head', expected version $label_version on $arch"
echo "$notices_head"

# The restic backup and its drill replace the alpha's backup once T5/T7 are in the image.
restic_backup=false
if docker run --rm --entrypoint test "$image" -f /app/apps/server/dist/backup/drill.js; then
  restic_backup=true
fi

step "kept admin backup (the image's pg_dump against Postgres 18)"
docker run --rm --network "$net" "${hardening[@]}" --entrypoint pg_dump "$image" --version |
  grep -q '(PostgreSQL) 18\.' || fail "the image's pg_dump is not version 18"
if [[ $restic_backup == true ]]; then
  echo "restic backup in the image: checked after the first boot"
else
backup_out=$(docker run --rm --network "$net" "${hardening[@]}" --tmpfs /backups \
  -v "$vol_data:/data" --entrypoint kept \
  -e KEPT_OWNER_DATABASE_URL="$(url owner "$owner_pw")" -e KEPT_BACKUP_DIR=/backups \
  "$image" admin backup) || fail "kept admin backup failed"
grep -q '^Backup ' <<<"$backup_out" || fail "kept admin backup said: $backup_out"
echo "$backup_out" | tail -n 1
fi

start_app() {
  docker run -d --name "$app" --network "$net" "${hardening[@]}" \
    -v "$vol_data:/data" -v "$vol_config:/config" \
    -e KEPT_DATABASE_URL="$(url app "$app_pw")" \
    -e KEPT_AUTH_DATABASE_URL="$(url auth "$auth_pw")" \
    -e KEPT_SYSTEM_DATABASE_URL="$(url system "$system_pw")" \
    -e KEPT_PUBLIC_URL=http://localhost:8080 \
    -p 127.0.0.1::8080 \
    "$image" >/dev/null
  port=$(docker port "$app" 8080/tcp | sed -n '1s/.*://p')
  [[ -n $port ]] || fail "no published port"
  base="http://127.0.0.1:$port"
  local deadline=$((SECONDS + BOOT_TIMEOUT)) code=000
  while ((SECONDS < deadline)); do
    [[ $(docker inspect -f '{{.State.Running}}' "$app") == true ]] || fail "kept exited before /readyz answered"
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$base/readyz" || true)
    if [[ $code == 200 ]]; then
      echo "/readyz 200 on $base"
      return 0
    fi
    sleep 0.5
  done
  fail "/readyz did not return 200 within ${BOOT_TIMEOUT}s (last: $code)"
}

step "first boot"
start_app

docker exec "$app" node /app/docker/healthcheck.mjs || fail "the image's HEALTHCHECK script failed"
echo "HEALTHCHECK script: ok"

label_source=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")
label_revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
version=$(curl -fsS "$base/version")
echo "/version: $version"
source=$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(v.source ?? "")' "$version")
[[ -n $label_source ]] || fail "image has no org.opencontainers.image.source label"
expected=$label_source${label_revision:+/tree/$label_revision}
[[ $source == "$expected" ]] || fail "/version source '$source', expected '$expected' (from the OCI labels)"

grep -q '<div id="root">' <<<"$(curl -fsS "$base/")" || fail "/ did not serve the web bundle"
headers=$(curl -fsS -o /dev/null -D - "$base/")
csp=$(grep -i '^content-security-policy:' <<<"$headers" | tr -d '\r')
[[ -n $csp && $csp != *unsafe-inline* ]] || fail "unexpected CSP on /: '$csp'"
echo "web bundle served at /; $csp"

uid=$(docker exec "$app" id -u)
[[ $uid == 10001 ]] || fail "runs as uid $uid, expected 10001"
[[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$app") == true ]] || fail "root filesystem is not read-only"
if docker exec "$app" sh -c 'touch /app/probe' 2>/dev/null; then fail "wrote to /app on a read-only root"; fi
docker exec "$app" sh -c 'touch /data/probe /tmp/probe && rm /data/probe /tmp/probe' ||
  fail "/data or /tmp is not writable"
echo "uid 10001, read-only root, /data and /tmp writable"

docker exec "$app" test -s /config/secrets.json || fail "/config/secrets.json was not generated"
mode=$(docker exec "$app" stat -c '%a %u' /config/secrets.json)
[[ $mode == "600 10001" ]] || fail "secrets.json mode/owner is '$mode', expected '600 10001'"
first_hash=$(docker exec "$app" sha256sum /config/secrets.json | cut -d' ' -f1)
# Logs are captured first: `docker logs | grep -q` under pipefail fails when grep exits early.
logs=$(docker logs "$app" 2>&1)
grep -q 'generated KEPT_SECRET_KEY and KEPT_AUTH_SECRET at /config/secrets.json' <<<"$logs" ||
  fail "first boot did not log where the keys were generated"
echo "secrets.json generated (sha256 ${first_hash:0:12}…), and logged"

# The first-run setup code (task 22, D32, D190): printed once, by the process that stored it.
code_lines=$(grep -cE '^KEPT SETUP CODE: [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$' <<<"$logs" || true)
[[ $code_lines == 1 ]] || fail "first boot printed $code_lines setup code lines, expected 1"
setup=$(curl -fsS "$base/api/v1/setup")
[[ $setup == '{"needed":true}' ]] || fail "GET /api/v1/setup: '$setup', expected needed"
echo "setup code printed once; $setup"

if [[ $SMOKE_SCOPE == release ]]; then
  echo "SMOKE_SCOPE=release: no restic drill and no second boot (ci-local's images step runs them)"
  exit 0
fi

if [[ $restic_backup == true ]]; then
  step "restic backup, then the drill into a second database"
  # The runbook's superuser commands (docs/runbooks/restore-drill.md).
  docker exec "$db" psql -U postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE kept_drill OWNER kept_owner" >/dev/null
  docker exec "$db" psql -U postgres -d kept_drill -v ON_ERROR_STOP=1 -qc \
    "CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION vector; ALTER SCHEMA public OWNER TO kept_owner;" >/dev/null
  # One container, so the backup directory (a tmpfs) outlives the backup for the drill. The keys
  # come from the config volume the first boot wrote, as `migrate` reads them in compose.yaml.
  drill_out=$(docker run --rm --network "$net" "${hardening[@]}" \
    --tmpfs /backups:uid=10001,gid=10001,mode=0700 \
    -v "$vol_data:/data" -v "$vol_config:/config:ro" --entrypoint sh \
    -e KEPT_OWNER_DATABASE_URL="$(url owner "$owner_pw")" \
    -e KEPT_BACKUP_DIR=/backups -e KEPT_BACKUP_PASSWORD="$(pw)" \
    -e DRILL_URL="postgres://kept_owner:$owner_pw@db:5432/kept_drill" \
    "$image" -c '
      set -e
      kept admin backup
      RESTIC_PASSWORD=$KEPT_BACKUP_PASSWORD restic -r /backups/restic snapshots --json --no-lock >/tmp/snaps.json
      node -e "const s = JSON.parse(require(\"fs\").readFileSync(\"/tmp/snaps.json\", \"utf8\")); console.log(\"restic snapshots: \" + s.length); process.exit(s.length > 0 ? 0 : 1)"
      kept admin backup drill --into "$DRILL_URL"
    ' 2>&1) || { echo "$drill_out" >&2; fail "the restic backup or its drill failed"; }
  echo "$drill_out" | tail -n 8
  docker exec "$db" psql -U postgres -qc "DROP DATABASE kept_drill" >/dev/null
fi

step "second boot on the same volumes"
docker stop -t 20 "$app" >/dev/null
docker rm "$app" >/dev/null
start_app
second_hash=$(docker exec "$app" sha256sum /config/secrets.json | cut -d' ' -f1)
[[ $second_hash == "$first_hash" ]] || fail "secrets.json changed on the second boot"
logs=$(docker logs "$app" 2>&1)
if grep -q 'generated KEPT_SECRET_KEY' <<<"$logs"; then
  fail "second boot generated new keys"
fi
echo "second boot reused secrets.json; no new keys"
if grep -q 'KEPT SETUP CODE' <<<"$logs"; then
  fail "second boot printed a new setup code"
fi
echo "second boot printed no setup code"

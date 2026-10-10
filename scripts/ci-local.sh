#!/usr/bin/env bash
# Kept's CI gate (engineering spec §7.12; D151, D173, D187). This script IS the gate; the hosted
# `ci` workflow runs only its --fast half and the checks a runner can do without a database.
# Every step gates on its exit code, never on a printed summary (L89), and the run stops at the
# first failure.
#
# Usage:
#   bash scripts/ci-local.sh                  every step
#   bash scripts/ci-local.sh --fast           lint, typecheck, unit, the extraction eval (no
#                                             Docker, no database)
#   bash scripts/ci-local.sh --from <step>    start at <step>; earlier steps are not run
#   bash scripts/ci-local.sh --only a,b,c     only these steps, in this order (the GitHub jobs in
#                                             .github/workflows/ci.yml each run a slice this way)
#   bash scripts/ci-local.sh --list           print the step names
#
# Steps: install lint catalogues typecheck compose test drift licences attribution docs helm
# prod-boot eval portability backup perf e2e images release-dry-run
# (`pnpm lint` already runs scripts/check-logical-css.mjs and scripts/check-i18n.mjs, the web
# catalogues holding every source message, through Lingui's API in memory. `catalogues` runs the
# real `lingui extract` CLI into a scratch copy and fails on a new msgid or an empty translation:
# the step-1 carry-over "catalogue extraction has no gate".)
#
# `eval` runs the extraction, assistant and search evaluations on the mock provider (the
# committed synthetic set, the `households` seed), always; a real extraction run only when
# KEPT_EVAL_DIR is set, outside CI (KEPT_EVAL_ARGS: its options,
# e.g. `--provider groq --model qwen/qwen3.8-27b`; the key from KEPT_EVAL_API_KEY, as
# apps/server/eval/README.md says). `perf` runs the snapshot bench at 10,000 things and
# apps/server/test/perf (a 50-op sync batch, the inbox at 500 open items); run it on a quiet
# machine, its numbers are meaningless under load.
#
# `portability` (step 7) runs the export → import round trip, the export's byte search for
# another tenant and the hostile archives on their own; `backup` (step 8) runs the snapshot →
# restore round trip, the readable copy and the restic contract, on the in-memory fake restic
# unless KEPT_TEST_RESTIC=1 (then the real binary: KEPT_RESTIC_BIN, else `restic` on PATH; the
# image pins 0.19.1). Both are also in `test`; their own steps say which half of the gate failed.
#
# Under load (other test runs on the same machine and Postgres), KEPT_TEST_WORKERS=<n> caps
# vitest's workers for `test` and `unit` (vitest.config.ts).
#
# Docker: DOCKER_CONFIG defaults to /tmp/kept-docker-config, a copy of ~/.docker without the
# Docker Desktop credential helper (`credsStore: desktop`), which can hang or fail when no
# desktop session is attached. The copy is made on first use; set DOCKER_CONFIG to override.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"

ALL_STEPS=(install lint catalogues typecheck compose test drift licences attribution docs helm prod-boot eval portability backup perf e2e e2e-update images release-dry-run)
FAST_STEPS=(lint catalogues typecheck unit eval)

DEV_COMPOSE=(docker compose -f compose.dev.yaml)
SUPERUSER_PSQL=("${DEV_COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt)
DEV_DB_HOST=localhost:5452
BOOT_PORT=8080 # main.ts listens on 8080 (plan, task 16)
BOOT_TIMEOUT=20 # seconds to /readyz 200 (L90)

# The header comment above, whatever its length.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

mode=all
from=
only=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) mode=fast ;;
    --from)
      [[ $# -ge 2 ]] || { echo "ci-local: --from needs a step name" >&2; exit 2; }
      from=$2
      shift
      ;;
    --only)
      [[ $# -ge 2 ]] || { echo "ci-local: --only needs a comma-separated list of steps" >&2; exit 2; }
      only=$2
      shift
      ;;
    --list) printf '%s\n' "${ALL_STEPS[@]}"; exit 0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "ci-local: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ $mode == fast ]]; then steps=("${FAST_STEPS[@]}"); else steps=("${ALL_STEPS[@]}"); fi
if [[ -n $only ]]; then
  [[ -z $from ]] || { echo "ci-local: --only and --from don't combine" >&2; exit 2; }
  IFS=, read -ra wanted <<<"$only"
  for w in "${wanted[@]}"; do
    [[ " ${ALL_STEPS[*]} unit " == *" $w "* ]] || {
      echo "ci-local: no step '$w'; steps: ${ALL_STEPS[*]} unit" >&2
      exit 2
    }
  done
  steps=("${wanted[@]}")
  mode=only
fi
if [[ -n $from ]]; then
  found=
  for i in "${!steps[@]}"; do
    if [[ ${steps[$i]} == "$from" ]]; then found=$i; break; fi
  done
  if [[ -z $found ]]; then
    echo "ci-local: no step '$from' in this mode; steps: ${steps[*]}" >&2
    exit 2
  fi
  steps=("${steps[@]:$found}")
fi

# ---------------------------------------------------------------------------------------------
# Environment

if [[ -d /opt/homebrew/opt/node@24/bin ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi
if [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  echo "ci-local: Node 24 is required; found $(node -v)" >&2
  exit 1
fi

ensure_docker_config() {
  if [[ -n ${DOCKER_CONFIG:-} ]]; then return; fi
  # A CI runner has no Docker Desktop credential helper: its own config is the right one.
  if [[ -n ${CI:-} ]]; then return; fi
  export DOCKER_CONFIG=/tmp/kept-docker-config
  if [[ -f $DOCKER_CONFIG/config.json ]]; then return; fi
  echo "ci-local: creating $DOCKER_CONFIG (~/.docker without credsStore)"
  mkdir -p "$DOCKER_CONFIG"
  local src="$HOME/.docker"
  for d in cli-plugins contexts; do
    [[ -e $src/$d ]] && ln -sfn "$src/$d" "$DOCKER_CONFIG/$d"
  done
  if [[ -f $src/config.json ]]; then
    node -e '
      const fs = require("node:fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      delete c.credsStore;
      fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 2));
    ' "$src/config.json" "$DOCKER_CONFIG/config.json"
  else
    echo '{}' >"$DOCKER_CONFIG/config.json"
  fi
}

# What a step creates (scratch databases, temp dirs, a server process) is registered in
# cleanup_cmds and undone when that step's subshell exits, pass or fail.
cleanup_cmds=()
on_exit() {
  local i
  for ((i = ${#cleanup_cmds[@]} - 1; i >= 0; i--)); do
    eval "${cleanup_cmds[$i]}" >/dev/null 2>&1 || true
  done
}

# A step that can't run yet calls `skip "<why>"` and returns 0; the runner reports SKIPPED
# loudly. Exit codes are never overloaded to mean "skipped".
skip_marker=$(mktemp "${TMPDIR:-/tmp}/kept-ci-skip.XXXXXX")
trap 'rm -f "$skip_marker"' EXIT
trap 'exit 130' INT TERM
skip() {
  printf '\033[33mSKIPPED (%s)\033[0m\n' "$1"
  echo "$1" >"$skip_marker"
}

# ---------------------------------------------------------------------------------------------
# Steps. Each runs in a subshell with errexit on, so any failing command fails the step.

step_install() { pnpm install --frozen-lockfile; }

step_lint() { pnpm lint; }

# Step 3 (T32): `lingui extract` into a scratch copy of the catalogues; a new msgid, or an empty
# translation in ar, fr, de or it, fails (scripts/check-i18n-extract.mjs).
step_catalogues() { node scripts/check-i18n-extract.mjs; }

step_typecheck() { pnpm typecheck; }

# Every vitest project except the server's, whose global setup needs the dev database.
step_unit() { pnpm exec vitest run --project '!@kept/server'; }

# The `s3` profile adds RustFS on 9452 for the S3 driver's tests (T18).
step_compose() {
  ensure_docker_config
  "${DEV_COMPOSE[@]}" --profile s3 up -d --wait
}

# The server's tests on Postgres with pgvector and RustFS (the fast job's unit step covers
# every other project, so this one doesn't repeat them). CI_VITEST_SHARD=k/n runs one slice
# (CI's db-test matrix); locally the whole suite.
step_test() {
  if [[ -n ${CI_VITEST_SHARD:-} ]]; then
    KEPT_TEST_S3_URL=http://localhost:9452 pnpm test --project @kept/server --shard "$CI_VITEST_SHARD"
  else
    KEPT_TEST_S3_URL=http://localhost:9452 pnpm test --project @kept/server
  fi
}

# drizzle-kit generate must find nothing to write, into a copy of the migrations, and
# drizzle-kit check must pass. The copy lives under .tmp/ (gitignored) and is relative to
# apps/server, because drizzle-kit 0.31.11 prefixes `out` with './' and so can't take an
# absolute path. It also exits 0 on some errors (observed: ENOENT on the snapshot folder), so
# besides the exit code and the diff, the step requires drizzle-kit's own no-change line.
step_drift() {
  local server="$repo/apps/server"
  mkdir -p "$repo/.tmp"
  local tmp
  tmp=$(mktemp -d "$repo/.tmp/ci-drift.XXXXXX")
  cleanup_cmds+=("rm -rf '$tmp'")
  local rel="../../.tmp/$(basename "$tmp")"
  cp -R "$server/migrations" "$tmp/migrations"
  cat >"$tmp/drizzle.config.ts" <<EOF
// Generated by scripts/ci-local.sh: the real config, writing into a scratch copy.
import base from '$server/drizzle.config.ts';
export default { ...base, out: '$rel/migrations' };
EOF
  local out
  out=$(cd "$server" && pnpm exec drizzle-kit generate --config "$tmp/drizzle.config.ts" 2>&1) || {
    echo "$out"
    return 1
  }
  echo "$out" | tail -n 3
  if ! diff -r "$server/migrations" "$tmp/migrations"; then
    echo "drift: the schema differs from the migrations; run drizzle-kit generate and commit it" >&2
    return 1
  fi
  if ! grep -q 'No schema changes' <<<"$out"; then
    echo "drift: drizzle-kit generate did not confirm 'No schema changes' (see output above)" >&2
    return 1
  fi
  (cd "$server" && pnpm exec drizzle-kit check --config "$tmp/drizzle.config.ts")
}

step_licences() { node scripts/check-licences.mjs; }

step_attribution() {
  local range
  if git rev-parse --verify -q origin/main >/dev/null; then
    range=origin/main..HEAD
  else
    range=HEAD
    echo "attribution: no origin/main; checking the whole history"
  fi
  echo "attribution: $(git rev-list --count "$range") commit(s) in $range"
  bash scripts/check-attribution.sh --range "$range"
}

# The docs site (step 8 T18; D102, D199): the configuration reference page must match what the
# env schema renders now, then `pnpm docs:build` writes the OpenAPI document from buildApp() (no
# database) and builds every locale, and starlight-links-validator fails the build on a broken
# link. ASTRO_TELEMETRY_DISABLED (set by the package scripts) keeps the build off the network.
step_docs() {
  pnpm --filter @kept/docs check:config
  pnpm docs:build
  if [[ ! -f apps/docs/dist/index.html || ! -f apps/docs/dist/ar/index.html ]]; then
    echo "docs: the build wrote no English or Arabic landing page" >&2
    return 1
  fi
}

# The Helm chart (step 8 T16): lint, golden renders of charts/kept/ci/*.values.yaml, kubeconform
# -strict at Kubernetes 1.37.0 with commit-pinned schemas, image pins and the chart's refusals
# (scripts/check-helm.sh). Skipped, loudly, without the pinned Helm and kubeconform; `bash
# scripts/tools.sh fetch helm kubeconform` installs them. KEPT_HELM_KIND=1 adds the kind smoke.
step_helm() {
  local t
  for t in helm kubeconform; do
    if ! bash scripts/tools.sh path "$t" >/dev/null; then
      skip "$t not found at its pinned version: bash scripts/tools.sh fetch helm kubeconform"
      return 0
    fi
  done
  bash scripts/check-helm.sh
}

# Builds @kept/shared and the server, migrates a fresh scratch database, then starts dist/main.js
# the way production does (NODE_ENV=production, OTel at a dead collector, L90) and requires
# /readyz 200 within BOOT_TIMEOUT seconds. A process that exits first fails the step, with its log.
# Step 4 (T30, Q11): the web makes web push's VAPID pair at boot, a second boot keeps it, and the
# private key (opened from the database as the server opens it) appears in neither boot's log.
#
# In the workspace @kept/shared exports its TypeScript source by default (tsx, vitest, vite and
# drizzle-kit read it); its `kept-dist` export condition points at the compiled dist/ instead, and
# node only takes it when asked: `node --conditions=kept-dist`. The image needs no flag: its build
# applies the package's publishConfig, so there dist/ is the only export (Dockerfile).
step_prod-boot() {
  ensure_docker_config
  if lsof -nP -iTCP:$BOOT_PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "prod-boot: port $BOOT_PORT is already in use; its /readyz would not be ours" >&2
    lsof -nP -iTCP:$BOOT_PORT -sTCP:LISTEN >&2 || true
    return 1
  fi

  # `@kept/server...` = the server and its workspace dependencies (@kept/shared), in order.
  pnpm --filter '@kept/server...' build

  local db
  db="kept_ci_boot_$(date +%s)_$$"
  "${SUPERUSER_PSQL[@]}" -c "CREATE DATABASE $db OWNER kept_owner"
  cleanup_cmds+=("${SUPERUSER_PSQL[*]} -c 'DROP DATABASE IF EXISTS $db WITH (FORCE)'")
  KEPT_OWNER_DATABASE_URL="postgres://kept_owner:kept_owner@$DEV_DB_HOST/$db" \
    node --conditions=kept-dist apps/server/dist/cli/index.js migrate

  local tmp source_url
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/kept-ci-boot.XXXXXX")
  cleanup_cmds+=("rm -rf '$tmp'")
  mkdir -p "$tmp/config" "$tmp/data"
  source_url=$(git remote get-url origin 2>/dev/null || true)
  source_url=${source_url%.git}
  if [[ $source_url != http* ]]; then
    echo "prod-boot: origin is not an https URL ('$source_url'); set a real one" >&2
    return 1
  fi

  # A clean environment: nothing from the developer's shell (KEPT_*, NODE_OPTIONS) leaks in.
  # "${clean_env[@]}" NAME=value… <command> runs a command in it.
  # Step 4 (T30, Q11): KEPT_VAPID_SUBJECT gives push a subject (the public URL is plain http),
  # so the web makes web push's VAPID pair at boot.
  local clean_env=(
    env -i PATH="$PATH" HOME="$HOME" TZ=UTC
    NODE_ENV=production
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9
    KEPT_DATABASE_URL="postgres://kept_app:kept_app@$DEV_DB_HOST/$db"
    KEPT_AUTH_DATABASE_URL="postgres://kept_auth:kept_auth@$DEV_DB_HOST/$db"
    KEPT_SYSTEM_DATABASE_URL="postgres://kept_system:kept_system@$DEV_DB_HOST/$db"
    KEPT_PUBLIC_URL="http://localhost:$BOOT_PORT"
    KEPT_SOURCE_URL="$source_url"
    KEPT_CONFIG_DIR="$tmp/config"
    KEPT_DATA_DIR="$tmp/data"
    KEPT_VAPID_SUBJECT=mailto:ci@kept.invalid
  )
  local main=(node --conditions=kept-dist apps/server/dist/main.js)

  # Step 3 (T2, T32): the mock AI provider is refused in production. The same boot with
  # KEPT_AI_MOCK=1 must exit non-zero, naming the variable, before anything listens.
  local mock_rc=0
  "${clean_env[@]}" KEPT_AI_MOCK=1 "${main[@]}" >"$tmp/mock.log" 2>&1 || mock_rc=$?
  if [[ $mock_rc == 0 ]] || ! grep -q 'KEPT_AI_MOCK=1 is for tests and development' "$tmp/mock.log"; then
    echo "prod-boot: NODE_ENV=production with KEPT_AI_MOCK=1 was not refused (exit $mock_rc)" >&2
    tail -n 20 "$tmp/mock.log" >&2
    return 1
  fi
  echo "prod-boot: KEPT_AI_MOCK=1 refused in production (exit $mock_rc), as it must be"

  # Starts dist/main.js with its log in $1 and waits for /readyz 200, then stops it. A process
  # that exits first, or a /readyz that never answers 200, fails the step with the log.
  # `exec` makes the background subshell the server itself, so $! is the server's pid and the
  # kill below stops it (a backgrounded function would leave the server running, orphaned,
  # holding the port: T30 found two such, from earlier runs).
  boot_until_ready() {
    local log=$1
    (exec "${clean_env[@]}" "${main[@]}") >"$log" 2>&1 &
    local pid=$!
    cleanup_cmds+=("kill $pid; sleep 1; kill -9 $pid")
    local deadline=$((SECONDS + BOOT_TIMEOUT)) code=000
    while ((SECONDS < deadline)); do
      if ! kill -0 "$pid" 2>/dev/null; then
        local rc=0
        wait "$pid" || rc=$?
        echo "prod-boot: dist/main.js exited (code $rc) before /readyz answered." >&2
        echo "--- server log ---" >&2
        tail -n 40 "$log" >&2
        return 1
      fi
      code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$BOOT_PORT/readyz" || true)
      if [[ $code == 200 ]]; then
        echo "prod-boot: /readyz 200 after $((BOOT_TIMEOUT - (deadline - SECONDS)))s"
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        return 0
      fi
      sleep 0.5
    done
    echo "prod-boot: /readyz did not return 200 within ${BOOT_TIMEOUT}s (last: $code)" >&2
    echo "--- server log ---" >&2
    tail -n 40 "$log" >&2
    return 1
  }

  # The stored VAPID public key, or nothing.
  vapid_public() {
    "${DEV_COMPOSE[@]}" exec -T db psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -qAt \
      -c "SELECT value->>'publicKey' FROM public.instance_settings WHERE key = 'vapid'"
  }

  boot_until_ready "$tmp/server.log"

  # Step 4 (T30, Q11): the web made the VAPID pair at boot; a second boot keeps it (generated
  # once); and the private key, opened from the database as the server opens it, is in neither
  # boot's log. It is written to a file in the step's temp dir, never printed.
  local first second
  first=$(vapid_public)
  if [[ -z $first ]]; then
    echo "prod-boot: the web did not make a VAPID pair at boot (no instance_settings 'vapid')" >&2
    tail -n 40 "$tmp/server.log" >&2
    return 1
  fi
  boot_until_ready "$tmp/server-2.log"
  second=$(vapid_public)
  if [[ $second != "$first" ]]; then
    echo "prod-boot: the second boot replaced the VAPID pair; it must be generated once" >&2
    return 1
  fi
  "${clean_env[@]}" node --conditions=kept-dist --input-type=module -e '
    import { createRequire } from "node:module";
    import { writeFileSync } from "node:fs";
    const pg = createRequire(process.cwd() + "/apps/server/package.json")("pg");
    const { loadEnv } = await import(process.cwd() + "/apps/server/dist/config/env.js");
    const { secretKeysOf } = await import(process.cwd() + "/apps/server/dist/crypto/keyring.js");
    const { ensureVapidKeys } = await import(process.cwd() + "/apps/server/dist/notify/vapid.js");
    const env = await loadEnv(process.env, { logger: () => {} });
    const keys = secretKeysOf(env);
    const pool = new pg.Pool({ connectionString: env.KEPT_SYSTEM_DATABASE_URL, max: 1 });
    try {
      const pair = await ensureVapidKeys(pool, env, () => keys.get());
      writeFileSync(process.argv[1], pair.privateKey, { mode: 0o600 });
    } finally {
      await pool.end();
    }
  ' "$tmp/vapid.key"
  if [[ ! -s $tmp/vapid.key ]]; then
    echo "prod-boot: could not open the stored VAPID private key" >&2
    return 1
  fi
  if grep -qF -f "$tmp/vapid.key" "$tmp/server.log" "$tmp/server-2.log"; then
    echo "prod-boot: the VAPID private key appears in the server log" >&2
    return 1
  fi
  if [[ $(vapid_public) != "$first" ]]; then
    echo "prod-boot: opening the stored VAPID pair replaced it" >&2
    return 1
  fi
  echo "prod-boot: the VAPID pair was made once at boot, kept by a second boot, and never logged"
}

# The evaluations on the mock provider, always, and no report written (a real provider is the
# maintainer's run, never CI's):
# - extraction (step-3 T11, T32): the committed synthetic set (apps/server/test/fixtures/eval and
#   its mock answers). A run that skips (no folder) or sends nothing fails: exit 0 alone could be
#   a skip (L89). A real provider runs only with KEPT_EVAL_DIR set and never in CI; its report
#   goes to .tmp/evals.
# - assistant (step-6 T17): every case through the real loop on a scratch `households` database;
#   on the mock any failed case exits 1, and the step also requires its "N/N passed" line.
# - search (step-6 T17, T14): keyword and meaning-fused recall@10 and MRR on the same seed. The
#   runner exits 0 whatever the numbers, so the step requires both lines over at least one query,
#   and meaning fused in never finding less than keywords alone on the mock's concept embedder.
step_eval() {
  local out
  out=$(pnpm eval:extraction --dir apps/server/test/fixtures/eval --no-report 2>&1) || {
    echo "$out"
    return 1
  }
  echo "$out" | tail -n 12
  if grep -q '^skipped' <<<"$out" || ! grep -Eq '^[1-9][0-9]* request\(s\) sent' <<<"$out"; then
    echo "eval: the mock run sent no request (see above)" >&2
    return 1
  fi
  if [[ -n ${KEPT_EVAL_DIR:-} && -z ${CI:-} ]]; then
    echo "eval: KEPT_EVAL_DIR is set: the real run, ${KEPT_EVAL_ARGS:-(the mock; set KEPT_EVAL_ARGS)}"
    # shellcheck disable=SC2086 # KEPT_EVAL_ARGS is a list of options, split on purpose
    pnpm eval:extraction --dir "$KEPT_EVAL_DIR" --out .tmp/evals ${KEPT_EVAL_ARGS:-}
  fi
  # --fast runs without the database; the assistant and search evaluations need its scratch
  # databases, so only the full gate runs them.
  if [[ $mode == fast ]]; then
    echo "eval: --fast: the assistant and search evaluations run in the full gate only"
    return 0
  fi

  out=$(pnpm eval:assistant --no-report 2>&1) || {
    echo "$out"
    return 1
  }
  echo "$out" | tail -n 1
  local n m
  read -r n m < <(grep -Eo '^[0-9]+/[0-9]+ passed' <<<"$out" | tail -n 1 | tr '/' ' ' | awk '{ print $1, $2 }') || true
  if [[ -z ${n:-} || $n == 0 || $n != "${m:-}" ]]; then
    echo "eval: the assistant evaluation did not pass every case (${n:-?}/${m:-?})" >&2
    return 1
  fi

  out=$(pnpm eval:search --no-report 2>&1) || {
    echo "$out"
    return 1
  }
  local keyword provider
  keyword=$(grep -E '^keyword: recall@10 [0-9.]+, MRR [0-9.]+ over [1-9][0-9]* queries' <<<"$out" || true)
  provider=$(grep -E '^provider: recall@10 [0-9.]+, MRR [0-9.]+ over [1-9][0-9]* queries' <<<"$out" || true)
  if [[ -z $keyword || -z $provider ]]; then
    echo "$out" | tail -n 5
    echo "eval: the search evaluation printed no keyword or provider result over any query" >&2
    return 1
  fi
  printf '%s\n%s\n' "$keyword" "$provider"
  local k p
  k=$(awk '{ print $3 }' <<<"$keyword" | tr -d ,)
  p=$(awk '{ print $3 }' <<<"$provider" | tr -d ,)
  if ! awk -v k="$k" -v p="$p" 'BEGIN { exit !(p >= k) }'; then
    echo "eval: meaning fused in found less than keywords alone (recall@10 $p < $k)" >&2
    return 1
  fi
}

# Step 7's portability (plan's definition of done 1): the Kept export → import round trip (on the
# same server and on another), the export's byte search for another tenant's values, and the
# hostile archives (size ratio, upload cap, nested, encrypted and oversized entries) through the
# zip reader, the archive import and the Kept import. KEPT_TEST_S3_URL, as in `test`: the zip
# reader's S3 half fails, not skips, when RustFS isn't answering.
step_portability() {
  (cd apps/server && KEPT_TEST_S3_URL=http://localhost:9452 pnpm exec vitest run \
    test/portability/round-trip.test.ts \
    src/exports/exports.test.ts \
    src/portability/zip/zip.test.ts \
    src/imports/archive.test.ts \
    src/imports/kept/kept-import.test.ts)
}

# Step 8's backups (plan's definition of done 1): snapshot → restore into an empty database and
# file store with equal data digests, the drill and verify (test/backup/round-trip.test.ts), the
# nightly snapshot and the readable copy in it, and the Restic contract. On the in-memory fake
# restic unless KEPT_TEST_RESTIC=1, which runs the same files against the real binary
# (KEPT_RESTIC_BIN, else `restic` on PATH) and fails when there is none.
step_backup() {
  if [[ ${KEPT_TEST_RESTIC:-} == 1 ]]; then
    local bin=${KEPT_RESTIC_BIN:-restic}
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "backup: KEPT_TEST_RESTIC=1 but there is no restic at '$bin' (set KEPT_RESTIC_BIN)" >&2
      return 1
    fi
    echo "backup: the real restic: $("$bin" version)"
  else
    echo "backup: the in-memory fake restic; KEPT_TEST_RESTIC=1 runs the real binary"
  fi
  (cd apps/server && pnpm exec vitest run \
    test/backup/round-trip.test.ts \
    src/backup/backup.test.ts \
    src/backup/readable/readable.test.ts \
    src/backup/restic/restic.contract.test.ts)
}

# Step 3's performance checks (plan T32; §3.1): the offline snapshot of 10,000 things, every
# page, through the RLS bench (its own scratch database; exits 1 over budget), then
# apps/server/test/perf (a 50-op sync batch's p95, the inbox's first page at 500 open items).
# Results: .tmp/perf/. Numbers taken under load are not evidence; run it on a quiet machine.
step_perf() {
  mkdir -p "$repo/.tmp/perf"
  pnpm --filter @kept/server bench -- --snapshot-only --out "$repo/.tmp/perf/snapshot-bench.json"
  (cd apps/server && pnpm exec vitest run --config vitest.perf.config.ts)
}

# Whether the e2e run uses the installed Google Chrome: outside CI, and where Playwright's `chrome`
# channel finds it (the same check as apps/web/playwright.config.ts).
uses_installed_chrome() {
  [[ -z ${CI:-} ]] || return 1
  case "$(uname -s)" in
    Darwin) [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] ;;
    Linux) [[ -x /opt/google/chrome/chrome ]] ;;
    *) return 1 ;;
  esac
}

# Playwright against the real server (task 28; apps/web/playwright.config.ts): builds the server
# (with @kept/shared) and the web bundle, installs Playwright's Chromium only when the installed
# Google Chrome isn't used (a no-op once installed), then runs the suite. apps/web/e2e/serve.mjs
# starts one server per instance on its own scratch database on the dev Postgres (ports
# 8181-8187) and drops it afterwards.
#
# Step 3 (T32): Chromium runs with the fake camera (playwright.config.ts passes e2e/camera.ts's
# fakeCameraArgs(): `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
# --use-file-for-fake-video-capture=<y4m>`, the y4m files in apps/web/e2e/fixtures, generated by
# e2e/fixtures/make-y4m.mjs), and step3.spec.ts runs on its own `households` instance with
# KEPT_AI_MOCK=1. The update-prompt flow (e2e/step3-update.spec.ts) edits the served dist/sw.js
# to make a second release, so it runs after the rest, alone, with KEPT_E2E_UPDATE=1 and only
# the capture instance started.
#
# Step 4 (T30): e2e/step4.spec.ts runs on its own seeded `household` instance. Every instance runs
# with KEPT_ROLE=all, so its worker runs the reminder scan, the digest and the claim-pack job; the
# spec also runs one scan pass itself rather than waiting up to 15 minutes for the schedule.
step_e2e() {
  local config=apps/web/playwright.config.ts
  if [[ ! -f $config ]]; then
    echo "e2e: $config is missing" >&2
    return 1
  fi
  pnpm --filter '@kept/server...' build
  pnpm --filter @kept/web build
  if uses_installed_chrome; then
    echo "e2e: using the installed Google Chrome"
  else
    # A fresh CI runner also needs Chromium's system libraries (--with-deps uses apt).
    if [[ -n ${CI:-} && $(uname -s) == Linux ]]; then
      pnpm --filter @kept/web exec playwright install --with-deps chromium
    else
      pnpm --filter @kept/web exec playwright install chromium
    fi
  fi
  local y4m
  for y4m in camera-qr camera-thing; do
    if [[ ! -s apps/web/e2e/fixtures/$y4m.y4m ]]; then
      echo "e2e: apps/web/e2e/fixtures/$y4m.y4m is missing: node apps/web/e2e/fixtures/make-y4m.mjs" >&2
      return 1
    fi
  done
  # The flags live in e2e/camera.ts (fakeCameraArgs, b04f4cf); the config must pass them on.
  grep -q -- '--use-file-for-fake-video-capture' apps/web/e2e/camera.ts || {
    echo "e2e: apps/web/e2e/camera.ts has no fake camera flags" >&2
    return 1
  }
  grep -q 'args: fakeCameraArgs()' apps/web/playwright.config.ts || {
    echo "e2e: playwright.config.ts doesn't launch Chromium with fakeCameraArgs()" >&2
    return 1
  }
  # On CI each matrix shard runs a slice (CI_E2E_SHARD=k/n); locally the whole suite.
  if [[ -n ${CI_E2E_SHARD:-} ]]; then
    pnpm --filter @kept/web exec playwright test --shard "$CI_E2E_SHARD"
  else
    pnpm --filter @kept/web exec playwright test
    KEPT_E2E_UPDATE=1 KEPT_E2E_INSTANCES=capture \
      pnpm --filter @kept/web exec playwright test step3-update.spec.ts --project phone
  fi
}

# The step-3 update migration spec on its own (CI's e2e-update job; the sharded e2e job skips
# it, so it runs exactly once). Same build the e2e job uses.
step_e2e-update() {
  pnpm --filter '@kept/server...' build
  pnpm --filter @kept/web build
  if uses_installed_chrome; then
    echo "e2e: using the installed Google Chrome"
  else
    # A fresh CI runner also needs Chromium's system libraries (--with-deps uses apt).
    if [[ -n ${CI:-} && $(uname -s) == Linux ]]; then
      pnpm --filter @kept/web exec playwright install --with-deps chromium
    else
      pnpm --filter @kept/web exec playwright install chromium
    fi
  fi
  KEPT_E2E_UPDATE=1 KEPT_E2E_INSTANCES=capture \
    pnpm --filter @kept/web exec playwright test step3-update.spec.ts --project phone
}

# SKIPPED until task 29 adds the Dockerfile. Once it exists, both
# platforms must build, and the natively built arm64 image must pass scripts/smoke-image.sh
# (L103); a Dockerfile without that script fails rather than passing unsmoked.
step_images() {
  if [[ ! -f Dockerfile ]]; then
    skip "not built yet: task 29: no Dockerfile"
    return 0
  fi
  ensure_docker_config
  local revision
  revision=$(git rev-parse HEAD)
  # On GitHub each architecture has its own native runner (ci.yml's images-amd64 and
  # images-arm64): build and smoke in full the runner's own platform, with no emulation.
  if [[ -n ${CI:-} ]]; then
    docker buildx build --build-arg "REVISION=$revision" -t kept:ci --load .
    bash scripts/smoke-image.sh kept:ci
    return 0
  fi
  docker buildx build --platform linux/amd64 --build-arg "REVISION=$revision" -t kept:ci-amd64 .
  docker buildx build --platform linux/arm64 --build-arg "REVISION=$revision" -t kept:ci-arm64 --load .
  if [[ ! -f scripts/smoke-image.sh ]]; then
    echo "images: scripts/smoke-image.sh is missing; the arm64 image is built but unsmoked" >&2
    return 1
  fi
  bash scripts/smoke-image.sh kept:ci-arm64
}

# The laptop release's dry run (step 8 T17): scripts/release.sh --dry-run builds both platforms
# from HEAD, pushes by digest to a throwaway local registry, smokes both, signs with a throwaway
# key, tags, publishes and signs the chart, and must end with a verified signature and no
# container left behind. Slow (a multi-arch build), so it runs only with KEPT_RELEASE_DRY_RUN=1.
step_release-dry-run() {
  if [[ ${KEPT_RELEASE_DRY_RUN:-} != 1 ]]; then
    skip "opt-in: KEPT_RELEASE_DRY_RUN=1 runs the release dry run"
    return 0
  fi
  ensure_docker_config
  local version log
  version=${KEPT_RELEASE_DRY_RUN_VERSION:-$(node scripts/release/version.mjs dry-run $(git tag -l 'v*'))}
  mkdir -p "$repo/.tmp/release"
  log=$repo/.tmp/release/ci-dry-run.log
  bash scripts/release.sh "$version" --dry-run 2>&1 | tee "$log"
  grep -q "the signature on .*:$version verifies" "$log" || {
    echo "release-dry-run: no verified signature at the end" >&2
    return 1
  }
  local left
  left=$(docker ps -aq --filter name=kept-release-dry)
  if [[ -n $left ]]; then
    echo "release-dry-run: containers left behind: $left" >&2
    return 1
  fi
  echo "release-dry-run: signed in the throwaway registry, nothing left behind"
}

# ---------------------------------------------------------------------------------------------
# Runner

results=()
skipped=0
run_step() {
  local name=$1 start rc
  start=$SECONDS
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  : >"$skip_marker"
  set +e
  (
    set -euo pipefail
    cleanup_cmds=()
    trap on_exit EXIT
    "step_$name"
  )
  rc=$?
  set -e
  local took=$((SECONDS - start))
  if [[ $rc == 0 && -s $skip_marker ]]; then
    printf '\033[33m<== %s: SKIPPED (%s)\033[0m\n' "$name" "$(cat "$skip_marker")"
    results+=("SKIPPED  ${took}s  $name  ($(cat "$skip_marker"))")
    skipped=$((skipped + 1))
  elif [[ $rc == 0 ]]; then
    printf '\033[32m<== %s: ok (%ss)\033[0m\n' "$name" "$took"
    results+=("ok       ${took}s  $name")
  else
    printf '\033[31m<== %s: FAILED with exit %s (%ss)\033[0m\n' "$name" "$rc" "$took"
    results+=("FAILED   ${took}s  $name")
    summary
    exit "$rc"
  fi
}

summary() {
  printf '\n\033[1mci-local summary (%s)\033[0m\n' "$mode${from:+, from $from}${only:+: $only}"
  printf '  %s\n' "${results[@]}"
}

total_start=$SECONDS
for step in "${steps[@]}"; do
  run_step "$step"
done
summary
echo "  total $((SECONDS - total_start))s"
if ((skipped > 0)); then
  printf '\033[33m  %s step(s) SKIPPED: this run passed, but it is not the full gate yet.\033[0m\n' "$skipped"
fi

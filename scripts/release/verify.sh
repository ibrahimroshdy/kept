# shellcheck shell=bash
# Stage 4 of scripts/release.sh (sourced): pull each architecture in $smoke_arches by digest and
# smoke it with the commit's own scripts/smoke-image.sh (L103), and check that /version reports
# this version and commit (L100). Nothing is tagged yet. On the laptop both run here (arm64
# natively, amd64 under emulation); in the workflow each build job smokes its own architecture
# natively (--arch). The smoke runs with SMOKE_SCOPE=release: the restic drill and the second
# boot are ci-local's (its `images` step), before the tag.
# release_notices takes the third-party notices file out of the image for the GitHub release.

release_verify() {
  say "4. smoke ${smoke_arches// / + } by digest"
  local arch digest ref log line got_version got_revision smoke=$work/src/scripts/smoke-image.sh
  # A dry run may smoke with another script (KEPT_RELEASE_SMOKE_SCRIPT) while the commit's own is
  # out of step with its image; a real release always uses the commit's own.
  if [[ -n ${KEPT_RELEASE_SMOKE_SCRIPT:-} ]]; then
    [[ -n $dry ]] || die "KEPT_RELEASE_SMOKE_SCRIPT is for dry runs only: a release smokes with the commit's own script"
    # In the export's scripts/, so it finds the commit's docker/initdb-prod beside it.
    cp "$KEPT_RELEASE_SMOKE_SCRIPT" "$smoke"
    warn "smoking with $KEPT_RELEASE_SMOKE_SCRIPT instead of the commit's scripts/smoke-image.sh"
  fi
  # Until T15 makes the smoke's boot timeout overridable (spike R2), the exported copy honours it:
  # 60 s is too short for amd64 under emulation on a loaded laptop. The image is untouched.
  if grep -qx 'BOOT_TIMEOUT=60' "$smoke"; then
    sed -i.orig 's/^BOOT_TIMEOUT=60$/BOOT_TIMEOUT=${BOOT_TIMEOUT:-60}/' "$smoke"
  fi
  for arch in $smoke_arches; do
    digest=${arch}_digest
    digest=${!digest}
    ref=$registry@$digest
    docker pull --quiet --platform "linux/$arch" "$ref" >/dev/null
    cleanup_cmds+=("docker image rm '$ref'")
    log=$work/smoke-$arch.log
    note "smoke linux/$arch ($ref); log $log"
    SMOKE_SCOPE=release BOOT_TIMEOUT=${KEPT_RELEASE_BOOT_TIMEOUT:-300} bash "$smoke" "$ref" >"$log" 2>&1 || {
      tail -n 30 "$log" >&2
      die "the linux/$arch smoke failed"
    }
    # smoke-image.sh prints the answer as `/version: {…}`.
    line=$(sed -n 's/^\/version: //p' "$log" | head -n 1)
    [[ -n $line ]] || die "the linux/$arch smoke printed no /version line"
    got_version=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).version ?? ""))' "$line")
    got_revision=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).revision ?? ""))' "$line")
    [[ $got_version == "$version" ]] || die "linux/$arch /version says version '$got_version', expected '$version'"
    [[ $got_revision == "$commit" ]] || die "linux/$arch /version says revision '$got_revision', expected '$commit'"
    note "linux/$arch: smoke PASS; /version $got_version at ${got_revision:0:12}"
  done
}

# The linux/arm64 image's notices. Copied out of a created, never started, container, so it needs
# no emulation on an amd64 machine.
release_notices() {
  local ref=$registry@$arm64_digest cid=
  rm -f "$work/THIRD-PARTY-NOTICES.txt"
  if docker pull --quiet --platform linux/arm64 "$ref" >/dev/null 2>&1; then
    cleanup_cmds+=("docker image rm '$ref'")
    cid=$(docker create --platform linux/arm64 "$ref" 2>/dev/null) || cid=
  fi
  if [[ -n $cid ]]; then
    docker cp "$cid:/app/THIRD-PARTY-NOTICES.txt" "$work/THIRD-PARTY-NOTICES.txt" >/dev/null 2>&1 || true
    docker rm "$cid" >/dev/null 2>&1 || true
  fi
  if [[ -s $work/THIRD-PARTY-NOTICES.txt ]]; then
    note "THIRD-PARTY-NOTICES.txt taken from the image ($(wc -l <"$work/THIRD-PARTY-NOTICES.txt" | tr -d ' ') lines)"
  else
    rm -f "$work/THIRD-PARTY-NOTICES.txt"
    [[ -n $dry ]] || die "the image has no /app/THIRD-PARTY-NOTICES.txt (D151)"
    warn "the image has no /app/THIRD-PARTY-NOTICES.txt (D151); a real release refuses this"
  fi
}

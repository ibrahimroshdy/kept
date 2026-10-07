# shellcheck shell=bash
# Stages 5 and 6 of scripts/release.sh (sourced): cosign with a key (D187), and the tags.
#
# While the repository is private the signature goes in no transparency log (it would publish the
# image's name and digest, plan Q14): cosign 3 says that with an empty signing config, and
# verifiers pass --insecure-ignore-tlog (spike R2; `--tlog-upload=false` is refused by cosign 3).
# KEPT_RELEASE_TLOG=1 uses Sigstore's public services instead (cosign's default).
# An unsigned release (KEPT_RELEASE_UNSIGNED=1, `$unsigned` in release.sh) never calls the signing
# functions, and the tags are checked by digest only.

cosign_registry_flags() {
  [[ -n $http_registry ]] && echo --allow-http-registry
  return 0
}

release_sign_digest() { # <ref@digest> [--recursive]
  local ref=$1 flags=()
  shift
  [[ $ref == *@sha256:* ]] || die "signing needs a digest, not a tag: $ref"
  if [[ ${KEPT_RELEASE_TLOG:-} != 1 ]]; then
    [[ -f $work/no-tlog.json ]] || "$cosign" signing-config create --out "$work/no-tlog.json" >/dev/null
    flags+=(--signing-config "$work/no-tlog.json")
  fi
  note "signing $ref${1:+ ($1)}"
  # COSIGN_PASSWORD comes from the environment; cosign never prints it.
  "$cosign" sign --yes --key "$cosign_key" ${flags[@]+"${flags[@]}"} $(cosign_registry_flags) "$@" "$ref" \
    >"$work/sign.log" 2>&1 || {
    tail -n 20 "$work/sign.log" >&2
    die "cosign sign failed for $ref"
  }
  release_verify_signature "$ref"
  note "signed and verified: $ref"
}

release_verify_signature() { # <ref>
  local flags=()
  [[ ${KEPT_RELEASE_TLOG:-} == 1 ]] || flags+=(--insecure-ignore-tlog)
  "$cosign" verify --key "$cosign_pub" ${flags[@]+"${flags[@]}"} $(cosign_registry_flags) "$1" >"$work/verify.json" 2>"$work/verify.log" || {
    cat "$work/verify.log" >&2
    die "cosign verify failed for $1"
  }
}

release_tags() {
  image_tags=()
  local t got
  while IFS= read -r t; do image_tags+=("$t"); done < <(
    node scripts/release/version.mjs tags "$version" ${existing_tags[@]+"${existing_tags[@]}"}
  )
  say "6. tag ${image_tags[*]} from $index_digest (never latest)"
  local args=()
  for t in "${image_tags[@]}"; do args+=(-t "$registry:$t"); done
  docker buildx imagetools create ${it_builder[@]+"${it_builder[@]}"} "${args[@]}" "$registry@$index_digest" >"$work/tag.log" 2>&1 || {
    cat "$work/tag.log" >&2
    die "imagetools create failed"
  }
  for t in "${image_tags[@]}"; do
    got=$(docker buildx imagetools inspect ${it_builder[@]+"${it_builder[@]}"} --format '{{json .Manifest}}' "$registry:$t" |
      node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).digest ?? ""))')
    [[ $got == "$index_digest" ]] || die "$registry:$t points at $got, not $index_digest"
    if [[ -n ${unsigned:-} ]]; then
      note "$registry:$t → $index_digest (unsigned)"
    else
      release_verify_signature "$registry:$t"
      note "$registry:$t → $index_digest, signature verified"
    fi
  done
}

# shellcheck shell=bash
# Stage 8 of scripts/release.sh (sourced): docs/releases/X.Y.Z.md, what was published and how to
# check it. A dry run writes it to its work directory only. An unsigned release
# (KEPT_RELEASE_UNSIGNED=1) says so at the top and checks digests instead of signatures. Sets
# notes_file.

release_notes() {
  if [[ -n $dry ]]; then notes_file=$work/$version.md; else notes_file=$repo/docs/releases/$version.md; fi
  say "8. record $notes_file"
  mkdir -p "$(dirname "$notes_file")"
  local tlog_flag=" --insecure-ignore-tlog" t tag_lines= unsigned_note= verify_lines tlog_note=
  [[ ${KEPT_RELEASE_TLOG:-} == 1 ]] && tlog_flag=
  for t in "${image_tags[@]}"; do tag_lines+="- \`$registry:$t\`"$'\n'; done
  if [[ -n ${unsigned:-} ]]; then
    unsigned_note=$'\n'"**This release is unsigned.** It was published before Kept's signing key existed: the image and"$'\n'
    unsigned_note+="the chart carry no cosign signature, so \`cosign verify\` has nothing to check. Check the digests"$'\n'
    unsigned_note+="below instead. Signing starts before the repository goes public, and 1.0.0 is signed."$'\n'
    verify_lines="docker buildx imagetools inspect $registry:$version --format '{{json .Manifest}}'   # its \"digest\" is $index_digest"
  else
    verify_lines="cosign verify --key cosign.pub$tlog_flag $registry:$version"$'\n'
    verify_lines+="cosign verify --key cosign.pub$tlog_flag $chart_repo/kept@$chart_digest"
    [[ -z $tlog_flag ]] ||
      tlog_note=$'\n''`--insecure-ignore-tlog`: this release was signed without the public transparency log (the repository was private, plan Q14).'
  fi
  cat >"$notes_file.tmp" <<NOTES
# Kept $version

Built $(date -u +%Y-%m-%d) from commit \`$commit\` by \`scripts/release.sh\`$([[ -z $dry ]] || echo ' (a dry run, to a throwaway registry)')$([[ -z ${ci:-} ]] || echo " on GitHub Actions (${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-})").
$unsigned_note
## The image

\`$registry@$index_digest\`, for linux/amd64 and linux/arm64, each smoked by digest before any tag
($smoke_how) with \`/version\` answering $version at this commit.

| Platform | Manifest |
|---|---|
| linux/amd64 | \`$amd64_digest\` |
| linux/arm64 | \`$arm64_digest\` |

Tags, all pointing at that digest (there is never a \`latest\`):

$tag_lines
## The chart

\`oci://$chart_ref\` (\`$chart_digest\`), appVersion $version, its image pinned by the digest above.

## Verify

\`\`\`sh
$verify_lines
docker buildx imagetools inspect $registry:$version --format '{{ json .SBOM }}'   # the SPDX SBOM per platform
\`\`\`
$tlog_note
NOTES
  mv "$notes_file.tmp" "$notes_file"
}

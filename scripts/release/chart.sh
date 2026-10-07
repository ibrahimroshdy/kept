# shellcheck shell=bash
# Stage 7 of scripts/release.sh (sourced): the chart as an OCI artifact beside the image (D87),
# as version X.Y.Z with appVersion X.Y.Z (the chart's version is the release's, plan Q17: set here
# at package time; the committed Chart.yaml stays 0.0.0-dev and is never edited by a release),
# and the image pinned by the signed digest, signed by its PUSHED digest
# (re-packaging changes the digest: spike H1); an unsigned release (KEPT_RELEASE_UNSIGNED=1)
# pushes it unsigned. Sets chart_ref, chart_digest, chart_version.

release_chart() {
  local stage=$work/chart pkg out
  chart_version=$version
  say "7. the chart $chart_version (appVersion $version) to oci://$chart_repo"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$work/src/charts/kept" "$stage/kept"
  # The release's image, by digest, as the packaged chart's default.
  node -e '
    const fs = require("fs");
    const [file, repo, digest] = process.argv.slice(1);
    let text = fs.readFileSync(file, "utf8");
    const swap = (from, to) => {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`values.yaml: expected one "${from.trim()}", found ${n}`);
      text = text.replace(from, to);
    };
    swap("\n  repository: ghcr.io/ibrahimroshdy/kept\n", `\n  repository: ${repo}\n`);
    swap("\n  digest: \"\"\n", `\n  digest: "${digest}"\n`);
    fs.writeFileSync(file, text);
  ' "$stage/kept/values.yaml" "$registry" "$index_digest"

  local plain=()
  [[ -n $http_registry ]] && plain=(--plain-http)
  if [[ -z $dry ]] && "$helm" show chart "oci://$chart_repo/kept" --version "$chart_version" >/dev/null 2>&1; then
    die "chart $chart_version is already published at $chart_repo/kept: release a newer version"
  fi
  "$helm" package "$stage/kept" --version "$chart_version" --app-version "$version" --destination "$work" >/dev/null
  pkg=$work/kept-$chart_version.tgz
  [[ -f $pkg ]] || die "helm package wrote no $pkg"
  # The packaged chart must render the signed image (`helm template` takes no --app-version, so
  # this renders the package itself).
  out=$("$helm" template kept "$pkg" --set publicUrl=https://kept.example.org \
    --set roles.existingSecret=x --set postgres.superuserSecret=y 2>&1) || {
    echo "$out" >&2
    die "the packaged chart does not render"
  }
  grep -qF "image: $registry:$version@$index_digest" <<<"$out" || die "the packaged chart does not render $registry:$version@$index_digest"
  note "the packaged chart renders $registry:$version@$index_digest"
  out=$("$helm" push "$pkg" "oci://$chart_repo" ${plain[@]+"${plain[@]}"} 2>&1) || {
    echo "$out" >&2
    die "helm push failed"
  }
  chart_digest=$(sed -n 's/^Digest: *//p' <<<"$out" | head -n 1)
  [[ $chart_digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "helm push printed no digest: $out"
  chart_ref=$chart_repo/kept:$chart_version
  note "pushed $chart_ref ($chart_digest)"
  if [[ -n ${unsigned:-} ]]; then
    note "the chart is not signed (KEPT_RELEASE_UNSIGNED=1)"
  else
    release_sign_digest "$chart_repo/kept@$chart_digest"
  fi
}

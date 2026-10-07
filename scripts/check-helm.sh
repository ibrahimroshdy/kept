#!/usr/bin/env bash
# The Helm chart's check (step 8 T16; ci-local's `helm` step; spike H1).
#
#   bash scripts/check-helm.sh             the checkout's chart version, lint, golden renders,
#                                          kubeconform, image pins, refusals
#   bash scripts/check-helm.sh --update    rewrite the golden renders from the current chart
#
# 0. Chart.yaml's version and appVersion are both 0.0.0-dev: the release sets both to Kept's
#    version at package time (scripts/release/chart.sh, plan Q17), so a hand bump is a mistake;
# 1. `helm lint` with each value set in charts/kept/ci/;
# 2. `helm template` of each set (and an upgrade render of backup-dir, which schedules the migrate
#    Job beside the pod holding the volumes) compared with charts/kept/ci/golden/;
# 3. `kubeconform -strict` at Kubernetes 1.37.0 against schemas pinned to a commit of
#    yannh/kubernetes-json-schema (kubeconform's default location is a moving branch). The schema
#    cache is .tmp/kubeconform: a cold cache needs the network once, a warm one runs offline;
# 4. every rendered image carries a tag or a digest, and none is `latest`;
# 5. the chart refuses what it must: no publicUrl, image.tag=latest, split without secret keys,
#    split with local files on a ReadWriteOnce volume;
# 6. with KEPT_HELM_KIND=1, a kind cluster: install with the bundled Postgres and a local image,
#    /readyz, `helm test`, one upgrade (the migrate hook runs again), then the cluster is deleted.
#    NOT RUN YET: build agents may not create clusters; it is the maintainer's device row H1b.
#    KEPT_HELM_IMAGE names the local image (default kept:ci-arm64, ci-local's `images` build).
#
# Tools: Helm v4.3.0 and kubeconform v0.8.0 (and kind v0.33.0 for 6), found by scripts/tools.sh;
# `bash scripts/tools.sh fetch helm kubeconform` installs the pinned, checksummed builds.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
chart=$repo/charts/kept
golden=$chart/ci/golden
# shellcheck source=tools.sh
source "$repo/scripts/tools.sh"

KUBE_VERSION=1.37.0
SCHEMAS_COMMIT=8df8a883b68a24a104b4a9e43c1288090ae60b3b
SCHEMA_LOCATION="https://raw.githubusercontent.com/yannh/kubernetes-json-schema/$SCHEMAS_COMMIT/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json"
# kind v0.33.0's default node image (its release notes), for the optional smoke.
KIND_NODE=kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5

update=
[[ ${1:-} == --update ]] && update=1

helm=$(tool_path helm) || { echo "check-helm: helm $HELM_VERSION not found (bash scripts/tools.sh fetch helm)" >&2; exit 1; }
kubeconform=$(tool_path kubeconform) || { echo "check-helm: kubeconform $KUBECONFORM_VERSION not found (bash scripts/tools.sh fetch kubeconform)" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/kept-helm.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
cache=$repo/.tmp/kubeconform
mkdir -p "$cache" "$golden"

render() { # <set> [extra helm args...]
  local set=$1
  shift
  "$helm" template kept "$chart" --namespace kept --kube-version "$KUBE_VERSION" \
    -f "$chart/ci/$set.values.yaml" "$@"
}

fail=0
sets=()
for f in "$chart"/ci/*.values.yaml; do sets+=("$(basename "$f" .values.yaml)"); done
[[ ${#sets[@]} -ge 4 ]] || { echo "check-helm: expected the four value sets in charts/kept/ci/" >&2; exit 1; }

echo "==> the checkout's chart version"
for key in version appVersion; do
  v=$(sed -n "s/^$key: *//p" "$chart/Chart.yaml")
  [[ $v == 0.0.0-dev ]] || {
    echo "check-helm: Chart.yaml $key is '$v', not 0.0.0-dev: the release sets it to Kept's version (scripts/release/chart.sh)" >&2
    exit 1
  }
done
echo "Chart.yaml: version and appVersion 0.0.0-dev"

echo "==> helm lint"
for set in "${sets[@]}"; do
  "$helm" lint "$chart" --quiet --kube-version "$KUBE_VERSION" -f "$chart/ci/$set.values.yaml" >"$tmp/lint.log" 2>&1 || {
    cat "$tmp/lint.log" >&2
    echo "check-helm: helm lint failed with $set" >&2
    exit 1
  }
  echo "lint: $set ok"
done

echo "==> golden renders"
renders=()
for set in "${sets[@]}"; do
  render "$set" >"$tmp/$set.yaml"
  renders+=("$set")
done
render backup-dir --is-upgrade >"$tmp/backup-dir.upgrade.yaml"
renders+=(backup-dir.upgrade)
for r in "${renders[@]}"; do
  if [[ -n $update ]]; then
    cp "$tmp/$r.yaml" "$golden/$r.yaml"
    echo "golden: wrote ci/golden/$r.yaml"
  elif ! diff -u "$golden/$r.yaml" "$tmp/$r.yaml" >"$tmp/$r.diff"; then
    head -n 60 "$tmp/$r.diff" >&2
    echo "check-helm: the $r render differs from ci/golden/$r.yaml; review it, then: bash scripts/check-helm.sh --update" >&2
    fail=1
  else
    echo "golden: $r matches"
  fi
done
for g in "$golden"/*.yaml; do
  r=$(basename "$g" .yaml)
  [[ -f $tmp/$r.yaml ]] || { echo "check-helm: ci/golden/$r.yaml has no value set" >&2; fail=1; }
done

echo "==> kubeconform -strict, Kubernetes $KUBE_VERSION"
for r in "${renders[@]}"; do
  "$kubeconform" -strict -summary -kubernetes-version "$KUBE_VERSION" -cache "$cache" \
    -schema-location "$SCHEMA_LOCATION" "$tmp/$r.yaml" || { echo "check-helm: kubeconform failed on $r" >&2; fail=1; }
done

echo "==> image pins"
for r in "${renders[@]}"; do
  while IFS= read -r ref; do
    ref=${ref#\"}
    ref=${ref%\"}
    if [[ $ref != *@sha256:* && $ref != *:* ]] || [[ $ref == *:latest || $ref == *:latest@* ]]; then
      echo "check-helm: $r renders an untagged or latest image: $ref" >&2
      fail=1
    fi
  done < <(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$tmp/$r.yaml")
done
echo "images: every one tagged or pinned, none latest"

echo "==> refusals"
refuses() { # <what the error must say> <helm template args...>
  local want=$1 out
  shift
  if out=$("$helm" template kept "$chart" --kube-version "$KUBE_VERSION" "$@" 2>&1); then
    echo "check-helm: rendered, but should have refused ($want): $*" >&2
    fail=1
  elif ! grep -qF -- "$want" <<<"$out"; then
    echo "check-helm: refused, but without '$want': $out" >&2
    fail=1
  else
    echo "refused: $want"
  fi
}
base=(-f "$chart/ci/bundled-local.values.yaml")
refuses 'publicUrl is required' --set image.tag=1.0.0 --set roles.existingSecret=x --set postgres.superuserSecret=y
refuses 'latest' "${base[@]}" --set image.tag=latest
refuses 'split.enabled needs keys.existingSecret' "${base[@]}" --set split.enabled=true
refuses 'ReadWriteMany' "${base[@]}" --set split.enabled=true --set keys.existingSecret=k
refuses 'postgres.external.host is required' "${base[@]}" --set postgres.bundled=false

if [[ ${KEPT_HELM_KIND:-} == 1 ]]; then
  echo "==> kind smoke (KEPT_HELM_KIND=1)"
  kind_bin=$(command -v kind || true)
  [[ -n $kind_bin ]] || { echo "check-helm: KEPT_HELM_KIND=1 but kind is not on PATH (v0.33.0)" >&2; exit 1; }
  kubectl_bin=$(command -v kubectl || true)
  [[ -n $kubectl_bin ]] || { echo "check-helm: KEPT_HELM_KIND=1 needs kubectl" >&2; exit 1; }
  image=${KEPT_HELM_IMAGE:-kept:ci-arm64}
  cluster="kept-helm-$$"
  kubeconfig="$tmp/kubeconfig"
  trap '"$kind_bin" delete cluster --name "$cluster" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
  "$kind_bin" create cluster --name "$cluster" --image "$KIND_NODE" --kubeconfig "$kubeconfig" --wait 120s
  "$kind_bin" load docker-image "$image" --name "$cluster"
  k() { "$kubectl_bin" --kubeconfig "$kubeconfig" -n kept "$@"; }
  "$kubectl_bin" --kubeconfig "$kubeconfig" create namespace kept
  pw() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
  k create secret generic kept-postgres --from-literal=POSTGRES_PASSWORD="$(pw)"
  k create secret generic kept-db --from-literal=KEPT_DB_OWNER_PASSWORD="$(pw)" \
    --from-literal=KEPT_DB_APP_PASSWORD="$(pw)" --from-literal=KEPT_DB_AUTH_PASSWORD="$(pw)" \
    --from-literal=KEPT_DB_SYSTEM_PASSWORD="$(pw)"
  repo_part=${image%:*}
  tag_part=${image##*:}
  args=(--kubeconfig "$kubeconfig" --namespace kept --set publicUrl=http://kept.localhost
    --set image.repository="$repo_part" --set image.tag="$tag_part" --set image.pullPolicy=Never
    --set postgres.superuserSecret=kept-postgres --set roles.existingSecret=kept-db)
  # No --wait on install: the migrate hook is post-install with the bundled Postgres (jobs.yaml).
  "$helm" install kept "$chart" "${args[@]}" --timeout 15m
  k rollout status deploy/kept --timeout 10m
  "$helm" test kept --kubeconfig "$kubeconfig" --namespace kept --logs
  "$helm" upgrade kept "$chart" "${args[@]}" --set podAnnotations.upgraded=yes --wait --timeout 15m
  "$helm" test kept --kubeconfig "$kubeconfig" --namespace kept --logs
  echo "kind: installed, tested, upgraded and tested again"
fi

if ((fail)); then
  echo "check-helm: FAILED" >&2
  exit 1
fi
echo "check-helm: ok"

#!/usr/bin/env bash
# The release (step 8 T17; D87, D186, D187, L100–L104; spike R2,
# docs/spikes/2026-10-06-step8-release.md). GitHub Actions runs it on a pushed release tag
# (.github/workflows/release.yml, `--ci`); from the laptop it is the fallback.
#
#   bash scripts/release.sh <X.Y.Z[-pre]> --run-gate      run ci-local in a clean worktree of HEAD
#                                                         and record it (.tmp/release/<v>/gate.txt)
#   bash scripts/release.sh <X.Y.Z[-pre]> [--registry <host/path>]   the release
#   bash scripts/release.sh <X.Y.Z[-pre]> --dry-run       the same against a throwaway local registry
#                                                         with a throwaway key; removes both after
#   bash scripts/release.sh <X.Y.Z[-pre]> --ci            the release, from release.yml only: HEAD is
#                                                         the pushed tag vX.Y.Z, on main; the gate ran
#                                                         on the laptop before the tag; step 9 hands
#                                                         the workflow its outputs instead of printing
#   … --ci --arch <amd64|arm64>                           release.yml's build jobs, one per runner of
#                                                         that architecture: stages 1–2, then 3 and 4
#                                                         for that platform only (built and smoked
#                                                         natively, pushed by digest), and its digests
#                                                         as outputs (<arch>_index, <arch>_manifest)
#   … --ci --publish                                      release.yml's last job: stages 1–2, then the
#                                                         two digests (KEPT_RELEASE_AMD64_INDEX/_MANIFEST,
#                                                         KEPT_RELEASE_ARM64_INDEX/_MANIFEST) joined into
#                                                         one index by digest (release/build.sh
#                                                         release_merge), then stages 5–9
#
# Stages, each stopping the run on failure:
#   1. preconditions: a clean tree on `main`, a version newer than the last v* tag, disk room, and
#      a gate record for this exact commit (optional in a dry run; with --ci, the tag at HEAD and
#      its commit on origin/main instead); a real run also refuses a version the registry already
#      holds, as an image or as a chart, before it builds anything;
#   2. the CHANGELOG.md section (scripts/changelog.mjs; the committed one when CHANGELOG.md already
#      has this version's section), checked for AI attribution (D173);
#   3. build linux/amd64 + linux/arm64 from `git archive HEAD`, with an SBOM and minimal provenance
#      (BuildKit attestations), pushed BY DIGEST with no tag (release/build.sh);
#   4. pull each architecture by digest and smoke it (scripts/smoke-image.sh with
#      SMOKE_SCOPE=release; on the laptop arm64 natively and amd64 under emulation, in the workflow
#      each natively on its own runner), and check /version reports this version and commit
#      (release/verify.sh);
#   5. cosign-sign the index digest and every manifest under it, then verify (release/sign.sh);
#   6. tag X.Y.Z, and X.Y and X when this is the newest final release of that line, all from the
#      signed digest; never `latest`; then verify by tag (release/sign.sh);
#   7. package the chart as version X.Y.Z with appVersion X.Y.Z (the chart's version is always the
#      release's, plan Q17; the committed Chart.yaml stays 0.0.0-dev) and the image pinned by digest,
#      push it beside the image as an OCI artifact, sign its pushed digest (release/chart.sh);
#      with KEPT_RELEASE_UNSIGNED=1, stages 5–7 sign and verify nothing (everything else runs);
#   8. record docs/releases/X.Y.Z.md: digests, tags, the chart, the verify commands
#      (release/notes.sh);
#   9. print the maintainer's steps (the tag on the built commit, the GitHub release, the record's
#      pull request: `main` takes no direct push), or with --ci write the workflow's outputs. The
#      script never commits, tags or pushes to git.
#
# Settings (environment):
#   KEPT_RELEASE_REGISTRY    the image path; default ghcr.io/ibrahimroshdy/kept, INFERRED from the
#                            Dockerfile's SOURCE default and to be confirmed (plan Q14); --registry
#   KEPT_RELEASE_CHART_REPO  where the chart goes; default <registry's parent>/charts
#   KEPT_COSIGN_KEY          the private key file (a real run; never in the repository)
#   COSIGN_PASSWORD          its password, read by cosign from the environment, never printed
#   KEPT_RELEASE_TLOG=1      sign into Sigstore's public transparency log (once the repository is
#                            public, Q14); default: no log (an empty signing config), and verifiers
#                            pass --insecure-ignore-tlog
#   KEPT_RELEASE_UNSIGNED=1  a real release with NO signature, while no cosign key exists yet: no key
#                            needed, stages 5–7 sign and verify nothing, the record says it is
#                            unsigned. Refused for 1.0.0 and every final release after it (1.0 must
#                            be signed); a dry run ignores it and signs with its throwaway key
#   KEPT_RELEASE_SOURCE      the repository URL stamped in the image; default origin's https URL
#   KEPT_RELEASE_BUILDER     the buildx builder; default kept-release (kept between releases for
#                            its cache; `docker buildx rm kept-release` drops it)
#   KEPT_RELEASE_BOOT_TIMEOUT  the smoke's boot timeout in seconds (default 300: amd64 is emulated)
#   KEPT_RELEASE_MIN_FREE_GB   disk room required (default 15)
#   KEPT_RELEASE_SMOKE_SCRIPT  dry runs only: smoke with this script instead of the commit's own
#   KEPT_RELEASE_CACHE_FROM, KEPT_RELEASE_CACHE_TO  buildx --cache-from / --cache-to values (the
#                            workflow uses a registry cache per architecture in GHCR); unset on the
#                            laptop, which keeps its builder
#
# The registry login, the cosign key and `gh auth` are the maintainer's: docs/runbooks/release.md.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
# shellcheck source=tools.sh
source "$repo/scripts/tools.sh"

DEFAULT_REGISTRY=ghcr.io/ibrahimroshdy/kept
# Pins from spike R2 (Docker Hub, multi-arch index digests).
BUILDKIT_IMAGE=moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea
REGISTRY_IMAGE=registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { echo "release: $*"; }
warn() { printf '\033[33mrelease: %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mrelease: %s\033[0m\n' "$*" >&2
  exit 1
}

version=
registry=${KEPT_RELEASE_REGISTRY:-}
dry=
run_gate=
ci=
arch=
publish=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --run-gate) run_gate=1 ;;
    --ci) ci=1 ;;
    --publish) publish=1 ;;
    --arch)
      [[ $# -ge 2 ]] || die "--arch needs amd64 or arm64"
      arch=$2
      shift
      ;;
    --registry)
      [[ $# -ge 2 ]] || die "--registry needs a path, e.g. ghcr.io/<owner>/kept"
      registry=$2
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    -*) die "unknown option $1" ;;
    *)
      [[ -z $version ]] || die "one version only"
      version=$1
      ;;
  esac
  shift
done
[[ -n $version ]] || die "usage: release.sh <X.Y.Z> [--registry <path>] [--dry-run | --run-gate | --ci]"
if [[ -n $ci ]]; then
  [[ -z $dry && -z $run_gate ]] || die "--ci is the release itself: no --dry-run, no --run-gate"
  [[ ${GITHUB_ACTIONS:-} == true ]] || die "--ci is for .github/workflows/release.yml; from the laptop run release.sh without it"
fi
if [[ -n $arch || -n $publish ]]; then
  [[ -n $ci ]] || die "--arch and --publish are release.yml's split of --ci; from the laptop run release.sh without them"
  [[ -z $arch || -z $publish ]] || die "--arch builds one platform, --publish joins both: one or the other"
  [[ -z $arch || $arch == amd64 || $arch == arm64 ]] || die "--arch is amd64 or arm64, not '$arch'"
fi
# What stages 3 and 4 build and smoke: both on the laptop (and with a bare --ci), one with --arch.
platforms=linux/amd64,linux/arm64
smoke_arches="arm64 amd64"
smoke_how="arm64 natively, amd64 under emulation"
if [[ -n $arch ]]; then
  platforms=linux/$arch
  smoke_arches=$arch
elif [[ -n $publish ]]; then
  smoke_arches=
  smoke_how="each natively, by the workflow's build job on a runner of its own architecture"
fi
if [[ -n $dry && -n $registry ]]; then
  die "--dry-run publishes to a throwaway local registry only; it takes no --registry"
fi
unsigned=
case "${KEPT_RELEASE_UNSIGNED:-}" in
  '') ;;
  1) unsigned=1 ;;
  *) die "KEPT_RELEASE_UNSIGNED is 1 or unset, not '$KEPT_RELEASE_UNSIGNED'" ;;
esac
if [[ -n $unsigned && -n $dry ]]; then
  warn "KEPT_RELEASE_UNSIGNED is ignored in a dry run: it signs with its throwaway key, as always"
  unsigned=
fi

commit=$(git rev-parse HEAD)
gate_file=$repo/.tmp/release/$version/gate.txt

# ---------------------------------------------------------------------------------------------
# 1. Preconditions

say "1. preconditions for $version at ${commit:0:12}${dry:+ (dry run)}${ci:+ (GitHub Actions${arch:+, linux/$arch}${publish:+, publish})}"
if [[ -n $ci ]]; then
  # The workflow builds the commit the pushed tag names; that tag is not an "earlier" release.
  tagged=$(git rev-parse -q --verify "refs/tags/v$version^{commit}" 2>/dev/null || true)
  [[ -n $tagged ]] || die "no tag v$version in this checkout"
  [[ $tagged == "$commit" ]] || die "HEAD (${commit:0:12}) is not the commit tag v$version names (${tagged:0:12})"
fi
existing_tags=()
while IFS= read -r t; do [[ -n $t && ( -z $ci || $t != "v$version" ) ]] && existing_tags+=("$t"); done < <(git tag -l 'v*')
why=$(node scripts/release/version.mjs check "$version" ${existing_tags[@]+"${existing_tags[@]}"} 2>&1) || die "$why"
last_tag=$(node scripts/release/version.mjs last ${existing_tags[@]+"${existing_tags[@]}"})
note "version $version is newer than ${last_tag:-every tag (there are none)}"
if [[ -n $unsigned ]]; then
  why=$(node scripts/release/version.mjs unsigned "$version" 2>&1) || die "$why"
  warn "UNSIGNED release (KEPT_RELEASE_UNSIGNED=1): no cosign signature on the image or the chart; the record says so"
fi

if [[ -n $(git status --porcelain) ]]; then
  [[ -n $dry ]] || die "the working tree is not clean: a release builds a commit, nothing else"
  warn "the working tree is not clean; the dry run builds HEAD (${commit:0:12}) and ignores it"
fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ -n $ci ]]; then
  # A tag checkout is detached: the tagged commit must be on main instead.
  git merge-base --is-ancestor "$commit" refs/remotes/origin/main 2>/dev/null ||
    die "v$version's commit ${commit:0:12} is not on origin/main: releases are cut from main"
  note "v$version is ${commit:0:12}, on origin/main"
elif [[ $branch != main ]]; then
  [[ -n $dry ]] || die "HEAD is on '$branch': releases are cut from main"
  warn "HEAD is on '$branch', not main (dry run)"
fi

if [[ -n $run_gate ]]; then
  say "the gate: bash scripts/ci-local.sh in a clean worktree of ${commit:0:12}"
  mkdir -p "$(dirname "$gate_file")"
  wt=$repo/.tmp/release/$version/gate-worktree
  [[ ! -e $wt ]] || die "$wt exists: remove it (git worktree remove --force $wt) and run again"
  git worktree add --detach "$wt" "$commit" >/dev/null
  rc=0
  (cd "$wt" && bash scripts/ci-local.sh) || rc=$?
  git worktree remove --force "$wt"
  printf 'commit=%s\nexit=%s\ndate=%s\n' "$commit" "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$gate_file"
  ((rc == 0)) || die "ci-local failed (exit $rc), recorded in $gate_file"
  note "ci-local passed; recorded in $gate_file"
  exit 0
fi

free_gb=$(df -Pk / | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
min_gb=${KEPT_RELEASE_MIN_FREE_GB:-15}
((free_gb >= min_gb)) || die "${free_gb} GB free on /; a release needs ${min_gb} GB (KEPT_RELEASE_MIN_FREE_GB)"
note "${free_gb} GB free"

gate_ok=
if [[ -f $gate_file ]] && grep -qx "commit=$commit" "$gate_file" && grep -qx 'exit=0' "$gate_file"; then
  gate_ok=1
  note "gate: ci-local passed for ${commit:0:12} ($gate_file)"
elif [[ -n $dry ]]; then
  warn "gate: no passing ci-local record for ${commit:0:12}; optional in a dry run"
elif [[ -n $ci ]]; then
  note "gate: ci-local ran on the laptop before the tag was pushed (docs/runbooks/release.md); not re-run here"
elif [[ -f $gate_file ]]; then
  die "the gate record $gate_file is not a pass for ${commit:0:12}: run release.sh $version --run-gate"
else
  die "no gate record for $version: run release.sh $version --run-gate first (ci-local in a clean worktree of this commit)"
fi

# The signing key of a real, signed release (checked before the tools: it needs none of them).
if [[ -n $dry ]]; then
  work=$repo/.tmp/release/dry-$version-$$
else
  work=$repo/.tmp/release/$version
  # A build job (--arch) signs nothing: the key is the publish job's alone.
  if [[ -z $unsigned && -z $arch ]]; then
    [[ -n ${KEPT_COSIGN_KEY:-} && -f ${KEPT_COSIGN_KEY:-} ]] || die "KEPT_COSIGN_KEY must name the cosign private key file (docs/runbooks/release.md)"
    [[ -n ${COSIGN_PASSWORD+set} ]] || die "COSIGN_PASSWORD must be set in the environment (it is never printed)"
    [[ -f $repo/cosign.pub ]] || die "cosign.pub is not committed at the repository root (docs/runbooks/release.md)"
  fi
fi

# Everything below needs Docker and Helm, and cosign unless the release is unsigned.
command -v docker >/dev/null || die "docker is not on PATH"
cosign=
helm=
if [[ -z $arch ]]; then
  if [[ -z $unsigned ]]; then
    cosign=$(tool_path cosign) || die "cosign $COSIGN_VERSION not found: bash scripts/tools.sh fetch cosign"
  fi
  helm=$(tool_path helm) || die "helm $HELM_VERSION not found: bash scripts/tools.sh fetch helm"
fi
mkdir -p "$work"

# Undo list, run in reverse on exit, pass or fail.
cleanup_cmds=()
on_exit() {
  local rc=$? i
  for ((i = ${#cleanup_cmds[@]} - 1; i >= 0; i--)); do eval "${cleanup_cmds[$i]}" >/dev/null 2>&1 || true; done
  if ((rc == 0)); then note "done"; else printf '\033[31mrelease: FAILED (exit %s); the work directory is %s\033[0m\n' "$rc" "$work" >&2; fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# The throwaway registry and key for a dry run, or the real settings.

if [[ -n $dry ]]; then
  say "dry run: a throwaway registry ($REGISTRY_IMAGE) and key"
  export DOCKER_CONFIG=$work/docker-config
  mkdir -p "$DOCKER_CONFIG/cli-plugins"
  for plugin in docker-buildx docker-compose; do
    for dir in "$HOME/.docker/cli-plugins" /Applications/Docker.app/Contents/Resources/cli-plugins /usr/libexec/docker/cli-plugins /usr/lib/docker/cli-plugins; do
      if [[ -x $dir/$plugin ]]; then
        ln -sfn "$dir/$plugin" "$DOCKER_CONFIG/cli-plugins/$plugin"
        break
      fi
    done
  done
  [[ -e $HOME/.docker/contexts ]] && ln -sfn "$HOME/.docker/contexts" "$DOCKER_CONFIG/contexts"
  context=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(c.currentContext ?? "") } catch {}' "$HOME/.docker/config.json")
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv[2] ? { currentContext: process.argv[2] } : {}))' "$DOCKER_CONFIG/config.json" "$context"

  port=
  for p in $(seq 5150 5199); do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then port=$p; break; fi
  done
  [[ -n $port ]] || die "no free port in 5150-5199 for the throwaway registry"
  reg_container=kept-release-dry-$$
  docker run -d --name "$reg_container" -p "127.0.0.1:$port:5000" "$REGISTRY_IMAGE" >/dev/null
  cleanup_cmds+=("docker rm -f '$reg_container'")
  for _ in $(seq 30); do
    [[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v2/" || true) == 200 ]] && break
    sleep 1
  done
  registry=localhost:$port/kept
  chart_repo=localhost:$port/charts
  http_registry=1

  export COSIGN_PASSWORD
  COSIGN_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  (cd "$work" && "$cosign" generate-key-pair --output-key-prefix throwaway >/dev/null 2>&1)
  cosign_key=$work/throwaway.key
  cosign_pub=$work/throwaway.pub
  cleanup_cmds+=("rm -f '$cosign_key' '$cosign_pub'")
  [[ -s $cosign_key && -s $cosign_pub ]] || die "cosign generate-key-pair made no key pair"
  builder=kept-release-dry-$$
  note "registry $registry (container $reg_container), throwaway key in $work, builder $builder"
else
  registry=${registry:-$DEFAULT_REGISTRY}
  chart_repo=${KEPT_RELEASE_CHART_REPO:-$(dirname "$registry")/charts}
  http_registry=
  cosign_key=${KEPT_COSIGN_KEY:-}
  cosign_pub=$repo/cosign.pub
  builder=${KEPT_RELEASE_BUILDER:-kept-release}
  [[ $registry == "$DEFAULT_REGISTRY" ]] && note "registry $registry (the inferred default, plan Q14)"
fi
# imagetools reads the registry settings (a dry run's plain-HTTP registry) from the builder; the
# publish job builds nothing and has none, and its registry is GHCR.
it_builder=(--builder "$builder")
[[ -z $publish ]] || it_builder=()
[[ $registry =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$ ]] || die "'$registry' is not an image path (host/owner/name)"

source_url=${KEPT_RELEASE_SOURCE:-$(git remote get-url origin 2>/dev/null || true)}
source_url=${source_url%.git}
[[ $source_url == https://* ]] || die "the source URL '$source_url' is not https: set KEPT_RELEASE_SOURCE"

# A real run refuses, before it builds anything, a version already published as an image or as a
# chart (the chart's version is the release's, plan Q17; both are immutable; the chart stage checks
# again before its push). A registry that can't be read here (no package yet, or no login) counts
# as "not published": the push then says which.
if [[ -z $dry ]]; then
  if docker buildx imagetools inspect "$registry:$version" >/dev/null 2>&1; then
    die "$registry:$version is already published: release a newer version"
  fi
  if [[ -n $helm ]] && "$helm" show chart "oci://$chart_repo/kept" --version "$version" >/dev/null 2>&1; then
    die "chart $version is already published at $chart_repo/kept: release a newer version"
  fi
  if [[ -n $helm ]]; then
    note "neither $registry:$version nor chart $version is published yet"
  else
    note "$registry:$version is not published yet (the publish job checks the chart)"
  fi
fi

# ---------------------------------------------------------------------------------------------
# 2. The changelog

say "2. the changelog since ${last_tag:-the first commit}"
cp "$repo/CHANGELOG.md" "$work/CHANGELOG.md" 2>/dev/null || true
# The runbook commits the section before the gate (`chore(release): X.Y.Z`); that one is used as
# committed. changelog.mjs --write refuses a version the file already has.
section_at="## $version ("
if [[ -f $work/CHANGELOG.md ]] && awk -v h="$section_at" 'index($0, h) == 1 { found = 1 } END { exit !found }' "$work/CHANGELOG.md"; then
  awk -v h="$section_at" 'index($0, h) == 1 { on = 1; print; next } on && /^## / { exit } on { print }' \
    "$work/CHANGELOG.md" >"$work/changelog-section.md"
  note "CHANGELOG.md already has the $version section; used as committed"
else
  node scripts/changelog.mjs --version "$version" ${last_tag:+--from "$last_tag"} --write "$work/CHANGELOG.md"
  node scripts/changelog.mjs --version "$version" ${last_tag:+--from "$last_tag"} >"$work/changelog-section.md"
fi
bash scripts/check-attribution.sh "$work/changelog-section.md"
note "$(grep -c '^- ' "$work/changelog-section.md" || true) entries; no AI attribution"

# ---------------------------------------------------------------------------------------------
# 3–8

# shellcheck source=release/build.sh
source scripts/release/build.sh
# shellcheck source=release/verify.sh
source scripts/release/verify.sh
# shellcheck source=release/sign.sh
source scripts/release/sign.sh
# shellcheck source=release/chart.sh
source scripts/release/chart.sh
# shellcheck source=release/notes.sh
source scripts/release/notes.sh

if [[ -n $arch ]]; then
  # A build job: this platform built and smoked natively, its digests to the publish job.
  release_build # sets index_digest and ${arch}_digest
  release_verify
  say "9. outputs for the publish job"
  manifest_var=${arch}_digest
  {
    echo "${arch}_index=$index_digest"
    echo "${arch}_manifest=${!manifest_var}"
  } >>"${GITHUB_OUTPUT:-$work/outputs.txt}"
  note "linux/$arch $index_digest (manifest ${!manifest_var}), smoked; nothing tagged"
  exit 0
fi

if [[ -n $publish ]]; then
  release_export_src # the chart comes from the commit
  release_merge      # sets index_digest, amd64_digest, arm64_digest
else
  release_build # sets index_digest, amd64_digest, arm64_digest
  [[ -n $dry ]] && cleanup_cmds+=("rm -rf '$work/src'")
  release_verify
fi
release_notices
if [[ -n $unsigned ]]; then
  say "5. NOT signed (KEPT_RELEASE_UNSIGNED=1): the index, its manifests and the chart get no signature"
else
  say "5. sign the index and every manifest under it, before any tag"
  release_sign_digest "$registry@$index_digest" --recursive
fi
release_tags    # sets image_tags
release_chart   # sets chart_ref, chart_digest
release_notes   # sets notes_file

if [[ -n $dry ]]; then
  say "dry run: what is in the throwaway registry"
  release_verify_signature "$registry:$version"
  note "the signature on $registry:$version verifies with the throwaway key"
  note "nothing was published anywhere else; the registry, the builder and the key are removed now"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 9. With --ci, the workflow's outputs: it creates the GitHub release from them

if [[ -n $ci ]]; then
  say "9. outputs for the workflow"
  out=${GITHUB_OUTPUT:-$work/outputs.txt}
  {
    echo "version=$version"
    echo "prerelease=$([[ $version == *-* ]] && echo true || echo false)"
    echo "index_digest=$index_digest"
    echo "notes_file=$notes_file"
    echo "changelog_section=$work/changelog-section.md"
    echo "notices_file=$work/THIRD-PARTY-NOTICES.txt"
    echo "signed=$([[ -n $unsigned ]] && echo false || echo true)"
  } >>"$out"
  note "published $registry:$version ($index_digest), tags ${image_tags[*]}; chart $chart_ref@$chart_digest${unsigned:+; UNSIGNED}"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 9. The maintainer's steps (never run by this script)

cp "$work/CHANGELOG.md" "$repo/CHANGELOG.md"
say "9. your steps (docs/runbooks/release.md)"
# `main` takes changes only through pull requests (docs/runbooks/repo-settings.md): the tag goes
# on the commit that was built (HEAD, already on main), and the record follows in a pull request.
record_files=${notes_file#"$repo"/}
git diff --quiet -- CHANGELOG.md 2>/dev/null || record_files="CHANGELOG.md $record_files"
cat <<EOF
Published: $registry:$version ($index_digest), tags ${image_tags[*]}; chart $chart_ref@$chart_digest${unsigned:+; UNSIGNED: no cosign signature}.
Written: $record_files.

  1. The tag, on the built commit ${commit:0:12} (main is never pushed to directly):
     git tag -a v$version -m "Kept $version" $commit && git push origin v$version
     (with release.yml in that commit the tag also starts the workflow, which stops at "already published")
  2. gh auth switch --user ibrahimroshdy   # the personal account
     gh release create v$version --verify-tag --title "Kept $version" --notes-file $work/changelog-section.md \\
       $work/THIRD-PARTY-NOTICES.txt $notes_file
EOF
if [[ $version == *-* ]]; then echo "     (add --prerelease: $version is a prerelease)"; fi
cat <<EOF
  3. The record, through a pull request (squash-merged):
     git switch -c release-record-$version && git add $record_files
     git commit -m "docs(release): the $version record" && git push -u origin release-record-$version
     gh pr create --fill --base main && gh pr merge --squash --delete-branch
  4. The first time only: make the package public on GHCR when the repository goes public.
EOF

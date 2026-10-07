#!/usr/bin/env bash
# The laptop tools the chart check and the release use, each pinned to one version and, when it is
# fetched, to its published SHA-256 (step-8 spikes H1 and R2: docs/spikes/2026-10-06-step8-helm.md,
# docs/spikes/2026-10-06-step8-release.md). They are laptop tools, never shipped in the image.
#
#   bash scripts/tools.sh path <tool>          print the binary's path, or exit 1 (nothing fetched)
#   bash scripts/tools.sh fetch <tool>...      download the pinned build into .tmp/tools/ and verify it
#   bash scripts/tools.sh check                which tools are found, and where
#
# A tool is used from PATH when `<tool> version` reports the pinned version, else from
# .tmp/tools/<tool>-<version>/ (git-ignored). Nothing is downloaded unless asked with `fetch`.
# Builds are pinned for darwin-arm64 (the maintainer's laptop), linux-amd64 and linux-arm64.
#
# Sourced (`source scripts/tools.sh`), it defines tool_path, tool_fetch and the pins.
set -euo pipefail

TOOLS_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOLS_DIR=${KEPT_TOOLS_DIR:-$TOOLS_REPO/.tmp/tools}

HELM_VERSION=v4.3.0
KUBECONFORM_VERSION=v0.8.0
COSIGN_VERSION=v3.1.3

# The checksums, from each release's own checksum file (helm: get.helm.sh/<file>.sha256sum;
# kubeconform: the release's CHECKSUMS; cosign: the release's cosign_checksums.txt), read
# 2026-10-06 and checked against the downloads in the spikes.
tool_sha256() {
  case "$1-$2" in
    helm-darwin-arm64) echo d3870437e1e95b67f8edbde964156c84a26503f560821d40c542441658934fba ;;
    helm-linux-amd64) echo 86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;;
    helm-linux-arm64) echo 31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;;
    kubeconform-darwin-arm64) echo f84f4dfbebf4a6b0b230385fa065a39ea35e02608c2b50d025dcf64775a69d67 ;;
    kubeconform-linux-amd64) echo 9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 ;;
    kubeconform-linux-arm64) echo 1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87 ;;
    cosign-darwin-arm64) echo 5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76 ;;
    cosign-linux-amd64) echo 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
    cosign-linux-arm64) echo c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
    *) return 1 ;;
  esac
}

tool_version() {
  case "$1" in
    helm) echo "$HELM_VERSION" ;;
    kubeconform) echo "$KUBECONFORM_VERSION" ;;
    cosign) echo "$COSIGN_VERSION" ;;
    *)
      echo "tools: unknown tool '$1' (helm, kubeconform, cosign)" >&2
      return 1
      ;;
  esac
}

tool_platform() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) os=unknown ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64 | amd64) arch=amd64 ;; *) arch=unknown ;; esac
  echo "$os-$arch"
}

# The version a binary reports, normalised to `vX.Y.Z`.
reported_version() {
  local tool=$1 bin=$2 out
  case "$tool" in
    helm) out=$("$bin" version --template '{{.Version}}' 2>/dev/null || true) ;;
    kubeconform) out=$("$bin" -v 2>/dev/null || true) ;;
    cosign) out=$("$bin" version --json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' || true) ;;
  esac
  out=$(tr -d '[:space:]' <<<"$out")
  [[ -n $out && $out != v* ]] && out=v$out
  echo "$out"
}

# Prints the path of the pinned tool, or returns 1.
tool_path() {
  local tool=$1 want found
  want=$(tool_version "$tool") || return 1
  found=$(command -v "$tool" 2>/dev/null || true)
  if [[ -n $found && $(reported_version "$tool" "$found") == "$want" ]]; then
    echo "$found"
    return 0
  fi
  found="$TOOLS_DIR/$tool-$want/$tool"
  if [[ -x $found && $(reported_version "$tool" "$found") == "$want" ]]; then
    echo "$found"
    return 0
  fi
  return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Downloads the pinned build for this machine into $TOOLS_DIR and verifies its checksum first.
tool_fetch() {
  local tool=$1 version platform sum url file dest tmp
  version=$(tool_version "$tool") || return 1
  platform=$(tool_platform)
  sum=$(tool_sha256 "$tool" "$platform") || {
    echo "tools: no pinned $tool build for $platform; install $tool $version yourself" >&2
    return 1
  }
  case "$tool" in
    helm) file="helm-$version-$platform.tar.gz" url="https://get.helm.sh/$file" ;;
    kubeconform) file="kubeconform-$platform.tar.gz" url="https://github.com/yannh/kubeconform/releases/download/$version/$file" ;;
    cosign) file="cosign-$platform" url="https://github.com/sigstore/cosign/releases/download/$version/$file" ;;
  esac
  dest="$TOOLS_DIR/$tool-$version"
  mkdir -p "$dest"
  tmp=$(mktemp -d "$TOOLS_DIR/.fetch.XXXXXX")
  echo "tools: fetching $url"
  curl -fsSL --retry 2 -o "$tmp/$file" "$url"
  if [[ $(sha256_of "$tmp/$file") != "$sum" ]]; then
    rm -rf "$tmp"
    echo "tools: $file does not match its pinned SHA-256; nothing installed" >&2
    return 1
  fi
  case "$tool" in
    helm) tar -xzf "$tmp/$file" -C "$tmp" && mv "$tmp/$platform/helm" "$dest/helm" ;;
    kubeconform) tar -xzf "$tmp/$file" -C "$tmp" kubeconform && mv "$tmp/kubeconform" "$dest/kubeconform" ;;
    cosign) mv "$tmp/$file" "$dest/cosign" ;;
  esac
  chmod 0755 "$dest/$tool"
  rm -rf "$tmp"
  echo "tools: $tool $version at $dest/$tool (SHA-256 verified)"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  cmd=${1:-check}
  shift || true
  case "$cmd" in
    path) tool_path "${1:?usage: tools.sh path <tool>}" ;;
    fetch)
      [[ $# -gt 0 ]] || set -- helm kubeconform cosign
      for t in "$@"; do
        if p=$(tool_path "$t"); then echo "tools: $t $(tool_version "$t") already at $p"; else tool_fetch "$t"; fi
      done
      ;;
    check)
      for t in helm kubeconform cosign; do
        if p=$(tool_path "$t"); then echo "$t $(tool_version "$t"): $p"; else echo "$t $(tool_version "$t"): not found"; fi
      done
      ;;
    *)
      echo "usage: tools.sh path <tool> | fetch [tool...] | check" >&2
      exit 2
      ;;
  esac
fi

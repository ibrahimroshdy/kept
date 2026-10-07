# Spike R2: the release pipeline on the laptop, against a throwaway local registry

Date: 2026-10-06. Step-8 plan, Task 0a (it feeds T17's `scripts/release.sh` and its `--dry-run`).
Result: **PASS.** A dry-run release of **`0.0.0-r2.1`** landed in a local registry: a multi-arch
index pushed **by digest with no tag**, both architectures smoked and `/version` checked **before**
any tag, three tags created from the index digest (all three resolve to the same digest), a
**key-based cosign signature** that verifies by digest and by tag, an **SPDX SBOM** a user can read,
and a **signed Helm chart** as an OCI artifact. No real registry, key or credential was used;
nothing was pushed anywhere external. The registry, the builder and every image were removed after.

## Tools (read from each project's releases on 2026-10-06)

| Tool | Version | Pin | Licence |
|---|---|---|---|
| cosign | **v3.1.3** (2026-08-06) | `cosign-darwin-arm64` SHA-256 `5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76` (release's `cosign_checksums.txt`, download verified); linux-amd64 `4629c757…7f71`, linux-arm64 `c5d324e0…220a` | Apache-2.0 |
| BuildKit (the `docker-container` builder) | **v0.33.1** | `moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea` (Docker Hub) | Apache-2.0 |
| Local registry | **distribution 3.1.2** | `registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8` (Docker Hub; GitHub latest `distribution/distribution` v3.1.2) | Apache-2.0 |
| syft (the alternative SBOM tool, downloaded, not needed) | v1.54.0 | `syft_1.54.0_darwin_arm64.tar.gz` verified against the release's checksums | Apache-2.0 |
| Docker on the laptop | Engine 25.0.2, buildx **v0.12.1-desktop.4**, Compose v2.24.3 | — | — |

The laptop's buildx is old (current is v0.37.2); every command below worked on 0.12.1.
`DOCKER_CONFIG=/tmp/kept-docker-config` links Compose only: the spike used its own config directory
with both `docker-compose` and `docker-buildx` linked (T17's `release.sh` needs buildx there too).

## The steps that ran, in D87's order

```sh
# 0. A throwaway registry on a spare loopback port, and a builder that can reach it.
docker run -d --name kept-spike8-registry -p 127.0.0.1:5099:5000 registry:3.1.2@sha256:ddf7…
printf '[registry."localhost:5099"]\n  http = true\n  insecure = true\n' > buildkitd.toml
docker buildx create --name kept-spike8 --driver docker-container --driver-opt network=host \
  --driver-opt image=moby/buildkit:v0.33.1@sha256:cec9… --config buildkitd.toml
# 1. Build both architectures and push by digest only: no tag exists yet.
docker buildx build --builder kept-spike8 --platform linux/amd64,linux/arm64 \
  --build-arg VERSION=0.0.0-r2.1 --build-arg REVISION=$(git rev-parse HEAD) \
  --sbom=true --provenance=mode=min --metadata-file r2-metadata.json \
  --output type=image,name=localhost:5099/kept,push-by-digest=true,name-canonical=true,push=true .
#    → containerimage.digest sha256:9249c5d4c4bcd2737a7bb20e10809ca0d9a7d51304a7008e7a127839f718bcf9
#    GET /v2/kept/tags/list → NAME_UNKNOWN (no tag at all)
# 2. Smoke each architecture by digest, which checks /version against the OCI source label.
bash scripts/smoke-image.sh localhost:5099/kept@sha256:9a13e34e…   # amd64, emulated: PASS
bash scripts/smoke-image.sh localhost:5099/kept@sha256:01ec937d…   # arm64: PASS
#    /version: {"version":"0.0.0-r2.1","revision":"5a7fa5f1…","source":"https://github.com/ibrahimroshdy/kept/tree/5a7fa5f1…"}
# 3. Sign the index digest (and every manifest under it), before any tag.
cosign signing-config create --out no-tlog.json        # {"…signingconfig.v0.2+json","rekorTlogConfig":{},"tsaConfig":{}}
COSIGN_PASSWORD=… cosign sign --yes --key cosign.key --signing-config no-tlog.json \
  --allow-http-registry --recursive localhost:5099/kept@sha256:9249c5d4…
# 4. The tags, from the index digest.
docker buildx imagetools create --builder kept-spike8 \
  -t localhost:5099/kept:0.0.0-r2.1 -t localhost:5099/kept:0.0 -t localhost:5099/kept:0 \
  localhost:5099/kept@sha256:9249c5d4…
#    every tag's Docker-Content-Digest: sha256:9249c5d4… (the same index)
# 5. Verify, by tag.
cosign verify --key cosign.pub --insecure-ignore-tlog --allow-http-registry localhost:5099/kept:0.0.0-r2.1
#    "The signatures were verified against the specified public key"
# 6. The chart (helm spike): helm package, helm push oci://localhost:5099/charts --plain-http,
#    cosign sign the pushed digest, cosign verify.
```

**L101 holds:** the only tags before step 4 were cosign's `sha256-<digest>` signature tags (cosign
stores signatures that way when the registry has no referrers API: distribution 3.1.2 answered 404
on `/v2/<name>/referrers/<digest>`). No release tag ever pointed at an untested or unsigned image.

## The index

| Manifest | Platform | Compressed size |
|---|---|---|
| `sha256:9a13e34e71be3e086448d60caf52acefa294070ec5f8b903512f60fbe45767a8` | linux/amd64 | 165.2 MB, 25 layers |
| `sha256:01ec937d35c0bc7305342fde937ba223b6a95fa2ea59d9a5193e6fb1f4f4eaec` | linux/arm64 | 141.3 MB, 25 layers |
| `sha256:fc097136…` / `sha256:af95e7b9…` | `unknown/unknown`, `vnd.docker.reference.type: attestation-manifest` for each image | 4.6 MB each (SBOM + provenance) |

(The image is the [image spike's](2026-10-06-step8-image.md) pruned build: today's Dockerfile plus
the optional-peer prune.)

## SBOM: BuildKit's attestation, not syft + `cosign attest`

- `--sbom=true` adds, per platform, an attestation manifest with two in-toto layers:
  `https://spdx.dev/Document` (4.6 MB) and `https://slsa.dev/provenance/v1` (`mode=min`, 2 KB).
- The SBOM is **SPDX-2.3**, created by `syft-v1.51.0` inside `buildkit-v0.33.1`'s scanner: **520
  packages** on amd64, the Debian packages and the npm packages both (`better-auth`,
  `postgresql-client-18`, `sharp`, `web-push` present; the pruned `vitest` absent).
- **It survives push-by-digest and `imagetools create`:** the attestation manifests are inside the
  index, and tagging re-points the same index digest.
- `cosign sign --recursive` signed them too (one `sha256-…` signature tag per manifest).
- **How a user reads it:** `docker buildx imagetools inspect <image>:<tag> --format '{{ json .SBOM }}'`
  → a JSON object keyed by platform (`linux/amd64`, `linux/arm64`), each with the SPDX document
  (ran on buildx 0.12.1).
- **Decision: BuildKit's attestation.** It needs no extra tool, is per-architecture, is inside the
  signed index, and a user reads it with the Docker CLI they already have. syft + `cosign attest`
  would add a tool and a second, separately signed artefact for the same content.

## cosign: keys and the transparency log (Q14)

- `cosign generate-key-pair` (with `COSIGN_PASSWORD` in the environment) writes `cosign.key`
  (encrypted, 0600) and `cosign.pub`. The spike's pair was throwaway and is deleted.
- **cosign 3 changed how "no transparency log" is said:** `--tlog-upload=false` is deprecated and
  **refused** together with the default `--use-signing-config=true` ("--tlog-upload=false is not
  supported with --signing-config or --use-signing-config"). What works:
  `cosign signing-config create --out no-tlog.json` (no services) and `--signing-config no-tlog.json`.
  (`--use-signing-config=false --tlog-upload=false` also signed, with a deprecation warning.)
- Verifying a signature that is in no log needs `--insecure-ignore-tlog`; cosign then still prints
  "Existence of the claims in the transparency log was verified offline", which is misleading here.
  A wrong key fails: "no matching attestations … Found: 0, Expected 1".
- `--allow-http-registry` is needed for the plain-HTTP local registry only.
- With the public log (after the repository goes public, Q14), the release drops the signing config
  (cosign's default uses Sigstore's public services) and verifiers drop `--insecure-ignore-tlog`
  (inferred from the flags' help; not run, since it would publish to the public log).

## Timings (M1 Pro, Docker Desktop VM, the laptop shared with other agents: load average 13–33)

| Step | Time |
|---|---|
| multi-arch build, warm pnpm store | 15 min 16 s (the amd64 `build` stage alone: 278 s install + 486 s compile under emulation) |
| first attempt, cold | failed after 14 min 53 s: `ERR_PNPM_BROKEN_METADATA_JSON … aborted due to timeout` in the amd64 install (registry fetches under emulation and load). The retry passed |
| amd64 smoke under emulation (L103) | 541 s incl. pull (pull 63 s) |
| arm64 smoke | 225 s |
| sign (index, recursive) | 23 s |
| `imagetools create` (3 tags) | under 1 s each |

**The smoke's fixed 60 s boot timeout fails on a loaded laptop:** the first runs failed for both
architectures (Postgres not ready in 60 s on arm64; `/readyz` not 200 in 60 s on amd64 under
emulation; once, Kept exited at boot on `timeout exceeded when trying to connect` from pg-boss's
pool while the host's load average was ~30). With the timeout raised to 300 s (a scratch copy of the
script, `BOOT_TIMEOUT=${BOOT_TIMEOUT:-60}`) both passed.

## Changes to the plan

1. **T17 / `scripts/smoke-image.sh` (T15 owns it):** make the boot timeout overridable
   (`BOOT_TIMEOUT`) and use ~300 s for the emulated amd64 smoke in the release.
2. **T17:** the order is build+push by digest → smoke both digests (`/version`) → **sign the index
   digest with `--recursive`** → tag with `imagetools create` → verify by tag → chart. Signing
   before tagging means no tag ever points at an unsigned image.
3. **T17:** while private, `--signing-config` with an empty config (not `--tlog-upload=false`,
   refused by cosign 3); verify with `--insecure-ignore-tlog`. The docs show both forms.
4. **T17:** SBOM = `--sbom=true --provenance=mode=min`; the docs give the `imagetools inspect`
   command. No syft on the laptop.
5. **T17:** `release.sh` needs a docker config with buildx linked, and a `docker-container` builder
   (the default `docker` driver can't push a multi-platform index by digest); for `--dry-run` the
   builder needs `network=host` and a `buildkitd.toml` marking the local registry as HTTP.
6. **T17:** retry the build once on a pnpm metadata timeout; consider `--platform=$BUILDPLATFORM`
   for the build stage (image spike).
7. **Tags for a prerelease:** the dry run made `0.0.0-r2.1`, `0.0`, `0`. Proposal: a prerelease
   version gets only its exact tag (no `X.Y`/`X`), so a release candidate never moves a floating tag.

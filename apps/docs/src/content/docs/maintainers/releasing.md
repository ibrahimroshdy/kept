---
title: Releasing
description: How a Kept release is cut - the local gate, a pushed tag, the release workflow, what gets published, the laptop fallback and the dry run.
---

A release is a pushed tag. The gate runs on the maintainer's machine first; the tag starts
[`.github/workflows/release.yml`](https://github.com/ibrahimroshdy/kept/blob/main/.github/workflows/release.yml),
which runs `scripts/release.sh --ci` on a GitHub-hosted runner and creates the GitHub release.
The full procedure, with every command and a table of what to do when a stage fails, is the
[release runbook](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/release.md). This
page is the map.

:::note[Releases so far]
`v1.0.0` is the first release, signed. Every final release must be signed: see
[signing](/maintainers/signing/).
:::

## Versions and tags

- **Git tags** are `vX.Y.Z`, or `vX.Y.Z-<prerelease>` such as `v1.0.0-rc.1`: semver without build
  metadata, checked exactly by `scripts/release/version.mjs`. The version must be newer than every
  other `v*` tag, and a pushed tag is never moved.
- **Image tags** drop the `v`: always `X.Y.Z`, plus `X.Y` and `X` only when this is the newest final
  release of that line, so a patch to an old line never moves a newer line's tags. A prerelease
  gets its exact tag only. There is never a `latest`.
- **The chart's version is the release's version.** `scripts/release/chart.sh` packages the chart with
  `--version X.Y.Z --app-version X.Y.Z`; the committed `charts/kept/Chart.yaml` stays `0.0.0-dev`
  (`scripts/check-helm.sh` fails if it is edited by hand). Each published chart pins one image
  digest, and the release still refuses a chart version the registry already holds.
- **Commits** follow Conventional Commits; the [changelog](/maintainers/changelog/) is built from
  them.

## What a release publishes

In this order, stopping at the first failure (D87, D186, D187):

1. a **multi-arch image** (linux/amd64 and linux/arm64) built from `git archive` of the tagged
   commit, with an SPDX SBOM and minimal provenance in its index, pushed **by digest, with no tag**;
2. each architecture **pulled by digest and smoked** with `scripts/smoke-image.sh` (arm64
   natively, amd64 under emulation), and `/version` checked to report this version and commit;
3. the index digest and every manifest under it **signed with cosign**, then verified;
4. the **tags**, all pointing at that one signed digest, each verified;
5. the **Helm chart** as an OCI artifact beside the image, its image pinned by the signed digest,
   signed too;
6. the **release record** `docs/releases/X.Y.Z.md`: digests, tags, the chart and the verify
   commands;
7. the **GitHub release** `vX.Y.Z`: the changelog section and the record as its notes, with
   `THIRD-PARTY-NOTICES.txt` and `X.Y.Z.md` attached, marked a prerelease for `X.Y.Z-…`.

Nothing is tagged until both architectures passed and the signature verified, so a failed run
leaves only untagged digests behind. The default registry is `ghcr.io/ibrahimroshdy/kept` (the
chart under `ghcr.io/ibrahimroshdy/charts/kept`); the runbook records that this path was inferred
from the Dockerfile and is to be confirmed (its step W2).

## Cutting one

The short version of the runbook's "Each release":

1. On `main`, clean, at the commit to release, write the changelog section and commit it alone:

   ```sh
   node scripts/changelog.mjs --version X.Y.Z --from vPREVIOUS --write CHANGELOG.md
   git commit -m "chore(release): X.Y.Z" -- CHANGELOG.md
   ```

2. Run the gate in a clean worktree of that exact commit. It runs `scripts/ci-local.sh` and records
   `.tmp/release/X.Y.Z/gate.txt`:

   ```sh
   bash scripts/release.sh X.Y.Z --run-gate
   ```

3. Push `main`, then the tag. The tag push starts the workflow:

   ```sh
   git push origin main
   git tag -a vX.Y.Z -m "Kept X.Y.Z" && git push origin vX.Y.Z
   ```

4. When the run is green, download the release record into `docs/releases/` and commit it.
5. Verify from outside, as a user would ([verifying a release](/admin/verify-release/)).

## What the workflow does

`release.yml` runs **only** on a pushed tag in Kept's version format, or by hand
(`workflow_dispatch`) for an existing tag after a failed run. Never on a branch push or a pull
request, so Actions minutes go to releases only. It is one job, `release`, on the arm64 runner
(`ubuntu-24.04-arm`) with a 90-minute timeout, and one release runs at a time.

- **Preflight**, before any build: the tag is a release version; signing is either fully set up or
  fully absent (half is refused); an unsigned `1.0.0` or later is refused; the GitHub release
  doesn't exist yet.
- **`scripts/release.sh --ci`**: the stages above. It also refuses a tagged commit that isn't on
  `origin/main` and a version or chart version the registry already holds.
- **The GitHub release**, after checking the notes for AI attribution (D173).
- **Cleanup**, always: the key file and the registry logins are removed.

The layer cache is Actions' cache, scoped by ref: it helps a re-run of the same tag, not the next
release. The gate is deliberately not in the workflow; it runs on the laptop before the tag.

## The laptop fallback

When Actions can't run, `bash scripts/release.sh X.Y.Z` does the same stages from the laptop, with
the cosign key file (`KEPT_COSIGN_KEY`, `COSIGN_PASSWORD`), a GHCR login and `gh` as the
repository owner (the runbook's M1–M3). It never commits, tags or pushes: at the end it prints
those steps for you. It needs the pinned tools (`bash scripts/tools.sh fetch`) and 15 GB free.
Don't push a tag from a laptop release while `release.yml` is in the tagged commit unless you mean
the workflow to run as well; it stops at "already published" in its first minutes.

## The dry run

Rehearse the whole pipeline locally, with nothing published outside the machine:

```sh
bash scripts/release.sh 0.1.0 --dry-run
# or as ci-local's opt-in step:
KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh --from release-dry-run
```

It builds HEAD from `git archive`, pushes to a throwaway `registry:3.1.2` container on a spare port,
smokes both architectures, signs with a throwaway key pair, tags, publishes and signs the chart,
and must end with a verified signature and no container left behind. ci-local's
`release-dry-run` step skips (loudly) unless `KEPT_RELEASE_DRY_RUN=1` is set.

## Related

- [Signing](/maintainers/signing/): the key, what is signed, and why it isn't keyless yet.
- [The changelog](/maintainers/changelog/).
- [Runbooks and scripts](/maintainers/runbooks/): every ci-local step.
- [The 1.0 checklist](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/1.0-checklist.md).

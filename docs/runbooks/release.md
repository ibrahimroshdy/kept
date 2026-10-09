# Cut a release

**Status (2026-10-07):** a pushed release tag starts `.github/workflows/release.yml`, which runs
`scripts/release.sh` split across three jobs on GitHub-hosted runners and creates the GitHub
release. `0.9.0` went out through it in one job (run 37606305438, 18 minutes); the split below is
new and the next release measures it. `scripts/release.sh` from the laptop is the fallback, and
`--dry-run` still rehearses the whole pipeline locally. **The gate is GitHub Actions (D222,
2026-10-09):** `ci.yml` runs every step of `scripts/ci-local.sh` except perf on each pull request
and on the push to main, its jobs are main's required checks, and `release.yml`'s preflight
refuses a tag whose commit has no successful `ci` run on main. No laptop run is needed;
`release.sh --run-gate` stays for a release cut from the laptop. `main` takes
changes only through pull requests once the repository is public (`docs/runbooks/repo-settings.md`),
so a release never pushes `main`: the changelog section and the record go in through pull requests,
and only the tag is pushed.

What a release publishes (D87, D186, D187, L100–L104): a multi-arch image (linux/amd64,
linux/arm64) with an SPDX SBOM and minimal provenance inside its index, pushed by digest, smoked on
both architectures and checked at `/version` **before any tag**, signed with cosign, then tagged
`X.Y.Z` (and `X.Y`, `X` when it is the newest final release of that line; a prerelease gets only
its exact tag; never `latest`); and the Helm chart as an OCI artifact beside it, its image pinned by
the signed digest, signed too. `docs/releases/X.Y.Z.md` records the digests and the verify commands.

## Push the tag; the workflow does the rest

`release.yml` runs **only** on a pushed tag in Kept's version format (`vX.Y.Z` or
`vX.Y.Z-<prerelease>`, checked exactly by `scripts/release/version.mjs`) and on a manual run for an
existing tag. Never on a branch push or a pull request, so Actions minutes go to releases only.
Three jobs, and no emulation anywhere:

1. **preflight** (`ubuntu-24.04`, seconds) refuses before any build: a tag that isn't a release
   version, a half-done signing setup (one secret, or the secrets without `cosign.pub`), an
   unsigned `1.0.0` or later, a GitHub release that already exists.
2. **build**, two jobs in parallel, each on a runner of its own architecture (`ubuntu-24.04` for
   amd64, `ubuntu-24.04-arm` for arm64; both are standard runners for private repositories,
   2 vCPU, 8 GB, 14 GB disk, per GitHub's runner reference, read 2026-10-07). Each runs
   `release.sh X.Y.Z --ci --arch <arch>`: the preconditions (the tag at HEAD, its commit on
   `origin/main`, newer than every other `v*` tag, not already in the registry) and the changelog
   check, then builds its one platform natively with the SBOM and provenance, pushes it **by digest,
   with no tag**, pulls it back and smokes it natively (`smoke-image.sh`, `SMOKE_SCOPE=release`),
   and checks `/version`. Its two digests (the platform's index and its image manifest) are the
   job's outputs. If either architecture fails, the other is cancelled and nothing is published.
3. **publish** (`ubuntu-24.04-arm`) runs `release.sh X.Y.Z --ci --publish`: joins the two indexes
   into one multi-arch index with `docker buildx imagetools create`, pushed by its own digest with
   no tag. Nothing is rebuilt: the index's linux/amd64 and linux/arm64 manifests are byte for byte
   the ones the build jobs smoked, and `release.sh` refuses the join if they differ. The SBOMs come
   along. Then, as `release.sh` always has: sign the index and every manifest under it, tag
   `X.Y.Z` (`X.Y`, `X`), push and sign the chart, write the release record; and the job creates
   the GitHub release `vX.Y.Z` (the changelog section and the record as its notes,
   `THIRD-PARTY-NOTICES.txt` and `X.Y.Z.md` attached, a prerelease for `X.Y.Z-…`).

What the Dockerfile's `build` stage compiles (shared, mcp, server, the web bundle) is the same
JavaScript for every architecture and runs on the build platform (`--platform=$BUILDPLATFORM`); per
architecture only `prod-deps` (sharp's and Typst's binaries), the OS stage and the notices differ.
Split across two native runners, each job compiles its own copy in parallel: a shared compile job
before them would add its own minutes to the critical path instead of saving any.

**Time and minutes.** `0.9.0` (one arm64 job, amd64 under QEMU) took 18 minutes: the build of both
platforms 12.3 minutes, the smokes 4.9 (arm64 0.7 natively, amd64 3.9 under QEMU, each with an
18-second pull), the rest 0.5. The split is expected to take **about 8–9 minutes cold** (a changed
lockfile) and **about 6 warm**: preflight under a minute, then each build job about 1 minute of
setup, 3–6 minutes of native build, a minute of pull and smoke, then publish 1–2 minutes. That is
inferred from the 0.9.0 log (arm64's native smoke, the tag and chart timings) and not yet measured;
the build log of 0.9.0 has no per-stage times, so the native build figure is the least certain.
Billed minutes stay about the same (each job is rounded up to whole minutes, and amd64 now runs on
the x64 runner, $0.006 a minute against the arm64 runner's $0.005; a Pro account includes 3,000
minutes a month, both read from GitHub's billing docs on 2026-10-07). Re-pushing a published tag
costs a minute or two: the build jobs stop at "already published".

**The layer cache** is a registry cache per architecture in GHCR,
`ghcr.io/ibrahimroshdy/kept-cache:buildcache-amd64` and `…-arm64` (`mode=max`: every stage's
layers, not only the final image's). Every release reads the previous one's, so an unchanged
lockfile skips both installs, and an unchanged OS stage skips apt and restic. Actions' own cache
(`type=gha`, used for `0.9.0`) is scoped by ref, so a new tag could never read it. The first run
creates the `kept-cache` package with the workflow's token, private and linked to the repository
like `kept` (W3). Each release re-points the two tags and leaves the previous cache manifests
untagged; container storage on GHCR is free today (GitHub's Packages billing docs, read
2026-10-07), so they can stay, or be deleted in the package's settings. A missing or unreadable
cache is a warning, never a failure.

## Unsigned releases, until the key exists

The first release, `0.9.0`, goes out **unsigned**: no cosign key exists yet, and signing turns on
before the repository goes public. With **neither** secret set and **no** `cosign.pub` committed,
`release.yml` warns `unsigned release: …` and runs `release.sh` with `KEPT_RELEASE_UNSIGNED=1`.
Everything else runs as usual (both platforms pushed by digest and smoked, the tags, the chart, the
record); nothing is signed or verified, and the record and the GitHub release say at the top that
the release is unsigned, with a digest check in place of `cosign verify`. `release.sh` refuses
`KEPT_RELEASE_UNSIGNED=1` for `1.0.0` and every final release after it (a `1.0.0-rc.N` may still
go unsigned): **1.0 must be signed**, so W1 comes first. A dry run ignores it and signs with its
throwaway key, as always. From the laptop: `KEPT_RELEASE_UNSIGNED=1 bash scripts/release.sh 0.9.0`,
with no `KEPT_COSIGN_KEY` or `COSIGN_PASSWORD` (M2 and M3 still apply). Once W1 is done (both
secrets and `cosign.pub`), every run signs; half of W1 fails the preflight rather than ship
unsigned.

## Once: the maintainer's steps (W1–W4)

**W1. The cosign key pair, and its two repository secrets.** Off the repository, in a directory
only you can read:

```sh
bash scripts/tools.sh fetch cosign          # cosign v3.1.3, checksum-verified, into .tmp/tools/
COSIGN=$(bash scripts/tools.sh path cosign)
mkdir -p ~/kept-signing && chmod 700 ~/kept-signing && cd ~/kept-signing
"$COSIGN" generate-key-pair                 # asks for a password; writes cosign.key and cosign.pub
gh auth switch --user ibrahimroshdy
gh secret set COSIGN_PRIVATE_KEY -R ibrahimroshdy/kept < cosign.key
gh secret set COSIGN_PASSWORD -R ibrahimroshdy/kept       # prompts; type the key's password
```

Put `cosign.key` and its password in your password manager too. Copy `cosign.pub` to the
repository root and commit it (it is public by design; the docs' "Verifying a release" page names
it). `cosign.key` never enters the repository (`.gitignore` already ignores `*.key`). Signing is
key-based (D187), not keyless: keyless signing records the signer in the public transparency log,
which plan Q14 keeps off while the repository is private.

**W2. The registry path.** `ghcr.io/ibrahimroshdy/kept` (and the chart at
`ghcr.io/ibrahimroshdy/charts/kept`) is **inferred** from the Dockerfile's `SOURCE` default
(`https://github.com/ibrahimroshdy/kept`), never confirmed (plan Q14). Confirm it, or set
`KEPT_RELEASE_REGISTRY` (and `KEPT_RELEASE_CHART_REPO`) in the release step's `env:` in
`release.yml`. The chart's own default (`charts/kept/values.yaml` `image.repository`) carries the
same path; a release rewrites it in the packaged chart to wherever it published.

**W3. The GHCR packages.** The workflow pushes with its own `GITHUB_TOKEN` (`packages: write`): no
token to create. The first run creates `kept`, `charts/kept` and `kept-cache` (the layer cache), private and
linked to the repository. On 2026-10-07 neither package existed (`gh api user/packages?package_type=container`).
If one is ever created another way first, give the repository the **Write** role in that package's
settings ("Manage Actions access"), or the push is refused. When the repository goes public, make
both packages public (the old M4); the run then signs into the public transparency log on its own
(`KEPT_RELEASE_TLOG=1` when the repository is public) and the release notes drop
`--insecure-ignore-tlog`.

**W4. Push `main`.** The tagged commit must be on `origin/main`, and a tag push runs the
`release.yml` **in the tagged commit**, so the commit that adds it must be pushed before the first
tag. Actions must stay enabled for the repository (it is, with "all actions" allowed: read
2026-10-07).

## Each release

`main` takes no direct push (a ruleset, `docs/runbooks/repo-settings.md`): the changelog section
goes in by a pull request, the tag goes on the merged commit, and the record follows in a second
pull request.

1. The changelog section, by a pull request, squash-merged. Its title must be
   `chore(release): X.Y.Z` (a squash merge commits under the pull request's title, and a `chore`
   subject stays out of the next changelog):

   ```sh
   git switch main && git pull --ff-only
   git switch -c release-X.Y.Z
   node scripts/changelog.mjs --version X.Y.Z --from vPREVIOUS --write CHANGELOG.md   # no --from for the first
   git commit -m "chore(release): X.Y.Z" -- CHANGELOG.md
   git push -u origin release-X.Y.Z
   gh pr create --base main --title "chore(release): X.Y.Z" --body "The X.Y.Z changelog section."
   gh pr merge --squash --delete-branch      # once the checks are green
   ```

2. Wait for `ci` on the merged commit to pass on main (the gate, D222):

   ```sh
   gh run watch "$(gh run list -R ibrahimroshdy/kept --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" -R ibrahimroshdy/kept --exit-status
   ```

   The release workflow's preflight checks it again and refuses the tag if it hasn't passed.

3. Push the tag, and only the tag. It starts the release, and `docs.yml` deploys the docs site
   from the same tag (a final release only), so the site follows the release, not `main`:

   ```sh
   git tag -a vX.Y.Z -m "Kept X.Y.Z" && git push origin vX.Y.Z
   gh run watch "$(gh run list -R ibrahimroshdy/kept --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" -R ibrahimroshdy/kept
   ```

4. When it is green, the release record into the repository (it is also on the GitHub release), by
   a pull request:

   ```sh
   git switch -c release-record-X.Y.Z
   gh release download vX.Y.Z -R ibrahimroshdy/kept -p 'X.Y.Z.md' -D docs/releases
   git add docs/releases/X.Y.Z.md && git commit -m "docs(release): the X.Y.Z record"
   git push -u origin release-record-X.Y.Z
   gh pr create --fill --base main && gh pr merge --squash --delete-branch
   ```

5. Verify from outside, as a user would (the commands are in the record):

   ```sh
   cosign verify --key cosign.pub --insecure-ignore-tlog ghcr.io/ibrahimroshdy/kept:X.Y.Z
   docker buildx imagetools inspect ghcr.io/ibrahimroshdy/kept:X.Y.Z --format '{{ json .SBOM }}'
   ```

A pushed tag is never moved. If the release needs a code fix, release the next version (or the
next `-rc.N`). If the run failed for a reason outside the code (a registry timeout, a slow smoke),
re-run it: "Re-run all jobs" on the run's page, or `gh workflow run release.yml -R
ibrahimroshdy/kept -f tag=vX.Y.Z`. Nothing is tagged until both architectures passed and the
signature verified, so a failed run leaves only untagged digests behind (GHCR's untagged versions;
delete them in the package settings if you like). After a failure in **publish** only, "Re-run
failed jobs" re-runs publish alone with the build jobs' digests: no rebuild.

The chart's version is the release's (plan Q17): release X.Y.Z publishes chart X.Y.Z with
appVersion X.Y.Z, set by `helm package --version --app-version` at package time
(`scripts/release/chart.sh`). Nothing is bumped by hand and no release edits the committed
`charts/kept/Chart.yaml`, which stays `0.0.0-dev` for both (`check-helm.sh` fails otherwise). Each
published chart pins one image digest, so every release needs a new chart version anyway; a chart
change ships with the next release. The release still refuses a chart version the registry already
holds, before it builds anything and again before the push. Charts 0.1.0 and 0.2.0 (Kept 0.9.0 and
1.0.0) predate the rule; 1.0.0-rc.1 failed on exactly this, its chart version already taken.

## From the laptop (the fallback)

For when Actions can't run. The laptop needs credentials the workflow gets from GitHub:

- **M1**, the key file: `KEPT_COSIGN_KEY` names it and `COSIGN_PASSWORD` holds its password (W1's
  `~/kept-signing/cosign.key`).
- **M2**, the registry login: a GitHub token (classic) with `write:packages` (and
  `read:packages`), as `ibrahimroshdy`:

  ```sh
  echo "$GHCR_TOKEN" | docker login ghcr.io -u ibrahimroshdy --password-stdin
  echo "$GHCR_TOKEN" | "$(bash scripts/tools.sh path helm)" registry login ghcr.io -u ibrahimroshdy --password-stdin
  ```

  cosign reads Docker's login. Use the Docker config the release will use (`DOCKER_CONFIG`, or
  `~/.docker`), and make sure it has the `buildx` plugin (`docker buildx version`).
- **M3**, `gh` as the repository owner's account: `gh auth switch --user ibrahimroshdy`.

Then, on `main`, clean, at the commit to release, with the tools fetched
(`bash scripts/tools.sh fetch`) and 15 GB free:

```sh
bash scripts/release.sh X.Y.Z --run-gate
export KEPT_COSIGN_KEY=~/kept-signing/cosign.key
read -rs COSIGN_PASSWORD && export COSIGN_PASSWORD     # never echoed, never in shell history
bash scripts/release.sh X.Y.Z                          # about 30–45 minutes
```

It runs in one process, both platforms in one build (amd64 under emulation) and both smokes, and
stops at the first failing stage. At the end it prints the steps it never runs itself: the tag on
the built commit (only the tag is pushed), `gh release create` with the notices file and the record
(add `--prerelease` for `X.Y.Z-rc.N`), and the record (and `CHANGELOG.md`, if it wrote the section)
through a pull request. Pushing that tag starts `release.yml` too, when it is in the tagged commit:
its build jobs stop at "already published" in their first minutes, at the cost of those minutes. Builds reuse the `kept-release` buildx builder's cache
between releases; `docker buildx rm kept-release` drops it. Never prune it right before a release
(a cold build is much slower).

## The dry run

```sh
bash scripts/release.sh 0.1.0 --dry-run
# or, as ci-local's opt-in step:
KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh --from release-dry-run
```

Every stage runs except the gate (optional) and the maintainer's steps, against a `registry:3.1.2`
container on a spare port in 5150–5199 with a throwaway key pair in `.tmp/release/dry-*`. It ends
by verifying the signature on the version tag, then removes the registry, the builder, the pulled
images and the key; logs, the changelog and the release record stay in the work directory. It
needs no credential and publishes nothing outside the laptop. A dirty tree or another branch is a
warning, not a refusal: it builds HEAD from `git archive`, never the working tree. It is the
rehearsal for both paths: the workflow runs the same stages, split by platform. The split's own
step, joining two pushed digests into one index (`release_merge`), is not in the dry run; it was
tried on 2026-10-07 against a local registry with buildx v0.37.2 (two single-platform digests with
attestations joined, pushed by digest, no tag created).

The smoke is the commit's own `scripts/smoke-image.sh`, so a commit whose smoke is out of step with
its image fails the dry run, as it would fail a release (2026-10-07: HEAD's smoke still ran the
alpha backup, which restic's "no password, no backup" now refuses, until step 8 T15 lands). To
exercise the later stages meanwhile, a dry run (never a release) can smoke with another script:
`KEPT_RELEASE_SMOKE_SCRIPT=<path>`, copied over the export's `scripts/smoke-image.sh`.

## When a stage fails

| Stage | Usual cause | What to do |
|---|---|---|
| preflight (workflow) | signing half set up, an unsigned `1.0.0`+, the GitHub release exists | Finish W1 (or undo it, before 1.0); delete the stray release, or release the next version |
| preconditions | "already published", "not newer than", "not on origin/main" | Release the next version; push `main` before the tag (W4) |
| build | `ERR_PNPM_BROKEN_METADATA_JSON` / a registry timeout in an install (spike R2; mostly the laptop's emulated amd64) | Retried once automatically; else re-run the workflow (or, on the laptop, run again on a quieter machine) |
| build, push | `denied` / `permission_denied` from ghcr.io | W3: the package isn't linked to the repository; give it Write in "Manage Actions access" |
| verify | `/readyz` not 200 in time | The workflow allows 180 s (native); on the laptop, amd64 is emulated: `KEPT_RELEASE_BOOT_TIMEOUT=600`. The smoke's log is `smoke-<arch>.log` in the work directory (`.tmp/release/X.Y.Z/`); the build job prints its last 30 lines |
| publish, join | "the joined index has linux/… but the build job smoked …" | Never expected (imagetools copies manifests as they are). Re-run all jobs; if it repeats, release from the laptop and report it |
| sign | `COSIGN_PASSWORD` wrong, or no registry login for cosign | W1 (the secret), M1–M2 on the laptop |
| chart | "chart X.Y.Z is already published" | Release the next version (the chart's version is the release's; never bump `Chart.yaml`) |
| GitHub release | the last step failed after everything was published | The notes are in that step's log: save them to a file, then `gh release create vX.Y.Z --verify-tag --title "Kept X.Y.Z" --notes-file <file>`, attaching `THIRD-PARTY-NOTICES.txt` (`docker run --rm --entrypoint cat ghcr.io/ibrahimroshdy/kept:X.Y.Z /app/THIRD-PARTY-NOTICES.txt`) |

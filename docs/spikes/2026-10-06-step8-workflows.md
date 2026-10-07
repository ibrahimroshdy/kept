# Spike W1: the inert workflows' actions, pinned by commit SHA

Date: 2026-10-06. Step-8 plan, Task 0b (it feeds T20; D87, D105, D187, D199, Q20). Result: **PASS.**
Every action T20 uses has a latest release and a commit SHA, all read from public data with no
token.
- **The StepSecurity CLA fork is `step-security/contributor-assistant-github-action`.** Its GitHub
  description reads "CLA Assistant GitHub Action. Secure drop-in replacement for
  contributor-assistant/github-action." Its latest release is `v2.6.1`.
- **One tag is annotated:** `pnpm/action-setup`'s `v6.1.0`, so its pin is the peeled `^{}` commit,
  not the tag object.

## Method

1. **Latest release:** `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`, without
   authentication, with `User-Agent: Kept` (the same request as U1). Each answer was 200 with
   `prerelease: false`. A cross-check with `git ls-remote --tags --refs` (versions sorted) found no
   newer semver tag for any of the actions.
2. **Tag to commit:** `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag> refs/tags/<tag>^{}`.
   When the `^{}` line exists the tag is annotated and that line is the commit. Otherwise the tag
   points straight at the commit.
3. **Checked it is a commit:** `git fetch --depth 1 --filter=blob:none <url> <sha>` into a scratch
   bare repository, then `git cat-file -t <sha>`. All eight returned `commit`.

## The pins

| Action | Latest release (published) | Commit SHA to pin | Tag type | Commit (date, subject) | How read |
|---|---|---|---|---|---|
| `actions/checkout` | `v7.0.1` (2026-07-20) | `3d3c42e5aac5ba805825da76410c181273ba90b1` | lightweight | 2026-07-17 "prep v7.0.1 release (#2531)" | releases/latest API + ls-remote + cat-file |
| `actions/setup-node` | `v7.0.0` (2026-07-14) | `820762786026740c76f36085b0efc47a31fe5020` | lightweight | 2026-07-13 "Migrate to ESM and upgrade dependencies (#1574)" | same |
| `pnpm/action-setup` | `v6.1.0` (2026-09-05) | `ea17c68df8912ef543352723c149a84f56e3d413` (the tag object is `d9184bf108216479bc5a137cc391f4d7b14c870b`; don't pin that) | **annotated** | 2026-09-05 "feat: support pnpm v12 (#288)" | same, peeled `^{}` |
| `actions/upload-pages-artifact` | `v5.0.0` (2026-04-10) | `fc324d3547104276b827a68afc52ff2a11cc49c9` | lightweight | 2026-04-08 "Merge pull request #139 …" | same |
| `actions/deploy-pages` | `v5.0.1` (2026-09-01) | `368f82528645a54fb793d4d04e342629a3f51346` | lightweight | 2026-09-01 "Merge pull request #444 …" | same |
| `actions/configure-pages` (optional) | `v6.0.0` (2026-03-25) | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | lightweight | 2026-03-24 "Merge pull request #186 from salmanmkc/node24" | same |
| `step-security/contributor-assistant-github-action` | `v2.6.1` (2026-09-22) | `b9bd60bf1b766fa48dae03427059187137236239` | lightweight | 2026-09-21 "Merge pull request #11 from step-security/bumpd-deps" | same; repository found via a web search, then its GitHub page (below) |
| `rhysd/actionlint` (optional local tool, not an action) | `v1.7.12` (2026-03-30) | `914e7df21a07ef503a81201c76d2b11c789d3fca` | lightweight | 2026-03-31 "bump up version to v1.7.12" | same |

The YAML form is `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`.
Renovate (D187, T20) keeps both the SHA and the comment current once the repository is public.

## Notes for T20's workflows (from the pages read)

- **CLA fork** (https://github.com/step-security/contributor-assistant-github-action, read
  2026-10-06):
  - Its example workflow triggers on `pull_request_target` (`opened`, `closed`, `synchronize`) and
    `issue_comment` (`created`).
  - It asks for `permissions: actions: write, contents: write, pull-requests: write, statuses: write`.
  - It uses `step-security/contributor-assistant-github-action@v2`; T20 pins the SHA above instead.
  - The example has no `actions/checkout` step. That fits D187's rule: `cla.yml` must never check out
    PR code under `pull_request_target`, so it has no checkout step at all.
  - The upstream `contributor-assistant/github-action` is archived. D105 says so, and the web-search
    listing shows the same.
- **Pages** ("Using custom workflows with GitHub Pages",
  https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages,
  read 2026-10-06):
  - The deploy job needs at least `pages: write` and `id-token: write`, plus `contents: read`.
  - The default environment is `github-pages`.
  - `configure-pages` "enables the use of GitHub Pages … and also lets you gather different metadata
    about a website". The page presents it as optional, so `docs.yml` can skip it if Starlight's
    `site`/`base` are set in `astro.config`. I pinned it anyway in case T20 wants the base path from
    it.
- **pnpm:** the repository pins `"packageManager": "pnpm@11.23.0"`. `pnpm/action-setup` v6.1.0's
  head commit is "support pnpm v12". I assume (not checked) that it reads `packageManager` when no
  `version` input is given. T20 can use `corepack enable` instead, as the Dockerfile does, and drop
  the action. That is a free choice; the pin is here either way.
- **actionlint:** `v1.7.12` is its latest release. It is a Go binary, not an npm package. It's
  useful for checking the inert workflows locally, but no step requires it.

## Changes to the plan

- **T20:** pin the SHAs above, with the tag in a trailing comment. For `pnpm/action-setup` use the
  peeled commit `ea17c68…`, never the tag object `d9184bf…`.
- **T20 `cla.yml`:** `uses: step-security/contributor-assistant-github-action@b9bd60bf1b766fa48dae03427059187137236239 # v2.6.1`,
  with the README's triggers and permissions and no checkout step (D187).
- **T20 `docs.yml`:** deploy job permissions `contents: read`, `pages: write`, `id-token: write`,
  environment `github-pages`. `configure-pages` is optional.
- **Q20:** unchanged (committed now, inert until the repository is public).

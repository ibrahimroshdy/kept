# Repository settings

**Status (2026-10-07):** `scripts/repo-settings.sh` is written and its `--dry-run` reads every
setting on the private repository. **Nothing has been applied.** The go-public plan §5 and audit
rows 5.9, 5.11, 5.12 and 5.15 are what it implements.

The script holds GitHub's settings as code. It reads each setting, prints `current -> intended`,
and writes only what differs, so it can be run any number of times. Every endpoint and field comes
from GitHub's REST description; none is guessed.

## When to run it

| When | Command | What it does |
|---|---|---|
| Any time | `bash scripts/repo-settings.sh --dry-run` | Reads, prints, changes nothing |
| **Now, while private** | `bash scripts/repo-settings.sh` | Applies the settings that are safe and available on a private repository (below), and lists the rest as "needs public" |
| **At the flip**, after the last direct push to `main` and right after `gh repo edit … --visibility public` | `bash scripts/repo-settings.sh` | Applies the rest: Pages, homepage, secret scanning, push protection, private vulnerability reporting, the allowed-actions list, and the `main` ruleset with its required checks |
| After a CI job is renamed or added | `bash scripts/repo-settings.sh --only main-ruleset` | Updates the required checks |

The script needs `gh`, logged in as an account with admin on the repository (`gh auth switch -u
<owner>` if another account is active; the script says so and stops), and `jq`. Run it from the
checkout: it reads the workflow files to find the actions and the job names.

Options: `--only <groups>` (comma-separated: `merge`, `features`, `metadata`, `security`,
`actions`, `tag-ruleset`, `main-ruleset`, `pages`), `--repo OWNER/NAME`, and the ones described
with each setting below.

## The settings

### Merge (`merge`) — safe now

- **Squash merge only.** Merge commits and rebase merges off. With required linear history this
  gives one commit on `main` per pull request.
- **The pull request title is the squash commit's title** (`PR_TITLE`), so a Conventional Commit
  title on the pull request becomes the commit `changelog.mjs` reads. The body stays the branch's
  commit messages (`COMMIT_MESSAGES`), which keeps each commit's `Signed-off-by`.
- **Delete the branch on merge**, **allow auto-merge**, **always suggest updating the branch**.
- **Sign-off required on web commits** (`web_commit_signoff_required`): an edit made in GitHub's
  web editor gets the DCO sign-off the `dco` check asks for (plan D5).

### Features (`features`) — safe now

Issues on, Discussions on (checklist 6.10), the wiki off and projects off: the docs site is the
documentation. Discussions are switched with `gh repo edit --enable-discussions`, because
`has_discussions` is not in the documented body of `PATCH /repos/{owner}/{repo}`.

### Metadata (`metadata`) — description and topics now, homepage at the flip

- Description: "Self-hosted, open-source inventory of everything you own and where it is. AI
  assistant and MCP server built in."
- Topics: `self-hosted`, `home-inventory`, `inventory`, `ai`, `ai-agents`, `agentic-ai`, `mcp`,
  `mcp-server`, `model-context-protocol`, `pwa`, `typescript`, `fastify`, `react`, `postgres`,
  `kubernetes`, `helm`, `arabic`, `rtl`, `agpl` (19 of GitHub's 20). The script replaces the
  whole set, so edit the list in the script, not in the web UI.
- Homepage: the Pages site's `html_url`, read from `GET /repos/{owner}/{repo}/pages`, always as
  `https://`: the API gives `http://ibrahimroshdy.com/kept/` because the maintainer's user site
  doesn't enforce HTTPS, though the domain serves it. It stays unset until Pages exists; the script
  never builds the URL itself.

### Security (`security`) — Dependabot alerts now, the rest at the flip

| Setting | Private repository (GitHub Pro, user-owned) | Public |
|---|---|---|
| Dependabot alerts + dependency graph | Available: **applied now** | On |
| Dependabot security updates | Available, **left off** on purpose: Renovate opens the update pull requests (audit 5.12). `--dependabot-security-updates` turns them on | Same |
| Secret scanning | **Not available** (user-owned private repositories only get it on Enterprise Cloud with managed users) | Runs for free; the script makes sure it is enabled |
| Push protection | Not available | Enabled by the script |
| Private vulnerability reporting | Not available (public repositories only); `SECURITY.md`'s one channel | Enabled by the script, right after the flip |

Sources: GitHub's docs, `reusables/gated-features` (`secret-scanning`, `dependabot-alerts`,
`dependabot-security-updates`, `private-vulnerability-reporting`).

### Actions (`actions`) — SHA pinning and the token now, the allowlist at the flip

- **Full-SHA pinning required** (`sha_pinning_required`). Every `uses:` in the three workflows is
  already pinned by commit SHA (spike W1); the script stops if one isn't.
- **Default `GITHUB_TOKEN` read-only**, and Actions may not approve pull requests. Each workflow
  asks for more per job where it needs it (`docs.yml`'s deploy, `release.yml`).
- **Allowed actions: GitHub-owned plus the third-party actions the workflows use**, read from the
  workflow files: today only `pnpm/action-setup` (the release workflow no longer uses QEMU or the
  GitHub runtime action since it builds each architecture natively). Marketplace
  "verified creators" are not allowed wholesale. The pattern is `owner/repo@*`: the pinned SHA in
  the workflow file is what fixes the version, and a Renovate bump to a new SHA must not fail its
  own pull request because the allowlist still names the old one. `--pin-action-shas` allows only
  the exact SHAs instead (then rerun the script with every bump).
- **Why the allowlist waits for the flip:** GitHub's REST reference says `patterns_allowed` only
  applies to public repositories, so it is applied at the flip with the other public-only
  settings.

### Release tags (`tag-ruleset`) — safe now

A tag ruleset "release tags" on `refs/tags/v*`: creating, moving or deleting a `v*` tag is blocked
for everyone except the repository admin role, who bypasses it always. That is the maintainer
pushing a release tag. `release.yml` doesn't create tags (`gh release create --verify-tag` uses
the pushed one), so the workflow is unaffected.

The admin role's id is `5`. The REST description doesn't list role ids; the value is from the
GitHub Terraform provider's ruleset docs (`maintain` 2, `write` 4, `admin` 5) and GitHub's own docs
repository, which uses `5` for the same purpose.

### `main` (`main-ruleset`) — at the flip

A branch ruleset "main" on the default branch:

- **changes only through pull requests**, 0 approvals required (a solo maintainer can't approve his
  own pull request), all review conversations resolved, squash the only merge method;
- **required status checks**, from the GitHub Actions app only: `fast`, `attribution` and `dco`
  (`ci.yml`'s job ids) and `build` (`docs.yml`), with the branch up to date before merging. The
  script checks each name against the workflow file and stops if a job was renamed;
- **linear history**; **no force-push**; **no deletion**;
- **no bypass**: the maintainer works through pull requests too. `--allow-admin-bypass` adds the
  admin role as a bypass actor.

Why it waits for the flip:

- It blocks direct pushes to `main`, which is how `main` moves while the repository is private
  (agents commit to `main`, the maintainer pushes). Apply it after the last direct push.
  `--only main-ruleset` applies it earlier on purpose.
- The checks only run once public (every job is gated on `private == false`). While private the
  script leaves them out of the ruleset; `--required-checks` / `--no-required-checks` override
  that.

**The release flow changes with it.** `release.sh` ends by telling the maintainer to
`git push origin main v<version>`. With no bypass, the release commit (the changelog section and
`docs/releases/X.Y.Z.md`) has to go through a pull request, and the tag is pushed on the merged
commit. Either run with `--allow-admin-bypass`, or update `docs/runbooks/release.md` and the
`release.sh` message to the pull-request flow before the first public release.

### Pages (`pages`) — at the flip

Source "GitHub Actions" (`build_type: workflow`): `docs.yml` builds the site and deploys it with
`actions/deploy-pages`, from a final release tag only (`vX.Y.Z`), so the site describes the latest
release and never unreleased work on `main`. GitHub creates the `github-pages` environment allowing
`main` only; the script adds a deployment policy for tags `v*`, or the tag's deploy is refused. To
redeploy the current release's docs: `gh workflow run docs.yml --ref vX.Y.Z`. Run this before the first push to `main` after the flip, or that deploy
fails (audit 5.9). The script creates the Pages site if it doesn't exist; once it does, the next
run sets the repository homepage to its URL.

## Not in the script

- Flipping the visibility (checklist 6.12): `gh repo edit … --visibility public
  --accept-visibility-change-consequences`. Only the maintainer, only on his go.
- Making the GHCR packages `kept` and `charts/kept` public (audit 5.14): package settings, after
  the first release run creates them.
- Installing Renovate (audit 5.13).

## Verify

After each run, the dry run is the check: `bash scripts/repo-settings.sh --dry-run` prints `(ok)`
on every line it applied, and "0 setting(s) would change now". Before the flip it still lists the
"needs public" settings; after the flip that list is empty.

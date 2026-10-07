# Taking Kept public: the plan

Status 2026-10-07. Inputs: [go-public-audit.md](go-public-audit.md) (11 must-fix, 17 decide, 35
fine) and [1.0-checklist.md](1.0-checklist.md). Nothing below flips the repository's visibility,
rewrites history or changes a GitHub setting without the maintainer's explicit go-ahead.

## 0. Decisions only the maintainer can make (blocking)

| # | Decision | Why it blocks | Default if he doesn't choose |
|---|---|---|---|
| D1 | **Were the pre-rename sample-cast names real people?** (74 files in history, 2026-09-26 → the renames; plus the surname display name in `b933c69`, "surname household" in `9703576`) | If yes, history must be rewritten (git filter-repo) before going public, ideally into a **new** repository, because GitHub keeps serving old commit ids; 205 commit ids cited in tracked files get re-mapped | **Decided 2026-10-07: the names were fictional.** No rewrite; history stays |
| D2 | **Docs site engine**: the docs site already exists in Starlight (Astro, RTL Arabic, link checker, OpenAPI reference). He asked for **MkDocs**. Options: (a) migrate to MkDocs Material with Kept's kit; (b) keep Starlight and restyle it with the kit | (a) is a rewrite of the site build, the OpenAPI page and the RTL setup; (b) is a theme pass | (a), as asked: MkDocs Material, themed with the kit |
| D3 | First public version | 1.0 is blocked on the 2 GB VM run | Go public at `v0.9.x`, then `v1.0.0-rc.1` after the release dry runs and the VM run |
| D4 | Security and conduct contacts | SECURITY.md / CODE_OF_CONDUCT.md placeholders | **Decided 2026-10-07:** GitHub private vulnerability reporting is the one channel; conduct reports the same private route (titled "Conduct report") or @ibrahimroshdy on GitHub; no email address |
| D5 | CLA or DCO | `cla.yml` turns on at the flip and points to a placeholder CLA.md | **Decided 2026-10-07: DCO.** `CLA.md` and `cla.yml` removed; CONTRIBUTING.md "Sign your commits (DCO)"; the `dco` job in `ci.yml` runs `scripts/check-dco.sh` on a pull request's commits. No bot, no signatures branch. History before the flip has no sign-offs; the DCO applies from the first public pull request. Supersedes D105 (product design) |
| D6 | Keep `docs/plans`, `docs/spikes`, `docs/audits` public? | They are the project's engineering record | Keep, after the audit's edits; move coordinator/agent instructions out |

## 1. Clean the content (agents; no history change)

1. Fix the audit's must-fix items 1–5 and 8: real LAN/Tailscale IPs in `ssrf.test.ts` → RFC 5737/6598
   examples; the scratchpad path and desktop-app names in two docs; the work GitHub login in the
   step-1 plan; the agent-skill line in all eight plans; README's "no hosted CI"; widen
   `check-no-local-paths` so it catches what it missed.
2. The maintainer's other private projects, named in research notes and comments: neutral
   wording.
3. A history-wide guard in CI: gitleaks on every push and PR (free once public).

## 2. Documentation site ("beautiful", with the kit)

- **Engine**: per D2. Plan for (a) MkDocs Material:
  - Theme: the kit's tokens (colours, IBM Plex Sans/Arabic/Mono, the label-tape mark, light and dark),
    RTL for Arabic, local fonts, no external requests.
  - Structure: **Users** (install: Compose, Kubernetes/Helm, managed Postgres, HTTPS; first run;
    everyday use; AI providers; the phone app; backups and restore; import/export; FAQ) ·
    **Admins** (configuration reference generated from `config/reference.ts`, upgrades, monitoring,
    recovery kit, security model) · **Developers** (architecture, the monorepo, local setup, the
    database and RLS model, migrations, the API (OpenAPI rendered), MCP and tokens, the offline/sync
    model, i18n and RTL, testing and `ci-local`, writing a feature end to end) · **Maintainers**
    (releasing, signing, the changelog, triage, security handling, the decision log, runbooks).
  - Generated pages kept in sync by a drift check (config reference, API, CLI help).
  - Published on GitHub Pages from a workflow on `main` (free once public).
- Port the existing Starlight content (19 EN + 5 AR pages) rather than rewriting it.

## 3. README

A short, scannable front page: the mark and one-line pitch, a screenshot strip (light/dark, phone,
Arabic), badges (release, licence AGPL-3.0, CI, docs, container image, signed with Sigstore once
signed), a 60-second Compose quick start, features in brief, a link table (docs, install, API, MCP,
contributing, security), status ("0.9: not yet 1.0"), and licence. Badges only for things that are
real (no badge for a workflow that doesn't run).

## 4. Contributing and community files

- `CONTRIBUTING.md` rewritten for real use: prerequisites (Node 24, pnpm, Docker), `pnpm install`,
  the dev database (`compose.dev.yaml`), seeding, running server and web, tests and `ci-local`
  (`--fast` locally, full before a release), the rules that the codebase enforces (logical CSS, no
  native selects, five catalogues, RLS and the leak test, migrations, no AI attribution in commits),
  Conventional Commits, the branch → PR flow, review expectations, how to add a migration, a route,
  a screen, a string, a tool.
- `SECURITY.md` with a real contact and GitHub private vulnerability reporting switched on.
- Issue forms (bug, feature, question → Discussions), a PR template with the checklist,
  `CODEOWNERS`.

## 5. Repository settings (maintainer approves; can be scripted with `gh api`)

- **Ruleset on `main`**: no direct pushes, changes only through pull requests; required status
  checks (CI typecheck/lint/unit, leak test, docs build, gitleaks); linear history (squash merge);
  no force-push or deletion; require conversation resolution; signed commits optional.
- Tag protection: only the maintainer creates `v*` tags (release workflow trigger).
- Merge settings: squash only, PR title as the commit (Conventional), auto-delete branches.
- Security: secret scanning + push protection, Dependabot alerts, private vulnerability reporting,
  Renovate (config exists).
- Discussions on; Pages source = GitHub Actions; repo description, topics, website.
- Actions: CI on PRs and `main` (free when public); the release workflow stays tag-only.
- GHCR packages `kept` and `charts/kept` set public at the flip.

## 6. Releases, tags and the changelog

- `v0.9.0` released 2026-10-07 (unsigned, private, for the homelab).
- From the flip: every release = a tag `vX.Y.Z` on `main` → `release.yml` (build, smoke, sign, push,
  GitHub release with the changelog section). CHANGELOG.md keeps one hand-edited section per
  release, generated from Conventional Commits by `scripts/changelog.mjs` and trimmed.
- Cosign key before the first public release (signing becomes mandatory from 1.0.0).

## 7. Order of work

1. Maintainer: D1–D6.
2. Agents, in parallel: §1 content fixes · §2 docs site · §3 README · §4 contributing/community.
3. If D1 = rewrite: one agent prepares the filtered history in a new repo, re-maps cited commit ids,
   verifies the tree is identical at HEAD; maintainer reviews.
4. Maintainer: §5 settings (or approves a `gh api` script that applies them), cosign key, contacts.
5. Flip visibility; switch on CI and Pages; tag the first public release.

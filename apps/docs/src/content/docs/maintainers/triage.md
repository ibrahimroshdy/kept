---
title: Triage
description: How issues and pull requests reach Kept, which checks run on a pull request, and what the go-public plan adds.
---

Kept's repository is private until the go-public flip, so this page has two parts: what is in the
repository today, and what the
[go-public plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-plan.md)
intends. Anything in the second part is a plan, not a setting that exists yet.

## Issues

Two templates live in
[`.github/ISSUE_TEMPLATE/`](https://github.com/ibrahimroshdy/kept/tree/main/.github/ISSUE_TEMPLATE):

| Template | Label it applies | What it asks for |
|---|---|---|
| **Bug report** (`bug_report.md`) | `bug` | what happened, what was expected, how to reproduce; the Kept version (from `/version`), how it runs (Compose, Helm) and on what machine, the browser or phone and whether Kept is installed, the language; the relevant `docker compose logs kept` lines with private details removed |
| **Idea** (`feature_request.md`) | `idea` | the situation rather than the solution, what gets in the way today, and what the person would like |

The bug template opens with a reminder that a security problem is not an issue. When one arrives
as an issue anyway, don't discuss it there: point the reporter at private vulnerability reporting
and handle it as in [security reports](/maintainers/security/).

The [troubleshooting](/admin/troubleshooting/) page lists the known configuration failures with
their fixes; a report that matches one can be answered with a link. No written triage procedure
exists beyond the templates.

There is no labels configuration in the repository: `bug` and `idea` come from the templates, and
Renovate's pull requests carry `dependencies` (`renovate.json`) once Renovate is enabled.

## Pull requests

The template ([`.github/pull_request_template.md`](https://github.com/ibrahimroshdy/kept/blob/main/.github/pull_request_template.md))
asks for what changes for the people who use or run Kept and why, with a linked issue, and a
checklist:

- `bash scripts/ci-local.sh` passes (or `--fast`, saying which steps couldn't run);
- tests first, on their own database; the leak test and route catalogue updated for a new table
  or route;
- migrations are additive (a drop or rename takes two releases);
- new strings in all five catalogues, Arabic in the house style; logical CSS; works at 375 px and
  1280;
- Conventional Commit messages, and no AI attribution in commits or the description (D173);
- every commit signed off ([the DCO](/maintainers/dco/)).

### Checks that run on a pull request

These jobs are the gate (D222): each is a required check on `main`, and a release is refused for
a commit that hasn't passed `ci`. Each `ci` job runs a slice of
`bash scripts/ci-local.sh` ([runbooks and scripts](/maintainers/runbooks/#ci-local-step-by-step)),
so a failure reproduces locally with the same `--only` list. Every job is gated on
`github.event.repository.private == false`: nothing runs while the repository is private.

| Workflow | Job | What it checks |
|---|---|---|
| [`ci`](https://github.com/ibrahimroshdy/kept/blob/main/.github/workflows/ci.yml) | `fast` | `pnpm install --frozen-lockfile`, `bash scripts/ci-local.sh --fast` (lint, catalogues, typecheck, unit tests, the mock evaluation), then `node scripts/check-licences.mjs` |
| `ci` | `db-test` | `ci-local.sh --only compose,test`: the server's tests on Postgres with pgvector and RustFS |
| `ci` | `db-ops` | `ci-local.sh --only compose,drift,prod-boot,portability,backup`: migration drift, a production boot, portability and backup |
| `ci` | `db` | the required check: green exactly when both halves are |
| `ci` | `e2e-shard` | `ci-local.sh --only compose,e2e` with `CI_E2E_SHARD=k/4`: a quarter of the Playwright suite against the built server; the results are a per-shard artifact when it fails |
| `ci` | `e2e-update` | `ci-local.sh --only compose,e2e-update`: the step-3 update migration spec on its own |
| `ci` | `e2e` | the required check: green exactly when every shard and the update spec are |
| `ci` | `images-amd64`, `images-arm64` | `ci-local.sh --only images`: the image built natively on that architecture's runner and smoked in full |
| `ci` | `helm` | the pinned Helm and kubeconform, then `ci-local.sh --only helm` |
| `ci` | `attribution` | `scripts/check-attribution.sh` over the pull request's commits and its description |
| `ci` | `dco` | `scripts/check-dco.sh` over the pull request's commits |
| [`docs`](https://github.com/ibrahimroshdy/kept/blob/main/.github/workflows/docs.yml) | `build` | the configuration reference is current, then the docs site builds; a broken link fails it |

`ci` also runs on pushes to `main`; `docs` also deploys to GitHub Pages from `main`. `release.yml`
never runs on a pull request.
`perf.yml` runs ci-local's `perf` step nightly and on demand, as a report (its numbers are an
artifact); it is not a required check.

What a hosted runner can't do (the database tests, the leak test, e2e, the image builds) is in the
full local gate only, so a reviewer should expect the contributor's `ci-local` result in the
description, or run it themselves before merging.

## What the go-public plan adds

From the [go-public plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-plan.md),
§4 and §5, and the [go-public audit](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-audit.md).
None of this exists yet:

- **Issue forms** for bug, feature and question, with questions sent to GitHub Discussions; a
  `CODEOWNERS` file. The audit leans towards a `.github/ISSUE_TEMPLATE/config.yml` that turns off
  blank issues and links to Security advisories and Discussions.
- **GitHub Discussions** as the only community space (D88), and a public roadmap on GitHub
  Projects.
- **A ruleset on `main`**: changes only through pull requests; required checks (CI typecheck, lint
  and unit tests, the leak test, the docs build, gitleaks); linear history with squash merges;
  no force-pushes or deletion; conversations resolved before merging.
- **Squash merge only**, with the pull request's title as the commit, so the title must be a
  Conventional Commit (it is what the [changelog](/maintainers/changelog/) reads).
- **Tag protection**: only the maintainer creates `v*` tags, which start a release.
- **gitleaks** on every push and pull request, and GitHub secret scanning, push protection and
  Dependabot alerts after the flip.

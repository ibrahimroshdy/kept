---
title: The changelog
description: How CHANGELOG.md is generated from conventional commit subjects, what it leaves out, and how a release uses it.
---

[`CHANGELOG.md`](https://github.com/ibrahimroshdy/kept/blob/main/CHANGELOG.md) is written by
[`scripts/changelog.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/changelog.mjs)
from the commits' subjects when a release is cut. Newest release first; one section per release.
D187 names release-please as the eventual tool once releases run from GitHub; until then this
script writes the file, and release-please would start from it.

## Commit messages it expects

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, with the
scope optional and `!` before the colon for a breaking change.

```text
feat(backup): nightly restic snapshots with data digests
fix(web): the lock screen in Arabic
refactor(config)!: KEPT_BACKUP_KEEP is the daily count
```

How each commit is sorted:

| Commit | Goes under |
|---|---|
| `type!:`, or a `BREAKING CHANGE:` footer in the body, whatever the type | **Breaking changes** |
| `feat` | **Features** |
| `fix` | **Fixes** |
| `perf` | **Performance** |
| `i18n` | **Translations** |
| `docs` | **Documentation** |
| any other type, or a subject that isn't conventional | **Other**, with the whole subject |
| `test`, `chore`, `ci`, `build`, `style`, `refactor`, `spike`, `wip` | left out |

The hidden types change nothing a person running Kept sees. A breaking change is listed even on a
hidden type. Merge-commit subjects are read like any other.

Each entry is the subject, with the scope in bold and the short hash:

```text
- **backup:** nightly restic snapshots with data digests (fa0c96c)
```

A release with nothing user-facing gets "No user-facing changes."

## Running it

```sh
node scripts/changelog.mjs --version X.Y.Z [--from <ref>] [--to <ref>] [--date YYYY-MM-DD] [--write CHANGELOG.md]
```

- `--from` is the previous release tag (`vX.Y.Z`); without it, every commit up to `--to` (default
  `HEAD`) is read, as for the first release.
- `--date` defaults to today (UTC).
- Without `--write` it prints the section. With it, the section goes in above the newest one, under
  the file's header (the file is made if missing). It **refuses** a version the file already has.

## In a release

The [runbook](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/release.md) writes the
section before the gate and commits it on its own, so the release builds the commit that holds it:

```sh
node scripts/changelog.mjs --version X.Y.Z --from vPREVIOUS --write CHANGELOG.md
git commit -m "chore(release): X.Y.Z" -- CHANGELOG.md
```

The `chore` subject keeps that commit out of the next changelog. Read the section before
committing: the go-public plan has each release's section generated, then trimmed by hand.

`scripts/release.sh` (stage 2) then uses the committed section when `CHANGELOG.md` already has one
for this version, and generates it from the commits since the last `v*` tag when it doesn't.
Either way the section is checked for AI attribution (`scripts/check-attribution.sh`, D173) before
anything is built, and becomes the top of the GitHub release's notes.

## The test

[`scripts/changelog.test.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/changelog.test.mjs)
checks the grouping and hiding, breaking changes on a hidden type, unconventional subjects under
Other, the placement of a new section, the empty case, and a run over a fixture repository that
writes the section since a tag and refuses a second run for the same version. It is in the
`scripts` vitest project, so `pnpm test` and ci-local's `unit` and `test` steps run it; alone:

```sh
pnpm exec vitest run --project scripts scripts/changelog.test.mjs
```

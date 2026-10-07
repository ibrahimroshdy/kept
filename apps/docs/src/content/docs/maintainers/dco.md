---
title: The DCO
description: Why Kept takes contributions under the Developer Certificate of Origin, how to sign off, how the check works, and how to fix a missing sign-off.
---

Every commit in a pull request to Kept carries a `Signed-off-by:` line naming its author. That
line certifies the [Developer Certificate of Origin](https://developercertificate.org/) (DCO): that
the contributor has the right to submit the work under the project's licence, AGPL-3.0. There is
nothing to sign once, no bot and no third-party app.

## Why the DCO, and not a CLA

Kept first planned a contributor licence agreement (D105: the Harmony individual CLA, enforced by
a CLA bot and a signatures branch). On 2026-10-07 the
[go-public plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-plan.md)'s
decision D5 replaced it with the DCO:
`CLA.md` and the `cla` workflow were removed, `scripts/check-dco.sh` was added and wired into the
`ci` workflow, and CONTRIBUTING gained "Sign your commits (DCO)". D105 is marked superseded in the
[product design's decision log](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md).

On 2026-10-07 a CLA was added beside it (D221): [`CLA.md`](https://github.com/ibrahimroshdy/kept/blob/main/CLA.md),
adapted from the Apache individual CLA, signed once by a comment on the contributor's first pull
request (the `cla` workflow). Contributors keep their copyright and grant the maintainer a licence
that includes distributing their work under other licences, so Kept stays relicensable. The
sign-off still applies to every commit.

The history from before Kept went public has no sign-offs. The DCO applies from the first public
pull request on, and the check is never run over the whole history.

## Signing off

```sh
git commit -s -m "fix(web): the lock screen in Arabic"
```

`-s` appends a trailer from your `user.name` and `user.email`:

```text
Signed-off-by: Louis <louis@example.org>
```

The trailer must match the commit's **author** exactly, name and address. Signing off someone
else's commit doesn't count for it; a commit with several sign-offs passes if one of them is its
author's.

## The check

[`scripts/check-dco.sh`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/check-dco.sh)
takes a revision range and reads every non-merge commit in it:

```sh
bash scripts/check-dco.sh --range origin/main..HEAD
```

For each commit it reads the author (`%an <%ae>`) and the commit's `Signed-off-by` trailers, and
fails when none of them equals the author. It names every failing commit, then says how to fix
them; on success it prints `DCO: <n> commit(s) signed off`. Merge commits are skipped, and an empty
range passes. Without `--range` it exits with its usage line.

**Where it runs:** the `dco` job of the
[`ci` workflow](https://github.com/ibrahimroshdy/kept/blob/main/.github/workflows/ci.yml), on pull
requests only, over `base..head` of the pull request. Like every job in `ci`, it is inert while the
repository is private. It is not one of `ci-local.sh`'s steps; run it yourself before pushing.

Its tests are
[`scripts/check-dco.test.mjs`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/check-dco.test.mjs):
a signed range passes, an unsigned commit fails and is named, someone else's sign-off fails, a
co-signed commit that includes its author passes, merges are skipped, and an empty range passes.

## Fixing a missing sign-off

Add the trailer to every commit on the branch, then force-push the branch:

```sh
git rebase --signoff origin/main
git push --force-with-lease
```

For the last commit only, `git commit --amend -s --no-edit` does the same.

## Related

- [CONTRIBUTING.md](https://github.com/ibrahimroshdy/kept/blob/main/CONTRIBUTING.md) is the
  contributor's version of this page.
- The other check on a pull request's commits is the attribution check (D173): no AI co-author
  trailers or "Generated with" lines in commits or the description. See [triage](/maintainers/triage/#checks-that-run-on-a-pull-request).

---
title: Handling a security report
description: What a maintainer does with a vulnerability report - the private channel, the commitments in SECURITY.md, fixing, releasing and disclosing.
---

[`SECURITY.md`](https://github.com/ibrahimroshdy/kept/blob/main/SECURITY.md) is the reporter's
side of this. It promises things the maintainer has to keep; this page lists them and the steps
around them. The operator-facing summary of Kept's defences is the
[security model](/admin/security-model/).

## The channel

**GitHub private vulnerability reporting is the only channel**: the repository's **Security** tab →
**Report a vulnerability**. There is no security email address (go-public plan, decision D4). Only
the reporter and the maintainer see the report. Conduct reports use the same private route, titled
"Conduct report" ([1.0 checklist](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/1.0-checklist.md), row 6.3).

:::caution[Switch it on]
Private vulnerability reporting is off while the repository is private. It must be switched on
right after the flip (Settings → Security), or the button SECURITY.md points to isn't there
(1.0 checklist, row 6.4).
:::

A report that arrives anywhere else (a public issue, a discussion, a pull request) should be moved
to the private channel without discussing the details in public.

## What SECURITY.md commits to

| Commitment | Detail |
|---|---|
| Supported versions | the latest minor release (`X.Y`); the one before it for 90 days after the latest is published; nothing older |
| Critical fixes | within **7 days** of a confirmed report |
| Response | an acknowledgement, then a fix or a reasoned answer |
| Disclosure | a date agreed with the reporter |
| Credit | in the release notes, unless the reporter prefers not |
| When it applies | from 1.0; Kept has no supported release before it |

These come from D187 (the support window and the 7 days) and D83 (`SECURITY.md` and GitHub's
private advisories), in the
[product design's decision log](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md).

## Working a report

1. **Acknowledge** in the report's thread.
2. **Confirm** it on your own instance. Kept is self-hosted: there is no Kept-run service, and
   SECURITY.md asks reporters to test only their own instance too. The report should name the
   version (`/version` answers it).
3. **Fix it privately.** The report becomes a draft security advisory on GitHub, which can open a
   temporary private fork for the fix (a GitHub feature; Kept has no written procedure of its own
   for it). The fix follows the same rules as any change: a test first, the full local gate
   (`bash scripts/ci-local.sh`), additive migrations.
4. **Release.** Merge the fix to `main` and cut a release the usual way
   ([releasing](/maintainers/releasing/)): a tag starts `release.yml`. The release tooling only
   publishes a version newer than every existing `v*` tag, from a commit on `main`, so a fix ships
   as the next release; there is no backport path to an older line today.
5. **Disclose** on the agreed date: publish the advisory, and credit the reporter in the release
   notes unless they declined.

## Signed releases matter here

A fix is only useful if people can trust the image they pull. From `1.0.0` every release is signed
([signing](/maintainers/signing/)) and users can check it ([verifying a release](/admin/verify-release/)).

## The audit record

Kept's security reviews and the pre-publication audit are kept in the repository:

- [`docs/audits/security-step6-2026-10-06.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/audits/security-step6-2026-10-06.md):
  the review of personal tokens, the API, MCP, OAuth connectors, the assistant, webhooks, OIDC
  and semantic search. 0 high, 5 medium (all fixed with a test), 19 low left as they are.
- [`docs/release/go-public-audit.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-audit.md):
  secrets, personal data and attribution across the whole history before going public.
- The threat model: the
  [product design, §13](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md).
- The other files in [`docs/audits/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/audits)
  are UI reviews.

The existing reviews share one shape: what was reviewed and how, a result line counting findings
by severity, the findings with what was fixed, and how the fixes were verified.

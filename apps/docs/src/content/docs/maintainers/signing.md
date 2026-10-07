---
title: Signing releases
description: How Kept's images and chart are signed with a cosign key, where the key lives, and why signing is key-based rather than keyless for now.
---

Kept's release images and Helm chart are signed with **cosign, using a key pair the maintainer
holds** (key-based, decision D187 in the
[product design's decision log](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md)).
Users check a signature with the public half, `cosign.pub`; [verifying a release](/admin/verify-release/)
is their side of this page.

:::note[Since 1.0.0]
The key pair was made on 2026-10-07 and `cosign.pub` is committed at the repository root. Every
final release must be signed: `release.sh` refuses to publish one unsigned.
:::

## Where the key lives

Never in the repository. `.gitignore` already ignores `*.key`.

| Piece | Where |
|---|---|
| `cosign.key` (the private key, encrypted with a password) | a directory only the maintainer can read, and his password manager |
| its password | the password manager |
| both, for the workflow | repository secrets `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD` |
| `cosign.pub` | committed at the repository root; public by design |

The pair is made once with the pinned cosign (`bash scripts/tools.sh fetch cosign`, cosign
v3.1.3, checksum-verified) and `cosign generate-key-pair`. The runbook's step W1 has the exact
commands, including setting the two secrets with `gh secret set`:
[docs/runbooks/release.md](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/release.md).

In the workflow, the key is written to a file only that job can read, used, and removed in a step
that always runs. On the laptop, `KEPT_COSIGN_KEY` names the key file and `COSIGN_PASSWORD` is read
from the environment; cosign never prints it.

## All or nothing

`release.yml`'s preflight looks at three things: the two secrets and `cosign.pub`.

| State | What happens |
|---|---|
| all three present | the release is signed |
| none present | an unsigned release, with a warning, refused for `1.0.0` and later |
| anything in between | the run fails: signing is half set up |

So a forgotten secret can never quietly ship an unsigned release.

## What is signed

From `scripts/release/sign.sh` and `scripts/release/chart.sh`:

1. **The image index digest, recursively:** the multi-arch index and every manifest under it,
   signed by digest **before any tag exists**, then verified with `cosign.pub`.
2. **Every tag** (`X.Y.Z`, and `X.Y`, `X` when they move) is checked to point at that digest and its
   signature verified by tag.
3. **The Helm chart's** pushed digest, signed the same way.

Signing before tagging means no tag ever points at an unsigned image. The SBOM is BuildKit's SPDX
attestation inside the signed index, so it is covered by the same signature.

## The transparency log

While the repository is private, signatures are **not** recorded in Sigstore's public transparency
log: that would publish the image's name and digest. cosign 3 is told so with an empty signing
config (`cosign signing-config create`), because its old `--tlog-upload=false` flag is refused.
Verifiers then pass `--insecure-ignore-tlog`, and each release's notes say so.

Once the repository is public, the workflow sets `KEPT_RELEASE_TLOG=1`: signatures go to the public
log, and the release notes drop `--insecure-ignore-tlog`.

## Why not keyless yet

Keyless signing ties a signature to an identity from an OIDC provider, such as a CI run's, and
records it in the public log. Two reasons it isn't used yet:

- D187 chose key-based signing because releases were cut from the laptop, which has no CI
  identity to sign with.
- Keyless signing records the signer in the public transparency log, which the
  [step-8 plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/plans/2026-10-06-step-8-operations.md)
  (its Q14) keeps off while the repository is private.

Releases now run in GitHub Actions, which does have a CI identity, but no decision has moved Kept
to keyless signing; it stays key-based until one does.

## Rehearsing it

`bash scripts/release.sh <version> --dry-run` signs with a throwaway key pair against a local
registry and must end with `the signature on …:<version> verifies`; the key is deleted afterwards.
It needs no real key. See [releasing](/maintainers/releasing/#the-dry-run).

## Sources

- [`scripts/release/sign.sh`](https://github.com/ibrahimroshdy/kept/blob/main/scripts/release/sign.sh)
- [`.github/workflows/release.yml`](https://github.com/ibrahimroshdy/kept/blob/main/.github/workflows/release.yml)
- [Spike R2, the release pipeline](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-10-06-step8-release.md):
  the measured signing order and the cosign 3 transparency-log findings.

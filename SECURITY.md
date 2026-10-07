# Security policy

## Supported versions

| Version | Security fixes |
|---|---|
| The latest minor release (`X.Y`) | yes |
| The minor release before it | for 90 days after the latest one is published |
| Anything older | no: upgrade |

**Critical** vulnerabilities are fixed within 7 days of a confirmed report. Kept has no release
yet; this policy applies from 1.0.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it through GitHub's **private vulnerability reporting**, the only channel: on this
repository's page, open the **Security** tab (GitHub may label it "Security and quality") and
choose **Report a vulnerability**. Only you and the maintainer see the report. GitHub's own
walkthrough: [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).
There is no security email address.

Include what you found, the version (`/version` on a running Kept answers it), how to reproduce it,
and what an attacker could do with it. You'll get an acknowledgement, then a fix or a reasoned
answer; we'll agree a disclosure date with you and credit you in the release notes unless you
prefer not to be.

Kept is self-hosted: there is no Kept-run service to test against. Test on your own instance, never
on someone else's.

## Verifying a release

Release images are signed with a key the maintainer holds (cosign, key-based), and each ships with
an SBOM and a third-party notices file. The public key, `cosign.pub`, is committed to this
repository when signing starts. Check an image before running it:

```sh
cosign verify --key cosign.pub --insecure-ignore-tlog ghcr.io/ibrahimroshdy/kept:X.Y.Z
```

and run it by the digest that printed. `--insecure-ignore-tlog` is needed while releases are signed
without the public transparency log (the repository is private); it is dropped once they are, and
each release's notes give the exact command.

Every release is signed. The docs site's
[Verifying a release](https://ibrahimroshdy.com/kept/admin/verify-release/) page has the details.

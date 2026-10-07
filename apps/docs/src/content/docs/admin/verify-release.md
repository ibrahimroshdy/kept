---
title: Verifying a release
description: Check that a Kept image is the one the maintainer built and signed.
sidebar:
  order: 11
---

Every release image is signed with **cosign**, with a key the maintainer holds, and ships with an
SBOM (the list of everything inside it) and a third-party notices file. Release images are tagged
`X.Y.Z`, `X.Y` and `X`, all pointing at one verified digest; there is never a `latest`.

To check an image before running it, install cosign and verify it against `cosign.pub` from the
repository:

```sh
cosign verify --key cosign.pub --insecure-ignore-tlog <image>:<version>
```

`--insecure-ignore-tlog` is needed while releases are signed without the public transparency log
(the repository is private); it is dropped once they are, and each release's notes give the exact
command. A good signature prints the verified claims and exits 0; anything else means don't run it. Pin the
digest it printed in `KEPT_IMAGE` (`<image>@sha256:…`) to run exactly that image.

The Helm chart is published as an OCI artifact beside the image and signed the same way. A running
Kept reports its version, the commit it was built from and its source repository at `/version`,
and serves the image's third-party notices at `/notices.txt` (linked from the version line in the
app).

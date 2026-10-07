# Step 8: the device, machine and credentials checklist

Written 2026-10-06 (step-8 plan, Task 0b). **Nothing here has run: every Result cell is empty, and
every row is a maintainer check pending.** The build never waits for these. Each row already ships
its fallback ("Built meanwhile"); a result either confirms the preferred path or keeps the fallback.
From the plan's "Needs the maintainer's devices, machines and credentials", plus the rows Task 0's
spikes added (marked *T0*, with the spike that added them).

| # | Check | How | Built meanwhile | If it fails | Result |
|---|---|---|---|---|---|
| V5 | The performance targets, the backup and the readable copy at 10,000 things on a **2 GB, 2-vCPU VM, amd64 and arm64** (D209). Blocking for 1.0 (Q28) | The perf suite and `kept admin backup` on each VM, seeded with 10,000 things and ~2 GB of photos | The laptop under `--memory 2g --cpus 2` (T25). restic alone, arm64, synthetic 2.1 GiB: 115 MiB peak RSS, 52 s first backup, 5 s the next ([restic spike](2026-10-06-step8-restic.md)) | Lower the readable copy's concurrency and the digest page size; restic's `--read-concurrency` / `--pack-size`; record it | |
| V5b *T0, restic* | restic's memory and time on **amd64** at the floor (the spike measured arm64 only) | `docs/spikes/code/step8/restic/r1-memory.sh` in the spike image on the amd64 VM | arm64's numbers | As V5 | |
| V4 | The Ollama profile on the 2 GB floor: a small model, one extraction | `docker compose --profile ollama up`, pull a small model, run one extraction | The profile ships documented as "needs more than the floor" until measured. The pinned image alone is 2.8 GB (arm64) / 3.8 GB (amd64) compressed ([image spike](2026-10-06-step8-image.md)) | The docs keep that line; Ollama stays for bigger machines | |
| R1 | **Registry login, the cosign key, `gh auth`** for the real 1.0.0 release (maintainer steps) | `scripts/release.sh` without `--dry-run` | `release.sh --dry-run` against a throwaway local registry with a throwaway key ([release spike](2026-10-06-step8-release.md)) | — | |
| R2 *T0, release* | The registry path: GHCR under your account, `ghcr.io/ibrahimroshdy/kept` (Q14, **inferred**, not confirmed) | Say yes or name the path | The dry run uses `localhost:<port>/kept` | — | |
| R3 *T0, release* | **Transparency log while private** (Q14): sign without uploading to Rekor until the first public release | Your call | The dry run signs with `--tlog-upload=false` | — | |
| H1 | The Helm chart installed on a real cluster of your choosing | `helm install` from the OCI chart, then `helm test` | `helm lint`, `helm template` + kubeconform (Kubernetes 1.37.0 schemas). **No cluster was created by any agent** (the coordinator's rule for this step), so the kind smoke is also yours ([helm spike](2026-10-06-step8-helm.md)) | Fixes from your install become golden-file cases | |
| H1b *T0, helm* | The optional **kind smoke** (install, upgrade, `helm test`) on the laptop | `kind create cluster --image kindest/node:v1.37.0@sha256:a1ed56cf…`, the chart's smoke, `kind delete cluster` | Template + kubeconform only | Recorded as skipped in ci-local's `helm` step | |
| S1 | A real off-site target: your B2 or R2 bucket over S3, or your NAS over SFTP | Admin → Backups with the real target; one backup, one `check`, one restore drill | RustFS (S3) and a throwaway OpenSSH server (SFTP), both passed ([restic spike](2026-10-06-step8-restic.md)) | The provider's quirk becomes a documented setting or a repository-location fix | |
| S1b *T0, restic* | B2's and R2's S3 endpoints with restic 0.19.1: region, path style, and whether `init` may create the bucket (a scoped key usually can't) | As S1 | Inferred to work (Q3); `-o s3.bucket-lookup=path` when path style is on | A documented `s3.region` / lookup setting | |
| L1a | App lock, **iPhone, Safari tab**: Face ID through WebAuthn (`userVerification: 'required'`), `prf.enabled` at create, a PRF secret at create/get, PIN unlock time at 2,850,000 PBKDF2 iterations | Kept's L1 probe on the phone over HTTPS ([app-lock spike](2026-10-06-step8-app-lock.md)) | Chromium's virtual authenticator passed all of it; the PIN always works | Biometrics hidden where WebAuthn UV fails; the PIN stays; a lower stored iteration count if unlock passes ~1 s | |
| L1b | App lock, **iPhone, installed PWA**: as L1a. No published source covers PRF in an installed iOS PWA | As L1a, from the Home Screen app | As L1a | As L1a | |
| L1c | App lock, **Android, Chrome tab** (Google Password Manager passkey): as L1a | As L1a | As L1a | As L1a | |
| L1d | App lock, **Android, installed PWA**: as L1a. No published source | As L1a, from the installed app | As L1a | As L1a | |
| K1 | **Keep offline on the iPhone:** 250 MB of documents survive a week without opening Kept (iOS storage eviction, V11) | Keep a location offline, don't open Kept for 7 days, go offline, open a receipt | The sync line's warning; the PIN-wrapped store | Help says the phone may drop the copy; the cap drops | |
| W1 | The readable copy opened from a restic restore **on Windows** (paths, `index.html` in a browser) | `restic restore latest --include /backup/readable` on Windows, open `index.html` | macOS and Linux in T25 | A path or encoding fix in the builder | |
| C1 | `CLA.md` from Harmony's generator, and the SECURITY and code-of-conduct contacts | Generate the CLA; name the contact addresses | Placeholders the 1.0 checklist refuses | — | |
| U1 *T0, updates* | The update check against the **public** repository: while it is private, every official image's check answers `not_found` (GitHub returns 404 for private and release-less repositories alike) | After the repository goes public and a release exists, turn the check on in an instance | The stub release in T11's tests ([updates spike](2026-10-06-step8-updates.md)) | — | |
| M1 *T0, managed Postgres* | One managed provider end to end with the published SQL (the provider's admin role, not a superuser) | Your pick among RDS, Cloud SQL, Azure flexible server, Neon, DigitalOcean Standard | The SQL measured on local 18.6 + pgvector 0.8.6 as a non-superuser admin ([managed-Postgres spike](2026-10-06-step8-managed-postgres.md)) | The docs' table and SQL change | |

## Reports

Paste results under each row's number, with the date, the device or machine, and its OS version.

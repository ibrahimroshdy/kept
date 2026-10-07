# Spike R1: restic

Date: 2026-10-06. Step-8 plan, Task 0a (it feeds T1, T2's `Restic` interface, T5, T7, T13, T15).
Result: **PASS**, with two findings that change the plan (below, "Changes to the plan").
- **restic 0.19.1** (latest stable, released 2026-07-05), BSD-2-Clause. The release's `SHA256SUMS`
  verified against its signature `SHA256SUMS.asc` with restic's key (fingerprint
  `CF8F 18F2 8445 7597 3F79 D4E1 91A6 868B D3F7 A907`, from restic's installation docs), and both
  Linux binaries match it.
- Every target works from a container shaped like Kept's (uid 10001, read-only root, `HOME=/tmp`):
  a **directory** (a `restic/` subdirectory beside the alpha's `runs/` and `blobs/`, Q2), **S3** on
  the dev RustFS under a prefix, and **SFTP** to a throwaway OpenSSH server with a **pinned host key**
  and a 0600 key file on a read-only mount.
- **The SSH client refuses to run for a uid with no passwd entry** ("No user exists for uid 10001").
  Kept's image has no entry for 10001 today, so **SFTP fails in the image as it stands**. T15 adds
  one (below).
- The password given only as `RESTIC_PASSWORD` in the child's environment never appeared in any
  process's argv (every `/proc/*/cmdline` read mid-backup: 0 hits).
- **Memory on the 2 GB floor's proxy** (`--memory 2g --cpus 2`, arm64): a first backup of 2.1 GiB
  took **52 s with a peak RSS of 115 MiB**; the next night's (50 new files) **5.2 s, 95 MiB**. Far under
  the 600 MiB bar; no restic setting is needed.
- **Retention** 7/4/6 over 40 faked days (`backup --time`) keeps exactly what it should, **only if the
  backed-up paths are stable**: a per-run temporary path puts every snapshot in its own group, and
  `forget` then removes nothing (40 of 40 kept). `--group-by host,tags` fixes it either way.

Code: `docs/spikes/code/step8/restic/` (every script's header says how to run it):
- `r1-local.sh`: the directory target, exit codes, the argv check, JSON shapes of every command.
- `r1-retention.sh`: 40 faked days, three grouping variants, the `pre_upgrade` series.
- `r1-s3.sh`: RustFS (compose profile `s3`, port 9452), wrong key, unreachable endpoint.
- `r1-sftp.sh` + `Dockerfile.restic`: SFTP from an image built the way T15 should build Kept's.
- `r1-memory.sh`: peak RSS and wall time under `--memory 2g --cpus 2`.

## Version, binaries, licence

Read from `https://api.github.com/repos/restic/restic/releases/latest` (tag `v0.19.1`, published
2026-07-05) and the release's own files.

| File | SHA-256 (from the release's `SHA256SUMS`, signature verified) |
|---|---|
| `restic_0.19.1_linux_amd64.bz2` | `f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c` |
| `restic_0.19.1_linux_arm64.bz2` | `a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465` |
| `restic_0.19.1_darwin_arm64.bz2` (laptop runs) | `7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143` |
| `restic-0.19.1.tar.gz` (source) | `bb9b1a19040744d26d8a79be029d4e6b189c45ccc9d8831d7fe367d3c33df725` |

- URL pattern (read from the release's asset list):
  `https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_<arch>.bz2`.
- Binaries: statically linked Go (`go1.26.4`), 30.9 MB (amd64) and 28.6 MB (arm64) decompressed.
- Signature check: `gpg --verify SHA256SUMS.asc SHA256SUMS` in a scratch `GNUPGHOME` with
  `https://restic.net/gpg-key-alex.asc` imported → "Good signature from Alexander Neumann", key
  `CF8F 18F2 8445 7597 3F79 D4E1 91A6 868B D3F7 A907` (the fingerprint restic's installation page
  publishes).
- **Licence: BSD 2-Clause** ("Copyright (c) 2014, Alexander Neumann"), read from
  `https://raw.githubusercontent.com/restic/restic/v0.19.1/LICENSE` (SHA-256
  `6f08a01a9fab5b24e139a09f15cc24a73087c7bc09e3bacf099fdf2d767bf897`). The notices file ships this
  text.

### How the Dockerfile installs it

The runtime image has no `curl`, no `bunzip2` and no `ssh` (checked in
`node:24.21.0-bookworm-slim@sha256:0e0ff40c…`). The pattern that built and ran
(`Dockerfile.restic`, arm64 built natively; the amd64 stage is the same lines):
- one build stage per architecture, each `ADD --checksum=sha256:<literal>` of its `.bz2`, and
  `FROM restic-${TARGETARCH} AS restic` to pick one;
- `bzip2` installed **in that build stage only**, `bunzip2`, `restic version` as a smoke;
- the runtime stage `COPY --from=restic` the binary to `/usr/local/bin/restic` and the licence to
  `/usr/share/doc/restic/LICENSE` (T15 should pin the licence `ADD` with the checksum above).
- `openssh-client` from Debian bookworm: candidate **`1:9.2p1-2+deb12u10`** on 2026-10-06
  (Installed-Size 6,372 KiB; depends on `libfido2-1`, `libedit2`, `libgssapi-krb5-2`, …). Pinning
  the exact Debian version, as the Dockerfile pins `postgresql-client-18`, **breaks the build when
  Debian publishes the next security update** (the main archive keeps only the current version;
  inferred from how Debian's archive works, not observed today). T15 decides: pin and bump, or
  install unpinned and record the version in the notices file.

## The SSH client needs a passwd entry (finding)

`ssh -V` as uid 10001 in the image: `No user exists for uid 10001`. restic then fails every SFTP
command with exit 1 and `unable to start the sftp session … server unexpectedly closed connection`
(stderr line `subprocess ssh: No user exists for uid 10001`). After

```dockerfile
RUN groupadd --gid 10001 kept \
 && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin kept
```

the same run passes (init, backup, snapshots, check all 0), and snapshots record `username: kept`.
**T15 adds this to the runtime stage.** Helm's `runAsUser: 10001` then matches a real entry.

## Exit codes (docs and a real run)

From `https://restic.readthedocs.io/en/stable/075_scripting.html` (read 2026-10-06), each one seen
in a real run unless marked:

| Code | Meaning (restic's docs) | Seen |
|---|---|---|
| 0 | success | every passing command |
| 1 | command failed | wrong S3 secret (`Stat: Access Denied`), SSH failures, a corrupt fresh cache (below), `init` on an existing repository |
| 2 | Go runtime error | not seen |
| 3 | backup could not read some source data; or forget could not remove snapshots | a 0000-mode file in the backup set: **the snapshot is still written** |
| 10 | repository does not exist (since 0.17.0) | `snapshots` before `init` |
| 11 | failed to lock the repository (since 0.17.0) | `backup` while `prune` held the exclusive lock |
| 12 | wrong password (since 0.17.1) | `snapshots` with a wrong password: `Fatal: wrong password or no key found` |
| 130 | cancelled (SIGINT/SIGTERM) | killing a command stuck on an unreachable endpoint |

With `--json`, the fatal error is one line on **stderr**:
`{"message_type":"exit_error","code":<n>,"message":"<text>"}`. Plain-text warnings
(`subprocess ssh: …`, retry lines, `unable to open cache: …`) can precede it on stderr, so T5 parses
stderr line by line and ignores lines that aren't JSON.

**An unreachable S3 endpoint is retried indefinitely** (backoff `retrying after 1.27s`, `2.89s`, …;
still retrying after 20 s, killed → 130). T5's wrapper needs its own timeout per command (kill the
child, report `backup_target_unreachable`).

**Two restic processes that create a fresh cache directory at the same moment** can fail with exit 1
`unable to open cache: readVersion: … parsing "": invalid syntax` (seen once, when `prune` started
1 s after a first `backup`). Kept never runs two at once (`backup_running`), so it is noted, not
designed for.

## Environment

restic's docs list the variables; used and proven in the runs:
- `RESTIC_REPOSITORY` (or `-r`), `RESTIC_PASSWORD` (also `RESTIC_PASSWORD_FILE`,
  `RESTIC_PASSWORD_COMMAND`), `RESTIC_CACHE_DIR`, `RESTIC_HOST` (Kept passes `--host kept`).
- S3: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (also `AWS_SESSION_TOKEN`,
  `AWS_DEFAULT_REGION`); options `-o s3.bucket-lookup=auto|dns|path`, `-o s3.region=…`.
- SFTP: `-o sftp.args="…"` (the `ssh` arguments) or `-o sftp.command="…"`.
- `TMPDIR`/`TMP` for temporary files (the image's `/tmp`).
- **argv check:** during a 300 MB backup, every `/proc/*/cmdline` in the container was read: the
  password appeared **0 times**. It is in `/proc/<pid>/environ` of the child, readable by the same
  uid only (Linux rule; true of any env secret). The repository URL is in argv only if passed as
  `-r`; T5 passes it as `RESTIC_REPOSITORY` too, since an SFTP URL names a user and host.

## Repository locations

| Target | Location string (what worked) | Notes |
|---|---|---|
| Directory | `<target>/restic` | `init` beside the alpha's `runs/` and `blobs/`; they are untouched (`ls`: `blobs restic runs`) |
| S3 (RustFS 1.0.0, dev compose) | `s3:http://localhost:9452/<bucket>/<prefix>/restic` | `init` **created the missing bucket** (restic's docs: "will create it"). Path-style works with the default `auto` lookup on RustFS; `-o s3.bucket-lookup=path` is what T5 passes when `KEPT_S3_FORCE_PATH_STYLE` is true. `check --read-data` and a byte-identical restore passed |
| SFTP | `sftp://kept@sftp:2222//config/kept-target/restic` | URL form for a port; the double slash makes the path absolute (restic's docs). `sftp:user@host:/path` for port 22 |

**Host key pinning** (SFTP), passed as `-o sftp.args="…"`:
`-o UserKnownHostsFile=<file> -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null
-i <key> -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=240`.
The known-hosts line is `ssh-keyscan -p 2222 -t ed25519 sftp` output (`[sftp]:2222 ssh-ed25519 …`).
With a wrong pinned key: exit 1, stderr `REMOTE HOST IDENTIFICATION HAS CHANGED … Host key
verification failed.` A private key at mode 0600, owned by 10001, on a read-only mount, under a
read-only root, works. `ServerAlive*` is restic's own advice for long uploads.

The SSH server: `linuxserver/openssh-server:10.3_p1-r1-ls238@sha256:46f115de7c251558297e7e87566fc3fc08544b63e55502b5cf294454db5d29d1`
(read from Docker Hub, 2026-10-06; listens on 2222, `USER_NAME`, `PUBLIC_KEY`, from its README).
Removed after the run.

## JSON messages (docs and a real run)

The docs' field tables are the source for T5's zod schemas; the run confirmed these shapes and
added the notes in bold.

- **`init`**: `{"message_type":"initialized","id","repository"}`.
- **`backup`** (stdout, one JSON object per line):
  - `status`: `seconds_elapsed`, `seconds_remaining`, `percent_done`, `total_files`, `files_done`,
    `total_bytes`, `bytes_done`, `error_count`, `current_files[]`. **Zero-valued fields are omitted**
    (the first status line had no `seconds_elapsed`), so every number is `.optional().default(0)`.
  - `error` (stdout): `{"message_type":"error","error":{"message"},"during":"archival","item"}`.
  - `verbose_status` only with `-v`; Kept doesn't use it.
  - `summary`: `files_new`, `files_changed`, `files_unmodified`, `dirs_new`, `dirs_changed`,
    `dirs_unmodified`, `data_blobs`, `tree_blobs`, `data_added`, `data_added_packed`,
    `total_files_processed`, `total_bytes_processed`, `total_duration`, `backup_start`,
    `backup_end`, `snapshot_id` (64 hex). `dry_run` appears only when true.
- **`snapshots --json`**: one JSON **array** of `{time, parent?, tree, paths[], hostname, username?,
  uid?, gid?, tags?, program_version, summary{…}, id, short_id}`. `parent`, `tags`, `username`,
  `uid`/`gid` are omitted when empty (a root-run or no-passwd-entry snapshot had no `username`).
- **`ls --json <snapshot>`**: first line the snapshot (`message_type":"snapshot"`, the fields above),
  then one `{"message_type":"node","name","type":"dir"|"file"|…,"path","uid","gid","size"?,"mode",
  "permissions","mtime","atime","ctime","inode"}` per entry.
- **`stats --json`** (default `restore-size` mode): `{total_size, total_file_count, snapshots_count}`;
  `--mode raw-data` adds `total_uncompressed_size`, `compression_ratio`, `compression_progress`,
  `compression_space_saving`, `total_blob_count`.
- **`check --json`**: `{"message_type":"summary","num_errors","broken_packs":null|[],
  "suggest_repair_index","suggest_prune"}`; errors as `{"message_type":"error","message"}`.
- **`restore --json`**: `status` lines and a `summary`
  `{seconds_elapsed?, total_files, files_restored, files_skipped?, files_deleted?, total_bytes,
  bytes_restored, bytes_skipped?}` (zero fields omitted; `files_restored` counted directories too:
  4 for 3 files).
- **`forget --json`**: a JSON **array of groups** `{tags, host, paths, keep[], remove[], reasons[]}`;
  `reasons[]` is `{snapshot, matches[]}` with strings such as `daily snapshot`, `weekly snapshot`,
  `monthly snapshot`, `oldest monthly snapshot`. With `--prune`, stdout stayed one parseable JSON
  document.
- **`prune --json` prints text, not JSON** (seen). T5 runs `forget --prune` and reads its JSON, or
  treats prune's output as a log.

## Snapshot paths and grouping

- Run from inside `KEPT_DATA_DIR` with relative arguments (`backup blobs`), restic stores the
  snapshot's `paths` as **absolute** (`/work/data/backup`, `/work/data/blobs`) but the **tree** from the
  working directory (`/backup/db/db.dump`), so `restore --include /backup/readable` and
  `ls` paths don't depend on where `KEPT_DATA_DIR` is mounted.
- `forget` groups by `host,paths` by default, and `paths` are absolute: moving `KEPT_DATA_DIR`
  starts a new group. Retention over 40 faked days (`r1-retention.sh`):

| Variant | Kept after `--keep-daily 7 --keep-weekly 4 --keep-monthly 6` |
|---|---|
| stable paths, default `host,paths` | **11**: the last 7 days, weeks ending 2026-09-20 and 09-27, months ending 08-31 and 09-30, and the oldest (08-28, "oldest monthly snapshot", restic keeps it while a bucket is unfilled) |
| a new temp path per run, default grouping | **40 of 40**: every snapshot is its own group; nothing is removed |
| a new temp path per run, `--group-by host,tags` | 11, as the stable case |

- `--time "2026-08-28 02:00:00"` on `backup` sets the snapshot time (restic has the flag; listed in
  `backup --help`).
- The `pre_upgrade` series, tagged separately and forgotten with `--tag pre_upgrade --keep-last 3`,
  kept its last 3 and was never touched by the nightly policy (`--tag nightly`).
- **Proposal for T5:** stable paths (T5's "one stable backup directory") **and**
  `--group-by host,tags` with `--tag nightly`/`--tag pre_upgrade`, so a moved `KEPT_DATA_DIR` or a
  changed file set never escapes retention.

## Restore and listing

- `restore latest --target <dir> --include /backup/readable` restored only that subtree.
- `ls --json latest` lists every node (above).
- `restic mount` needs FUSE: Linux, macOS (macFUSE) and FreeBSD only (restic's docs); not used by
  Kept, mentioned in "read your inventory with restic alone" as an option.

## Memory and time (the 2 GB floor's proxy)

`r1-memory.sh` in the spike image, `docker run --memory 2g --cpus 2`, arm64 (M1 Pro, Docker Engine
25.0.2 in Docker Desktop's VM), a named volume. Synthetic data, not a real Kept dump: a 100 MiB incompressible file
standing in for a 10,000-thing `pg_dump -Fc` (whose real size this spike didn't measure) and 2,048
random 1 MiB files standing in for JPEGs. Peak RSS is restic's `VmHWM`, polled every 0.2 s.

| Run | Wall time | Peak RSS | Summary |
|---|---|---|---|
| first backup (2.1 GiB, 2,049 files) | 51.7 s | 115 MiB | `data_added` 2.25 GB |
| second backup (+50 files, 50 MiB) | 5.2 s | 95 MiB | `files_new` 50, `files_unmodified` 2,049 |
| `check` | 2.4 s | 64 MiB | 0 errors |
| `forget --prune` | 2.9 s | 58 MiB | — |

Repository 2.2 GB; **cache 468 KiB** after these runs. Pass (< 600 MiB); no setting needed. amd64
on the same floor is V5's maintainer row.

## Cache

- Default with `HOME=/tmp`: `/tmp/.cache/restic/<repo-id>` plus a `CACHEDIR.TAG` (`restic cache`
  lists it). On a read-only root `/tmp` is a tmpfs, so the cache dies with the container and the
  next run re-reads the index.
- **Proposal Q5 holds:** `RESTIC_CACHE_DIR=KEPT_DATA_DIR/.cache/restic`. Kept backs up only
  `backup/` and `blobs/`, so the cache is outside the backup set anyway; restic also writes
  `CACHEDIR.TAG`, so `--exclude-caches` would skip it if the set ever widens. Size: under 1 MiB at
  2 GiB of data.

## Changes to the plan

1. **T15:** add the passwd/group entry for uid 10001 (above) to the runtime stage, or SFTP never
   works in the image.
2. **T15:** the restic install pattern above (per-arch `ADD --checksum` stages, `bzip2` in the build
   stage only); decide whether `openssh-client` is pinned to a Debian version (breaks on the next
   security update) or not.
3. **T5:** `--group-by host,tags` on every `forget`; stable relative paths run from
   `KEPT_DATA_DIR`; zod schemas with optional numeric fields (zero values are omitted); stderr parsed
   line by line, non-JSON lines kept as log text; **a per-command timeout** (an unreachable S3
   endpoint retries forever); `prune` output is not JSON.
4. **T5/T7:** exit 3 still writes a snapshot. The run is a `warning` (an unreadable file), and the
   snapshot counts for retention only if T5 decides so; proposed: it counts, the alert says which
   file.
5. **T5:** pass `-o s3.bucket-lookup=path` when `KEPT_S3_FORCE_PATH_STYLE` is true; restic creates a
   missing bucket on `init` (so a typo'd bucket name is created, not refused: the settings test
   should `snapshots` first and only `init` on exit 10).

---
title: Switching file storage
description: Move Kept's files between the server's disk and an S3 bucket with a verified copy.
sidebar:
  order: 6
---

Kept stores files (photos, receipts, documents) on the data volume (`KEPT_STORAGE=local`, the
default) or in an S3-compatible bucket (`KEPT_STORAGE=s3` with the `KEPT_S3_*` variables). Changing
`KEPT_STORAGE` alone doesn't move anything: the files already stored stay where they were and Kept
can't find them. Moving them is a copy.

## Moving

Files never change once stored, so the copy is safe while Kept runs, and it can be repeated: a file
already at the destination with the right hash is skipped.

1. Add the destination's settings beside the current ones (for S3: `KEPT_S3_BUCKET`,
   `KEPT_S3_ACCESS_KEY_ID`, `KEPT_S3_SECRET_ACCESS_KEY` and, if needed, `KEPT_S3_ENDPOINT`,
   `KEPT_S3_REGION`, `KEPT_S3_FORCE_PATH_STYLE`), keeping `KEPT_STORAGE` as it is.
2. **Copy while Kept runs:** `kept admin storage copy --to s3` (or `--to local`). Every file the
   database refers to, and its resized versions, is copied and its SHA-256 checked. `--dry-run`
   only counts.
3. **Stop Kept**, and copy again: only what arrived since is copied.
4. Set `KEPT_STORAGE` to the new store, and start Kept.
5. **Verify:** `kept admin storage verify --store s3` checks every file the database refers to.

The old files are left where they were; delete them yourself once you're satisfied.

## Before you choose S3

- Turn on **bucket versioning**: with S3 storage the backups don't hold the files, and versioning
  is what brings back a deleted or overwritten one ([backups](/admin/backups/#when-files-live-in-s3)).
- Phones fetch files from the bucket directly, through short-lived signed links. If the server
  reaches the bucket at an address phones can't (inside Compose, say), set
  `KEPT_S3_PUBLIC_ENDPOINT` to the one they can.
- Serve the bucket from its own hostname, never Kept's.

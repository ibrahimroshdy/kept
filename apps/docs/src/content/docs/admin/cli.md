---
title: The operator CLI
description: kept migrate and kept admin - what each command does and how to run it under Compose.
sidebar:
  order: 7
---

The image has a `kept` command for the person running the server: migrations, the way back in when
no one can sign in, keys, backups. `kept admin --help` lists everything; each command that changes
something is audited, and a person whose account it touches is told by mail.

## Running it under Compose

Most commands need the database **owner's** login (`KEPT_OWNER_DATABASE_URL`), which only the
one-shot `migrate` service holds; the serving container never does. Its entrypoint is `kept`, so:

```sh
docker compose run --rm migrate admin <command>
```

Two kinds of command need the serving container's volumes instead:

- `recovery-kit` reads the keys from the config volume and prints them even with no database:
  `docker compose exec kept kept admin recovery-kit`. With `KEPT_OWNER_DATABASE_URL` (below) it
  also holds the backup repository, its password and its credentials.
- `rotate-key`, `backup`, `restore` and `export` need the keys or the files as well as the owner
  login. Give the `kept` service `KEPT_OWNER_DATABASE_URL` in a `compose.override.yaml`
  ([as for backups](/admin/backups/#turning-it-on)), then run them in a one-off container:
  `docker compose run --rm --no-deps --entrypoint kept kept admin <command>`.

## Commands

| Command | What it does |
|---|---|
| `kept migrate` | Applies pending migrations once, under a database lock (the `migrate` service runs it on every start). |
| `kept admin setup-code` | Issues the first-run setup code again, while setup is pending, and lifts the instance-wide lockout. |
| `kept admin reset-password <login>` | A one-time password reset code, valid for an hour; signs the account out everywhere. |
| `kept admin disable-user <login>` / `enable-user <login>` | Stops an account signing in (and ends its sessions), or lets it again. |
| `kept admin transfer-ownership <locationId> <toUserId>` | Gives a location to another owner; the previous owner becomes an admin of it. |
| `kept admin recovery-kit [--format text\|html] [--out <file>]` | The recovery kit to keep off the server: the keys, the backup repository and its credentials, the restore steps. See [the recovery kit](/admin/recovery-kit/). |
| `kept admin gen-key` | Prints a new key, for setting `KEPT_SECRET_KEY` or `KEPT_AUTH_SECRET` yourself. |
| `kept admin rotate-key` | Makes a new secret key current and re-wraps every stored secret. `--resume` finishes an interrupted one; `--drop <version>` removes a retired key nothing uses. |
| `kept admin backup` | Backs up now (a restic snapshot); `--list` lists the snapshots, and any older pre-restic backups; `--accept-size` accepts a much smaller backup as the new normal. See [backups](/admin/backups/). |
| `kept admin backup verify` | Checks the backup repository; `--read-data <percent>` also reads that share of the data; with S3 file storage, checks the files against the bucket (`--all-files` for every one, not one in 20). |
| `kept admin backup drill --into <database>` | Restores the newest backup into an **empty** scratch database and checks it: the [monthly drill](/admin/restore/#the-monthly-drill). |
| `kept admin backup unlock` | Removes a stale restic lock after a crash; refused while a backup runs. |
| `kept admin restore <snapshot>` | Restores a snapshot (or `latest`) into an **empty** database and verifies it; `--legacy <id>` restores a pre-restic backup, for one release. See [restore](/admin/restore/). |
| `kept admin readable --out <dir>` | Writes every location's [readable copy](/admin/read-with-restic/) (HTML, CSV, files) into a directory; `--location <id>` for one, `--no-pdf` without the inventory PDFs. |
| `kept admin storage copy --to s3\|local` | Copies every file to the other store, checking each one's hash; `--dry-run` only counts. See [switching file storage](/admin/storage/). |
| `kept admin storage verify --store s3\|local` | Checks every file the database refers to is in that store with the right bytes. |
| `kept admin export --out <dir>` | Every row, raw, with secrets still sealed, and every file, into a new directory: the escape hatch, as sensitive as a backup. |
| `kept admin backfill-pdf-text` | Reads the text of PDFs uploaded before Kept read PDFs, so search finds them. |
| `kept admin config` | Prints the [configuration reference](/reference/configuration/) for this version. |

`kept admin seed` exists for development and refuses to run in production.

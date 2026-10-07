---
title: Troubleshooting
description: Real failure modes of a Kept server, what causes each one, and the fix.
---

Each entry is a symptom, its cause and the fix. The commands assume Docker Compose; under Helm the
same checks apply to the pods.

## First, look

- **Admin → Status** names most problems by itself: mail, failed background jobs, the reminder
  scan, backups and the restore drill, disks, the release and its migrations, HTTPS.
- **The logs:** `docker compose logs kept` and `docker compose logs migrate`. `KEPT_LOG_FORMAT=pretty`
  makes them readable by eye; `KEPT_LOG_LEVEL` (default `info`) sets the level.
- **A request id:** every response carries `x-request-id`; search the log for it to find the line
  that belongs to a report.
- **The probes:** `/healthz` (the process serves HTTP), `/readyz` (both database connections
  answer), `/version` (version, commit, source). See [monitoring](/admin/observability/).
- **Checks you can run:** `kept admin backup verify`, `kept admin storage verify --store local`
  (or `s3`) and `kept admin config` ([the CLI](/admin/cli/)).

## Compose stops with "set KEPT_PUBLIC_URL in .env"

**Cause:** `compose.yaml` refuses to start without the five database passwords and
`KEPT_PUBLIC_URL`; the message names the missing one.

**Fix:** fill in `.env` from `compose.env.example` ([install](/install/compose/#1-fill-in-env)).

## Kept exits at start with `kept: invalid environment: …` or another `kept:` line

**Cause:** the environment is checked before anything starts, and the first problem stops the
process with one line naming it. Common ones:

| The line says | Fix |
|---|---|
| `KEPT_SECRET_KEY and KEPT_AUTH_SECRET are set together or not at all` | Set both, or unset both to use the generated pair in the config volume |
| `<path>/secrets.json exists but …; fix or restore it` | The generated keys file is damaged: put back the keys from [the recovery kit](/admin/recovery-kit/) |
| `KEPT_BACKUP_DIR is inside KEPT_DATA_DIR …` | Point the backup at another disk |
| `a backup target is set, and the nightly backup dumps the database as kept_owner …` | Give the worker `KEPT_OWNER_DATABASE_URL` ([backups](/admin/backups/#turning-it-on)) |
| `set one backup target, not …` | Keep one of `KEPT_BACKUP_DIR`, `KEPT_BACKUP_S3_BUCKET`, `KEPT_BACKUP_SFTP` |
| `KEPT_STORAGE=s3 needs …` | Add the S3 settings it names ([storage](/admin/storage/)) |
| `KEPT_OIDC_ISSUER is set without KEPT_OIDC_CLIENT_ID` | Add the client id, or unset the issuer |

Every variable is in the [configuration reference](/reference/configuration/).

## Changed a database password in `.env`, and now nothing connects

**Cause:** the database passwords are read once, when the `kept-db` volume is first created.
Changing `.env` later changes what Kept sends, not what Postgres expects.

**Fix:** change the role's password in Postgres to match, then restart:

```sh
docker compose exec db psql -U postgres -c "ALTER ROLE kept_app PASSWORD '<the new password>'"
```

(The role is `kept_owner`, `kept_app`, `kept_auth` or `kept_system`, matching the variable.)

## `/readyz` answers 503

**Cause:** one of the web's two database connections (`app` and `system`, shown as `false` in
the response body) can't run a query. The log has `readiness check failed`. At start, Kept waits
about two minutes for a database that is still starting before it gives up.

**Fix:** check `docker compose ps db` is healthy and that the login named `false` has the right
password (above). On managed Postgres, check the four logins exist
([managed Postgres](/install/managed-postgres/#the-four-logins)).

## Saving anything fails with "The request did not come from this site."

**Cause:** a write that carries Kept's cookie must come from the exact origin of
`KEPT_PUBLIC_URL`: scheme, host and port. Opening Kept at another address (an IP instead of the
name, `http` instead of `https`, a different port) makes every write a 403. Links, QR codes and
invitation mails are built from the same value, and passkeys are registered for its host name.

**Fix:** set `KEPT_PUBLIC_URL` to exactly what the browser's address bar shows, restart, and
always open Kept there.

## Kept doesn't start after an upgrade, and `migrate` exited with an error

**Cause:** the `kept` service starts only after `migrate` succeeds. Before migrating a database
that has data, `kept migrate` takes a pre-upgrade snapshot when a backup target is set; **if the
snapshot fails, nothing is migrated** and it exits with the reason
([upgrades](/admin/upgrades/#the-snapshot-before-every-upgrade)).

**Fix:** read `docker compose logs migrate`, fix the backup (target, password, mount on
`migrate`), and `docker compose up -d` again. To upgrade without the snapshot on purpose, set
`KEPT_UPGRADE_SNAPSHOT=off` for that run.

## Kept refuses to start with `downgrade_refused`

**Cause:** the image is more than one release older than the database (or the database has
migrations no recorded release made). One version back is allowed; more isn't.

**Fix:** run the newer release again, or [restore](/admin/restore/) the pre-upgrade snapshot taken
by the older one. `KEPT_ALLOW_DOWNGRADE=1` forces the start and is audited; use it only when a
release's notes say to ([going back one version](/admin/upgrades/#going-back-one-version)).

## The setup code is lost, or setup is locked

**Cause:** the code is printed once, by the process that created it. Wrong codes lock out the
address that sent them, and many wrong codes lock out the instance.

**Fix:** `docker compose run --rm migrate admin setup-code` issues a new code and lifts the
instance-wide lockout; a per-address lockout ends on its own. If everyone is locked out at once,
read the next entry.

## Everyone hits the same sign-in limits

**Cause:** behind a reverse proxy Kept sees the proxy's address for every visitor unless the
proxy is in `KEPT_TRUSTED_PROXIES`, so everyone shares one set of limits.

**Fix:** list the proxy's address as Kept sees it in `KEPT_TRUSTED_PROXIES`
([reverse proxies](/install/reverse-proxy/#trust-the-proxy-and-only-the-proxy)).

## Uploads fail, or large photos never arrive

**Cause:** Kept refuses a file over `KEPT_MAX_FILE_MB` (25 MB by default) with 413. A proxy in
front often has a smaller body limit of its own and fails first.

**Fix:** raise the proxy's limit to at least `KEPT_MAX_FILE_MB`
([let uploads through](/install/reverse-proxy/#let-uploads-through)).

## The camera, installing, push or location doesn't work on phones

**Cause:** phones allow them only on a secure origin; a LAN address over plain HTTP isn't one.
Over HTTP Kept also refuses showing secret values, exports, access tokens, OAuth connections, the
recovery kit download and backup settings.

**Fix:** [put Kept on HTTPS](/install/https/) and set `KEPT_PUBLIC_URL` to the `https://` address.

## Saving an AI provider or webhook fails: "That address is on a private network."

**Cause:** outbound requests are refused to private, loopback and reserved addresses
(`private_address`). A provider on your own network, including Compose's `http://ollama:11434/v1`,
resolves to one.

**Fix:** an instance admin turns on **Admin → Settings → Allow private addresses**. See the
[security model](/admin/security-model/#outbound-requests-ssrf).

## No mail arrives

**Cause:** without `KEPT_SMTP_URL` and `KEPT_SMTP_FROM`, mail is only logged as due, and Admin →
Status says mail isn't configured.

**Fix:** set both and restart ([install](/install/compose/#5-next)).

## Backups don't run, or the "Backup stale" alert fires

**Cause:** usually one of: no target or no password (there is no unencrypted backup), the worker
without `KEPT_OWNER_DATABASE_URL`, a directory target not mounted on the container, or one not
owned by Kept's user (uid 10001).

**Fix:** follow [backups](/admin/backups/#turning-it-on), then run one by hand and read what it
says:

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup
```

It exits 1 on a warning, by name:

| Warning | Meaning, and what to do |
|---|---|
| `backup_suspicious_size` | much smaller than the last good one; if the shrink is real, `kept admin backup --accept-size` |
| `files_unreadable` | restic couldn't read some files; check the data volume's permissions |
| `blob_checksum_mismatch` | a stored file no longer matches its SHA-256; check the disk |
| `readable_incomplete` | a location's readable copy failed; the log names it |

After a crash, a stale restic lock can block every run: `kept admin backup unlock` removes it
(it refuses while a backup runs).

## A restore refuses to start

**Cause:** Kept restores only into an **empty** database, and checks that `pg_restore` matches the
server's Postgres major version and that the extensions exist.

**Fix:** create a new empty database with the extensions, as in [restore](/admin/restore/#restore);
never point the restore at the live one.

## After a restore, secret values and AI keys can't be read

**Cause:** they are sealed with `KEPT_SECRET_KEY`, which isn't in the backup.

**Fix:** put the recovery kit's keys in `.env` (with `KEPT_SECRET_KEY_VERSION` and
`KEPT_SECRET_KEYS_RETIRED` if it lists them) and restart. If the kit lists retired keys, run
`kept admin rotate-key --resume` once Kept is up. Without the key those values are gone for good.

## `kept admin` says `KEPT_OWNER_DATABASE_URL … is required`

**Cause:** most admin commands need the database owner's login, which only the `migrate` service
holds.

**Fix:** run them as `docker compose run --rm migrate admin <command>`, or for `rotate-key`,
`backup`, `restore` and `export`, give the `kept` service the owner login in
`compose.override.yaml` ([the CLI](/admin/cli/#running-it-under-compose)).

## A worker-only container is unhealthy

**Cause:** with `KEPT_ROLE=worker` the healthcheck reads the file the job loop touches
(`/tmp/kept-worker-alive`); it fails when the loop hasn't polled the database for two minutes.

**Fix:** check the worker's log and its database connection; the same database checks as for
`/readyz` apply.

## Still stuck

Open an issue with the version from `/version`, how Kept runs, and the relevant log lines with
anything private removed. A security problem goes through private vulnerability reporting
instead ([security model](/admin/security-model/#reporting-a-vulnerability)).
